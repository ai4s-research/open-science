// A real shell in a pane.
//
// The contract is borrowed from Orca: a terminal is a PTY the UI owns by id —
// open it, write to it, resize it, close it, and read its bytes as they arrive.
// So is where the PTY lives: in the terminal host (`osd termd`, osd-core
// termd.rs), a background process that outlives the app. An update, a crash or
// a quit leaves every shell, and the Claude Code / Codex in it, running; the
// next app finds them by pane id, replays their recent output and carries on.
//
// This module is the host's client. It keeps, per terminal it has attached,
// the output stream the window and web clients read.
//
// A reopened pane does not get the shell's raw recent output: that was drawn
// for whatever widths the pane had over time, with the cursor moves of the
// programs that drew it, so replayed into one size it lands in the wrong
// places and the resize repaints the pane once spliced in come back as
// copies. The window saves its screen instead (`terminal_save_screen`), with
// the offset into the output it covers; a reopen draws that screen at the size
// it was saved at and replays only the output after it.
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};

use osd_core::termd::{self, strip_queries, Client, Output, Spawn};
use portable_pty::CommandBuilder;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

/// A terminal this app has attached.
struct Attached {
    output: Arc<Mutex<Output>>,
    pid: Option<u32>,
    /// (rows, cols), as last set from here.
    size: (u16, u16),
}

#[derive(Default)]
struct Inner {
    host: Option<Client>,
    terminals: HashMap<String, Attached>,
}

/// One lock for the host connection and the attached terminals: an open is a
/// check, a host call and an insert, and two opens for one id (a remount) must
/// not both get past the check.
#[derive(Default)]
pub struct TerminalState(Mutex<Inner>);

impl Inner {
    /// A request to the host, starting the host if none runs. A connection the
    /// host dropped (it restarted) is dialled again, once.
    fn call<T>(&mut self, app: &AppHandle, f: impl Fn(&mut Client) -> Result<T, String>) -> Result<T, String> {
        for _ in 0..2 {
            let host = match &mut self.host {
                Some(host) => host,
                None => self.host.insert(termd::ensure(&data_dir(app)?, &bundled_osd()?)?),
            };
            let result = f(host);
            if !host.is_broken() {
                return result;
            }
            self.host = None;
        }
        Err("the terminal host is not answering".into())
    }
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// The bundled `osd`, which runs the host. Tauri bundles it next to the app
/// binary under its plain name (in development: `scripts/dev/build-osd-sidecar.sh`).
fn bundled_osd() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let name = if cfg!(windows) { "osd.exe" } else { "osd" };
    let path = exe.parent().ok_or("no app folder")?.join(name);
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!("terminal host missing: {} (dev: scripts/dev/build-osd-sidecar.sh)", path.display()))
    }
}

/// Each attached shell's process id, keyed by the pane that owns it: the status
/// bar says WHICH terminal is using the memory.
pub fn pids(state: &TerminalState) -> HashMap<String, u32> {
    let Ok(inner) = state.0.lock() else { return HashMap::new() };
    inner.terminals.iter().filter_map(|(id, t)| Some((id.clone(), t.pid?))).collect()
}

/// The terminal host's process id, once this app has reached it: what the
/// terminals' programs (a dev server, say) run under.
pub fn host_pid(state: &TerminalState) -> Option<u32> {
    state.0.lock().ok()?.host.as_ref().map(|h| h.welcome.pid)
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

/// Start a shell, or attach the one already running under this pane's id.
///
/// `id` is the caller's own handle for it — the pane's leaf id — so a reopen
/// after a reload or a relaunch finds the same shell without asking for a name.
#[tauri::command(async)]
pub fn terminal_open(
    app: AppHandle,
    id: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<Opened, String> {
    open(&app, id, cwd, cols, rows)
}

#[derive(Serialize)]
pub struct Opened {
    /// True when a new shell was started; false when `id` was already running
    /// (a remount, a web client sharing these Screens, or a shell that
    /// outlived the last app). Only a new shell may be sent the pane's
    /// startup command.
    pub created: bool,
    /// The size the shell runs at: what its recent output was drawn for. A
    /// pane reopening on a running shell starts at it and resizes from there.
    pub cols: u16,
    pub rows: u16,
    /// The pane's saved screen, when it fits this shell at this size.
    pub screen: Option<Screen>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Screen {
    /// The offset into the shell's output that the screen covers up to.
    pub end: u64,
    /// The screen, as escape sequences that redraw it.
    pub data: String,
}

fn open(app: &AppHandle, id: String, cwd: Option<String>, cols: u16, rows: u16) -> Result<Opened, String> {
    let state = app.state::<TerminalState>();
    let mut inner = state.0.lock().map_err(|_| "terminal state poisoned")?;
    if let Some(t) = inner.terminals.get(&id) {
        let (rows, cols) = t.size;
        let screen = load_saved(app, &id, t.pid, cols, rows).map(|s| s.screen);
        return Ok(Opened { created: false, cols, rows, screen });
    }

    // A running shell keeps its size: opening it at the pane's would make its
    // program repaint before the pane has drawn what came before.
    let running = inner.call(app, |host| host.list())?.into_iter().find(|t| t.id == id);
    let (cols, rows) = running.map_or((cols, rows), |t| (t.cols, t.rows));
    let spawn = Spawn::from_command(&shell_command(app, &id, cwd), cols, rows);
    let (created, pid) = inner.call(app, |host| host.open(&id, &spawn))?;
    let saved = if created {
        forget_screen(app, &id);
        None
    } else {
        load_saved(app, &id, pid, cols, rows)
    };
    let host = inner.host.as_ref().ok_or("terminal host gone")?;
    let (output, stream, screen): (Output, Box<dyn Iterator<Item = String> + Send>, _) = if host.welcome.offsets {
        let screen = saved.map(|s| s.screen);
        let (recent, from, stream) = host.attach_from(&id, screen.as_ref().map_or(0, |s| s.end))?;
        let mut output = Output::starting_at(from);
        output.push(&recent);
        (output, Box::new(stream), screen)
    } else {
        // An older host sends the shell's recent output raw, drawn at every
        // size the pane has had: replayed into one, Claude Code's resize
        // repaints in it land as copies. It gives no offsets, so the saved
        // screen is found in it by the output that screen ended on.
        let (recent, stream) = host.attach_recent(&id)?;
        let recent = strip_queries(&recent); // older hosts keep them
        let resume = saved.and_then(|s| Some((resume_at(&recent, s.tail.as_deref()?)?, s.screen)));
        if !created {
            let how = if resume.is_some() { "resumed after the saved screen".into() } else { why_raw(app, &id, pid, cols, rows, &recent) };
            crate::debug_log::append(app, &format!("terminal {id} reopened on an older host: {how}"));
        }
        let mut output = Output::starting_at(resume.as_ref().map_or(0, |(_, screen)| screen.end));
        output.push(&recent[resume.as_ref().map_or(0, |(at, _)| *at)..]);
        (output, Box::new(stream.into_iter()), resume.map(|(_, screen)| screen))
    };

    let output = Arc::new(Mutex::new(output));
    let reader_output = output.clone();
    let reader_app = app.clone();
    let reader_id = id.clone();
    std::thread::spawn(move || {
        for chunk in stream {
            if let Ok(mut out) = reader_output.lock() {
                out.push(&chunk);
            }
        }
        // The shell exited (or the host went away with it): readers' channels
        // close, and the id is free for a new shell — if it still names this one.
        if let Ok(mut out) = reader_output.lock() {
            out.end();
        }
        if let Some(state) = reader_app.try_state::<TerminalState>() {
            if let Ok(mut inner) = state.0.lock() {
                if inner.terminals.get(&reader_id).is_some_and(|t| Arc::ptr_eq(&t.output, &reader_output)) {
                    inner.terminals.remove(&reader_id);
                }
            }
        }
    });

    let size = (rows.max(1), cols.max(1));
    inner.terminals.insert(id, Attached { output, pid, size });
    Ok(Opened { created, cols: size.1, rows: size.0, screen })
}

/// How much of the output before a saved screen is kept with it, to find the
/// screen's place in an older host's recent output. Long enough that Claude
/// Code's identical repaints do not repeat it (2026-10-28, 20 real terminals:
/// 4 KB repeated at 2.5% of places, 16 KB at 0.1%).
const TAIL_BYTES: usize = 16 * 1024;

/// Why an older host's replay of `id` is drawn raw instead of resuming after
/// its saved screen: a raw replay is what shows Claude Code's repaints twice.
fn why_raw(app: &AppHandle, id: &str, pid: Option<u32>, cols: u16, rows: u16, recent: &str) -> String {
    let Some(text) = screen_path(app, id).and_then(|p| std::fs::read_to_string(p).ok()) else {
        return "replayed raw: no saved screen".into();
    };
    let Ok(saved) = serde_json::from_str::<SavedScreen>(&text) else {
        return "replayed raw: saved screen unreadable".into();
    };
    if pid.is_none() || saved.pid != pid {
        return format!("replayed raw: saved screen is of pid {:?}, the shell is {:?}", saved.pid, pid);
    }
    if (saved.cols, saved.rows) != (cols, rows) {
        return format!("replayed raw: saved at {}x{}, the shell is {}x{}", saved.cols, saved.rows, cols, rows);
    }
    match saved.tail.map(|t| strip_queries(&t)) {
        None => "replayed raw: saved screen has no tail".into(),
        Some(t) if t.is_empty() => "replayed raw: saved tail is empty".into(),
        Some(t) => format!("replayed raw: saved tail found {} times in the replay", recent.matches(t.as_str()).count()),
    }
}

/// Where `recent` goes on after `tail`, when `tail` is in it once, and only
/// once: a repeated tail could be the wrong place.
fn resume_at(recent: &str, tail: &str) -> Option<usize> {
    let tail = strip_queries(tail); // as `recent` has them stripped
    let at = recent.find(&tail)?;
    (!tail.is_empty() && recent.rfind(&tail) == Some(at)).then(|| at + tail.len())
}

/// Where a pane's screen is saved. Only plain ids name a file.
fn screen_path(app: &AppHandle, id: &str) -> Option<PathBuf> {
    let plain = !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    plain.then(|| Some(data_dir(app).ok()?.join("terminal-screens").join(format!("{id}.json"))))?
}

#[derive(Serialize, Deserialize)]
struct SavedScreen {
    /// The shell it shows: an id is reused once its shell has exited.
    pid: Option<u32>,
    cols: u16,
    rows: u16,
    #[serde(flatten)]
    screen: Screen,
    /// The output it ends on (see `TAIL_BYTES`).
    #[serde(default)]
    tail: Option<String>,
}

/// The saved screen of `id`, if it shows this shell at this size.
fn load_saved(app: &AppHandle, id: &str, pid: Option<u32>, cols: u16, rows: u16) -> Option<SavedScreen> {
    let text = std::fs::read_to_string(screen_path(app, id)?).ok()?;
    let saved: SavedScreen = serde_json::from_str(&text).ok()?;
    (pid.is_some() && saved.pid == pid && saved.cols == cols && saved.rows == rows).then_some(saved)
}

fn forget_screen(app: &AppHandle, id: &str) {
    if let Some(path) = screen_path(app, id) {
        let _ = std::fs::remove_file(path);
    }
}

/// The window's screen of `id` as of offset `end` of its output, drawn at
/// `cols` x `rows`: what a reopen draws instead of replaying that output.
#[tauri::command(async)]
pub fn terminal_save_screen(app: AppHandle, id: String, end: u64, cols: u16, rows: u16, data: String) -> Result<(), String> {
    let (pid, tail) = {
        let state = app.state::<TerminalState>();
        let inner = state.0.lock().map_err(|_| "terminal state poisoned")?;
        let t = inner.terminals.get(&id).ok_or("no such terminal")?;
        let tail = t.output.lock().ok().and_then(|o| o.before(end, TAIL_BYTES));
        (t.pid, tail)
    };
    let path = screen_path(&app, &id).ok_or("not a pane id")?;
    let dir = path.parent().ok_or("no folder")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let saved = SavedScreen { pid, cols, rows, screen: Screen { end, data }, tail };
    let tmp = dir.join(format!(".{id}.tmp"));
    std::fs::write(&tmp, serde_json::to_vec(&saved).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// The command a pane's shell starts with. Built here, not in the host: the
/// host was started by whichever app came first, possibly an older one.
fn shell_command(app: &AppHandle, id: &str, cwd: Option<String>) -> CommandBuilder {
    let shell = default_shell();
    let mut command = CommandBuilder::new(&shell);
    if let Some(dir) = cwd.filter(|d| std::path::Path::new(d).is_dir()) {
        command.cwd(dir);
    }
    // Tell the shell what it is talking to, or curses programs assume the
    // dumbest possible terminal and render as if formatting did not exist.
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    // Launched from Finder the app has no LANG, so the shell would start in the
    // C locale: zsh then echoes typed CJK as escapes and counts its bytes as
    // columns. The user's rc files still run after and can override.
    if std::env::var_os("LANG").is_none() {
        command.env("LANG", "en_US.UTF-8");
    }
    // The app's proxy setting, same as the sidecar gets. Launched from Finder
    // the app inherits no shell env, so without this a Claude Code / Codex
    // started (or auto-resumed) here cannot reach its API behind a proxy and
    // hangs silently. The user's rc files still run after and can override.
    for (k, v) in crate::runtime::sidecar_proxy_env(app) {
        command.env(k, v);
    }
    // Which pane this is, so `osd screen add --here` run in it finds it.
    command.env("OSD_PANE", id);
    // The shell restores what the user exported by hand before it last ended
    // (see terminal_env.rs).
    crate::terminal_env::prepare(app, &shell, id, &mut command);
    command
}

/// A terminal's output, for the window: recent output first (from `since`, or
/// all of it when that is no longer held), then live, then `exit`. Each chunk
/// says the offset it ends at, and the first where it starts, when known.
#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TerminalEvent {
    Data {
        data: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        from: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        end: Option<u64>,
    },
    Exit,
}

#[tauri::command]
pub fn terminal_subscribe(app: AppHandle, id: String, since: Option<u64>, on_event: Channel<TerminalEvent>) {
    let followed = follow(&app, &id, since.unwrap_or(0));
    std::thread::spawn(move || {
        if let Some((recent, from, rx)) = followed {
            for event in output_events(recent, from, rx) {
                if on_event.send(event).is_err() {
                    return; // The window is gone.
                }
            }
        }
        let _ = on_event.send(TerminalEvent::Exit);
    });
}

/// The recent output, its queries taken out (see `strip_queries`), then each
/// live chunk, every one with the offset it ends at.
fn output_events(recent: String, from: Option<u64>, rx: Receiver<String>) -> impl Iterator<Item = TerminalEvent> {
    let mut end = from.map(|f| f + recent.len() as u64);
    let first = TerminalEvent::Data { data: strip_queries(&recent), from, end };
    std::iter::once(first).chain(rx.into_iter().map(move |chunk| {
        end = end.map(|e| e + chunk.len() as u64);
        TerminalEvent::Data { data: chunk, from: None, end }
    }))
}

fn follow(app: &AppHandle, id: &str, since: u64) -> Option<(String, Option<u64>, Receiver<String>)> {
    let state = app.state::<TerminalState>();
    let inner = state.0.lock().ok()?;
    let mut output = inner.terminals.get(id)?.output.lock().ok()?;
    Some(output.follow(since))
}

fn subscribe(app: &AppHandle, id: &str) -> Option<Receiver<String>> {
    let state = app.state::<TerminalState>();
    let inner = state.0.lock().ok()?;
    let mut output = inner.terminals.get(id)?.output.lock().ok()?;
    Some(output.subscribe())
}

/// What every live terminal is doing: its shell's folder and the coding agent
/// running in it (see `terminal_probe.rs`). Polled by the layout every few
/// seconds so a relaunch can reopen each terminal where it was.
///
/// The host is asked under the lock and the probing happens outside it:
/// probing reads files (and on macOS may run `lsof` once per Codex process),
/// and keystrokes must not wait behind that.
#[tauri::command(async)]
pub fn terminal_probe(app: AppHandle) -> HashMap<String, crate::terminal_probe::TerminalProbe> {
    let state = app.state::<TerminalState>();
    let listed = match state.0.lock() {
        // Nothing attached, nothing to ask (and no host to start for it).
        Ok(mut inner) if !inner.terminals.is_empty() => inner.call(&app, |host| host.list()),
        _ => return HashMap::new(),
    };
    listed
        .unwrap_or_default()
        .into_iter()
        .map(|t| (t.id, crate::terminal_probe::probe(t.pid, t.foreground)))
        .collect()
}

/// Keystrokes, paste, anything the pane types.
#[tauri::command]
pub fn terminal_write(app: AppHandle, id: String, data: String) -> Result<(), String> {
    write(&app, &id, &data)
}

fn write(app: &AppHandle, id: &str, data: &str) -> Result<(), String> {
    let state = app.state::<TerminalState>();
    let mut inner = state.0.lock().map_err(|_| "terminal state poisoned")?;
    if !inner.terminals.contains_key(id) {
        return Err("no such terminal".into());
    }
    inner.call(app, |host| host.write(id, data))
}

/// The pane changed size. Without this the shell keeps wrapping to the old
/// width and every full-screen program draws into the wrong box.
/// The files copied in Finder, Explorer or a Linux file manager, as absolute
/// paths. The webview keeps them from a page's paste event, so without this
/// ⌘V of copied files reached the terminal as nothing. Empty when the
/// clipboard holds no files.
#[tauri::command]
pub fn clipboard_file_paths() -> Vec<String> {
    arboard::Clipboard::new()
        .and_then(|mut clipboard| clipboard.get().file_list())
        .map(|paths| paths.into_iter().map(|p| p.to_string_lossy().into_owned()).collect())
        .unwrap_or_default()
}

#[tauri::command]
pub fn terminal_resize(app: AppHandle, id: String, cols: u16, rows: u16) -> Result<(), String> {
    resize(&app, &id, cols, rows)
}

fn resize(app: &AppHandle, id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let state = app.state::<TerminalState>();
    let mut inner = state.0.lock().map_err(|_| "terminal state poisoned")?;
    let Some(terminal) = inner.terminals.get_mut(id) else {
        return Ok(()); // A resize for a shell that already exited is not an error.
    };
    terminal.size = (rows.max(1), cols.max(1));
    inner.call(app, |host| host.resize(id, cols, rows))
}

/// Kill the shell and forget it. Called when the pane closes.
#[tauri::command]
pub fn terminal_close(app: AppHandle, id: String) -> Result<(), String> {
    close(&app, &id)
}

fn close(app: &AppHandle, id: &str) -> Result<(), String> {
    let state = app.state::<TerminalState>();
    let mut inner = state.0.lock().map_err(|_| "terminal state poisoned")?;
    inner.terminals.remove(id);
    let result = inner.call(app, |host| host.close(id));
    crate::terminal_env::forget(app, id);
    forget_screen(app, id);
    result
}

/// End the shells whose panes are gone: the window's own (web clients' ids
/// start with `w`, see terminalTransport.ts) that no restored pane names.
/// Called once at startup with the restored layout. A pane closed while the
/// host kept running otherwise leaves its shell, and whatever agent is in it,
/// running where no pane shows it — and leaf ids are reused, so the next new
/// pane of that id would attach to it.
pub fn prune(app: &AppHandle, open: &[String]) {
    let state = app.state::<TerminalState>();
    let Ok(mut inner) = state.0.lock() else { return };
    // Only a host that already runs: there is nothing to prune in a new one.
    if inner.host.is_none() {
        let Ok(dir) = data_dir(app) else { return };
        let Ok(client) = Client::connect(&dir) else { return };
        inner.host = Some(client);
    }
    let open: HashSet<&str> = open.iter().map(String::as_str).collect();
    let Ok(running) = inner.call(app, |host| host.list()) else { return };
    for t in running {
        if !t.id.starts_with('w') && !open.contains(t.id.as_str()) && !inner.terminals.contains_key(&t.id) {
            let _ = inner.call(app, |host| host.close(&t.id));
            forget_screen(app, &t.id);
        }
    }
}

/// The desktop's shells, offered to the remote-access gateway. Which of them a
/// web client may touch, and whether it may at all, is the gateway's call.
pub struct GatewayTerminals(pub AppHandle);

impl osd_core::gateway::Terminals for GatewayTerminals {
    fn open(&self, id: &str, cwd: Option<String>, cols: u16, rows: u16) -> Result<bool, String> {
        open(&self.0, id.to_string(), cwd, cols, rows).map(|o| o.created)
    }
    fn write(&self, id: &str, data: &str) -> Result<(), String> {
        write(&self.0, id, data)
    }
    fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        resize(&self.0, id, cols, rows)
    }
    fn close(&self, id: &str) -> Result<(), String> {
        close(&self.0, id)
    }
    fn subscribe(&self, id: &str) -> Option<Receiver<String>> {
        subscribe(&self.0, id)
    }
    fn size(&self, id: &str) -> Option<(u16, u16)> {
        let state = self.0.state::<TerminalState>();
        let inner = state.0.lock().ok()?;
        Some(inner.terminals.get(id)?.size)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn falls_back_to_a_real_shell_when_the_environment_names_none() {
        // Never empty: an empty command would fail to spawn with no explanation.
        assert!(!default_shell().is_empty());
    }

    #[test]
    fn an_older_hosts_replay_resumes_after_the_saved_screens_tail_found_once() {
        let recent = "\x1b[Hrepaint\r\nA\x1b[Hrepaint\r\nB";
        // Queries are stripped from the replay, so from the tail too.
        assert_eq!(resume_at(recent, "A\x1b[6n\x1b[Hrepaint\r\n"), Some(recent.len() - 1));
        // Twice in the replay: either could be the place.
        assert_eq!(resume_at(recent, "\x1b[Hrepaint\r\n"), None);
        assert_eq!(resume_at(recent, "gone"), None);
        assert_eq!(resume_at(recent, ""), None);
    }

    #[test]
    fn the_window_hears_data_then_exit() {
        let data = TerminalEvent::Data { data: "$ ".into(), from: None, end: Some(9) };
        assert_eq!(serde_json::to_value(data).unwrap(), serde_json::json!({ "kind": "data", "data": "$ ", "end": 9 }));
        let exit = serde_json::to_value(TerminalEvent::Exit).unwrap();
        assert_eq!(exit, serde_json::json!({ "kind": "exit" }));
    }

    #[test]
    fn each_chunk_says_where_it_ends_and_the_replay_where_it_starts() {
        let (tx, rx) = std::sync::mpsc::channel();
        tx.send("中".to_string()).unwrap();
        drop(tx);
        let events: Vec<_> = output_events("\x1b[6n$ ".into(), Some(10), rx).collect();
        assert_eq!(
            events,
            [
                TerminalEvent::Data { data: "$ ".into(), from: Some(10), end: Some(16) },
                TerminalEvent::Data { data: "中".into(), from: None, end: Some(19) },
            ]
        );
        let (_tx, rx) = std::sync::mpsc::channel::<String>();
        let unknown: Vec<_> = output_events("$ ".into(), None, rx).take(1).collect();
        assert_eq!(unknown, [TerminalEvent::Data { data: "$ ".into(), from: None, end: None }]);
    }
}
