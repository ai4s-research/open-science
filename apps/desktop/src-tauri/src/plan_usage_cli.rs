// Plan usage read through the agents' own CLIs, for when the usage endpoint
// cannot be asked directly. Ported from Orca (MIT): `claude-pty.ts`,
// `claude-pty-usage-parser.ts`, `codex-rpc-rate-limit-probe.ts`,
// `codex-pty-rate-limit-probe.ts`, `codex-pty-status-parser.ts`.
//
// Running the CLI is also how a lapsed login gets renewed: the CLI refreshes
// its own token on start, so the app never has to rotate a refresh token the
// CLI also holds. Every CLI here runs in the `LaunchEnv` it is given, which the
// caller builds with `agent_accounts::agent_env`: the user's PATH, the account's
// folder, and the app's proxy.
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::Stdio;
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use regex::Regex;
use serde_json::{json, Value};
use osd_core::agent_accounts::{AgentKind, LaunchEnv};
use osd_core::usage::RateLimitWindow;

const MAX_OUTPUT: usize = 100_000;

/// Why a CLI reading failed. `refused` (a 403 surfaced by the CLI) stops all
/// further checks of the account; `auth` means signing in again is the only fix.
#[derive(Debug, Default)]
pub struct CliFailure {
    pub message: String,
    pub refused: bool,
    pub auth: bool,
}

impl CliFailure {
    fn new(message: impl Into<String>, output: &str) -> Self {
        Self {
            message: message.into(),
            refused: is_refusal(output),
            auth: CODEX_AUTH.iter().any(|re| re.is_match(output)),
        }
    }
}

static REFUSAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b403\b|\bforbidden\b").unwrap());

/// A 403 anywhere in what the provider or the CLI said.
pub fn is_refusal(text: &str) -> bool {
    REFUSAL.is_match(text)
}

// ─── Hidden terminal ────────────────────────────────────────────────

enum Step {
    Continue,
    Done,
}

/// Run the agent's CLI on a hidden terminal in `cwd`. `step` sees the cleaned
/// output so far, the cleaned new chunk (empty on a tick) and the elapsed time,
/// may type into the terminal, and says when to stop. Returns the cleaned output.
fn run_hidden(
    env: &LaunchEnv,
    kind: AgentKind,
    args: &[&str],
    cwd: &Path,
    limit: Duration,
    mut step: impl FnMut(&str, &str, Duration, &mut dyn Write) -> Step,
) -> Result<String, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows: 40, cols: 120, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("could not open a terminal: {e}"))?;
    // A Windows npm install is a .cmd shim, which only cmd.exe can start.
    let mut cmd = if cfg!(windows) {
        let mut c = CommandBuilder::new("cmd.exe");
        c.args(["/c", kind.binary()]);
        c
    } else {
        CommandBuilder::new(kind.binary())
    };
    cmd.args(args);
    for (k, v) in &env.0 {
        cmd.env(k, v);
    }
    for k in &env.1 {
        cmd.env_remove(k);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.cwd(cwd);
    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("could not start {}: {e}", kind.binary()))?;
    drop(pair.slave);
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let (tx, rx) = channel::<String>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 || tx.send(String::from_utf8_lossy(&buf[..n]).into_owned()).is_err() {
                break;
            }
        }
    });

    // The raw stream is kept and cleaned whole, since a row can arrive split
    // across reads and a move is only read right knowing the row before it.
    let started = Instant::now();
    let mut raw = String::new();
    let mut output = String::new();
    loop {
        let elapsed = started.elapsed();
        if elapsed >= limit {
            break;
        }
        let chunk = match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(read) => {
                raw.push_str(&read);
                if raw.len() > MAX_OUTPUT {
                    let cut = raw.len() - MAX_OUTPUT;
                    let cut = (cut..raw.len()).find(|&i| raw.is_char_boundary(i)).unwrap_or(0);
                    raw.drain(..cut);
                }
                output = strip_controls(&raw);
                strip_controls(&read)
            }
            Err(RecvTimeoutError::Timeout) => String::new(),
            Err(RecvTimeoutError::Disconnected) => break, // the CLI exited
        };
        if let Step::Done = step(&output, &chunk, elapsed, &mut writer) {
            break;
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    Ok(output)
}

/// Cursor moves. Both TUIs lay text out with them instead of spaces and line
/// breaks (Claude 2.1.312 draws the gap between words as a column move, Codex
/// 0.164.0 places every cell with row;column), so a move to another row
/// becomes a line break and any other move a space.
static MOVE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b\[(\d*)(?:;(\d*))?([HfdEFABCG])").unwrap());
static OSC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\][^\x07]*(?:\x07|\x1b\\)").unwrap());
static CSI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").unwrap());

fn strip_controls(raw: &str) -> String {
    let mut row: Option<String> = None;
    let laid_out = MOVE.replace_all(raw, |m: &regex::Captures| {
        let gap = match &m[3] {
            "C" | "G" => " ",
            "H" | "f" => {
                let to = m.get(1).map_or("", |r| r.as_str()).to_string();
                let same = row.as_ref() == Some(&to);
                row = Some(to);
                if same { " " } else { "\n" }
            }
            _ => {
                row = None;
                "\n"
            }
        };
        gap.to_string()
    });
    CSI.replace_all(&OSC.replace_all(&laid_out, ""), "").into_owned()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ─── Claude: `/usage` ───────────────────────────────────────────────

const CLAUDE_STOP: &[&str] = &[
    "Current week (all models)",
    "Current week (Opus)",
    "Current week (Sonnet only)",
    "Current week (Sonnet)",
    "Weekly limits",
    "Weekly limit",
    "Weekly usage",
    "7-day",
    "Current session",
    "Failed to load usage data",
    "failed to load usage data",
];
static TRUST_PROMPT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)do you trust|trust the files|safety check|trust this folder").unwrap());
/// A CLI offering to update itself. Enter there would run the update (Codex
/// 0.164.0 preselects "Update now (runs `brew upgrade --cask codex`)"), and Esc
/// cannot be relied on to skip it (Codex reads keys in the kitty protocol, where
/// a bare ESC byte is not the Esc key). A hidden run that meets one stops at
/// once, pressing nothing.
static UPDATE_MENU: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)update now|skip until next version|update available|brew upgrade|npm install -g").unwrap()
});
/// The highlighted choice of a menu.
static SELECTED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"❯\s*(No|Yes)\b").unwrap());
static COMMAND_PALETTE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)show plan|usage limits").unwrap());
static CLAUDE_21_PANEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)settings?\s+status?\s+config\s+usage\s+stats|total\s*cost|total\s*duration|usage:\s*\d+\s*input")
        .unwrap()
});
static RATE_LIMITED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)rate limited\.?\s+please try again later").unwrap());

/// Start `claude` hidden, type `/usage`, and read the panel. Timings are Orca's:
/// 2 s for the TUI to start (its prompt is not reliably detectable), Enter
/// every 0.8 s to page through, 2 s to settle once the panel shows.
///
/// The folder-trust question defaults to "No, exit" on 2.1.312, so Orca's
/// `y` + Enter quits the CLI. It is answered by moving to Yes first, with
/// pauses, since keys sent together are read before the menu is ready. Only the
/// empty probe folder is ever trusted.
pub fn claude_usage(env: &LaunchEnv, cwd: &Path) -> Result<Vec<RateLimitWindow>, CliFailure> {
    let pause = Duration::from_millis(600);
    let mut prompt_seen: Option<Duration> = None;
    let mut arrow_at: Option<Duration> = None;
    let mut trusted_at: Option<Duration> = None;
    let mut sent_at: Option<Duration> = None;
    let mut last_enter = Duration::ZERO;
    let mut finish_at: Option<Duration> = None;
    let mut panel_21 = false;
    let output = run_hidden(env, AgentKind::Claude, &[], cwd, Duration::from_secs(30), |out, chunk, t, w| {
        if UPDATE_MENU.is_match(chunk) {
            return Step::Done;
        }
        if sent_at.is_none() && trusted_at.is_none() && TRUST_PROMPT.is_match(out) {
            let selected = SELECTED.captures_iter(out).last().map(|c| c[1].to_string());
            match (selected.as_deref(), arrow_at) {
                (Some("Yes"), _) => {
                    if arrow_at.is_none_or(|at| t >= at + pause) {
                        let _ = w.write_all(b"\r");
                        trusted_at = Some(t);
                    }
                }
                (Some(_), None) => {
                    let seen = *prompt_seen.get_or_insert(t);
                    if t >= seen + pause {
                        let _ = w.write_all(b"\x1b[B");
                        arrow_at = Some(t);
                    }
                }
                _ => {} // options not drawn yet, or the arrow not yet shown
            }
            return Step::Continue;
        }
        let Some(sent) = sent_at else {
            let ready = match trusted_at {
                Some(at) => t >= at + Duration::from_millis(2500),
                None => t >= Duration::from_secs(2),
            };
            if ready {
                let _ = w.write_all(b"/usage\r");
                sent_at = Some(t);
                last_enter = t;
            }
            return Step::Continue;
        };
        if COMMAND_PALETTE.is_match(chunk) {
            let _ = w.write_all(b"\r");
        }
        if finish_at.is_none() {
            if CLAUDE_STOP.iter().any(|s| out.contains(s)) {
                finish_at = Some(t + Duration::from_secs(2));
            } else if !panel_21 && CLAUDE_21_PANEL.is_match(out) {
                // Session stats without plan windows: give them time to load.
                panel_21 = true;
                finish_at = Some(t + Duration::from_secs(8));
            } else if !panel_21 && t >= sent && t - last_enter >= Duration::from_millis(800) {
                let _ = w.write_all(b"\r");
                last_enter = t;
            }
        }
        match finish_at {
            Some(at) if t >= at => Step::Done,
            _ => Step::Continue,
        }
    })
    .map_err(|e| CliFailure { message: e, ..Default::default() })?;

    let windows = parse_claude_usage(&output);
    if !windows.is_empty() {
        return Ok(windows);
    }
    let message = if RATE_LIMITED.is_match(&output) {
        "Claude usage is rate limited right now."
    } else if CLAUDE_21_PANEL.is_match(&output) {
        "Claude plan usage is unavailable for this Claude CLI session."
    } else {
        "Claude usage is unavailable right now."
    };
    Err(CliFailure::new(message, &output))
}

static SESSION_LABEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)current\s*session").unwrap());
static WEEKLY_LABEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:current\s*week|weekly\s*(?:limits?|usage|rate\s*limits?)|7\s*[- ]?\s*day)").unwrap()
});
static FABLE_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bfable\b").unwrap());
static PERCENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(\d{1,3})(?:\.\d+)?\s*%\s*(used|consumed|left|remaining|available)").unwrap()
});

fn is_weekly(line: &str) -> bool {
    WEEKLY_LABEL.is_match(line) && !FABLE_WORD.is_match(line)
}

fn is_section(line: &str) -> bool {
    let fable = FABLE_WORD.is_match(line) && (line.trim().eq_ignore_ascii_case("fable") || WEEKLY_LABEL.is_match(line));
    SESSION_LABEL.is_match(line) || is_weekly(line) || fable
}

/// The percentage used under the first label that has one within 12 lines,
/// stopping at the next section. "N% left" is turned into used.
fn percent_after(lines: &[&str], is_label: impl Fn(&str) -> bool) -> Option<f64> {
    for (i, line) in lines.iter().enumerate() {
        if !is_label(line) {
            continue;
        }
        for (j, candidate) in lines.iter().enumerate().skip(i).take(12) {
            if j > i && is_section(candidate) {
                break;
            }
            if let Some(m) = PERCENT.captures(candidate) {
                let pct: f64 = m[1].parse().ok()?;
                let used = matches!(m[2].to_lowercase().as_str(), "used" | "consumed");
                return Some(if used { pct } else { 100.0 - pct }.clamp(0.0, 100.0));
            }
        }
    }
    None
}

/// The five-hour and weekly windows from `/usage`. Reset times are not read
/// from the panel (Orca's 300-line reset parser was not ported), so these carry
/// none.
pub fn parse_claude_usage(output: &str) -> Vec<RateLimitWindow> {
    let lines: Vec<&str> = output.split(['\n', '\r']).collect();
    let as_of_ms = now_ms();
    let window = |used_percent: f64, window_minutes: u64| RateLimitWindow {
        used_percent,
        window_minutes,
        resets_at: None,
        as_of_ms,
        plan_type: None,
    };
    [
        percent_after(&lines, |l| SESSION_LABEL.is_match(l)).map(|p| window(p, 300)),
        percent_after(&lines, is_weekly).map(|p| window(p, 10080)),
    ]
    .into_iter()
    .flatten()
    .collect()
}

// ─── Codex: `app-server` ────────────────────────────────────────────

/// Orca's list of what Codex says when only signing in again helps.
static CODEX_AUTH: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"(?i)access token could not be refreshed",
        r"(?i)authentication session could not be refreshed",
        r"(?i)refresh token (?:has expired|was already used|was revoked)",
        r"(?i)you have since logged out or signed in to another account",
        r"(?i)please (?:log out and )?sign in again",
        r"(?i)please reauthenticate",
        r"(?i)not logged in",
        r"(?i)sign in with chatgpt",
        r"(?i)token data is not available",
        r"(?i)auth (?:is missing|tokens are missing|does not expose)",
        r"(?i)chatgpt authentication required",
    ]
    .iter()
    .map(|p| Regex::new(p).unwrap())
    .collect()
});

/// Ask `codex app-server` over JSON-RPC: `initialize`, `initialized`, then
/// `account/rateLimits/read`. Codex refreshes its own login to answer.
pub fn codex_rpc(env: &LaunchEnv, cwd: &Path) -> Result<Vec<RateLimitWindow>, CliFailure> {
    let fail = |message: String, output: &str| Err(CliFailure::new(message, output));
    let mut cmd = crate::runtime::quiet_command(AgentKind::Codex.binary());
    for (k, v) in &env.0 {
        cmd.env(k, v);
    }
    for k in &env.1 {
        cmd.env_remove(k);
    }
    cmd.arg("app-server")
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return fail("Codex CLI not found".into(), ""),
        Err(e) => return fail(format!("could not start codex: {e}"), ""),
    };
    let mut stdin = child.stdin.take().ok_or_else(|| CliFailure::new("no stdin", ""))?;
    let stdout = child.stdout.take().ok_or_else(|| CliFailure::new("no stdout", ""))?;
    let stderr_text = Arc::new(Mutex::new(String::new()));
    if let Some(mut stderr) = child.stderr.take() {
        let sink = stderr_text.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = stderr.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let mut s = sink.lock().unwrap();
                if s.len() < MAX_OUTPUT {
                    s.push_str(&String::from_utf8_lossy(&buf[..n]));
                }
            }
        });
    }
    let (tx, rx) = channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });

    let mut send = |message: Value| writeln!(stdin, "{message}").and_then(|_| stdin.flush());
    let init = json!({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                      "params": {"clientInfo": {"name": "open-science-desktop", "version": "1.0.0"}}});
    let outcome = (|| {
        send(init).map_err(|e| e.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let line = match rx.recv_timeout(left) {
                Ok(line) => line,
                Err(RecvTimeoutError::Timeout) => return Err("RPC timeout".to_string()),
                Err(RecvTimeoutError::Disconnected) => return Err("Codex RPC process exited".to_string()),
            };
            let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
            match message.get("id").and_then(Value::as_i64) {
                Some(1) => {
                    send(json!({"jsonrpc": "2.0", "method": "initialized", "params": {}})).map_err(|e| e.to_string())?;
                    send(json!({"jsonrpc": "2.0", "id": 2, "method": "account/rateLimits/read", "params": {}}))
                        .map_err(|e| e.to_string())?;
                }
                Some(2) => {
                    if let Some(error) = message.get("error") {
                        let text = error.get("message").and_then(Value::as_str).unwrap_or("Codex RPC error");
                        return Err(text.to_string());
                    }
                    return Ok(codex_rpc_windows(message.get("result").unwrap_or(&Value::Null)));
                }
                _ => {}
            }
        }
    })();
    let _ = child.kill();
    let _ = child.wait();
    let stderr = stderr_text.lock().unwrap().clone();
    outcome.map_err(|message| {
        // A refusal or a dead login can be in either stream; judge both.
        let seen = format!("{message}\n{stderr}");
        let mut failure = CliFailure::new(message, &seen);
        if failure.auth {
            failure.message = "Your ChatGPT session could not be refreshed. Please sign in again.".into();
        }
        failure
    })
}

/// Map `rateLimits` by window length: 300 minutes is the session window and
/// 10080 the week, a minute either way (older builds drift by one). A window of
/// any other length keeps Orca's legacy reading: primary is the session,
/// secondary the week.
pub fn codex_rpc_windows(result: &Value) -> Vec<RateLimitWindow> {
    let limits = result.get("rateLimits").unwrap_or(&Value::Null);
    let plan_type = limits.get("planType").and_then(Value::as_str).map(str::to_owned);
    let as_of_ms = now_ms();
    let kind_of = |minutes: Option<f64>| match minutes {
        Some(m) if (m - 300.0).abs() <= 1.0 => Some(300),
        Some(m) if (m - 10080.0).abs() <= 1.0 => Some(10080),
        _ => None,
    };
    let mut windows: Vec<RateLimitWindow> = Vec::new();
    for (key, legacy) in [("primary", 300u64), ("secondary", 10080u64)] {
        let Some(raw) = limits.get(key).filter(|v| v.is_object()) else { continue };
        let Some(used) = raw.get("usedPercent").and_then(Value::as_f64) else { continue };
        let window_minutes = kind_of(raw.get("windowDurationMins").and_then(Value::as_f64)).unwrap_or(legacy);
        if windows.iter().any(|w| w.window_minutes == window_minutes) {
            continue;
        }
        windows.push(RateLimitWindow {
            used_percent: used.clamp(0.0, 100.0),
            window_minutes,
            // Unix seconds, as Codex sends them.
            resets_at: raw.get("resetsAt").and_then(Value::as_i64).filter(|s| *s > 0),
            as_of_ms,
            plan_type: plan_type.clone(),
        });
    }
    windows.sort_by_key(|w| w.window_minutes);
    windows
}

// ─── Codex: `/status` ───────────────────────────────────────────────

/// The terminal fallback when the RPC fails for a reason other than the login:
/// type `/status`, Enter after 350 ms (it picks the command from the popup),
/// Enter again after 3 s if no limit row shows yet (it runs it), settle 1 s
/// once one does (Orca's timings). Started with the update check off, so the
/// update menu, where Enter would install an update, is never shown.
pub fn codex_status(env: &LaunchEnv, cwd: &Path) -> Result<Vec<RateLimitWindow>, CliFailure> {
    let mut typed_at: Option<Duration> = None;
    let mut enters = 0;
    let mut finish_at: Option<Duration> = None;
    let args = ["-c", "check_for_update_on_startup=false"];
    let output = run_hidden(env, AgentKind::Codex, &args, cwd, Duration::from_secs(15), |out, chunk, t, w| {
        if UPDATE_MENU.is_match(chunk) {
            return Step::Done;
        }
        let has_rows = !parse_codex_status(out).is_empty();
        match typed_at {
            None if t >= Duration::from_millis(2500) => {
                let _ = w.write_all(b"/status");
                typed_at = Some(t);
            }
            Some(at) if enters == 0 && t >= at + Duration::from_millis(350) => {
                let _ = w.write_all(b"\r");
                enters = 1;
            }
            Some(at) if enters == 1 && !has_rows && t >= at + Duration::from_millis(3350) => {
                let _ = w.write_all(b"\r");
                enters = 2;
            }
            _ => {}
        }
        if finish_at.is_none() && has_rows {
            finish_at = Some(t + Duration::from_secs(1));
        }
        match finish_at {
            Some(at) if t >= at => Step::Done,
            _ => Step::Continue,
        }
    })
    .map_err(|e| CliFailure { message: e, ..Default::default() })?;
    let windows = parse_codex_status(&output);
    if windows.is_empty() {
        return Err(CliFailure::new("Codex usage is unavailable right now.", &output));
    }
    Ok(windows)
}

// A label at the start of its row (after borders), so a model-scoped row such
// as "GPT-5 5h limit" is not read as the account's.
static CODEX_FIVE_HOUR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?im)^[\s│|>•·-]*5h\s+limit[^\d%\r\n]*(\d+)%(?:\s*(used|left))?").unwrap());
static CODEX_WEEKLY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?im)^[\s│|>•·-]*weekly\s+limit[^\d%\r\n]*(\d+)%(?:\s*(used|left))?").unwrap());

pub fn parse_codex_status(output: &str) -> Vec<RateLimitWindow> {
    let as_of_ms = now_ms();
    let read = |re: &Regex, window_minutes: u64| {
        let m = re.captures(output)?;
        let pct: f64 = m[1].parse().ok()?;
        let left = m.get(2).is_some_and(|w| w.as_str().eq_ignore_ascii_case("left"));
        Some(RateLimitWindow {
            used_percent: if left { 100.0 - pct } else { pct }.clamp(0.0, 100.0),
            window_minutes,
            resets_at: None,
            as_of_ms,
            plan_type: None,
        })
    };
    [read(&CODEX_FIVE_HOUR, 300), read(&CODEX_WEEKLY, 10080)].into_iter().flatten().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_usage_panel() {
        // Gaps drawn as column moves, as 2.1.312 does.
        let panel = "\x1b[1mCurrent\x1b[9Gsession\x1b[0m\n  ███▌  7%\x1b[12Gused\n  Resets 4pm\n\nCurrent\x1b[9Gweek (all models)\n  40% left\n";
        let windows = parse_claude_usage(&strip_controls(panel));
        assert_eq!(windows.len(), 2);
        assert_eq!((windows[0].window_minutes, windows[0].used_percent), (300, 7.0));
        assert_eq!((windows[1].window_minutes, windows[1].used_percent), (10080, 60.0));
    }

    #[test]
    fn a_fable_week_is_not_the_week() {
        let panel = "Current week (Fable)\n  90% used\nCurrent week (all models)\n  10% used\n";
        let windows = parse_claude_usage(panel);
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].used_percent, 10.0);
    }

    #[test]
    fn a_percent_belongs_to_its_own_section() {
        // The session has no figure; the week's must not be read as the session's.
        let windows = parse_claude_usage("Current session\nCurrent week (all models)\n  30% used\n");
        assert_eq!(windows.iter().map(|w| w.window_minutes).collect::<Vec<_>>(), vec![10080]);
    }

    #[test]
    fn maps_the_rpc_answer_by_window_length() {
        // Shape from a live `codex app-server` 0.164.0 answer.
        let result = json!({"rateLimits": {
            "primary": {"usedPercent": 12, "windowDurationMins": 10080, "resetsAt": 1793791186},
            "secondary": null, "planType": "prolite"}});
        let windows = codex_rpc_windows(&result);
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].window_minutes, 10080);
        assert_eq!(windows[0].used_percent, 12.0);
        assert_eq!(windows[0].resets_at, Some(1793791186));
        assert_eq!(windows[0].plan_type.as_deref(), Some("prolite"));
    }

    #[test]
    fn reads_codex_status_rows_but_not_model_rows() {
        let out = "│ 5h limit:      [████    ] 20% used │\n│ GPT-5 5h limit: 99% used │\n│ Weekly limit: [██  ] 70% left │";
        let windows = parse_codex_status(out);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].used_percent, 20.0);
        assert_eq!(windows[1].used_percent, 30.0);
    }

    /// The machine's own CLIs, default accounts, through `OSD_TEST_PROXY` when
    /// set. Run by hand: `cargo test --lib plan_usage_cli -- --ignored`.
    fn live_env() -> LaunchEnv {
        let mut set = vec![("PATH".to_string(), std::env::var("PATH").unwrap_or_default())];
        if let Ok(proxy) = std::env::var("OSD_TEST_PROXY") {
            set.push(("HTTPS_PROXY".into(), proxy.clone()));
            set.push(("HTTP_PROXY".into(), proxy));
        }
        (set, vec!["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_CHILD_SESSION"])
    }

    fn fresh_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("osd-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    #[ignore]
    fn live_claude_usage_through_a_hidden_terminal() {
        // A fresh folder, so the trust question is asked and answered.
        let windows = claude_usage(&live_env(), &fresh_dir("claude")).unwrap();
        eprintln!("{windows:?}");
        assert!(windows.iter().any(|w| w.window_minutes == 10080));
    }

    #[test]
    #[ignore]
    fn live_codex_rpc() {
        let windows = codex_rpc(&live_env(), &fresh_dir("codex")).unwrap();
        eprintln!("{windows:?}");
        assert!(!windows.is_empty());
    }

    #[test]
    #[ignore]
    fn live_codex_status_through_a_hidden_terminal() {
        let windows = codex_status(&live_env(), &fresh_dir("codex-status")).unwrap();
        eprintln!("{windows:?}");
        assert!(!windows.is_empty());
    }

    #[test]
    fn reads_codex_status_laid_out_with_cursor_moves() {
        // Codex 0.164.0: each row starts with a row move, no line breaks.
        let raw = "\x1b[12;3HSession:\x1b[12;24H01a1-e86fa\x1b[13;3HWeekly limit:\x1b[13;24H[████]100%left (resets 17:26 on 4 Nov)";
        let windows = parse_codex_status(&strip_controls(raw));
        assert_eq!(windows.len(), 1);
        assert_eq!((windows[0].window_minutes, windows[0].used_percent), (10080, 0.0));
    }

    #[test]
    fn recognizes_a_refusal_and_a_dead_login() {
        assert!(is_refusal("unexpected status 403 Forbidden"));
        assert!(!is_refusal("4030 tokens"));
        assert!(CliFailure::new("x", "Please sign in again").auth);
    }
}
