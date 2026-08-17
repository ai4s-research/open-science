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

use tauri::{AppHandle, Emitter, Manager, State};

use crate::artifact_file::{locate_under, mime_for, resolve_under, scope_root};
use crate::runtime::{random_hex, runtime_root, server_password, sidecar_url, tighten_private, workspace_dir, RuntimeState};

/// The web client + all `/v1` routes are served on this port when free, so a
/// bookmarked URL / QR survives restarts; falls back to an ephemeral port.
const PREFERRED_PORT: u16 = 4098;

/// SPA route roots (client-side routes served by index.html, not the OpenCode
/// proxy). Everything else that isn't a static asset is proxied to the sidecar.
const SPA_ROOTS: &[&str] = &["live", "example", "skills", "notebooks", "files", "runs", "projects", "settings"];

// ---- persisted config (app-level, under the runtime root) -------------------

struct Persisted {
    enabled: bool,
    lan: bool,
    /// "full" = every endpoint; "read-only" = GET only (no turns, no approvals).
    mode: String,
    token: String,
}

impl Default for Persisted {
    fn default() -> Self {
        Persisted { enabled: false, lan: false, mode: "full".into(), token: String::new() }
    }
}

fn config_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_root(app)?.join("gateway.txt"))
}

fn read_persisted(app: &AppHandle) -> Persisted {
    let mut p = Persisted::default();
    if let Ok(f) = config_file(app) {
        if let Ok(s) = std::fs::read_to_string(f) {
            for line in s.lines() {
                if let Some((k, v)) = line.trim().split_once(' ') {
                    match k {
                        "enabled" => p.enabled = v == "1",
                        "lan" => p.lan = v == "1",
                        "mode" => p.mode = normalize_mode(v),
                        "token" => p.token = v.to_string(),
                        _ => {}
                    }
                }
            }
        }
    }
    p
}

fn write_persisted(app: &AppHandle, p: &Persisted) -> Result<(), String> {
    let f = config_file(app)?;
    if let Some(dir) = f.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = format!(
        "enabled {}\nlan {}\nmode {}\ntoken {}\n",
        if p.enabled { 1 } else { 0 },
        if p.lan { 1 } else { 0 },
        p.mode,
        p.token
    );
    std::fs::write(&f, body).map_err(|e| e.to_string())?;
    tighten_private(&f); // token is a secret — owner-only, never in git
    Ok(())
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

#[derive(Default)]
pub struct GatewayState(Mutex<Option<Running>>);

struct Ctx {
    app: AppHandle,
    shared: Arc<Shared>,
}

impl Ctx {
    fn token(&self) -> String {
        self.shared.token.lock().unwrap().clone()
    }
    fn read_only(&self) -> bool {
        self.shared.read_only.load(Ordering::Relaxed)
    }
}

// ---- lifecycle --------------------------------------------------------------

fn bind_listener(lan: bool) -> std::io::Result<TcpListener> {
    let host = if lan { "0.0.0.0" } else { "127.0.0.1" };
    match TcpListener::bind((host, PREFERRED_PORT)) {
        Ok(l) => Ok(l),
        Err(_) => TcpListener::bind((host, 0)),
    }
}

fn start(app: &AppHandle, state: &GatewayState, p: &Persisted) -> Result<u16, String> {
    // An empty token would make `ct_eq` accept `Authorization: Bearer ` (also
    // empty) — i.e. no auth at all on an off-loopback listener. Callers mint one
    // before enabling; refuse here too rather than trust every caller to.
    if p.token.is_empty() {
        return Err("gateway token is not set".into());
    }
    stop(state);
    let listener = bind_listener(p.lan).map_err(|e| format!("gateway bind failed: {e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let stop_flag = Arc::new(AtomicBool::new(false));
    let shared = Arc::new(Shared {
        token: Mutex::new(p.token.clone()),
        read_only: AtomicBool::new(p.mode == "read-only"),
        tickets: Mutex::new(HashMap::new()),
    });
    let ctx = Arc::new(Ctx { app: app.clone(), shared: shared.clone() });
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
    *state.0.lock().unwrap() = Some(Running { port, lan: p.lan, stop: stop_flag, shared });
    Ok(port)
}

fn stop(state: &GatewayState) {
    if let Some(r) = state.0.lock().unwrap().take() {
        r.stop.store(true, Ordering::Relaxed);
    }
}

/// Auto-start on app launch if the user left it enabled last time.
pub fn autostart(app: &AppHandle) {
    let state = app.state::<GatewayState>();
    let p = read_persisted(app);
    if p.enabled && !p.token.is_empty() {
        let _ = start(app, state.inner(), &p);
    }
}

/// Stop the accept loop on app exit.
pub fn shutdown(state: &GatewayState) {
    stop(state);
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
        let mut parts = line.trim_end().split_whitespace();
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
        ("POST", ["sessions"]) => {
            let ws = ws_dir(ctx);
            if forward(stream, upstream_post(ctx, "/session", &[("directory", &ws)], "{}")) {
                let _ = ctx.app.emit("gateway:sessions-changed", ());
            }
        }
        ("DELETE", ["sessions", id]) => {
            if forward(stream, upstream_delete(ctx, &format!("/session/{}", enc(id)))) {
                let _ = ctx.app.emit("gateway:sessions-changed", ());
            }
        }
        ("GET", ["sessions", id, "messages"]) => {
            forward(stream, upstream_get(ctx, &format!("/session/{}/message", enc(id)), &[]));
        }
        ("POST", ["sessions", id, "prompt"]) => {
            let text = json_str_field(&req.body, "text").unwrap_or_default();
            if text.trim().is_empty() {
                respond_json(stream, 400, "{\"error\":\"missing text\"}");
                return;
            }
            let body = serde_json::json!({ "parts": [{ "type": "text", "text": text }] }).to_string();
            forward(stream, upstream_post(ctx, &format!("/session/{}/prompt_async", enc(id)), &[], &body));
        }
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
        ("GET", ["projects"]) => match crate::project::list_projects(ctx.app.clone()) {
            Ok(list) => respond_json(stream, 200, &serde_json::to_string(&list).unwrap_or_else(|_| "[]".into())),
            Err(e) => respond_json(stream, 500, &err_json(&e)),
        },
        ("GET", ["runs"]) => match crate::runs::list_runs(ctx.app.clone()) {
            Ok(list) => respond_json(stream, 200, &serde_json::to_string(&list).unwrap_or_else(|_| "[]".into())),
            Err(e) => respond_json(stream, 500, &err_json(&e)),
        },
        ("GET", ["runs", "query"]) => {
            let q = req.query_get("q").unwrap_or_else(|| "{}".into());
            match serde_json::from_str::<crate::runs_index::RunQuery>(&q) {
                Ok(query) => match crate::runs_index::query_runs_cmd(ctx.app.clone(), query) {
                    Ok(page) => respond_json(stream, 200, &serde_json::to_string(&page).unwrap_or_else(|_| "{}".into())),
                    Err(e) => respond_json(stream, 500, &err_json(&e)),
                },
                Err(e) => respond_json(stream, 400, &err_json(&format!("bad query: {e}"))),
            }
        }
        ("GET", ["runs", "log"]) => {
            let hash = req.query_get("hash").unwrap_or_default();
            match crate::runs::read_run_log(ctx.app.clone(), hash) {
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

/// Serve the SPA shell (`index.html`) with a marker so it boots in web mode.
fn serve_index(stream: &mut TcpStream, ctx: &Ctx) {
    match ctx.app.asset_resolver().get("index.html".to_string()) {
        Some(asset) => {
            let html = String::from_utf8_lossy(&asset.bytes);
            let injected = html.replacen("<head>", "<head><script>window.__OS_WEB__=true;</script>", 1);
            respond(stream, 200, "text/html; charset=utf-8", injected.as_bytes());
        }
        None => respond(stream, 503, "text/plain; charset=utf-8", b"Frontend assets unavailable."),
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
    match ctx.app.asset_resolver().get(key.to_string()) {
        Some(asset) => {
            respond(stream, 200, &asset.mime_type, &asset.bytes);
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
        let base_root = crate::runtime::base_workspace_dir(&ctx.app)?
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let canon = PathBuf::from(&dir).canonicalize().map_err(|_| "dir not found".to_string())?;
        if canon.starts_with(&base_root)
            || crate::project::is_registered_project_path(&ctx.app, &canon)
        {
            return Ok(canon);
        }
        return Err("dir is outside the workspace".into());
    }
    scope_root(&ctx.app, req.query_get("root").as_deref())
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
    let base = sidecar_url(ctx.app.state::<RuntimeState>().inner())?;
    Some((base, server_password()))
}

fn ws_dir(ctx: &Ctx) -> String {
    workspace_dir(&ctx.app).map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
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

// ---- Tauri commands ---------------------------------------------------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStatus {
    enabled: bool,
    lan: bool,
    mode: String,
    running: bool,
    port: Option<u16>,
    loopback_url: Option<String>,
    lan_url: Option<String>,
    token: String,
}

/// The LAN IP the machine would use to reach the internet — found without
/// sending a packet (UDP connect just picks the route). None when offline.
fn local_ip() -> Option<String> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("8.8.8.8:80").ok()?;
    s.local_addr().ok().map(|a| a.ip().to_string())
}

fn status_of(app: &AppHandle, state: &GatewayState) -> GatewayStatus {
    let p = read_persisted(app);
    let (running, port) = match state.0.lock().unwrap().as_ref() {
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
        loopback_url,
        lan_url,
        token: p.token,
    }
}

#[tauri::command]
pub fn gateway_status(app: AppHandle, state: State<'_, GatewayState>) -> GatewayStatus {
    status_of(&app, state.inner())
}

/// Absolute path of the bundled ACP agent script (#14, server direction), or
/// None when it is missing.
///
/// An external editor integrates with an ACP agent by SPAWNING it — stdio is the
/// only transport the protocol stabilizes — so what Settings has to show the
/// user is a command, and a command needs a real path inside the installed app.
/// The script drives this same gateway with a token, so nothing new is exposed:
/// an editor gets exactly the access the token already carries.
#[tauri::command]
pub fn acp_server_script(app: AppHandle) -> Option<String> {
    let path = app
        .path()
        .resolve("acp-server/acp-server.mjs", tauri::path::BaseDirectory::Resource)
        .ok()?;
    path.exists().then(|| path.to_string_lossy().to_string())
}

#[tauri::command(async)]
pub fn set_gateway_config(
    app: AppHandle,
    state: State<'_, GatewayState>,
    enabled: bool,
    lan: bool,
    mode: String,
) -> Result<GatewayStatus, String> {
    let mut p = read_persisted(&app);
    p.enabled = enabled;
    p.lan = lan;
    p.mode = normalize_mode(&mode);
    if p.enabled && p.token.is_empty() {
        p.token = random_hex(24);
    }
    write_persisted(&app, &p)?;
    if !p.enabled {
        stop(state.inner());
        return Ok(status_of(&app, state.inner()));
    }
    // If already running on the same binding, update token/mode IN PLACE so the
    // port never changes; only first-enable or a loopback↔LAN switch rebinds.
    let updated_in_place = {
        let guard = state.inner().0.lock().unwrap();
        match guard.as_ref() {
            Some(r) if r.lan == p.lan => {
                *r.shared.token.lock().unwrap() = p.token.clone();
                r.shared.read_only.store(p.mode == "read-only", Ordering::Relaxed);
                true
            }
            _ => false,
        }
    };
    if !updated_in_place {
        start(&app, state.inner(), &p)?;
    }
    Ok(status_of(&app, state.inner()))
}

#[tauri::command(async)]
pub fn regenerate_gateway_token(
    app: AppHandle,
    state: State<'_, GatewayState>,
) -> Result<GatewayStatus, String> {
    let mut p = read_persisted(&app);
    p.token = random_hex(24);
    write_persisted(&app, &p)?;
    // Rotate the live token in place — the listener keeps running on the same
    // port (no rebind), so the URL a client bookmarked stays valid.
    if let Some(r) = state.inner().0.lock().unwrap().as_ref() {
        *r.shared.token.lock().unwrap() = p.token.clone();
    }
    Ok(status_of(&app, state.inner()))
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn normalize_mode_only_two_values() {
        assert_eq!(normalize_mode("read-only"), "read-only");
        assert_eq!(normalize_mode("full"), "full");
        assert_eq!(normalize_mode("garbage"), "full");
    }
}
