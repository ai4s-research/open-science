// How much of the subscription is left, asked of the provider rather than
// guessed from transcripts. Ported from Orca (`src/main/rate-limits`, MIT):
//
//   Claude  GET https://api.anthropic.com/api/oauth/usage with the CLI's OAuth
//           token (macOS keychain "Claude Code-credentials[-<hash>]", else
//           `<config>/.credentials.json`). The server, not `expiresAt`, decides
//           whether a token is good. A rejected token is repaired by starting the
//           CLI hidden and asking for `/usage`, which reads the plan and renews
//           the CLI's own login; the endpoint is then asked once more. Any other
//           failure falls back to `/usage` alone. An account added in Settings
//           has its token renewed here first when it is about to lapse, unless a
//           Claude is running as it, which renews it itself. An answer missing
//           a window (the Fable week) is completed from `/usage`.
//   Codex   `codex app-server` over JSON-RPC (`account/rateLimits/read`), Codex
//           renewing its own login; `/status` on a hidden terminal when the RPC
//           fails for a reason other than the login; the five-hour window from
//           chatgpt.com when neither had it. Nothing runs while Codex is
//           rebuilding its session index.
//   Both    A reading under 30 min old (24 h when rate limited) stands in
//           through failures; failures back off from 30 s, doubling, to 5 min;
//           a Retry-After is honoured.
//
// Two rules on top of Orca's:
//   - Every request and every CLI goes through the app's proxy when one is set,
//     never direct instead.
//   - A 403 from anyone stops all checks of that account until the app restarts:
//     no retry, no refresh, no CLI. A refusal is the provider saying no, and
//     asking again is how an account gets flagged.
//
// Not ported, as nothing in this app uses them: WSL accounts; the retry with
// the legacy keychain item (the default account already reads it, and an added
// account reading it would show another account's plan); spending a free Codex
// reset; Orca's job that repairs Codex's session index.
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
const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
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
/// provider nor the CLI should hear from us each time.
const MIN_GAP_MS: i64 = 60 * 1000;
/// After a failure, wait 30 s, doubling per failure in a row, at most 5 min.
const BACKOFF_BASE_MS: i64 = 30 * 1000;
const BACKOFF_MAX_MS: i64 = 5 * 60 * 1000;
const MAX_FAILURE_STREAK: u32 = 8;
/// A Retry-After longer than this is not believed.
const MAX_RETRY_AFTER_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanUsage {
    pub claude: Vec<RateLimitWindow>,
    pub codex: Vec<RateLimitWindow>,
    /// Why a plan has no windows, when the reason is knowable. A silent absence
    /// is indistinguishable from "this app cannot do that".
    pub claude_error: Option<String>,
    pub codex_error: Option<String>,
    /// Free rate-limit resets the Codex account holds.
    #[serde(default)]
    pub codex_reset_credits: Option<u32>,
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
    #[serde(default)]
    pub reset_credits: Option<u32>,
}

/// One account's reading.
#[derive(Debug, Default, Clone, PartialEq)]
struct Reading {
    windows: Vec<RateLimitWindow>,
    reset_credits: Option<u32>,
}

impl From<Vec<RateLimitWindow>> for Reading {
    fn from(windows: Vec<RateLimitWindow>) -> Self {
        Self { windows, reset_credits: None }
    }
}

/// What the panel shows for one account.
#[derive(Debug, Default, Clone, PartialEq)]
struct Answer {
    windows: Vec<RateLimitWindow>,
    error: Option<String>,
    reset_credits: Option<u32>,
}

/// Why a reading failed, as far as what happens next is concerned.
#[derive(Debug, PartialEq)]
enum Failure {
    /// A 403: stop checking this account.
    Refused(String),
    /// A 429: no fallback; honour its Retry-After; the last reading may stand
    /// in for a day.
    RateLimited { message: String, retry_after_ms: Option<i64> },
    /// The token was turned away (401): the CLI can renew it.
    Rejected(String),
    /// Nothing to read (not signed in, API-key billing, no CLI): no stand-in
    /// and no back-off, as in Orca.
    Unavailable(String),
    /// Anything else: network, a server error, an answer that did not parse.
    Other(String),
}

/// What this process remembers between refreshes.
#[derive(Default)]
struct Memory {
    /// Accounts that answered 403, with the message to keep showing.
    refused: HashMap<String, String>,
    /// The last good reading per account and when it was taken.
    last_good: HashMap<String, (Reading, i64)>,
    /// What was shown last, served while a check is held back.
    last_answer: HashMap<String, Answer>,
    /// Failures in a row and when the last one happened.
    failures: HashMap<String, (u32, i64)>,
    /// No request before this, as the provider asked.
    retry_at: HashMap<String, i64>,
    /// When the hidden CLI last ran per account.
    last_cli: HashMap<String, i64>,
}

static MEMORY: LazyLock<Mutex<Memory>> = LazyLock::new(Mutex::default);
/// One refresh at a time: two overlapping ones would start the same CLIs twice.
static RUN: Mutex<()> = Mutex::new(());

/// The environment a CLI runs in for an account: the user's PATH, the
/// account's folder and the app's proxy (`agent_accounts::agent_env`).
type EnvFor = Box<dyn Fn(AgentKind, Option<&Path>) -> agent_accounts::LaunchEnv + Send + Sync>;

/// What every reading needs.
struct Ctx {
    env: EnvFor,
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
        env: Box::new(move |kind, home| crate::agent_accounts::agent_env(&app, kind, home)),
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
                        let answer = reading(ctx, *kind, Some(home), &key);
                        AccountPlan {
                            kind: kind_name(*kind).to_string(),
                            id: account.id.clone(),
                            email: account.identity.email.clone(),
                            windows: answer.windows,
                            error: answer.error,
                            reset_credits: answer.reset_credits,
                        }
                    })
                })
                .collect();
            let claude = claude.join().unwrap_or_default();
            let codex = codex.join().unwrap_or_default();
            PlanUsage {
                claude: claude.windows,
                claude_error: claude.error,
                codex: codex.windows,
                codex_error: codex.error,
                codex_reset_credits: codex.reset_credits,
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

fn memory() -> std::sync::MutexGuard<'static, Memory> {
    MEMORY.lock().unwrap_or_else(|e| e.into_inner())
}

/// One account's answer, after the refusal rule, the pacing rules and the
/// stale rule. `home` None is the agent's own default folder.
fn reading(ctx: &Ctx, kind: AgentKind, home: Option<&Path>, key: &str) -> Answer {
    if let Some(held) = held_back(&memory(), key, now_ms()) {
        return held;
    }
    let fresh = match kind {
        AgentKind::Claude => claude_plan(ctx, home, key),
        AgentKind::Codex => codex_plan(ctx, home, key),
    };
    settle(&mut memory(), key, fresh, now_ms())
}

/// The answer to give without asking anyone, when one is due: a refused
/// account, a reading under a minute old, a Retry-After still running, or a
/// back-off after failures.
fn held_back(memory: &Memory, key: &str, now: i64) -> Option<Answer> {
    if let Some(message) = memory.refused.get(key) {
        return Some(Answer { error: Some(message.clone()), ..Answer::default() });
    }
    if let Some((reading, at)) = memory.last_good.get(key) {
        if now - at < MIN_GAP_MS {
            return Some(Answer { windows: reading.windows.clone(), error: None, reset_credits: reading.reset_credits });
        }
    }
    let waiting = memory.retry_at.get(key).is_some_and(|until| now < *until)
        || memory.failures.get(key).is_some_and(|(streak, at)| now - at < backoff_ms(*streak));
    if waiting {
        return Some(memory.last_answer.get(key).cloned().unwrap_or_default());
    }
    None
}

fn backoff_ms(streak: u32) -> i64 {
    let doublings = streak.saturating_sub(1).min(16);
    (BACKOFF_BASE_MS << doublings).min(BACKOFF_MAX_MS)
}

/// Keep a good reading, remember a refusal for good, and let a recent good
/// reading stand in through other failures. A stand-in keeps its own `as_of_ms`,
/// so the panel shows its age rather than passing it off as live.
fn settle(memory: &mut Memory, key: &str, fresh: Result<Reading, Failure>, now: i64) -> Answer {
    let (message, keep_for) = match fresh {
        Ok(reading) => {
            memory.failures.remove(key);
            memory.retry_at.remove(key);
            memory.last_good.insert(key.to_string(), (reading.clone(), now));
            let answer = Answer { windows: reading.windows, error: None, reset_credits: reading.reset_credits };
            memory.last_answer.insert(key.to_string(), answer.clone());
            return answer;
        }
        Err(Failure::Refused(message)) => {
            memory.last_good.remove(key);
            memory.refused.insert(key.to_string(), message.clone());
            return Answer { error: Some(message), ..Answer::default() };
        }
        Err(Failure::Unavailable(message)) => {
            memory.last_good.remove(key);
            memory.failures.remove(key);
            let answer = Answer { error: Some(message), ..Answer::default() };
            memory.last_answer.insert(key.to_string(), answer.clone());
            return answer;
        }
        Err(Failure::RateLimited { message, retry_after_ms }) => {
            if let Some(wait) = retry_after_ms {
                memory.retry_at.insert(key.to_string(), now + wait.min(MAX_RETRY_AFTER_MS));
            }
            (message, RATE_LIMITED_STALE_MS)
        }
        Err(Failure::Rejected(message)) | Err(Failure::Other(message)) => (message, STALE_MS),
    };
    let streak = memory.failures.get(key).map_or(0, |(n, _)| *n);
    memory.failures.insert(key.to_string(), ((streak + 1).min(MAX_FAILURE_STREAK), now));
    let answer = match memory.last_good.get(key) {
        Some((reading, at)) if now - at < keep_for => {
            Answer { windows: reading.windows.clone(), error: None, reset_credits: reading.reset_credits }
        }
        _ => Answer { error: Some(message), ..Answer::default() },
    };
    memory.last_answer.insert(key.to_string(), answer.clone());
    answer
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

/// Send a request and judge the status. Only the status and Retry-After are
/// kept from a failed answer, never its body.
fn send(provider: &str, request: reqwest::blocking::RequestBuilder) -> Result<String, Failure> {
    let response = request.send().map_err(|e| {
        Failure::Other(if e.is_timeout() {
            "timed out. Check the proxy in Settings.".into()
        } else if e.is_connect() {
            "could not connect. Check the proxy in Settings.".into()
        } else {
            e.to_string()
        })
    })?;
    match response.status().as_u16() {
        403 => Err(refused(provider)),
        429 => Err(Failure::RateLimited {
            message: format!("{provider} is rate limiting usage checks right now."),
            retry_after_ms: response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| parse_retry_after(v, now_ms())),
        }),
        401 => Err(Failure::Rejected("the login has lapsed".into())),
        code if !(200..300).contains(&code) => Err(Failure::Other(format!("the provider answered {code}"))),
        _ => response.text().map_err(|e| Failure::Other(e.to_string())),
    }
}

/// Retry-After as seconds or an HTTP date (RFC 9110), as a wait in ms.
fn parse_retry_after(value: &str, now: i64) -> Option<i64> {
    let value = value.trim();
    if let Ok(seconds) = value.parse::<f64>() {
        return (seconds > 0.0).then(|| ((seconds * 1000.0) as i64).min(MAX_RETRY_AFTER_MS));
    }
    let at = chrono::DateTime::parse_from_rfc2822(value).ok()?.timestamp_millis();
    (at > now).then(|| (at - now).min(MAX_RETRY_AFTER_MS))
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

/// Orca's `fetchActiveClaudeRateLimits`, with the added-account renewal of its
/// managed accounts.
fn claude_plan(ctx: &Ctx, home: Option<&Path>, key: &str) -> Result<Reading, Failure> {
    // A Claude running as an added account renews that login itself; renewing
    // it here at the same time would race it for the refresh token.
    let live = home.is_some_and(claude_running_in);
    let (raw, store) = match read_claude_credentials(home) {
        Credentials::Found(raw, store) => (raw, store),
        Credentials::KeychainUnavailable => {
            return cli_only(ctx, home, key, Failure::Other("Claude keychain credentials are unavailable".into()));
        }
        Credentials::Absent => {
            return cli_only(ctx, home, key, Failure::Unavailable("No subscription plan (API key billing)".into()));
        }
    };
    let mut raw = raw;
    // Renewing rotates the refresh token, so it is done only where the new one
    // can be saved; otherwise the CLI below renews it itself.
    if home.is_some() && !live && store.writable() && is_expiring(&raw, now_ms()) {
        if let Some(renewed) = refresh_claude_token(ctx.proxy.as_deref(), &raw)? {
            // Keep the renewed token for this reading even if saving it fails;
            // the next refresh will try again.
            let _ = store.write(&renewed);
            raw = renewed;
        }
    }

    let Some(token) = oauth_field(&raw, "accessToken") else {
        // Only a refresh token is stored: the CLI can turn it into an access one.
        if live {
            return Err(waiting_for_live());
        }
        return repair(ctx, home, key, None, "Claude OAuth access token unavailable".into());
    };
    match claude_usage(ctx.proxy.as_deref(), &token) {
        Ok(windows) => Ok(complete_from_panel(ctx, home, key, windows, &store, live).into()),
        Err(Failure::Rejected(_)) if live => Err(waiting_for_live()),
        Err(Failure::Rejected(message)) => repair(ctx, home, key, Some(&token), message),
        Err(Failure::Other(message)) => cli_only(ctx, home, key, Failure::Other(message)),
        Err(done) => Err(done), // a refusal or a rate limit: nothing more is tried
    }
}

fn waiting_for_live() -> Failure {
    Failure::Other("Waiting for the running Claude terminal to renew its login.".into())
}

/// A rejected token: let the CLI renew the login while it reads `/usage`, then
/// ask the endpoint once more with whatever token it left (Orca's
/// `repairClaudeCredentialsThenRetryOAuth`).
fn repair(ctx: &Ctx, home: Option<&Path>, key: &str, failed: Option<&str>, message: String) -> Result<Reading, Failure> {
    if !may_run_cli(key) {
        return Err(Failure::Rejected(message));
    }
    let env = (ctx.env)(AgentKind::Claude, home);
    let cli = plan_usage_cli::claude_usage(&env, &ctx.probe_dir);
    if matches!(&cli, Err(f) if f.refused) {
        return Err(refused("Anthropic"));
    }
    let renewed = match read_claude_credentials(home) {
        Credentials::Found(raw, _) => oauth_field(&raw, "accessToken"),
        _ => None,
    };
    if let Some(renewed) = renewed.filter(|t| Some(t.as_str()) != failed) {
        match claude_usage(ctx.proxy.as_deref(), &renewed) {
            Ok(windows) => return Ok(merge(windows, cli.as_ref().ok()).into()),
            Err(Failure::Rejected(_)) | Err(Failure::Other(_)) => {}
            Err(done) => return Err(done),
        }
    }
    cli.map(Reading::from).map_err(|f| cli_failure("Anthropic", f))
}

/// No usable answer from the endpoint: read `/usage` alone.
fn cli_only(ctx: &Ctx, home: Option<&Path>, key: &str, otherwise: Failure) -> Result<Reading, Failure> {
    if !may_run_cli(key) {
        return Err(otherwise);
    }
    let env = (ctx.env)(AgentKind::Claude, home);
    match plan_usage_cli::claude_usage(&env, &ctx.probe_dir) {
        Ok(windows) => Ok(windows.into()),
        Err(f) if f.refused => Err(refused("Anthropic")),
        Err(_) => Err(otherwise),
    }
}

/// Orca's usage-panel supplement: when the endpoint gave the session or the
/// week but no Fable week, read `/usage` for what is missing. Not on Windows,
/// where hidden terminals are less reliable, and not while a live Claude owns
/// the login. For an added account whose login is in the keychain, the panel is
/// believed only if every window both show agrees within a point: an older CLI
/// may read the default login instead of the account's.
fn complete_from_panel(
    ctx: &Ctx,
    home: Option<&Path>,
    key: &str,
    windows: Vec<RateLimitWindow>,
    store: &CredentialStore,
    live: bool,
) -> Vec<RateLimitWindow> {
    let has = |minutes: u64, model: Option<&str>| {
        windows.iter().any(|w| w.window_minutes == minutes && w.model.as_deref() == model)
    };
    let wanted = cfg!(not(windows)) && !live && !has(10080, Some("Fable")) && (has(300, None) || has(10080, None));
    if !wanted || !may_run_cli(key) {
        return windows;
    }
    let env = (ctx.env)(AgentKind::Claude, home);
    let Ok(panel) = plan_usage_cli::claude_usage(&env, &ctx.probe_dir) else {
        return windows;
    };
    let must_agree = home.is_some() && matches!(store, CredentialStore::Keychain { .. });
    if must_agree && !panel_agrees(&windows, &panel) {
        return windows;
    }
    merge(windows, Some(&panel))
}

/// Every window both readings have agrees within one point, and there is at
/// least one such window.
fn panel_agrees(api: &[RateLimitWindow], panel: &[RateLimitWindow]) -> bool {
    let shared: Vec<bool> = api
        .iter()
        .filter(|w| w.model.is_none())
        .filter_map(|w| {
            let p = panel.iter().find(|p| p.window_minutes == w.window_minutes && p.model.is_none())?;
            Some((w.used_percent - p.used_percent).abs() <= 1.0)
        })
        .collect();
    !shared.is_empty() && shared.iter().all(|ok| *ok)
}

/// The first reading, with any window it lacks taken from the second.
fn merge(mut primary: Vec<RateLimitWindow>, extra: Option<&Vec<RateLimitWindow>>) -> Vec<RateLimitWindow> {
    for window in extra.into_iter().flatten() {
        let present = primary
            .iter()
            .any(|w| w.window_minutes == window.window_minutes && w.model == window.model);
        if !present {
            primary.push(window.clone());
        }
    }
    primary.sort_by(|a, b| a.window_minutes.cmp(&b.window_minutes).then(a.model.is_some().cmp(&b.model.is_some())));
    primary
}

/// Whether a Claude is running as this config folder. Claude Code keeps
/// `sessions/<pid>.json` in the folder for each running instance.
fn claude_running_in(home: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(home.join("sessions")) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let name = entry.file_name();
        let pid = name.to_str().and_then(|n| n.strip_suffix(".json")).and_then(|p| p.parse::<u32>().ok());
        pid.is_some_and(process_alive)
    })
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    // Signal 0 checks the process exists without touching it.
    pid > 0 && unsafe { libc::kill(pid as libc::pid_t, 0) } == 0
}

#[cfg(not(unix))]
fn process_alive(_pid: u32) -> bool {
    false
}

fn claude_usage(proxy: Option<&str>, token: &str) -> Result<Vec<RateLimitWindow>, Failure> {
    let request = client(proxy)?
        .get(CLAUDE_USAGE_URL)
        .bearer_auth(token)
        // The endpoint answers the CLI's OAuth beta, not a bare bearer request.
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("User-Agent", "claude-code/2.1.0");
    let body = send("Anthropic", request)?;
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

/// What a login's stored credentials turned out to be.
enum Credentials {
    Found(String, CredentialStore),
    Absent,
    /// The keychain could not be asked at all (not the same as "no item").
    KeychainUnavailable,
}

/// Where a login's credentials were found, so a renewed token goes back there.
/// A keychain item is named by its service and its account; the account is
/// None when it could not be read, and then nothing is written.
enum CredentialStore {
    Keychain { service: String, account: Option<String> },
    File(PathBuf),
}

fn has_oauth(raw: &str) -> bool {
    oauth_field(raw, "accessToken").or_else(|| oauth_field(raw, "refreshToken")).is_some()
}

/// The CLI's stored credentials JSON. `home` None is the default login. An
/// account's keychain entry is named after its folder, and an account never
/// falls back to the default's: that would report one account's plan as another's.
fn read_claude_credentials(home: Option<&Path>) -> Credentials {
    let mut keychain_unavailable = false;
    if cfg!(target_os = "macos") {
        let service = home.map_or_else(|| "Claude Code-credentials".to_string(), agent_accounts::claude_keychain_service);
        match crate::runtime::quiet_command("security")
            .args(["find-generic-password", "-s", &service, "-w"])
            .output()
        {
            Ok(out) if out.status.success() => {
                let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if has_oauth(&raw) {
                    let account = keychain_account(&service);
                    return Credentials::Found(raw, CredentialStore::Keychain { service, account });
                }
            }
            // 44: no such item. Anything else is the keychain not answering.
            Ok(out) if out.status.code() == Some(44) => {}
            _ => keychain_unavailable = true,
        }
    }
    let folder = match home {
        Some(home) => Some(home.to_path_buf()),
        None => AgentKind::Claude.default_home().ok(),
    };
    if let Some(path) = folder.map(|f| f.join(".credentials.json")) {
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if has_oauth(&raw) {
                return Credentials::Found(raw, CredentialStore::File(path));
            }
        }
    }
    if keychain_unavailable {
        Credentials::KeychainUnavailable
    } else {
        Credentials::Absent
    }
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

/// Map the response's windows: the five-hour, the week, and the Fable week.
///
/// `utilization` is the percentage used; `resets_at` is an ISO timestamp. Both
/// names are the vendor's, verified against a live response. The Fable week is
/// the `weekly_scoped` limit whose model is Fable (seen live), else one of the
/// older top-level names Orca also reads.
pub fn claude_windows_from(body: &Value) -> Vec<RateLimitWindow> {
    let window = |raw: &Value, window_minutes: u64, model: Option<&str>| -> Option<RateLimitWindow> {
        let used_percent = raw.get("utilization").or_else(|| raw.get("used_percentage"))?.as_f64()?;
        Some(RateLimitWindow {
            used_percent: used_percent.clamp(0.0, 100.0),
            window_minutes,
            resets_at: raw.get("resets_at").and_then(parse_reset),
            as_of_ms: now_ms(),
            plan_type: None,
            model: model.map(str::to_owned),
        })
    };
    let scoped_fable = body.get("limits").and_then(Value::as_array).and_then(|limits| {
        limits.iter().find(|l| {
            l.get("kind").and_then(Value::as_str) == Some("weekly_scoped")
                && l.get("percent").and_then(Value::as_f64).is_some()
                && l.pointer("/scope/model/display_name")
                    .and_then(Value::as_str)
                    .is_some_and(|n| n.trim().eq_ignore_ascii_case("fable"))
        })
    });
    let fable = scoped_fable
        .and_then(|l| {
            let raw = serde_json::json!({"used_percentage": l.get("percent"), "resets_at": l.get("resets_at")});
            window(&raw, 10080, Some("Fable"))
        })
        .or_else(|| {
            ["fable_weekly", "fable_seven_day", "seven_day_fable"]
                .iter()
                .find_map(|k| window(body.get(k)?, 10080, Some("Fable")))
        });
    [
        body.get("five_hour").and_then(|raw| window(raw, 300, None)),
        body.get("seven_day").and_then(|raw| window(raw, 10080, None)),
        fable,
    ]
    .into_iter()
    .flatten()
    .collect()
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

/// Orca's order: is anyone signed in, is Codex mid-rebuild, then the RPC, then
/// `/status` unless the RPC said the login itself is the problem; then the
/// five-hour window from chatgpt.com if neither had it.
fn codex_plan(ctx: &Ctx, home: Option<&Path>, key: &str) -> Result<Reading, Failure> {
    let folder = match home {
        Some(home) => home.to_path_buf(),
        None => AgentKind::Codex.default_home().map_err(Failure::Other)?,
    };
    if !folder.join("auth.json").is_file() {
        return Err(Failure::Unavailable("Codex is not signed in on this machine".into()));
    }
    if codex_rebuilding_index(&folder) {
        return Err(Failure::Other("Codex is rebuilding its session index; usage will refresh when it finishes.".into()));
    }
    let env = (ctx.env)(AgentKind::Codex, home);
    let reading = match plan_usage_cli::codex_rpc(&env, &ctx.probe_dir) {
        Ok(rpc) => Reading { windows: rpc.windows, reset_credits: rpc.reset_credits },
        Err(f) if f.message == "Codex CLI not found" => return Err(Failure::Unavailable(f.message)),
        Err(f) if f.refused || f.auth => return Err(cli_failure("OpenAI", f)),
        Err(f) => {
            if !may_run_cli(key) {
                return Err(Failure::Other(f.message));
            }
            plan_usage_cli::codex_status(&env, &ctx.probe_dir)
                .map(Reading::from)
                .map_err(|f| cli_failure("OpenAI", f))?
        }
    };
    complete_codex_session(ctx.proxy.as_deref(), &folder, reading)
}

/// Orca's `supplementCodexSessionWindow`: a reading with the week but no
/// five-hour window asks chatgpt.com for it. A 403 there stops the account;
/// any other failure keeps the reading as it is.
fn complete_codex_session(proxy: Option<&str>, folder: &Path, mut reading: Reading) -> Result<Reading, Failure> {
    let has = |minutes| reading.windows.iter().any(|w: &RateLimitWindow| w.window_minutes == minutes);
    if has(300) || !has(10080) {
        return Ok(reading);
    }
    let backend = match codex_backend(proxy, folder) {
        Ok(Some(backend)) => backend,
        Ok(None) | Err(Failure::Other(_)) | Err(Failure::Rejected(_)) => return Ok(reading),
        Err(Failure::Refused(message)) => return Err(Failure::Refused(message)),
        Err(_) => return Ok(reading),
    };
    reading.reset_credits = reading.reset_credits.or(backend.reset_credits);
    if let Some(session) = backend.windows.into_iter().find(|w| w.window_minutes == 300) {
        reading.windows.insert(0, session);
    }
    Ok(reading)
}

/// chatgpt.com's own usage answer, with the CLI's login. Ok(None) when there
/// is no token to ask with or the answer has no plan.
fn codex_backend(proxy: Option<&str>, folder: &Path) -> Result<Option<Reading>, Failure> {
    let Ok(raw) = std::fs::read(folder.join("auth.json")) else {
        return Ok(None);
    };
    let Ok(auth) = serde_json::from_slice::<Value>(&raw) else {
        return Ok(None);
    };
    let Some(token) = auth.pointer("/tokens/access_token").and_then(Value::as_str) else {
        return Ok(None);
    };
    let mut request = client(proxy)?
        .get(CODEX_USAGE_URL)
        .bearer_auth(token)
        .header("User-Agent", "codex-cli")
        .header("OpenAI-Beta", "codex-1")
        .header("originator", "Codex Desktop");
    if let Some(account) = auth.pointer("/tokens/account_id").and_then(Value::as_str) {
        request = request.header("ChatGPT-Account-Id", account);
    }
    let body = send("OpenAI", request)?;
    let json: Value = serde_json::from_str(&body).map_err(|e| Failure::Other(e.to_string()))?;
    Ok(codex_backend_reading(&json))
}

/// Map chatgpt.com's answer: windows classified by length as the RPC's are,
/// and the free resets.
fn codex_backend_reading(body: &Value) -> Option<Reading> {
    let plan_type = body.get("plan_type")?.as_str()?.to_owned();
    let snapshot = |key: &str| -> Value {
        let Some(raw) = body.pointer(&format!("/rate_limit/{key}")).filter(|v| v.is_object()) else {
            return Value::Null;
        };
        let minutes = raw.get("limit_window_seconds").and_then(Value::as_f64).filter(|s| *s > 0.0).map(|s| (s / 60.0).ceil());
        serde_json::json!({"usedPercent": raw.get("used_percent"), "windowDurationMins": minutes, "resetsAt": raw.get("reset_at")})
    };
    let shaped = serde_json::json!({"rateLimits": {
        "primary": snapshot("primary_window"),
        "secondary": snapshot("secondary_window"),
        "planType": plan_type,
    }});
    let credits = body.get("rate_limit_reset_credits");
    let reset_credits = credits.and_then(|c| c.get("available_count")).and_then(Value::as_u64).map(|n| n as u32).or_else(|| {
        let list = credits?.get("credits")?.as_array()?;
        Some(list.iter().filter(|c| c.get("status").and_then(Value::as_str) == Some("available")).count() as u32)
    });
    Some(Reading { windows: plan_usage_cli::codex_rpc_windows(&shaped), reset_credits })
}

/// Whether Codex's own state database says it is rebuilding its session index
/// (`backfill_state`, read-only). Orca also counts a folder with no such record
/// and 100+ sessions as rebuilding, because it then starts a job that drives
/// the rebuild; this app has no such job, so only an explicit record counts,
/// or checks could stop for good on an older Codex.
fn codex_rebuilding_index(folder: &Path) -> bool {
    let newest = std::fs::read_dir(folder).ok().and_then(|entries| {
        entries
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().into_string().ok()?;
                let version: u64 = name.strip_prefix("state_")?.strip_suffix(".sqlite")?.parse().ok()?;
                Some((version, e.path()))
            })
            .max_by_key(|(version, _)| *version)
    });
    let Some((_, path)) = newest else {
        return false;
    };
    let Ok(db) = rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return false;
    };
    db.query_row("SELECT status FROM backfill_state WHERE id = 1", [], |row| row.get::<_, String>(0))
        .is_ok_and(|status| status != "complete")
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
        RateLimitWindow { used_percent: used, window_minutes: 300, resets_at: None, as_of_ms: 1, plan_type: None, model: None }
    }

    fn reading(used: f64) -> Reading {
        vec![window(used)].into()
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
    fn reads_the_fable_week_from_the_scoped_limits() {
        // Shape from a live answer (2026-10-28).
        let body = serde_json::json!({
            "seven_day": {"utilization": 27.0},
            "limits": [
                {"kind": "weekly_all", "percent": 27},
                {"kind": "weekly_scoped", "percent": 4, "resets_at": "2026-11-01T23:00:00+00:00",
                 "scope": {"model": {"id": null, "display_name": "Fable"}}}
            ]
        });
        let windows = claude_windows_from(&body);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[1].model.as_deref(), Some("Fable"));
        assert_eq!(windows[1].used_percent, 4.0);
        assert!(windows[1].resets_at.is_some());
        // The older top-level name, when there is no scoped limit.
        let old = claude_windows_from(&serde_json::json!({"seven_day_fable": {"utilization": 9.0}}));
        assert_eq!(old[0].model.as_deref(), Some("Fable"));
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
        settle(&mut memory, "claude:a", Ok(reading(10.0)), 0);
        let answer = settle(&mut memory, "claude:a", Err(refused("Anthropic")), 1);
        assert!(answer.windows.is_empty());
        assert!(answer.error.unwrap().contains("403"));
        assert!(held_back(&memory, "claude:a", 10 * STALE_MS).unwrap().error.unwrap().contains("403"));
        assert!(!memory.last_good.contains_key("claude:a"));
    }

    #[test]
    fn a_recent_reading_stands_in_until_it_ages_out() {
        let mut memory = Memory::default();
        settle(&mut memory, "k", Ok(reading(10.0)), 0);
        let answer = settle(&mut memory, "k", Err(Failure::Other("offline".into())), STALE_MS - 1);
        assert_eq!(answer.windows.len(), 1);
        assert_eq!(answer.windows[0].as_of_ms, 1, "the stand-in keeps its own age");
        assert_eq!(answer.error, None);
        let answer = settle(&mut memory, "k", Err(Failure::Other("offline".into())), STALE_MS);
        assert!(answer.windows.is_empty());
        assert_eq!(answer.error.as_deref(), Some("offline"));
        // A rate limit lets it stand for a day.
        let limited = Failure::RateLimited { message: "429".into(), retry_after_ms: None };
        assert_eq!(settle(&mut memory, "k", Err(limited), STALE_MS * 2).windows.len(), 1);
        // Nothing to read drops it at once.
        let gone = settle(&mut memory, "k", Err(Failure::Unavailable("signed out".into())), STALE_MS * 2 + 1);
        assert!(gone.windows.is_empty());
    }

    #[test]
    fn failures_back_off_and_a_retry_after_is_honoured() {
        let mut memory = Memory::default();
        settle(&mut memory, "k", Err(Failure::Other("down".into())), 0);
        assert!(held_back(&memory, "k", BACKOFF_BASE_MS - 1).is_some(), "30 s after the first failure");
        assert!(held_back(&memory, "k", BACKOFF_BASE_MS).is_none());
        settle(&mut memory, "k", Err(Failure::Other("down".into())), BACKOFF_BASE_MS);
        assert!(held_back(&memory, "k", BACKOFF_BASE_MS * 3 - 1).is_some(), "60 s after the second");
        assert_eq!(backoff_ms(8), BACKOFF_MAX_MS);
        let limited = Failure::RateLimited { message: "429".into(), retry_after_ms: Some(3_600_000) };
        settle(&mut memory, "r", Err(limited), 0);
        assert!(held_back(&memory, "r", 3_599_999).is_some());
        // A success clears both.
        settle(&mut memory, "r", Ok(reading(1.0)), 3_600_000);
        assert!(held_back(&memory, "r", 3_600_000 + MIN_GAP_MS).is_none());
    }

    #[test]
    fn a_reading_under_a_minute_old_is_reused() {
        let mut memory = Memory::default();
        settle(&mut memory, "k", Ok(reading(10.0)), 0);
        assert_eq!(held_back(&memory, "k", MIN_GAP_MS - 1).unwrap().windows.len(), 1);
        assert!(held_back(&memory, "k", MIN_GAP_MS).is_none());
    }

    #[test]
    fn reads_retry_after_both_ways() {
        assert_eq!(parse_retry_after("120", 0), Some(120_000));
        assert_eq!(parse_retry_after("999999999", 0), Some(MAX_RETRY_AFTER_MS), "capped at a day");
        let now = chrono::DateTime::parse_from_rfc2822("Wed, 28 Oct 2026 10:00:00 GMT").unwrap().timestamp_millis();
        assert_eq!(parse_retry_after("Wed, 28 Oct 2026 10:05:00 GMT", now), Some(300_000));
        assert_eq!(parse_retry_after("soon", now), None);
    }

    #[test]
    fn the_panel_fills_gaps_only_when_it_agrees() {
        let api = vec![window(10.0)];
        let mut fable = window(3.0);
        fable.window_minutes = 10080;
        fable.model = Some("Fable".into());
        let panel = vec![window(10.5), fable];
        assert!(panel_agrees(&api, &panel));
        assert_eq!(merge(api.clone(), Some(&panel)).len(), 2, "the Fable week is added, the session kept");
        assert_eq!(merge(api.clone(), Some(&panel))[0].used_percent, 10.0, "the API's own figure wins");
        assert!(!panel_agrees(&api, &[window(30.0)]), "another account's numbers");
        assert!(!panel_agrees(&api, &[]), "nothing to compare");
    }

    #[test]
    fn maps_chatgpts_answer_and_its_resets() {
        let body = serde_json::json!({
            "plan_type": "plus",
            "rate_limit": {
                "primary_window": {"used_percent": 45, "limit_window_seconds": 604800, "reset_at": 1790057375},
                "secondary_window": {"used_percent": 8, "limit_window_seconds": 18000}
            },
            "rate_limit_reset_credits": {"credits": [{"status": "available"}, {"status": "used"}]}
        });
        let reading = codex_backend_reading(&body).unwrap();
        assert_eq!(reading.windows.iter().map(|w| w.window_minutes).collect::<Vec<_>>(), vec![300, 10080]);
        assert_eq!(reading.reset_credits, Some(1));
        assert!(codex_backend_reading(&serde_json::json!({"rate_limit": {}})).is_none(), "no plan, no reading");
    }

    #[test]
    fn a_rebuild_counts_only_when_codex_records_one() {
        let dir = std::env::temp_dir().join(format!("osd-backfill-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!codex_rebuilding_index(&dir), "no database");
        let db = rusqlite::Connection::open(dir.join("state_5.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE backfill_state (id INTEGER PRIMARY KEY, status TEXT); INSERT INTO backfill_state VALUES (1, 'running');").unwrap();
        assert!(codex_rebuilding_index(&dir));
        db.execute("UPDATE backfill_state SET status = 'complete'", []).unwrap();
        assert!(!codex_rebuilding_index(&dir));
    }

    #[test]
    fn sees_a_claude_running_as_a_folder() {
        let dir = std::env::temp_dir().join(format!("osd-live-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sessions")).unwrap();
        assert!(!claude_running_in(&dir));
        std::fs::write(dir.join("sessions").join("999999999.json"), "{}").unwrap();
        assert!(!claude_running_in(&dir), "a record whose process is gone");
        std::fs::write(dir.join("sessions").join(format!("{}.json", std::process::id())), "{}").unwrap();
        assert_eq!(claude_running_in(&dir), cfg!(unix));
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
        assert_eq!(apply_refreshed_token(raw, &serde_json::json!({}), 0), None);
    }

    /// The whole flow for this machine's logins, outside the app: the default
    /// Claude and Codex accounts, and an added Claude account when
    /// `OSD_TEST_CLAUDE_HOME` names its folder. Through `OSD_TEST_PROXY`.
    /// Run by hand: `cargo test --lib plan_usage::tests::live -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_whole_flow() {
        let proxy = std::env::var("OSD_TEST_PROXY").ok();
        let path = std::env::var("PATH").unwrap_or_default();
        let env_proxy = proxy.clone();
        let ctx = Ctx {
            proxy: proxy.clone(),
            probe_dir: std::env::temp_dir().join(format!("osd-probe-{}", std::process::id())),
            env: Box::new(move |kind, home| {
                let mut set = vec![("PATH".to_string(), path.clone())];
                if let Some(p) = &env_proxy {
                    set.push(("HTTPS_PROXY".into(), p.clone()));
                    set.push(("HTTP_PROXY".into(), p.clone()));
                }
                let mut unset = vec!["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_CHILD_SESSION"];
                if let Some(home) = home {
                    let (account_set, account_unset) = agent_accounts::launch_env(kind, home);
                    set.extend(account_set);
                    unset.extend(account_unset);
                }
                (set, unset)
            }),
        };
        std::fs::create_dir_all(&ctx.probe_dir).unwrap();
        let claude = super::reading(&ctx, AgentKind::Claude, None, "claude");
        eprintln!("claude: {claude:?}");
        assert!(claude.error.is_none());
        let codex = super::reading(&ctx, AgentKind::Codex, None, "codex");
        eprintln!("codex: {codex:?}");
        assert!(codex.error.is_none());
        if let Ok(home) = std::env::var("OSD_TEST_CLAUDE_HOME") {
            let added = super::reading(&ctx, AgentKind::Claude, Some(Path::new(&home)), "claude:added");
            eprintln!("added: {added:?}");
            assert!(added.error.is_none());
        }
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
