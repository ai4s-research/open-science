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
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
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
        "enabled {}\nlan {}\nmode {}\ntoken {}\nport {}\npreferredPort {}\n",
        if p.enabled { 1 } else { 0 },
        if p.lan { 1 } else { 0 },
        p.mode,
        p.token,
        p.port.map(|v| v.to_string()).unwrap_or_default(),
        p.preferred_port.map(|v| v.to_string()).unwrap_or_default()
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
    /// Live file tickets: id → (issued, resolved absolute path). See `issue_ticket`.
    tickets: Mutex<HashMap<String, (Instant, PathBuf)>>,
}

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
    /// Called when a client created or deleted a session, so a desktop window
    /// showing the same workspace refreshes instead of going stale.
    on_sessions_changed: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl GatewayState {
    pub fn new(
        assets: Arc<dyn Assets>,
        on_sessions_changed: Option<Arc<dyn Fn() + Send + Sync>>,
    ) -> Self {
        GatewayState { running: Mutex::new(None), assets, on_sessions_changed }
    }
}

impl Default for GatewayState {
    fn default() -> Self {
        GatewayState::new(Arc::new(NoAssets), None)
    }
}

struct Ctx {
    env: Env,
    shared: Arc<Shared>,
    assets: Arc<dyn Assets>,
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
        tickets: Mutex::new(HashMap::new()),
    });
    let ctx = Arc::new(Ctx {
        env: env.clone(),
        shared: shared.clone(),
        assets: state.assets.clone(),
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

struct Request {
    method: String,
    path: String,
    query: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn parse(stream: &TcpStream) -> Option<Request> {
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
        // Guard against an oversized body claim (nothing here needs > 8 MiB).
        if content_length > 8 * 1024 * 1024 {
            return None;
        }
        let mut body = vec![0u8; content_length];
        if content_length > 0 {
            reader.read_exact(&mut body).ok()?;
        }
        Some(Request { method, path, query, headers, body })
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
        Some(r) => r,
        None => {
            respond_json(&mut stream, 400, "{\"error\":\"bad request\"}");
            return;
        }
    };
    route(&mut stream, &req, &ctx);
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
                Some(full) => send_file(stream, &full),
                None => respond_json(stream, 403, "{\"error\":\"ticket expired\"}"),
            }
            return;
        }
    }

    // ---- /v1 contract API (CLI / curl / the SPA's file browser) ----
    if let Some(rest) = path.strip_prefix("/v1/") {
        if !authed(req, &ctx.token()) {
            respond_json(stream, 401, "{\"error\":\"unauthorized\"}");
            return;
        }
        if ctx.read_only() && req.method != "GET" {
            respond_json(stream, 403, "{\"error\":\"token is read-only\"}");
            return;
        }
        v1(stream, req, ctx, rest);
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
    if !authed(req, &ctx.token()) {
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

/// The versioned contract surface (CLI / curl / the SPA's file browser).
/// `rest` is the path after `/v1/`.
fn v1(stream: &mut TcpStream, req: &Request, ctx: &Ctx, rest: &str) {
    let segs: Vec<&str> = rest.trim_matches('/').split('/').collect();
    match (req.method.as_str(), segs.as_slice()) {
        ("GET", ["whoami"]) => {
            let mode = if ctx.read_only() { "read-only" } else { "full" };
            let payload = serde_json::json!({ "mode": mode, "directory": ws_dir(ctx) });
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
        ("GET", ["permissions"]) => {
            let ws = ws_dir(ctx);
            forward(stream, upstream_get(ctx, "/permission", &[("directory", &ws)]));
        }
        ("GET", ["questions"]) => {
            let ws = ws_dir(ctx);
            forward(stream, upstream_get(ctx, "/question", &[("directory", &ws)]));
        }
        ("POST", ["permissions", rid, "reply"]) => {
            let ws = ws_dir(ctx);
            let reply = json_str_field(&req.body, "reply").unwrap_or_else(|| "reject".into());
            let body = serde_json::json!({ "reply": reply }).to_string();
            forward(stream, upstream_post(ctx, &format!("/permission/{}/reply", enc(rid)), &[("directory", &ws)], &body));
        }
        ("GET", ["fs", "list"]) => fs_list(stream, req, ctx),
        ("GET", ["fs", "read"]) => fs_read(stream, req, ctx),
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
        // Which models OpenCode Zen still serves. The browser cannot ask
        // opencode.ai itself (no CORS headers), so the web client asks us and
        // gets the identical list the desktop picker filters by. Carries no
        // credentials in either direction.
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
/// must sit under the base workspace, or BE a registered project's own folder
/// (an in-place import lives outside the base). Anything else is refused —
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
    if canon.starts_with(&base) || crate::project::is_registered_project_path(&ctx.env, &canon) {
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
/// workspace (so a client can't read arbitrary paths). Otherwise fall back to
/// the `root` scope (workspace = host active, base = the base folder).
fn fs_base(ctx: &Ctx, req: &Request) -> Result<PathBuf, String> {
    if let Some(dir) = req.query_get("dir").filter(|d| !d.is_empty()) {
        let base_root = crate::runtime::base_workspace_dir(&ctx.env)?
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let canon = PathBuf::from(&dir).canonicalize().map_err(|_| "dir not found".to_string())?;
        if canon.starts_with(&base_root)
            || crate::project::is_registered_project_path(&ctx.env, &canon)
        {
            return Ok(canon);
        }
        return Err("dir is outside the workspace".into());
    }
    scope_root(&ctx.env, req.query_get("root").as_deref())
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

fn fs_read(stream: &mut TcpStream, req: &Request, ctx: &Ctx) {
    match fs_resolve(ctx, req) {
        Ok(full) => send_file(stream, &full),
        Err(e) => respond_json(stream, 404, &err_json(&e)),
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

/// Proxy the sidecar's SSE event stream verbatim (workspace-wide). Holds this
/// connection thread until the sidecar closes or the client disconnects.
fn events(stream: &mut TcpStream, ctx: &Ctx, directory: &str) {
    let (base, pw) = match endpoint(ctx) {
        Some(v) => v,
        None => return respond_json(stream, 503, "{\"error\":\"runtime not started\"}"),
    };
    // A dedicated client with NO timeout — an idle event stream must not be cut.
    let client = match reqwest::blocking::Client::builder().build() {
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

// ---- upstream proxy helpers -------------------------------------------------

fn shared_client() -> &'static reqwest::blocking::Client {
    static C: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::blocking::Client::builder()
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
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "OK",
    }
}

fn respond(stream: &mut TcpStream, status: u16, content_type: &str, body: &[u8]) {
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
) -> Result<GatewayStatus, String> {
    let mut p = read_persisted(env);
    p.enabled = enabled;
    p.lan = lan;
    p.mode = normalize_mode(&mode);
    p.preferred_port = port.filter(|&n| n > 0);
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
    }
    Ok(status_of(env, state))
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
