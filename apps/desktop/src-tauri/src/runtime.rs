// Manages the bundled OpenCode sidecar so it never interferes with any OpenCode
// the user already has: it runs the *bundled* binary, on a *dedicated free port*,
// with an *app-private* XDG config/data dir, and is killed on app exit.
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

use crate::opencode_config::merge_config;

#[derive(Default)]
struct RuntimeLifecycle {
    child: Option<CommandChild>,
    url: Option<String>,
    port: Option<u16>,
}

/// One lock owns every sidecar lifecycle field. Keeping child/url/port in
/// separate mutexes allowed two concurrent `start_runtime` calls to both see
/// "stopped", spawn on the same port, and overwrite each other's child handle.
#[derive(Default)]
pub struct RuntimeState {
    lifecycle: Mutex<RuntimeLifecycle>,
}

/// App-private runtime root, e.g. ~/Library/Application Support/com.ai4s.workbench/runtime
pub(crate) fn runtime_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("runtime"))
}

/// The running sidecar's base URL (`http://127.0.0.1:<port>`), or None when the
/// runtime is not started yet. The gateway proxies agent calls here, adding the
/// per-run Basic-auth password (`server_password`) itself.
pub(crate) fn sidecar_url(state: &RuntimeState) -> Option<String> {
    state.lifecycle.lock().unwrap().url.clone()
}

fn xdg_config_home(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_root(app)?.join("xdg-config"))
}

/// The sidecar's XDG_DATA_HOME — also where the bundled goal plugin keeps its
/// per-session state (`opencode-goal-plugin/goals.json`, read by `goal.rs`).
pub(crate) fn xdg_data_home(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_root(app)?.join("xdg-data"))
}

/// File recording the user's chosen active workspace folder (absolute path).
fn active_workspace_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_root(app)?.join("active-workspace.txt"))
}

/// File recording the user's chosen BASE folder — it contains the managed
/// `projects/` and `sessions/` collections (Settings → Workspace).
fn base_workspace_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_root(app)?.join("base-workspace.txt"))
}

pub(crate) const PROJECTS_DIR_NAME: &str = "projects";
pub(crate) const SESSIONS_DIR_NAME: &str = "sessions";

/// Keep the user-visible workspace root predictable:
///
/// ```text
/// OpenScience/
///   projects/
///   sessions/
///   .openscience/
/// ```
///
/// Existing root-level workspaces are left where they are and remain readable.
/// Moving them would invalidate absolute session directories stored by OpenCode.
fn ensure_base_layout(dir: PathBuf) -> Result<PathBuf, String> {
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for child in [PROJECTS_DIR_NAME, SESSIONS_DIR_NAME] {
        std::fs::create_dir_all(dir.join(child)).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

pub(crate) fn projects_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(base_workspace_dir(app)?.join(PROJECTS_DIR_NAME))
}

pub(crate) fn sessions_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(base_workspace_dir(app)?.join(SESSIONS_DIR_NAME))
}

/// The active workspace folder OpenCode / the kernel / previews / provenance all
/// operate in. Defaults to the base folder (`~/Documents/OpenScience`) until the
/// user opens or creates another one; the choice persists across restarts.
pub fn workspace_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(f) = active_workspace_file(app) {
        if let Ok(s) = std::fs::read_to_string(&f) {
            let dir = PathBuf::from(s.trim());
            if dir.is_dir() {
                return ensure_base_layout(dir);
            }
        }
    }
    base_workspace_dir(app)
}

/// The workspace root containing the `projects/` and `sessions/` collections.
/// A folder the user picked in Settings wins; the default is `~/Documents/OpenScience`
/// (no space — the agent runs shell commands against this path, and unquoted
/// spaces break them), falling back to `$HOME/Documents`.
pub fn base_workspace_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(f) = base_workspace_file(app) {
        if let Ok(s) = std::fs::read_to_string(&f) {
            let dir = PathBuf::from(s.trim());
            if dir.is_dir() {
                return Ok(dir);
            }
        }
    }
    let docs = match app.path().document_dir() {
        Ok(d) => d,
        Err(_) => {
            let home = std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .map_err(|_| "could not resolve a documents directory".to_string())?;
            PathBuf::from(home).join("Documents")
        }
    };
    let dir = docs.join("OpenScience");

    // One-time migrations, oldest name last. A failed rename (e.g. cross-volume)
    // keeps the existing location rather than splitting the user's files.
    if !dir.exists() {
        for old in [docs.join("Open Science"), runtime_root(app)?.join("workspace")] {
            if old.is_dir() {
                if std::fs::rename(&old, &dir).is_ok() {
                    break;
                }
                return ensure_base_layout(old);
            }
        }
    }
    ensure_base_layout(dir)
}

/// Path OpenCode reads when XDG_CONFIG_HOME points at our private dir.
fn opencode_config_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(xdg_config_home(app)?.join("opencode").join("opencode.json"))
}

/// The config file to edit in place: the server may have rewritten the config
/// as opencode.jsonc — prefer whichever exists, fall back to opencode.json.
fn effective_config_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = xdg_config_home(app)?.join("opencode");
    Ok(["opencode.jsonc", "opencode.json"]
        .iter()
        .map(|n| dir.join(n))
        .find(|p| p.exists())
        .unwrap_or_else(|| dir.join("opencode.json")))
}

/// The user's existing OpenCode auth file (their login / free credits), if any.
/// Read-only: we copy it into our sandbox so the bundled runtime can use the same
/// login, but we never modify the user's file or sessions.
fn user_auth_source() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        if !xdg.is_empty() {
            candidates.push(PathBuf::from(xdg).join("opencode").join("auth.json"));
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(PathBuf::from(&home).join(".local/share/opencode/auth.json"));
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        candidates.push(PathBuf::from(appdata).join("opencode").join("auth.json"));
    }
    candidates.into_iter().find(|p| p.exists())
}

/// Copy the user's OpenCode CLI login into the app-private data dir, EXPLICITLY
/// (from the Settings page) — never silently. Returns false when there is no
/// CLI login to import. Restarts the sidecar so it picks the credentials up.
#[tauri::command(async)]
pub fn import_opencode_login(app: AppHandle, state: State<'_, RuntimeState>) -> Result<bool, String> {
    let Some(src) = user_auth_source() else {
        return Ok(false);
    };
    let dst = runtime_root(&app)?.join("xdg-data").join("opencode").join("auth.json");
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::copy(&src, &dst).map_err(|e| format!("copy failed: {e}"))?;

    // Restart the running sidecar so /config/providers reflects the login.
    restart_sidecar_if_running(&app, &state)?;
    Ok(true)
}

/// Whether the bundled runtime's credential store (its auth.json) has an entry
/// for this provider. The sidecar writes the token there the moment a browser
/// login completes, so the UI can fall back on it when the pending OAuth
/// callback request is lost (loopback port collision, proxy) — issue #17.
#[tauri::command(async)]
pub fn provider_auth_exists(app: AppHandle, provider_id: String) -> Result<bool, String> {
    let path = runtime_root(&app)?
        .join("xdg-data")
        .join("opencode")
        .join("auth.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(false); // no store yet — no logins
    };
    Ok(auth_has_provider(&text, &provider_id))
}

fn auth_has_provider(text: &str, provider_id: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .is_some_and(|auth| auth.get(provider_id).is_some())
}

/// Deploy the bundled skill packs (Tauri resources) into the app-private
/// profile's global skills dir (`<xdg-config>/opencode/skills/`), which OpenCode
/// scans regardless of project detection: `skills/` is the external ai4s-skills
/// pack, `skills-office/` Anthropic's document skills (docx/pdf/pptx/xlsx),
/// `skills-core/` the first-party skills from `runtime/skills/core`. The
/// workspace's own `.opencode/skills/` stays reserved for skills the user
/// installs. Runs before every sidecar start so app upgrades refresh the packs.
fn deploy_bundled_skills(app: &AppHandle) {
    let dst = match xdg_config_home(app) {
        Ok(cfg) => cfg.join("opencode").join("skills"),
        Err(_) => return,
    };
    let mut bundled: std::collections::HashSet<std::ffi::OsString> = std::collections::HashSet::new();
    let mut all_ok = true;
    for resource in ["skills", "skills-office", "skills-core"] {
        let src = match app
            .path()
            .resolve(resource, tauri::path::BaseDirectory::Resource)
        {
            Ok(p) if p.is_dir() => p,
            _ => {
                all_ok = false; // dev run without `fetch-skills.sh` — nothing to deploy
                continue;
            }
        };
        match sync_skill_pack(&src, &dst) {
            Ok(names) => bundled.extend(names),
            Err(e) => {
                all_ok = false;
                eprintln!("failed to deploy bundled skills ({resource}): {e}");
            }
        }
    }
    // The global skills dir is exclusively app-managed (the user's own skills
    // live in the workspace's `.opencode/skills/`), so any skill dir not in the
    // freshly-bundled set is a stale leftover — e.g. one renamed across an app
    // upgrade (`hpc-slurm` → `remote-compute`) — and must be removed so the
    // obsolete duplicate can't shadow or confuse the agent. Prune ONLY when all
    // three packs deployed cleanly: a partial deploy would make `bundled`
    // incomplete and wrongly delete valid skills.
    if all_ok {
        prune_stale_skills(&dst, &bundled);
    }
}

const OPENCODE_PLUGIN_PACKAGE: &str = "@opencode-ai/plugin";

fn package_dependency_version(path: &Path, package: &str) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()?
        .get("dependencies")?
        .get(package)?
        .as_str()
        .map(str::to_owned)
}

fn installed_package_version(node_modules: &Path, package: &str) -> Option<String> {
    let package_json = package
        .split('/')
        .fold(node_modules.to_path_buf(), |path, part| path.join(part))
        .join("package.json");
    let text = std::fs::read_to_string(package_json).ok()?;
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()?
        .get("version")?
        .as_str()
        .map(str::to_owned)
}

/// Deploy OpenCode's plugin SDK before registering the bundled goal plugin.
/// OpenCode waits for this dependency before opening `/event`; without a local
/// copy, a fresh install performs a live npm install and an unreachable
/// registry leaves the desktop on "Connecting" for minutes.
fn deploy_goal_plugin_dependencies(src: &Path, dst: &Path) -> Result<(), String> {
    let expected = std::fs::read_to_string(src.join(".opencode-plugin-version"))
        .map_err(|_| "bundled goal plugin dependencies are missing".to_string())?;
    let expected = expected.trim();
    if expected.is_empty() {
        return Err("bundled OpenCode plugin version is empty".into());
    }

    let marker = dst.join(".opencode-plugin-version");
    let package_json = dst.join("package.json");
    let package_lock = dst.join("package-lock.json");
    let node_modules = dst.join("node_modules");
    let dependency_ready =
        package_dependency_version(&package_json, OPENCODE_PLUGIN_PACKAGE).as_deref()
            == Some(expected)
        && installed_package_version(&node_modules, OPENCODE_PLUGIN_PACKAGE).as_deref()
            == Some(expected)
        && package_lock.is_file();
    let ready = dependency_ready
        && std::fs::read_to_string(&marker)
            .ok()
            .is_some_and(|v| v.trim() == expected);
    if ready {
        return Ok(());
    }
    // Existing app profiles may predate the marker but already have the exact
    // dependency from OpenCode's old live install. Adopt it without copying the
    // bundled 60 MB tree over the user's profile.
    if dependency_ready {
        return std::fs::write(marker, format!("{expected}\n")).map_err(|e| e.to_string());
    }

    let src_package = src.join("package.json");
    let src_lock = src.join("package-lock.json");
    let src_modules = src.join("node_modules");
    if !src_package.is_file() || !src_lock.is_file() || !src_modules.is_dir() {
        return Err("bundled OpenCode plugin dependency tree is incomplete".into());
    }

    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    copy_dir(&src_modules, &node_modules).map_err(|e| e.to_string())?;

    // A fresh app profile has neither file. Existing profiles created by
    // OpenCode already carry the same dependency; never overwrite a user's
    // additional plugin dependencies or lockfile.
    if !package_json.exists() {
        std::fs::copy(&src_package, &package_json).map_err(|e| e.to_string())?;
    }
    if !package_lock.exists() {
        std::fs::copy(&src_lock, &package_lock).map_err(|e| e.to_string())?;
    }

    if package_dependency_version(&package_json, OPENCODE_PLUGIN_PACKAGE).as_deref()
        != Some(expected)
        || installed_package_version(&node_modules, OPENCODE_PLUGIN_PACKAGE).as_deref()
            != Some(expected)
    {
        return Err("OpenCode plugin dependency version does not match the bundled runtime".into());
    }
    std::fs::write(marker, format!("{expected}\n")).map_err(|e| e.to_string())
}

/// Ship the bundled goal plugin and its already-resolved OpenCode dependency
/// tree into the app-private profile, then return the plugin's absolute path.
/// None in dev runs without the fetch script.
fn deploy_goal_plugin(app: &AppHandle) -> Option<PathBuf> {
    let resource = app
        .path()
        .resolve("goal-plugin", tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|p| p.is_dir())?;
    let src = resource.join("goal-plugin.server.js");
    if !src.is_file() {
        return None;
    }
    let config_dir = xdg_config_home(app).ok()?.join("opencode");
    if let Err(e) = deploy_goal_plugin_dependencies(&resource, &config_dir) {
        eprintln!("failed to deploy goal plugin dependencies: {e}");
        return None;
    }
    let dst = config_dir.join("goal-plugin.server.js");
    std::fs::create_dir_all(&config_dir).ok()?;
    // Refresh on every start so app upgrades replace the plugin in place.
    if let Err(e) = std::fs::copy(&src, &dst) {
        eprintln!("failed to deploy goal plugin: {e}");
        return None;
    }
    Some(dst)
}

/// Ship app-owned custom tools into OpenCode's global tools directory. These
/// tools expose safe, declarative host capabilities (for example, asking the
/// UI to present an existing workspace artifact); they never hand the model a
/// raw window handle or filesystem access outside the active workspace.
fn deploy_workbench_tools(app: &AppHandle) {
    let Ok(src) = app
        .path()
        .resolve("tools", tauri::path::BaseDirectory::Resource)
    else {
        return;
    };
    if !src.is_dir() {
        return;
    }
    let Ok(config_home) = xdg_config_home(app) else {
        return;
    };
    let dst = config_home.join("opencode").join("tools");
    if let Err(e) = std::fs::create_dir_all(&dst) {
        eprintln!("failed to create workbench tools directory: {e}");
        return;
    }
    let Ok(entries) = std::fs::read_dir(&src) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name() else {
            continue;
        };
        if let Err(e) = std::fs::copy(&path, dst.join(name)) {
            eprintln!("failed to deploy workbench tool {}: {e}", path.display());
        }
    }
}

/// Remove every SKILL.md-bearing directory in `dst` whose name is not in
/// `bundled` (the set just deployed). Non-skill directories — including the
/// reserved `user/` tree of installed skills — are left untouched.
fn prune_stale_skills(dst: &Path, bundled: &std::collections::HashSet<std::ffi::OsString>) {
    let Ok(entries) = std::fs::read_dir(dst) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_name() == std::ffi::OsStr::new(USER_SKILLS_DIR) {
            continue;
        }
        if path.is_dir()
            && path.join("SKILL.md").is_file()
            && !bundled.contains(&entry.file_name())
        {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

/// Copy every skill directory under `src` into `dst`, replacing same-named
/// directories (so bundled updates win) and leaving everything else in `dst`
/// alone. Returns the names of the skill directories it deployed (for stale
/// pruning). Directories without a SKILL.md (placeholders) are skipped.
fn sync_skill_pack(src: &Path, dst: &Path) -> std::io::Result<Vec<std::ffi::OsString>> {
    std::fs::create_dir_all(dst)?;
    let mut deployed = Vec::new();
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() || !entry.path().join("SKILL.md").is_file() {
            continue;
        }
        // `user/` belongs to the installed skills — a pack may never claim it.
        if entry.file_name() == std::ffi::OsStr::new(USER_SKILLS_DIR) {
            continue;
        }
        let target = dst.join(entry.file_name());
        if target.exists() {
            std::fs::remove_dir_all(&target)?;
        }
        copy_dir(&entry.path(), &target)?;
        deployed.push(entry.file_name());
    }
    Ok(deployed)
}

fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

/// Reserved subdirectory of the profile's global skills dir holding the skills
/// the USER installs. It lives inside a directory OpenCode already scans
/// (`<xdg-config>/opencode/skills/`, matched recursively by both skill loaders),
/// so an installed skill is available in EVERY workspace — a session's own
/// `.opencode/skills/` would vanish with the next dated session folder (#61).
/// Bundled-pack pruning skips this name, so app upgrades never delete it.
const USER_SKILLS_DIR: &str = "user";

fn user_skills_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(xdg_config_home(app)?
        .join("opencode")
        .join("skills")
        .join(USER_SKILLS_DIR))
}

/// The `name:` from a SKILL.md's YAML frontmatter, or None when the text is not
/// a skill file (no leading frontmatter, no usable name).
fn skill_name_from_markdown(text: &str) -> Option<String> {
    let front = text
        .trim_start_matches('\u{feff}')
        .trim_start()
        .strip_prefix("---")?
        .split_once("\n---")?
        .0
        .to_string();
    front.lines().find_map(|line| {
        let value = line.trim().strip_prefix("name:")?;
        sanitize_skill_name(value.trim().trim_matches(['"', '\'']))
    })
}

/// A skill's name doubles as its directory name — accept only what cannot
/// escape the skills dir (no separators, no `..`, no hidden names).
fn sanitize_skill_name(name: &str) -> Option<String> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    ok.then(|| name.to_string())
}

/// Skill directories in the active workspace's `.opencode/skills/`.
fn workspace_skill_dirs(workspace: &Path) -> Vec<PathBuf> {
    let root = workspace.join(".opencode").join("skills");
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir() && p.join("SKILL.md").is_file())
        .collect()
}

fn dir_name(path: &Path) -> Option<&str> {
    path.file_name().and_then(|n| n.to_str())
}

/// Install a pasted SKILL.md straight into the profile's user skills dir — no
/// model turn, no provider needed — and restart the sidecar so OpenCode
/// rediscovers it (discovery is cached per instance). Returns the skill's name.
#[tauri::command(async)]
pub fn install_skill_markdown(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    text: String,
) -> Result<String, String> {
    let name = skill_name_from_markdown(&text)
        .ok_or_else(|| "not a skill file: it needs YAML frontmatter with a `name:`".to_string())?;
    // A bundled pack owns its name: two skills sharing one name make OpenCode
    // pick whichever it scanned last, so refuse instead of shadowing.
    if xdg_config_home(&app)?
        .join("opencode")
        .join("skills")
        .join(&name)
        .join("SKILL.md")
        .is_file()
    {
        return Err(format!("a bundled skill is already called \"{name}\""));
    }
    let dir = user_skills_dir(&app)?.join(&name);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("SKILL.md"), text.as_bytes()).map_err(|e| e.to_string())?;
    restart_sidecar_if_running(&app, &state)?;
    Ok(name)
}

/// Names already in the workspace's `.opencode/skills/`. Taken before an agent
/// install runs so `adopt_workspace_skills` can tell what it added.
#[tauri::command(async)]
pub fn workspace_skill_names(app: AppHandle) -> Result<Vec<String>, String> {
    Ok(workspace_skill_dirs(&workspace_dir(&app)?)
        .iter()
        .filter_map(|p| dir_name(p).map(str::to_owned))
        .collect())
}

/// Move skills the agent just wrote into the workspace over to the profile's
/// user skills dir, so they outlive that session's folder. `known` is the
/// pre-install listing — a pinned project's own skills stay project-scoped.
/// The workspace copy is dropped once the profile copy is in place: leaving both
/// would give OpenCode two skills with the same name, and it then picks whichever
/// it scanned last. Restarts the sidecar when anything moved; returns the names.
#[tauri::command(async)]
pub fn adopt_workspace_skills(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    known: Vec<String>,
) -> Result<Vec<String>, String> {
    let dst_root = user_skills_dir(&app)?;
    let mut adopted = Vec::new();
    for src in workspace_skill_dirs(&workspace_dir(&app)?) {
        let Some(name) = dir_name(&src) else { continue };
        if known.iter().any(|k| k == name) || sanitize_skill_name(name).is_none() {
            continue;
        }
        let dst = dst_root.join(name);
        if dst.exists() {
            std::fs::remove_dir_all(&dst).map_err(|e| e.to_string())?;
        }
        copy_dir(&src, &dst).map_err(|e| e.to_string())?;
        // Only now that the profile copy exists — a failed cleanup leaves a
        // harmless duplicate, never a lost skill.
        if let Err(e) = std::fs::remove_dir_all(&src) {
            eprintln!("could not remove the workspace copy of {name}: {e}");
        }
        adopted.push(name.to_string());
    }
    if !adopted.is_empty() {
        restart_sidecar_if_running(&app, &state)?;
    }
    Ok(adopted)
}

/// PATH for the sidecar (and everything the agent runs through it). Apps
/// launched from Finder/Dock/a desktop entry get a minimal PATH, so the agent
/// would not find the user's Python/conda/Homebrew tools. Prepend the
/// well-known locations that actually exist — the platform lists differ
/// (macOS Homebrew vs. Linux /opt/conda & Linuxbrew), same as python_candidates.
#[cfg(unix)]
pub(crate) fn enriched_path() -> String {
    let base = std::env::var("PATH").unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_default();

    #[cfg(target_os = "macos")]
    let extras = [
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        format!("{home}/anaconda3/bin"),
        format!("{home}/miniconda3/bin"),
        "/opt/anaconda3/bin".to_string(),
        "/opt/miniconda3/bin".to_string(),
        format!("{home}/.pyenv/shims"),
        format!("{home}/.local/bin"),
    ];
    #[cfg(target_os = "linux")]
    let extras = [
        format!("{home}/anaconda3/bin"),
        format!("{home}/miniconda3/bin"),
        "/opt/conda/bin".to_string(),
        "/opt/anaconda3/bin".to_string(),
        "/opt/miniconda3/bin".to_string(),
        format!("{home}/.pyenv/shims"),
        "/home/linuxbrew/.linuxbrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        format!("{home}/.local/bin"),
    ];
    #[cfg(all(unix, not(target_os = "macos"), not(target_os = "linux")))]
    let extras = [
        format!("{home}/.pyenv/shims"),
        "/usr/local/bin".to_string(),
        format!("{home}/.local/bin"),
    ];

    let mut parts: Vec<String> = extras
        .into_iter()
        .filter(|p| !base.split(':').any(|b| b == p) && std::path::Path::new(p).is_dir())
        .collect();
    if !base.is_empty() {
        parts.push(base);
    }
    parts.join(":")
}

/// Windows twin of the unix version above: GUI apps inherit a PATH without the
/// user's Python/conda, and Anaconda famously does NOT add itself to PATH.
/// Prepend the conda install roots that exist — including `Library\bin`, which
/// conda pythons need on PATH for their DLLs (numpy fails to import otherwise).
#[cfg(windows)]
pub(crate) fn enriched_path() -> String {
    let base = std::env::var("PATH").unwrap_or_default();
    let mut roots: Vec<String> = Vec::new();
    if let Ok(profile) = std::env::var("USERPROFILE") {
        roots.push(format!("{profile}\\anaconda3"));
        roots.push(format!("{profile}\\miniconda3"));
    }
    roots.push("C:\\ProgramData\\anaconda3".into());
    roots.push("C:\\ProgramData\\miniconda3".into());
    let mut extras: Vec<String> = Vec::new();
    for root in roots {
        for dir in [root.clone(), format!("{root}\\Scripts"), format!("{root}\\Library\\bin")] {
            extras.push(dir);
        }
    }
    let mut parts: Vec<String> = extras
        .into_iter()
        .filter(|p| {
            !base.split(';').any(|b| b.eq_ignore_ascii_case(p)) && Path::new(p).is_dir()
        })
        .collect();
    if !base.is_empty() {
        parts.push(base);
    }
    parts.join(";")
}

/// A `std::process::Command` that never pops a console window on Windows.
/// A GUI app spawning a console-subsystem child (python.exe, taskkill, git…)
/// otherwise flashes a black window per spawn — every direct spawn in this
/// crate must go through here. (Sidecars via tauri_plugin_shell already set
/// the flag internally.)
pub(crate) fn quiet_command(bin: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(bin);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Make a secret-holding path owner-only: 700 for directories, 600 for files
/// (unix). The runtime root carries provider/connector API keys in
/// `opencode.jsonc`/`auth.json`, and the sidecar rewrites those files with a
/// default umask while running — locking the DIRECTORY is what holds, since a
/// 700 dir is unreachable for other users whatever the file modes inside. On
/// Windows, %APPDATA% is per-user ACL'd already; nothing to do.
pub(crate) fn tighten_private(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            let mode = if meta.is_dir() { 0o700 } else { 0o600 };
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// `bytes` bytes of OS randomness as lowercase hex. Panics only if the OS
/// CSPRNG is unavailable — a machine state where serving anything is unsafe.
pub(crate) fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("OS random source unavailable");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// Per-run password the sidecar requires on every HTTP request (OpenCode's
/// built-in Basic auth, `OPENCODE_SERVER_PASSWORD`). Generated fresh each app
/// launch and held only in memory — never written to disk — so a local
/// webpage that scans loopback ports can neither drive agent turns nor read
/// `/global/config` (which carries provider API keys). The webview gets it
/// via the `runtime_password` command; Tauri IPC is app-only.
pub(crate) fn server_password() -> &'static str {
    static PASSWORD: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    PASSWORD.get_or_init(|| random_hex(16))
}

/// Expose the per-run sidecar password to the frontend SDK client.
#[tauri::command]
pub fn runtime_password() -> String {
    server_password().to_string()
}

pub(crate) fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
        .unwrap_or(43917)
}

/// Network-proxy setting for the sidecar: `system` (default) follows the OS,
/// `custom <url>` uses a fixed proxy, `none` forces direct connections.
/// Stored as one line in `proxy.txt` under the runtime root.
fn proxy_setting_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_root(app)?.join("proxy.txt"))
}

/// The persisted proxy setting as (mode, url). Unknown/missing → system.
fn read_proxy_setting(app: &AppHandle) -> (String, String) {
    let raw = proxy_setting_file(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default();
    let line = raw.lines().next().unwrap_or("").trim();
    match line.split_once(' ') {
        Some(("custom", url)) if !url.trim().is_empty() => ("custom".into(), url.trim().into()),
        _ if line == "none" => ("none".into(), String::new()),
        _ => ("system".into(), String::new()),
    }
}

/// Accept `http://`, `https://` or `socks5://` with a host:port.
fn validate_proxy_url(url: &str) -> Result<(), String> {
    let rest = ["http://", "https://", "socks5://"]
        .iter()
        .find_map(|s| url.strip_prefix(s))
        .ok_or("proxy URL must start with http://, https:// or socks5://")?;
    let hostport = rest.trim_end_matches('/');
    let (host, port) = hostport
        .rsplit_once(':')
        .ok_or("proxy URL needs a host:port")?;
    if host.is_empty() || port.parse::<u16>().is_err() {
        return Err("proxy URL needs a host:port".into());
    }
    Ok(())
}

/// Proxy env for the sidecar. A GUI app launched from Finder/Dock inherits no
/// shell environment, so a user whose traffic runs through a system proxy
/// (common where provider hosts are unreachable directly) gets a sidecar that
/// cannot reach them: its fetch honors HTTP(S)_PROXY but nothing sets it.
/// Resolved from the persisted setting: `system` mirrors the OS proxy (an
/// existing env always wins — a terminal launch already carries the user's own
/// values), `custom` pins the user's URL, `none` neutralizes even inherited
/// env. Verified live with xAI OAuth (#9): the proxied browser delivers the
/// code, then the sidecar's token exchange to auth.x.ai hangs without a proxy
/// and succeeds with one.
fn resolve_proxy_env(mode: &str, url: &str) -> Vec<(&'static str, String)> {
    // Loopback traffic (the sidecar's own API, provider OAuth callback
    // servers) must never route through a proxy.
    const NO_PROXY_LOOPBACK: &str = "localhost,127.0.0.1,::1";
    match mode {
        "none" => vec![
            ("HTTP_PROXY", String::new()),
            ("HTTPS_PROXY", String::new()),
            ("http_proxy", String::new()),
            ("https_proxy", String::new()),
            ("ALL_PROXY", String::new()),
            ("NO_PROXY", "*".to_string()),
        ],
        "custom" => vec![
            ("HTTP_PROXY", url.to_string()),
            ("HTTPS_PROXY", url.to_string()),
            ("NO_PROXY", NO_PROXY_LOOPBACK.to_string()),
        ],
        _ => {
            if ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]
                .iter()
                .any(|k| std::env::var_os(k).is_some())
            {
                return Vec::new();
            }
            match system_proxy_url() {
                Some(sys) => vec![
                    ("HTTP_PROXY", sys.clone()),
                    ("HTTPS_PROXY", sys),
                    ("NO_PROXY", NO_PROXY_LOOPBACK.to_string()),
                ],
                None => Vec::new(),
            }
        }
    }
}

/// The proxy the sidecar would actually use right now, for display in
/// Settings. None ⇒ direct connections.
fn effective_proxy(mode: &str, url: &str) -> Option<String> {
    match mode {
        "none" => None,
        "custom" => Some(url.to_string()),
        _ => ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]
            .iter()
            .find_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty()))
            .or_else(system_proxy_url),
    }
}

/// PyPI-index and Python-download mirrors for the bundled uv, stored one per
/// line (`pypi <url>` / `python <url>`) in `mirrors.txt` under the runtime root.
/// Empty ⇒ uv's defaults (pypi.org / github.com). Only the uv provisioning
/// flows read these — no long-running sidecar to restart.
fn mirror_setting_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_root(app)?.join("mirrors.txt"))
}

/// The persisted mirrors as (pypi_index_url, python_install_mirror_url).
fn read_mirror_setting(app: &AppHandle) -> (String, String) {
    let raw = mirror_setting_file(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default();
    let (mut pypi, mut python) = (String::new(), String::new());
    for line in raw.lines() {
        match line.trim().split_once(' ') {
            Some(("pypi", v)) => pypi = v.trim().to_string(),
            Some(("python", v)) => python = v.trim().to_string(),
            _ => {}
        }
    }
    (pypi, python)
}

/// Accept an `http(s)://` URL with a non-empty host.
fn validate_mirror_url(url: &str) -> Result<(), String> {
    let rest = ["https://", "http://"]
        .iter()
        .find_map(|s| url.strip_prefix(s))
        .ok_or("mirror URL must start with http:// or https://")?;
    if rest.trim_matches('/').is_empty() {
        return Err("mirror URL needs a host".into());
    }
    Ok(())
}

/// Network env for the bundled uv sidecar (managed-Python download + pip
/// install). Mirrors the OpenCode sidecar's proxy so first-run provisioning
/// works behind the same proxy the agent uses, and adds the optional PyPI /
/// Python-download mirrors. uv reads HTTP(S)_PROXY, `UV_DEFAULT_INDEX` and
/// `UV_PYTHON_INSTALL_MIRROR` from its environment.
pub(crate) fn uv_network_env(app: &AppHandle) -> Vec<(&'static str, String)> {
    let (mode, url) = read_proxy_setting(app);
    let mut env = resolve_proxy_env(&mode, &url);
    let (pypi, python) = read_mirror_setting(app);
    if !pypi.is_empty() {
        env.push(("UV_DEFAULT_INDEX", pypi));
    }
    if !python.is_empty() {
        env.push(("UV_PYTHON_INSTALL_MIRROR", python));
    }
    env
}

/// Proxy env for a bundled sidecar OTHER than opencode (e.g. agent-browser's
/// Chrome download). Same resolution as the OpenCode sidecar so a first-run
/// browser install works behind the user's configured proxy, without the uv
/// mirror vars that only uv understands.
pub(crate) fn sidecar_proxy_env(app: &AppHandle) -> Vec<(&'static str, String)> {
    let (mode, url) = read_proxy_setting(app);
    resolve_proxy_env(&mode, &url)
}

/// The system-configured proxy as a URL, if one is enabled (macOS: scutil).
/// HTTP(S) proxies are preferred — an HTTPS proxy endpoint still speaks plain
/// HTTP CONNECT, hence the http:// scheme — with SOCKS as the fallback.
#[cfg(target_os = "macos")]
fn system_proxy_url() -> Option<String> {
    let out = quiet_command("scutil").arg("--proxy").output().ok()?;
    parse_scutil_proxy(&String::from_utf8_lossy(&out.stdout))
}

/// Parse `scutil --proxy` output (`  Key : value` lines) into a proxy URL.
fn parse_scutil_proxy(text: &str) -> Option<String> {
    let get = |key: &str| -> Option<String> {
        let prefix = format!("{key} : ");
        text.lines()
            .find_map(|l| l.trim().strip_prefix(prefix.as_str()).map(|v| v.trim().to_string()))
    };
    let enabled = |key: &str| get(key).as_deref() == Some("1");
    for (en, host, port, scheme) in [
        ("HTTPSEnable", "HTTPSProxy", "HTTPSPort", "http"),
        ("HTTPEnable", "HTTPProxy", "HTTPPort", "http"),
        ("SOCKSEnable", "SOCKSProxy", "SOCKSPort", "socks5"),
    ] {
        if enabled(en) {
            if let (Some(h), Some(p)) = (get(host), get(port)) {
                return Some(format!("{scheme}://{h}:{p}"));
            }
        }
    }
    None
}

#[cfg(not(target_os = "macos"))]
fn system_proxy_url() -> Option<String> {
    // Windows/Linux: terminal-launched apps inherit the user's proxy env
    // (covered by the passthrough above); no OS store is read here yet.
    None
}

fn spawn_sidecar(app: &AppHandle, port: u16) -> Result<CommandChild, String> {
    let root = runtime_root(app)?;
    let cfg = root.join("xdg-config");
    let data = root.join("xdg-data");
    let cache = root.join("xdg-cache");
    let state = root.join("xdg-state");
    // Run OpenCode inside the user-facing workspace, NOT the app's cwd (which is `/`
    // when launched from Finder) — otherwise it scans the whole filesystem root.
    let workspace = workspace_dir(app)?;
    for d in [&cfg, &data, &cache, &state] {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    // Ship the bundled scientific skills into the app-private OpenCode profile.
    deploy_bundled_skills(app);
    // Host presentation tools are global to the app-owned OpenCode profile and
    // available in every session workspace.
    deploy_workbench_tools(app);
    // Safety default (AGENTS.md non-negotiable): on first run, seed the
    // "approve" permission mode so dangerous shell commands prompt for
    // approval. A mode the user chose (approve or full) is never overridden.
    let cfg_file = effective_config_file(app)?;
    let existing = std::fs::read_to_string(&cfg_file).unwrap_or_default();
    if let Some(seeded) = crate::opencode_config::seed_default_permission(&existing) {
        if let Some(dir) = cfg_file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&cfg_file, seeded).map_err(|e| e.to_string())?;
    }
    // Long conversations must not die on "Input exceeds context window" (#62):
    // turn OpenCode's automatic compaction on for a config that has never
    // said either way, and register the memory layers (global MEMORY.md +
    // each project's own AGENTS.md) the same one-time way. Both respect a
    // later choice by the user — they only seed what is absent.
    {
        let existing = std::fs::read_to_string(&cfg_file).unwrap_or_default();
        if let Some(updated) = crate::opencode_config::seed_compaction(&existing) {
            std::fs::write(&cfg_file, updated).map_err(|e| e.to_string())?;
        }
        let global_memory = global_memory_file(app)?.to_string_lossy().replace('\\', "/");
        let existing = std::fs::read_to_string(&cfg_file).unwrap_or_default();
        // Absent `instructions` means a fresh profile: switch memory on. A
        // config that already lists instructions is the user's, left alone.
        let untouched = serde_json::from_str::<serde_json::Value>(&existing)
            .ok()
            .is_none_or(|v| v.get("instructions").is_none());
        if untouched {
            if let Some(updated) =
                crate::opencode_config::set_memory_enabled(&existing, &global_memory, true)
            {
                std::fs::write(&cfg_file, updated).map_err(|e| e.to_string())?;
            }
        }
    }
    // Goal mode (/goal): register the bundled plugin under its deployed path.
    // Forward slashes everywhere — Windows accepts them, and the config stays
    // portable for opencode's path-spec detection.
    if let Some(plugin_path) = deploy_goal_plugin(app) {
        let existing = std::fs::read_to_string(&cfg_file).unwrap_or_default();
        let path_str = plugin_path.to_string_lossy().replace('\\', "/");
        if let Some(updated) = crate::opencode_config::ensure_goal_plugin(&existing, &path_str) {
            std::fs::write(&cfg_file, updated).map_err(|e| e.to_string())?;
        }
    }
    // Secrets live under the runtime root (provider/connector keys in
    // opencode.jsonc, OpenCode's auth.json) — owner-only on every start, so
    // existing installs are repaired and whatever the sidecar later rewrites
    // inside stays unreachable to other users regardless of its umask.
    tighten_private(&root);
    tighten_private(&cfg_file);
    let home = std::env::var("HOME").unwrap_or_default();
    let port_str = port.to_string();

    let cmd = app
        .shell()
        .sidecar("opencode")
        .map_err(|e| format!("sidecar not found: {e}"))?
        .args(["serve", "--hostname", "127.0.0.1", "--port", port_str.as_str()])
        // Require auth on every request (P0-7): without a password the server
        // trusts ANY localhost-origin page (verified in the 1.17.13 source —
        // its CORS allowlist admits http://localhost:*/127.0.0.1:* wholesale,
        // and `--cors "*"` was only ever an exact-match literal, not a
        // wildcard). The webview authenticates via the SDK; nothing else may.
        .env("OPENCODE_SERVER_PASSWORD", server_password())
        // App-private dirs: OpenCode never touches the user's ~/.config/opencode.
        .env("XDG_CONFIG_HOME", cfg.to_string_lossy().to_string())
        .env("XDG_DATA_HOME", data.to_string_lossy().to_string())
        .env("XDG_CACHE_HOME", cache.to_string_lossy().to_string())
        .env("XDG_STATE_HOME", state.to_string_lossy().to_string())
        .env("HOME", home)
        // Lets bundled skill helpers (e.g. remote-compute's record_run.py) stamp
        // the recording app version into provenance — they run outside the app
        // and can't otherwise know it.
        .env("OPENSCIENCE_APP_VERSION", app.package_info().version.to_string())
        .current_dir(workspace);
    // GUI-launched apps get a minimal PATH; give the agent the user's real tools.
    let mut cmd = cmd.env("PATH", enriched_path());
    // Apply the network-proxy setting so provider logins and API calls work
    // where direct connections are blocked (see resolve_proxy_env).
    let (proxy_mode, proxy_url) = read_proxy_setting(app);
    for (k, v) in resolve_proxy_env(&proxy_mode, &proxy_url) {
        cmd = cmd.env(k, v);
    }

    let (mut rx, child) = cmd.spawn().map_err(|e| format!("failed to spawn opencode: {e}"))?;
    // Drain events so the child's stdout/stderr buffer never blocks it, AND record
    // the failure signals we used to discard. When the ad-hoc-signed sidecar dies
    // during bootstrap (TCC denial, config-merge abort, panic) the only symptom was
    // a generic "Could not open OpenCode event stream" in the UI with no cause. Now
    // stderr, spawn errors, and the exit code land in debug.log next to the
    // frontend's connection attempts. Stdout is left to OpenCode's own log file
    // (xdg-data/opencode/log/opencode.log) so request spam never bloats debug.log.
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stderr(bytes) => {
                    for line in String::from_utf8_lossy(&bytes).split(['\n', '\r']) {
                        let line = line.trim();
                        if !line.is_empty() {
                            crate::debug_log::append(&app, &format!("[opencode] {line}"));
                        }
                    }
                }
                CommandEvent::Error(e) => {
                    crate::debug_log::append(&app, &format!("[opencode] error: {e}"));
                }
                CommandEvent::Terminated(status) => {
                    crate::debug_log::append(
                        &app,
                        &format!("[opencode] terminated: code={:?} signal={:?}", status.code, status.signal),
                    );
                }
                _ => {}
            }
        }
    });
    Ok(child)
}

/// Kill and respawn a running sidecar on its stable port. The lifecycle lock
/// covers the complete state transition, and URL is cleared before spawning so
/// a failed restart can never leave a stale "running" marker behind.
fn restart_sidecar_if_running(
    app: &AppHandle,
    state: &RuntimeState,
) -> Result<Option<String>, String> {
    let mut lifecycle = state.lifecycle.lock().unwrap();
    let Some(child) = lifecycle.child.take() else {
        lifecycle.url = None;
        return Ok(None);
    };
    lifecycle.url = None;
    let _ = child.kill();

    let port = *lifecycle.port.get_or_insert_with(free_port);
    let child = spawn_sidecar(app, port)?;
    let url = format!("http://127.0.0.1:{port}");
    lifecycle.child = Some(child);
    lifecycle.url = Some(url.clone());
    Ok(Some(url))
}

/// Start the bundled OpenCode (idempotent). Returns its base URL. `async`:
/// skill-pack deployment + process spawn at startup must not block the UI
/// thread while the first window paints.
#[tauri::command(async)]
pub fn start_runtime(app: AppHandle, state: State<'_, RuntimeState>) -> Result<String, String> {
    let mut lifecycle = state.lifecycle.lock().unwrap();
    if let (Some(_), Some(url)) = (&lifecycle.child, &lifecycle.url) {
        return Ok(url.clone());
    }
    // Repair any impossible partial state left by an older build or a failed
    // transition before attempting a fresh start.
    if let Some(child) = lifecycle.child.take() {
        let _ = child.kill();
    }
    lifecycle.url = None;

    // Reuse a stable port across restarts so the frontend URL doesn't change.
    let port = *lifecycle.port.get_or_insert_with(free_port);
    let child = spawn_sidecar(&app, port)?;
    let url = format!("http://127.0.0.1:{port}");
    lifecycle.child = Some(child);
    lifecycle.url = Some(url.clone());
    Ok(url)
}

/// The workspace directory the sidecar runs in — the frontend passes it to the
/// SDK so skill discovery is scoped to the right OpenCode instance.
#[tauri::command]
pub fn workspace_path(app: AppHandle) -> Result<String, String> {
    Ok(workspace_dir(&app)?.to_string_lossy().to_string())
}

/// The base folder containing projects and sessions (`~/Documents/OpenScience`).
#[tauri::command]
pub fn workspace_base(app: AppHandle) -> Result<String, String> {
    Ok(base_workspace_dir(&app)?.to_string_lossy().to_string())
}

/// Choose the base folder (Settings → Workspace → Change). Creates its
/// `projects/` and `sessions/` collections and persists the choice. Existing
/// workspaces keep their folders.
#[tauri::command]
pub fn set_workspace_base(app: AppHandle, path: String) -> Result<String, String> {
    let dir = PathBuf::from(&path);
    if !dir.is_absolute() {
        return Err("workspace base must be absolute".into());
    }
    ensure_base_layout(dir.clone()).map_err(|e| format!("could not create folder: {e}"))?;
    let canon = dir.canonicalize().map_err(|e| e.to_string())?;
    std::fs::write(base_workspace_file(&app)?, canon.to_string_lossy().as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(canon.to_string_lossy().to_string())
}

/// Reveal the base workspace folder in the OS file manager. (The sandboxed
/// `open_path` resolves inside the ACTIVE workspace only, which may be a dated
/// subfolder — the base needs its own door.)
#[tauri::command]
pub fn open_workspace_base(app: AppHandle) -> Result<(), String> {
    crate::artifact_file::os_open(&base_workspace_dir(&app)?)
}

/// Switch the active workspace folder: create it if needed and persist the
/// choice. The kernel / Files / provenance read the folder via `workspace_dir`;
/// the agent runtime is scoped per request — the frontend reconnects its event
/// stream with `?directory=` and creates sessions with it (a bare `/event`
/// stream would not see other folders' instances, so the scoped stream is
/// required). `path` must be absolute.
#[tauri::command(async)]
pub fn set_workspace(
    app: AppHandle,
    _state: State<'_, RuntimeState>,
    path: String,
) -> Result<String, String> {
    let dir = PathBuf::from(&path);
    if !dir.is_absolute() {
        return Err("workspace path must be absolute".into());
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create folder: {e}"))?;
    let canon = dir.canonicalize().map_err(|e| e.to_string())?;
    std::fs::write(active_workspace_file(&app)?, canon.to_string_lossy().as_bytes())
        .map_err(|e| e.to_string())?;

    // Follow the active folder with the snapshot watcher so out-of-app edits
    // (external editor, detached process) in the new workspace are captured too.
    crate::git_snapshot::watch_workspace(&canon);

    // No sidecar restart: OpenCode serves every folder from one process via
    // per-directory instances, and the frontend reconnects its event stream
    // with `?directory=<new folder>`. Restarting here used to cost 3-6 s per
    // history-session switch (process boot + reconnect polling).
    // Jupyter-lab, however, pins its root_dir at spawn time — re-root it (in
    // the background) so agent-created notebooks land in the new folder.
    crate::jupyter::reroot_jupyter(&app);
    // Refresh this session's local copy of the remote-machine list from the
    // canonical base file, so a machine configured in Settings is visible to
    // every session's agent without reaching outside the workspace.
    crate::compute::materialize_active(&app);
    Ok(canon.to_string_lossy().to_string())
}

/// Record which session owns the active workspace, so bundled skill helpers
/// (record_run.py) can stamp remote runs with their `sessionId` — the app knows
/// the id but the off-app helper only sees the workspace. Written as
/// `<workspace>/.openscience/session.txt`; best-effort, empty ids are ignored.
#[tauri::command]
pub fn mark_session(app: AppHandle, session_id: String) -> Result<(), String> {
    let id = session_id.trim();
    if id.is_empty() {
        return Ok(());
    }
    let dir = workspace_dir(&app)?.join(".openscience");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("session.txt");
    // Write-then-rename so a concurrent read never sees a half-written id.
    let tmp = path.with_extension("txt.tmp");
    std::fs::write(&tmp, id).map_err(|e| e.to_string())?;
    if std::fs::rename(&tmp, &path).is_err() {
        let _ = std::fs::write(&path, id);
        let _ = std::fs::remove_file(&tmp);
    }
    Ok(())
}

/// Create a new dated folder `<base>/sessions/<name>` and switch to it. `name`
/// is a single path segment (the frontend supplies a timestamp); rejects
/// separators.
#[tauri::command(async)]
pub fn new_dated_workspace(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    name: String,
) -> Result<String, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("invalid folder name".into());
    }
    let dir = sessions_dir(&app)?.join(&name);
    // `set_workspace` moves `app`; keep a handle to seed the harness afterwards.
    let seed_app = app.clone();
    let canon = set_workspace(app, state, dir.to_string_lossy().to_string())?;
    // Seed the agent harness into the fresh folder so it starts with its
    // operating rules, not an empty directory. Only NEW dated folders get seeded
    // (never `set_workspace` alone — switching to an existing session must not
    // re-plant the scaffold).
    crate::harness::seed_harness(&seed_app, std::path::Path::new(&canon));
    crate::git_snapshot::commit_best_effort(std::path::Path::new(&canon), "Initialize workspace");
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

/// Characters a file name cannot carry on Windows/macOS/Linux, plus control
/// characters. Conversation titles are free text, so a title becomes a file
/// name only after this.
fn safe_file_stem(title: &str, fallback: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '-'
            } else {
                c
            }
        })
        .collect();
    // Windows also rejects a trailing dot or space.
    let trimmed = cleaned.trim().trim_end_matches('.').trim();
    // 80 chars leaves room for the id suffix and the extension inside the
    // 255-byte limit every mainstream filesystem enforces.
    let capped: String = trimmed.chars().take(80).collect();
    let capped = capped.trim().to_string();
    if capped.is_empty() {
        return fallback.to_string();
    }
    // Windows refuses these device names whatever the extension.
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.iter().any(|r| capped.eq_ignore_ascii_case(r)) {
        return format!("{capped}-");
    }
    capped
}

/// Write one exported conversation into a folder the user picked in a native
/// dialog. Confined to that folder: the file name is derived from the title
/// (never used as a path), so a conversation called "../../.ssh/authorized_keys"
/// cannot escape it.
#[tauri::command]
pub fn write_export_file(
    directory: String,
    name: String,
    contents: String,
) -> Result<String, String> {
    let dir = PathBuf::from(&directory);
    if !dir.is_dir() {
        return Err(format!("{directory} is not a folder"));
    }
    let stem = safe_file_stem(&name, "conversation");
    let mut path = dir.join(format!("{stem}.md"));
    // Two conversations can share a title; never silently overwrite one.
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem} ({n}).md"));
        n += 1;
        if n > 999 {
            return Err("too many files with that name".to_string());
        }
    }
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Kill the bundled OpenCode if running.
#[tauri::command]
pub fn stop_runtime(state: State<'_, RuntimeState>) {
    let mut lifecycle = state.lifecycle.lock().unwrap();
    if let Some(child) = lifecycle.child.take() {
        let _ = child.kill();
    }
    lifecycle.url = None;
}

pub fn kill_child(state: &RuntimeState) {
    let mut lifecycle = state.lifecycle.lock().unwrap();
    if let Some(child) = lifecycle.child.take() {
        let _ = child.kill();
    }
    lifecycle.url = None;
}

#[cfg(test)]
mod tests {
    use super::{
        auth_has_provider, deploy_goal_plugin_dependencies, parse_scutil_proxy,
        ensure_base_layout, prune_stale_skills, random_hex, remove_key_from_config,
        resolve_proxy_env, skill_name_from_markdown, sync_skill_pack, validate_proxy_url,
        workspace_skill_dirs,
    };
    use std::fs;

    #[test]
    fn auth_store_provider_lookup() {
        let auth = r#"{ "openai": { "type": "oauth", "refresh": "r", "access": "a" } }"#;
        assert!(auth_has_provider(auth, "openai"));
        assert!(!auth_has_provider(auth, "anthropic"));
        assert!(!auth_has_provider("", "openai")); // empty/corrupt store
        assert!(!auth_has_provider("not json", "openai"));
    }

    #[test]
    fn base_layout_has_separate_project_and_session_collections() {
        let root =
            std::env::temp_dir().join(format!("os-workspace-layout-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);

        assert_eq!(ensure_base_layout(root.clone()).unwrap(), root);
        assert!(root.join("projects").is_dir());
        assert!(root.join("sessions").is_dir());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn proxy_url_validation() {
        assert!(validate_proxy_url("http://127.0.0.1:7890").is_ok());
        assert!(validate_proxy_url("socks5://10.0.0.2:1080").is_ok());
        assert!(validate_proxy_url("http://[::1]:8080").is_ok());
        assert!(validate_proxy_url("127.0.0.1:7890").is_err()); // no scheme
        assert!(validate_proxy_url("http://host").is_err()); // no port
        assert!(validate_proxy_url("http://:7890").is_err()); // no host
        assert!(validate_proxy_url("ftp://h:1").is_err()); // wrong scheme
    }

    #[test]
    fn proxy_env_modes() {
        let none = resolve_proxy_env("none", "");
        assert!(none.iter().any(|(k, v)| *k == "NO_PROXY" && v == "*"));
        assert!(none.iter().any(|(k, v)| *k == "HTTPS_PROXY" && v.is_empty()));

        let custom = resolve_proxy_env("custom", "http://127.0.0.1:7890");
        assert!(custom.iter().any(|(k, v)| *k == "HTTPS_PROXY" && v == "http://127.0.0.1:7890"));
        assert!(custom.iter().any(|(k, v)| *k == "NO_PROXY" && v.contains("127.0.0.1")));
    }

    #[test]
    fn scutil_proxy_parses_and_prefers_https() {
        // Real `scutil --proxy` shape (indented `Key : value` lines).
        let all = "<dictionary> {\n  HTTPEnable : 1\n  HTTPPort : 1087\n  HTTPProxy : 127.0.0.1\n  HTTPSEnable : 1\n  HTTPSPort : 1087\n  HTTPSProxy : 127.0.0.1\n  SOCKSEnable : 1\n  SOCKSPort : 1087\n  SOCKSProxy : 127.0.0.1\n}";
        assert_eq!(parse_scutil_proxy(all).as_deref(), Some("http://127.0.0.1:1087"));
        let socks_only = "  SOCKSEnable : 1\n  SOCKSPort : 7890\n  SOCKSProxy : 10.0.0.2\n";
        assert_eq!(parse_scutil_proxy(socks_only).as_deref(), Some("socks5://10.0.0.2:7890"));
        let disabled = "  HTTPEnable : 0\n  HTTPPort : 1087\n  HTTPProxy : 127.0.0.1\n";
        assert_eq!(parse_scutil_proxy(disabled), None);
        assert_eq!(parse_scutil_proxy(""), None);
    }

    #[test]
    fn prune_removes_only_stale_skill_dirs() {
        let dst = std::env::temp_dir().join(format!("os-prune-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dst);
        for name in ["remote-compute", "hpc-slurm"] {
            fs::create_dir_all(dst.join(name)).unwrap();
            fs::write(dst.join(name).join("SKILL.md"), b"---\n").unwrap();
        }
        // A directory without a SKILL.md must never be touched.
        fs::create_dir_all(dst.join("notes")).unwrap();

        let mut bundled = std::collections::HashSet::new();
        bundled.insert(std::ffi::OsString::from("remote-compute"));
        prune_stale_skills(&dst, &bundled);

        assert!(dst.join("remote-compute").is_dir(), "bundled skill kept");
        assert!(!dst.join("hpc-slurm").exists(), "stale renamed skill removed");
        assert!(dst.join("notes").is_dir(), "non-skill dir left alone");
        let _ = fs::remove_dir_all(&dst);
    }

    #[test]
    fn prune_keeps_installed_user_skills() {
        // The reserved `user/` tree holds what the user installed — an app
        // upgrade (which prunes everything unbundled) must never delete it (#61).
        let dst = std::env::temp_dir().join(format!("os-prune-user-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dst);
        let installed = dst.join("user").join("my-skill");
        fs::create_dir_all(&installed).unwrap();
        fs::write(installed.join("SKILL.md"), b"---\nname: my-skill\n---\n").unwrap();
        // A SKILL.md directly inside `user/` (not a skill dir of its own) too.
        fs::write(dst.join("user").join("SKILL.md"), b"---\n").unwrap();

        prune_stale_skills(&dst, &std::collections::HashSet::new());

        assert!(installed.join("SKILL.md").is_file(), "installed skill kept");
        let _ = fs::remove_dir_all(&dst);
    }

    #[test]
    fn skill_name_comes_from_frontmatter_and_is_safe() {
        assert_eq!(
            skill_name_from_markdown("---\nname: my-skill\ndescription: x\n---\n\nbody\n")
                .as_deref(),
            Some("my-skill"),
        );
        // Quoted, CRLF, and a leading BOM all still parse.
        assert_eq!(
            skill_name_from_markdown("\u{feff}---\r\nname: \"quoted_1\"\r\n---\r\n").as_deref(),
            Some("quoted_1"),
        );
        // Not a skill file, or a name that cannot be a directory.
        assert_eq!(skill_name_from_markdown("# just markdown\n"), None);
        assert_eq!(skill_name_from_markdown("---\ndescription: x\n---\n"), None);
        assert_eq!(skill_name_from_markdown("---\nname: ../escape\n---\n"), None);
        assert_eq!(skill_name_from_markdown("---\nname: sub/dir\n---\n"), None);
        assert_eq!(skill_name_from_markdown("---\nname: .hidden\n---\n"), None);
        assert_eq!(skill_name_from_markdown("---\nname:\n---\n"), None);
    }

    #[test]
    fn workspace_skill_dirs_lists_only_real_skills() {
        let ws = std::env::temp_dir().join(format!("os-ws-skills-{}", std::process::id()));
        let _ = fs::remove_dir_all(&ws);
        let root = ws.join(".opencode").join("skills");
        fs::create_dir_all(root.join("installed")).unwrap();
        fs::write(root.join("installed").join("SKILL.md"), b"---\n").unwrap();
        fs::create_dir_all(root.join("half-written")).unwrap(); // no SKILL.md yet
        fs::write(root.join("loose.md"), b"---\n").unwrap();

        let found = workspace_skill_dirs(&ws);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].file_name().unwrap(), "installed");
        // A workspace with no .opencode/skills at all is simply empty.
        assert!(workspace_skill_dirs(&std::env::temp_dir().join("os-nope")).is_empty());
        let _ = fs::remove_dir_all(&ws);
    }

    #[cfg(unix)]
    #[test]
    fn tighten_private_makes_dir_and_secrets_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("os-private-{}", std::process::id()));
        let sub = dir.join("opencode");
        fs::create_dir_all(&sub).unwrap();
        let cfg = sub.join("opencode.jsonc");
        fs::write(&cfg, b"{\"apiKey\":\"secret\"}").unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(&cfg, fs::Permissions::from_mode(0o644)).unwrap();

        // The runtime root holds provider/connector keys (opencode.jsonc,
        // auth.json) — it must be unreadable to other users even when the
        // sidecar later rewrites files inside with a default umask.
        super::tighten_private(&dir);
        assert_eq!(fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        super::tighten_private(&cfg);
        assert_eq!(fs::metadata(&cfg).unwrap().permissions().mode() & 0o777, 0o600);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn random_hex_is_csprng_shaped() {
        // 16 bytes → 32 hex chars, fresh per call — the shape the sidecar
        // password and the preview/Jupyter tokens rely on.
        let a = random_hex(16);
        let b = random_hex(16);
        assert_eq!(a.len(), 32);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b, "two draws must differ");
    }

    #[test]
    fn removes_only_the_named_config_entry() {
        let cfg = r#"{"model":"a/b","provider":{"ollama":{"npm":"x"},"keep":{"npm":"y"}},"mcp":{"pw":{"type":"local"}}}"#;
        let out = remove_key_from_config(cfg, "provider", "ollama").unwrap();
        assert!(!out.contains("ollama"));
        assert!(out.contains("keep"));
        assert!(out.contains("\"model\": \"a/b\""));
        let out2 = remove_key_from_config(cfg, "mcp", "pw").unwrap();
        assert!(!out2.contains("\"pw\""));
        // Absent key and non-JSON input are errors, not silent no-ops.
        assert!(remove_key_from_config(cfg, "provider", "missing").is_err());
        assert!(remove_key_from_config("// jsonc comment\n{}", "provider", "x").is_err());
    }

    fn write(path: &std::path::Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    #[test]
    fn deploys_goal_plugin_dependencies_without_network() {
        let tmp = std::env::temp_dir().join(format!("goal-deps-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let src = tmp.join("src");
        let dst = tmp.join("dst");
        write(&src.join(".opencode-plugin-version"), "1.17.13\n");
        write(
            &src.join("package.json"),
            r#"{"dependencies":{"@opencode-ai/plugin":"1.17.13"}}"#,
        );
        write(&src.join("package-lock.json"), "{}");
        write(
            &src.join("node_modules/@opencode-ai/plugin/package.json"),
            r#"{"name":"@opencode-ai/plugin","version":"1.17.13"}"#,
        );
        write(
            &src.join("node_modules/@opencode-ai/plugin/dist/tool.js"),
            "export const tool = (x) => x;",
        );

        deploy_goal_plugin_dependencies(&src, &dst).unwrap();

        assert_eq!(
            fs::read_to_string(dst.join(".opencode-plugin-version")).unwrap(),
            "1.17.13\n"
        );
        assert!(dst
            .join("node_modules/@opencode-ai/plugin/dist/tool.js")
            .is_file());
        assert!(dst.join("package-lock.json").is_file());
        fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn adopts_existing_goal_plugin_dependencies_without_recopying() {
        let tmp =
            std::env::temp_dir().join(format!("goal-deps-existing-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let src = tmp.join("src");
        let dst = tmp.join("dst");
        write(&src.join(".opencode-plugin-version"), "1.17.13\n");
        write(
            &dst.join("package.json"),
            r#"{"dependencies":{"@opencode-ai/plugin":"1.17.13","user-plugin":"2.0.0"}}"#,
        );
        write(&dst.join("package-lock.json"), "{}");
        write(
            &dst.join("node_modules/@opencode-ai/plugin/package.json"),
            r#"{"name":"@opencode-ai/plugin","version":"1.17.13"}"#,
        );
        write(&dst.join("node_modules/user-plugin/keep.txt"), "keep");

        deploy_goal_plugin_dependencies(&src, &dst).unwrap();

        assert_eq!(
            fs::read_to_string(dst.join(".opencode-plugin-version")).unwrap(),
            "1.17.13\n"
        );
        assert_eq!(
            fs::read_to_string(dst.join("node_modules/user-plugin/keep.txt")).unwrap(),
            "keep"
        );
        fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn sync_replaces_bundled_and_keeps_user_skills() {
        let tmp = std::env::temp_dir().join(format!("skillsync-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let src = tmp.join("src");
        let dst = tmp.join("dst");

        // Bundled pack: one skill with a nested reference file, plus a top-level
        // plain file (.commit) that must NOT be copied.
        write(&src.join("paper-writer/SKILL.md"), "v2");
        write(&src.join("paper-writer/references/guide.md"), "ref");
        write(&src.join(".commit"), "abc123");
        // A placeholder dir without SKILL.md must not be deployed.
        fs::create_dir_all(src.join("placeholder")).unwrap();

        // Existing workspace: a stale copy of the bundled skill (with a file the
        // new version no longer has) and a user-installed skill.
        write(&dst.join("paper-writer/SKILL.md"), "v1");
        write(&dst.join("paper-writer/obsolete.md"), "old");
        write(&dst.join("my-skill/SKILL.md"), "user");

        sync_skill_pack(&src, &dst).unwrap();

        assert_eq!(fs::read_to_string(dst.join("paper-writer/SKILL.md")).unwrap(), "v2");
        assert_eq!(
            fs::read_to_string(dst.join("paper-writer/references/guide.md")).unwrap(),
            "ref"
        );
        assert!(!dst.join("paper-writer/obsolete.md").exists(), "stale file must be gone");
        assert_eq!(fs::read_to_string(dst.join("my-skill/SKILL.md")).unwrap(), "user");
        assert!(!dst.join(".commit").exists(), "top-level files are not skills");
        assert!(!dst.join("placeholder").exists(), "dirs without SKILL.md are not skills");

        fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn sync_creates_destination_when_missing() {
        let tmp = std::env::temp_dir().join(format!("skillsync-new-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let src = tmp.join("src");
        write(&src.join("literature-survey/SKILL.md"), "s");

        let dst = tmp.join("deep/nested/skills");
        sync_skill_pack(&src, &dst).unwrap();
        assert_eq!(
            fs::read_to_string(dst.join("literature-survey/SKILL.md")).unwrap(),
            "s"
        );
        fs::remove_dir_all(&tmp).unwrap();
    }
}

/// Remove an entry from a map section of the app-private global OpenCode
/// config ("provider" or "mcp") and restart the sidecar (PATCH /global/config
/// cannot delete keys).
#[tauri::command(async)]
pub fn remove_config_entry(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    section: String,
    key: String,
) -> Result<(), String> {
    if !matches!(section.as_str(), "provider" | "mcp") {
        return Err(format!("section \"{section}\" is not removable"));
    }
    let dir = xdg_config_home(&app)?.join("opencode");
    // The server writes opencode.jsonc; older configs may be opencode.json.
    let path = ["opencode.jsonc", "opencode.json"]
        .iter()
        .map(|n| dir.join(n))
        .find(|p| p.exists())
        .ok_or("no global OpenCode config found")?;
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let out = remove_key_from_config(&text, &section, &key)?;
    std::fs::write(&path, out).map_err(|e| e.to_string())?;
    tighten_private(&path);

    restart_sidecar_if_running(&app, &state)?;
    Ok(())
}

/// Drop `key` from the config JSON's `section` map, erroring when the config
/// is not plain JSON or the key is absent.
fn remove_key_from_config(text: &str, section: &str, key: &str) -> Result<String, String> {
    let mut cfg: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("config is not plain JSON: {e}"))?;
    let removed = cfg
        .get_mut(section)
        .and_then(|p| p.as_object_mut())
        .map(|p| p.remove(key).is_some())
        .unwrap_or(false);
    if !removed {
        return Err(format!("\"{key}\" is not in the config's {section} section"));
    }
    serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())
}

/// The current approval mode ("approve" | "full"). Spawn seeding guarantees a
/// mode exists once the runtime has started; before that, report the default.
#[tauri::command]
pub fn get_approval_mode(app: AppHandle) -> Result<String, String> {
    let path = effective_config_file(&app)?;
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    Ok(crate::opencode_config::permission_mode_of(&existing)
        .unwrap_or(crate::opencode_config::MODE_APPROVE)
        .to_string())
}

/// Switch the approval mode and restart the sidecar so the permission rules
/// take effect. Returns the (stable-port) base URL when it was running.
#[tauri::command(async)]
pub fn set_approval_mode(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    mode: String,
) -> Result<String, String> {
    let path = effective_config_file(&app)?;
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let updated = crate::opencode_config::set_permission_mode(&existing, &mode)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, updated).map_err(|e| e.to_string())?;
    tighten_private(&path);

    // Same restart flow as configure_opencode: reload rules on a stable port.
    Ok(restart_sidecar_if_running(&app, &state)?
        .unwrap_or_else(|| path.to_string_lossy().to_string()))
}

/// The global memory file: one Markdown document that OpenCode loads into
/// every conversation, in the app-private profile next to the config.
fn global_memory_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(xdg_config_home(app)?.join("opencode").join("MEMORY.md"))
}

/// Absolute path of a memory file, forward-slashed so the config stays
/// portable. `scope` is "global" (the profile file) or "project" (that
/// folder's own AGENTS.md — the file OpenCode loads for sessions inside it).
fn memory_file(app: &AppHandle, scope: &str, directory: Option<&str>) -> Result<PathBuf, String> {
    match scope {
        "global" => global_memory_file(app),
        "project" => {
            let dir = directory.filter(|d| !d.is_empty()).ok_or("no project folder")?;
            Ok(PathBuf::from(dir).join(crate::opencode_config::PROJECT_MEMORY_FILE))
        }
        other => Err(format!("unknown memory scope \"{other}\"")),
    }
}

/// Read a memory layer. A file that was never written reads as empty — the
/// editor opens blank rather than erroring.
#[tauri::command]
pub fn read_memory(
    app: AppHandle,
    scope: String,
    directory: Option<String>,
) -> Result<String, String> {
    let path = memory_file(&app, &scope, directory.as_deref())?;
    Ok(std::fs::read_to_string(path).unwrap_or_default())
}

/// Replace a memory layer's contents. Writing an empty document deletes the
/// file, so "cleared" and "never set" stay the same state.
#[tauri::command]
pub fn write_memory(
    app: AppHandle,
    scope: String,
    directory: Option<String>,
    text: String,
) -> Result<(), String> {
    let path = memory_file(&app, &scope, directory.as_deref())?;
    if text.trim().is_empty() {
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, text).map_err(|e| e.to_string())
}

/// Append a block to a memory layer, keeping what is already there. This is
/// what "save this to memory" from a conversation does.
#[tauri::command]
pub fn append_memory(
    app: AppHandle,
    scope: String,
    directory: Option<String>,
    text: String,
) -> Result<(), String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let path = memory_file(&app, &scope, directory.as_deref())?;
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let mut out = existing.trim_end().to_string();
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(trimmed);
    out.push('\n');
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, out).map_err(|e| e.to_string())
}

/// Whether the memory layers are currently applied to conversations.
#[tauri::command]
pub fn get_memory_enabled(app: AppHandle) -> Result<bool, String> {
    let global = global_memory_file(&app)?.to_string_lossy().replace('\\', "/");
    let existing = std::fs::read_to_string(effective_config_file(&app)?).unwrap_or_default();
    Ok(crate::opencode_config::memory_enabled(&existing, &global))
}

/// Apply or stop applying the memory layers, restarting the sidecar so the
/// change takes effect (instructions are read when a session's context is built).
#[tauri::command(async)]
pub fn set_memory_enabled(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    enabled: bool,
) -> Result<(), String> {
    let global = global_memory_file(&app)?.to_string_lossy().replace('\\', "/");
    let path = effective_config_file(&app)?;
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let Some(updated) = crate::opencode_config::set_memory_enabled(&existing, &global, enabled)
    else {
        return Ok(()); // already in the requested state — no restart
    };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, updated).map_err(|e| e.to_string())?;
    tighten_private(&path);
    restart_sidecar_if_running(&app, &state)?;
    Ok(())
}

/// Per-agent model overrides as `{ agent: "provider/model" }`.
#[tauri::command]
pub fn get_agent_models(app: AppHandle) -> Result<serde_json::Value, String> {
    let existing = std::fs::read_to_string(effective_config_file(&app)?).unwrap_or_default();
    let map: serde_json::Map<String, serde_json::Value> =
        crate::opencode_config::agent_models(&existing)
            .into_iter()
            .map(|(k, v)| (k, serde_json::Value::String(v)))
            .collect();
    Ok(serde_json::Value::Object(map))
}

/// Pin one agent to its own model, or clear the override with an empty model.
/// Restarts the sidecar: agent definitions are built when it loads its config.
#[tauri::command(async)]
pub fn set_agent_model(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    agent: String,
    model: String,
) -> Result<(), String> {
    let path = effective_config_file(&app)?;
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let want = if model.is_empty() { None } else { Some(model.as_str()) };
    let updated = crate::opencode_config::set_agent_model(&existing, &agent, want);
    if updated == existing {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, updated).map_err(|e| e.to_string())?;
    tighten_private(&path);
    restart_sidecar_if_running(&app, &state)?;
    Ok(())
}

/// The persisted proxy setting plus the proxy the sidecar would use right now.
#[tauri::command]
pub fn get_proxy_setting(app: AppHandle) -> Result<serde_json::Value, String> {
    let (mode, url) = read_proxy_setting(&app);
    let effective = effective_proxy(&mode, &url);
    Ok(serde_json::json!({ "mode": mode, "url": url, "effective": effective }))
}

/// Persist the proxy setting ("system" | "custom" | "none", url for custom)
/// and restart the sidecar so its network env takes effect.
#[tauri::command(async)]
pub fn set_proxy_setting(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    mode: String,
    url: String,
) -> Result<String, String> {
    let line = match mode.as_str() {
        "system" => "system".to_string(),
        "none" => "none".to_string(),
        "custom" => {
            let url = url.trim();
            validate_proxy_url(url)?;
            format!("custom {url}")
        }
        other => return Err(format!("unknown proxy mode: {other}")),
    };
    let path = proxy_setting_file(&app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, line).map_err(|e| e.to_string())?;

    // Same restart flow as set_approval_mode: the env only applies at spawn.
    Ok(restart_sidecar_if_running(&app, &state)?
        .unwrap_or_else(|| path.to_string_lossy().to_string()))
}

/// The persisted uv mirrors (empty string ⇒ use uv's default index/mirror).
#[tauri::command]
pub fn get_mirror_setting(app: AppHandle) -> Result<serde_json::Value, String> {
    let (pypi, python) = read_mirror_setting(&app);
    Ok(serde_json::json!({ "pypi": pypi, "python": python }))
}

/// Persist the uv mirrors. Blank fields clear that mirror. No sidecar restart:
/// only the next provisioning run (Jupyter / science MCP) reads them.
#[tauri::command]
pub fn set_mirror_setting(app: AppHandle, pypi: String, python: String) -> Result<(), String> {
    let (pypi, python) = (pypi.trim(), python.trim());
    let mut lines = Vec::new();
    if !pypi.is_empty() {
        validate_mirror_url(pypi)?;
        lines.push(format!("pypi {pypi}"));
    }
    if !python.is_empty() {
        validate_mirror_url(python)?;
        lines.push(format!("python {python}"));
    }
    let path = mirror_setting_file(&app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, lines.join("\n")).map_err(|e| e.to_string())
}

/// Write the provider key/model into the app-private OpenCode config and restart
/// the sidecar so it picks them up. Returns the same base URL (stable port).
#[tauri::command(async)]
pub fn configure_opencode(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    provider: String,
    api_key: String,
    model: String,
    base_url: Option<String>,
) -> Result<String, String> {
    let path = opencode_config_file(&app)?;
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let merged = merge_config(&existing, &provider, &api_key, &model, base_url.as_deref())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, merged).map_err(|e| e.to_string())?;
    tighten_private(&path);

    // Restart so the running server reloads the new provider config.
    Ok(restart_sidecar_if_running(&app, &state)?
        .unwrap_or_else(|| path.to_string_lossy().to_string()))
}

#[cfg(test)]
mod export_tests {
    use super::safe_file_stem;

    #[test]
    fn a_title_can_never_become_a_path() {
        // Separators become dashes, so the result can only ever be a leaf name.
        assert_eq!(
            safe_file_stem("../../.ssh/authorized_keys", "x"),
            "..-..-.ssh-authorized_keys"
        );
        assert_eq!(safe_file_stem("C:\\Windows\\System32", "x"), "C--Windows-System32");
    }

    #[test]
    fn keeps_ordinary_titles_readable_including_non_latin() {
        assert_eq!(safe_file_stem("Spike sorting — pass 2", "x"), "Spike sorting — pass 2");
        assert_eq!(safe_file_stem("脑机接口趋势分析", "x"), "脑机接口趋势分析");
    }

    #[test]
    fn falls_back_when_a_title_leaves_nothing_usable() {
        assert_eq!(safe_file_stem("   ", "conversation"), "conversation");
        // Nothing but separators still yields a harmless leaf name.
        assert_eq!(safe_file_stem("///", "conversation"), "---");
        // Windows rejects a trailing dot.
        assert_eq!(safe_file_stem("results.", "x"), "results");
    }

    #[test]
    fn sidesteps_windows_device_names() {
        assert_eq!(safe_file_stem("CON", "x"), "CON-");
        assert_eq!(safe_file_stem("nul", "x"), "nul-");
        assert_eq!(safe_file_stem("console", "x"), "console");
    }

    #[test]
    fn caps_the_length_so_the_filesystem_accepts_it() {
        let long = "n".repeat(500);
        assert_eq!(safe_file_stem(&long, "x").chars().count(), 80);
    }
}
