// How much of the subscription is left, asked of the provider rather than
// guessed from transcripts.
//
// Borrowed from Orca (`rate-limits/claude-oauth-usage-request.ts`,
// `rate-limits/codex-backend-usage-client.ts`). Both CLIs already hold an OAuth
// token for the user's plan, and both vendors expose the plan's own usage to
// that token, so the honest figure is one request away:
//
//   Claude  GET https://api.anthropic.com/api/oauth/usage
//           token: macOS keychain (service "Claude Code-credentials"), else
//                  ~/.claude/.credentials.json
//   Codex   GET https://chatgpt.com/backend-api/wham/usage
//           token: ~/.codex/auth.json
//
// This replaces reading the last `rate_limits` payload out of a Codex session
// file. That number was whatever the file happened to end on — a session left
// open yesterday reported yesterday's percentage for ever, which is why the
// figure was wrong rather than merely stale.
//
// Nothing here is scraped and nothing is inferred: a window is reported only if
// the provider sent it.
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use osd_core::usage::{iso8601_to_epoch_ms, RateLimitWindow};

const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
/// The provider is not the app's critical path: a slow network must never hold
/// the status bar, so the request is given a short leash and its failure is a
/// quiet absence.
const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanUsage {
    pub claude: Vec<RateLimitWindow>,
    pub codex: Vec<RateLimitWindow>,
    /// Why a plan has no windows, when the reason is knowable. A silent absence
    /// is indistinguishable from "this app cannot do that", which is what the
    /// first attempt looked like when the requests were going out unproxied.
    pub claude_error: Option<String>,
    pub codex_error: Option<String>,
}

/// Both plans' current windows. Either half may be empty — not signed in, no
/// network, a token that has expired — and an empty half simply shows no bar.
///
/// `async` so the two requests never run on the UI thread; the requests
/// themselves are blocking, like every other outbound call in this app.
#[tauri::command]
pub async fn plan_usage(app: tauri::AppHandle) -> PlanUsage {
    // THROUGH THE USER'S PROXY. The app's proxy setting used to be applied only
    // to the processes it starts, so this request — made by the app itself —
    // went direct and simply failed wherever those two hosts need a proxy to be
    // reachable. Both plans then showed no bars at all, which read as "the
    // feature does not work" rather than "the network did not answer".
    let proxy = proxy_url(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let claude = claude_windows(proxy.as_deref());
        let codex = codex_windows(proxy.as_deref());
        PlanUsage {
            claude_error: claude.as_ref().err().cloned(),
            codex_error: codex.as_ref().err().cloned(),
            claude: claude.unwrap_or_default(),
            codex: codex.unwrap_or_default(),
        }
    })
    .await
    .unwrap_or_default()
}

/// The proxy the app is configured to use, if any — the same one its sidecars
/// get, resolved by the same code, so the two never disagree.
fn proxy_url(app: &tauri::AppHandle) -> Option<String> {
    let setting = osd_core::runtime::get_proxy_setting(&crate::env_of(app)).ok()?;
    setting
        .get("effective")?
        .as_str()
        .filter(|url| !url.is_empty())
        .map(str::to_owned)
}

fn client(proxy: Option<&str>) -> Option<reqwest::blocking::Client> {
    let mut builder = reqwest::blocking::Client::builder().timeout(TIMEOUT);
    if let Some(url) = proxy {
        // A proxy that no longer parses must not take the request down with
        // it: a direct attempt is still worth making.
        if let Ok(p) = reqwest::Proxy::all(url) {
            builder = builder.proxy(p);
        }
    }
    builder.build().ok()
}

// ─── Claude ─────────────────────────────────────────────────────────

/// The token Claude Code signed in with.
///
/// Two places, because the CLI keeps it in two: the login keychain on macOS
/// (service "Claude Code-credentials", the entry Orca reads), and a file under
/// `~/.claude` where there is no keychain. Reading either needs no prompt
/// because this app is asking on behalf of the same user who granted it.
///
/// This used to shell out to `security` unconditionally. On Linux and Windows —
/// both shipped targets — that command does not exist, so every Claude plan
/// lookup failed with "could not read the keychain", which reads as a broken
/// keychain rather than as a thing this build never did. Worse, the empty
/// result then fell through to the spend figures, so a subscriber saw a dollar
/// amount computed at API rates where their quota bars belonged.
fn claude_token() -> Result<String, String> {
    let keychain = cfg!(target_os = "macos")
        .then(read_claude_keychain)
        .and_then(Result::ok);
    if let Some(token) = keychain {
        return Ok(token);
    }
    // NOT verified against a real file: this machine holds its credentials in
    // the keychain, so the path and the `claudeAiOauth` shape below are read
    // across from the keychain entry (which holds exactly this JSON) rather
    // than observed on disk. If the CLI writes something else, this returns the
    // same "not signed in" it would have anyway — it cannot report a wrong
    // number, only fail to find one.
    let home = dirs_home().ok_or("no home directory")?;
    let path = home.join(".claude").join(".credentials.json");
    let raw = std::fs::read(&path).map_err(|_| {
        if cfg!(target_os = "macos") {
            "Claude Code is not signed in on this machine".to_string()
        } else {
            "Claude Code is not signed in on this machine (looked in ~/.claude)".to_string()
        }
    })?;
    claude_token_from(&raw).ok_or_else(|| "no Claude access token in ~/.claude".into())
}

fn read_claude_keychain() -> Result<String, String> {
    let out = crate::runtime::quiet_command("security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
        .output()
        .map_err(|e| format!("could not read the keychain: {e}"))?;
    if !out.status.success() {
        return Err("Claude Code is not signed in on this machine".into());
    }
    claude_token_from(&out.stdout)
        .ok_or_else(|| "no Claude access token in the keychain".to_string())
}

/// The one shape both stores use.
fn claude_token_from(raw: &[u8]) -> Option<String> {
    serde_json::from_slice::<Value>(raw)
        .ok()?
        .get("claudeAiOauth")?
        .get("accessToken")?
        .as_str()
        .map(str::to_owned)
}

fn claude_windows(proxy: Option<&str>) -> Result<Vec<RateLimitWindow>, String> {
    let token = claude_token()?;
    let body = client(proxy)
        .ok_or("could not create an HTTP client")?
        .get(CLAUDE_USAGE_URL)
        .bearer_auth(token)
        // Orca's headers, and they matter: the endpoint answers the CLI's
        // OAuth beta, not a bare bearer request.
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("User-Agent", "claude-code/2.1.0")
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| short_error(&e))?
        .text()
        .map_err(|e| e.to_string())?;
    let json: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(claude_windows_from(&json))
}

/// One readable line, not a chain of transport internals.
fn short_error(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        return "timed out — check the proxy in Settings".into();
    }
    if e.is_connect() {
        return "could not connect — check the proxy in Settings".into();
    }
    match e.status() {
        Some(code) if code.as_u16() == 401 || code.as_u16() == 403 => {
            "signed out — sign in again in the CLI".into()
        }
        Some(code) => format!("the provider answered {code}"),
        None => e.to_string(),
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
    // The same ISO-8601 reader the transcript scanner uses, so one parser
    // covers every timestamp this app reads.
    Some(iso8601_to_epoch_ms(value.as_str()?)? / 1000)
}

// ─── Codex ──────────────────────────────────────────────────────────

fn codex_windows(proxy: Option<&str>) -> Result<Vec<RateLimitWindow>, String> {
    let home = dirs_home().ok_or("no home directory")?;
    let raw = std::fs::read(home.join(".codex").join("auth.json"))
        .map_err(|_| "Codex is not signed in on this machine".to_string())?;
    let auth: Value = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    let tokens = auth.get("tokens").ok_or("no Codex tokens on this machine")?;
    let token = tokens
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or("no Codex access token")?;
    let mut request = client(proxy)
        .ok_or("could not create an HTTP client")?
        .get(CODEX_USAGE_URL)
        .bearer_auth(token)
        .header("User-Agent", "codex-cli")
        .header("OpenAI-Beta", "codex-1")
        .header("originator", "Codex Desktop");
    if let Some(account) = tokens.get("account_id").and_then(Value::as_str) {
        request = request.header("ChatGPT-Account-Id", account);
    }
    let body = request
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| short_error(&e))?
        .text()
        .map_err(|e| e.to_string())?;
    let json: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(codex_windows_from(&json))
}

/// Map ChatGPT's answer: a primary and (on some plans) a secondary window, each
/// with the percentage used and the seconds the window spans.
pub fn codex_windows_from(body: &Value) -> Vec<RateLimitWindow> {
    let plan_type = body
        .get("plan_type")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let Some(limit) = body.get("rate_limit") else {
        return Vec::new();
    };
    let mut windows: Vec<RateLimitWindow> = ["primary_window", "secondary_window"]
        .into_iter()
        .filter_map(|key| codex_window(limit.get(key)?, plan_type.clone()))
        .collect();
    // Shortest window first, so the one that bites soonest reads first.
    windows.sort_by_key(|w| w.window_minutes);
    windows
}

fn codex_window(raw: &Value, plan_type: Option<String>) -> Option<RateLimitWindow> {
    let used_percent = raw.get("used_percent")?.as_f64()?;
    Some(RateLimitWindow {
        used_percent,
        window_minutes: raw
            .get("limit_window_seconds")
            .and_then(Value::as_u64)
            .map(|s| s / 60)
            .unwrap_or(0),
        resets_at: raw.get("reset_at").and_then(parse_reset),
        as_of_ms: now_ms(),
        plan_type,
    })
}

fn dirs_home() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(std::path::PathBuf::from)
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
        // `seven_day` missing entirely: no bar, rather than a bar reading 0%.
        let body = serde_json::json!({ "five_hour": { "utilization": 12.0 } });
        let windows = claude_windows_from(&body);
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].resets_at, None);
    }

    const CODEX_BODY: &str = r#"{
      "plan_type": "prolite",
      "rate_limit": {
        "primary_window": {"used_percent": 33, "limit_window_seconds": 604800, "reset_at": 1790057375},
        "secondary_window": null
      }
    }"#;

    #[test]
    fn reads_codexs_own_figure_rather_than_an_old_session_file() {
        let windows = codex_windows_from(&serde_json::from_str(CODEX_BODY).unwrap());
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].used_percent, 33.0);
        // 604800s is the week.
        assert_eq!(windows[0].window_minutes, 10080);
        assert_eq!(windows[0].resets_at, Some(1790057375));
        assert_eq!(windows[0].plan_type.as_deref(), Some("prolite"));
    }

    #[test]
    fn puts_the_shortest_codex_window_first() {
        let body = serde_json::json!({
            "rate_limit": {
                "primary_window": {"used_percent": 45, "limit_window_seconds": 604800},
                "secondary_window": {"used_percent": 8, "limit_window_seconds": 18000}
            }
        });
        let windows = codex_windows_from(&body);
        assert_eq!(
            windows.iter().map(|w| w.window_minutes).collect::<Vec<_>>(),
            vec![300, 10080]
        );
    }

    #[test]
    fn one_token_shape_serves_the_keychain_and_the_file() {
        // The keychain entry holds this JSON; the file store is read with the
        // same parse, so a signed-in user is found on every platform rather
        // than only where `security` exists.
        let raw = br#"{"claudeAiOauth":{"accessToken":"sk-tok","refreshToken":"r"}}"#;
        assert_eq!(claude_token_from(raw).as_deref(), Some("sk-tok"));
        // Anything else is "no token found", never a wrong one.
        assert_eq!(claude_token_from(b"not json"), None);
        assert_eq!(claude_token_from(br#"{"claudeAiOauth":{}}"#), None);
        assert_eq!(claude_token_from(br#"{"other":{"accessToken":"x"}}"#), None);
    }

    #[test]
    fn an_answer_with_no_limits_reports_nothing() {
        assert!(codex_windows_from(&serde_json::json!({ "plan_type": "free" })).is_empty());
        assert!(claude_windows_from(&serde_json::json!({})).is_empty());
    }
}
