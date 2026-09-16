// A real shell in a pane.
//
// The contract, not the implementation, is borrowed from Orca: a terminal is a
// PTY the UI owns by id — open it, write to it, resize it, close it, and read
// its bytes as they arrive. Orca's own terminal layer is forty-odd modules
// because it also spans WSL, SSH and worktree hibernation; none of that exists
// here, so this is the small honest core of the same idea.
//
// Output is pushed as events rather than polled: a shell writes when it writes,
// and a poll loop would either lag the caret or burn a timer doing nothing.
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use tauri::{AppHandle, Emitter, Manager};

/// One live shell.
pub(crate) struct Terminal {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
pub struct TerminalState(pub Mutex<HashMap<String, Terminal>>);

/// Each live shell's process id, keyed by the pane that owns it.
///
/// The status bar needs this to say WHICH terminal is using the memory — a
/// single total tells you the workbench is heavy but not which pane to look at.
pub fn pids(state: &TerminalState) -> std::collections::HashMap<String, u32> {
    let Ok(map) = state.0.lock() else {
        return std::collections::HashMap::new();
    };
    map.iter()
        .filter_map(|(id, term)| Some((id.clone(), term.child.process_id()?)))
        .collect()
}

/// Event carrying a chunk of a terminal's output. One event name per terminal
/// so a pane listens only to its own shell.
fn output_event(id: &str) -> String {
    format!("terminal://{id}/data")
}

fn exit_event(id: &str) -> String {
    format!("terminal://{id}/exit")
}

/// The shell to run. `$SHELL` is the user's actual choice; the fallbacks only
/// matter on a machine that does not set it.
fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

/// Start a shell and stream its output to the window.
///
/// `id` is the caller's own handle for it — the pane's leaf id — so a reopen
/// after a reload can reuse the same name without asking us for one.
#[tauri::command(async)]
pub fn terminal_open(
    app: AppHandle,
    id: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let state = app.state::<TerminalState>();
    {
        let terminals = state.0.lock().map_err(|_| "terminal state poisoned")?;
        // Reopening a live terminal is a no-op, not a second shell: a pane that
        // remounts (a Screen switch, a React strict-mode double effect) must not
        // silently leave an orphan process behind.
        if terminals.contains_key(&id) {
            return Ok(());
        }
    }

    let pty = NativePtySystem::default();
    let pair = pty
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut command = CommandBuilder::new(default_shell());
    if let Some(dir) = cwd.filter(|d| std::path::Path::new(d).is_dir()) {
        command.cwd(dir);
    }
    // Tell the shell what it is talking to, or curses programs assume the
    // dumbest possible terminal and render as if formatting did not exist.
    command.env("TERM", "xterm-256color");

    let child = pair.slave.spawn_command(command).map_err(|e| e.to_string())?;
    // The slave handle must be dropped or the master never sees EOF when the
    // shell exits, and the reader below blocks for the life of the app.
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let reader_app = app.clone();
    let reader_id = id.clone();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    // Lossy on purpose: a shell can split a UTF-8 sequence across
                    // reads, and a dropped replacement character is a better
                    // outcome than a terminal that stops on a partial glyph.
                    let chunk = String::from_utf8_lossy(&buffer[..n]).to_string();
                    if reader_app.emit(&output_event(&reader_id), chunk).is_err() {
                        break; // The window is gone; so is the reason to read.
                    }
                }
            }
        }
        let _ = reader_app.emit(&exit_event(&reader_id), ());
        if let Some(state) = reader_app.try_state::<TerminalState>() {
            if let Ok(mut terminals) = state.0.lock() {
                terminals.remove(&reader_id);
            }
        }
    });

    let mut terminals = state.0.lock().map_err(|_| "terminal state poisoned")?;
    terminals.insert(
        id,
        Terminal {
            writer,
            master: pair.master,
            child,
        },
    );
    Ok(())
}

/// Keystrokes, paste, anything the pane types.
#[tauri::command]
pub fn terminal_write(app: AppHandle, id: String, data: String) -> Result<(), String> {
    let state = app.state::<TerminalState>();
    let mut terminals = state.0.lock().map_err(|_| "terminal state poisoned")?;
    let terminal = terminals.get_mut(&id).ok_or("no such terminal")?;
    terminal
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    terminal.writer.flush().map_err(|e| e.to_string())
}

/// The pane changed size. Without this the shell keeps wrapping to the old
/// width and every full-screen program draws into the wrong box.
#[tauri::command]
pub fn terminal_resize(app: AppHandle, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let state = app.state::<TerminalState>();
    let terminals = state.0.lock().map_err(|_| "terminal state poisoned")?;
    let Some(terminal) = terminals.get(&id) else {
        return Ok(()); // A resize for a shell that already exited is not an error.
    };
    terminal
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

/// Kill the shell and forget it. Called when the pane closes.
#[tauri::command]
pub fn terminal_close(app: AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<TerminalState>();
    let mut terminals = state.0.lock().map_err(|_| "terminal state poisoned")?;
    if let Some(mut terminal) = terminals.remove(&id) {
        let _ = terminal.child.kill();
        let _ = terminal.child.wait();
    }
    Ok(())
}

/// Kill every shell — the app is quitting, and a PTY child outlives its parent
/// unless someone says otherwise.
pub fn close_all(state: &TerminalState) {
    if let Ok(mut terminals) = state.0.lock() {
        for (_, mut terminal) in terminals.drain() {
            let _ = terminal.child.kill();
        }
    }
}

/// Shared so the frontend and this module cannot drift on the event names.
#[tauri::command]
pub fn terminal_event_names(id: String) -> (String, String) {
    (output_event(&id), exit_event(&id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_terminal_owns_its_own_event_names() {
        // Two panes must never receive each other's bytes.
        assert_eq!(output_event("p1"), "terminal://p1/data");
        assert_eq!(exit_event("p1"), "terminal://p1/exit");
        assert_ne!(output_event("p1"), output_event("p2"));
    }

    #[test]
    fn falls_back_to_a_real_shell_when_the_environment_names_none() {
        // Never empty: an empty command would fail to spawn with no explanation.
        assert!(!default_shell().is_empty());
    }
}
