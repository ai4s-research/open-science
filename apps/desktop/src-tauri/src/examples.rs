// Tauri command over `osd_core::examples`.
use tauri::AppHandle;

use crate::env_of;

/// Copy a bundled example project into the workspace (idempotent, never
/// overwrites) and return its workspace-relative directory name.
#[tauri::command(async)]
pub fn install_example(app: AppHandle, name: String) -> Result<String, String> {
    osd_core::examples::install_example(&env_of(&app), name)
}
