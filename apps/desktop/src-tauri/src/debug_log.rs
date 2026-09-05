// Tauri command over `osd_core::debug_log`, and the AppHandle-shaped `append`
// the rest of the desktop already calls.
use tauri::AppHandle;

use crate::env_of;

/// Append one timestamped line to <app-data>/debug.log.
pub fn append(app: &AppHandle, message: &str) {
    osd_core::debug_log::append(&env_of(app), message);
}

#[tauri::command]
pub fn log_debug(app: AppHandle, message: String) {
    append(&app, &message);
}
