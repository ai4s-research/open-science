// Tauri command over `osd_core::git_snapshot`; the rest of the desktop calls
// the core module directly through these re-exports.
use tauri::AppHandle;

use crate::env_of;

pub use osd_core::git_snapshot::watch_workspace;

#[tauri::command(async)]
pub fn commit_workspace_snapshot(app: AppHandle, message: String) -> Result<bool, String> {
    osd_core::git_snapshot::commit_workspace_snapshot(&env_of(&app), &message)
}
