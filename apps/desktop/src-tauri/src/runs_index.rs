// Tauri command over `osd_core::runs_index`.
use tauri::AppHandle;

use osd_core::runs_index::{RunPage, RunQuery};

use crate::env_of;

/// `async`: opens + syncs the index (reads new log bytes, writes the DB) and
/// queries it — none of which may run on the UI thread.
#[tauri::command(async)]
pub fn query_runs_cmd(app: AppHandle, query: RunQuery) -> Result<RunPage, String> {
    osd_core::runs_index::query_runs_cmd(&env_of(&app), query)
}
