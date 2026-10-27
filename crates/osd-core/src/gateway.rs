// Remote Access Gateway — one authenticated HTTP surface that re-exposes the
// agent runtime + workspace files to CLI / LAN-web / tunnel clients. Loopback by
// default; LAN (0.0.0.0) is an explicit opt-in. Std-only `TcpListener` with a
// thread per connection (mirrors `preview_server.rs`) — no new crates: agent
// calls proxy to the loopback OpenCode sidecar with the already-present blocking
// `reqwest`, adding the sidecar's per-run Basic-auth password itself; file calls
// reuse `artifact_file`. A small self-contained web client ships at `/`.
//
// The ONLY thing that ever binds off-loopback is this gateway, and it is the only
// thing that understands the external bearer token — the sidecar stays
// 127.0.0.1-only always. See docs/rfc/remote-access-gateway.md.
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::artifact_file::{locate_under, mime_for, resolve_under, scope_root};
use crate::env::Env;
use crate::runtime::{random_hex, runtime_root, server_password, sidecar_url, tighten_private, workspace_dir};

/// The web client + all `/v1` routes are served on this port when free, so a
/// bookmarked URL / QR survives restarts; falls back to an ephemeral port.
const PREFERRED_PORT: u16 = 4098;

/// SPA route roots (client-side routes served by index.html, not the OpenCode
/// proxy). Everything else that isn't a static asset is proxied to the sidecar.
const SPA_ROOTS: &[&str] = &["live", "example", "skills", "notebooks", "files", "runs", "projects", "settings"];

// ---- persisted config (app-level, under the runtime root) -------------------

pub struct Persisted {
    pub enabled: bool,
    pub lan: bool,
    /// "full" = every endpoint; "read-only" = GET only (no turns, no approvals).
    pub mode: String,
    pub token: String,
    /// The port the listener is CURRENTLY on, rewritten on every bind and
    /// cleared on stop. `osd` reads it to find a gateway already running on this
    /// machine — the desktop app's own — instead of asking the user for a URL.
    pub port: Option<u16>,
    /// The port the user pinned the gateway to in Settings, kept until they
    /// clear it (#80). Deliberately NOT `port`: that field is an address record
    /// this process rewrites on every bind and erases on exit, while a
    /// preference has to survive both — and reading a stale record back as a
    /// preference would silently turn "4098 when it is free" into "4098 or
    /// refuse to start".
    pub preferred_port: Option<u16>,
    /// Whether a web client may open a shell on this machine. Its own switch,
    /// off by default: a full-access token is otherwise a token to run agent
    /// turns, and a shell is a step past that the user has to take on purpose.
    pub terminal: bool,
}

impl Default for Persisted {
    fn default() -> Self {
        Persisted {
            enabled: false,
            lan: false,
            mode: "full".into(),
            token: String::new(),
            port: None,
            preferred_port: None,
            terminal: false,
        }
    }
}

fn config_file(env: &Env) -> Result<PathBuf, String> {
    Ok(runtime_root(env)?.join("gateway.txt"))
}

pub fn read_persisted(env: &Env) -> Persisted {
    let mut p = Persisted::default();
    if let Ok(f) = config_file(env) {
        if let Ok(s) = std::fs::read_to_string(f) {
            for line in s.lines() {
                if let Some((k, v)) = line.trim().split_once(' ') {
                    match k {
                        "enabled" => p.enabled = v == "1",
                        "lan" => p.lan = v == "1",
                        "mode" => p.mode = normalize_mode(v),
                        "token" => p.token = v.to_string(),
                        "port" => p.port = v.parse().ok(),
                        "preferredPort" => p.preferred_port = v.parse().ok(),
                        "terminal" => p.terminal = v == "1",
                        _ => {}
                    }
                }
            }
        }
    }
    p
}

fn write_persisted(env: &Env, p: &Persisted) -> Result<(), String> {
    let f = config_file(env)?;
    if let Some(dir) = f.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = format!(
        "enabled {}\nlan {}\nmode {}\ntoken {}\nport {}\npreferredPort {}\nterminal {}\n",
        if p.enabled { 1 } else { 0 },
        if p.lan { 1 } else { 0 },
        p.mode,
        p.token,
        p.port.map(|v| v.to_string()).unwrap_or_default(),
        p.preferred_port.map(|v| v.to_string()).unwrap_or_default(),
        if p.terminal { 1 } else { 0 }
    );
    std::fs::write(&f, body).map_err(|e| e.to_string())?;
    tighten_private(&f); // token is a secret — owner-only, never in git
    Ok(())
}

/// The gateway token for this machine, minting and storing one if there is none.
///
/// The token is shared on purpose: the desktop app and `osd server` are two
/// front doors to ONE runtime root, and a client that was handed a token by
/// either must be able to use it against the other. Nothing else in the
/// persisted record is touched — enabled/LAN/mode are the desktop's settings,
/// and running a headless server for an afternoon must not rewrite them.
pub fn ensure_token(env: &Env, requested: Option<String>) -> Result<String, String> {
    let mut p = read_persisted(env);
    match requested {
        Some(t) if t.trim().is_empty() => return Err("the token cannot be empty".into()),
        Some(t) if t != p.token => p.token = t,
        Some(t) => return Ok(t),
        None if !p.token.is_empty() => return Ok(p.token),
        None => p.token = random_hex(24),
    }
    write_persisted(env, &p)?;
    Ok(p.token)
}

fn normalize_mode(m: &str) -> String {
    if m == "read-only" { "read-only".into() } else { "full".into() }
}

// ---- runtime state ----------------------------------------------------------

/// Token + mode the running listener reads PER-REQUEST, so rotating the token
/// or flipping the access mode never needs a rebind (the port stays stable).
struct Shared {
    token: Mutex<String>,
    read_only: AtomicBool,
    /// The user's "allow terminal" switch, read per request like the mode.
    terminal: AtomicBool,
    /// Shells this gateway opened. A web client reaches only these — never a
    /// terminal of the desktop window — and they are killed when access to
    /// them is withdrawn (see `close_remote_terminals`).
    remote_terminals: Mutex<HashSet<String>>,
    /// Live file tickets: id → (issued, resolved absolute path). See `issue_ticket`.
    tickets: Mutex<HashMap<String, (Instant, PathBuf)>>,
    /// Open browser-tab streams (`GET /v1/mux`), by id. See `mux_open`.
    muxes: Mutex<HashMap<String, Mux>>,
    /// When each conversation last messaged another one through `osd` (see
    /// `agent_send_limited`).
    agent_sends: Mutex<HashMap<String, Vec<Instant>>>,
}

/// How many messages one conversation may send to other sessions and
/// terminals within `AGENT_SEND_WINDOW`. Two agents told to talk to each other
/// would otherwise go on for as long as the tokens last.
const AGENT_SEND_LIMIT: usize = 5;
const AGENT_SEND_WINDOW: Duration = Duration::from_secs(600);

/// How long a file ticket stays valid. Long enough for a <video> to stream and
/// seek through one sitting, short enough that a leaked URL is quickly worthless.
const TICKET_TTL: Duration = Duration::from_secs(600);

/// Mint a capability for ONE already-resolved file.
///
/// The gateway token must never appear in a URL that ends up inside a document
/// — an `<iframe>`/`<img>` src, or a tab opened on an artifact. A page can read
/// its own `location` whatever its sandbox, and the agent writes the HTML in
/// this workspace: one prompt-injected report would post the token out and hand
/// an attacker the whole gateway. A ticket names one file and expires.
fn issue_ticket(ctx: &Ctx, full: PathBuf) -> String {
    let mut tickets = ctx.shared.tickets.lock().unwrap();
    let now = Instant::now();
    tickets.retain(|_, (issued, _)| now.duration_since(*issued) < TICKET_TTL);
    let id = random_hex(24);
    tickets.insert(id.clone(), (now, full));
    id
}

fn redeem_ticket(ctx: &Ctx, id: &str) -> Option<PathBuf> {
    let tickets = ctx.shared.tickets.lock().unwrap();
    let (issued, path) = tickets.get(id)?;
    (Instant::now().duration_since(*issued) < TICKET_TTL).then(|| path.clone())
}

/// Re-verify a ticket's path at REDEMPTION time, not just at issuance.
///
/// A ticket names a path that was canonicalized inside the workspace when it
/// was issued, but the file on disk is not immutable between the two moments:
/// an agent run in the workspace can replace it with a symlink that points
/// outside (`.ssh/id_ed25519`, `auth.json`, …). Redemption runs BEFORE the
/// token gate, so `send_file` must not open whatever now sits at that name.
/// Three checks, all cheap:
///
///   * the path must not be a symlink (`symlink_metadata` — `File::open` would
///     follow one), and must still be a regular file;
///   * its canonical target must still sit under the base workspace, or inside
///     a registered project's own folder (the same rule every other
///     caller-supplied session directory in this codebase follows).
fn redeem_verify(ctx: &Ctx, full: &Path) -> Result<PathBuf, String> {
    // `symlink_metadata` does not follow the final component, so a swapped-in
    // symlink is caught here rather than resolved.
    let meta = std::fs::symlink_metadata(full).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err("not a plain file".into());
    }
    let canon = full.canonicalize().map_err(|e| e.to_string())?;
    let base = crate::runtime::base_workspace_dir(&ctx.env)
        .map_err(|e| e.to_string())?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    // The same folders `fs_base` issues tickets in: the base folder, the host's
    // active workspace (which may sit elsewhere, e.g. `osd server --workspace`),
    // and registered projects.
    let active = workspace_dir(&ctx.env).ok().and_then(|p| p.canonicalize().ok());
    if !canon.starts_with(&base)
        && !active.is_some_and(|a| canon.starts_with(a))
        && !crate::project::is_inside_registered_project(&ctx.env, &canon)
    {
        return Err("outside the workspace".into());
    }
    Ok(canon)
}

struct Running {
    port: u16,
    lan: bool,
    stop: Arc<AtomicBool>,
    shared: Arc<Shared>,
}

/// One static file of the web client: its bytes and its content type.
///
/// The gateway serves the REAL desktop UI, not a re-implementation, so both
/// hosts have to hand it the same build: the desktop passes Tauri's embedded
/// asset resolver, `osd` passes the copy compiled into its own binary.
pub trait Assets: Send + Sync {
    fn get(&self, path: &str) -> Option<(Vec<u8>, String)>;
}

/// Shells for web clients, supplied by a host that has them (the desktop app;
/// `osd server` has none, and its gateway answers terminal requests with 404).
///
/// `id` is the client's own handle — its pane's id — so a page reload reattaches
/// to the same shell instead of starting another.
pub trait Terminals: Send + Sync {
    /// Start a shell, or do nothing if `id` is already running. True when a
    /// new shell was started — only then may the caller type a startup
    /// command into it.
    fn open(&self, id: &str, cwd: Option<String>, cols: u16, rows: u16) -> Result<bool, String>;
    fn write(&self, id: &str, data: &str) -> Result<(), String>;
    fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String>;
    fn close(&self, id: &str) -> Result<(), String>;
    /// Recent output, then everything after it. The channel closes when the
    /// shell exits. None for a terminal that is not running.
    fn subscribe(&self, id: &str) -> Option<Receiver<String>>;
    /// The pane's size as (rows, cols). None when it is not running or not known.
    fn size(&self, id: &str) -> Option<(u16, u16)>;
}

/// A build with no web client bundled. Serving still works — `/v1` is a
/// complete API on its own — but `/` says so instead of returning nothing.
pub struct NoAssets;

impl Assets for NoAssets {
    fn get(&self, _path: &str) -> Option<(Vec<u8>, String)> {
        None
    }
}

pub struct GatewayState {
    running: Mutex<Option<Running>>,
    assets: Arc<dyn Assets>,
    terminals: Option<Arc<dyn Terminals>>,
    /// Called with a layout a token client wrote, so the desktop window shows
    /// it at once (the window and token clients share one set of Screens).
    on_desktop_layout: Option<Arc<dyn Fn(&str) + Send + Sync>>,
    /// Called with a Screen's id when a client asks the window to show it
    /// (`osd screen show`): which Screen a view shows is its own, so this is
    /// a request to the window, not a layout change.
    on_show_screen: Option<Arc<dyn Fn(&str) + Send + Sync>>,
    /// Called when a client created or deleted a session, so a desktop window
    /// showing the same workspace refreshes instead of going stale.
    on_sessions_changed: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl GatewayState {
    pub fn new(
        assets: Arc<dyn Assets>,
        on_sessions_changed: Option<Arc<dyn Fn() + Send + Sync>>,
    ) -> Self {
        GatewayState {
            running: Mutex::new(None),
            assets,
            terminals: None,
            on_desktop_layout: None,
            on_show_screen: None,
            on_sessions_changed,
        }
    }

    /// Tell the window when a token client changes the shared Screens.
    pub fn with_desktop_layout_listener(mut self, f: Arc<dyn Fn(&str) + Send + Sync>) -> Self {
        self.on_desktop_layout = Some(f);
        self
    }

    /// Let clients ask the window to show a Screen.
    pub fn with_show_screen_listener(mut self, f: Arc<dyn Fn(&str) + Send + Sync>) -> Self {
        self.on_show_screen = Some(f);
        self
    }

    /// Offer this host's shells to web clients (still behind the user's switch).
    pub fn with_terminals(mut self, terminals: Arc<dyn Terminals>) -> Self {
        self.terminals = Some(terminals);
        self
    }
}

impl Default for GatewayState {
    fn default() -> Self {
        GatewayState::new(Arc::new(NoAssets), None)
    }
}

#[derive(Clone)]
struct Ctx {
    env: Env,
    shared: Arc<Shared>,
    assets: Arc<dyn Assets>,
    terminals: Option<Arc<dyn Terminals>>,
    on_desktop_layout: Option<Arc<dyn Fn(&str) + Send + Sync>>,
    on_show_screen: Option<Arc<dyn Fn(&str) + Send + Sync>>,
    on_sessions_changed: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl Ctx {
    fn sessions_changed(&self) {
        if let Some(f) = &self.on_sessions_changed {
            f();
        }
    }

    fn token(&self) -> String {
        self.shared.token.lock().unwrap().clone()
    }
    fn read_only(&self) -> bool {
        self.shared.read_only.load(Ordering::Relaxed)
    }
    /// The shells, if this client may use them right now: a host that has
    /// them, the user's switch on, and a full-access token.
    fn terminals(&self) -> Option<&Arc<dyn Terminals>> {
        let allowed = self.shared.terminal.load(Ordering::Relaxed) && !self.read_only();
        self.terminals.as_ref().filter(|_| allowed)
    }
}

/// Kill every shell a web client opened. Called whenever the access that let
/// it be opened goes away — gateway stopped, switch off, read-only, token
/// rotated — so a revoked client leaves nothing running behind it.
fn close_remote_terminals(shared: &Shared, terminals: Option<&Arc<dyn Terminals>>) {
    let ids: Vec<String> = shared.remote_terminals.lock().unwrap().drain().collect();
    if let Some(t) = terminals {
        for id in ids {
            let _ = t.close(&id);
        }
    }
}

// ---- lifecycle --------------------------------------------------------------

/// `requested` is an explicit port the caller must have (`osd server --port`):
/// if it is taken, that is an error, because falling back to another port would
/// leave every script pointed somewhere nothing is listening. With no explicit
/// port we prefer the well-known one and accept any free port if it is taken.
fn bind_listener(lan: bool, requested: Option<u16>) -> std::io::Result<TcpListener> {
    let host = if lan { "0.0.0.0" } else { "127.0.0.1" };
    match requested {
        Some(port) => TcpListener::bind((host, port)),
        None => match TcpListener::bind((host, PREFERRED_PORT)) {
            Ok(l) => Ok(l),
            Err(_) => TcpListener::bind((host, 0)),
        },
    }
}

pub fn start(env: &Env, state: &GatewayState, p: &Persisted) -> Result<u16, String> {
    start_at(env, state, p, None)
}

/// `start`, with an explicit port the caller insists on. See `bind_listener`.
pub fn start_at(
    env: &Env,
    state: &GatewayState,
    p: &Persisted,
    requested: Option<u16>,
) -> Result<u16, String> {
    // An empty token would make `ct_eq` accept `Authorization: Bearer ` (also
    // empty) — i.e. no auth at all on an off-loopback listener. Callers mint one
    // before enabling; refuse here too rather than trust every caller to.
    if p.token.is_empty() {
        return Err("gateway token is not set".into());
    }
    stop(env, state);
    let listener = bind_listener(p.lan, requested)
        .map_err(|e| match requested {
            Some(port) => format!("port {port} is not available: {e}"),
            None => format!("gateway bind failed: {e}"),
        })?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let stop_flag = Arc::new(AtomicBool::new(false));
    let shared = Arc::new(Shared {
        token: Mutex::new(p.token.clone()),
        read_only: AtomicBool::new(p.mode == "read-only"),
        terminal: AtomicBool::new(p.terminal),
        remote_terminals: Mutex::new(HashSet::new()),
        tickets: Mutex::new(HashMap::new()),
        muxes: Mutex::new(HashMap::new()),
        agent_sends: Mutex::new(HashMap::new()),
    });
    let ctx = Arc::new(Ctx {
        env: env.clone(),
        shared: shared.clone(),
        assets: state.assets.clone(),
        terminals: state.terminals.clone(),
        on_desktop_layout: state.on_desktop_layout.clone(),
        on_show_screen: state.on_show_screen.clone(),
        on_sessions_changed: state.on_sessions_changed.clone(),
    });
    let sf = stop_flag.clone();
    // Detached accept loop. A non-blocking listener + a short poll lets the flag
    // stop us within ~150ms on toggle/rebind (a blocking accept() could not).
    std::thread::spawn(move || loop {
        if sf.load(Ordering::Relaxed) {
            break;
        }
        match listener.accept() {
            Ok((stream, _addr)) => {
                // The listener is non-blocking so this loop can poll the stop
                // flag; accepted sockets INHERIT that mode on macOS/Linux, so
                // force each one back to blocking — otherwise reads/writes hit
                // WouldBlock mid-request (parse fails → 400; a partial write of
                // a large asset → truncated body → ERR_CONTENT_LENGTH_MISMATCH).
                let _ = stream.set_nonblocking(false);
                let ctx = ctx.clone();
                std::thread::spawn(move || handle(stream, ctx));
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(150));
            }
            Err(_) => std::thread::sleep(Duration::from_millis(300)),
        }
    });
    *state.running.lock().unwrap() = Some(Running { port, lan: p.lan, stop: stop_flag, shared });
    // Record where we ended up, so a CLI on this machine can find us — unless
    // the record already names a DIFFERENT gateway that is still answering.
    //
    // Taking the record from a live one failed twice over, observed here with an
    // `osd server` started for a test beside a running desktop app: every CLI on
    // the machine silently reached the temporary server, and when THAT exited it
    // cleared the record it now owned, leaving the app running and impossible to
    // find. Whoever is up and recorded keeps the record; a later server says so
    // and is reached with an explicit --gateway.
    if !record_belongs_to_a_live_other(env, port) {
        let mut persisted = read_persisted(env);
        persisted.port = Some(port);
        let _ = write_persisted(env, &persisted);
    }
    Ok(port)
}

/// Does the recorded port name a gateway other than `ours` that is still
/// listening? A refused connection means the record is stale and free to take.
fn record_belongs_to_a_live_other(env: &Env, ours: u16) -> bool {
    let Some(recorded) = read_persisted(env).port.filter(|p| *p != ours) else {
        return false;
    };
    port_is_answering(recorded)
}

/// Is something listening on this loopback port right now?
pub fn port_is_answering(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(200),
    )
    .is_ok()
}

pub fn stop(env: &Env, state: &GatewayState) {
    let Some(r) = state.running.lock().unwrap().take() else {
        return; // nothing of ours was listening; the record is not ours to touch
    };
    r.stop.store(true, Ordering::Relaxed);
    close_remote_terminals(&r.shared, state.terminals.as_ref());
    // A recorded port that nothing is listening on would send `osd` to a dead
    // address, so clear it — but ONLY if it is still ours. The desktop app and
    // an `osd server` share this file: whichever bound last owns the record, and
    // clearing it blindly on the other one's exit would erase a live gateway's
    // address and leave every CLI on this machine unable to find it.
    let mut persisted = read_persisted(env);
    if persisted.port == Some(r.port) {
        persisted.port = None;
        let _ = write_persisted(env, &persisted);
    }
}

/// Auto-start on app launch if the user left it enabled last time.
pub fn autostart(env: &Env, state: &GatewayState) {
    let p = read_persisted(env);
    if p.enabled && !p.token.is_empty() {
        // Honour the pin here too, so a restart comes back on the port the
        // user's firewall rule names. If that port is taken we stay down and
        // Settings shows the gateway as not running — binding somewhere else
        // unasked would be the worse answer, since every client pointed at the
        // pinned port would reach nothing while the app looked healthy.
        let _ = start_at(env, state, &p, p.preferred_port);
    }
}

/// Stop the accept loop on app exit.
pub fn shutdown(env: &Env, state: &GatewayState) {
    stop(env, state);
}

// ---- request handling -------------------------------------------------------

/// Largest body any request may carry. Everything but an upload is small JSON.
const MAX_BODY: usize = 8 * 1024 * 1024;
/// Largest file the web client may upload into a session folder. The body is
/// held in memory while it is written, so this is a memory bound too; the
/// client checks it first and says so, this is the backstop.
pub const MAX_UPLOAD: usize = 50 * 1024 * 1024;

enum ParseError {
    Bad,
    TooLarge,
}

struct Request {
    method: String,
    path: String,
    query: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn parse(stream: &TcpStream) -> Result<Request, ParseError> {
        Self::parse_inner(stream).unwrap_or(Err(ParseError::Bad))
    }

    fn parse_inner(stream: &TcpStream) -> Option<Result<Request, ParseError>> {
        let mut reader = BufReader::new(stream.try_clone().ok()?);
        let mut line = String::new();
        reader.read_line(&mut line).ok()?;
        let mut parts = line.split_whitespace();
        let method = parts.next()?.to_string();
        let target = parts.next()?.to_string();
        let (path, query) = match target.split_once('?') {
            Some((p, q)) => (p.to_string(), q.to_string()),
            None => (target, String::new()),
        };
        let mut headers = Vec::new();
        let mut content_length = 0usize;
        loop {
            let mut h = String::new();
            if reader.read_line(&mut h).ok()? == 0 {
                break;
            }
            let h = h.trim_end();
            if h.is_empty() {
                break;
            }
            if let Some((k, v)) = h.split_once(':') {
                let k = k.trim().to_lowercase();
                let v = v.trim().to_string();
                if k == "content-length" {
                    content_length = v.parse().unwrap_or(0);
                }
                headers.push((k, v));
            }
        }
        // Guard against an oversized body claim; only an upload may be large.
        let limit = if path == "/v1/fs/upload" { MAX_UPLOAD } else { MAX_BODY };
        if content_length > limit {
            return Some(Err(ParseError::TooLarge));
        }
        let mut body = vec![0u8; content_length];
        if content_length > 0 {
            reader.read_exact(&mut body).ok()?;
        }
        Some(Ok(Request { method, path, query, headers, body }))
    }

    fn header(&self, k: &str) -> Option<&str> {
        self.headers.iter().find(|(hk, _)| hk == k).map(|(_, v)| v.as_str())
    }

    fn query_get(&self, key: &str) -> Option<String> {
        query_get(&self.query, key)
    }
}

fn handle(mut stream: TcpStream, ctx: Arc<Ctx>) {
    let req = match Request::parse(&stream) {
        Ok(r) => r,
        Err(ParseError::Bad) => {
            respond_json(&mut stream, 400, "{\"error\":\"bad request\"}");
            return;
        }
        Err(ParseError::TooLarge) => {
            respond_json(&mut stream, 413, "{\"error\":\"file is too large\"}");
            return;
        }
    };
    let call = audit_call(&req);
    // Who, before handling: signing out ends the very session that names them.
    let actor = call.as_ref().map(|c| match principal(&req, &ctx) {
        Some(Principal::Token) => "admin".to_string(),
        Some(Principal::User { name, .. }) => format!("account:{name}"),
        None if c.action == "login" => format!("account:{}", c.target.clone().unwrap_or_default()),
        None => "anonymous".to_string(),
    });
    LAST_STATUS.with(|s| s.set(0));
    route(&mut stream, &req, &ctx);
    if let (Some(call), Some(actor)) = (call, actor) {
        let status = LAST_STATUS.with(|s| s.get());
        audit_record(&ctx, &req, &stream, call, actor, status);
    }
}

/// A change worth recording: what was done, to what, with what words.
struct AuditCall {
    action: String,
    target: Option<String>,
    detail: Option<String>,
}

/// The audit entry a request makes, or None for one that changes nothing
/// (every GET) or nothing anyone needs to look back on (a resize, a layout save).
/// Covers both doors: the `/v1` API (CLI, scripts) and the OpenCode paths the
/// web client's conversations go through.
fn audit_call(req: &Request) -> Option<AuditCall> {
    if req.method == "GET" {
        return None;
    }
    let body = || serde_json::from_slice::<serde_json::Value>(&req.body).unwrap_or_default();
    let field = |k: &str| body()[k].as_str().map(str::to_string);
    let words = |text: String| Some(crate::audit::clip(&text, 500));
    let parts_text = || {
        body()["parts"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|p| p["type"] == "text")
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n")
    };
    let call = |action: &str, target: Option<String>, detail: Option<String>| {
        Some(AuditCall { action: action.to_string(), target, detail })
    };
    let m = req.method.as_str();
    if let Some(rest) = req.path.strip_prefix("/v1/") {
        let segs: Vec<&str> = rest.trim_matches('/').split('/').collect();
        let id = |i: usize| segs.get(i).map(|s| s.to_string());
        return match (m, segs.as_slice()) {
            ("POST", ["login"]) => call("login", field("name"), None),
            ("POST", ["logout"]) => call("logout", None, None),
            ("POST", ["sessions"]) => call("session.create", field("directory"), field("title")),
            ("DELETE", ["sessions", _]) => call("session.delete", id(1), None),
            ("POST", ["sessions", _, "prompt"]) => call("session.prompt", id(1), words(field("text").unwrap_or_default())),
            ("POST", ["sessions", _, "abort"]) => call("session.abort", id(1), None),
            ("PATCH", ["sessions", _]) => match body()["archived"].as_bool() {
                Some(true) => call("session.archive", id(1), None),
                Some(false) => call("session.unarchive", id(1), None),
                None => call("session.rename", id(1), field("title")),
            },
            ("POST", ["sessions", _, "move"]) => call("session.move", id(1), field("project")),
            ("POST", ["questions", _, what @ ("reply" | "reject")]) => {
                call(&format!("question.{what}"), id(1), words(String::from_utf8_lossy(&req.body).into_owned()))
            }
            ("POST", ["permissions", _, "reply"]) => call("permission.reply", id(1), field("reply")),
            ("POST", ["fs", "upload"]) => {
                call("file.upload", req.query_get("name"), Some(format!("{} bytes", req.body.len())))
            }
            ("POST", ["fs", "discard"]) => call("file.discard", req.query_get("name"), None),
            ("POST", ["projects"]) => call("project.create", field("name"), None),
            ("POST", ["screens"]) => call("screen.new", field("name").filter(|n| !n.is_empty()), Some(format!("{} panes", body()["panes"].as_array().map_or(0, Vec::len)))),
            ("POST", ["screens", _, "panes"]) => call("screen.add", id(1), words(String::from_utf8_lossy(&req.body).into_owned())),
            ("DELETE", ["screens", _]) => call("screen.close", id(1), None),
            // A browser saves its whole layout on every change, which is no news.
            // A script or an agent overwriting it whole is: it can undo what the
            // window just did. (`osd screen` edits it in place instead.)
            ("PUT", ["layout", "desktop"]) if !req.header("user-agent").is_some_and(|ua| ua.contains("Mozilla")) => {
                call("layout.replace", None, None)
            }
            ("POST", ["terminals", _]) => call("terminal.open", id(1), None),
            ("DELETE", ["terminals", _]) => call("terminal.close", id(1), None),
            ("POST", ["terminals", _, "input"]) => call("terminal.input", id(1), field("data")),
            _ => None,
        };
    }
    let segs: Vec<&str> = req.path.trim_matches('/').split('/').collect();
    let id = segs.get(1).map(|s| s.to_string());
    match (m, segs.as_slice()) {
        ("POST", ["session"]) => call("session.create", req.query_get("directory"), field("title")),
        ("DELETE", ["session", _]) => call("session.delete", id, None),
        ("PATCH", ["session", _]) => call("session.rename", id, field("title")),
        ("POST", ["session", _, "prompt_async" | "message"]) => call("session.prompt", id, words(parts_text())),
        ("POST", ["session", _, "command"]) => {
            let line = format!("/{} {}", field("command").unwrap_or_default(), field("arguments").unwrap_or_default());
            call("session.command", id, words(line.trim_end().to_string()))
        }
        ("POST", ["session", _, "shell"]) => call("session.shell", id, words(field("command").unwrap_or_default())),
        ("POST", ["session", _, what @ ("abort" | "revert" | "unrevert" | "summarize" | "fork")]) => {
            call(&format!("session.{what}"), id, None)
        }
        ("POST", ["permission", _, "reply"]) => call("permission.reply", id, field("reply")),
        ("POST", ["question", _, what @ ("reply" | "reject")]) => {
            call(&format!("question.{what}"), id, words(String::from_utf8_lossy(&req.body).into_owned()))
        }
        ("PATCH", ["global", "config"]) => call("config.model", None, field("model")),
        _ => None,
    }
}

/// Keys typed into a web terminal arrive one request each. They are gathered
/// per typist and terminal and recorded as one line when Enter is pressed (or
/// past 2 KB), so the log reads `ls -l⏎`, not seven entries.
static TYPING: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn audit_record(ctx: &Ctx, req: &Request, stream: &TcpStream, mut call: AuditCall, actor: String, status: u16) {
    if call.action == "terminal.input" {
        if status != 200 {
            return;
        }
        let data = call.detail.take().unwrap_or_default();
        // The data dir keeps two gateways in one process (tests) apart.
        let key = format!("{}\0{actor}\0{}", ctx.env.data_dir().display(), call.target.as_deref().unwrap_or(""));
        let mut typing = TYPING.lock().unwrap_or_else(|e| e.into_inner());
        let buf = typing.get_or_insert_with(HashMap::new).entry(key.clone()).or_default();
        buf.push_str(&data);
        if !data.contains(['\r', '\n']) && buf.len() < 2048 {
            return;
        }
        let line = typing.as_mut().and_then(|t| t.remove(&key)).unwrap_or_default();
        call.detail = Some(crate::audit::clip(&crate::audit::typed(&line), 2048));
    }
    if call.action == "login" && status != 200 {
        call.action = "login.failed".into();
    }
    crate::audit::record(
        &ctx.env,
        &crate::audit::Entry {
            time: crate::audit::now(),
            actor,
            ip: stream.peer_addr().ok().map(|a| a.ip().to_string()),
            via: req.header("x-osd-origin-session").filter(|v| !v.is_empty()).map(str::to_string),
            action: call.action,
            target: call.target,
            detail: call.detail,
            status,
        },
    );
}

fn route(stream: &mut TcpStream, req: &Request, ctx: &Ctx) {
    let path = req.path.as_str();

    // Liveness — open (carries no capability).
    if req.method == "GET" && path == "/v1/health" {
        respond_json(stream, 200, "{\"ok\":true,\"service\":\"open-science-gateway\"}");
        return;
    }

    // A ticket stands in for the token on exactly one file (see `issue_ticket`),
    // which is the whole point: it is the only credential allowed to ride in a
    // URL a document can read back. Checked before the token gate.
    if req.method == "GET" && path == "/v1/fs/read" {
        if let Some(id) = req.query_get("ticket") {
            match redeem_ticket(ctx, &id) {
                Some(full) => {
                    // The ticket names a path that was canonicalized INSIDE the
                    // workspace when it was issued. Serve time is a different
                    // moment: an agent run (or anything else) can replace the
                    // file with a symlink pointing outside the workspace, and
                    // File::open follows it — the ticket check runs before the
                    // token gate, so that would hand an unauthenticated client
                    // an arbitrary file (the SSH key, auth.json, …). Re-verify
                    // containment and reject symlinks here, at redemption.
                    match redeem_verify(ctx, &full) {
                        Ok(verified) => send_file(stream, &verified),
                        Err(_) => respond_json(stream, 403, "{\"error\":\"file changed\"}"),
                    }
                }
                None => respond_json(stream, 403, "{\"error\":\"ticket expired\"}"),
            }
            return;
        }
    }

    // Signing in is how a web account gets its credential, so it is the one
    // write that comes before the gate.
    if req.method == "POST" && path == "/v1/login" {
        return login_route(stream, req, ctx);
    }

    // ---- /v1 contract API (CLI / curl / the SPA's file browser) ----
    if let Some(rest) = path.strip_prefix("/v1/") {
        let Some(who) = principal(req, ctx) else {
            respond_json(stream, 401, "{\"error\":\"unauthorized\"}");
            return;
        };
        // Read-only stops changes to the workspace, not an account keeping
        // its own Screens or signing itself out.
        // Following a stream changes nothing either, so a read-only token may.
        let own_state = (req.method == "PUT" && rest == "me/layout")
            || (req.method == "POST" && (rest == "logout" || rest.starts_with("mux/")));
        if ctx.read_only() && req.method != "GET" && !own_state {
            respond_json(stream, 403, "{\"error\":\"token is read-only\"}");
            return;
        }
        if agent_send_limited(req, ctx, rest) {
            let error = format!(
                "this conversation has sent {AGENT_SEND_LIMIT} messages to other sessions or terminals in the last \
                 {} minutes — stop and ask the user before sending more (a guard against agents messaging each other \
                 without end)",
                AGENT_SEND_WINDOW.as_secs() / 60
            );
            return respond_json(stream, 429, &serde_json::json!({ "error": error }).to_string());
        }
        v1(stream, req, ctx, rest, &who);
        return;
    }

    // ---- the real desktop SPA (served straight from the app's embedded assets,
    //      so remote clients get the identical UI, not a re-implementation) ----
    if req.method == "GET" {
        if path == "/" || path == "/index.html" {
            serve_index(stream, ctx);
            return;
        }
        // Static assets are the ONLY GETs served from disk. Crucially, do NOT
        // let the asset resolver's SPA fallback answer OpenCode API paths
        // (/event, /experimental/session, …) with index.html — that would break
        // EventSource (MIME text/html) and every JSON fetch (sessions / runs /
        // notebooks come back as HTML and render blank).
        if looks_static(path) {
            if !serve_asset(stream, ctx, path) {
                respond_json(stream, 404, "{\"error\":\"not found\"}");
            }
            return;
        }
        // Extensionless GET on a known client-side route → the SPA shell.
        let first = path.trim_matches('/').split('/').next().unwrap_or("");
        if SPA_ROOTS.contains(&first) {
            serve_index(stream, ctx);
            return;
        }
        // Anything else GET is an OpenCode API path → proxied below.
    }

    // ---- transparent OpenCode proxy (the SPA's OpenCodeClient talks here) ----
    if principal(req, ctx).is_none() {
        respond_json(stream, 401, "{\"error\":\"unauthorized\"}");
        return;
    }
    if ctx.read_only() && req.method != "GET" {
        respond_json(stream, 403, "{\"error\":\"token is read-only\"}");
        return;
    }
    // Secrets never cross the wire (AGENTS.md). `/auth` is pure OAuth/tokens →
    // always blocked. Config/provider READS are proxied with API keys REDACTED
    // (the model picker needs the model + provider names, not the keys); config
    // WRITES (setting a key/model) stay desktop-only.
    if path.starts_with("/auth") {
        respond_json(stream, 403, "{\"error\":\"managed on the desktop\"}");
        return;
    }
    if is_config_path(path) && req.method != "GET" {
        // Allow the benign default-model write (setDefaultModel PATCHes
        // /global/config with just `{model}`); block anything that could set a
        // key / provider / auth.
        let model_only = path.starts_with("/global/config") && body_only_sets_model(&req.body);
        if !model_only {
            respond_json(stream, 403, "{\"error\":\"provider/model config is managed on the desktop\"}");
            return;
        }
    }
    if req.method == "GET" && path == "/event" {
        let dir = req.query_get("directory").unwrap_or_else(|| ws_dir(ctx));
        events(stream, ctx, &dir);
        return;
    }
    proxy_opencode(stream, req, ctx);
}

/// Is this a message an agent is sending (`X-OSD-Origin-Session`, set by the
/// runtime's origin plugin) past its conversation's allowance? A message is a
/// prompt to a session, or terminal input that presses Enter — typing without
/// it sends nothing. Counts the message when it is let through.
fn agent_send_limited(req: &Request, ctx: &Ctx, rest: &str) -> bool {
    let Some(origin) = req.header("x-osd-origin-session").filter(|o| !o.is_empty()) else {
        return false;
    };
    let segs: Vec<&str> = rest.trim_matches('/').split('/').collect();
    let sends = req.method == "POST"
        && match segs.as_slice() {
            ["sessions", _, "prompt"] => true,
            ["terminals", _, "input"] => json_str_field(&req.body, "data").is_some_and(|d| d.contains('\r') || d.contains('\n')),
            _ => false,
        };
    if !sends {
        return false;
    }
    let now = Instant::now();
    let mut all = ctx.shared.agent_sends.lock().unwrap();
    all.retain(|_, times| times.last().is_some_and(|t| now.duration_since(*t) < AGENT_SEND_WINDOW));
    let times = all.entry(origin.to_string()).or_default();
    times.retain(|t| now.duration_since(*t) < AGENT_SEND_WINDOW);
    if times.len() >= AGENT_SEND_LIMIT {
        return true;
    }
    times.push(now);
    false
}

/// The folder a request is about: `?dir=` (a session's, checked to be inside
/// the workspace), else the host's.
fn req_dir(ctx: &Ctx, req: &Request) -> Result<String, String> {
    match req.query_get("dir").filter(|d| !d.is_empty()) {
        Some(d) => session_dir(ctx, &d),
        None => Ok(ws_dir(ctx)),
    }
}

fn upstream_patch(ctx: &Ctx, path: &str, body: &str) -> UpstreamResult {
    let (base, pw) = endpoint(ctx).ok_or_else(|| "runtime not started".to_string())?;
    shared_client()
        .patch(format!("{base}{path}"))
        .basic_auth("opencode", Some(pw))
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .map_err(|e| e.to_string())
}

/// The app's own namespace in a session's metadata (the web client's META_NS).
const META_NS: &str = "ai4s";

/// `PATCH /v1/sessions/:id {title?, archived?}`.
fn session_patch(stream: &mut TcpStream, req: &Request, ctx: &Ctx, id: &str) {
    let v: serde_json::Value = serde_json::from_slice(&req.body).unwrap_or_default();
    let mut patch = serde_json::Map::new();
    if let Some(title) = v["title"].as_str().map(str::trim).filter(|t| !t.is_empty()) {
        patch.insert("title".into(), serde_json::json!(title));
    }
    if let Some(archived) = v["archived"].as_bool() {
        // PATCH replaces `metadata` whole: start from what is there, so other
        // keys (another client's) survive.
        let current: serde_json::Value = match upstream_get(ctx, &format!("/session/{}", enc(id)), &[]) {
            Ok(r) if r.status().is_success() => r.bytes().ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default(),
            Ok(r) => return respond_json(stream, r.status().as_u16(), &err_json("no such session")),
            Err(e) => return respond_json(stream, 502, &err_json(&e)),
        };
        let mut metadata = current["metadata"].as_object().cloned().unwrap_or_default();
        let mut mine = metadata.get(META_NS).and_then(|m| m.as_object().cloned()).unwrap_or_default();
        if archived {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
            mine.insert("archived".into(), serde_json::json!(now));
        } else {
            mine.remove("archived");
        }
        if mine.is_empty() {
            metadata.remove(META_NS);
        } else {
            metadata.insert(META_NS.into(), serde_json::Value::Object(mine));
        }
        patch.insert("metadata".into(), serde_json::Value::Object(metadata));
    }
    if patch.is_empty() {
        return respond_json(stream, 400, &err_json("nothing to change: give a title or archived"));
    }
    if forward(stream, upstream_patch(ctx, &format!("/session/{}", enc(id)), &serde_json::Value::Object(patch).to_string())) {
        ctx.sessions_changed();
    }
}

/// One layout change at a time, so two `osd screen` calls cannot each read
/// the layout before the other has written it.
static LAYOUT_EDIT: Mutex<()> = Mutex::new(());

/// Change the Screens this caller works in — the desktop window's for the
/// token (which the window shows at once, as it does a token client's change),
/// an account's own for an account — by editing the saved layout in place.
fn edit_layout<T>(ctx: &Ctx, who: &Principal, edit: impl FnOnce(&mut serde_json::Value) -> Result<T, String>) -> Result<T, String> {
    let _one = LAYOUT_EDIT.lock().unwrap_or_else(|e| e.into_inner());
    let saved = match who {
        Principal::Token => crate::web_accounts::read_desktop_layout(&ctx.env).map(|(_, json)| json),
        Principal::User { name, .. } => crate::web_accounts::read_layout(&ctx.env, name),
    };
    let mut layout: serde_json::Value = saved.and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default();
    let out = edit(&mut layout)?;
    let json = layout.to_string();
    match who {
        Principal::Token => {
            crate::web_accounts::write_desktop_layout(&ctx.env, &json)?;
            if let Some(f) = &ctx.on_desktop_layout {
                f(&json);
            }
        }
        Principal::User { name, .. } => crate::web_accounts::write_layout(&ctx.env, name, &json)?,
    }
    Ok(out)
}

/// `{"session": "<id>"}` or `{"terminal": {"cwd": "<dir>"}}` (or `"terminal": true`).
fn pane_of(v: &serde_json::Value) -> Result<crate::screens::Pane, String> {
    if let Some(id) = v["session"].as_str().filter(|s| !s.is_empty()) {
        return Ok(crate::screens::Pane::Session(id.to_string()));
    }
    if !v["terminal"].is_null() {
        let text = |k: &str| v["terminal"][k].as_str().filter(|s| !s.trim().is_empty()).map(str::to_string);
        return Ok(crate::screens::Pane::Terminal { cwd: text("cwd"), command: text("command") });
    }
    Err("a pane is {\"session\": id} or {\"terminal\": {\"cwd\": dir, \"command\": cmd}}".into())
}

/// `POST /v1/screens {name?, directory?, panes: [...]}`: a new Screen, filed
/// under the project `directory` belongs to.
fn screen_new(stream: &mut TcpStream, req: &Request, ctx: &Ctx, who: &Principal) {
    let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap_or_default();
    let panes: Result<Vec<_>, _> = body["panes"].as_array().into_iter().flatten().map(pane_of).collect();
    let panes = match panes {
        Ok(p) => p,
        Err(e) => return respond_json(stream, 400, &err_json(&e)),
    };
    let project = body["directory"]
        .as_str()
        .map(|dir| {
            let projects: Vec<(String, String)> = crate::project::list_projects(&ctx.env)
                .unwrap_or_default()
                .into_iter()
                .map(|p| (p.id, p.path))
                .collect();
            crate::screens::project_for(dir, &projects)
        })
        .unwrap_or_default();
    let name = body["name"].as_str().unwrap_or("");
    match edit_layout(ctx, who, |l| crate::screens::new_screen(l, name, &panes, &project)) {
        Ok((id, panes)) => respond_json(stream, 200, &serde_json::json!({ "id": id, "panes": panes }).to_string()),
        Err(e) => respond_json(stream, 400, &err_json(&e)),
    }
}

/// The versioned contract surface (CLI / curl / the SPA's file browser).
/// `rest` is the path after `/v1/`.
fn v1(stream: &mut TcpStream, req: &Request, ctx: &Ctx, rest: &str, who: &Principal) {
    let segs: Vec<&str> = rest.trim_matches('/').split('/').collect();
    match (req.method.as_str(), segs.as_slice()) {
        ("GET", ["whoami"]) => {
            let mode = if ctx.read_only() { "read-only" } else { "full" };
            let user = match who {
                Principal::User { name, .. } => Some(name.as_str()),
                Principal::Token => None,
            };
            let payload = serde_json::json!({
                "mode": mode,
                "directory": ws_dir(ctx),
                // The base folder, so a client can name a session's files the
                // way the Files tree does (base-relative), e.g. for links.
                "base": crate::runtime::base_workspace_dir(&ctx.env).ok().map(|p| p.to_string_lossy().into_owned()),
                "terminal": ctx.terminals().is_some(),
                "user": user,
            });
            respond_json(stream, 200, &payload.to_string());
        }
        ("GET", ["sessions"]) => {
            forward(stream, upstream_get(ctx, "/experimental/session", &[]));
        }
        // `directory` names the folder the session belongs to — a project's
        // workspace, typically. Without it a client could only ever create in
        // whatever folder the host happens to be on, which is no basis for
        // scripting anything (and is the same root cause as #81).
        ("POST", ["sessions"]) => {
            let dir = match json_str_field(&req.body, "directory") {
                Some(d) if !d.trim().is_empty() => match session_dir(ctx, d.trim()) {
                    Ok(d) => d,
                    Err(e) => return respond_json(stream, 400, &err_json(&e)),
                },
                _ => ws_dir(ctx),
            };
            let body = match json_str_field(&req.body, "title") {
                Some(t) if !t.trim().is_empty() => {
                    serde_json::json!({ "title": t.trim() }).to_string()
                }
                _ => "{}".to_string(),
            };
            if forward(stream, upstream_post(ctx, "/session", &[("directory", &dir)], &body)) {
                ctx.sessions_changed();
            }
        }
        ("DELETE", ["sessions", id]) => {
            if forward(stream, upstream_delete(ctx, &format!("/session/{}", enc(id)))) {
                ctx.sessions_changed();
            }
        }
        ("GET", ["sessions", id, "messages"]) => {
            forward(stream, upstream_get(ctx, &format!("/session/{}/message", enc(id)), &[]));
        }
        // `model` ("provider/model") and `agent` are what make a scripted run
        // reproducible: without them the turn silently inherits whatever the
        // session was created with, which a script cannot see or state.
        ("POST", ["sessions", id, "prompt"]) => {
            let text = json_str_field(&req.body, "text").unwrap_or_default();
            if text.trim().is_empty() {
                respond_json(stream, 400, "{\"error\":\"missing text\"}");
                return;
            }
            let mut body = serde_json::json!({ "parts": [{ "type": "text", "text": text }] });
            let map = body.as_object_mut().expect("object literal");
            if let Some(agent) = json_str_field(&req.body, "agent").filter(|a| !a.is_empty()) {
                map.insert("agent".into(), serde_json::Value::String(agent));
            }
            if let Some(model) = json_str_field(&req.body, "model").filter(|m| !m.is_empty()) {
                match split_model(&model) {
                    Some(m) => {
                        map.insert("model".into(), m);
                    }
                    None => {
                        return respond_json(
                            stream,
                            400,
                            &err_json("model must be written provider/model, e.g. anthropic/claude-sonnet-4-5"),
                        )
                    }
                }
            }
            if let Some(variant) = json_str_field(&req.body, "variant").filter(|v| !v.is_empty()) {
                map.insert("variant".into(), serde_json::Value::String(variant));
            }
            forward(
                stream,
                upstream_post(ctx, &format!("/session/{}/prompt_async", enc(id)), &[], &body.to_string()),
            );
        }
        // Whether a turn is still running. `prompt` returns as soon as the turn
        // is ACCEPTED, so without this there is nothing for a script to wait on.
        ("GET", ["sessions", id, "status"]) => session_status(stream, ctx, id),
        ("POST", ["sessions", id, "abort"]) => {
            forward(stream, upstream_post(ctx, &format!("/session/{}/abort", enc(id)), &[], "{}"));
        }
        // Permission requests and questions belong to a folder's runtime
        // instance: `?dir=` names a session's folder, else the host's.
        ("GET", ["permissions"]) => match req_dir(ctx, req) {
            Ok(dir) => {
                forward(stream, upstream_get(ctx, "/permission", &[("directory", &dir)]));
            }
            Err(e) => respond_json(stream, 400, &err_json(&e)),
        },
        ("GET", ["questions"]) => match req_dir(ctx, req) {
            Ok(dir) => {
                forward(stream, upstream_get(ctx, "/question", &[("directory", &dir)]));
            }
            Err(e) => respond_json(stream, 400, &err_json(&e)),
        },
        ("POST", ["permissions", rid, "reply"]) => match req_dir(ctx, req) {
            Ok(dir) => {
                let reply = json_str_field(&req.body, "reply").unwrap_or_else(|| "reject".into());
                let body = serde_json::json!({ "reply": reply }).to_string();
                forward(stream, upstream_post(ctx, &format!("/permission/{}/reply", enc(rid)), &[("directory", &dir)], &body));
            }
            Err(e) => respond_json(stream, 400, &err_json(&e)),
        },
        // `{"answers": [[label, …], …]}`, one list per question, or reject to
        // let the agent go on without an answer.
        ("POST", ["questions", rid, what @ ("reply" | "reject")]) => match req_dir(ctx, req) {
            Ok(dir) => {
                let body = if *what == "reply" {
                    let v: serde_json::Value = serde_json::from_slice(&req.body).unwrap_or_default();
                    serde_json::json!({ "answers": v["answers"] }).to_string()
                } else {
                    "{}".to_string()
                };
                forward(stream, upstream_post(ctx, &format!("/question/{}/{what}", enc(rid)), &[("directory", &dir)], &body));
            }
            Err(e) => respond_json(stream, 400, &err_json(&e)),
        },
        ("GET", ["sessions", "find"]) => {
            let q = req.query_get("q").unwrap_or_default();
            let limit = req.query_get("limit").and_then(|v| v.parse().ok()).unwrap_or(20);
            match crate::runtime::runtime_root(&ctx.env).and_then(|root| crate::session_find::find(&root, &q, limit)) {
                Ok(found) => respond_json(stream, 200, &serde_json::to_string(&found).unwrap_or_else(|_| "[]".into())),
                Err(e) => respond_json(stream, 400, &err_json(&e)),
            }
        }
        // `{"title": …}` renames; `{"archived": true|false}` files it away or
        // back, as the sidebar does (the app's key in the session's metadata).
        ("PATCH", ["sessions", id]) => session_patch(stream, req, ctx, id),
        ("POST", ["sessions", id, "move"]) => {
            let project = json_str_field(&req.body, "project").unwrap_or_default();
            match crate::session_sync::move_session_to_project(&ctx.env, id, &project) {
                Ok(moved) => {
                    ctx.sessions_changed();
                    respond_json(stream, 200, &serde_json::to_string(&moved).unwrap_or_else(|_| "{}".into()));
                }
                Err(e) => respond_json(stream, 400, &err_json(&e)),
            }
        }
        ("GET", ["fs", "list"]) => fs_list(stream, req, ctx),
        ("GET", ["fs", "read"]) => fs_read(stream, req, ctx),
        ("GET", ["fs", "locate"]) => fs_locate(stream, req, ctx),
        ("POST", ["fs", "upload"]) => fs_upload(stream, req, ctx),
        ("POST", ["fs", "discard"]) => fs_discard(stream, req, ctx),
        // Trade the token for a short-lived, single-file read capability the
        // client can safely put in an <iframe>/<img> src. A GET (not a POST) so
        // a read-only token can still preview files.
        ("GET", ["fs", "ticket"]) => match fs_resolve(ctx, req) {
            Ok(full) => {
                let payload = serde_json::json!({ "ticket": issue_ticket(ctx, full) });
                respond_json(stream, 200, &payload.to_string());
            }
            Err(e) => respond_json(stream, 404, &err_json(&e)),
        },
        // Read-only projects + runs (local state the sidecar doesn't own) so the
        // web client can see existing projects and run history.
        ("GET", ["projects"]) => match crate::project::list_projects(&ctx.env) {
            Ok(list) => respond_json(stream, 200, &serde_json::to_string(&list).unwrap_or_else(|_| "[]".into())),
            Err(e) => respond_json(stream, 500, &err_json(&e)),
        },
        // Creating a project is a folder + metadata + the agent harness — no
        // window needed, and a CLI that can create sessions but not the project
        // to put them in is only half a tool.
        ("POST", ["projects"]) => {
            let name = json_str_field(&req.body, "name").unwrap_or_default();
            if name.trim().is_empty() {
                return respond_json(stream, 400, &err_json("missing name"));
            }
            match crate::project::create_project(&ctx.env, name.trim()) {
                Ok(info) => respond_json(
                    stream,
                    200,
                    &serde_json::to_string(&info).unwrap_or_else(|_| "{}".into()),
                ),
                Err(e) => respond_json(stream, 400, &err_json(&e)),
            }
        }
        ("GET", ["runs"]) => match crate::runs::list_runs(&ctx.env) {
            Ok(list) => respond_json(stream, 200, &serde_json::to_string(&list).unwrap_or_else(|_| "[]".into())),
            Err(e) => respond_json(stream, 500, &err_json(&e)),
        },
        ("POST", ["runs"]) => record_run(stream, req, ctx),
        ("GET", ["runs", "query"]) => {
            let q = req.query_get("q").unwrap_or_else(|| "{}".into());
            match serde_json::from_str::<crate::runs_index::RunQuery>(&q) {
                Ok(query) => match crate::runs_index::query_runs_cmd(&ctx.env, query) {
                    Ok(page) => respond_json(stream, 200, &serde_json::to_string(&page).unwrap_or_else(|_| "{}".into())),
                    Err(e) => respond_json(stream, 500, &err_json(&e)),
                },
                Err(e) => respond_json(stream, 400, &err_json(&format!("bad query: {e}"))),
            }
        }
        ("GET", ["runs", "log"]) => {
            let hash = req.query_get("hash").unwrap_or_default();
            match crate::runs::read_run_log(&ctx.env, &hash) {
                Ok(text) => respond(stream, 200, "text/plain; charset=utf-8", text.as_bytes()),
                Err(e) => respond_json(stream, 404, &err_json(&e)),
            }
        }
        ("POST", ["provenance"]) => record_provenance(stream, req, ctx),
        // History lives in the folder the file is in: scoped like file reads,
        // so a web client viewing another session's folder passes its `dir`.
        ("GET", ["provenance"]) => {
            let path = req.query_get("path").unwrap_or_default();
            match fs_base(ctx, req).and_then(|root| crate::provenance::versions_for(&root, &path)) {
                Ok(list) => respond_json(stream, 200, &serde_json::to_string(&list).unwrap_or_else(|_| "[]".into())),
                Err(e) => respond_json(stream, 400, &err_json(&e)),
            }
        }
        ("GET", ["provenance", "lockfile"]) => {
            let hash = req.query_get("hash").unwrap_or_default();
            match fs_base(ctx, req).and_then(|root| crate::provenance::read_lockfile(&root, &hash)) {
                Ok(text) => respond(stream, 200, "text/plain; charset=utf-8", text.as_bytes()),
                Err(e) => respond_json(stream, 404, &err_json(&e)),
            }
        }
        // Which models OpenCode Zen still serves. The browser cannot ask
        // opencode.ai itself (no CORS headers), so the web client asks us and
        // gets the identical list the desktop picker filters by. Carries no
        // credentials in either direction.
        (_, ["terminals", id, ..]) => terminal_route(stream, req, ctx, id, &segs[2..], who),
        ("GET", ["mux"]) => mux_open(stream, ctx),
        ("POST", ["mux", id]) => mux_change(stream, req, ctx, id, who),
        ("POST", ["logout"]) => match who {
            Principal::User { session, .. } => match crate::web_accounts::logout(&ctx.env, session) {
                Ok(()) => respond_json(stream, 200, "{\"ok\":true}"),
                Err(e) => respond_json(stream, 500, &err_json(&e)),
            },
            Principal::Token => respond_json(stream, 400, "{\"error\":\"not signed in with an account\"}"),
        },
        ("GET", ["me", "layout"]) => match who {
            Principal::User { name, .. } => match crate::web_accounts::read_layout(&ctx.env, name) {
                Some(json) => respond_json(stream, 200, &json),
                None => respond_json(stream, 200, "null"),
            },
            Principal::Token => respond_json(stream, 400, "{\"error\":\"not signed in with an account\"}"),
        },
        ("PUT", ["me", "layout"]) => match who {
            Principal::User { name, .. } => {
                let body = String::from_utf8_lossy(&req.body);
                match crate::web_accounts::write_layout(&ctx.env, name, &body) {
                    Ok(()) => respond_json(stream, 200, "{\"ok\":true}"),
                    Err(e) => respond_json(stream, 400, &err_json(&e)),
                }
            }
            Principal::Token => respond_json(stream, 400, "{\"error\":\"not signed in with an account\"}"),
        },
        // The desktop window's Screens, which a token client mirrors (polling
        // with `since`, answered 204 while nothing changed). An account has its
        // own Screens and no view of the window's.
        ("GET", ["layout", "desktop"]) if matches!(who, Principal::User { .. }) => {
            respond_json(stream, 403, "{\"error\":\"an account keeps its own layout\"}")
        }
        ("GET", ["layout", "desktop"]) => match crate::web_accounts::read_desktop_layout(&ctx.env) {
            Some((rev, _)) if req.query_get("since").and_then(|v| v.parse::<u64>().ok()) == Some(rev) => {
                respond(stream, 204, "application/json", b"")
            }
            Some((rev, json)) => respond_json(stream, 200, &format!("{{\"rev\":{rev},\"layout\":{json}}}")),
            None => respond_json(stream, 200, "{\"rev\":0,\"layout\":null}"),
        },
        // Only the token shares the window's Screens; an account has its own.
        ("PUT", ["layout", "desktop"]) => match who {
            Principal::Token => {
                let body = String::from_utf8_lossy(&req.body);
                match crate::web_accounts::write_desktop_layout(&ctx.env, &body) {
                    Ok(rev) => {
                        if let Some(f) = &ctx.on_desktop_layout {
                            f(&body);
                        }
                        respond_json(stream, 200, &format!("{{\"rev\":{rev}}}"))
                    }
                    Err(e) => respond_json(stream, 400, &err_json(&e)),
                }
            }
            Principal::User { .. } => respond_json(stream, 403, "{\"error\":\"an account keeps its own layout\"}"),
        },
        // Who did what — for the desktop's owner only: an account reading
        // everyone's messages and keystrokes would undo the point of it.
        ("GET", ["audit"]) => match who {
            Principal::Token => {
                let filter = crate::audit::Filter {
                    actor: req.query_get("actor"),
                    target: req.query_get("target"),
                    action: req.query_get("action"),
                    since: req.query_get("since"),
                    until: req.query_get("until"),
                    limit: req.query_get("limit").and_then(|v| v.parse().ok()),
                };
                match crate::audit::query(&ctx.env, &filter) {
                    Ok(list) => respond_json(stream, 200, &serde_json::to_string(&list).unwrap_or_else(|_| "[]".into())),
                    Err(e) => respond_json(stream, 500, &err_json(&e)),
                }
            }
            Principal::User { .. } => respond_json(stream, 403, "{\"error\":\"the audit log is for the desktop's owner\"}"),
        },
        ("POST", ["screens"]) => screen_new(stream, req, ctx, who),
        ("POST", ["screens", id, "panes"]) => {
            let pane = match pane_of(&serde_json::from_slice(&req.body).unwrap_or_default()) {
                Ok(p) => p,
                Err(e) => return respond_json(stream, 400, &err_json(&e)),
            };
            match edit_layout(ctx, who, |l| crate::screens::add_pane(l, id, &pane)) {
                Ok(pane) => respond_json(stream, 200, &serde_json::json!({ "pane": pane }).to_string()),
                Err(e) => respond_json(stream, 404, &err_json(&e)),
            }
        }
        // The desktop window's view only: a browser shows what its user picks.
        ("POST", ["screens", id, "show"]) => match (who, &ctx.on_show_screen) {
            (Principal::User { .. }, _) => respond_json(stream, 403, &err_json("an account's Screens are shown by its own browser")),
            (_, None) => respond_json(stream, 409, &err_json("no desktop window to show it in")),
            (_, Some(show)) => {
                let known = crate::web_accounts::read_desktop_layout(&ctx.env)
                    .and_then(|(_, j)| serde_json::from_str::<serde_json::Value>(&j).ok())
                    .is_some_and(|l| l["groups"].as_array().is_some_and(|g| g.iter().any(|g| g["id"] == *id)));
                if known {
                    show(id);
                    respond_json(stream, 200, "{\"ok\":true}");
                } else {
                    respond_json(stream, 404, &err_json(&format!("no Screen {id}")));
                }
            }
        },
        ("DELETE", ["screens", id]) => match edit_layout(ctx, who, |l| crate::screens::close_screen(l, id)) {
            Ok(()) => respond_json(stream, 200, "{\"ok\":true}"),
            Err(e) => respond_json(stream, 404, &err_json(&e)),
        },
        ("GET", ["zen-models"]) => match crate::model_probe::fetch_zen_models() {
            Ok(ids) => {
                let payload = serde_json::json!({ "models": ids });
                respond_json(stream, 200, &payload.to_string());
            }
            Err(e) => respond_json(stream, 502, &err_json(&e)),
        },
        ("GET", ["events"]) => {
            let dir = ws_dir(ctx);
            events(stream, ctx, &dir);
        }
        _ => respond_json(stream, 404, "{\"error\":\"not found\"}"),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunRecordRequest {
    command: String,
    session_id: String,
    started_at: u64,
    ended_at: u64,
    status: String,
    log: Option<String>,
    surface: Option<String>,
    model: Option<String>,
}

fn parse_run_record_request(body: &[u8]) -> Result<RunRecordRequest, String> {
    let input: RunRecordRequest = serde_json::from_slice(body).map_err(|e| format!("bad run: {e}"))?;
    if input.command.trim().is_empty() || input.session_id.trim().is_empty() {
        return Err("run needs a command and sessionId".into());
    }
    if input.started_at == 0 || input.ended_at < input.started_at {
        return Err("run needs a valid execution window".into());
    }
    if !matches!(input.status.as_str(), "ok" | "failed") {
        return Err("run status must be ok or failed".into());
    }
    if input.surface.as_deref().is_some_and(|s| s != "local") {
        return Err("gateway can only record local runs".into());
    }
    Ok(input)
}

/// Record the same local run/provenance pair as the Tauri bridge. The caller
/// supplies the completed tool event; the sidecar supplies the session folder.
fn record_run(stream: &mut TcpStream, req: &Request, ctx: &Ctx) {
    let input = match parse_run_record_request(&req.body) {
        Ok(v) => v,
        Err(e) => return respond_json(stream, 400, &err_json(&e)),
    };
    let root = match session_root(ctx, &input.session_id) {
        Ok(v) => v,
        Err((status, e)) => return respond_json(stream, status, &err_json(&e)),
    };
    let env = crate::provenance::capture_env(
        &root, ctx.env.version().to_string(), Some(&input.command), None,
    );
    // record_run_inner serializes itself (and provenance.jsonl) process-wide.
    match crate::runs::record_run_inner(
        &root, &input.command, input.log.as_deref(),
        Some(input.started_at), Some(input.ended_at), &input.status,
        Some("local".into()), Some(input.session_id), input.model, Some(env),
    ) {
        Ok(record) => {
            crate::git_snapshot::commit_best_effort(&root, &format!("Record run {}", record.run_id));
            respond_json(stream, 200, &serde_json::to_string(&record).unwrap_or_default())
        }
        Err(e) => respond_json(stream, 500, &err_json(&e)),
    }
}

/// The folder a session works in, as the sidecar reports it, validated like a
/// caller-supplied session directory. Err carries the HTTP status to answer.
fn session_root(ctx: &Ctx, session_id: &str) -> Result<PathBuf, (u16, String)> {
    let response = match upstream_get(ctx, &format!("/session/{}", enc(session_id)), &[]) {
        Ok(r) if r.status().is_success() => r,
        _ => return Err((404, "session not found".into())),
    };
    let session: serde_json::Value = response
        .bytes()
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .ok_or((502, "invalid session reply".to_string()))?;
    let dir = session
        .get("directory")
        .and_then(|v| v.as_str())
        .ok_or((502, "session has no directory".to_string()))?;
    session_dir(ctx, dir).map(PathBuf::from).map_err(|e| (403, e))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProvenanceRecordRequest {
    path: String,
    tool: String,
    session_id: String,
    model: Option<String>,
    content: Option<String>,
    diff: Option<String>,
    log: Option<String>,
    call_id: Option<String>,
}

fn parse_provenance_request(body: &[u8]) -> Result<ProvenanceRecordRequest, String> {
    let input: ProvenanceRecordRequest =
        serde_json::from_slice(body).map_err(|e| format!("bad provenance: {e}"))?;
    if input.path.trim().is_empty() || input.tool.trim().is_empty() || input.session_id.trim().is_empty() {
        return Err("provenance needs a path, tool and sessionId".into());
    }
    Ok(input)
}

/// Record an authored write (the agent's write/edit tool) — the web twin of the
/// desktop's `record_provenance`, stored in the session's own folder.
fn record_provenance(stream: &mut TcpStream, req: &Request, ctx: &Ctx) {
    let input = match parse_provenance_request(&req.body) {
        Ok(v) => v,
        Err(e) => return respond_json(stream, 400, &err_json(&e)),
    };
    let root = match session_root(ctx, &input.session_id) {
        Ok(v) => v,
        Err((status, e)) => return respond_json(stream, status, &err_json(&e)),
    };
    // An authored write, not a run — no command interpreter to introspect.
    let env = crate::provenance::capture_env(&root, ctx.env.version().to_string(), None, None);
    match crate::provenance::append_record(
        &root, &input.path, &input.tool, Some(input.session_id), input.model,
        input.content, input.diff, input.log, Some(env), None, input.call_id,
    ) {
        Ok(record) => {
            crate::git_snapshot::commit_best_effort(&root, &format!("Record {}", record.path));
            respond_json(stream, 200, &serde_json::to_string(&record).unwrap_or_default())
        }
        // Mostly a path outside the session folder — the caller's input.
        Err(e) => respond_json(stream, 400, &err_json(&e)),
    }
}

/// Split "provider/model" into the `{providerID, modelID}` OpenCode expects.
/// None when there is no separator, or either half is empty — a typo must be
/// reported, never silently dropped into a default model.
fn split_model(model: &str) -> Option<serde_json::Value> {
    let (provider, id) = model.split_once('/')?;
    if provider.is_empty() || id.is_empty() {
        return None;
    }
    Some(serde_json::json!({ "providerID": provider, "modelID": id }))
}

/// Validate a caller-supplied session directory. Same rule as file access: it
/// must sit under the base workspace, be the active workspace, or BE a
/// registered project's own folder (an in-place import lives outside the base).
/// Anything else is refused —
/// creating a session elsewhere would point the agent at an arbitrary path.
fn session_dir(ctx: &Ctx, dir: &str) -> Result<String, String> {
    let canon = PathBuf::from(dir)
        .canonicalize()
        .map_err(|_| format!("{dir} does not exist"))?;
    if !canon.is_dir() {
        return Err(format!("{dir} is not a folder"));
    }
    let base = crate::runtime::base_workspace_dir(&ctx.env)?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let active = workspace_dir(&ctx.env).ok().and_then(|p| p.canonicalize().ok());
    if canon.starts_with(&base)
        || active.as_ref() == Some(&canon)
        || crate::project::is_registered_project_path(&ctx.env, &canon)
    {
        return Ok(crate::artifact_file::native_path(&canon));
    }
    Err("directory is outside the workspace".into())
}

/// Is this session's last turn still running?
///
/// A turn in flight and a turn whose runtime died mid-stream persist
/// IDENTICALLY — an assistant message with a `created` and no `completed` — so
/// the sidecar's own start time is what separates them: a message written
/// before the current process began cannot be something it is still producing.
/// (Same reasoning as the desktop's `turnStillStreaming`; see PROGRESS
/// 2026-08-15.) A client that gets this wrong waits forever on a dead turn.
fn turn_is_running(last: Option<&serde_json::Value>, runtime_started_at: u64) -> bool {
    last.is_some_and(|info| {
        info.get("role").and_then(|r| r.as_str()) == Some("assistant")
            && info.get("error").is_none_or(|e| e.is_null())
            && info.get("time").and_then(|t| t.get("completed")).is_none()
            && info
                .get("time")
                .and_then(|t| t.get("created"))
                .and_then(|c| c.as_u64())
                .is_some_and(|created| created >= runtime_started_at)
    })
}

fn session_status(stream: &mut TcpStream, ctx: &Ctx, id: &str) {
    let resp = upstream_get(ctx, &format!("/session/{}/message", enc(id)), &[]);
    let body = match resp {
        Ok(r) if r.status().is_success() => r.bytes().map(|b| b.to_vec()).unwrap_or_default(),
        Ok(r) => {
            let status = r.status().as_u16();
            return respond_json(stream, status, &err_json("session not found"));
        }
        Err(e) => return respond_json(stream, 502, &err_json(&format!("upstream: {e}"))),
    };
    let messages: Vec<serde_json::Value> = serde_json::from_slice(&body).unwrap_or_default();
    let last = messages.last().map(|m| m.get("info").unwrap_or(m));
    let started_at = crate::runtime::runtime_started_at(ctx.env.runtime()).unwrap_or(0);
    let working = turn_is_running(last, started_at);
    let payload = serde_json::json!({
        "state": if working { "working" } else { "idle" },
        "messages": messages.len(),
        "lastRole": last.and_then(|i| i.get("role").and_then(|r| r.as_str())),
        "lastError": last.and_then(|i| i.get("error").filter(|e| !e.is_null()).cloned()),
    });
    respond_json(stream, 200, &payload.to_string());
}

/// Serve the SPA shell (`index.html`) with a marker so it boots in web mode.
fn serve_index(stream: &mut TcpStream, ctx: &Ctx) {
    match ctx.assets.get("index.html") {
        Some((bytes, _)) => {
            let html = String::from_utf8_lossy(&bytes);
            let injected = html.replacen("<head>", "<head><script>window.__OS_WEB__=true;</script>", 1);
            respond(stream, 200, "text/html; charset=utf-8", injected.as_bytes());
        }
        None => respond(
            stream,
            503,
            "text/plain; charset=utf-8",
            b"This build carries no web client. The /v1 API is still served here.",
        ),
    }
}

/// Whether a GET path is a static frontend asset (vs an OpenCode API path or a
/// client-side route). Vite emits everything hashed under `/assets/`; a few root
/// files carry a known extension. OpenCode paths and SPA routes are extensionless.
fn looks_static(path: &str) -> bool {
    if path.starts_with("/assets/") {
        return true;
    }
    let last = path.rsplit('/').next().unwrap_or("");
    match last.rsplit_once('.') {
        Some((_, ext)) => matches!(
            ext,
            "js" | "mjs" | "css" | "map" | "svg" | "png" | "jpg" | "jpeg" | "gif" | "webp"
                | "ico" | "woff" | "woff2" | "ttf" | "otf" | "json" | "wasm" | "txt" | "html"
        ),
        None => false,
    }
}

/// Serve a bundled static asset (JS/CSS/fonts/images). Returns false if there is
/// no such asset (the caller then decides: SPA route vs OpenCode proxy).
fn serve_asset(stream: &mut TcpStream, ctx: &Ctx, path: &str) -> bool {
    let key = path.trim_start_matches('/');
    match ctx.assets.get(key) {
        Some((bytes, mime)) => {
            respond(stream, 200, &mime, &bytes);
            true
        }
        None => false,
    }
}

/// Transparently proxy any other OpenCode HTTP call to the loopback sidecar,
/// swapping the gateway token for the sidecar's own Basic-auth password.
fn proxy_opencode(stream: &mut TcpStream, req: &Request, ctx: &Ctx) {
    let (base, pw) = match endpoint(ctx) {
        Some(v) => v,
        None => return respond_json(stream, 503, "{\"error\":\"runtime not started\"}"),
    };
    let target = if req.query.is_empty() {
        format!("{base}{}", req.path)
    } else {
        format!("{base}{}?{}", req.path, req.query)
    };
    let method = match reqwest::Method::from_bytes(req.method.as_bytes()) {
        Ok(m) => m,
        Err(_) => return respond_json(stream, 400, "{\"error\":\"bad method\"}"),
    };
    let mut rb = shared_client().request(method, target).basic_auth("opencode", Some(pw));
    if !req.body.is_empty() {
        let ct = req.header("content-type").unwrap_or("application/json").to_string();
        rb = rb.header("Content-Type", ct).body(req.body.clone());
    }
    // Config/provider responses (reads AND the allowed model write): strip any
    // API keys from the JSON before it leaves the machine.
    if is_config_path(&req.path) {
        match rb.send() {
            Ok(r) => {
                let status = r.status().as_u16();
                let body = r.bytes().map(|b| b.to_vec()).unwrap_or_default();
                respond(stream, status, "application/json; charset=utf-8", &redact_config(&body));
            }
            Err(e) => respond_json(stream, 502, &err_json(&format!("upstream: {e}"))),
        }
        return;
    }
    forward(stream, rb.send().map_err(|e| e.to_string()));
}

/// Config / provider endpoints — carry API keys, so reads are redacted and
/// writes are blocked (see route()).
fn is_config_path(path: &str) -> bool {
    path.starts_with("/global/config") || path.starts_with("/config") || path.starts_with("/provider")
}

/// True only for a JSON object body whose sole key is `model` — the one config
/// write allowed over the wire (default-model selection; carries no secret).
fn body_only_sets_model(body: &[u8]) -> bool {
    match serde_json::from_slice::<serde_json::Value>(body) {
        Ok(serde_json::Value::Object(map)) => !map.is_empty() && map.keys().all(|k| k == "model"),
        _ => false,
    }
}

/// Recursively blank out any secret-looking field (apiKey, token, secret,
/// password, authorization, credential) — case/underscore-insensitive.
fn redact_secrets(v: &mut serde_json::Value) {
    match v {
        serde_json::Value::Object(map) => {
            for (k, val) in map.iter_mut() {
                let norm: String = k.chars().filter(|c| c.is_alphanumeric()).map(|c| c.to_ascii_lowercase()).collect();
                if ["apikey", "secret", "token", "password", "authorization", "credential"]
                    .iter()
                    .any(|p| norm.contains(p))
                {
                    *val = serde_json::Value::String("__redacted__".into());
                } else {
                    redact_secrets(val);
                }
            }
        }
        serde_json::Value::Array(a) => a.iter_mut().for_each(redact_secrets),
        _ => {}
    }
}

fn redact_config(body: &[u8]) -> Vec<u8> {
    match serde_json::from_slice::<serde_json::Value>(body) {
        Ok(mut v) => {
            redact_secrets(&mut v);
            serde_json::to_vec(&v).unwrap_or_else(|_| b"{}".to_vec())
        }
        // Never forward an unparseable body — it could still contain a key.
        Err(_) => b"{}".to_vec(),
    }
}

// ---- workspace file routes (reuse artifact_file, sandboxed) -----------------

/// Resolve which directory a file request is scoped to. A web client viewing a
/// session that is NOT the host's active one passes that session's absolute
/// `dir` (from its SessionMeta); we accept it only if it sits under the base
/// workspace, is the host's active one, or is a registered project (so a client
/// can't read arbitrary paths). Otherwise fall back to
/// the `root` scope (workspace = host active, base = the base folder).
fn fs_base(ctx: &Ctx, req: &Request) -> Result<PathBuf, String> {
    if let Some(dir) = req.query_get("dir").filter(|d| !d.is_empty()) {
        let base_root = crate::runtime::base_workspace_dir(&ctx.env)?
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let canon = PathBuf::from(&dir).canonicalize().map_err(|_| "dir not found".to_string())?;
        let active = workspace_dir(&ctx.env).ok().and_then(|p| p.canonicalize().ok());
        if canon.starts_with(&base_root)
            || active.as_ref() == Some(&canon)
            || crate::project::is_registered_project_path(&ctx.env, &canon)
        {
            return Ok(canon);
        }
        return Err("dir is outside the workspace".into());
    }
    let root = req.query_get("root");
    // "home" and "disk" are the desktop's scopes for links the user clicks; a
    // web client stays inside the workspaces.
    match root.as_deref() {
        None | Some("workspace") | Some("base") => scope_root(&ctx.env, root.as_deref()),
        Some(other) => Err(format!("unknown root scope: {other}")),
    }
}

fn fs_list(stream: &mut TcpStream, req: &Request, ctx: &Ctx) {
    let rel = req.query_get("path").unwrap_or_default();
    let base = match fs_base(ctx, req) {
        Ok(b) => b,
        Err(e) => return respond_json(stream, 400, &err_json(&e)),
    };
    match crate::artifact_file::dir_entries(&base, &rel) {
        Ok(entries) => {
            let json = serde_json::to_string(&entries).unwrap_or_else(|_| "[]".into());
            respond_json(stream, 200, &json);
        }
        Err(e) => respond_json(stream, 400, &err_json(&e)),
    }
}

/// The workspace file a `path` (+ `root`/`dir` scope) query names, sandboxed by
/// `fs_base` + `resolve_under`.
fn fs_resolve(ctx: &Ctx, req: &Request) -> Result<PathBuf, String> {
    let rel = req.query_get("path").unwrap_or_default();
    let base = fs_base(ctx, req)?;
    // Resolve by basename like the desktop preview server: agent prose often
    // names a file without its directory ("figure1.png" for "figures/figure1.png").
    let located = locate_under(&base, &rel).unwrap_or(rel);
    resolve_under(&base, &located)
}

/// Where a file an answer mentions really is, or `null`: the desktop's
/// `resolve_artifact` for the web client, so a mention becomes a chip only when
/// there is a file behind it — as on the desktop — instead of a chip whose
/// preview then fails.
fn fs_locate(stream: &mut TcpStream, req: &Request, ctx: &Ctx) {
    let rel = req.query_get("path").unwrap_or_default();
    match fs_base(ctx, req) {
        Ok(base) => {
            let found = locate_under(&base, &rel);
            respond_json(stream, 200, &serde_json::json!({ "path": found }).to_string());
        }
        Err(e) => respond_json(stream, 400, &err_json(&e)),
    }
}

fn fs_read(stream: &mut TcpStream, req: &Request, ctx: &Ctx) {
    match fs_resolve(ctx, req) {
        Ok(full) => send_file(stream, &full),
        Err(e) => respond_json(stream, 404, &err_json(&e)),
    }
}

/// The folder a composer attachment goes to: the session's `dir`, or the
/// host's active workspace. Never the `base` folder — an attachment belongs to
/// one session, like the desktop's copy into its workspace root.
fn attach_dir(ctx: &Ctx, req: &Request) -> Result<PathBuf, String> {
    if req.query_get("root").is_some() {
        return Err("attachments go to a session folder".into());
    }
    fs_base(ctx, req)
}

/// The web composer's paste / drop / "add files": the raw body becomes a file
/// at the root of the session folder, deduplicated, exactly where the desktop
/// copies one. Answers with the name written, which the chip and the prompt use.
fn fs_upload(stream: &mut TcpStream, req: &Request, ctx: &Ctx) {
    let name = req.query_get("name").unwrap_or_default();
    match attach_dir(ctx, req)
        .and_then(|dir| crate::artifact_file::write_new_file(&dir, &name, &req.body))
    {
        Ok(written) => respond_json(stream, 200, &serde_json::json!({ "name": written }).to_string()),
        Err(e) => respond_json(stream, 400, &err_json(&e)),
    }
}

/// Removing an uploaded chip before sending deletes the upload. Root-level
/// names only (see `discard_file_in`), so it can never reach a file that was
/// in the folder before.
fn fs_discard(stream: &mut TcpStream, req: &Request, ctx: &Ctx) {
    let name = req.query_get("name").unwrap_or_default();
    match attach_dir(ctx, req).and_then(|dir| crate::artifact_file::discard_file_in(&dir, &name)) {
        Ok(()) => respond_json(stream, 200, "{\"ok\":true}"),
        Err(e) => respond_json(stream, 400, &err_json(&e)),
    }
}

/// Send a resolved workspace file. HTML gets `CSP: sandbox` so a page the agent
/// wrote lands in an OPAQUE origin however it is loaded — including a tab opened
/// directly on it, which no `<iframe sandbox>` attribute can cover — and so can
/// never read this origin's storage or act as the user. `allow-scripts` keeps
/// interactive reports (plots, widgets) working.
fn send_file(stream: &mut TcpStream, full: &Path) {
    // `resolve_under` accepts any existing path, and `File::open` on a directory
    // SUCCEEDS on Unix — without this the response would be a 200 whose
    // Content-Length nothing can satisfy, cut off mid-body.
    if !full.is_file() {
        return respond_json(stream, 404, "{\"error\":\"not a file\"}");
    }
    let ext = full.extension().and_then(|s| s.to_str()).unwrap_or("");
    let (mime, _is_text) = mime_for(ext);
    let extra = if mime == "text/html" {
        "Content-Security-Policy: sandbox allow-scripts\r\n"
    } else {
        ""
    };
    match std::fs::File::open(full).and_then(|f| Ok((f.metadata()?.len(), f))) {
        Ok((total, mut file)) => {
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {total}\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\n{extra}Connection: close\r\n\r\n"
            );
            if stream.write_all(head.as_bytes()).is_err() {
                return;
            }
            // Chunked, like preview_server: a multi-GB dataset or video must not
            // be pulled into memory whole just to answer one request.
            let mut buf = vec![0u8; total.clamp(1, 1024 * 1024) as usize];
            let mut left = total;
            while left > 0 {
                let n = left.min(buf.len() as u64) as usize;
                if file.read_exact(&mut buf[..n]).is_err() || stream.write_all(&buf[..n]).is_err() {
                    return;
                }
                left -= n as u64;
            }
            let _ = stream.flush();
        }
        Err(e) => respond_json(stream, 404, &err_json(&e.to_string())),
    }
}

// ---- web accounts -------------------------------------------------------------

#[derive(serde::Deserialize)]
struct LoginBody {
    name: String,
    password: String,
}

fn login_route(stream: &mut TcpStream, req: &Request, ctx: &Ctx) {
    use crate::web_accounts::{login, LoginError};
    let Ok(body) = serde_json::from_slice::<LoginBody>(&req.body) else {
        return respond_json(stream, 400, "{\"error\":\"bad body\"}");
    };
    match login(&ctx.env, &body.name, &body.password) {
        Ok((token, expires, user)) => respond_json(
            stream,
            200,
            &serde_json::json!({ "token": token, "user": user, "expires": expires }).to_string(),
        ),
        Err(LoginError::Invalid) => respond_json(stream, 401, "{\"error\":\"invalid\"}"),
        Err(LoginError::Locked(left)) => respond_json(
            stream,
            429,
            &serde_json::json!({ "error": "locked", "retryAfter": left.as_secs().max(1) }).to_string(),
        ),
        Err(LoginError::Other(e)) => respond_json(stream, 500, &err_json(&e)),
    }
}

// ---- terminals --------------------------------------------------------------

/// A pane id from the web client: short, and nothing a path or a shell could
/// read as syntax.
fn valid_terminal_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[derive(serde::Deserialize)]
struct TerminalOpen {
    cwd: Option<String>,
    cols: u16,
    rows: u16,
}

#[derive(serde::Deserialize)]
struct TerminalInput {
    data: String,
}

#[derive(serde::Deserialize)]
struct TerminalSize {
    cols: u16,
    rows: u16,
}

/// `/v1/terminals/{id}[/input|/resize|/output]`. The read-only gate has already
/// refused every write; `ctx.terminals()` refuses the rest unless the user
/// turned terminals on.
/// The token is the desktop's own owner and shares its Screens, so it reaches
/// the window's shells and the shells it opens belong to the desktop (they
/// outlive a revoked token, which simply loses access). An account reaches
/// only the shells it opened, and those die with its access.
fn terminal_route(stream: &mut TcpStream, req: &Request, ctx: &Ctx, id: &str, rest: &[&str], who: &Principal) {
    let Some(terminals) = ctx.terminals() else {
        return respond_json(stream, 403, "{\"error\":\"terminals are off on the desktop\"}");
    };
    if !valid_terminal_id(id) {
        return respond_json(stream, 400, "{\"error\":\"bad terminal id\"}");
    }
    let owner = matches!(who, Principal::Token);
    let ours = owner || ctx.shared.remote_terminals.lock().unwrap().contains(id);
    let done = |stream: &mut TcpStream, r: Result<(), String>| match r {
        Ok(()) => respond_json(stream, 200, "{\"ok\":true}"),
        Err(e) => respond_json(stream, 400, &err_json(&e)),
    };
    match (req.method.as_str(), rest) {
        ("POST", []) => {
            let Ok(o) = serde_json::from_slice::<TerminalOpen>(&req.body) else {
                return respond_json(stream, 400, "{\"error\":\"bad body\"}");
            };
            // Only ids this gateway owns, or new ones: an id the desktop window
            // is using must not be adopted from the web.
            if !ours && terminals.subscribe(id).is_some() {
                return respond_json(stream, 409, "{\"error\":\"terminal id in use\"}");
            }
            match terminals.open(id, o.cwd.filter(|d| !d.trim().is_empty()), o.cols, o.rows) {
                Ok(created) => {
                    if !owner {
                        ctx.shared.remote_terminals.lock().unwrap().insert(id.to_string());
                    }
                    respond_json(stream, 200, &format!("{{\"created\":{created}}}"))
                }
                Err(e) => respond_json(stream, 400, &err_json(&e)),
            }
        }
        _ if !ours => respond_json(stream, 404, "{\"error\":\"no such terminal\"}"),
        ("GET", ["read"]) => terminal_read(stream, req, ctx, terminals, id, who),
        ("POST", ["input"]) => match serde_json::from_slice::<TerminalInput>(&req.body) {
            Ok(i) => done(stream, terminals.write(id, &i.data)),
            Err(_) => respond_json(stream, 400, "{\"error\":\"bad body\"}"),
        },
        ("POST", ["resize"]) => match serde_json::from_slice::<TerminalSize>(&req.body) {
            Ok(z) => done(stream, terminals.resize(id, z.cols, z.rows)),
            Err(_) => respond_json(stream, 400, "{\"error\":\"bad body\"}"),
        },
        ("DELETE", []) => {
            ctx.shared.remote_terminals.lock().unwrap().remove(id);
            done(stream, terminals.close(id))
        }
        ("GET", ["output"]) => match terminals.subscribe(id) {
            Some(rx) => terminal_output(stream, ctx, rx),
            None => respond_json(stream, 404, "{\"error\":\"no such terminal\"}"),
        },
        _ => respond_json(stream, 404, "{\"error\":\"not found\"}"),
    }
}

/// The agent a terminal pane runs, from the layout it lives in: the desktop
/// window's, or the account's own. A browser names its own shells
/// `w<browser>-<pane>` (see the web client's `shellOf`), so the pane is the
/// part after the last dash. Only a RUNNING agent counts — one that has exited
/// left a shell behind, and the shell is what is there now.
fn terminal_agent(ctx: &Ctx, id: &str, who: &Principal) -> Option<(String, String, Option<String>)> {
    let pane = if id.starts_with('w') { id.rsplit('-').next().unwrap_or(id) } else { id };
    let layout = match who {
        Principal::User { name, .. } => crate::web_accounts::read_layout(&ctx.env, name)?,
        Principal::Token => crate::web_accounts::read_desktop_layout(&ctx.env)?.1,
    };
    let layout: serde_json::Value = serde_json::from_str(&layout).ok()?;
    fn find<'a>(n: &'a serde_json::Value, pane: &str) -> Option<&'a serde_json::Value> {
        if n["kind"] == "leaf" {
            return (n["id"].as_str() == Some(pane)).then_some(n);
        }
        n["children"].as_array()?.iter().find_map(|c| find(c, pane))
    }
    let leaf = layout["groups"].as_array()?.iter().find_map(|g| find(&g["tree"], pane))?;
    let c = &leaf["content"];
    let agent = &c["agent"];
    if c["kind"] != "terminal" || agent["running"].as_bool() != Some(true) {
        return None;
    }
    Some((
        agent["kind"].as_str()?.to_string(),
        agent["sessionId"].as_str()?.to_string(),
        c["cwd"].as_str().map(str::to_string),
    ))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// `GET /v1/terminals/{id}/read?turns=N&lines=N`: what the terminal is doing,
/// as text. An agent in it is read from its own transcript (the last `turns`
/// turns, and whether one is still open); a plain shell from its recent output
/// (the last `lines` lines).
fn terminal_read(
    stream: &mut TcpStream,
    req: &Request,
    ctx: &Ctx,
    terminals: &Arc<dyn Terminals>,
    id: &str,
    who: &Principal,
) {
    let num = |k: &str, default: usize, max: usize| {
        req.query_get(k).and_then(|v| v.parse::<usize>().ok()).unwrap_or(default).clamp(1, max)
    };
    if let Some((agent, session, cwd)) = terminal_agent(ctx, id, who) {
        if let Some(t) = home_dir().and_then(|h| crate::terminal_read::transcript(&h, &agent, &session, num("turns", 3, 50))) {
            let payload = serde_json::json!({
                "kind": "agent", "agent": t.agent, "session": session, "cwd": cwd,
                "busy": t.busy, "entries": t.entries,
            });
            return respond_json(stream, 200, &payload.to_string());
        }
    }
    let Some(rx) = terminals.subscribe(id) else {
        return respond_json(stream, 404, "{\"error\":\"no such terminal\"}");
    };
    // `subscribe` replays the recent output first: take that, not what follows
    // — and stop within a second even for a shell that never goes quiet.
    let mut raw = String::new();
    let until = Instant::now() + Duration::from_secs(1);
    while let Ok(chunk) = rx.recv_timeout(Duration::from_millis(150)) {
        raw.push_str(&chunk);
        if Instant::now() > until {
            break;
        }
    }
    let (rows, cols) = terminals.size(id).unwrap_or((24, 80));
    let text = crate::terminal_read::screen_text(&raw, num("lines", 40, 1000), rows, cols);
    respond_json(stream, 200, &serde_json::json!({ "kind": "shell", "text": text }).to_string());
}

/// A shell's output as server-sent events: `data:` carries a JSON string per
/// chunk, `event: exit` ends it. Holds this connection's thread until the shell
/// exits, the client goes away, or access is withdrawn.
fn terminal_output(stream: &mut TcpStream, ctx: &Ctx, rx: Receiver<String>) {
    let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
    if stream.write_all(head.as_bytes()).is_err() {
        return;
    }
    let _ = stream.flush();
    loop {
        let frame = match rx.recv_timeout(Duration::from_secs(15)) {
            Ok(chunk) => format!("data: {}\n\n", serde_json::Value::String(chunk)),
            // A comment line: proves the client is still there (a write to a
            // closed socket fails) without putting anything on its screen.
            Err(RecvTimeoutError::Timeout) => ": keepalive\n\n".to_string(),
            Err(RecvTimeoutError::Disconnected) => {
                let _ = stream.write_all(b"event: exit\ndata: null\n\n");
                let _ = stream.flush();
                return;
            }
        };
        if ctx.terminals().is_none() || stream.write_all(frame.as_bytes()).is_err() {
            return;
        }
        let _ = stream.flush();
    }
}

/// Proxy the sidecar's SSE event stream verbatim (workspace-wide). Holds this
/// connection thread until the sidecar closes or the client disconnects.
fn events(stream: &mut TcpStream, ctx: &Ctx, directory: &str) {
    let (base, pw) = match endpoint(ctx) {
        Some(v) => v,
        None => return respond_json(stream, 503, "{\"error\":\"runtime not started\"}"),
    };
    // A dedicated client with NO timeout — an idle event stream must not be cut.
    // Never proxied, like `shared_client`: the sidecar is on loopback.
    let client = match reqwest::blocking::Client::builder().no_proxy().build() {
        Ok(c) => c,
        Err(e) => return respond_json(stream, 502, &err_json(&e.to_string())),
    };
    let resp = client
        .get(format!("{base}{}", with_query("/event", &[("directory", directory)])))
        .basic_auth("opencode", Some(pw))
        .send();
    let mut resp = match resp {
        Ok(r) => r,
        Err(e) => return respond_json(stream, 502, &err_json(&e.to_string())),
    };
    let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
    if stream.write_all(head.as_bytes()).is_err() {
        return;
    }
    let _ = stream.flush();
    let mut buf = [0u8; 4096];
    loop {
        match resp.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if stream.write_all(&buf[..n]).is_err() {
                    break;
                }
                let _ = stream.flush();
            }
            Err(_) => break,
        }
    }
}

// ---- one stream per browser tab ---------------------------------------------
//
// A browser opens at most six connections to one host and port — over plain
// HTTP/1.1, which is what a LAN address gets — shared by every tab. A tab used
// to hold one stream per folder it showed and one per terminal pane, so two
// tabs of a real workbench took all six, and from then on every other request
// from that browser (loading a thread, sending, even opening the page) waited
// forever. Now a tab holds ONE: `GET /v1/mux` streams everything it follows,
// each frame tagged with the tab's own key, and `POST /v1/mux/:id` changes what
// that is.

/// One tab's stream: where its frames go, and a stop switch per subscription.
struct Mux {
    tx: Sender<String>,
    subs: HashMap<String, Arc<AtomicBool>>,
}

#[derive(serde::Deserialize)]
struct MuxChange {
    #[serde(default)]
    add: Vec<MuxSub>,
    #[serde(default)]
    remove: Vec<String>,
}

#[derive(serde::Deserialize)]
struct MuxSub {
    key: String,
    #[serde(flatten)]
    what: MuxWhat,
}

#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum MuxWhat {
    /// The sidecar's events for one folder — what `/event?directory=` streams.
    Events { directory: Option<String> },
    /// A shell's output — what `/v1/terminals/:id/output` streams.
    Terminal { id: String },
}

/// One frame: `{"k": key, <field>: value}`. Fields: `open` (it is flowing),
/// `d` (an event's data, or a chunk of output), `exit` (the shell ended),
/// `gone` (it cannot be, or can no longer be, followed).
fn mux_frame(key: &str, field: &str, value: serde_json::Value) -> String {
    let mut m = serde_json::Map::new();
    m.insert("k".into(), serde_json::Value::String(key.into()));
    m.insert(field.into(), value);
    format!("data: {}\n\n", serde_json::Value::Object(m))
}

/// A tab's key for one of its subscriptions: short, and safe to echo back.
fn valid_mux_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 64 && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// `GET /v1/mux`: the first frame names the stream (`{"mux": id}`), then every
/// subscription's frames follow. Holds this connection until the tab goes;
/// then every subscription stops with it.
fn mux_open(stream: &mut TcpStream, ctx: &Ctx) {
    let id = random_hex(16);
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    ctx.shared.muxes.lock().unwrap().insert(id.clone(), Mux { tx, subs: HashMap::new() });
    let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
    let hello = format!("data: {}\n\n", serde_json::json!({ "mux": id }));
    if stream.write_all(head.as_bytes()).is_ok() && stream.write_all(hello.as_bytes()).is_ok() {
        let _ = stream.flush();
        let mut idle = 0;
        loop {
            let frame = match rx.recv_timeout(Duration::from_secs(1)) {
                Ok(frame) => frame,
                Err(RecvTimeoutError::Timeout) => {
                    // A closed tab is noticed within a second, not at the next
                    // failed write, so its subscriptions let go at once.
                    if peer_closed(stream) {
                        break;
                    }
                    idle += 1;
                    if idle < 15 {
                        continue;
                    }
                    ": keepalive\n\n".to_string()
                }
                Err(RecvTimeoutError::Disconnected) => break,
            };
            idle = 0;
            if stream.write_all(frame.as_bytes()).is_err() {
                break;
            }
            let _ = stream.flush();
        }
    }
    if let Some(mux) = ctx.shared.muxes.lock().unwrap().remove(&id) {
        for stop in mux.subs.values() {
            stop.store(true, Ordering::Relaxed);
        }
    }
}

/// Has the other end of a stream gone? The tab never writes after its
/// request, so a readable end-of-stream means it closed.
fn peer_closed(stream: &TcpStream) -> bool {
    if stream.set_nonblocking(true).is_err() {
        return false;
    }
    let closed = match stream.peek(&mut [0u8; 1]) {
        Ok(0) => true,
        Ok(_) => false,
        Err(e) => e.kind() != std::io::ErrorKind::WouldBlock,
    };
    let _ = stream.set_nonblocking(false);
    closed
}

/// `POST /v1/mux/:id` — `{"add": [{key, kind, …}], "remove": [key]}`. Adding a
/// key that is already there replaces it. A subscription that cannot be
/// followed (a terminal that is not this client's) answers with its own `gone`
/// frame rather than failing the rest.
fn mux_change(stream: &mut TcpStream, req: &Request, ctx: &Ctx, id: &str, who: &Principal) {
    let Ok(change) = serde_json::from_slice::<MuxChange>(&req.body) else {
        return respond_json(stream, 400, "{\"error\":\"bad body\"}");
    };
    if !change.add.iter().map(|s| s.key.as_str()).chain(change.remove.iter().map(String::as_str)).all(valid_mux_key) {
        return respond_json(stream, 400, "{\"error\":\"bad key\"}");
    }
    let mut muxes = ctx.shared.muxes.lock().unwrap();
    let Some(mux) = muxes.get_mut(id) else {
        return respond_json(stream, 404, "{\"error\":\"no such stream\"}");
    };
    for key in &change.remove {
        if let Some(stop) = mux.subs.remove(key) {
            stop.store(true, Ordering::Relaxed);
        }
    }
    for sub in change.add {
        if let Some(old) = mux.subs.remove(&sub.key) {
            old.store(true, Ordering::Relaxed);
        }
        let stop = Arc::new(AtomicBool::new(false));
        mux.subs.insert(sub.key.clone(), stop.clone());
        let (tx, ctx) = (mux.tx.clone(), ctx.clone());
        match sub.what {
            MuxWhat::Events { directory } => {
                let dir = directory.filter(|d| !d.is_empty()).unwrap_or_else(|| ws_dir(&ctx));
                std::thread::spawn(move || mux_events(&ctx, &sub.key, &dir, &tx, &stop));
            }
            MuxWhat::Terminal { id: tid } => {
                // The same rule as `terminal_route`: the token reaches every
                // shell, an account only the ones the gateway opened.
                let ours = matches!(who, Principal::Token)
                    || ctx.shared.remote_terminals.lock().unwrap().contains(&tid);
                let rx = ctx
                    .terminals()
                    .filter(|_| valid_terminal_id(&tid) && ours)
                    .and_then(|t| t.subscribe(&tid));
                match rx {
                    Some(rx) => {
                        std::thread::spawn(move || mux_terminal(&ctx, &sub.key, rx, &tx, &stop));
                    }
                    None => {
                        let _ = tx.send(mux_frame(&sub.key, "gone", serde_json::Value::Bool(true)));
                    }
                }
            }
        }
    }
    respond_json(stream, 200, "{\"ok\":true}");
}

/// Forward one folder's sidecar events into a tab's stream, an event per
/// frame. Stops at the next event after `stop` — the sidecar's heartbeat
/// arrives every ten seconds, so an unfollowed folder lets go soon.
fn mux_events(ctx: &Ctx, key: &str, directory: &str, tx: &Sender<String>, stop: &AtomicBool) {
    let send = |field: &str, v: serde_json::Value| tx.send(mux_frame(key, field, v)).is_ok();
    let gone = || send("gone", serde_json::Value::Bool(true));
    let Some((base, pw)) = endpoint(ctx) else {
        gone();
        return;
    };
    // No timeout and no proxy, as for `events`.
    let Ok(client) = reqwest::blocking::Client::builder().no_proxy().build() else {
        gone();
        return;
    };
    let resp = client
        .get(format!("{base}{}", with_query("/event", &[("directory", directory)])))
        .basic_auth("opencode", Some(pw))
        .send();
    let mut resp = match resp {
        Ok(r) if r.status().is_success() => r,
        _ => {
            gone();
            return;
        }
    };
    if !send("open", serde_json::Value::Bool(true)) {
        return;
    }
    let mut pending: Vec<u8> = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        let n = match resp.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        if stop.load(Ordering::Relaxed) {
            return;
        }
        pending.extend(buf[..n].iter().filter(|b| **b != b'\r'));
        while let Some(end) = pending.windows(2).position(|w| w == b"\n\n") {
            let block: Vec<u8> = pending.drain(..end + 2).collect();
            let text = String::from_utf8_lossy(&block);
            let data: Vec<&str> = text
                .lines()
                .filter_map(|l| l.strip_prefix("data:"))
                .map(|l| l.strip_prefix(' ').unwrap_or(l))
                .collect();
            if !data.is_empty() && !send("d", serde_json::Value::String(data.join("\n"))) {
                return;
            }
        }
    }
    if !stop.load(Ordering::Relaxed) {
        gone();
    }
}

/// Forward a shell's output into a tab's stream, as `terminal_output` does on
/// a connection of its own.
fn mux_terminal(ctx: &Ctx, key: &str, rx: Receiver<String>, tx: &Sender<String>, stop: &AtomicBool) {
    let send = |field: &str, v: serde_json::Value| tx.send(mux_frame(key, field, v)).is_ok();
    if !send("open", serde_json::Value::Bool(true)) {
        return;
    }
    loop {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        match rx.recv_timeout(Duration::from_secs(1)) {
            Ok(chunk) => {
                if !send("d", serde_json::Value::String(chunk)) {
                    return;
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                send("exit", serde_json::Value::Bool(true));
                return;
            }
        }
        // Access withdrawn (switch off, read-only, gateway stopped).
        if ctx.terminals().is_none() {
            send("gone", serde_json::Value::Bool(true));
            return;
        }
    }
}

// ---- upstream proxy helpers -------------------------------------------------

/// The client for the sidecar, which is always on loopback. Never proxied: an
/// app started from a terminal inherits its HTTP(S)_PROXY, and reqwest then
/// sent every sidecar call through it (a Clash answered each one 502, so every
/// `osd` command failed while the window worked).
fn shared_client() -> &'static reqwest::blocking::Client {
    static C: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(120))
            .build()
            .expect("build reqwest client")
    })
}

/// (sidecar base URL, per-run password) or None if the runtime is not up.
fn endpoint(ctx: &Ctx) -> Option<(String, &'static str)> {
    let base = sidecar_url(ctx.env.runtime())?;
    Some((base, server_password()))
}

fn ws_dir(ctx: &Ctx) -> String {
    workspace_dir(&ctx.env).map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
}

/// Append a percent-encoded query string to a path (built by hand so it needs
/// no optional reqwest feature).
fn with_query(path: &str, query: &[(&str, &str)]) -> String {
    if query.is_empty() {
        return path.to_string();
    }
    let mut s = String::from(path);
    s.push('?');
    for (i, (k, v)) in query.iter().enumerate() {
        if i > 0 {
            s.push('&');
        }
        s.push_str(k);
        s.push('=');
        s.push_str(&enc(v));
    }
    s
}

type UpstreamResult = Result<reqwest::blocking::Response, String>;

fn upstream_get(ctx: &Ctx, path: &str, query: &[(&str, &str)]) -> UpstreamResult {
    let (base, pw) = endpoint(ctx).ok_or_else(|| "runtime not started".to_string())?;
    shared_client()
        .get(format!("{base}{}", with_query(path, query)))
        .basic_auth("opencode", Some(pw))
        .send()
        .map_err(|e| e.to_string())
}

fn upstream_post(ctx: &Ctx, path: &str, query: &[(&str, &str)], body: &str) -> UpstreamResult {
    let (base, pw) = endpoint(ctx).ok_or_else(|| "runtime not started".to_string())?;
    shared_client()
        .post(format!("{base}{}", with_query(path, query)))
        .basic_auth("opencode", Some(pw))
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .map_err(|e| e.to_string())
}

fn upstream_delete(ctx: &Ctx, path: &str) -> UpstreamResult {
    let (base, pw) = endpoint(ctx).ok_or_else(|| "runtime not started".to_string())?;
    shared_client()
        .delete(format!("{base}{path}"))
        .basic_auth("opencode", Some(pw))
        .send()
        .map_err(|e| e.to_string())
}

/// Forward an upstream response to the client; returns whether it was 2xx.
fn forward(stream: &mut TcpStream, resp: UpstreamResult) -> bool {
    match resp {
        Ok(r) => {
            let status = r.status().as_u16();
            let ct = r
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/json")
                .to_string();
            let body = r.bytes().map(|b| b.to_vec()).unwrap_or_default();
            respond(stream, status, &ct, &body);
            (200..300).contains(&status)
        }
        Err(e) => {
            respond_json(stream, 502, &err_json(&format!("upstream: {e}")));
            false
        }
    }
}

// ---- auth + HTTP plumbing ---------------------------------------------------

fn authed(req: &Request, token: &str) -> bool {
    if let Some(h) = req.header("authorization") {
        // Bearer <token> — the /v1 contract clients (CLI, file browser).
        if let Some(t) = h.strip_prefix("Bearer ") {
            if ct_eq(t.trim(), token) {
                return true;
            }
        }
        // Basic base64("opencode:<token>") — the SPA's own OpenCodeClient, which
        // speaks OpenCode's Basic auth; we accept the gateway token as its password.
        if let Some(b) = h.strip_prefix("Basic ") {
            if ct_eq(b.trim(), &expected_basic(token)) {
                return true;
            }
        }
    }
    // Header-less clients: ?token= (fetch links), ?auth_token= (OpenCodeClient SSE).
    if let Some(t) = req.query_get("token") {
        if ct_eq(&t, token) {
            return true;
        }
    }
    if let Some(t) = req.query_get("auth_token") {
        if ct_eq(&t, &expected_basic(token)) {
            return true;
        }
    }
    false
}

/// Who a request is: the gateway token, or a signed-in web account (see
/// `web_accounts`). Both carry the same rights; the account also has a layout.
enum Principal {
    Token,
    User { name: String, session: String },
}

fn principal(req: &Request, ctx: &Ctx) -> Option<Principal> {
    if authed(req, &ctx.token()) {
        return Some(Principal::Token);
    }
    // A session token arrives every way the gateway token does, since the SPA
    // simply uses it in the token's place.
    let mut presented: Vec<String> = Vec::new();
    if let Some(h) = req.header("authorization") {
        if let Some(t) = h.strip_prefix("Bearer ") {
            presented.push(t.trim().to_string());
        }
        if let Some(b) = h.strip_prefix("Basic ") {
            presented.extend(basic_password(b.trim()));
        }
    }
    presented.extend(req.query_get("token"));
    presented.extend(req.query_get("auth_token").and_then(|b| basic_password(&b)));
    presented.into_iter().find_map(|session| {
        crate::web_accounts::session_user(&ctx.env, &session).map(|name| Principal::User { name, session })
    })
}

/// The password half of a Basic credential `base64("opencode:<password>")`.
fn basic_password(b64: &str) -> Option<String> {
    let raw = base64_decode(b64)?;
    String::from_utf8(raw).ok()?.strip_prefix("opencode:").map(str::to_string)
}

fn base64_decode(input: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut acc = 0u32;
    let mut bits = 0;
    for c in input.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => return None,
        };
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

/// The `Authorization: Basic` value OpenCodeClient sends when the gateway token
/// is used as its password: base64("opencode:<token>").
fn expected_basic(token: &str) -> String {
    base64_encode(format!("opencode:{token}").as_bytes())
}

fn base64_encode(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        out.push(T[(b0 >> 2) as usize] as char);
        out.push(T[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        out.push(if chunk.len() > 1 { T[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(b2 & 0x3f) as usize] as char } else { '=' });
    }
    out
}

/// Length-independent-ish constant-time compare, so token checks don't leak
/// length or a prefix by timing.
fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "OK",
    }
}

thread_local! {
    /// The status this thread last answered with — one request per connection,
    /// one connection per thread — so `handle` can audit how a change ended
    /// without every handler reporting it.
    static LAST_STATUS: std::cell::Cell<u16> = const { std::cell::Cell::new(0) };
}

fn respond(stream: &mut TcpStream, status: u16, content_type: &str, body: &[u8]) {
    LAST_STATUS.with(|s| s.set(status));
    let head = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        reason(status),
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

fn respond_json(stream: &mut TcpStream, status: u16, json: &str) {
    respond(stream, status, "application/json; charset=utf-8", json.as_bytes());
}

fn err_json(msg: &str) -> String {
    serde_json::json!({ "error": msg }).to_string()
}

fn enc(s: &str) -> String {
    // Percent-encode a single path segment (session/request ids are safe hex-ish
    // strings in practice, but never trust — encode anything non-unreserved).
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn query_get(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == key {
                return Some(percent_decode(v));
            }
        }
    }
    None
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' => {
                let hex = bytes.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok());
                if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    out.push(v);
                    i += 3;
                } else {
                    out.push(b'%');
                    i += 1;
                }
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Pull a top-level string field out of a small JSON body without a full model.
fn json_str_field(body: &[u8], field: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_slice(body).ok()?;
    v.get(field)?.as_str().map(|s| s.to_string())
}

// ---- status + configuration -------------------------------------------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStatus {
    pub enabled: bool,
    pub lan: bool,
    pub mode: String,
    pub running: bool,
    pub port: Option<u16>,
    /// The port the user pinned in Settings, or None for "wherever it lands".
    pub configured_port: Option<u16>,
    pub loopback_url: Option<String>,
    pub lan_url: Option<String>,
    pub token: String,
    pub terminal: bool,
}

/// The LAN IP the machine would use to reach the internet — found without
/// sending a packet (UDP connect just picks the route). None when offline.
fn local_ip() -> Option<String> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("8.8.8.8:80").ok()?;
    s.local_addr().ok().map(|a| a.ip().to_string())
}

pub fn status_of(env: &Env, state: &GatewayState) -> GatewayStatus {
    let p = read_persisted(env);
    let (running, port) = match state.running.lock().unwrap().as_ref() {
        Some(r) => (true, Some(r.port)),
        None => (false, None),
    };
    let loopback_url = port.map(|pt| format!("http://127.0.0.1:{pt}"));
    let lan_url = if p.lan {
        port.and_then(|pt| local_ip().map(|ip| format!("http://{ip}:{pt}")))
    } else {
        None
    };
    GatewayStatus {
        enabled: p.enabled,
        lan: p.lan,
        mode: p.mode,
        running,
        port,
        configured_port: p.preferred_port,
        loopback_url,
        lan_url,
        token: p.token,
        terminal: p.terminal,
    }
}

/// Absolute path of the bundled ACP agent script (#14, server direction), or
/// None when it is missing.
///
/// An external editor integrates with an ACP agent by SPAWNING it — stdio is the
/// only transport the protocol stabilizes — so what Settings has to show the
/// user is a command, and a command needs a real path inside the installed app.
/// The script drives this same gateway with a token, so nothing new is exposed:
/// an editor gets exactly the access the token already carries.
pub fn acp_server_script(env: &Env) -> Option<String> {
    env.resource("acp-server/acp-server.mjs")
        .map(|p| p.to_string_lossy().to_string())
}

/// `port` is the address the user pinned the gateway to, `None` for "wherever
/// it lands" — every caller passes the current value, so an ordinary mode or
/// LAN toggle carries the pin through rather than clearing it. Port 0 is not a
/// pin (it means "any" to the OS) and is stored as None.
pub fn set_gateway_config(
    env: &Env,
    state: &GatewayState,
    enabled: bool,
    lan: bool,
    mode: String,
    port: Option<u16>,
    terminal: bool,
) -> Result<GatewayStatus, String> {
    let mut p = read_persisted(env);
    p.enabled = enabled;
    p.lan = lan;
    p.mode = normalize_mode(&mode);
    p.preferred_port = port.filter(|&n| n > 0);
    p.terminal = terminal;
    if p.enabled && p.token.is_empty() {
        p.token = random_hex(24);
    }
    write_persisted(env, &p)?;
    if !p.enabled {
        stop(env, state);
        return Ok(status_of(env, state));
    }
    // If already running on the same binding, update token/mode IN PLACE so the
    // port never changes; only first-enable, a loopback↔LAN switch, or a pin to
    // a port we are not on rebinds. The pin is compared only when there is one:
    // an unpinned gateway that fell back to an ephemeral port would otherwise
    // rebind — and change its URL — on every mode change, because it is not on
    // PREFERRED_PORT and never will be.
    let updated_in_place = {
        let guard = state.running.lock().unwrap();
        match guard.as_ref() {
            Some(r) if r.lan == p.lan && p.preferred_port.is_none_or(|want| r.port == want) => {
                *r.shared.token.lock().unwrap() = p.token.clone();
                r.shared.read_only.store(p.mode == "read-only", Ordering::Relaxed);
                r.shared.terminal.store(p.terminal, Ordering::Relaxed);
                if !p.terminal || p.mode == "read-only" {
                    close_remote_terminals(&r.shared, state.terminals.as_ref());
                }
                true
            }
            _ => false,
        }
    };
    if !updated_in_place {
        // A pin must bind exactly or say so: it exists because a firewall rule,
        // a reverse proxy, or a bookmark names that port, and quietly listening
        // somewhere else would break all three while Settings still showed the
        // port the user asked for.
        start_at(env, state, &p, p.preferred_port)?;
    }
    Ok(status_of(env, state))
}

pub fn regenerate_gateway_token(env: &Env, state: &GatewayState) -> Result<GatewayStatus, String> {
    let mut p = read_persisted(env);
    p.token = random_hex(24);
    write_persisted(env, &p)?;
    // Rotate the live token in place — the listener keeps running on the same
    // port (no rebind), so the URL a client bookmarked stays valid.
    if let Some(r) = state.running.lock().unwrap().as_ref() {
        *r.shared.token.lock().unwrap() = p.token.clone();
        // A new token is how a leaked one is revoked; the shells opened with
        // the old one go with it.
        close_remote_terminals(&r.shared, state.terminals.as_ref());
    }
    Ok(status_of(env, state))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provenance_request_requires_a_path_tool_and_session() {
        let ok = parse_provenance_request(br#"{"path":"fig.svg","tool":"write","sessionId":"ses_1","callId":"call_1","content":"<svg/>"}"#).unwrap();
        assert_eq!(ok.call_id.as_deref(), Some("call_1"));
        assert!(parse_provenance_request(br#"{"path":"fig.svg","tool":"write"}"#).is_err());
        assert!(parse_provenance_request(br#"{"path":" ","tool":"write","sessionId":"ses_1"}"#).is_err());
    }

    #[test]
    fn run_record_request_requires_a_session_and_bounded_execution() {
        assert!(parse_run_record_request(br#"{"command":"python3 analysis.py","sessionId":"ses_123","startedAt":100,"endedAt":200,"status":"ok"}"#).is_ok());
        assert!(parse_run_record_request(br#"{"command":"python3 analysis.py","startedAt":100,"endedAt":200,"status":"ok"}"#).is_err());
        assert!(parse_run_record_request(br#"{"command":"python3 analysis.py","sessionId":"ses_123","startedAt":200,"endedAt":100,"status":"ok"}"#).is_err());
        assert!(parse_run_record_request(br#"{"command":"python3 analysis.py","sessionId":"ses_123","startedAt":100,"endedAt":200,"status":"unknown"}"#).is_err());
    }

    /// A gateway record with `port` set, in a throwaway data dir.
    fn env_with_recorded_port(name: &str, port: Option<u16>) -> (Env, PathBuf) {
        let dir = std::env::temp_dir().join(format!("gw-record-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let env = Env::new(dir.clone(), dir.join("res"), None, "0.0.0".into());
        let mut p = read_persisted(&env);
        p.token = "t".into();
        p.port = port;
        write_persisted(&env, &p).unwrap();
        (env, dir)
    }

    #[test]
    fn a_live_gateways_recorded_address_is_not_taken_by_a_second_server() {
        // What happened here for real: an `osd server` started for a test beside
        // a running desktop app took the record, and clearing it on its own exit
        // left the app running and undiscoverable.
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let live = listener.local_addr().unwrap().port();
        let (env, dir) = env_with_recorded_port("live", Some(live));

        assert!(record_belongs_to_a_live_other(&env, live + 1), "the recorded gateway answers");
        assert!(
            !record_belongs_to_a_live_other(&env, live),
            "our own port is not somebody else's"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn starting_beside_a_live_gateway_leaves_its_address_in_place() {
        // The call site, not just the predicate: a mutation that restores the
        // old "record where we ended up, always" line has to fail here.
        let other = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let live = other.local_addr().unwrap().port();
        let (env, dir) = env_with_recorded_port("beside", Some(live));

        let state = GatewayState::default();
        let persisted = Persisted { token: "t".into(), ..read_persisted(&env) };
        let ours = start_at(&env, &state, &persisted, None).expect("a second gateway binds");
        assert_ne!(ours, live);
        assert_eq!(
            read_persisted(&env).port,
            Some(live),
            "the live gateway keeps the recorded address"
        );

        // And our own exit must not clear a record that was never ours.
        stop(&env, &state);
        assert_eq!(
            read_persisted(&env).port,
            Some(live),
            "stopping the second server must not erase the first one's address"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_only_gateway_on_the_machine_does_record_itself() {
        let (env, dir) = env_with_recorded_port("alone", None);
        let state = GatewayState::default();
        let persisted = Persisted { token: "t".into(), ..read_persisted(&env) };
        let ours = start_at(&env, &state, &persisted, None).unwrap();
        assert_eq!(read_persisted(&env).port, Some(ours), "a CLI has to be able to find it");
        stop(&env, &state);
        assert_eq!(read_persisted(&env).port, None, "and its own exit clears its own address");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_stale_record_is_free_to_take() {
        // Bind, learn the port, drop the listener: nothing is there now.
        let dead = {
            let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
            l.local_addr().unwrap().port()
        };
        let (env, dir) = env_with_recorded_port("stale", Some(dead));
        assert!(!port_is_answering(dead), "the port was released");
        assert!(
            !record_belongs_to_a_live_other(&env, dead + 1),
            "a record nothing answers on must not block the new server"
        );

        let (empty_env, empty_dir) = env_with_recorded_port("empty", None);
        assert!(!record_belongs_to_a_live_other(&empty_env, 4098));
        std::fs::remove_dir_all(&dir).unwrap();
        std::fs::remove_dir_all(&empty_dir).unwrap();
    }

    /// A free port, learned by binding and releasing one. Never a fixed number:
    /// two tests in this binary run in parallel, and both reaching for the same
    /// hard-coded port would make one of them fail on every run.
    fn a_free_port() -> u16 {
        std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port()
    }

    #[test]
    fn a_pinned_port_outlives_the_address_record_it_sits_beside() {
        // The two are different facts about the same gateway: where it IS (a
        // record this process rewrites on bind and erases on exit) and where the
        // user asked it to be (#80, kept until they clear it). Sharing one field
        // would let an ordinary stop erase the setting.
        let (env, dir) = env_with_recorded_port("pinned", None);
        let pin = a_free_port();
        let mut p = read_persisted(&env);
        p.preferred_port = Some(pin);
        write_persisted(&env, &p).unwrap();

        let state = GatewayState::default();
        let p = Persisted { token: "t".into(), ..read_persisted(&env) };
        let bound = start_at(&env, &state, &p, p.preferred_port).expect("the pinned port is free");
        assert_eq!(bound, pin, "a pin is where the listener goes");
        assert_eq!(read_persisted(&env).port, Some(pin), "and the CLI can still find it");

        stop(&env, &state);
        let after = read_persisted(&env);
        assert_eq!(after.port, None, "the address record dies with the listener");
        assert_eq!(after.preferred_port, Some(pin), "the user's setting does not");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_address_record_is_never_read_back_as_a_pin() {
        // The regression this field split exists to prevent: an unpinned gateway
        // records 4098 on every start, and reading THAT back as a preference
        // turns "4098 when it is free" into "4098 or refuse to start" the moment
        // anything else takes the port.
        let (env, dir) = env_with_recorded_port("recorded", Some(4098));
        assert_eq!(read_persisted(&env).preferred_port, None, "a record is not a request");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_pinned_port_that_is_taken_is_an_error_not_a_quiet_fallback() {
        // Falling back would leave Settings reporting the port the user asked
        // for while the firewall rule, the reverse proxy and the bookmark that
        // named it all reach nothing.
        let occupied = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let taken = occupied.local_addr().unwrap().port();
        let (env, dir) = env_with_recorded_port("taken", None);
        let state = GatewayState::default();
        let p = Persisted { token: "t".into(), ..read_persisted(&env) };

        let err = start_at(&env, &state, &p, Some(taken)).expect_err("the port is in use");
        assert!(err.contains(&taken.to_string()), "the error has to name the port: {err}");
        drop(occupied);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn ct_eq_matches_only_identical() {
        assert!(ct_eq("abc123", "abc123"));
        assert!(!ct_eq("abc123", "abc124"));
        assert!(!ct_eq("abc", "abcd"));
        assert!(!ct_eq("", "x"));
    }

    #[test]
    fn enc_encodes_unsafe_bytes() {
        assert_eq!(enc("ses_abc-123"), "ses_abc-123");
        assert_eq!(enc("a/b c"), "a%2Fb%20c");
    }

    #[test]
    fn query_get_decodes() {
        assert_eq!(query_get("path=a%2Fb&root=base", "path").as_deref(), Some("a/b"));
        assert_eq!(query_get("path=a%2Fb&root=base", "root").as_deref(), Some("base"));
        assert_eq!(query_get("path=x", "missing"), None);
    }

    #[test]
    fn json_str_field_reads_top_level() {
        assert_eq!(json_str_field(br#"{"text":"hi","n":1}"#, "text").as_deref(), Some("hi"));
        assert_eq!(json_str_field(br#"{"text":"hi"}"#, "reply"), None);
        assert_eq!(json_str_field(b"not json", "text"), None);
    }

    #[test]
    fn base64_matches_opencode_basic_auth() {
        // Must equal btoa("opencode:<token>") that OpenCodeClient sends.
        assert_eq!(base64_encode(b"opencode:abc"), "b3BlbmNvZGU6YWJj");
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
    }

    #[test]
    fn only_static_looking_paths_are_assets() {
        // Assets → served from disk.
        assert!(looks_static("/assets/index-CK0bI0S9.js"));
        assert!(looks_static("/assets/index-abc.css"));
        assert!(looks_static("/favicon.ico"));
        // OpenCode API paths → must NOT be treated as assets (else index.html
        // gets served and EventSource/JSON break).
        assert!(!looks_static("/event"));
        assert!(!looks_static("/experimental/session"));
        assert!(!looks_static("/session/ses_07d47c275ffe6PKKbIF2DpjEhp/message"));
        assert!(!looks_static("/permission"));
        // SPA routes → extensionless, also not assets.
        assert!(!looks_static("/settings"));
        assert!(!looks_static("/live/ses_abc"));
    }

    #[test]
    fn config_paths_recognized() {
        assert!(is_config_path("/global/config"));
        assert!(is_config_path("/config/providers"));
        assert!(is_config_path("/provider/anthropic"));
        assert!(!is_config_path("/session"));
        assert!(!is_config_path("/experimental/session"));
        assert!(!is_config_path("/auth/x")); // /auth handled separately (always blocked)
    }

    #[test]
    fn only_model_writes_allowed() {
        assert!(body_only_sets_model(br#"{"model":"anthropic/claude"}"#));
        assert!(!body_only_sets_model(br#"{"model":"x","provider":{}}"#));
        assert!(!body_only_sets_model(br#"{"provider":{"anthropic":{"apiKey":"sk"}}}"#));
        assert!(!body_only_sets_model(b"{}"));
        assert!(!body_only_sets_model(b"not json"));
    }

    #[test]
    fn redaction_strips_keys_keeps_model() {
        let input = br#"{"model":"anthropic/claude","provider":{"anthropic":{"options":{"apiKey":"sk-secret","baseURL":"https://x"}}},"accessToken":"t","nested":[{"clientSecret":"z"}]}"#;
        let out = redact_config(input);
        let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["model"], "anthropic/claude");
        assert_eq!(v["provider"]["anthropic"]["options"]["baseURL"], "https://x");
        assert_eq!(v["provider"]["anthropic"]["options"]["apiKey"], "__redacted__");
        assert_eq!(v["accessToken"], "__redacted__");
        assert_eq!(v["nested"][0]["clientSecret"], "__redacted__");
        // Unparseable input must not leak.
        assert_eq!(redact_config(b"sk-not-json"), b"{}");
    }

    #[test]
    fn accepted_socket_is_blocking_so_large_bodies_are_not_truncated() {
        // Regression: a non-blocking listener yields non-blocking accepted
        // sockets on Unix; without forcing them back to blocking, write_all of a
        // large asset returns WouldBlock mid-write → the browser sees fewer bytes
        // than Content-Length (ERR_CONTENT_LENGTH_MISMATCH). This asserts the
        // full body arrives over the exact accept pattern start() uses.
        use std::io::Read as _;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let payload = vec![b'x'; 5 * 1024 * 1024]; // 5 MiB, well past a socket buffer
        let expected = payload.len();

        let server = std::thread::spawn(move || loop {
            match listener.accept() {
                Ok((mut s, _)) => {
                    s.set_nonblocking(false).unwrap(); // the fix under test
                    let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {expected}\r\nConnection: close\r\n\r\n");
                    s.write_all(head.as_bytes()).unwrap();
                    s.write_all(&payload).unwrap();
                    s.flush().unwrap();
                    return;
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(_) => return,
            }
        });

        let mut c = loop {
            match TcpStream::connect(("127.0.0.1", port)) {
                Ok(c) => break c,
                Err(_) => std::thread::sleep(Duration::from_millis(5)),
            }
        };
        let mut buf = Vec::new();
        c.read_to_end(&mut buf).unwrap();
        server.join().unwrap();

        let sep = buf.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let body_len = buf.len() - (sep + 4);
        assert_eq!(body_len, expected, "body truncated: got {body_len} of {expected}");
    }

    /// An agent messaging other sessions and terminals through `osd` is held to
    /// AGENT_SEND_LIMIT per conversation: past it, 429. Typing without Enter
    /// sends nothing and is not counted; another conversation, or a person (no
    /// origin header), is not affected.
    #[test]
    fn an_agent_may_send_only_so_many_messages() {
        let (env, dir) = env_with_recorded_port("agentsends", None);
        let fake = Arc::new(FakeTerminals::default());
        let state = GatewayState::default().with_terminals(fake.clone());
        let mut p = read_persisted(&env);
        p.enabled = true;
        write_persisted(&env, &p).unwrap();
        let port = start_at(&env, &state, &p, None).unwrap();
        set_gateway_config(&env, &state, true, false, "full".into(), None, true).unwrap();
        assert_eq!(call(port, "POST", "/v1/terminals/t1", r#"{"cwd":null,"cols":80,"rows":24}"#).0, 200);
        let from = |origin: &str| format!("Bearer t\r\nX-OSD-Origin-Session: {origin}");
        let a = from("ses_a");
        let enter = r#"{"data":"ls\r"}"#;
        for _ in 0..AGENT_SEND_LIMIT {
            assert_eq!(call_as(port, "POST", "/v1/terminals/t1/input", Some(&a), enter).0, 200);
        }
        assert_eq!(call_as(port, "POST", "/v1/terminals/t1/input", Some(&a), r#"{"data":"ls"}"#).0, 200, "no Enter");
        let (status, body) = call_as(port, "POST", "/v1/terminals/t1/input", Some(&a), enter);
        assert_eq!(status, 429);
        assert!(body.contains("ask the user"), "{body}");
        // A prompt to a session counts the same way.
        assert_eq!(call_as(port, "POST", "/v1/sessions/ses_x/prompt", Some(&a), r#"{"text":"hi"}"#).0, 429);
        assert_eq!(call_as(port, "POST", "/v1/terminals/t1/input", Some(&from("ses_b")), enter).0, 200);
        assert_eq!(call(port, "POST", "/v1/terminals/t1/input", enter).0, 200);
        stop(&env, &state);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Changes through either door are recorded with who made them; keys typed
    /// into a terminal become one line at Enter; no password reaches the log;
    /// only the token may read it.
    #[test]
    fn changes_are_audited_and_only_the_owner_reads_the_log() {
        let (env, dir) = env_with_recorded_port("audit", None);
        crate::web_accounts::set_password(&env, "hana", "a long password").unwrap();
        let fake = Arc::new(FakeTerminals::default());
        let state = GatewayState::default().with_terminals(fake.clone());
        let mut p = read_persisted(&env);
        p.enabled = true;
        write_persisted(&env, &p).unwrap();
        let port = start_at(&env, &state, &p, None).unwrap();
        set_gateway_config(&env, &state, true, false, "full".into(), None, true).unwrap();

        assert_eq!(call_as(port, "POST", "/v1/login", None, r#"{"name":"hana","password":"wrong one here"}"#).0, 401);
        let (_, login) = call_as(port, "POST", "/v1/login", None, r#"{"name":"hana","password":"a long password"}"#);
        let hana = format!("Bearer {}", serde_json::from_str::<serde_json::Value>(&login).unwrap()["token"].as_str().unwrap());

        assert_eq!(call(port, "POST", "/v1/terminals/t1", r#"{"cwd":null,"cols":80,"rows":24}"#).0, 200);
        for key in ["l", "x", "\\u007f", "s", "\\r"] {
            assert_eq!(call(port, "POST", "/v1/terminals/t1/input", &format!(r#"{{"data":"{key}"}}"#)).0, 200);
        }
        call(port, "POST", "/v1/terminals/t1/resize", r#"{"cols":100,"rows":30}"#);
        // An agent's message, through /v1; the runtime is not running here, so it fails — and that is recorded too.
        let agent = "Bearer t\r\nX-OSD-Origin-Session: ses_b";
        call_as(port, "POST", "/v1/sessions/ses_a/prompt", Some(agent), r#"{"text":"what is the batch code?"}"#);

        assert_eq!(call_as(port, "GET", "/v1/audit", Some(&hana), "").0, 403);
        let (status, body) = call(port, "GET", "/v1/audit", "");
        assert_eq!(status, 200, "{body}");
        let log: Vec<crate::audit::Entry> = serde_json::from_str(&body).unwrap();
        let seen: Vec<(&str, &str, Option<&str>)> =
            log.iter().rev().map(|e| (e.actor.as_str(), e.action.as_str(), e.detail.as_deref())).collect();
        assert_eq!(
            seen,
            vec![
                ("account:hana", "login.failed", None),
                ("account:hana", "login", None),
                ("admin", "terminal.open", None),
                ("admin", "terminal.input", Some("ls⏎")),
                ("admin", "session.prompt", Some("what is the batch code?")),
            ]
        );
        assert_eq!(log[0].via.as_deref(), Some("ses_b"));
        assert_eq!(log[0].target.as_deref(), Some("ses_a"));
        assert_eq!(log[4].status, 401, "the failed sign-in");
        let raw = std::fs::read_to_string(crate::audit::utc_month_file_for_tests(&env)).unwrap();
        assert!(!raw.contains("long password") && !raw.contains("wrong one"), "{raw}");
        let one = call(port, "GET", "/v1/audit?action=terminal&limit=5", "").1;
        assert_eq!(serde_json::from_str::<Vec<crate::audit::Entry>>(&one).unwrap().len(), 2);
        stop(&env, &state);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// `osd screen new | add | close`: the token edits the window's Screens in
    /// place (and the window hears of it at once), an account its own; both
    /// are audited, and so is a script overwriting the window's layout whole.
    #[test]
    fn screens_are_added_to_and_closed_in_place() {
        let (env, dir) = env_with_recorded_port("screens", None);
        crate::web_accounts::set_password(&env, "ines", "a long password").unwrap();
        let seen: Arc<Mutex<Vec<String>>> = Arc::default();
        let sink = seen.clone();
        let state = GatewayState::default().with_desktop_layout_listener(Arc::new(move |j: &str| sink.lock().unwrap().push(j.to_string())));
        let mut p = read_persisted(&env);
        p.enabled = true;
        write_persisted(&env, &p).unwrap();
        let port = start_at(&env, &state, &p, None).unwrap();
        let mine = r#"{"activeGroupId":"g1","groups":[{"id":"g1","name":"","tree":{"kind":"leaf","id":"p1","sessionId":"ses_a"},"focusedLeafId":"p1","zoomedLeafId":null}]}"#;
        crate::web_accounts::write_desktop_layout(&env, mine).unwrap();

        let (status, body) = call(port, "POST", "/v1/screens", r#"{"name":"Six","panes":[{"session":"s1"},{"terminal":{"cwd":"/repo"}}]}"#);
        assert_eq!(status, 200, "{body}");
        let made: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!((made["id"].as_str(), made["panes"].as_array().unwrap().len()), (Some("g2"), 2));
        let layout = |env: &Env| serde_json::from_str::<serde_json::Value>(&crate::web_accounts::read_desktop_layout(env).unwrap().1).unwrap();
        let l = layout(&env);
        assert_eq!(l["groups"][0]["tree"]["sessionId"], "ses_a", "the window's Screen is untouched");
        assert_eq!(l["groups"][1]["name"], "Six");
        assert_eq!(seen.lock().unwrap().len(), 1, "the window hears of it");

        assert_eq!(call(port, "POST", "/v1/screens/g2/panes", r#"{"session":"s2"}"#).0, 200);
        assert_eq!(call(port, "POST", "/v1/screens/g9/panes", r#"{"session":"s2"}"#).0, 404);
        assert_eq!(call(port, "POST", "/v1/screens/g2/panes", r#"{"nothing":1}"#).0, 400);
        assert_eq!(call(port, "DELETE", "/v1/screens/g2", "").0, 200);
        assert_eq!(layout(&env)["groups"].as_array().unwrap().len(), 1);

        // An account edits its own Screens, never the window's.
        let (_, login) = call_as(port, "POST", "/v1/login", None, r#"{"name":"ines","password":"a long password"}"#);
        let ines = format!("Bearer {}", serde_json::from_str::<serde_json::Value>(&login).unwrap()["token"].as_str().unwrap());
        assert_eq!(call_as(port, "POST", "/v1/screens", Some(&ines), r#"{"panes":[{"session":"s3"}]}"#).0, 200);
        assert_eq!(layout(&env)["groups"].as_array().unwrap().len(), 1);
        let own: serde_json::Value = serde_json::from_str(&crate::web_accounts::read_layout(&env, "ines").unwrap()).unwrap();
        assert_eq!(own["groups"][0]["tree"]["sessionId"], "s3");

        // A script overwriting the window's layout whole is on the record; a browser saving it is not.
        call(port, "PUT", "/v1/layout/desktop", mine);
        let browser = "Bearer t\r\nUser-Agent: Mozilla/5.0";
        call_as(port, "PUT", "/v1/layout/desktop", Some(browser), mine);
        let actions: Vec<String> = crate::audit::query(&env, &crate::audit::Filter::default()).unwrap().into_iter().map(|e| e.action).collect();
        assert_eq!(actions.iter().filter(|a| *a == "layout.replace").count(), 1, "{actions:?}");
        for a in ["screen.new", "screen.add", "screen.close"] {
            assert!(actions.iter().any(|x| x == a), "{a} in {actions:?}");
        }
        stop(&env, &state);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The window can be asked to show one of its Screens — only by the
    /// token, only a Screen it has; requests about a session's folder must
    /// name one inside the workspace; a rename needs something to change.
    #[test]
    fn show_screen_and_folder_scoped_requests() {
        let (env, dir) = env_with_recorded_port("showscreen", None);
        crate::web_accounts::set_password(&env, "jon", "a long password").unwrap();
        let shown: Arc<Mutex<Vec<String>>> = Arc::default();
        let sink = shown.clone();
        let state = GatewayState::default().with_show_screen_listener(Arc::new(move |id: &str| sink.lock().unwrap().push(id.to_string())));
        let mut p = read_persisted(&env);
        p.enabled = true;
        write_persisted(&env, &p).unwrap();
        let port = start_at(&env, &state, &p, None).unwrap();
        crate::web_accounts::write_desktop_layout(&env, r#"{"activeGroupId":"g1","groups":[{"id":"g1","name":"","tree":null,"focusedLeafId":null,"zoomedLeafId":null}]}"#).unwrap();

        assert_eq!(call(port, "POST", "/v1/screens/g1/show", "{}").0, 200);
        assert_eq!(call(port, "POST", "/v1/screens/g9/show", "{}").0, 404);
        let (_, login) = call_as(port, "POST", "/v1/login", None, r#"{"name":"jon","password":"a long password"}"#);
        let jon = format!("Bearer {}", serde_json::from_str::<serde_json::Value>(&login).unwrap()["token"].as_str().unwrap());
        assert_eq!(call_as(port, "POST", "/v1/screens/g1/show", Some(&jon), "{}").0, 403);
        assert_eq!(*shown.lock().unwrap(), vec!["g1".to_string()]);

        let outside = enc(&std::env::temp_dir().to_string_lossy());
        assert_eq!(call(port, "GET", &format!("/v1/questions?dir={outside}"), "").0, 400);
        assert_eq!(call(port, "POST", &format!("/v1/permissions/r1/reply?dir={outside}"), r#"{"reply":"once"}"#).0, 400);
        assert_eq!(call(port, "PATCH", "/v1/sessions/ses_x", "{}").0, 400);
        assert_eq!(call(port, "GET", "/v1/sessions/find?q=", "").0, 400);
        assert_eq!(call(port, "GET", "/v1/sessions/find?q=anything", "").1, "[]", "no runtime database yet: nothing found");
        stop(&env, &state);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A terminal's agent is found on its pane: the desktop window's for the
    /// token, the account's own Screens for an account (where a browser names
    /// the shell `w<browser>-<pane>`). One that has exited does not count.
    #[test]
    fn a_terminal_agent_is_found_on_its_pane() {
        let (ctx, root) = ctx_with_base("tagent");
        let layout = |pane: &str, running: bool| {
            serde_json::json!({ "groups": [{ "id": "g1", "name": "", "tree": { "kind": "split", "dir": "row", "sizes": [0.5, 0.5], "children": [
                { "kind": "leaf", "id": "p1", "sessionId": "ses_a" },
                { "kind": "leaf", "id": pane, "sessionId": null, "content": { "kind": "terminal", "cwd": "/repo",
                  "agent": { "kind": "claude", "sessionId": "abc-1", "running": running } } }
            ]}}]})
            .to_string()
        };
        crate::web_accounts::write_desktop_layout(&ctx.env, &layout("p9", true)).unwrap();
        let want = Some(("claude".to_string(), "abc-1".to_string(), Some("/repo".to_string())));
        assert_eq!(terminal_agent(&ctx, "p9", &Principal::Token), want);
        assert_eq!(terminal_agent(&ctx, "p1", &Principal::Token), None, "a conversation pane");

        crate::web_accounts::set_password(&ctx.env, "gus", "a long password").unwrap();
        crate::web_accounts::write_layout(&ctx.env, "gus", &layout("p4", true)).unwrap();
        let gus = Principal::User { name: "gus".into(), session: String::new() };
        assert_eq!(terminal_agent(&ctx, "wk3j9x2m1q8z0-p4", &gus), want);
        assert_eq!(terminal_agent(&ctx, "p9", &gus), None, "not the window's panes");

        crate::web_accounts::write_desktop_layout(&ctx.env, &layout("p9", false)).unwrap();
        assert_eq!(terminal_agent(&ctx, "p9", &Principal::Token), None, "exited");
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A host's shells, faked: echoes input back as output, records what was
    /// closed. `desktop` stands in for a terminal the desktop window owns.
    #[derive(Default)]
    struct FakeTerminals {
        live: Mutex<HashMap<String, Vec<std::sync::mpsc::Sender<String>>>>,
        closed: Mutex<Vec<String>>,
        /// Everything each shell has printed, replayed to a new subscriber.
        history: Mutex<HashMap<String, String>>,
    }

    impl Terminals for FakeTerminals {
        fn open(&self, id: &str, _cwd: Option<String>, _cols: u16, _rows: u16) -> Result<bool, String> {
            let mut live = self.live.lock().unwrap();
            let created = !live.contains_key(id);
            live.entry(id.to_string()).or_default();
            Ok(created)
        }
        fn write(&self, id: &str, data: &str) -> Result<(), String> {
            let mut live = self.live.lock().unwrap();
            let subs = live.get_mut(id).ok_or("no such terminal")?;
            subs.retain(|tx| tx.send(format!("echo:{data}")).is_ok());
            self.history.lock().unwrap().entry(id.to_string()).or_default().push_str(&format!("echo:{data}"));
            Ok(())
        }
        fn resize(&self, _id: &str, _cols: u16, _rows: u16) -> Result<(), String> {
            Ok(())
        }
        fn close(&self, id: &str) -> Result<(), String> {
            self.live.lock().unwrap().remove(id); // drops the senders: streams end
            self.closed.lock().unwrap().push(id.to_string());
            Ok(())
        }
        fn subscribe(&self, id: &str) -> Option<Receiver<String>> {
            let mut live = self.live.lock().unwrap();
            let subs = live.get_mut(id)?;
            let (tx, rx) = std::sync::mpsc::channel();
            if let Some(past) = self.history.lock().unwrap().get(id) {
                let _ = tx.send(past.clone());
            }
            subs.push(tx);
            Some(rx)
        }
        fn size(&self, _id: &str) -> Option<(u16, u16)> {
            None
        }
    }

    /// One request against a running gateway; returns (status, body).
    fn call(port: u16, method: &str, path: &str, body: &str) -> (u16, String) {
        let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let req = format!(
            "{method} {path} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer t\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        c.write_all(req.as_bytes()).unwrap();
        let mut buf = String::new();
        c.read_to_string(&mut buf).unwrap();
        let status = buf[9..12].parse().unwrap();
        let body = buf.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default();
        (status, body)
    }

    #[test]
    fn web_terminals_need_the_switch_and_full_access() {
        let (env, dir) = env_with_recorded_port("terminals", None);
        crate::web_accounts::set_password(&env, "erin", "a long password").unwrap();
        let fake = Arc::new(FakeTerminals::default());
        fake.open("desktop-pane", None, 80, 24).unwrap();
        let state = GatewayState::default().with_terminals(fake.clone());
        let mut p = read_persisted(&env);
        p.enabled = true;
        write_persisted(&env, &p).unwrap();
        let port = start_at(&env, &state, &p, None).unwrap();
        let open = r#"{"cwd":null,"cols":80,"rows":24}"#;
        let (_, login) = call_as(port, "POST", "/v1/login", None, r#"{"name":"erin","password":"a long password"}"#);
        let session = serde_json::from_str::<serde_json::Value>(&login).unwrap()["token"].as_str().unwrap().to_string();
        let account = format!("Bearer {session}");
        let token = Some("Bearer t");

        // Off by default: neither the token nor an account opens a shell.
        assert_eq!(call(port, "POST", "/v1/terminals/web1", open).0, 403);
        assert_eq!(call_as(port, "POST", "/v1/terminals/web1", Some(&account), open).0, 403);
        assert!(call(port, "GET", "/v1/whoami", "").1.contains("\"terminal\":false"));

        set_gateway_config(&env, &state, true, false, "full".into(), None, true).unwrap();
        assert!(call(port, "GET", "/v1/whoami", "").1.contains("\"terminal\":true"));
        assert_eq!(call(port, "POST", "/v1/terminals/bad$id", open).0, 400);

        // The token shares the window's Screens, so it attaches to the window's
        // shells — and says it did not start one, so no startup is retyped.
        let (status, body) = call_as(port, "POST", "/v1/terminals/desktop-pane", token, open);
        assert_eq!((status, body.as_str()), (200, r#"{"created":false}"#));
        assert_eq!(call_as(port, "POST", "/v1/terminals/desktop-pane/input", token, r#"{"data":"x"}"#).0, 200);
        // A shell with no agent in it is read from its recent output.
        let (status, body) = call_as(port, "GET", "/v1/terminals/desktop-pane/read", token, "");
        assert_eq!(status, 200, "{body}");
        let read: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!((read["kind"].as_str(), read["text"].as_str()), (Some("shell"), Some("echo:x")));
        assert_eq!(call_as(port, "GET", "/v1/terminals/desktop-pane/read", Some(&account), "").0, 404);
        // An account reaches only what it opened.
        assert_eq!(call_as(port, "POST", "/v1/terminals/desktop-pane", Some(&account), open).0, 409);
        assert_eq!(call_as(port, "POST", "/v1/terminals/desktop-pane/input", Some(&account), r#"{"data":"x"}"#).0, 404);
        let (status, body) = call_as(port, "POST", "/v1/terminals/acct1", Some(&account), open);
        assert_eq!((status, body.as_str()), (200, r#"{"created":true}"#));
        assert_eq!(call_as(port, "POST", "/v1/terminals/tok1", token, open).0, 200);

        // Output streams as SSE; typing comes back through it.
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .write_all(format!("GET /v1/terminals/acct1/output HTTP/1.1\r\nAuthorization: {account}\r\n\r\n").as_bytes())
            .unwrap();
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(call_as(port, "POST", "/v1/terminals/acct1/input", Some(&account), r#"{"data":"ls\n"}"#).0, 200);
        std::thread::sleep(Duration::from_millis(100));

        // Read-only: no more shells; the account's are killed, the desktop's
        // (including the one the token opened) are not.
        set_gateway_config(&env, &state, true, false, "read-only".into(), None, true).unwrap();
        let mut out = String::new();
        stream.read_to_string(&mut out).unwrap();
        assert!(out.contains("text/event-stream"), "{out}");
        assert!(out.contains(r#"data: "echo:ls\n""#), "{out}");
        assert!(out.contains("event: exit"), "the stream ends when the shell is killed: {out}");
        assert_eq!(call(port, "POST", "/v1/terminals/web2", open).0, 403);
        assert_eq!(*fake.closed.lock().unwrap(), vec!["acct1".to_string()]);
        let live = fake.live.lock().unwrap();
        assert!(live.contains_key("desktop-pane") && live.contains_key("tok1"));
        drop(live);
        stop(&env, &state);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_token_shares_the_desktop_layout_and_an_account_does_not() {
        let (env, dir) = env_with_recorded_port("desklayout", None);
        crate::web_accounts::set_password(&env, "finn", "a long password").unwrap();
        let seen: Arc<Mutex<Vec<String>>> = Arc::default();
        let sink = seen.clone();
        let state = GatewayState::default()
            .with_desktop_layout_listener(Arc::new(move |json: &str| sink.lock().unwrap().push(json.to_string())));
        let p = read_persisted(&env);
        let port = start_at(&env, &state, &p, None).unwrap();
        let token = Some("Bearer t");

        assert_eq!(call_as(port, "GET", "/v1/layout/desktop", token, "").1, r#"{"rev":0,"layout":null}"#);
        let rev0 = crate::web_accounts::write_desktop_layout(&env, r#"{"groups":[1]}"#).unwrap();
        let (_, body) = call_as(port, "GET", "/v1/layout/desktop", token, "");
        assert_eq!(body, format!(r#"{{"rev":{rev0},"layout":{{"groups":[1]}}}}"#));
        // Nothing newer: an empty answer, so a mirroring client polls cheaply.
        assert_eq!(call_as(port, "GET", &format!("/v1/layout/desktop?since={rev0}"), token, "").0, 204);

        // A token client's change reaches the window, and raises the revision.
        let (status, body) = call_as(port, "PUT", "/v1/layout/desktop", token, r#"{"groups":[2]}"#);
        assert_eq!(status, 200);
        let rev1: u64 = serde_json::from_str::<serde_json::Value>(&body).unwrap()["rev"].as_u64().unwrap();
        assert!(rev1 > rev0);
        assert_eq!(*seen.lock().unwrap(), vec![r#"{"groups":[2]}"#.to_string()]);

        // An account neither sees nor writes the window's Screens.
        let (_, login) = call_as(port, "POST", "/v1/login", None, r#"{"name":"finn","password":"a long password"}"#);
        let session = serde_json::from_str::<serde_json::Value>(&login).unwrap()["token"].as_str().unwrap().to_string();
        let account = format!("Bearer {session}");
        assert_eq!(call_as(port, "GET", "/v1/layout/desktop", Some(&account), "").0, 403);
        assert_eq!(call_as(port, "PUT", "/v1/layout/desktop", Some(&account), r#"{"groups":[3]}"#).0, 403);
        stop(&env, &state);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// `call`, with a chosen credential header (or none).
    fn call_as(port: u16, method: &str, path: &str, auth: Option<&str>, body: &str) -> (u16, String) {
        let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let auth = auth.map(|a| format!("Authorization: {a}\r\n")).unwrap_or_default();
        let req = format!(
            "{method} {path} HTTP/1.1\r\nHost: x\r\n{auth}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        c.write_all(req.as_bytes()).unwrap();
        let mut buf = String::new();
        c.read_to_string(&mut buf).unwrap();
        let status = buf[9..12].parse().unwrap();
        let body = buf.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default();
        (status, body)
    }

    #[test]
    fn a_web_account_signs_in_and_keeps_its_own_layout() {
        let (env, dir) = env_with_recorded_port("accounts", None);
        crate::web_accounts::set_password(&env, "dana", "a long password").unwrap();
        let state = GatewayState::default();
        let p = read_persisted(&env);
        let port = start_at(&env, &state, &p, None).unwrap();

        let bad = call_as(port, "POST", "/v1/login", None, r#"{"name":"dana","password":"nope nope"}"#);
        assert_eq!(bad.0, 401);
        let (status, body) = call_as(port, "POST", "/v1/login", None, r#"{"name":"Dana","password":"a long password"}"#);
        assert_eq!(status, 200, "{body}");
        let session = serde_json::from_str::<serde_json::Value>(&body).unwrap()["token"].as_str().unwrap().to_string();

        // The session stands in for the token everywhere the SPA sends one.
        let bearer = format!("Bearer {session}");
        let who = call_as(port, "GET", "/v1/whoami", Some(&bearer), "").1;
        assert!(who.contains(r#""user":"dana""#), "{who}");
        let basic = format!("Basic {}", base64_encode(format!("opencode:{session}").as_bytes()));
        assert_eq!(call_as(port, "GET", "/v1/whoami", Some(&basic), "").0, 200);
        assert_eq!(call_as(port, "GET", "/v1/whoami", Some("Bearer not-a-session"), "").0, 401);
        // The token still works, and is nobody's account.
        assert!(call_as(port, "GET", "/v1/whoami", Some("Bearer t"), "").1.contains(r#""user":null"#));

        // The account's layout lives here, whatever address it signs in from.
        assert_eq!(call_as(port, "GET", "/v1/me/layout", Some(&bearer), "").1, "null");
        let layout = r#"{"groups":[],"activeGroupId":""}"#;
        assert_eq!(call_as(port, "PUT", "/v1/me/layout", Some(&bearer), layout).0, 200);
        // Read-only stops workspace writes, not an account keeping its Screens.
        set_gateway_config(&env, &state, true, false, "read-only".into(), None, false).unwrap();
        assert_eq!(call_as(port, "PUT", "/v1/me/layout", Some(&bearer), layout).0, 200);
        assert_eq!(call_as(port, "GET", "/v1/me/layout", Some(&bearer), "").1, layout);
        assert_eq!(call_as(port, "PUT", "/v1/me/layout", Some("Bearer t"), layout).0, 400, "the token has no layout");

        assert_eq!(call_as(port, "POST", "/v1/logout", Some(&bearer), "").0, 200);
        assert_eq!(call_as(port, "GET", "/v1/whoami", Some(&bearer), "").0, 401);
        stop(&env, &state);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn model_must_be_written_provider_slash_model() {
        let m = split_model("anthropic/claude-sonnet-4-5").expect("a well-formed model");
        assert_eq!(m["providerID"], "anthropic");
        assert_eq!(m["modelID"], "claude-sonnet-4-5");
        // A model id may itself contain slashes (openrouter names do).
        let m = split_model("openrouter/qwen/qwen3-coder").expect("nested model id");
        assert_eq!(m["providerID"], "openrouter");
        assert_eq!(m["modelID"], "qwen/qwen3-coder");
        // A typo must be reported, never silently answered by another model.
        assert!(split_model("claude-sonnet-4-5").is_none());
        assert!(split_model("/claude").is_none());
        assert!(split_model("anthropic/").is_none());
    }

    #[test]
    fn a_turn_that_died_with_the_runtime_is_not_still_running() {
        // A turn in flight and a turn whose sidecar died persist identically;
        // only the runtime's start time separates them.
        let streaming = serde_json::json!({ "role": "assistant", "time": { "created": 2_000u64 } });
        assert!(turn_is_running(Some(&streaming), 1_000));
        // Same shape, but written before this sidecar existed → dead, not live.
        assert!(!turn_is_running(Some(&streaming), 3_000));

        let done = serde_json::json!({
            "role": "assistant",
            "time": { "created": 2_000u64, "completed": 2_500u64 }
        });
        assert!(!turn_is_running(Some(&done), 1_000));

        let failed = serde_json::json!({
            "role": "assistant",
            "error": { "name": "ProviderError" },
            "time": { "created": 2_000u64 }
        });
        assert!(!turn_is_running(Some(&failed), 1_000));

        // The user's own message is never a running turn, and neither is an
        // empty session.
        let user = serde_json::json!({ "role": "user", "time": { "created": 2_000u64 } });
        assert!(!turn_is_running(Some(&user), 1_000));
        assert!(!turn_is_running(None, 1_000));
    }

    #[test]
    fn normalize_mode_only_two_values() {
        assert_eq!(normalize_mode("read-only"), "read-only");
        assert_eq!(normalize_mode("full"), "full");
        assert_eq!(normalize_mode("garbage"), "full");
    }

    /// A gateway context whose base workspace is a throwaway temp dir.
    ///
    /// Not `#[cfg(unix)]`: the helper is portable, and the terminal test below
    /// uses it on every platform. The ticket tests that first needed it keep
    /// their own `#[cfg(unix)]` for symlink semantics.
    fn ctx_with_base(name: &str) -> (Ctx, PathBuf) {
        let root = std::env::temp_dir().join(format!("gw-verify-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let env = Env::new(root.clone(), root.join("res"), None, "0.0.0".into());
        // `set_workspace_base` persists its choice under the runtime root; the
        // dir must exist first (Env::new creates nothing).
        std::fs::create_dir_all(root.join("runtime")).unwrap();
        std::fs::create_dir_all(root.join("base")).unwrap();
        crate::runtime::set_workspace_base(&env, root.join("base").to_string_lossy().to_string())
            .unwrap();
        let ctx = Ctx {
            env,
            shared: Arc::new(Shared {
                token: Mutex::new("t".into()),
                read_only: AtomicBool::new(false),
                terminal: AtomicBool::new(false),
                remote_terminals: Mutex::new(HashSet::new()),
                tickets: Mutex::new(HashMap::new()),
                muxes: Mutex::new(HashMap::new()),
                agent_sends: Mutex::new(HashMap::new()),
            }),
            assets: Arc::new(NoAssets),
            terminals: None,
            on_desktop_layout: None,
            on_show_screen: None,
            on_sessions_changed: None,
        };
        (ctx, root)
    }

    /// A file ticket must not become a way to read a file OUTSIDE the workspace.
    /// Between issuance and redemption the file can be replaced with a symlink
    /// pointing anywhere — the redemption runs before the token gate, so
    /// `send_file` must refuse to follow it (TOCTOU).
    #[test]
    #[cfg(unix)] // symlink semantics; Windows symlinks need privileges
    fn a_ticket_does_not_serve_a_swapped_symlink_outside_the_workspace() {
        use std::os::unix::fs::symlink;
        let (ctx, root) = ctx_with_base("ticket");
        let base = root.join("base");
        let inside = base.join("report.pdf");
        std::fs::write(&inside, b"innocent").unwrap();
        let outside = root.join("secret.txt");
        std::fs::write(&outside, b"top secret").unwrap();

        // A regular in-workspace file redeems fine.
        assert!(redeem_verify(&ctx, &inside).is_ok());

        // Swap the file for a symlink to something outside the workspace.
        std::fs::remove_file(&inside).unwrap();
        symlink(&outside, &inside).unwrap();
        assert!(
            redeem_verify(&ctx, &inside).is_err(),
            "a swapped symlink must be refused at redemption"
        );

        // And a file that legitimately lives outside the workspace is refused
        // outright (containment, independent of symlinks).
        assert!(redeem_verify(&ctx, &outside).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// The host's active folder may be any folder (a picked one, or
    /// `osd server --workspace`); `fs_base` issues tickets there, so redemption
    /// must honour them — else every web preview and image send there is a 403.
    #[test]
    #[cfg(unix)]
    fn a_ticket_for_a_file_in_an_active_folder_outside_the_base_redeems() {
        let (ctx, root) = ctx_with_base("active");
        let picked = root.join("picked-folder");
        std::fs::create_dir_all(&picked).unwrap();
        let file = picked.join("shot.png");
        std::fs::write(&file, b"png").unwrap();
        assert!(redeem_verify(&ctx, &file).is_err(), "not active yet");
        crate::runtime::set_workspace(&ctx.env, picked.to_string_lossy().to_string()).unwrap();
        assert!(redeem_verify(&ctx, &file).is_ok());
        let sibling = root.join("secret.txt");
        std::fs::write(&sibling, b"no").unwrap();
        assert!(redeem_verify(&ctx, &sibling).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// An in-place project lives OUTSIDE the base workspace, and `fs_base`
    /// issues tickets for files in it — so redemption must accept any file under
    /// that project's root, not only the root itself.
    #[test]
    #[cfg(unix)]
    fn a_ticket_for_a_file_in_an_in_place_project_redeems() {
        let (ctx, root) = ctx_with_base("inplace");
        let ext = root.join("external-project");
        std::fs::create_dir_all(ext.join("figures")).unwrap();
        let file = ext.join("figures").join("fig1.png");
        std::fs::write(&file, b"png").unwrap();
        crate::project::import_project(
            &ctx.env,
            ext.to_string_lossy().to_string(),
            Some("in-place".into()),
        )
        .unwrap();

        assert!(redeem_verify(&ctx, &file).is_ok());
        // A sibling of the project that is not part of it stays refused.
        let sibling = root.join("external-project-other.txt");
        std::fs::write(&sibling, b"no").unwrap();
        assert!(redeem_verify(&ctx, &sibling).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// The web composer's attachments: an upload lands at the root of the
    /// session folder under a free name, a removed chip deletes only what was
    /// uploaded, and nothing can write outside a session folder.
    #[test]
    #[cfg(unix)]
    fn web_uploads_land_in_the_session_folder_and_nowhere_else() {
        let (env, dir) = env_with_recorded_port("upload", None);
        std::fs::create_dir_all(dir.join("runtime")).unwrap();
        let base = dir.join("base");
        std::fs::create_dir_all(base.join("ses1")).unwrap();
        crate::runtime::set_workspace_base(&env, base.to_string_lossy().to_string()).unwrap();
        let ses = base.join("ses1").canonicalize().unwrap();
        let ses_q = enc(&ses.to_string_lossy());
        let state = GatewayState::default();
        let mut p = read_persisted(&env);
        p.enabled = true;
        write_persisted(&env, &p).unwrap();
        let port = start_at(&env, &state, &p, None).unwrap();
        let name_of = |body: &str| {
            serde_json::from_str::<serde_json::Value>(body).unwrap()["name"].as_str().unwrap().to_string()
        };

        let up = format!("/v1/fs/upload?name=fig.png&dir={ses_q}");
        let (s1, b1) = call(port, "POST", &up, "png-bytes");
        assert_eq!((s1, name_of(&b1)), (200, "fig.png".to_string()));
        let (s2, b2) = call(port, "POST", &up, "second");
        assert_eq!((s2, name_of(&b2)), (200, "fig-1.png".to_string()), "a second upload must not overwrite");
        assert_eq!(std::fs::read(ses.join("fig.png")).unwrap(), b"png-bytes");

        // A name carrying a path keeps only its file name: it cannot climb out.
        let (s, b) = call(port, "POST", &format!("/v1/fs/upload?name=..%2F..%2Fescape.txt&dir={ses_q}"), "x");
        assert_eq!((s, name_of(&b)), (200, "escape.txt".to_string()));
        assert!(!dir.join("escape.txt").exists() && !base.join("escape.txt").exists());

        // Only session folders: not the base folder, not anywhere else.
        assert_eq!(call(port, "POST", "/v1/fs/upload?name=a.txt&root=base", "x").0, 400);
        let outside = enc(&dir.to_string_lossy());
        assert_eq!(call(port, "POST", &format!("/v1/fs/upload?name=a.txt&dir={outside}"), "x").0, 400);
        assert!(!dir.join("a.txt").exists());

        // Removing a chip deletes the upload; a nested name is refused.
        std::fs::create_dir_all(ses.join("sub")).unwrap();
        std::fs::write(ses.join("sub/keep.txt"), b"mine").unwrap();
        assert_eq!(call(port, "POST", &format!("/v1/fs/discard?name=fig-1.png&dir={ses_q}"), "").0, 200);
        assert!(!ses.join("fig-1.png").exists() && ses.join("fig.png").exists());
        assert_eq!(call(port, "POST", &format!("/v1/fs/discard?name=sub%2Fkeep.txt&dir={ses_q}"), "").0, 400);
        assert!(ses.join("sub/keep.txt").exists());

        // Too large is refused before the body is read.
        let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let head = format!(
            "POST {up} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer t\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            MAX_UPLOAD + 1
        );
        c.write_all(head.as_bytes()).unwrap();
        let mut buf = String::new();
        let _ = c.read_to_string(&mut buf);
        assert!(buf.starts_with("HTTP/1.1 413"), "{buf}");

        // A mention is located like on the desktop: by path, else by name in a
        // subfolder; a file that is not there is `null`, not a broken chip.
        let path_of = |body: &str| serde_json::from_str::<serde_json::Value>(body).unwrap()["path"].clone();
        let (s, b) = call(port, "GET", &format!("/v1/fs/locate?path=keep.txt&dir={ses_q}"), "");
        assert_eq!((s, path_of(&b)), (200, serde_json::json!("sub/keep.txt")));
        let (s, b) = call(port, "GET", &format!("/v1/fs/locate?path=gone.html&dir={ses_q}"), "");
        assert_eq!((s, path_of(&b)), (200, serde_json::Value::Null));
        assert_eq!(call(port, "GET", &format!("/v1/fs/locate?path=a.txt&dir={outside}"), "").0, 400);

        // A read-only token cannot write.
        set_gateway_config(&env, &state, true, false, "read-only".into(), None, false).unwrap();
        assert_eq!(call(port, "POST", &up, "x").0, 403);
        assert_eq!(call(port, "POST", &format!("/v1/fs/discard?name=fig.png&dir={ses_q}"), "").0, 403);
        assert!(ses.join("fig.png").exists());

        stop(&env, &state);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A tab's one stream carries its shells' output (and its folders'
    /// events), each frame under the tab's own key; removing a key stops it;
    /// what a client may not follow answers `gone` on its own key.
    #[test]
    fn a_tab_follows_everything_over_one_stream() {
        let (env, dir) = env_with_recorded_port("mux", None);
        let fake = Arc::new(FakeTerminals::default());
        fake.open("desktop-pane", None, 80, 24).unwrap();
        let state = GatewayState::default().with_terminals(fake.clone());
        let mut p = read_persisted(&env);
        p.enabled = true;
        write_persisted(&env, &p).unwrap();
        let port = start_at(&env, &state, &p, None).unwrap();
        set_gateway_config(&env, &state, true, false, "full".into(), None, true).unwrap();
        crate::web_accounts::set_password(&env, "erin", "a long password").unwrap();
        let (_, login) = call_as(port, "POST", "/v1/login", None, r#"{"name":"erin","password":"a long password"}"#);
        let account = format!(
            "Bearer {}",
            serde_json::from_str::<serde_json::Value>(&login).unwrap()["token"].as_str().unwrap()
        );

        // Open the stream and collect its frames as they come.
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(b"GET /v1/mux HTTP/1.1\r\nAuthorization: Bearer t\r\n\r\n").unwrap();
        let frames = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        {
            let frames = frames.clone();
            let reader = BufReader::new(s.try_clone().unwrap());
            std::thread::spawn(move || {
                for line in reader.lines().map_while(Result::ok) {
                    if let Some(json) = line.strip_prefix("data: ") {
                        frames.lock().unwrap().push(serde_json::from_str(json).unwrap());
                    }
                }
            });
        }
        let wait_for = |pred: &dyn Fn(&serde_json::Value) -> bool| {
            for _ in 0..100 {
                if frames.lock().unwrap().iter().any(pred) {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            false
        };
        assert!(wait_for(&|f| f["mux"].is_string()));
        let id = frames.lock().unwrap()[0]["mux"].as_str().unwrap().to_string();
        let change = |body: &str| call(port, "POST", &format!("/v1/mux/{id}"), body).0;

        // A shell's output arrives under the key the tab gave it.
        assert_eq!(change(r#"{"add":[{"key":"t1","kind":"terminal","id":"desktop-pane"}]}"#), 200);
        assert!(wait_for(&|f| f["k"] == "t1" && f["open"] == true));
        fake.write("desktop-pane", "ls").unwrap();
        assert!(wait_for(&|f| f["k"] == "t1" && f["d"] == "echo:ls"));

        // An account does not reach the window's shell: `gone`, nothing else.
        assert_eq!(
            call_as(port, "POST", &format!("/v1/mux/{id}"), Some(&account), r#"{"add":[{"key":"t2","kind":"terminal","id":"desktop-pane"}]}"#).0,
            200
        );
        assert!(wait_for(&|f| f["k"] == "t2" && f["gone"] == true));

        // No runtime here, so a folder's events cannot be followed: `gone`.
        assert_eq!(change(r#"{"add":[{"key":"e1","kind":"events","directory":"/tmp"}]}"#), 200);
        assert!(wait_for(&|f| f["k"] == "e1" && f["gone"] == true));

        // Removed: the next output is not forwarded.
        assert_eq!(change(r#"{"remove":["t1"]}"#), 200);
        std::thread::sleep(Duration::from_millis(1300));
        fake.write("desktop-pane", "pwd").unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert!(!frames.lock().unwrap().iter().any(|f| f["d"] == "echo:pwd"));

        // Bad input and unknown streams are refused.
        assert_eq!(change(r#"{"add":[{"key":"bad key!","kind":"terminal","id":"x"}]}"#), 400);
        assert_eq!(call(port, "POST", "/v1/mux/nope", r#"{"add":[]}"#).0, 404);

        // A read-only token can still change what it follows.
        set_gateway_config(&env, &state, true, false, "read-only".into(), None, true).unwrap();
        assert_eq!(change(r#"{"remove":[]}"#), 200);

        // The tab goes (the reader holds a clone, so close it outright): its
        // stream is forgotten within about a second.
        s.shutdown(std::net::Shutdown::Both).unwrap();
        for _ in 0..30 {
            if call(port, "POST", &format!("/v1/mux/{id}"), r#"{"remove":[]}"#).0 == 404 {
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        assert_eq!(call(port, "POST", &format!("/v1/mux/{id}"), r#"{"remove":[]}"#).0, 404);

        stop(&env, &state);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
