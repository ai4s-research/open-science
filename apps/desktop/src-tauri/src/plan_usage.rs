// How much of the subscription is left, asked of the provider rather than
// guessed from transcripts. The approach is Orca's (`src/main/rate-limits`,
// MIT):
//
//   Claude  GET https://api.anthropic.com/api/oauth/usage with the CLI's OAuth
//           token (macOS keychain "Claude Code-credentials[-<hash>]", else
//           `<config>/.credentials.json`). The server, not `expiresAt`, decides
//           whether the token is good. When it is not, the CLI is started hidden
//           and asked for `/usage`: that reads the plan AND renews the CLI's own
//           login, after which the endpoint is asked once more. An account added
//           in Settings has its token renewed here first when it is about to
//           lapse, as Orca does for the accounts it manages.
//   Codex   `codex app-server` over JSON-RPC (`account/rateLimits/read`), Codex
//           renewing its own login; `/status` on a hidden terminal when the RPC
//           fails for a reason other than the login.
//
// Two rules on top of Orca's:
//   - Every request and every CLI goes through the app's proxy when one is set,
//     never direct instead.
//   - A 403 from anyone stops all checks of that account until the app restarts:
//     no retry, no refresh, no CLI. A refusal is the provider saying no, and
//     asking again is how an account gets flagged.
//
// Nothing here is scraped from transcripts and nothing is inferred: a window is
// reported only if the provider or its CLI showed it.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use osd_core::agent_accounts::{self, AgentKind};
use osd_core::usage::{iso8601_to_epoch_ms, RateLimitWindow};

use crate::plan_usage_cli::{self, CliFailure};

const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
/// The public Claude Code OAuth client and token endpoint (Orca's
/// `oauth-refresh.ts`, checked there against the installed CLI).
const CLAUDE_TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/// Renew this far ahead of expiry, the CLI's own margin.
const EXPIRY_BUFFER_MS: i64 = 5 * 60 * 1000;
/// The provider is not the app's critical path: a slow network must never hold
/// the status bar.
const TIMEOUT: Duration = Duration::from_secs(10);
/// How long a last good reading stands in through failures (Orca's figures).
const STALE_MS: i64 = 30 * 60 * 1000;
const RATE_LIMITED_STALE_MS: i64 = 24 * 60 * 60 * 1000;
/// The least time between two checks of one account, and between two hidden
/// CLI runs for it. The panel refreshes on every window focus; neither the
/// provider nor the CLI should hear from us each time (Orca debounces the same
/// way).
const MIN_GAP_MS: i64 = 60 * 1000;

#[derive(Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanUsage {
    pub claude: Vec<RateLimitWindow>,
    pub codex: Vec<RateLimitWindow>,
    /// Why a plan has no windows, when the reason is knowable. A silent absence
    /// is indistinguishable from "this app cannot do that".
    pub claude_error: Option<String>,
    pub codex_error: Option<String>,
    /// The same for every account added in Settings → Agents.
    #[serde(default)]
    pub accounts: Vec<AccountPlan>,
}

/// One added account's windows, or why it has none.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountPlan {
    /// `claude` or `codex`.
    pub kind: String,
    pub id: String,
    pub email: Option<String>,
    pub windows: Vec<RateLimitWindow>,
    pub error: Option<String>,
}

/// Why a reading failed, as far as what happens next is concerned.
#[derive(Debug, PartialEq)]
enum Failure {
    /// A 403: stop checking this account.
    Refused(String),
    /// A 429: no fallback, the last reading may stand in for longer.
    RateLimited(String),
    Other(String),
}

/// What this process remembers between refreshes.
#[derive(Default)]
struct Memory {
    /// Accounts that answered 403, with the message to keep showing.
    refused: HashMap<String, String>,
    /// The last good reading per account and when it was taken.
    last_good: HashMap<String, (Vec<RateLimitWindow>, i64)>,
    /// When the hidden CLI last ran per account.
    last_cli: HashMap<String, i64>,
}

static MEMORY: LazyLock<Mutex<Memory>> = LazyLock::new(Mutex::default);
/// One refresh at a time: two overlapping ones would start the same CLIs twice.
static RUN: Mutex<()> = Mutex::new(());

/// What every reading needs.
struct Ctx {
    app: tauri::AppHandle,
    proxy: Option<String>,
    /// An empty folder the hidden CLIs run in, so they never index a real one.
    probe_dir: PathBuf,
}

/// Both plans' current windows, and every added account's.
///
/// `async` so the work never runs on the UI thread; the requests and CLIs
/// themselves block, so they run on a pool thread, the accounts side by side.
#[tauri::command]
pub async fn plan_usage(app: tauri::AppHandle) -> PlanUsage {
    let data = crate::env_of(&app).data_dir().to_path_buf();
    let ctx = Ctx {
        proxy: proxy_url(&app),
        probe_dir: data.join("plan-usage-probe"),
        app,
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _run = RUN.lock().unwrap_or_else(|e| e.into_inner());
        let _ = std::fs::create_dir_all(&ctx.probe_dir);
        let data = &data;
        let added: Vec<(AgentKind, agent_accounts::Account, PathBuf)> = [AgentKind::Claude, AgentKind::Codex]
            .into_iter()
            .flat_map(|kind| {
                agent_accounts::list(data, kind).into_iter().filter_map(move |account| {
                    let home = agent_accounts::home_dir(data, kind, &account.id).ok()?;
                    Some((kind, account, home))
                })
            })
            .collect();
        std::thread::scope(|scope| {
            let claude = scope.spawn(|| reading(&ctx, AgentKind::Claude, None, "claude"));
            let codex = scope.spawn(|| reading(&ctx, AgentKind::Codex, None, "codex"));
            let accounts: Vec<_> = added
                .iter()
                .map(|(kind, account, home)| {
                    let ctx = &ctx;
                    scope.spawn(move || {
                        let key = format!("{}:{}", kind_name(*kind), account.id);
                        let (windows, error) = reading(ctx, *kind, Some(home), &key);
                        AccountPlan {
                            kind: kind_name(*kind).to_string(),
                            id: account.id.clone(),
                            email: account.identity.email.clone(),
                            windows,
                            error,
                        }
                    })
                })
                .collect();
            let (claude, claude_error) = claude.join().unwrap_or_default();
            let (codex, codex_error) = codex.join().unwrap_or_default();
            PlanUsage {
                claude,
                codex,
                claude_error,
                codex_error,
                accounts: accounts.into_iter().filter_map(|h| h.join().ok()).collect(),
            }
        })
    })
    .await
    .unwrap_or_default()
}

fn kind_name(kind: AgentKind) -> &'static str {
    match kind {
        AgentKind::Claude => "claude",
        AgentKind::Codex => "codex",
    }
}

/// One account's windows, or why there are none, after the refusal rule and
/// the stale rule. `home` None is the agent's own default folder.
fn reading(ctx: &Ctx, kind: AgentKind, home: Option<&Path>, key: &str) -> (Vec<RateLimitWindow>, Option<String>) {
    {
        let memory = memory();
        if let Some(message) = memory.refused.get(key) {
            return (Vec::new(), Some(message.clone()));
        }
        // Asked less than a minute ago: answer from that, not the provider.
        if let Some((windows, _)) = memory.last_good.get(key).filter(|(_, at)| now_ms() - at < MIN_GAP_MS) {
            return (windows.clone(), None);
        }
    }
    let fresh = match kind {
        AgentKind::Claude => claude_plan(ctx, home, key),
        AgentKind::Codex => codex_plan(ctx, home, key),
    };
    settle(&mut memory(), key, fresh, now_ms())
}

fn memory() -> std::sync::MutexGuard<'static, Memory> {
    MEMORY.lock().unwrap_or_else(|e| e.into_inner())
}

/// Keep a good reading, remember a refusal for good, and let a recent good
/// reading stand in through other failures. A stand-in keeps its own `as_of_ms`,
/// so the panel shows its age rather than passing it off as live.
fn settle(
    memory: &mut Memory,
    key: &str,
    fresh: Result<Vec<RateLimitWindow>, Failure>,
    now: i64,
) -> (Vec<RateLimitWindow>, Option<String>) {
    let (message, keep_for) = match fresh {
        Ok(windows) => {
            memory.last_good.insert(key.to_string(), (windows.clone(), now));
            return (windows, None);
        }
        Err(Failure::Refused(message)) => {
            memory.last_good.remove(key);
            memory.refused.insert(key.to_string(), message.clone());
            return (Vec::new(), Some(message));
        }
        Err(Failure::RateLimited(message)) => (message, RATE_LIMITED_STALE_MS),
        Err(Failure::Other(message)) => (message, STALE_MS),
    };
    match memory.last_good.get(key) {
        Some((windows, at)) if now - at < keep_for => (windows.clone(), None),
        _ => (Vec::new(), Some(message)),
    }
}

/// Whether the hidden CLI may run for this account now, and if so, note it.
fn may_run_cli(key: &str) -> bool {
    let now = now_ms();
    let mut memory = memory();
    if memory.last_cli.get(key).is_some_and(|at| now - at < MIN_GAP_MS) {
        return false;
    }
    memory.last_cli.insert(key.to_string(), now);
    true
}

/// The proxy the app is configured to use, if any: the same one its sidecars
/// get, resolved by the same code, so the two never disagree.
fn proxy_url(app: &tauri::AppHandle) -> Option<String> {
    let setting = osd_core::runtime::get_proxy_setting(&crate::env_of(app)).ok()?;
    setting
        .get("effective")?
        .as_str()
        .filter(|url| !url.is_empty())
        .map(str::to_owned)
}

/// A client on the configured proxy. A proxy that does not parse is an error,
/// never a reason to go direct.
fn client(proxy: Option<&str>) -> Result<reqwest::blocking::Client, Failure> {
    let mut builder = reqwest::blocking::Client::builder().timeout(TIMEOUT);
    if let Some(url) = proxy {
        let proxy = reqwest::Proxy::all(url)
            .map_err(|_| Failure::Other("the proxy in Settings is not a valid URL".into()))?;
        builder = builder.proxy(proxy);
    }
    builder
        .build()
        .map_err(|_| Failure::Other("could not create an HTTP client".into()))
}

/// What a failed request means. Only the status code is kept, never the body.
fn http_failure(provider: &str, e: &reqwest::Error) -> Failure {
    match e.status().map(|s| s.as_u16()) {
        Some(403) => refused(provider),
        Some(429) => Failure::RateLimited(format!("{provider} is rate limiting usage checks right now.")),
        Some(401) => Failure::Other("the login has lapsed".into()),
        Some(code) => Failure::Other(format!("the provider answered {code}")),
        None if e.is_timeout() => Failure::Other("timed out. Check the proxy in Settings.".into()),
        None if e.is_connect() => Failure::Other("could not connect. Check the proxy in Settings.".into()),
        None => Failure::Other(e.to_string()),
    }
}

fn refused(provider: &str) -> Failure {
    Failure::Refused(format!(
        "{provider} refused this account (403). Usage checks for it are stopped until the app restarts."
    ))
}

fn cli_failure(provider: &str, failure: CliFailure) -> Failure {
    if failure.refused {
        refused(provider)
    } else {
        Failure::Other(failure.message)
    }
}

// ─── Claude ─────────────────────────────────────────────────────────

fn claude_plan(ctx: &Ctx, home: Option<&Path>, key: &str) -> Result<Vec<RateLimitWindow>, Failure> {
    let (mut raw, store) =
        read_claude_credentials(home).ok_or_else(|| Failure::Other("Claude Code is not signed in on this machine".into()))?;

    // An added account's token is renewed here when it is about to lapse
    // (Orca's managed accounts). The default login is left to its own CLI.
    // Renewing rotates the refresh token, so it is done only where the new one
    // can be saved; otherwise the CLI below renews it itself.
    if home.is_some() && store.writable() && is_expiring(&raw, now_ms()) {
        if let Some(renewed) = refresh_claude_token(ctx.proxy.as_deref(), &raw)? {
            // Keep the renewed token for this reading even if saving it fails;
            // the next refresh will try again.
            let _ = store.write(&renewed);
            raw = renewed;
        }
    }

    let token = oauth_field(&raw, "accessToken");
    if token.is_none() && oauth_field(&raw, "refreshToken").is_none() {
        return Err(Failure::Other("Claude Code is not signed in on this machine".into()));
    }
    let first = match &token {
        Some(token) => claude_usage(ctx.proxy.as_deref(), token),
        None => Err(Failure::Other("no Claude access token".into())),
    };
    let message = match first {
        Err(Failure::Other(message)) => message,
        done => return done, // a reading, a refusal, or a rate limit: no fallback
    };

    // Orca's recovery: the CLI renews its own login while it reads `/usage`.
    if !may_run_cli(key) {
        return Err(Failure::Other(message));
    }
    let env = crate::agent_accounts::agent_env(&ctx.app, AgentKind::Claude, home);
    let cli = plan_usage_cli::claude_usage(&env, &ctx.probe_dir);
    if matches!(&cli, Err(f) if f.refused) {
        return Err(refused("Anthropic"));
    }
    let renewed = read_claude_credentials(home).and_then(|(raw, _)| oauth_field(&raw, "accessToken"));
    if let Some(renewed) = renewed.filter(|t| Some(t) != token.as_ref()) {
        match claude_usage(ctx.proxy.as_deref(), &renewed) {
            Err(Failure::Other(_)) => {}
            done => return done,
        }
    }
    cli.map_err(|f| cli_failure("Anthropic", f))
}

fn claude_usage(proxy: Option<&str>, token: &str) -> Result<Vec<RateLimitWindow>, Failure> {
    let body = client(proxy)?
        .get(CLAUDE_USAGE_URL)
        .bearer_auth(token)
        // The endpoint answers the CLI's OAuth beta, not a bare bearer request.
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("User-Agent", "claude-code/2.1.0")
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.text())
        .map_err(|e| http_failure("Anthropic", &e))?;
    let json: Value = serde_json::from_str(&body).map_err(|e| Failure::Other(e.to_string()))?;
    Ok(claude_windows_from(&json))
}

/// Renew an OAuth token as the CLI does. Ok(None) keeps the stored one: a
/// failure here is never worse than not trying. Ok(Some) is the stored JSON
/// with the new token merged in, the rotated refresh token included.
fn refresh_claude_token(proxy: Option<&str>, raw: &str) -> Result<Option<String>, Failure> {
    let Some(refresh_token) = oauth_field(raw, "refreshToken") else {
        return Ok(None);
    };
    let response = client(proxy)?
        .post(CLAUDE_TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form_body(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.as_str()),
            ("client_id", CLAUDE_CLIENT_ID),
        ]))
        .send();
    let response = match response {
        Ok(r) if r.status().as_u16() == 403 => return Err(refused("Anthropic")),
        Ok(r) if r.status().is_success() => r,
        _ => return Ok(None),
    };
    let Some(answer) = response.text().ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else {
        return Ok(None);
    };
    Ok(apply_refreshed_token(raw, &answer, now_ms()))
}

/// `application/x-www-form-urlencoded`, encoded by the URL parser.
fn form_body(pairs: &[(&str, &str)]) -> String {
    let mut url = reqwest::Url::parse("http://form.invalid/").expect("static URL");
    url.query_pairs_mut().extend_pairs(pairs);
    url.query().unwrap_or_default().to_string()
}

/// Merge a token-endpoint answer into the stored JSON, keeping every field the
/// answer does not replace (Orca's `applyRefreshedToken`).
fn apply_refreshed_token(raw: &str, answer: &Value, now: i64) -> Option<String> {
    let mut stored: Value = serde_json::from_str(raw).ok()?;
    let access = answer.get("access_token")?.as_str().filter(|t| !t.trim().is_empty())?;
    let oauth = stored.get_mut("claudeAiOauth")?.as_object_mut()?;
    oauth.insert("accessToken".into(), access.into());
    if let Some(seconds) = answer.get("expires_in").and_then(Value::as_f64) {
        // Whole milliseconds, as the CLI writes it.
        oauth.insert("expiresAt".into(), (now + (seconds * 1000.0).round() as i64).into());
    }
    if let Some(rotated) = answer.get("refresh_token").and_then(Value::as_str).filter(|t| !t.trim().is_empty()) {
        oauth.insert("refreshToken".into(), rotated.into());
    }
    if let Some(scope) = answer.get("scope").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
        oauth.insert("scopes".into(), scope.split(' ').collect::<Vec<_>>().into());
    }
    serde_json::to_string(&stored).ok()
}

/// Expired or within the buffer. No usable `expiresAt` counts as expiring, so a
/// token without one is renewed rather than trusted for ever (Orca's rule).
fn is_expiring(raw: &str, now: i64) -> bool {
    let Some(oauth) = serde_json::from_str::<Value>(raw).ok().and_then(|v| v.get("claudeAiOauth").cloned()) else {
        return false;
    };
    match oauth.get("expiresAt").and_then(Value::as_f64) {
        Some(at) => (now + EXPIRY_BUFFER_MS) as f64 >= at,
        None => true,
    }
}

fn oauth_field(raw: &str, field: &str) -> Option<String> {
    serde_json::from_str::<Value>(raw)
        .ok()?
        .get("claudeAiOauth")?
        .get(field)?
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
}

/// Where a login's credentials were found, so a renewed token goes back there.
/// A keychain item is named by its service and its account; the account is
/// None when it could not be read, and then nothing is written.
enum CredentialStore {
    Keychain { service: String, account: Option<String> },
    File(PathBuf),
}

/// The CLI's stored credentials JSON. `home` None is the default login. An
/// account's keychain entry is named after its folder, and an account never
/// falls back to the default's: that would report one account's plan as another's.
fn read_claude_credentials(home: Option<&Path>) -> Option<(String, CredentialStore)> {
    if cfg!(target_os = "macos") {
        let service = home.map_or_else(|| "Claude Code-credentials".to_string(), agent_accounts::claude_keychain_service);
        let out = crate::runtime::quiet_command("security")
            .args(["find-generic-password", "-s", &service, "-w"])
            .output()
            .ok()?;
        let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if out.status.success() && oauth_field(&raw, "accessToken").or_else(|| oauth_field(&raw, "refreshToken")).is_some() {
            let account = keychain_account(&service);
            return Some((raw, CredentialStore::Keychain { service, account }));
        }
    }
    let folder = match home {
        Some(home) => home.to_path_buf(),
        None => AgentKind::Claude.default_home().ok()?,
    };
    let path = folder.join(".credentials.json");
    let raw = std::fs::read_to_string(&path).ok()?;
    oauth_field(&raw, "accessToken").or_else(|| oauth_field(&raw, "refreshToken"))?;
    Some((raw, CredentialStore::File(path)))
}

/// The account name on a keychain item, from `security`'s attribute dump.
fn keychain_account(service: &str) -> Option<String> {
    let found = crate::runtime::quiet_command("security")
        .args(["find-generic-password", "-s", service])
        .output()
        .ok()?;
    parse_keychain_account(&String::from_utf8_lossy(&found.stdout))
}

fn parse_keychain_account(attrs: &str) -> Option<String> {
    attrs
        .lines()
        .find_map(|l| l.trim().strip_prefix("\"acct\"<blob>=\"")?.strip_suffix('"').map(str::to_owned))
        .filter(|a| !a.is_empty())
}

impl CredentialStore {
    fn writable(&self) -> bool {
        match self {
            Self::Keychain { account, .. } => account.is_some(),
            Self::File(path) => path.parent().is_some_and(Path::is_dir),
        }
    }

    fn write(&self, raw: &str) -> Result<(), String> {
        match self {
            // Same call as Orca's: `-U` updates the item in place, keeping its
            // account name.
            Self::Keychain { service, account } => {
                let account = account.as_deref().ok_or("no account name on the keychain item")?;
                let status = crate::runtime::quiet_command("security")
                    .args(["add-generic-password", "-U", "-s", service, "-a", account, "-w", raw])
                    .status()
                    .map_err(|e| e.to_string())?;
                status.success().then_some(()).ok_or_else(|| "the keychain refused the update".into())
            }
            // Written beside and renamed over, so a reader never sees half a file.
            Self::File(path) => {
                let temp = path.with_extension("json.osd-tmp");
                std::fs::write(&temp, raw).map_err(|e| e.to_string())?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600));
                }
                std::fs::rename(&temp, path).map_err(|e| e.to_string())
            }
        }
    }
}

/// Map the response's windows, in the order the CLI shows them.
///
/// `utilization` is the percentage used; `resets_at` is an ISO timestamp. Both
/// names are the vendor's, verified against a live response.
pub fn claude_windows_from(body: &Value) -> Vec<RateLimitWindow> {
    // Only the windows a plan actually has: the response carries a long list of
    // per-model buckets, almost all null for any given account.
    [("five_hour", 300u64), ("seven_day", 10080)]
        .into_iter()
        .filter_map(|(key, minutes)| claude_window(body.get(key)?, minutes))
        .collect()
}

fn claude_window(raw: &Value, window_minutes: u64) -> Option<RateLimitWindow> {
    let used_percent = raw
        .get("utilization")
        .or_else(|| raw.get("used_percentage"))?
        .as_f64()?;
    Some(RateLimitWindow {
        used_percent,
        window_minutes,
        resets_at: raw.get("resets_at").and_then(parse_reset),
        as_of_ms: now_ms(),
        plan_type: None,
    })
}

/// `resets_at` arrives as an ISO-8601 string here and as an epoch elsewhere;
/// both end up as unix SECONDS, which is what the rest of the app speaks.
fn parse_reset(value: &Value) -> Option<i64> {
    if let Some(n) = value.as_i64() {
        // Orca's rule: past 1e10 it can only be milliseconds.
        return Some(if n > 10_000_000_000 { n / 1000 } else { n });
    }
    Some(iso8601_to_epoch_ms(value.as_str()?)? / 1000)
}

// ─── Codex ──────────────────────────────────────────────────────────

/// Orca's order: is anyone signed in, then the RPC, then `/status` unless the
/// RPC said the login itself is the problem.
fn codex_plan(ctx: &Ctx, home: Option<&Path>, key: &str) -> Result<Vec<RateLimitWindow>, Failure> {
    let folder = match home {
        Some(home) => home.to_path_buf(),
        None => AgentKind::Codex.default_home().map_err(Failure::Other)?,
    };
    if !folder.join("auth.json").is_file() {
        return Err(Failure::Other("Codex is not signed in on this machine".into()));
    }
    let env = crate::agent_accounts::agent_env(&ctx.app, AgentKind::Codex, home);
    let rpc = match plan_usage_cli::codex_rpc(&env, &ctx.probe_dir) {
        Ok(windows) => return Ok(windows),
        Err(f) if f.refused || f.auth || f.message == "Codex CLI not found" => {
            return Err(cli_failure("OpenAI", f))
        }
        Err(f) => f,
    };
    if !may_run_cli(key) {
        return Err(Failure::Other(rpc.message));
    }
    plan_usage_cli::codex_status(&env, &ctx.probe_dir).map_err(|f| cli_failure("OpenAI", f))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    // A real response, trimmed: the endpoint answers with a long list of
    // per-model buckets that are null for any given account.
    const CLAUDE_BODY: &str = r#"{
      "five_hour": {"utilization": 43.0, "resets_at": "2026-09-16T05:20:00.668161+00:00"},
      "seven_day": {"utilization": 50.0, "resets_at": "2026-09-19T13:00:00.668182+00:00"},
      "seven_day_opus": null,
      "nimbus_quill": {"utilization": 0.0, "resets_at": null}
    }"#;

    fn window(used: f64) -> RateLimitWindow {
        RateLimitWindow { used_percent: used, window_minutes: 300, resets_at: None, as_of_ms: 1, plan_type: None }
    }

    #[test]
    fn reads_claudes_own_figure_for_the_plan() {
        let windows = claude_windows_from(&serde_json::from_str(CLAUDE_BODY).unwrap());
        assert_eq!(windows.len(), 2, "the five-hour and the weekly window");
        assert_eq!(windows[0].used_percent, 43.0);
        assert_eq!(windows[0].window_minutes, 300);
        assert_eq!(windows[1].used_percent, 50.0);
        assert_eq!(windows[1].window_minutes, 10080);
        // ISO-8601 in, unix seconds out: 2026-09-16T05:20:00Z.
        assert_eq!(windows[0].resets_at, Some(1789536000));
    }

    #[test]
    fn a_window_the_plan_does_not_have_is_absent_rather_than_zero() {
        let body = serde_json::json!({ "five_hour": { "utilization": 12.0 } });
        let windows = claude_windows_from(&body);
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].resets_at, None);
        assert!(claude_windows_from(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn a_refusal_is_remembered_and_drops_the_old_reading() {
        let mut memory = Memory::default();
        settle(&mut memory, "claude:a", Ok(vec![window(10.0)]), 0);
        let (windows, error) = settle(&mut memory, "claude:a", Err(refused("Anthropic")), 1);
        assert!(windows.is_empty());
        assert!(error.unwrap().contains("403"));
        assert!(memory.refused.contains_key("claude:a"));
        assert!(!memory.last_good.contains_key("claude:a"));
    }

    #[test]
    fn a_recent_reading_stands_in_until_it_ages_out() {
        let mut memory = Memory::default();
        settle(&mut memory, "k", Ok(vec![window(10.0)]), 0);
        let (windows, error) = settle(&mut memory, "k", Err(Failure::Other("offline".into())), STALE_MS - 1);
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].as_of_ms, 1, "the stand-in keeps its own age");
        assert_eq!(error, None);
        let (windows, error) = settle(&mut memory, "k", Err(Failure::Other("offline".into())), STALE_MS);
        assert!(windows.is_empty());
        assert_eq!(error.as_deref(), Some("offline"));
        // A rate limit lets it stand for a day.
        let (windows, _) = settle(&mut memory, "k", Err(Failure::RateLimited("429".into())), STALE_MS * 2);
        assert_eq!(windows.len(), 1);
    }

    #[test]
    fn expiry_follows_orcas_rule() {
        let at = |ms: i64| format!(r#"{{"claudeAiOauth":{{"accessToken":"a","expiresAt":{ms}}}}}"#);
        assert!(is_expiring(&at(1_000), 1_000));
        assert!(is_expiring(&at(1_000 + EXPIRY_BUFFER_MS), 1_000), "inside the buffer");
        assert!(!is_expiring(&at(2_000 + EXPIRY_BUFFER_MS), 1_000));
        assert!(is_expiring(r#"{"claudeAiOauth":{"accessToken":"a"}}"#, 0), "no expiry: renew");
        assert!(!is_expiring("not json", 0));
    }

    #[test]
    fn a_renewed_token_keeps_what_the_answer_does_not_replace() {
        let raw = r#"{"claudeAiOauth":{"accessToken":"old","refreshToken":"r1","expiresAt":1,"subscriptionType":"max"},"other":1}"#;
        let answer = serde_json::json!({"access_token": "new", "expires_in": 3600, "refresh_token": "r2"});
        let merged: Value = serde_json::from_str(&apply_refreshed_token(raw, &answer, 1_000).unwrap()).unwrap();
        let oauth = &merged["claudeAiOauth"];
        assert_eq!(oauth["accessToken"], "new");
        assert_eq!(oauth["refreshToken"], "r2");
        assert_eq!(oauth["expiresAt"].as_i64(), Some(3_601_000));
        assert_eq!(oauth["subscriptionType"], "max");
        assert_eq!(merged["other"], 1);
        // No access token in the answer: keep the stored credentials.
        assert_eq!(apply_refreshed_token(raw, &serde_json::json!({}), 0), None);
    }

    /// Renew an added account's lapsed token and read its plan, as a refresh
    /// would. Rotates that account's real refresh token. Run by hand:
    /// `OSD_TEST_CLAUDE_HOME=<account home> OSD_TEST_PROXY=<url> cargo test
    /// --lib plan_usage::tests::live -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_renew_an_added_account() {
        let home = PathBuf::from(std::env::var("OSD_TEST_CLAUDE_HOME").expect("OSD_TEST_CLAUDE_HOME"));
        let proxy = std::env::var("OSD_TEST_PROXY").ok();
        let (raw, store) = read_claude_credentials(Some(&home)).expect("signed in");
        let expires = |raw: &str| serde_json::from_str::<Value>(raw).ok().and_then(|v| v["claudeAiOauth"]["expiresAt"].as_i64());
        eprintln!("stored expiresAt {:?}, now {}, writable {}", expires(&raw), now_ms(), store.writable());
        assert!(store.writable());
        let renewed = match refresh_claude_token(proxy.as_deref(), &raw) {
            Ok(Some(renewed)) => renewed,
            other => panic!("not renewed: {other:?}"),
        };
        store.write(&renewed).expect("saved");
        let (again, _) = read_claude_credentials(Some(&home)).unwrap();
        assert_eq!(oauth_field(&again, "accessToken"), oauth_field(&renewed, "accessToken"), "the saved token is the new one");
        eprintln!("renewed expiresAt {:?}", expires(&again));
        let windows = claude_usage(proxy.as_deref(), &oauth_field(&again, "accessToken").unwrap());
        eprintln!("{windows:?}");
        assert!(windows.is_ok());
    }

    #[test]
    fn reads_the_keychain_account_name() {
        let attrs = "keychain: \"/Users/a/Library/Keychains/login.keychain-db\"\nattributes:\n    \"acct\"<blob>=\"asq\"\n    \"svce\"<blob>=\"Claude Code-credentials\"\n";
        assert_eq!(parse_keychain_account(attrs).as_deref(), Some("asq"));
        assert_eq!(parse_keychain_account("    \"acct\"<blob>=<NULL>\n"), None);
    }

    #[test]
    fn reads_the_one_shape_both_stores_use() {
        let raw = r#"{"claudeAiOauth":{"accessToken":"sk-tok","refreshToken":"r"}}"#;
        assert_eq!(oauth_field(raw, "accessToken").as_deref(), Some("sk-tok"));
        assert_eq!(oauth_field("not json", "accessToken"), None);
        assert_eq!(oauth_field(r#"{"claudeAiOauth":{}}"#, "accessToken"), None);
        assert_eq!(oauth_field(r#"{"other":{"accessToken":"x"}}"#, "accessToken"), None);
    }
}
