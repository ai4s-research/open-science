// Tauri commands over `osd_core::project`.
use tauri::AppHandle;

use crate::env_of;

pub use osd_core::project::ProjectInfo;

#[tauri::command(async)]
pub fn create_project(app: AppHandle, name: String) -> Result<ProjectInfo, String> {
    osd_core::project::create_project(&env_of(&app), &name)
}

#[tauri::command(async)]
pub fn import_project(
    app: AppHandle,
    path: String,
    mode: Option<String>,
) -> Result<ProjectInfo, String> {
    osd_core::project::import_project(&env_of(&app), path, mode)
}

#[tauri::command(async)]
pub fn list_projects(app: AppHandle) -> Result<Vec<ProjectInfo>, String> {
    osd_core::project::list_projects(&env_of(&app))
}

#[tauri::command(async)]
pub fn rename_project(app: AppHandle, id: String, name: String) -> Result<(), String> {
    osd_core::project::rename_project(&env_of(&app), &id, &name)
}

#[tauri::command(async)]
pub fn set_project_pinned(app: AppHandle, id: String, pinned: bool) -> Result<(), String> {
    osd_core::project::set_project_pinned(&env_of(&app), &id, pinned)
}

#[tauri::command(async)]
pub fn delete_project(app: AppHandle, id: String) -> Result<(), String> {
    osd_core::project::delete_project(&env_of(&app), &id)
}

/// Open a project's workspace folder in the OS file manager. The folder is
/// resolved from the project's own metadata, so the frontend passes only the id
/// — never a raw path (no arbitrary-path open).
#[tauri::command(async)]
pub fn open_project_folder(app: AppHandle, id: String) -> Result<(), String> {
    let target = osd_core::project::project_folder(&env_of(&app), &id)?;
    crate::artifact_file::os_open(&target)
}
