// Tauri command over `osd_core::usage`: what the workbench itself has spent,
// plus what the Claude Code and Codex CLIs spent elsewhere on this machine.
use tauri::AppHandle;

use osd_core::usage::{agent_home, collect_usage, UsageSummary};

use crate::env_of;

/// `async`: a first scan walks hundreds of transcripts off `~` and opens the
/// runtime's database, which must never run on the UI thread.
///
/// Both bounds are epoch milliseconds supplied by the caller. "Today" begins at
/// the user's own local midnight, which the renderer knows and Rust does not —
/// deriving it here would silently use UTC and hand a user in Asia the wrong
/// day for most of their working hours.
#[tauri::command(async)]
pub fn agent_usage(
    app: AppHandle,
    today_start_ms: i64,
    week_start_ms: i64,
) -> Result<UsageSummary, String> {
    let home = agent_home().ok_or("could not resolve the home directory")?;
    // The workbench's own turns live under the runtime root. Missing it is not
    // an error — the CLI figures are still worth reporting on their own.
    let runtime_root = osd_core::runtime::runtime_root(&env_of(&app)).ok();
    Ok(collect_usage(
        &home,
        runtime_root.as_deref(),
        today_start_ms,
        week_start_ms,
    ))
}

/// Which of the given commands this machine can run.
///
/// The renderer owns the catalog of agents it knows how to drive; only this
/// side can answer whether the binary exists.
#[tauri::command(async)]
pub fn detect_commands(commands: Vec<String>) -> Vec<String> {
    osd_core::which::detect_installed(&commands)
}
