// Optional Jupyter integration for the Jupyter MCP server: the bundled `uv`
// sidecar provisions an ISOLATED environment (own managed Python — nothing on
// the user's machine is touched) under app data, and the app manages a
// headless jupyter-lab process the MCP server connects to.
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

use crate::runtime::{free_port, workspace_dir};

// Pinned per datalayer/jupyter-mcp-server's documented requirements, plus the
// core scientific stack: this env is now the DEFAULT interpreter for the app's
// own notebook Run button (kernel::python_bin), so `import numpy/pandas` must
// work out of the box — an empty jupyter-only env would make the unified kernel
// useless for real work. scipy/statsmodels/pyDOE3 extend that stack to
// design-of-experiments analysis — response-surface fits, ANOVA, Tukey/Dunnett
// post-hoc tests, main-effects plots, and Box-Behnken/CCD designs — the same
// stack the domain-check bioprocess rules assume is available.
//
// The ~50 MB they add is not paid at install or at launch: nothing here ships
// in the bundle, and this list is only ever installed by setup_jupyter, which
// the user starts from Settings and which already warns that the first run
// downloads a few hundred MB. A user who never enables Jupyter never fetches
// any of it.
const PIP_SPEC: &[&str] = &[
    "jupyterlab==4.4.1",
    "jupyter-collaboration==4.0.2",
    "jupyter-mcp-server",
    "ipykernel",
    "numpy",
    "pandas",
    "matplotlib",
    "scipy",
    "statsmodels",
    "pyDOE3",
];

#[derive(Default)]
pub struct JupyterState {
    child: Mutex<Option<CommandChild>>,
    running: Mutex<bool>,
    /// Serializes start / re-root so overlapping workspace switches can never
    /// leave two jupyter-lab processes fighting over the fixed port.
    lifecycle: Mutex<()>,
}

fn env_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("runtime")
        .join("jupyter-env"))
}

fn server_meta_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(env_dir(app)?.join("server.json"))
}

/// Where we record the managed jupyter-lab's PID, so a later run can kill an
/// orphan left by a crash/force-quit before rebinding the fixed port.
fn pid_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(env_dir(app)?.join("jupyter.pid"))
}

/// Kill an orphaned jupyter-lab from a previous app run (a crash or force quit
/// leaves one behind; two instances then fight over the fixed port). Best-effort
/// and precise: never touches unrelated processes.
fn kill_orphan_jupyter(app: &AppHandle) {
    // Unix: match the env's own jupyter-lab path — scoped, proven, no PID reuse risk.
    // SIGKILL, not SIGTERM: a wedged orphan survives TERM (observed in the field —
    // jupyter's graceful shutdown hangs on dead kernels) and these are our own
    // headless processes from a dead app run, so there is nothing to save.
    #[cfg(unix)]
    if let Ok(dir) = env_dir(app) {
        let pattern = format!("{}/bin/jupyter-lab", dir.to_string_lossy());
        let _ = crate::runtime::quiet_command("pkill").args(["-9", "-f", &pattern]).output();
        std::thread::sleep(std::time::Duration::from_millis(400));
    }
    // Windows: taskkill the recorded PID, filtered to python.exe so a recycled
    // PID belonging to some other process is spared.
    #[cfg(windows)]
    if let Ok(path) = pid_path(app) {
        if let Ok(pid) = std::fs::read_to_string(&path).map(|s| s.trim().to_string()) {
            if !pid.is_empty() && pid.chars().all(|c| c.is_ascii_digit()) {
                let _ = crate::runtime::quiet_command("taskkill")
                    .args([
                        "/FI",
                        &format!("PID eq {pid}"),
                        "/FI",
                        "IMAGENAME eq python.exe",
                        "/F",
                        "/T",
                    ])
                    .output();
                std::thread::sleep(std::time::Duration::from_millis(400));
            }
        }
    }
}

/// Path to a binary in the managed env (provisioned or not — callers check
/// existence). Also read by the Skills-page tool probe, which must look here
/// because this env is deliberately off any PATH (#68).
pub(crate) fn env_bin(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = env_dir(app)?;
    #[cfg(windows)]
    return Ok(dir.join("Scripts").join(format!("{name}.exe")));
    #[cfg(not(windows))]
    Ok(dir.join("bin").join(name))
}

/// The managed env's Python, if provisioned. Doubles as the local kernel's
/// DEFAULT interpreter (kernel::python_bin), so the app's Run button and the
/// agent's Jupyter MCP share one Python — same packages, same results.
pub(crate) fn env_python(app: &AppHandle) -> Option<PathBuf> {
    env_bin(app, "python").ok().filter(|p| p.exists())
}

/// Port + token are chosen once at setup and reused so the MCP config entry
/// (which carries JUPYTER_URL/JUPYTER_TOKEN) stays valid across app restarts.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct ServerMeta {
    port: u16,
    token: String,
}

fn load_meta(app: &AppHandle) -> Option<ServerMeta> {
    let text = std::fs::read_to_string(server_meta_path(app).ok()?).ok()?;
    serde_json::from_str(&text).ok()
}

// CSPRNG on every platform — the old Windows fallback (pid + nanos) was
// guessable, and this token is the only thing between localhost and the
// Jupyter server.
fn random_token() -> String {
    crate::runtime::random_hex(16)
}

#[derive(serde::Serialize)]
pub struct JupyterStatus {
    pub installed: bool,
    pub running: bool,
    pub url: Option<String>,
    pub token: Option<String>,
    /// Absolute jupyter-mcp-server path for the MCP config entry.
    pub mcp_command: Option<String>,
}

fn status_of(app: &AppHandle, state: &JupyterState) -> JupyterStatus {
    let installed = env_bin(app, "jupyter-lab").map(|p| p.exists()).unwrap_or(false);
    let running = *state.running.lock().unwrap();
    let meta = load_meta(app);
    JupyterStatus {
        installed,
        running,
        url: meta.as_ref().map(|m| format!("http://127.0.0.1:{}", m.port)),
        token: meta.map(|m| m.token),
        mcp_command: env_bin(app, "jupyter-mcp-server")
            .ok()
            .filter(|p| p.exists())
            .map(|p| p.to_string_lossy().to_string()),
    }
}

#[tauri::command]
pub fn jupyter_status(app: AppHandle, state: State<'_, JupyterState>) -> JupyterStatus {
    status_of(&app, &state)
}

/// Provision the isolated Jupyter environment with the bundled uv. First run
/// downloads a managed Python + JupyterLab (a few hundred MB into app data);
/// takes a few minutes. Streams progress as `setup-progress` events and fails
/// with a readable error when a download stalls (see uv::run_uv).
#[tauri::command]
pub async fn setup_jupyter(app: AppHandle) -> Result<(), String> {
    let dir = env_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // Same Windows lock-avoidance as setup_science_mcp (#10): `uv venv`
    // rewrites the env's interpreter even with --allow-existing, and a running
    // jupyter-lab holds python.exe — re-running Setup would fail. Only create
    // the venv when its interpreter is missing; pip install is incremental.
    if env_python(&app).is_none() {
        crate::uv::create_venv(&app, "jupyter", &dir).await?;
    }

    let py = env_bin(&app, "python")?;
    let mut args = vec![
        "pip".to_string(),
        "install".to_string(),
        "--python".to_string(),
        py.to_string_lossy().to_string(),
    ];
    args.extend(PIP_SPEC.iter().map(|s| s.to_string()));
    crate::uv::run_uv(&app, "jupyter", args, "uv pip install").await?;

    // Fix port + token once so the MCP config entry stays valid.
    if load_meta(&app).is_none() {
        let meta = ServerMeta { port: free_port(), token: random_token() };
        std::fs::write(
            server_meta_path(&app)?,
            serde_json::to_string(&meta).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Start the managed headless jupyter-lab (idempotent). Root dir = workspace,
/// so the agent and the app's Notebooks page see the same files. `async`: the
/// orphan cleanup alone (taskkill + settle delay) would freeze the UI thread.
#[tauri::command(async)]
pub fn start_jupyter(app: AppHandle, state: State<'_, JupyterState>) -> Result<JupyterStatus, String> {
    let _guard = state.lifecycle.lock().unwrap();
    if *state.running.lock().unwrap() {
        return Ok(status_of(&app, &state));
    }
    spawn_lab(&app, &state)
}

/// Spawn jupyter-lab rooted in the CURRENT active workspace. Caller holds the
/// lifecycle lock and has ensured no managed instance is running.
fn spawn_lab(app: &AppHandle, state: &JupyterState) -> Result<JupyterStatus, String> {
    let lab = env_bin(app, "jupyter-lab")?;
    if !lab.exists() {
        return Err("Jupyter is not set up yet".into());
    }
    let meta = load_meta(app).ok_or("Jupyter setup is incomplete (no server meta)")?;
    let workspace = workspace_dir(app)?;

    kill_orphan_jupyter(app);

    let cmd = app
        .shell()
        .command(lab.to_string_lossy().to_string())
        .args([
            "--no-browser".to_string(),
            "--ip".to_string(),
            "127.0.0.1".to_string(),
            "--port".to_string(),
            meta.port.to_string(),
            format!("--IdentityProvider.token={}", meta.token),
            format!("--ServerApp.root_dir={}", workspace.to_string_lossy()),
        ])
        .current_dir(workspace);
    let (mut rx, child) = cmd.spawn().map_err(|e| format!("failed to start jupyter: {e}"))?;
    tauri::async_runtime::spawn(async move { while rx.recv().await.is_some() {} });
    // Record the PID so a future run can kill this process if it is orphaned.
    if let Ok(path) = pid_path(app) {
        let _ = std::fs::write(path, child.pid().to_string());
    }
    *state.child.lock().unwrap() = Some(child);
    *state.running.lock().unwrap() = true;
    Ok(status_of(app, state))
}

/// Follow a workspace switch: a running jupyter-lab keeps the root_dir it was
/// born with, so it must be restarted rooted in the NEW active workspace —
/// otherwise the agent's jupyter MCP keeps writing notebooks into the old
/// folder, invisible to the Notebooks page and previews. Port and token are
/// fixed in server meta, so the MCP config entry stays valid across the
/// restart. Runs in the background: a session switch must not wait on it.
pub fn reroot_jupyter(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<JupyterState>();
        let _guard = state.lifecycle.lock().unwrap();
        if !*state.running.lock().unwrap() {
            return;
        }
        kill_jupyter(&state);
        if let Err(e) = spawn_lab(&app, &state) {
            eprintln!("jupyter re-root failed: {e}");
        }
    });
}

pub fn kill_jupyter(state: &JupyterState) {
    if let Some(child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
    }
    *state.running.lock().unwrap() = false;
}
