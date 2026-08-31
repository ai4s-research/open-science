//! Tauri surface for cross-device conversation sync (#124). The policy — which
//! sessions to mirror out and which files to pull in — lives in the frontend
//! beside the session list it already tracks; these commands only do the file
//! and process work that has to happen on this side.

use std::path::PathBuf;

use osd_core::session_sync::{self, ExportOutcome, MirrorFile};
use tauri::AppHandle;

use crate::env_of;

/// Mirror one session to `<dir>/<session-id>.json`. `previous_hash` is what
/// this machine last wrote for it; an unchanged conversation is left on disk
/// untouched, so the other machines are not told it moved.
/// `async`: exporting a long conversation runs the runtime CLI and must never
/// sit on the UI thread.
#[tauri::command(async)]
pub fn sync_export_session(
    app: AppHandle,
    session_id: String,
    dir: String,
    previous_hash: Option<String>,
) -> Result<ExportOutcome, String> {
    session_sync::export_session(
        &env_of(&app),
        &session_id,
        &PathBuf::from(dir),
        previous_hash.as_deref(),
    )
}

/// Import one mirrored session. Idempotent, and unions by message id, so a file
/// seen twice or a session that both machines added to is safe.
#[tauri::command(async)]
pub fn sync_import_session(app: AppHandle, dir: String, session_id: String) -> Result<(), String> {
    session_sync::import_session(&env_of(&app), &PathBuf::from(dir), &session_id)
}

/// What the mirror directory holds. Empty (not an error) when the folder does
/// not exist yet — the other machine may not have synced anything.
#[tauri::command(async)]
pub fn sync_list_mirror(dir: String) -> Result<Vec<MirrorFile>, String> {
    session_sync::list_mirror(&PathBuf::from(dir))
}

/// Is the chosen folder usable? Reported once when the setting is saved, rather
/// than as a recurring failure afterwards.
#[tauri::command(async)]
pub fn sync_check_dir(dir: String) -> Result<(), String> {
    session_sync::check_dir(&PathBuf::from(dir))
}
