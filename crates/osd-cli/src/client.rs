// Talking to a gateway: finding one, and calling `/v1` on it.
//
// The gateway may be `osd server` on this machine, the desktop app running in
// front of the user, or either of those across the network — the CLI cannot and
// need not tell them apart.
use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;

use crate::args::Args;

pub struct Client {
    pub base: String,
    token: String,
    http: reqwest::blocking::Client,
    /// How this connection was found, for `osd status` and for error messages
    /// that would otherwise leave the user guessing which server they hit.
    pub origin: String,
    /// The conversation this `osd` runs for, when an agent runs it (set by the
    /// runtime's origin plugin): sent as `X-OSD-Origin-Session`, so the gateway
    /// can say which agent did what and keep agents from messaging each other
    /// without end.
    via: Option<String>,
}

impl Client {
    /// The URL a person can open to answer an approval (or watch the turn).
    ///
    /// Deliberately WITHOUT the token. It would save one paste, and the earlier
    /// version of this did exactly that — but this line goes to stderr, which is
    /// a CI log, a systemd journal or a scrollback shared in a bug report, and a
    /// bearer token has no business in any of them. The web client asks for the
    /// token itself, and whoever is answering an approval can get it from
    /// `osd status --json` or Settings → Remote Access.
    pub fn web_url(&self) -> String {
        self.base.clone()
    }


    /// Resolve a gateway, in order of how explicit the answer is:
    ///
    /// 1. `--gateway` / `--token`
    /// 2. `OSD_GATEWAY` / `OSD_TOKEN`
    /// 3. `~/.config/osd/config`, written by `osd login`
    /// 4. a gateway running on THIS machine — the desktop app's or an
    ///    `osd server`'s — read from the runtime's own `gateway.txt`
    ///
    /// (4) is what makes `osd session ls` work with no setup at all while the
    /// app is open, which is the common case on a laptop.
    pub fn connect(args: &Args) -> Result<Client, String> {
        let (base, token, origin) = resolve(args)?;
        let mut builder = reqwest::blocking::Client::builder().timeout(Duration::from_secs(120));
        // reqwest honours HTTP_PROXY but not loopback: with a local proxy set and
        // NO_PROXY not naming 127.0.0.1, the request to THIS machine's gateway
        // went to the proxy, which answered 502.
        if is_loopback(&base) {
            builder = builder.no_proxy();
        }
        let http = builder
            .build()
            .map_err(|e| e.to_string())?;
        let via = std::env::var("OSD_ORIGIN_SESSION")
            .ok()
            .filter(|s| !s.is_empty() && s.len() <= 128 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'));
        Ok(Client { base: base.trim_end_matches('/').to_string(), token, http, origin, via })
    }

    pub fn get(&self, path: &str) -> Result<Value, String> {
        self.json(self.http.get(self.url(path)))
    }

    pub fn post(&self, path: &str, body: Value) -> Result<Value, String> {
        self.json(
            self.http
                .post(self.url(path))
                .header("Content-Type", "application/json")
                .body(body.to_string()),
        )
    }

    /// PATCH — the verb OpenCode's config endpoint takes. The gateway allows
    /// exactly one such write (`{model}`); everything else there is 403.
    pub fn patch(&self, path: &str, body: Value) -> Result<Value, String> {
        self.json(
            self.http
                .patch(self.url(path))
                .header("Content-Type", "application/json")
                .body(body.to_string()),
        )
    }

    /// POST a file's bytes as the body (`osd fs put`).
    pub fn post_bytes(&self, path: &str, bytes: Vec<u8>) -> Result<Value, String> {
        self.json(
            self.http
                .post(self.url(path))
                .header("Content-Type", "application/octet-stream")
                .body(bytes),
        )
    }

    pub fn delete(&self, path: &str) -> Result<Value, String> {
        self.json(self.http.delete(self.url(path)))
    }

    /// A response body as raw bytes (file downloads, run logs).
    pub fn get_bytes(&self, path: &str) -> Result<Vec<u8>, String> {
        let res = self
            .http
            .get(self.url(path))
            .bearer_auth(&self.token)
            .headers(self.via_header())
            .send()
            .map_err(|e| self.unreachable(e))?;
        let status = res.status();
        let bytes = res.bytes().map_err(|e| e.to_string())?.to_vec();
        if !status.is_success() {
            return Err(describe_error(status.as_u16(), &bytes));
        }
        Ok(bytes)
    }

    fn via_header(&self) -> reqwest::header::HeaderMap {
        let mut h = reqwest::header::HeaderMap::new();
        if let Some(v) = self.via.as_deref().and_then(|v| reqwest::header::HeaderValue::from_str(v).ok()) {
            h.insert("x-osd-origin-session", v);
        }
        h
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    fn json(&self, req: reqwest::blocking::RequestBuilder) -> Result<Value, String> {
        let res = req
            .bearer_auth(&self.token)
            .headers(self.via_header())
            .send()
            .map_err(|e| self.unreachable(e))?;
        let status = res.status();
        let bytes = res.bytes().map_err(|e| e.to_string())?.to_vec();
        if !status.is_success() {
            return Err(describe_error(status.as_u16(), &bytes));
        }
        if bytes.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&bytes).map_err(|e| format!("unexpected reply: {e}"))
    }

    fn unreachable(&self, e: reqwest::Error) -> String {
        format!(
            "cannot reach the gateway at {} ({}).\nThat address came from {}.",
            self.base, e, self.origin
        )
    }
}

/// Turn a gateway error status into something that says what to do about it.
fn describe_error(status: u16, body: &[u8]) -> String {
    let detail = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
        .unwrap_or_else(|| String::from_utf8_lossy(body).trim().to_string());
    match status {
        401 => "the token was rejected (401). Check --token, or run `osd login`.".to_string(),
        403 if detail.contains("read-only") => {
            "this token is read-only (403); it can list and read, but not run anything.".to_string()
        }
        503 => format!("the runtime is not started (503): {detail}"),
        _ if detail.is_empty() => format!("request failed ({status})"),
        _ => format!("{detail} ({status})"),
    }
}

/// A gateway address must carry its scheme. Without one, reqwest fails with
/// "relative URL without a base", which says nothing about what to fix.
fn check_url(base: &str) -> Result<String, String> {
    let base = base.trim().trim_end_matches('/');
    if base.starts_with("http://") || base.starts_with("https://") {
        return Ok(base.to_string());
    }
    Err(format!(
        "{base:?} is not a gateway address — it needs a scheme, e.g. http://{base}"
    ))
}

/// Whether `base` points at this machine (127.0.0.0/8, ::1, localhost).
fn is_loopback(base: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(base) else { return false };
    match url.host_str() {
        Some("localhost") => true,
        Some(host) => host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback()),
        None => false,
    }
}

fn resolve(args: &Args) -> Result<(String, String, String), String> {
    if let Some(base) = args.value("gateway").or_else(|| env_var("OSD_GATEWAY")) {
        let base = check_url(&base)?;
        let token = args
            .value("token")
            .or_else(|| env_var("OSD_TOKEN"))
            .or_else(|| stored().map(|(_, t)| t))
            .ok_or("no token: pass --token, set OSD_TOKEN, or run `osd login`")?;
        return Ok((base, token, "--gateway/OSD_GATEWAY".into()));
    }
    if let Some((base, token)) = stored() {
        return Ok((check_url(&base)?, token, format!("{}", config_file().display())));
    }
    if let Some((base, token)) = local_gateway(args) {
        return Ok((base, token, "a gateway running on this machine".into()));
    }
    // The app has served this machine before but is not listening now: it is
    // closed, or restarting (an update). Its terminals keep running meanwhile.
    if local_gateway_known(args) {
        return Err("the Open Science app is not running, or is restarting. Its terminals keep \
                    running; retry in a few seconds once the app is open."
            .into());
    }
    Err("no gateway found. Start one with `osd server`, or point at one with \
         `osd login --gateway <url> --token <token>`."
        .into())
}

fn env_var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// The gateway the desktop app (or an `osd server`) left running here. Both
/// record their live port and token under the shared runtime root, so no
/// discovery protocol is needed — and nothing is guessed: an absent port means
/// nothing is listening.
///
/// `--state-dir` has to be threaded through: the record is read out of the
/// runtime root, so an isolated instance's port and token live under ITS root.
/// Resolving the default root here instead would silently hand the caller the
/// desktop install's gateway — driving the wrong server, with no error, which
/// is the exact confusion `--state-dir` exists to prevent. (`OSD_STATE_DIR` is
/// read inside `headless` and so was never affected.)
fn local_gateway(args: &Args) -> Option<(String, String)> {
    let env = osd_core::Env::headless(
        None,
        args.value("state-dir").map(PathBuf::from),
        env!("CARGO_PKG_VERSION").to_string(),
    )
    .ok()?;
    let p = osd_core::gateway::read_persisted(&env);
    let port = p.port?;
    if p.token.is_empty() {
        return None;
    }
    Some((format!("http://127.0.0.1:{port}"), p.token))
}

/// Whether a gateway has run on this machine (it may not be up now). The
/// desktop app always runs one, so a token on record means the app was here.
fn local_gateway_known(args: &Args) -> bool {
    osd_core::Env::headless(
        None,
        args.value("state-dir").map(PathBuf::from),
        env!("CARGO_PKG_VERSION").to_string(),
    )
    .is_ok_and(|env| !osd_core::gateway::read_persisted(&env).token.is_empty())
}

pub fn config_file() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .or_else(|| {
            std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(|h| PathBuf::from(h).join(".config"))
        })
        .unwrap_or_else(|| PathBuf::from(".osd"));
    base.join("osd").join("config")
}

/// `gateway <url>` / `token <token>`, one per line — the same shape as the
/// gateway's own record, for the same reason: it is readable and repairable by
/// hand when something goes wrong on a machine with no GUI.
fn stored() -> Option<(String, String)> {
    let text = std::fs::read_to_string(config_file()).ok()?;
    let mut base = None;
    let mut token = None;
    for line in text.lines() {
        match line.trim().split_once(' ') {
            Some(("gateway", v)) => base = Some(v.trim().to_string()),
            Some(("token", v)) => token = Some(v.trim().to_string()),
            _ => {}
        }
    }
    Some((base?, token?))
}

pub fn save_login(base: &str, token: &str) -> Result<PathBuf, String> {
    let base = check_url(base)?;
    let path = config_file();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, format!("gateway {base}\ntoken {token}\n")).map_err(|e| e.to_string())?;
    // The token is a credential for the whole workbench.
    osd_core::runtime::tighten_private(&path);
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::is_loopback;

    #[test]
    fn loopback_gateways_skip_the_proxy() {
        assert!(is_loopback("http://127.0.0.1:4098"));
        assert!(is_loopback("http://localhost:4098/"));
        assert!(is_loopback("http://[::1]:4098"));
        assert!(!is_loopback("https://osd.example.com"));
        assert!(!is_loopback("http://100.68.102.13:4098"));
        assert!(!is_loopback("not a url"));
    }
}
