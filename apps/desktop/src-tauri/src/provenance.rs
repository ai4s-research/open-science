// Tauri commands over `osd_core::provenance`. Recording stays here for the same
// reason as `runs`: it captures the interpreter the desktop's kernel resolves.
use tauri::AppHandle;

use osd_core::provenance::{append_record, capture_env, ProvenanceRecord, ProvenanceState};

use crate::env_of;

/// `async`: fired on every agent write; the first call shells out to
/// `pip freeze` (seconds) and every call re-reads the whole store — none of
/// which may run on the UI thread.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn record_provenance(
    app: AppHandle,
    state: tauri::State<ProvenanceState>,
    path: String,
    tool: String,
    session_id: Option<String>,
    model: Option<String>,
    content: Option<String>,
    diff: Option<String>,
    log: Option<String>,
) -> Result<ProvenanceRecord, String> {
    let _guard = state.0.lock().map_err(|_| "provenance lock poisoned")?;
    let root = crate::runtime::workspace_dir(&app)?;
    // An authored write, not a run — no command interpreter to introspect.
    let env = capture_env(
        &root,
        app.package_info().version.to_string(),
        None,
        crate::kernel::python_bin(&app).ok().map(|(bin, _)| bin),
    );
    // Writes are authored, not runs — no run_id here (runs.rs sets it for
    // files produced by executing code).
    let record = append_record(
        &root, &path, &tool, session_id, model, content, diff, log, Some(env), None,
    )?;
    drop(_guard);
    osd_core::git_snapshot::commit_best_effort(&root, &format!("Record {}", record.path));
    Ok(record)
}

/// `async`: reads the whole (unbounded) store off the UI thread.
#[tauri::command(async)]
pub fn list_provenance(app: AppHandle, path: String) -> Result<Vec<ProvenanceRecord>, String> {
    osd_core::provenance::list_provenance(&env_of(&app), &path)
}

/// Read a content-addressed package lockfile (`.openscience/env/<hash>.txt`).
#[tauri::command]
pub fn read_env_lockfile(app: AppHandle, hash: String) -> Result<String, String> {
    osd_core::provenance::read_env_lockfile(&env_of(&app), &hash)
}
