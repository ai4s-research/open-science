// The desktop's door onto `osd_core::artifact_file`, plus the parts that only
// make sense with a desktop in front of them: the OS file manager, the default
// browser, and native file dialogs.
use std::path::{Path, PathBuf};

use tauri::AppHandle;

use crate::env_of;

pub use osd_core::artifact_file::{
    locate_under, mime_for, resolve_under, ArtifactFile, DirEntry, NotebookEntry,
};

/// Windows only — `reveal_impl` below hands Explorer a plain path, never the
/// `\\?\` verbatim form `canonicalize()` produces (Explorer rejects it). This
/// re-export is cfg'd because an unconditional one warns as unused everywhere
/// else, and trimming it on that advice is exactly how it went missing: the
/// Windows build then failed to compile, which no macOS or Linux build could
/// have shown.
#[cfg(target_os = "windows")]
pub use osd_core::artifact_file::native_path;

/// The folder tree a file command operates in: the ACTIVE session workspace
/// (default) or the base folder every session workspace is created under.
pub fn scope_root(app: &AppHandle, root: Option<&str>) -> Result<PathBuf, String> {
    osd_core::artifact_file::scope_root(&env_of(app), root)
}

/// Open an absolute path with the OS default application / file manager.
/// Via the `opener` crate: on Windows that is ShellExecuteW — NEVER
/// `cmd /C start`, which re-parses `&`/`^`/`|` so an agent-emitted argument
/// could execute commands (and any legit path containing `&` broke). It also
/// reaps the helper process (the old spawn-and-forget leaked zombies).
pub fn os_open(full: &Path) -> Result<(), String> {
    opener::open(full).map_err(|e| format!("open failed: {e}"))
}

// Windows: opener's reveal uses SHOpenFolderAndSelectItems (COM), which can
// return a spurious IO error even when it would work. `explorer /select,<path>`
// is the reliable path — but explorer returns a NON-ZERO exit code even on
// success, so we spawn and don't wait; and it rejects the `\\?\` verbatim form
// that canonicalize() produces, so we pass the plain path. `raw_arg` keeps
// explorer's non-standard `/select,"…"` token intact (Rust must not re-quote).
#[cfg(target_os = "windows")]
fn reveal_impl(full: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let arg = format!("/select,\"{}\"", native_path(full));
    crate::runtime::quiet_command("explorer")
        .raw_arg(arg)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("reveal failed: {e}"))
}

#[cfg(not(target_os = "windows"))]
fn reveal_impl(full: &Path) -> Result<(), String> {
    opener::reveal(full).map_err(|e| format!("reveal failed: {e}"))
}

/// The workspace path an agent message named, resolved to a real file (searching
/// by basename when the literal path does not exist), or None.
#[tauri::command(async)]
pub fn resolve_artifact(app: AppHandle, path: String) -> Result<Option<String>, String> {
    osd_core::artifact_file::resolve_artifact(&env_of(&app), &path)
}

/// Read a workspace file for preview. Text types come back as UTF-8, binary as
/// base64. `async`: previews read multi-MB files — never on the UI thread.
#[tauri::command(async)]
pub fn read_artifact(
    app: AppHandle,
    path: String,
    root: Option<String>,
) -> Result<ArtifactFile, String> {
    osd_core::artifact_file::read_artifact(&env_of(&app), path, root)
}

/// Open a workspace file in the OS default application.
#[tauri::command]
pub fn open_path(app: AppHandle, path: String, root: Option<String>) -> Result<(), String> {
    let full = resolve_under(&scope_root(&app, root.as_deref())?, &path)?;
    os_open(&full)
}

/// Reveal a workspace file/dir in the OS file manager (Finder on macOS,
/// Explorer on Windows, the file-manager portal/DBus with a folder-open
/// fallback on Linux).
#[tauri::command]
pub fn reveal_path(app: AppHandle, path: String, root: Option<String>) -> Result<(), String> {
    let full = resolve_under(&scope_root(&app, root.as_deref())?, &path)?;
    reveal_impl(&full)
}

/// The absolute filesystem path of a workspace file/dir, for "Copy path" — in
/// OS-native form (plain `C:\…` on Windows, not the `\\?\` verbatim path).
#[tauri::command]
pub fn absolute_path(app: AppHandle, path: String, root: Option<String>) -> Result<String, String> {
    osd_core::artifact_file::absolute_path(&env_of(&app), path, root)
}

#[tauri::command(async)]
pub fn list_notebooks(app: AppHandle, root: Option<String>) -> Result<Vec<NotebookEntry>, String> {
    osd_core::artifact_file::list_notebooks(&env_of(&app), root)
}

#[tauri::command(async)]
pub fn list_dir(
    app: AppHandle,
    rel: String,
    root: Option<String>,
) -> Result<Vec<DirEntry>, String> {
    osd_core::artifact_file::list_dir(&env_of(&app), rel, root)
}

#[tauri::command(async)]
pub fn write_workspace_file(
    app: AppHandle,
    path: String,
    content: String,
    root: Option<String>,
) -> Result<(), String> {
    osd_core::artifact_file::write_workspace_file(&env_of(&app), path, content, root)
}

/// Pick local files via the native open dialog and attach them to the agent
/// workspace so the agent can read them. Returns workspace-relative names; empty
/// on cancel. See `attach_paths` for the in-place-vs-copy rule.
#[tauri::command]
pub async fn add_files_to_workspace(app: AppHandle) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let Some(picked) = app.dialog().file().blocking_pick_files() else {
        return Ok(Vec::new()); // user cancelled
    };
    let ws = crate::runtime::workspace_dir(&app)?;
    let srcs = picked
        .into_iter()
        .map(|f| f.into_path().map_err(|e| e.to_string()))
        .collect::<Result<Vec<PathBuf>, String>>()?;
    osd_core::artifact_file::attach_paths(&ws, srcs)
}

#[tauri::command(async)]
pub fn add_text_to_workspace(
    app: AppHandle,
    filename: String,
    content: String,
) -> Result<String, String> {
    osd_core::artifact_file::add_text_to_workspace(&env_of(&app), filename, content)
}

#[tauri::command(async)]
pub fn add_paths_to_workspace(app: AppHandle, paths: Vec<String>) -> Result<Vec<String>, String> {
    osd_core::artifact_file::add_paths_to_workspace(&env_of(&app), paths)
}

#[tauri::command(async)]
pub fn add_binary_to_workspace(
    app: AppHandle,
    filename: String,
    base64: String,
) -> Result<String, String> {
    osd_core::artifact_file::add_binary_to_workspace(&env_of(&app), filename, base64)
}

/// Open an http(s) URL in the user's default browser. The webview itself must
/// never navigate away from the app, so external links land here instead.
/// Same `opener` rationale as `os_open` — a URL like `https://x.com/?a=1&b=2`
/// used to execute `b=2` as a command on Windows via `cmd /C start`.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("only http(s) URLs can be opened".into());
    }
    opener::open(&url).map_err(|e| format!("open failed: {e}"))
}

/// Save text through a native "Save As" dialog. Returns the chosen path, or
/// None if the user cancelled. Async so the blocking dialog never runs on the
/// main thread.
#[tauri::command]
pub async fn save_text_file(
    app: AppHandle,
    filename: String,
    content: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let Some(choice) = app.dialog().file().set_file_name(&filename).blocking_save_file() else {
        return Ok(None); // user cancelled
    };
    let path = choice.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, content).map_err(|e| format!("write failed: {e}"))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[cfg(test)]
mod tests {
    use super::open_url;

    #[test]
    fn open_url_rejects_non_http_schemes() {
        // Only http(s) may leave the app — never file:, javascript:, or a bare
        // command. (The open itself goes through the `opener` crate, which on
        // Windows is ShellExecuteW — no `cmd /C start` re-parsing of `&`.)
        assert!(open_url("javascript:alert(1)".into()).is_err());
        assert!(open_url("file:///etc/hosts".into()).is_err());
        assert!(open_url("calc".into()).is_err());
    }
}
