// The desktop's door onto `osd_core::runtime`.
//
// Everything below is either a `#[tauri::command]` shell around a core function
// or an `AppHandle`-shaped wrapper for one, so the rest of the desktop keeps
// calling `crate::runtime::workspace_dir(&app)` exactly as before. The logic all
// lives in the core crate, which knows nothing about windows and therefore runs
// under `osd server` too.
use std::path::PathBuf;

use tauri::AppHandle;

use crate::env_of;

// App-free helpers pass straight through.
pub use osd_core::runtime::{
    enriched_path, free_port, kill_child, quiet_command, random_hex, sidecar_bin, tighten_private,
};

/// Expose the per-run sidecar password to the frontend SDK client.
#[tauri::command]
pub fn runtime_password() -> String {
    osd_core::runtime::runtime_password()
}

/// Write one exported conversation into a folder the user picked in a native
/// dialog. Confined to that folder: the file name is derived from the title
/// (never used as a path).
#[tauri::command]
pub fn write_export_file(
    directory: String,
    name: String,
    contents: String,
) -> Result<String, String> {
    osd_core::runtime::write_export_file(directory, name, contents)
}

pub fn runtime_root(app: &AppHandle) -> Result<PathBuf, String> {
    osd_core::runtime::runtime_root(&env_of(app))
}

pub fn xdg_data_home(app: &AppHandle) -> Result<PathBuf, String> {
    osd_core::runtime::xdg_data_home(&env_of(app))
}

pub fn workspace_dir(app: &AppHandle) -> Result<PathBuf, String> {
    osd_core::runtime::workspace_dir(&env_of(app))
}

pub fn base_workspace_dir(app: &AppHandle) -> Result<PathBuf, String> {
    osd_core::runtime::base_workspace_dir(&env_of(app))
}

pub fn uv_network_env(app: &AppHandle) -> Vec<(&'static str, String)> {
    osd_core::runtime::uv_network_env(&env_of(app))
}

pub fn sidecar_proxy_env(app: &AppHandle) -> Vec<(&'static str, String)> {
    osd_core::runtime::sidecar_proxy_env(&env_of(app))
}

// ---- runtime lifecycle ------------------------------------------------------

/// Start the bundled OpenCode (idempotent). Returns its base URL. `async`:
/// skill-pack deployment + process spawn at startup must not block the UI
/// thread while the first window paints.
#[tauri::command(async)]
pub fn start_runtime(app: AppHandle) -> Result<String, String> {
    osd_core::runtime::start_runtime(&env_of(&app))
}

/// Force a fresh sidecar, whatever state the current one is in (the escape
/// hatch for a process that is alive but no longer serving).
#[tauri::command]
pub fn restart_runtime(app: AppHandle) -> Result<String, String> {
    osd_core::runtime::restart_runtime(&env_of(&app))
}

#[tauri::command]
pub fn runtime_started_at(app: AppHandle) -> Result<u64, String> {
    osd_core::runtime::runtime_started_at(env_of(&app).runtime())
}

/// A sidecar that exited, and its own last words. The frontend uses `exits` to
/// tell a runtime that is slow to listen from one that will never listen, and
/// `message` to say why instead of "could not open the event stream" (#118).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeFailure {
    exits: u64,
    message: String,
}

#[tauri::command]
pub fn runtime_failure(app: AppHandle) -> Option<RuntimeFailure> {
    osd_core::runtime::runtime_failure(env_of(&app).runtime())
        .map(|(exits, message)| RuntimeFailure { exits, message })
}

/// One-shot: the config that was moved aside because neither this app nor the
/// runtime could read it. Reading it clears it.
#[tauri::command]
pub fn take_config_quarantine_notice(app: AppHandle) -> Option<String> {
    osd_core::runtime::take_config_quarantine_notice(&env_of(&app))
}

#[tauri::command]
pub fn stop_runtime(app: AppHandle) {
    osd_core::runtime::stop_runtime(env_of(&app).runtime())
}

// ---- workspace --------------------------------------------------------------

#[tauri::command]
pub fn workspace_path(app: AppHandle) -> Result<String, String> {
    osd_core::runtime::workspace_path(&env_of(&app))
}

#[tauri::command]
pub fn workspace_base(app: AppHandle) -> Result<String, String> {
    osd_core::runtime::workspace_base(&env_of(&app))
}

#[tauri::command]
pub fn set_workspace_base(app: AppHandle, path: String) -> Result<String, String> {
    osd_core::runtime::set_workspace_base(&env_of(&app), path)
}

/// Reveal the base workspace folder in the OS file manager. (The sandboxed
/// `open_path` resolves inside the ACTIVE workspace only, which may be a dated
/// subfolder — the base needs its own door.)
#[tauri::command]
pub fn open_workspace_base(app: AppHandle) -> Result<(), String> {
    crate::artifact_file::os_open(&base_workspace_dir(&app)?)
}

/// Switch the active workspace folder. The core persists the choice; the two
/// things that follow the workspace and only exist on the desktop are re-pointed
/// here.
#[tauri::command(async)]
pub fn set_workspace(app: AppHandle, path: String) -> Result<String, String> {
    let native = osd_core::runtime::set_workspace(&env_of(&app), path)?;
    let canon = PathBuf::from(&native);
    // Follow the active folder with the snapshot watcher so out-of-app edits
    // (external editor, detached process) in the new workspace are captured too.
    osd_core::git_snapshot::watch_workspace(&canon);
    // Jupyter-lab pins its root_dir at spawn time — re-root it (in the
    // background) so agent-created notebooks land in the new folder.
    crate::jupyter::reroot_jupyter(&app);
    // Refresh this session's local copy of the remote-machine list from the
    // canonical base file, so a machine configured in Settings is visible to
    // every session's agent without reaching outside the workspace.
    crate::compute::materialize_active(&app);
    Ok(native)
}

#[tauri::command]
pub fn mark_session(app: AppHandle, session_id: String) -> Result<(), String> {
    osd_core::runtime::mark_session(&env_of(&app), session_id)
}

#[tauri::command(async)]
pub fn new_dated_workspace(app: AppHandle, name: String) -> Result<String, String> {
    let canon = osd_core::runtime::new_dated_workspace(&env_of(&app), name)?;
    osd_core::git_snapshot::watch_workspace(std::path::Path::new(&canon));
    crate::jupyter::reroot_jupyter(&app);
    crate::compute::materialize_active(&app);
    Ok(canon)
}

/// Native "choose a folder" dialog; returns the absolute path, or None on cancel.
#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let Some(picked) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

// ---- skills -----------------------------------------------------------------

#[tauri::command(async)]
pub fn install_skill_markdown(app: AppHandle, text: String) -> Result<String, String> {
    osd_core::runtime::install_skill_markdown(&env_of(&app), text)
}

#[tauri::command(async)]
pub fn workspace_skill_names(app: AppHandle) -> Result<Vec<String>, String> {
    osd_core::runtime::workspace_skill_names(&env_of(&app))
}

#[tauri::command(async)]
pub fn adopt_workspace_skills(app: AppHandle, known: Vec<String>) -> Result<Vec<String>, String> {
    osd_core::runtime::adopt_workspace_skills(&env_of(&app), known)
}

// ---- providers + config -----------------------------------------------------

#[tauri::command(async)]
pub fn import_opencode_login(app: AppHandle) -> Result<bool, String> {
    osd_core::runtime::import_opencode_login(&env_of(&app))
}

#[tauri::command(async)]
pub fn provider_auth_exists(app: AppHandle, provider_id: String) -> Result<bool, String> {
    osd_core::runtime::provider_auth_exists(&env_of(&app), provider_id)
}

#[tauri::command(async)]
pub fn remove_config_entry(app: AppHandle, section: String, key: String) -> Result<(), String> {
    osd_core::runtime::remove_config_entry(&env_of(&app), section, key)
}

#[tauri::command(async)]
pub fn configure_opencode(
    app: AppHandle,
    provider: String,
    api_key: String,
    model: String,
    base_url: Option<String>,
) -> Result<String, String> {
    osd_core::runtime::configure_opencode(&env_of(&app), provider, api_key, model, base_url)
}

#[tauri::command]
pub fn get_approval_mode(app: AppHandle) -> Result<String, String> {
    osd_core::runtime::get_approval_mode(&env_of(&app))
}

#[tauri::command(async)]
pub fn set_approval_mode(app: AppHandle, mode: String) -> Result<String, String> {
    osd_core::runtime::set_approval_mode(&env_of(&app), mode)
}

// ---- memory -----------------------------------------------------------------

#[tauri::command]
pub fn read_memory(
    app: AppHandle,
    scope: String,
    directory: Option<String>,
) -> Result<String, String> {
    osd_core::runtime::read_memory(&env_of(&app), scope, directory)
}

#[tauri::command]
pub fn write_memory(
    app: AppHandle,
    scope: String,
    directory: Option<String>,
    text: String,
) -> Result<(), String> {
    osd_core::runtime::write_memory(&env_of(&app), scope, directory, text)
}

#[tauri::command]
pub fn append_memory(
    app: AppHandle,
    scope: String,
    directory: Option<String>,
    text: String,
) -> Result<(), String> {
    osd_core::runtime::append_memory(&env_of(&app), scope, directory, text)
}

#[tauri::command]
pub fn get_memory_enabled(app: AppHandle) -> Result<bool, String> {
    osd_core::runtime::get_memory_enabled(&env_of(&app))
}

#[tauri::command(async)]
pub fn set_memory_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    osd_core::runtime::set_memory_enabled(&env_of(&app), enabled)
}

// ---- per-agent models + network --------------------------------------------

#[tauri::command]
pub fn get_agent_models(app: AppHandle) -> Result<serde_json::Value, String> {
    osd_core::runtime::get_agent_models(&env_of(&app))
}

#[tauri::command(async)]
pub fn set_agent_model(app: AppHandle, agent: String, model: String) -> Result<(), String> {
    osd_core::runtime::set_agent_model(&env_of(&app), agent, model)
}

#[tauri::command]
pub fn get_agent_variants(app: AppHandle) -> Result<serde_json::Value, String> {
    osd_core::runtime::get_agent_variants(&env_of(&app))
}

#[tauri::command(async)]
pub fn set_agent_variant(app: AppHandle, agent: String, variant: String) -> Result<(), String> {
    osd_core::runtime::set_agent_variant(&env_of(&app), agent, variant)
}

#[tauri::command]
pub fn get_proxy_setting(app: AppHandle) -> Result<serde_json::Value, String> {
    osd_core::runtime::get_proxy_setting(&env_of(&app))
}

#[tauri::command(async)]
pub fn set_proxy_setting(app: AppHandle, mode: String, url: String) -> Result<String, String> {
    osd_core::runtime::set_proxy_setting(&env_of(&app), mode, url)
}

#[tauri::command]
pub fn get_mirror_setting(app: AppHandle) -> Result<serde_json::Value, String> {
    osd_core::runtime::get_mirror_setting(&env_of(&app))
}

#[tauri::command(async)]
pub fn set_mirror_setting(app: AppHandle, pypi: String, python: String) -> Result<(), String> {
    osd_core::runtime::set_mirror_setting(&env_of(&app), pypi, python)
}

#[cfg(test)]
mod tests {
    /// The rule stated above `osd_core::runtime::quiet_command`, enforced on
    /// THIS crate too. A raw `Command::new` in shipped code opens a console
    /// window on Windows — 0.4.0 shipped one that stayed open beside the app for
    /// every agent-browser MCP server the runtime started (#114). The core crate
    /// runs the same check over its own sources; neither covers the other, and
    /// the desktop is where most direct spawns live (ssh, kernel, Jupyter).
    /// Test code is exempt: it never runs inside the packaged app.
    #[test]
    fn shipped_code_never_spawns_with_a_raw_command() {
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders = Vec::new();
        for entry in std::fs::read_dir(&src).expect("src/ is readable") {
            let path = entry.expect("directory entry").path();
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            let text = std::fs::read_to_string(&path).expect("source is readable");
            // Everything from the file's first `#[cfg(test)]` on is test-only.
            let shipped = text.split("#[cfg(test)]").next().unwrap_or_default();
            for (i, line) in shipped.lines().enumerate() {
                if line.contains("Command::new(") {
                    offenders.push(format!("{}:{}", path.display(), i + 1));
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "spawn through crate::runtime::quiet_command instead: {offenders:?}"
        );
    }
}
