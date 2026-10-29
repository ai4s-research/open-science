// The terminal host: one background process that owns every terminal's PTY.
//
// A PTY dies with the process holding its master side, so while the app held
// them, every update or relaunch killed each shell and the Claude Code / Codex
// running in it. Here, as in Orca, the PTYs live in a detached `osd termd`
// started on first use; the app is only a client. A new app (after an update,
// a crash, a quit) dials the same host and finds every terminal still running.
//
// Wire: loopback TCP, one JSON object per line. Every connection opens with the
// token from the host's state file (owner-only, in the app's data folder).
// A control connection then sends requests and reads one reply each; an
// `attach` turns its connection into that terminal's output stream: recent
// output first, then live output, then `{"exit":true}`. An attach that names
// `since` (an offset into the terminal's output, in bytes) gets the output
// from there on when it is still held, unaltered, with `from` saying where it
// starts; a host that can do this says `offsets` in its welcome.
//
// Compatibility: a host outlives the app that started it, so a newer app talks
// to an older host. Requests and replies only ever gain optional fields; a
// change that cannot be additive bumps PROTOCOL, and the state file name with
// it, so hosts of different protocols run side by side, never misread.
use std::collections::{HashMap, VecDeque};
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const PROTOCOL: u32 = 1;
const VERSION: &str = env!("CARGO_PKG_VERSION");

/// How much output a reattaching reader is replayed: a few screens of a busy
/// TUI. Whole chunks are dropped from the front, never half of one.
pub const RECENT_BYTES: usize = 256 * 1024;

/// A host with no terminals and no clients exits after this long.
const IDLE_EXIT: Duration = Duration::from_secs(10);

/// A request the host does not answer in this time is a wedged host.
const REPLY_TIMEOUT: Duration = Duration::from_secs(10);

/// An older host's recent output (`attach_recent`): the pause that ends it,
/// and the longest it is waited for. It comes from memory: 2026-10-28, four
/// real terminals sent ~430 KB each with no gap over 5 ms.
const RECENT_PAUSE: Duration = Duration::from_millis(50);
const RECENT_WAIT: Duration = Duration::from_secs(1);

// ---- output fan-out ---------------------------------------------------------

/// A terminal's output for its readers: recent output for one that attaches
/// late, live output for all. Used by the host per PTY and by the app per
/// attached terminal (the window and web clients read the same stream).
#[derive(Default)]
pub struct Output {
    recent: VecDeque<String>,
    recent_len: usize,
    /// Where `recent` starts in the terminal's whole output, in bytes. None in
    /// a copy that joined the stream at an unknown point (from an older host).
    start: Option<u64>,
    readers: Vec<Sender<String>>,
}

impl Output {
    /// The output of a terminal that has printed `at` bytes before it.
    pub fn starting_at(at: u64) -> Output {
        Output { start: Some(at), ..Output::default() }
    }

    pub fn push(&mut self, chunk: &str) {
        self.readers.retain(|tx| tx.send(chunk.to_string()).is_ok());
        self.recent_len += chunk.len();
        self.recent.push_back(chunk.to_string());
        while self.recent_len > RECENT_BYTES && self.recent.len() > 1 {
            if let Some(old) = self.recent.pop_front() {
                self.recent_len -= old.len();
                if let Some(start) = &mut self.start {
                    *start += old.len() as u64;
                }
            }
        }
    }

    /// Output from offset `since` on, unaltered, and the offset it starts at;
    /// all recent output when `since` is no longer held. Then live output.
    pub fn follow(&mut self, since: u64) -> (String, Option<u64>, Receiver<String>) {
        let (tx, rx) = channel();
        let recent = self.recent.iter().map(String::as_str).collect::<String>();
        let skip = self
            .start
            .and_then(|start| since.checked_sub(start))
            .and_then(|skip| usize::try_from(skip).ok())
            .filter(|&skip| skip <= recent.len() && recent.is_char_boundary(skip));
        let (text, from) = match (skip, self.start) {
            (Some(skip), _) => (recent[skip..].to_string(), Some(since)),
            (None, start) => (recent, start),
        };
        self.readers.push(tx);
        (text, from, rx)
    }

    /// Up to `len` bytes of the output that ends at offset `end`, if held.
    pub fn before(&self, end: u64, len: usize) -> Option<String> {
        let recent = self.recent.iter().map(String::as_str).collect::<String>();
        let stop = usize::try_from(end.checked_sub(self.start?)?).ok()?;
        if stop > recent.len() || !recent.is_char_boundary(stop) {
            return None;
        }
        let mut from = stop.saturating_sub(len);
        while !recent.is_char_boundary(from) {
            from += 1;
        }
        Some(recent[from..stop].to_string())
    }

    /// Recent output, then everything after it. Closes when the shell exits.
    ///
    /// The replay has its queries taken out (see `strip_queries`): a fresh
    /// screen would answer each one, and the answers would reach whatever runs
    /// in the shell NOW as typed text: a prompt full of `rgb:1f1f/…` after the
    /// app reopens on a shell where Claude Code once started.
    pub fn subscribe(&mut self) -> Receiver<String> {
        let (tx, rx) = channel();
        let replay = strip_queries(&self.recent.iter().map(String::as_str).collect::<String>());
        if !replay.is_empty() {
            let _ = tx.send(replay);
        }
        self.readers.push(tx);
        rx
    }

    /// The shell is gone: every reader's channel closes.
    pub fn end(&mut self) {
        self.readers.clear();
    }
}

/// `text` without the sequences that ask the terminal something: device
/// attributes and status (`CSI … c`, `CSI … n`), window reports (`CSI … t`),
/// mode and version queries (`CSI … $ p`, `CSI > … q`, `CSI ? u`), colour
/// queries (an OSC ending in `?`) and DCS setting queries (`$q`, `+q`). They
/// draw nothing, so dropping them from a replay changes nothing on screen.
pub fn strip_queries(text: &str) -> String {
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let (mut i, mut kept) = (0, 0);
    while i < b.len() {
        if b[i] != 0x1b || i + 1 >= b.len() {
            i += 1;
            continue;
        }
        let start = i;
        let (end, query) = match b[i + 1] {
            b'[' => {
                let mut j = i + 2;
                while j < b.len() && (0x20..=0x3f).contains(&b[j]) {
                    j += 1;
                }
                if j >= b.len() {
                    break; // cut off at the end: leave it
                }
                let body = &text[i + 2..j];
                let query = match b[j] {
                    b'c' | b'n' | b't' => true,
                    b'p' => body.ends_with('$'),
                    b'q' => body.starts_with('>'),
                    b'u' => body == "?",
                    _ => false,
                };
                (j + 1, query)
            }
            kind @ (b']' | b'P') => {
                // Up to BEL (OSC only) or ST.
                let mut j = i + 2;
                let mut end = None;
                while j < b.len() {
                    if b[j] == 0x07 && kind == b']' {
                        end = Some((j, j + 1));
                        break;
                    }
                    if b[j] == 0x1b && b.get(j + 1) == Some(&b'\\') {
                        end = Some((j, j + 2));
                        break;
                    }
                    j += 1;
                }
                let Some((body_end, end)) = end else { break };
                let body = &text[i + 2..body_end];
                let query = if kind == b']' {
                    body.ends_with('?')
                } else {
                    body.starts_with("$q") || body.starts_with("+q")
                };
                (end, query)
            }
            _ => (i + 2, false),
        };
        if query {
            out.push_str(&text[kept..start]);
            kept = end;
        }
        i = end;
    }
    out.push_str(&text[kept..]);
    out
}

/// Decode everything in `pending` except a trailing, still-incomplete UTF-8
/// sequence, which stays for the next read. Decoding each read on its own
/// turned every split `─` into three `�`, three cells where the program had
/// counted one, and TUIs that redraw with relative moves drew over their text.
/// Bytes invalid in themselves are still replaced, so binary cannot stall it.
pub fn take_utf8(pending: &mut Vec<u8>) -> String {
    let split = pending.len() - incomplete_tail(pending);
    let text = String::from_utf8_lossy(&pending[..split]).into_owned();
    pending.drain(..split);
    text
}

/// Length of a UTF-8 sequence cut off at the end of `bytes`. 0 when whole.
fn incomplete_tail(bytes: &[u8]) -> usize {
    for back in 1..=bytes.len().min(4) {
        let byte = bytes[bytes.len() - back];
        if byte & 0xC0 == 0x80 {
            continue;
        }
        let need = match byte {
            0xC0..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF7 => 4,
            _ => 1,
        };
        return if need > back { back } else { 0 };
    }
    0
}

// ---- control ----------------------------------------------------------------
//
// The desktop window and web tabs can show the same terminal. A shell has one
// size, and each of them used to set it to its own box: Claude Code repainted
// for each in turn, and every view but the one that asked drew those repaints
// as copies. Now one view controls a terminal at a time, as in tmux's
// `window-size latest`: it alone sets the size, the others follow it at that
// size, masked, until they take over. Kept by the app, which every view
// reaches the terminal through.

/// A window or browser tab showing a terminal. `kind` is what the others call
/// it: `desktop`, `web` or `phone`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Viewer {
    pub id: String,
    pub kind: String,
}

impl Viewer {
    pub fn desktop() -> Viewer {
        Viewer { id: "desktop".into(), kind: "desktop".into() }
    }

    /// A web page from before views named themselves. It sizes the shell
    /// like any view, so it is one: unnamed, it would size it from under the
    /// view in control, whose repaints the others then drew as copies.
    pub fn unnamed() -> Viewer {
        Viewer { id: "web".into(), kind: "web".into() }
    }

    /// One a client named itself: a short plain id and a known kind.
    pub fn is_valid(&self) -> bool {
        (1..=40).contains(&self.id.len())
            && self.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            && ["desktop", "web", "phone"].contains(&self.kind.as_str())
    }
}

/// Who controls a terminal (None: nobody, the next view to size it takes
/// it) and the size it runs at. Sent to every view when either changes.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Control {
    pub by: Option<Viewer>,
    pub cols: u16,
    pub rows: u16,
}

/// One terminal's control and the views told of its changes.
#[derive(Default)]
pub struct Controller {
    by: Option<Viewer>,
    watchers: Vec<Sender<Control>>,
}

impl Controller {
    /// `who` sized its view to `cols` x `rows`. True when that is the
    /// terminal's size now: `who` controls it, or took it as nobody did. A
    /// view following another is ignored.
    pub fn resize(&mut self, who: &Viewer, cols: u16, rows: u16) -> bool {
        match &self.by {
            Some(by) if by.id != who.id => return false,
            Some(_) => {}
            None => self.by = Some(who.clone()),
        }
        self.tell(cols, rows);
        true
    }

    /// `who` takes control, at its own size.
    pub fn claim(&mut self, who: Viewer, cols: u16, rows: u16) {
        self.by = Some(who);
        self.tell(cols, rows);
    }

    /// The view `id` went away; if it controlled the terminal, nobody does.
    pub fn release(&mut self, id: &str, cols: u16, rows: u16) {
        if self.by.as_ref().is_some_and(|by| by.id == id) {
            self.by = None;
            self.tell(cols, rows);
        }
    }

    /// Every change from now on, starting with how things stand.
    pub fn watch(&mut self, cols: u16, rows: u16) -> Receiver<Control> {
        let (tx, rx) = channel();
        let _ = tx.send(Control { by: self.by.clone(), cols, rows });
        self.watchers.push(tx);
        rx
    }

    fn tell(&mut self, cols: u16, rows: u16) {
        let control = Control { by: self.by.clone(), cols, rows };
        self.watchers.retain(|tx| tx.send(control.clone()).is_ok());
    }
}

// ---- wire -------------------------------------------------------------------

/// What to start, decided by the app: the host inherited the environment of
/// whichever app started it, possibly an older one, so the app sends its own.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Spawn {
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

impl Spawn {
    pub fn from_command(command: &CommandBuilder, cols: u16, rows: u16) -> Spawn {
        Spawn {
            argv: command.get_argv().iter().map(|a| a.to_string_lossy().into_owned()).collect(),
            cwd: command.get_cwd().map(|c| c.to_string_lossy().into_owned()),
            env: command
                .iter_full_env_as_str()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            cols,
            rows,
        }
    }

    fn command(&self) -> CommandBuilder {
        let mut command = CommandBuilder::from_argv(self.argv.iter().map(OsString::from).collect());
        command.env_clear();
        for (k, v) in &self.env {
            command.env(k, v);
        }
        if let Some(dir) = &self.cwd {
            command.cwd(dir);
        }
        command
    }

    fn size(&self) -> PtySize {
        pty_size(self.cols, self.rows)
    }
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Request {
    Open { id: String, spawn: Spawn },
    Write { id: String, data: String },
    Resize { id: String, cols: u16, rows: u16 },
    Close { id: String },
    List,
    Attach {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        since: Option<u64>,
    },
    Quit,
}

/// One running terminal, as `list` reports it.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Info {
    pub id: String,
    /// The shell's process id.
    pub pid: Option<u32>,
    /// The terminal's foreground process group (Unix): the program in front.
    pub foreground: Option<u32>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Serialize, Deserialize)]
struct Hello {
    token: String,
    protocol: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Welcome {
    /// The osd version the host was built from.
    pub version: String,
    pub protocol: u32,
    pub pid: u32,
    /// The host takes `since` on attach (see the top of this file).
    #[serde(default)]
    pub offsets: bool,
}

/// Where a running host can be reached. Written by the host, owner-only.
#[derive(Serialize, Deserialize)]
struct State {
    port: u16,
    token: String,
    pid: u32,
}

fn state_path(dir: &Path) -> PathBuf {
    dir.join(format!("termd-v{PROTOCOL}.json"))
}

fn read_state(dir: &Path) -> Result<State, String> {
    let text = std::fs::read_to_string(state_path(dir)).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

fn write_state(dir: &Path, state: &State) -> Result<(), String> {
    let path = state_path(dir);
    let tmp = dir.join(format!(".termd-{}.tmp", std::process::id()));
    {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&tmp).map_err(|e| e.to_string())?;
        file.write_all(serde_json::to_string(state).unwrap().as_bytes())
            .map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

fn send<T: Serialize>(out: &mut TcpStream, value: &T) -> std::io::Result<()> {
    let mut line = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    line.push(b'\n');
    out.write_all(&line)
}

/// One line as JSON. None at a clean end of stream.
fn receive<T: for<'de> Deserialize<'de>>(input: &mut BufReader<TcpStream>) -> std::io::Result<Option<T>> {
    let mut line = String::new();
    if input.read_line(&mut line)? == 0 {
        return Ok(None);
    }
    serde_json::from_str(&line).map(Some).map_err(std::io::Error::other)
}

// ---- host -------------------------------------------------------------------

struct Term {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    output: Arc<Mutex<Output>>,
}

struct Host {
    terms: Mutex<HashMap<String, Term>>,
    clients: AtomicUsize,
    dir: PathBuf,
    port: u16,
}

/// Run the host for the app whose data folder is `dir`, until it has had no
/// terminals and no clients for a while. Returns at once if one is running.
pub fn serve(dir: &Path) -> Result<(), String> {
    run(dir, Some(IDLE_EXIT))
}

fn run(dir: &Path, idle_exit: Option<Duration>) -> Result<(), String> {
    if Client::connect(dir).is_ok() {
        return Ok(()); // One host per data folder.
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = random_token()?;
    write_state(dir, &State { port, token: token.clone(), pid: std::process::id() })?;

    let host = Arc::new(Host {
        terms: Mutex::new(HashMap::new()),
        clients: AtomicUsize::new(0),
        dir: dir.to_path_buf(),
        port,
    });
    if let Some(idle) = idle_exit {
        let host = host.clone();
        std::thread::spawn(move || watch_idle(&host, idle));
    }
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let host = host.clone();
        let token = token.clone();
        std::thread::spawn(move || {
            host.clients.fetch_add(1, Ordering::SeqCst);
            let _ = host.handle(stream, &token);
            host.clients.fetch_sub(1, Ordering::SeqCst);
        });
    }
    Ok(())
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn watch_idle(host: &Host, idle: Duration) {
    let mut since: Option<Instant> = None;
    loop {
        std::thread::sleep(Duration::from_secs(1));
        let empty = host.terms.lock().map(|t| t.is_empty()).unwrap_or(false);
        if empty && host.clients.load(Ordering::SeqCst) == 0 {
            let start = *since.get_or_insert_with(Instant::now);
            if start.elapsed() >= idle {
                host.leave();
            }
        } else {
            since = None;
        }
    }
}

impl Host {
    /// Stop serving: the state file goes first (only if it still names this
    /// host), so nobody dials a host that is on its way out.
    fn leave(&self) -> ! {
        if read_state(&self.dir).is_ok_and(|s| s.port == self.port && s.pid == std::process::id()) {
            let _ = std::fs::remove_file(state_path(&self.dir));
        }
        std::process::exit(0)
    }

    fn handle(self: &Arc<Self>, stream: TcpStream, token: &str) -> std::io::Result<()> {
        let _ = stream.set_nodelay(true);
        stream.set_read_timeout(Some(REPLY_TIMEOUT))?;
        let mut input = BufReader::new(stream.try_clone()?);
        let mut out = stream;
        let hello: Option<Hello> = receive(&mut input)?;
        if hello.is_none_or(|h| h.token != token) {
            return send(&mut out, &json!({ "error": "not authorized" }));
        }
        out.set_read_timeout(None)?;
        send(&mut out, &Welcome { version: VERSION.into(), protocol: PROTOCOL, pid: std::process::id(), offsets: true })?;
        loop {
            let request: Request = match receive(&mut input) {
                Ok(Some(r)) => r,
                Ok(None) => return Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::Other => {
                    send(&mut out, &json!({ "error": format!("bad request: {e}") }))?;
                    continue;
                }
                Err(e) => return Err(e),
            };
            match request {
                Request::Attach { id, since } => return self.stream(&id, since, out),
                Request::Quit => {
                    if self.terms.lock().map(|t| t.is_empty()).unwrap_or(false) {
                        if read_state(&self.dir).is_ok_and(|s| s.port == self.port) {
                            let _ = std::fs::remove_file(state_path(&self.dir));
                        }
                        let _ = send(&mut out, &json!({ "ok": true }));
                        self.leave();
                    }
                    send(&mut out, &json!({ "error": "terminals are running" }))?;
                }
                request => {
                    let reply = self.apply(request).unwrap_or_else(|e| json!({ "error": e }));
                    send(&mut out, &reply)?;
                }
            }
        }
    }

    fn apply(self: &Arc<Self>, request: Request) -> Result<Value, String> {
        let mut terms = self.terms.lock().map_err(|_| "terminal state poisoned")?;
        match request {
            Request::Open { id, spawn } => {
                if let Some(term) = terms.get(&id) {
                    // Reattached from a window of another size: the program
                    // redraws for this one.
                    let _ = term.master.resize(spawn.size());
                    return Ok(json!({ "created": false, "pid": term.child.process_id() }));
                }
                let term = self.start(&id, &spawn)?;
                let pid = term.child.process_id();
                terms.insert(id, term);
                Ok(json!({ "created": true, "pid": pid }))
            }
            Request::Write { id, data } => {
                let term = terms.get_mut(&id).ok_or("no such terminal")?;
                term.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
                term.writer.flush().map_err(|e| e.to_string())?;
                Ok(json!({ "ok": true }))
            }
            Request::Resize { id, cols, rows } => {
                if let Some(term) = terms.get(&id) {
                    term.master.resize(pty_size(cols, rows)).map_err(|e| e.to_string())?;
                }
                Ok(json!({ "ok": true }))
            }
            Request::Close { id } => {
                if let Some(mut term) = terms.remove(&id) {
                    let _ = term.child.kill();
                    let _ = term.child.wait();
                }
                Ok(json!({ "ok": true }))
            }
            Request::List => {
                let list: Vec<Info> = terms
                    .iter()
                    .map(|(id, term)| {
                        let size = term.master.get_size().unwrap_or_default();
                        Info {
                            id: id.clone(),
                            pid: term.child.process_id(),
                            foreground: foreground_of(term),
                            cols: size.cols,
                            rows: size.rows,
                        }
                    })
                    .collect();
                Ok(json!({ "terminals": list }))
            }
            Request::Attach { .. } | Request::Quit => unreachable!("handled per connection"),
        }
    }

    /// Start a PTY and the thread that reads it. Called under the terms lock,
    /// which the reader takes to forget an exited shell: a shell that exits at
    /// once is never removed before it is inserted.
    fn start(self: &Arc<Self>, id: &str, spawn: &Spawn) -> Result<Term, String> {
        let pair = NativePtySystem::default().openpty(spawn.size()).map_err(|e| e.to_string())?;
        let child = pair.slave.spawn_command(spawn.command()).map_err(|e| e.to_string())?;
        // Or the master never sees EOF when the shell exits.
        drop(pair.slave);
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let output = Arc::new(Mutex::new(Output::starting_at(0)));

        let host = self.clone();
        let reader_output = output.clone();
        let reader_id = id.to_string();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            let mut pending: Vec<u8> = Vec::new();
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&buffer[..n]);
                        let chunk = take_utf8(&mut pending);
                        if !chunk.is_empty() {
                            if let Ok(mut out) = reader_output.lock() {
                                out.push(&chunk);
                            }
                        }
                    }
                }
            }
            if let Ok(mut out) = reader_output.lock() {
                out.end();
            }
            // Forget it only if the id still names THIS shell: a close and a
            // reopen of the same id may have happened before this EOF.
            let exited = host.terms.lock().ok().and_then(|mut terms| {
                let same = terms.get(&reader_id).is_some_and(|t| Arc::ptr_eq(&t.output, &reader_output));
                if same { terms.remove(&reader_id) } else { None }
            });
            if let Some(mut term) = exited {
                let _ = term.child.wait(); // reap it
            }
        });
        Ok(Term { writer, master: pair.master, child, output })
    }

    /// Serve one terminal's output on this connection until the shell exits
    /// or the reader goes away.
    fn stream(&self, id: &str, since: Option<u64>, mut out: TcpStream) -> std::io::Result<()> {
        let output = self.terms.lock().ok().and_then(|terms| terms.get(id).map(|t| t.output.clone()));
        let rx = match (output, since) {
            (Some(output), Some(since)) => {
                let Ok(mut output) = output.lock() else { return send(&mut out, &json!({ "exit": true })) };
                let (text, from, rx) = output.follow(since);
                drop(output);
                send(&mut out, &json!({ "data": text, "from": from }))?;
                Some(rx)
            }
            (Some(output), None) => output.lock().ok().map(|mut o| o.subscribe()),
            (None, _) => None,
        };
        if let Some(rx) = rx {
            for chunk in rx {
                send(&mut out, &json!({ "data": chunk }))?;
            }
        }
        send(&mut out, &json!({ "exit": true }))
    }
}

#[cfg(unix)]
fn foreground_of(term: &Term) -> Option<u32> {
    term.master.process_group_leader().filter(|p| *p > 0).map(|p| p as u32)
}

#[cfg(not(unix))]
fn foreground_of(_term: &Term) -> Option<u32> {
    None
}

// ---- client -----------------------------------------------------------------

/// A control connection to the host.
pub struct Client {
    port: u16,
    token: String,
    input: BufReader<TcpStream>,
    out: TcpStream,
    pub welcome: Welcome,
    broken: bool,
}

fn dial(port: u16, token: &str) -> Result<(BufReader<TcpStream>, TcpStream, Welcome), String> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut out = TcpStream::connect_timeout(&addr, Duration::from_secs(1)).map_err(|e| e.to_string())?;
    let _ = out.set_nodelay(true);
    out.set_read_timeout(Some(REPLY_TIMEOUT)).map_err(|e| e.to_string())?;
    let mut input = BufReader::new(out.try_clone().map_err(|e| e.to_string())?);
    send(&mut out, &Hello { token: token.into(), protocol: PROTOCOL }).map_err(|e| e.to_string())?;
    let reply: Value = receive(&mut input).map_err(|e| e.to_string())?.ok_or("terminal host closed")?;
    if let Some(e) = reply.get("error").and_then(Value::as_str) {
        return Err(e.to_string());
    }
    let welcome = serde_json::from_value(reply).map_err(|e| e.to_string())?;
    Ok((input, out, welcome))
}

impl Client {
    /// The running host of this data folder, if there is one.
    pub fn connect(dir: &Path) -> Result<Client, String> {
        let state = read_state(dir)?;
        let (input, out, welcome) = dial(state.port, &state.token)?;
        Ok(Client { port: state.port, token: state.token, input, out, welcome, broken: false })
    }

    /// The connection failed mid-request: dial again before the next one.
    pub fn is_broken(&self) -> bool {
        self.broken
    }

    fn call(&mut self, request: &Request) -> Result<Value, String> {
        let reply = send(&mut self.out, request).and_then(|()| receive::<Value>(&mut self.input));
        let reply = match reply {
            Ok(Some(v)) => v,
            Ok(None) => {
                self.broken = true;
                return Err("terminal host closed the connection".into());
            }
            Err(e) => {
                self.broken = true;
                return Err(format!("terminal host: {e}"));
            }
        };
        match reply.get("error").and_then(Value::as_str) {
            Some(e) => Err(e.to_string()),
            None => Ok(reply),
        }
    }

    /// Start `id`, or find it running. (created, shell pid)
    pub fn open(&mut self, id: &str, spawn: &Spawn) -> Result<(bool, Option<u32>), String> {
        let reply = self.call(&Request::Open { id: id.into(), spawn: spawn.clone() })?;
        let created = reply.get("created").and_then(Value::as_bool).unwrap_or(false);
        let pid = reply.get("pid").and_then(Value::as_u64).map(|p| p as u32);
        Ok((created, pid))
    }

    pub fn write(&mut self, id: &str, data: &str) -> Result<(), String> {
        self.call(&Request::Write { id: id.into(), data: data.into() }).map(drop)
    }

    pub fn resize(&mut self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        self.call(&Request::Resize { id: id.into(), cols, rows }).map(drop)
    }

    pub fn close(&mut self, id: &str) -> Result<(), String> {
        self.call(&Request::Close { id: id.into() }).map(drop)
    }

    pub fn list(&mut self) -> Result<Vec<Info>, String> {
        let reply = self.call(&Request::List)?;
        serde_json::from_value(reply.get("terminals").cloned().unwrap_or_default()).map_err(|e| e.to_string())
    }

    /// Ask an idle host to exit. Refused while it has terminals.
    pub fn quit(&mut self) -> Result<(), String> {
        self.call(&Request::Quit).map(drop)
    }

    /// `id`'s output on a connection of its own: recent output, then live,
    /// ending when the shell exits or the host goes away.
    pub fn attach(&self, id: &str) -> Result<Attached, String> {
        let (input, mut out, _) = dial(self.port, &self.token)?;
        out.set_read_timeout(None).map_err(|e| e.to_string())?;
        send(&mut out, &Request::Attach { id: id.into(), since: None }).map_err(|e| e.to_string())?;
        Ok(Attached(input))
    }

    /// Like `attach`, for a host without `offsets`: such a host sends the
    /// recent output as it was read, chunk by chunk, then live output, with
    /// nothing in between. What arrives in its first burst (until a pause, or
    /// at most `RECENT_WAIT`) is returned as the recent output; it may end a
    /// little early or late, and the rest follows on the receiver.
    pub fn attach_recent(&self, id: &str) -> Result<(String, Receiver<String>), String> {
        let attached = self.attach(id)?;
        let (tx, rx) = channel();
        std::thread::spawn(move || {
            for chunk in attached {
                if tx.send(chunk).is_err() {
                    return;
                }
            }
        });
        let deadline = Instant::now() + RECENT_WAIT;
        let mut recent = String::new();
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(RECENT_PAUSE.min(left)) {
                Ok(chunk) => recent.push_str(&chunk),
                Err(_) => break,
            }
        }
        Ok((recent, rx))
    }

    /// Like `attach`, from offset `since` of `id`'s output (see `Output::follow`):
    /// that output, where it starts, then live output. Only for a host that
    /// says `offsets`, which answers at once.
    pub fn attach_from(&self, id: &str, since: u64) -> Result<(String, u64, Attached), String> {
        let (mut input, mut out, _) = dial(self.port, &self.token)?;
        send(&mut out, &Request::Attach { id: id.into(), since: Some(since) }).map_err(|e| e.to_string())?;
        let first: Value = receive(&mut input).map_err(|e| e.to_string())?.ok_or("terminal host closed")?;
        out.set_read_timeout(None).map_err(|e| e.to_string())?;
        let text = first.get("data").and_then(Value::as_str).ok_or("no such terminal")?;
        let from = first.get("from").and_then(Value::as_u64).ok_or("terminal host sent no offset")?;
        Ok((text.to_string(), from, Attached(input)))
    }
}

pub struct Attached(BufReader<TcpStream>);

impl Iterator for Attached {
    type Item = String;
    fn next(&mut self) -> Option<String> {
        let line: Value = receive(&mut self.0).ok()??;
        line.get("data").and_then(Value::as_str).map(str::to_string)
    }
}

// ---- starting the host ------------------------------------------------------

/// A client of the host for `dir`, starting one from `osd` (the bundled CLI)
/// when none runs. An idle host of another build is swapped for this one's;
/// a busy one is kept, because its terminals are the point.
pub fn ensure(dir: &Path, osd: &Path) -> Result<Client, String> {
    if let Ok(mut client) = Client::connect(dir) {
        if client.welcome.version == VERSION || !client.list().is_ok_and(|l| l.is_empty()) {
            return Ok(client);
        }
        let _ = client.quit();
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let exe = host_binary(dir, osd)?;
    spawn_detached(&exe, dir)?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match Client::connect(dir) {
            Ok(client) => return Ok(client),
            Err(e) if Instant::now() > deadline => return Err(format!("terminal host did not start: {e}")),
            Err(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

/// The binary the host runs from: a copy in the data folder, never the file
/// in the install. Nothing of the install may be running while it is replaced:
/// the Windows installer kills every process imaged under the install folder,
/// an AppImage's files vanish when the app that mounted them exits, and on
/// macOS a manual install (closing the app, dragging the new one over it) must
/// not meet a running file inside the old bundle.
fn host_binary(dir: &Path, osd: &Path) -> Result<PathBuf, String> {
    let len = std::fs::metadata(osd).map_err(|e| format!("{}: {e}", osd.display()))?.len();
    let folder = dir.join("termd");
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let name = format!("osd-{VERSION}-{len}{}", std::env::consts::EXE_SUFFIX);
    let target = folder.join(&name);
    if !target.is_file() {
        let tmp = folder.join(format!(".{name}.{}", std::process::id()));
        std::fs::copy(osd, &tmp).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
    }
    // Older copies; one still running is refused (Windows) or kept by its
    // process until it exits (Linux).
    if let Ok(entries) = std::fs::read_dir(&folder) {
        for entry in entries.flatten() {
            if entry.file_name() != name.as_str() {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    Ok(target)
}

fn spawn_detached(exe: &Path, dir: &Path) -> Result<(), String> {
    use std::process::Stdio;
    let mut command = crate::runtime::quiet_command(exe);
    command
        .arg("termd")
        .arg("--dir")
        .arg(dir)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        // Out of the app's job, if it is in one that kills its members on exit.
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB);
        if let Ok(child) = command.spawn() {
            return reap(child);
        }
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    let child = command.spawn().map_err(|e| format!("{}: {e}", exe.display()))?;
    reap(child)
}

/// Collect the exit status of a host that ends while we still run.
fn reap(mut child: std::process::Child) -> Result<(), String> {
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_view_sizes_a_terminal_and_the_others_follow_until_they_take_over() {
        let web = Viewer { id: "tab1".into(), kind: "web".into() };
        let mut c = Controller::default();
        let seen = c.watch(80, 24);
        assert_eq!(seen.try_recv().unwrap(), Control { by: None, cols: 80, rows: 24 });

        // Nobody controls it: the first view to size it takes it.
        assert!(c.resize(&Viewer::desktop(), 60, 22));
        assert_eq!(seen.try_recv().unwrap().by, Some(Viewer::desktop()));
        // Another view's box is ignored, an unnamed (older) page's too.
        assert!(!c.resize(&web, 50, 21));
        assert!(!c.resize(&Viewer::unnamed(), 50, 21));
        assert!(seen.try_recv().is_err());
        assert!(c.resize(&Viewer::desktop(), 61, 22));
        assert_eq!(seen.try_recv().unwrap(), Control { by: Some(Viewer::desktop()), cols: 61, rows: 22 });

        // Taking over; then the one that left lets go of nothing.
        c.claim(web.clone(), 50, 21);
        assert_eq!(seen.try_recv().unwrap(), Control { by: Some(web.clone()), cols: 50, rows: 21 });
        c.release("desktop", 50, 21);
        assert!(seen.try_recv().is_err());
        c.release("tab1", 50, 21);
        assert_eq!(seen.try_recv().unwrap(), Control { by: None, cols: 50, rows: 21 });
    }

    #[test]
    fn a_viewer_names_itself_plainly() {
        assert!(Viewer::desktop().is_valid());
        assert!(Viewer { id: "a1-b2".into(), kind: "phone".into() }.is_valid());
        assert!(!Viewer { id: "a b".into(), kind: "web".into() }.is_valid());
        assert!(!Viewer { id: "x".into(), kind: "tv".into() }.is_valid());
        assert!(!Viewer { id: "".into(), kind: "web".into() }.is_valid());
    }

    #[test]
    fn a_reattaching_reader_gets_recent_output_then_live_output() {
        let mut out = Output::default();
        out.push("$ ls\r\n");
        let early = out.subscribe();
        out.push("a.txt\r\n");
        let late = out.subscribe();
        assert_eq!(early.try_iter().collect::<Vec<_>>(), ["$ ls\r\n", "a.txt\r\n"]);
        assert_eq!(late.try_iter().collect::<Vec<_>>(), ["$ ls\r\na.txt\r\n"]);
        drop(early);
        out.push("$ ");
        assert_eq!(out.readers.len(), 1);
        assert_eq!(late.try_iter().collect::<Vec<_>>(), ["$ "]);
    }

    #[test]
    fn a_replay_asks_the_new_screen_nothing() {
        let mut out = Output::default();
        // What Claude Code sends as it starts, split across reads.
        out.push("\x1b[c\x1b]10;?\x1b\\\x1b]11;?\x07\x1b]4;0;?;1");
        out.push(";?\x1b\\\x1b[6n\x1b[>q\x1b[?u\x1b[?2004$p\x1bP$q m\x1b\\");
        out.push("\x1b[1;31mhi\x1b[0m\x1b]0;title\x07\x1b[?2004h$ ");
        let replay = out.subscribe().try_iter().collect::<Vec<_>>();
        assert_eq!(replay, ["\x1b[1;31mhi\x1b[0m\x1b]0;title\x07\x1b[?2004h$ "]);
        assert_eq!(strip_queries("a\x1b[6"), "a\x1b[6");
        assert_eq!(strip_queries("中\x1b[c文"), "中文");
    }

    #[test]
    fn a_reader_can_follow_on_from_an_offset_it_has_seen() {
        let mut out = Output::starting_at(0);
        out.push("\x1b[6n$ ls\r\n");
        out.push("a.txt\r\n");
        // From where an earlier reader left off: the rest, unaltered.
        let (text, from, rx) = out.follow(10);
        assert_eq!((text.as_str(), from), ("a.txt\r\n", Some(10)));
        out.push("$ ");
        assert_eq!(rx.try_iter().collect::<Vec<_>>(), ["$ "]);
        // From where nothing is held any more, or mid-character: everything.
        let (text, from, _) = out.follow(99);
        assert_eq!((text.as_str(), from), ("\x1b[6n$ ls\r\na.txt\r\n$ ", Some(0)));
        let mut wide = Output::starting_at(7);
        wide.push("中");
        assert_eq!(wide.follow(8).1, Some(7));
        assert_eq!(wide.follow(10).0, "");
        // Offsets move with what is dropped from the front.
        let mut long = Output::starting_at(0);
        let chunk = "x".repeat(100 * 1024);
        for _ in 0..5 {
            long.push(&chunk);
        }
        assert_eq!(long.follow(0).1, Some(5 * chunk.len() as u64 - long.recent_len as u64));
        // A copy that joined at an unknown point knows no offsets.
        assert_eq!(Output::default().follow(0).1, None);
    }

    #[test]
    fn the_output_before_an_offset_is_read_back_whole_characters() {
        let mut out = Output::starting_at(10);
        out.push("ab中");
        out.push("cd");
        assert_eq!(out.before(15, 3).as_deref(), Some("中"));
        assert_eq!(out.before(15, 4).as_deref(), Some("b中"));
        assert_eq!(out.before(15, 2).as_deref(), Some("")); // starts on a boundary
        assert_eq!(out.before(15, 99).as_deref(), Some("ab中"));
        assert_eq!(out.before(17, 2).as_deref(), Some("cd"));
        assert_eq!(out.before(14, 2), None); // mid-character
        assert_eq!(out.before(18, 2), None); // not printed yet
        assert_eq!(out.before(9, 2), None); // before what is held
        assert_eq!(Output::default().before(0, 2), None);
    }

    #[test]
    fn recent_output_is_capped_in_whole_chunks() {
        let mut out = Output::default();
        let chunk = "x".repeat(100 * 1024);
        for _ in 0..5 {
            out.push(&chunk);
        }
        assert!(out.recent_len <= RECENT_BYTES);
        assert!(out.recent.iter().all(|c| c.len() == chunk.len()));
    }

    #[test]
    fn a_character_split_across_reads_arrives_whole() {
        let rule = "a─b".as_bytes();
        let mut pending = rule[..2].to_vec();
        assert_eq!(take_utf8(&mut pending), "a");
        assert_eq!(pending, vec![0xE2]);
        pending.extend_from_slice(&rule[2..]);
        assert_eq!(take_utf8(&mut pending), "─b");
        assert!(pending.is_empty());
    }

    #[test]
    fn every_split_point_of_wide_text_decodes_losslessly() {
        let text = "设计 ⏺ 🧪 ─│ ok";
        let bytes = text.as_bytes();
        for cut in 0..=bytes.len() {
            let mut pending = bytes[..cut].to_vec();
            let mut out = take_utf8(&mut pending);
            pending.extend_from_slice(&bytes[cut..]);
            out += &take_utf8(&mut pending);
            assert_eq!(out, text, "cut at {cut}");
        }
    }

    #[test]
    fn invalid_bytes_do_not_stall_the_terminal() {
        let mut pending = vec![b'a', 0x80, b'b'];
        assert_eq!(take_utf8(&mut pending), "a\u{FFFD}b");
        assert!(pending.is_empty());
    }

    #[test]
    fn a_spawn_round_trips_through_a_command() {
        let mut command = CommandBuilder::new("/bin/sh");
        command.arg("-l");
        command.cwd("/tmp");
        command.env("OSD_PROBE", "1");
        let spawn = Spawn::from_command(&command, 80, 24);
        assert_eq!(spawn.argv, ["/bin/sh", "-l"]);
        assert_eq!(spawn.cwd.as_deref(), Some("/tmp"));
        assert!(spawn.env.contains(&("OSD_PROBE".into(), "1".into())));
        let back = spawn.command();
        assert_eq!(back.get_argv(), command.get_argv());
        assert_eq!(back.get_env("OSD_PROBE").and_then(|v| v.to_str()), Some("1"));
    }

    /// Read `attached` until `want` shows up, or fail after a few seconds.
    #[cfg(unix)]
    fn read_until(attached: Attached, want: &str) -> String {
        let (tx, rx) = channel();
        std::thread::spawn(move || {
            let mut seen = String::new();
            for chunk in attached {
                seen += &chunk;
                if tx.send(seen.clone()).is_err() {
                    return;
                }
            }
        });
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut seen = String::new();
        while !seen.contains(want) {
            let left = deadline.saturating_duration_since(Instant::now());
            seen = rx.recv_timeout(left).unwrap_or_else(|_| panic!("never saw {want:?} in {seen:?}"));
        }
        seen
    }

    #[cfg(unix)]
    #[test]
    fn a_terminal_outlives_its_client_and_replays_to_the_next() {
        let dir = std::env::temp_dir().join(format!("osd-termd-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let host_dir = dir.clone();
        std::thread::spawn(move || run(&host_dir, None));
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut first = loop {
            match Client::connect(&dir) {
                Ok(c) => break c,
                Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
                Err(e) => panic!("host never came up: {e}"),
            }
        };
        assert_eq!(first.welcome.protocol, PROTOCOL);

        let mut command = CommandBuilder::new("/bin/sh");
        command.env("PS1", "$ ");
        let spawn = Spawn::from_command(&command, 80, 24);
        let (created, pid) = first.open("t1", &spawn).unwrap();
        assert!(created && pid.is_some());
        let live = first.attach("t1").unwrap();
        first.write("t1", "echo kept-$((40+2))\n").unwrap();
        read_until(live, "kept-42");

        // The app goes away (update, crash, quit); the shell does not.
        drop(first);
        let mut second = Client::connect(&dir).unwrap();
        let (created, again) = second.open("t1", &spawn).unwrap();
        assert!(!created, "a running terminal is found, not started again");
        assert_eq!(again, pid);
        assert_eq!(second.list().unwrap().iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), ["t1"]);
        // The new client is replayed what it missed, and the shell still answers.
        let replay = second.attach("t1").unwrap();
        second.write("t1", "echo still-$((6*7))\n").unwrap();
        let seen = read_until(replay, "still-42");
        assert!(seen.contains("kept-42"), "recent output is replayed: {seen:?}");
        // From an offset: the output after it, and where that is.
        assert!(second.welcome.offsets);
        let (all, from, _) = second.attach_from("t1", 0).unwrap();
        assert_eq!(from, 0);
        let at = all.find("still-42").unwrap() as u64;
        let (rest, from, _) = second.attach_from("t1", at).unwrap();
        assert_eq!(from, at);
        assert!(rest.starts_with("still-42"), "{rest:?}");

        // Closing ends it, and its stream ends with it.
        let ending = second.attach("t1").unwrap();
        second.close("t1").unwrap();
        let _ = ending.count(); // returns only because the stream ended
        assert!(second.list().unwrap().is_empty());
        assert!(second.write("t1", "x").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_wrong_token_is_refused() {
        let dir = std::env::temp_dir().join(format!("osd-termd-token-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let host_dir = dir.clone();
        std::thread::spawn(move || run(&host_dir, None));
        let deadline = Instant::now() + Duration::from_secs(5);
        let state = loop {
            if let Ok(s) = read_state(&dir) {
                break s;
            }
            assert!(Instant::now() < deadline, "host never came up");
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(dial(state.port, "wrong").is_err());
        assert!(dial(state.port, &state.token).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
