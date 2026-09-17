//! What the local agents have spent, read from the transcripts they already
//! write to disk.
//!
//! Nothing here talks to a network or to a vendor API. Claude Code and Codex
//! both log every turn's token counts next to their session history, so cost is
//! arithmetic over files the user already owns — no credentials, no scraping,
//! and it keeps working when a vendor changes an endpoint.
//!
//! The scan is shaped by two facts measured against real history on disk:
//!
//! 1. Claude streams several assistant rows per reply, sharing one message and
//!    request id, and later rows can carry more complete usage. Counting rows
//!    would multiply one reply's cost; rows are merged by that id, taking the
//!    maximum of each bucket (this is Orca's rule, MIT).
//! 2. Codex writes the SAME reply twice once it is new enough: a
//!    `token_usage_record`, and an `event_msg`/`token_count` carrying the same
//!    `last_token_usage`. Verified on a session holding both — the eight
//!    overlapping pairs matched on `total_tokens`, one for one. So a file's
//!    `token_count` events are counted only before its first
//!    `token_usage_record`, after which the records are authoritative.
//!
//! Window boundaries arrive as epoch milliseconds from the caller rather than
//! being derived here: "today" is a question about the user's timezone, which
//! the UI knows and this crate does not.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::model_prices::Prices;
use crate::usage_pricing::{claude_cost_usd, codex_cost_usd};

/// Cap on how deep a transcript directory is walked. Claude nests one level
/// (`projects/<slug>/*.jsonl`) and Codex three (`sessions/YYYY/MM/DD/*.jsonl`);
/// the cap only stops a symlink loop from walking forever.
const MAX_SCAN_DEPTH: usize = 8;

/// One agent's tokens and cost over one window.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TokenTotals {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    /// Turns whose model this build cannot price are counted in the token
    /// figures but not here, so a cost is never quietly understated as $0.
    pub cost_usd: f64,
    /// How many turns landed in `cost_usd`, and how many were left out of it.
    pub priced_turns: u64,
    pub unpriced_turns: u64,
}

impl TokenTotals {
    fn add(&mut self, turn: &Turn) {
        self.input_tokens += turn.input_tokens;
        self.output_tokens += turn.output_tokens;
        self.cache_read_tokens += turn.cache_read_tokens;
        self.cache_write_tokens += turn.cache_write_tokens;
        match turn.cost_usd {
            Some(cost) => {
                self.cost_usd += cost;
                self.priced_turns += 1;
            }
            None => self.unpriced_turns += 1,
        }
    }
}

/// One agent's usage across both windows.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    /// Stable id the UI keys its label and icon off: `claude` or `codex`.
    pub agent: String,
    pub today: TokenTotals,
    pub week: TokenTotals,
}

/// A subscription window Codex reports alongside its own session events.
///
/// Read off disk like everything else here — Codex records the percentage it
/// was told, so the number needs no credentials and no request.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitWindow {
    pub used_percent: f64,
    pub window_minutes: u64,
    /// Unix SECONDS, as Codex writes it.
    pub resets_at: Option<i64>,
    /// When the session event carrying this was written (epoch ms), so the UI
    /// can say how stale it is instead of implying it is live.
    pub as_of_ms: i64,
    pub plan_type: Option<String>,
}

/// What one conversation in this app has spent.
///
/// Sessions do not have processes of their own — every one of them runs through
/// the single agent runtime — so memory cannot be split between them. What CAN
/// be attributed is the spend, and that is the figure the question "which
/// session is costing me" is actually about.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSpend {
    pub session_id: String,
    pub week: TokenTotals,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub agents: Vec<AgentUsage>,
    /// This app's own spend, split by conversation. Heaviest first.
    pub sessions: Vec<SessionSpend>,
    /// Codex's own most recent report of its subscription windows (the hourly
    /// one and the weekly one), if any session in the scanned range carried
    /// them. Empty when no session did.
    pub codex_rate_limits: Vec<RateLimitWindow>,
    /// Files opened, and files skipped because they could hold nothing in the
    /// window. Surfaced so a suspiciously small number is debuggable.
    pub scanned_files: usize,
    pub skipped_files: usize,
    pub scan_ms: u64,
}

/// One priced turn, before it is folded into a window.
#[derive(Debug, Clone, PartialEq)]
struct Turn {
    timestamp_ms: i64,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
    cost_usd: Option<f64>,
}

/// Parse an ISO-8601 instant (`2026-09-11T17:01:25.929Z`, or with a `+HH:MM`
/// offset) to epoch milliseconds.
///
/// Hand-rolled rather than pulling in a date crate: transcripts write one
/// shape, and this is the only date arithmetic the module needs.
pub fn iso8601_to_epoch_ms(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let num = |from: usize, to: usize| value.get(from..to)?.parse::<i64>().ok();
    let (year, month, day) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (hour, minute, second) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let rest = &value[19..];
    let millis = rest
        .strip_prefix('.')
        .map(|frac| {
            let digits: String = frac.chars().take_while(char::is_ascii_digit).collect();
            // Pad or truncate to exactly three digits: `.9` is 900ms, not 9ms.
            let mut ms = digits.chars().take(3).collect::<String>();
            while ms.len() < 3 {
                ms.push('0');
            }
            ms.parse::<i64>().unwrap_or(0)
        })
        .unwrap_or(0);

    // Anything after the seconds (and optional fraction) is the zone.
    let zone = rest.trim_start_matches(|c: char| c == '.' || c.is_ascii_digit());
    let offset_minutes = match zone.as_bytes().first() {
        None | Some(b'Z') | Some(b'z') => 0,
        Some(sign @ (b'+' | b'-')) => {
            let hours = zone.get(1..3)?.parse::<i64>().ok()?;
            let mins = zone
                .get(4..6)
                .or_else(|| zone.get(3..5))
                .and_then(|m| m.parse::<i64>().ok())
                .unwrap_or(0);
            let magnitude = hours * 60 + mins;
            if *sign == b'+' {
                magnitude
            } else {
                -magnitude
            }
        }
        _ => return None,
    };

    let days = days_from_civil(year, month, day);
    let utc_seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_minutes * 60;
    Some(utc_seconds * 1_000 + millis)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's
/// `days_from_civil`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_position = (month + 9) % 12;
    let day_of_year = (153 * month_position + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn as_u64(value: Option<&Value>) -> u64 {
    value.and_then(Value::as_u64).unwrap_or(0)
}

/// Collect every `.jsonl` under `root`, newest-first by nothing in particular —
/// order does not matter, the caller sums.
fn list_jsonl_files(root: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > MAX_SCAN_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return; // A missing or unreadable agent home is "no usage", not an error.
    };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(file_type) if file_type.is_dir() => list_jsonl_files(&path, depth + 1, out),
            Ok(file_type)
                if file_type.is_file() && path.extension().is_some_and(|ext| ext == "jsonl") =>
            {
                out.push(path)
            }
            _ => {}
        }
    }
}

fn modified_ms(path: &Path) -> Option<i64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let since = modified.duration_since(UNIX_EPOCH).ok()?;
    Some(since.as_millis() as i64)
}

/// A Claude assistant row, before same-reply rows are merged.
struct ClaudeRow {
    dedupe_key: Option<String>,
    timestamp_ms: i64,
    model: Option<String>,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
    cache_write_1h_tokens: u64,
}

fn parse_claude_row(line: &str) -> Option<ClaudeRow> {
    // Only assistant rows carry usage, and transcripts interleave tool results
    // that routinely embed whole files. Reject those before paying for a parse.
    if !line.contains("assistant") {
        return None;
    }
    let value: Value = serde_json::from_str(line).ok()?;
    if value.get("type")?.as_str()? != "assistant" {
        return None;
    }
    let timestamp_ms = iso8601_to_epoch_ms(value.get("timestamp")?.as_str()?)?;
    let message = value.get("message")?;
    let usage = message.get("usage")?;

    let input_tokens = as_u64(usage.get("input_tokens"));
    let output_tokens = as_u64(usage.get("output_tokens"));
    let cache_read_tokens = as_u64(usage.get("cache_read_input_tokens"));
    let cache_write_tokens = as_u64(usage.get("cache_creation_input_tokens"));
    // Clamped so the implied 5m remainder can never go negative on a partial row.
    let cache_write_1h_tokens = usage
        .get("cache_creation")
        .map(|split| as_u64(split.get("ephemeral_1h_input_tokens")))
        .unwrap_or(0)
        .min(cache_write_tokens);

    if input_tokens + output_tokens + cache_read_tokens + cache_write_tokens == 0 {
        return None;
    }

    // Forks rewrite the session id but keep message and request ids, so prefer
    // the strongest stable identity the row offers.
    let message_id = message.get("id").and_then(Value::as_str);
    let request_id = value.get("requestId").and_then(Value::as_str);
    let dedupe_key = match (message_id, request_id) {
        (Some(message), Some(request)) => Some(format!("{message}:{request}")),
        (Some(message), None) => Some(format!("msg:{message}")),
        (None, _) => value
            .get("uuid")
            .and_then(Value::as_str)
            .map(|uuid| format!("uuid:{uuid}")),
    };

    Some(ClaudeRow {
        dedupe_key,
        timestamp_ms,
        model: message
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_owned),
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        cache_write_1h_tokens,
    })
}

/// Merge the rows of one Claude transcript into priced turns.
///
/// Public for the tests, which feed it transcript text rather than a path.
pub fn claude_turns_from_lines<S: AsRef<str>>(
    prices: &Prices,
    lines: impl Iterator<Item = S>,
) -> Vec<TurnSummary> {
    let mut merged: Vec<ClaudeRow> = Vec::new();
    let mut index_by_key: HashMap<String, usize> = HashMap::new();

    for line in lines {
        let Some(row) = parse_claude_row(line.as_ref()) else {
            continue;
        };
        if let Some(key) = row.dedupe_key.clone() {
            if let Some(&existing) = index_by_key.get(&key) {
                // Claude streams repeated rows for one reply; later rows can
                // hold more complete usage, so keep the maximum of each bucket.
                let target = &mut merged[existing];
                target.input_tokens = target.input_tokens.max(row.input_tokens);
                target.output_tokens = target.output_tokens.max(row.output_tokens);
                target.cache_read_tokens = target.cache_read_tokens.max(row.cache_read_tokens);
                target.cache_write_tokens = target.cache_write_tokens.max(row.cache_write_tokens);
                target.cache_write_1h_tokens =
                    target.cache_write_1h_tokens.max(row.cache_write_1h_tokens);
                continue;
            }
            index_by_key.insert(key, merged.len());
        }
        merged.push(row);
    }

    merged
        .into_iter()
        .map(|row| TurnSummary {
            timestamp_ms: row.timestamp_ms,
            input_tokens: row.input_tokens,
            output_tokens: row.output_tokens,
            cache_read_tokens: row.cache_read_tokens,
            cache_write_tokens: row.cache_write_tokens,
            cost_usd: claude_cost_usd(
                prices,
                row.model.as_deref(),
                row.input_tokens,
                row.output_tokens,
                row.cache_read_tokens,
                row.cache_write_tokens,
                row.cache_write_1h_tokens,
            ),
        })
        .collect()
}

/// A priced turn, exposed so tests can assert on parsing without a filesystem.
#[derive(Debug, Clone, PartialEq)]
pub struct TurnSummary {
    pub timestamp_ms: i64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub cost_usd: Option<f64>,
}

impl From<TurnSummary> for Turn {
    fn from(summary: TurnSummary) -> Self {
        Turn {
            timestamp_ms: summary.timestamp_ms,
            input_tokens: summary.input_tokens,
            output_tokens: summary.output_tokens,
            cache_read_tokens: summary.cache_read_tokens,
            cache_write_tokens: summary.cache_write_tokens,
            cost_usd: summary.cost_usd,
        }
    }
}

/// What one Codex session file yielded.
pub struct CodexFileScan {
    pub turns: Vec<TurnSummary>,
    /// The last set of subscription windows the file reported — Codex sends the
    /// hourly and the weekly window together, and both matter.
    pub rate_limits: Vec<RateLimitWindow>,
}

fn codex_usage_turn(
    prices: &Prices,
    timestamp_ms: i64,
    usage: &Value,
    model: Option<&str>,
) -> Option<TurnSummary> {
    let input_tokens = as_u64(usage.get("input_tokens"));
    let cached_input_tokens = as_u64(usage.get("cached_input_tokens"));
    let output_tokens = as_u64(usage.get("output_tokens"));
    if input_tokens + output_tokens == 0 {
        return None;
    }
    Some(TurnSummary {
        timestamp_ms,
        // Cached input is a SUBSET of input; report the uncached remainder as
        // input and the rest as a cache read so the two never double-count.
        input_tokens: input_tokens.saturating_sub(cached_input_tokens),
        output_tokens,
        cache_read_tokens: cached_input_tokens.min(input_tokens),
        cache_write_tokens: as_u64(usage.get("cache_write_input_tokens")),
        cost_usd: codex_cost_usd(prices, model, input_tokens, cached_input_tokens, output_tokens),
    })
}

/// Codex reports TWO windows on every `rate_limits` payload — `primary` (a few
/// hours) and `secondary` (the week). Verified on real sessions:
///
/// ```text
/// "primary":   {"used_percent":0.0,"window_minutes":300,  "resets_at":...}
/// "secondary": {"used_percent":0.0,"window_minutes":10080,"resets_at":...}
/// ```
///
/// Fenced as `text`, not indented: an indented block is a Rust doctest, so this
/// JSON was compiled as code and `cargo test --workspace` has been failing on
/// it. Nothing caught that because CI only builds.
///
/// Reading only `primary` threw the weekly quota away — the one a subscriber
/// actually runs out of.
fn parse_codex_rate_limits(payload: &Value, timestamp_ms: i64) -> Vec<RateLimitWindow> {
    let Some(limits) = payload.get("rate_limits") else {
        return Vec::new();
    };
    let plan_type = limits
        .get("plan_type")
        .and_then(Value::as_str)
        .map(str::to_owned);
    ["primary", "secondary"]
        .iter()
        .filter_map(|key| {
            let w = limits.get(key)?;
            Some(RateLimitWindow {
                used_percent: w.get("used_percent")?.as_f64()?,
                window_minutes: as_u64(w.get("window_minutes")),
                resets_at: w.get("resets_at").and_then(Value::as_i64),
                as_of_ms: timestamp_ms,
                plan_type: plan_type.clone(),
            })
        })
        .collect()
}

/// Read one Codex session file's lines into priced turns.
///
/// Public for the tests. See the module note on why `token_count` events stop
/// counting once the file starts writing `token_usage_record` rows.
pub fn codex_scan_from_lines<S: AsRef<str>>(
    prices: &Prices,
    lines: impl Iterator<Item = S>,
) -> CodexFileScan {
    let mut model: Option<String> = None;
    let mut records: Vec<TurnSummary> = Vec::new();
    let mut events: Vec<TurnSummary> = Vec::new();
    let mut seen_response_ids: HashMap<String, ()> = HashMap::new();
    let mut first_record_ms: Option<i64> = None;
    let mut rate_limits: Vec<RateLimitWindow> = Vec::new();

    for line in lines {
        let Ok(value) = serde_json::from_str::<Value>(line.as_ref()) else {
            continue;
        };
        let Some(kind) = value.get("type").and_then(Value::as_str) else {
            continue;
        };
        let payload = value.get("payload");
        let timestamp_ms = value
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(iso8601_to_epoch_ms);

        match kind {
            // The model in force for the turns that follow.
            "turn_context" => {
                if let Some(name) = payload.and_then(|p| p.get("model")).and_then(Value::as_str) {
                    model = Some(name.to_owned());
                }
            }
            "token_usage_record" => {
                let (Some(payload), Some(timestamp_ms)) = (payload, timestamp_ms) else {
                    continue;
                };
                first_record_ms =
                    Some(first_record_ms.map_or(timestamp_ms, |first| first.min(timestamp_ms)));
                // `response_id` makes a retry or a replayed tail idempotent.
                if let Some(response_id) = payload.get("response_id").and_then(Value::as_str) {
                    if seen_response_ids
                        .insert(response_id.to_owned(), ())
                        .is_some()
                    {
                        continue;
                    }
                }
                if let Some(turn) = payload
                    .get("usage")
                    .and_then(|usage| codex_usage_turn(prices, timestamp_ms, usage, model.as_deref()))
                {
                    records.push(turn);
                }
            }
            "event_msg" => {
                let (Some(payload), Some(timestamp_ms)) = (payload, timestamp_ms) else {
                    continue;
                };
                if payload.get("type").and_then(Value::as_str) != Some("token_count") {
                    continue;
                }
                let windows = parse_codex_rate_limits(payload, timestamp_ms);
                // Keep the newest report in the file, as one set: the two
                // windows are read from the same payload and must not be mixed
                // across payloads.
                if !windows.is_empty()
                    && rate_limits
                        .first()
                        .is_none_or(|current| windows[0].as_of_ms >= current.as_of_ms)
                {
                    rate_limits = windows;
                }
                // `last_token_usage` is Codex's own per-turn delta, so the
                // cumulative `total_token_usage` never needs differencing.
                if let Some(turn) = payload
                    .get("info")
                    .and_then(|info| info.get("last_token_usage"))
                    .and_then(|usage| codex_usage_turn(prices, timestamp_ms, usage, model.as_deref()))
                {
                    events.push(turn);
                }
            }
            _ => {}
        }
    }

    // Both shapes describe the same replies once the newer one appears.
    let cutoff = first_record_ms;
    let mut turns = records;
    turns.extend(
        events
            .into_iter()
            .filter(|turn| cutoff.is_none_or(|first| turn.timestamp_ms < first)),
    );

    CodexFileScan { turns, rate_limits }
}

fn scan_agent<F>(
    root: &Path,
    week_start_ms: i64,
    today_start_ms: i64,
    stats: &mut (usize, usize),
    mut read_file: F,
) -> (TokenTotals, TokenTotals, Vec<RateLimitWindow>)
where
    F: FnMut(&Path) -> CodexFileScan,
{
    let mut files = Vec::new();
    list_jsonl_files(root, 0, &mut files);

    let mut today = TokenTotals::default();
    let mut week = TokenTotals::default();
    let mut rate_limits: Vec<RateLimitWindow> = Vec::new();

    for path in files {
        // A file untouched since before the window cannot hold a turn inside it.
        // This is what keeps a scan of hundreds of transcripts cheap.
        if modified_ms(&path).is_some_and(|mtime| mtime < week_start_ms) {
            stats.1 += 1;
            continue;
        }
        stats.0 += 1;
        let scan = read_file(&path);
        if !scan.rate_limits.is_empty()
            && rate_limits
                .first()
                .is_none_or(|current| scan.rate_limits[0].as_of_ms >= current.as_of_ms)
        {
            rate_limits = scan.rate_limits;
        }
        for summary in scan.turns {
            let turn: Turn = summary.into();
            if turn.timestamp_ms < week_start_ms {
                continue;
            }
            week.add(&turn);
            if turn.timestamp_ms >= today_start_ms {
                today.add(&turn);
            }
        }
    }

    (today, week, rate_limits)
}

/// Stream a transcript's lines. A transcript can be hundreds of megabytes, so
/// it is never held in memory whole; an unreadable file yields nothing.
fn stream_lines(path: &Path) -> impl Iterator<Item = String> {
    File::open(path)
        .ok()
        .into_iter()
        .flat_map(|file| BufReader::new(file).lines().map_while(Result::ok))
}

/// The user's home directory, where both agents keep their history.
pub fn agent_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Scan every local agent transcript under `home` and total the two windows.
///
/// `runtime_root` is this app's own runtime directory, whose bundled OpenCode
/// database holds the turns the workbench itself ran; the two CLI scanners
/// cover work done outside it. `today_start_ms` and `week_start_ms` are epoch
/// milliseconds, computed by the caller in the user's own timezone.
pub fn collect_usage(
    home: &Path,
    runtime_root: Option<&Path>,
    today_start_ms: i64,
    week_start_ms: i64,
) -> UsageSummary {
    let started = SystemTime::now();
    // Prices come from the catalog the runtime already caches; read once for the
    // whole scan rather than per file. Absent, every lookup falls back to the
    // built-in table (`usage_pricing`).
    let prices = Prices::load(runtime_root);
    let mut stats = (0usize, 0usize);
    let mut agents = Vec::new();
    let mut sessions = Vec::new();

    // This app's own turns lead: a reader asking what the workbench costs is
    // asking about this row, and the CLI rows below it are other tools' work on
    // the same machine.
    if let Some(workbench) =
        runtime_root.and_then(|root| collect_workbench_usage(root, today_start_ms, week_start_ms))
    {
        agents.push(workbench);
    }
    if let Some(root) = runtime_root {
        sessions = collect_session_spend(root, week_start_ms);
    }

    let (claude_today, claude_week, _) = scan_agent(
        &home.join(".claude").join("projects"),
        week_start_ms,
        today_start_ms,
        &mut stats,
        |path| CodexFileScan {
            turns: claude_turns_from_lines(&prices, stream_lines(path)),
            rate_limits: Vec::new(),
        },
    );
    if claude_week != TokenTotals::default() {
        agents.push(AgentUsage {
            agent: "claude".to_owned(),
            today: claude_today,
            week: claude_week,
        });
    }

    let (codex_today, codex_week, codex_rate_limits) = scan_agent(
        &home.join(".codex").join("sessions"),
        week_start_ms,
        today_start_ms,
        &mut stats,
        |path| codex_scan_from_lines(&prices, stream_lines(path)),
    );
    if codex_week != TokenTotals::default() {
        agents.push(AgentUsage {
            agent: "codex".to_owned(),
            today: codex_today,
            week: codex_week,
        });
    }

    UsageSummary {
        agents,
        sessions,
        codex_rate_limits,
        scanned_files: stats.0,
        skipped_files: stats.1,
        scan_ms: started.elapsed().map(|d| d.as_millis() as u64).unwrap_or(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(text: &str) -> Vec<&str> {
        text.trim().lines().collect()
    }

    #[test]
    fn parses_the_timestamp_shape_transcripts_actually_write() {
        // 2026-09-11T17:01:25.929Z, taken from a real Claude transcript row.
        let ms = iso8601_to_epoch_ms("2026-09-11T17:01:25.929Z").unwrap();
        assert_eq!(
            ms, 1_789_146_085_929,
            "checked against a calendar, not against this parser"
        );
        // The epoch itself, and a fraction shorter than three digits.
        assert_eq!(iso8601_to_epoch_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(iso8601_to_epoch_ms("1970-01-01T00:00:00.5Z"), Some(500));
        // An offset moves the instant the other way.
        assert_eq!(
            iso8601_to_epoch_ms("1970-01-01T08:00:00+08:00"),
            Some(0),
            "+08:00 08:00 is the epoch"
        );
        assert_eq!(iso8601_to_epoch_ms("not a date"), None);
    }

    #[test]
    fn one_reply_streamed_as_several_rows_is_counted_once() {
        // Same message and request id; the later row carries the fuller usage.
        let transcript = r#"
{"type":"assistant","timestamp":"2026-09-11T17:01:25.929Z","requestId":"req_1","message":{"id":"msg_1","model":"claude-sonnet-4-6","usage":{"input_tokens":10,"output_tokens":5}}}
{"type":"assistant","timestamp":"2026-09-11T17:01:26.100Z","requestId":"req_1","message":{"id":"msg_1","model":"claude-sonnet-4-6","usage":{"input_tokens":10,"output_tokens":40}}}
"#;
        let turns = claude_turns_from_lines(&Prices::empty(), lines(transcript).into_iter());
        assert_eq!(turns.len(), 1, "one reply, one turn");
        assert_eq!(turns[0].output_tokens, 40, "the fuller row wins");
        assert_eq!(turns[0].input_tokens, 10);
    }

    #[test]
    fn distinct_replies_are_not_merged() {
        let transcript = r#"
{"type":"assistant","timestamp":"2026-09-11T17:01:25.929Z","requestId":"req_1","message":{"id":"msg_1","model":"claude-sonnet-4-6","usage":{"input_tokens":10,"output_tokens":5}}}
{"type":"assistant","timestamp":"2026-09-11T17:02:25.929Z","requestId":"req_2","message":{"id":"msg_2","model":"claude-sonnet-4-6","usage":{"input_tokens":10,"output_tokens":5}}}
"#;
        assert_eq!(
            claude_turns_from_lines(&Prices::empty(), lines(transcript).into_iter()).len(),
            2
        );
    }

    #[test]
    fn non_assistant_rows_and_empty_usage_are_ignored() {
        let transcript = r#"
{"type":"user","timestamp":"2026-09-11T17:01:25.929Z","message":{"content":"assistant mentioned here"}}
{"type":"assistant","timestamp":"2026-09-11T17:01:25.929Z","message":{"id":"m","model":"claude-sonnet-4-6","usage":{"input_tokens":0,"output_tokens":0}}}
not json at all
"#;
        assert!(claude_turns_from_lines(&Prices::empty(), lines(transcript).into_iter()).is_empty());
    }

    #[test]
    fn the_one_hour_cache_split_is_read_and_clamped() {
        // ephemeral_1h exceeds the total write — a partial row must not make the
        // implied 5m remainder negative.
        let transcript = r#"
{"type":"assistant","timestamp":"2026-09-11T17:01:25.929Z","message":{"id":"m","model":"claude-opus-5","usage":{"input_tokens":1,"cache_creation_input_tokens":100,"cache_creation":{"ephemeral_1h_input_tokens":999}}}}
"#;
        let turns = claude_turns_from_lines(&Prices::empty(), lines(transcript).into_iter());
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].cache_write_tokens, 100);
        assert!(turns[0].cost_usd.is_some_and(|cost| cost > 0.0));
    }

    #[test]
    fn codex_counts_its_own_per_turn_delta_not_the_running_total() {
        // Two events whose cumulative totals grow; only the deltas are billed.
        let session = r#"
{"type":"turn_context","timestamp":"2026-07-25T17:11:00.000Z","payload":{"model":"gpt-5.1-codex"}}
{"type":"event_msg","timestamp":"2026-07-25T17:11:24.844Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":22804,"output_tokens":286},"last_token_usage":{"input_tokens":22804,"cached_input_tokens":0,"output_tokens":286}}}}
{"type":"event_msg","timestamp":"2026-07-25T17:11:39.371Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":54692,"output_tokens":558},"last_token_usage":{"input_tokens":31888,"cached_input_tokens":22272,"output_tokens":272}}}}
"#;
        let scan = codex_scan_from_lines(&Prices::empty(), lines(session).into_iter());
        assert_eq!(scan.turns.len(), 2);
        let billed_input: u64 = scan.turns.iter().map(|t| t.input_tokens).sum();
        let cached: u64 = scan.turns.iter().map(|t| t.cache_read_tokens).sum();
        // 22804 uncached, then 31888 of which 22272 was cached.
        assert_eq!(billed_input, 22804 + (31888 - 22272));
        assert_eq!(cached, 22272);
    }

    #[test]
    fn codex_does_not_bill_the_same_reply_twice() {
        // The overlap measured on a real session: once a file writes
        // `token_usage_record`, its `token_count` events repeat the same reply.
        let session = r#"
{"type":"turn_context","timestamp":"2026-09-07T16:00:00.000Z","payload":{"model":"gpt-5.6-sol"}}
{"type":"event_msg","timestamp":"2026-09-07T16:00:10.000Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1000,"output_tokens":100}}}}
{"type":"token_usage_record","timestamp":"2026-09-07T16:22:11.563Z","payload":{"response_id":"resp_a","usage":{"input_tokens":2000,"output_tokens":200}}}
{"type":"event_msg","timestamp":"2026-09-07T16:22:11.565Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":2000,"output_tokens":200}}}}
"#;
        let scan = codex_scan_from_lines(&Prices::empty(), lines(session).into_iter());
        assert_eq!(scan.turns.len(), 2, "the duplicated pair counts once");
        let output: u64 = scan.turns.iter().map(|t| t.output_tokens).sum();
        assert_eq!(output, 300, "100 from before the cutover, 200 after");
    }

    #[test]
    fn a_repeated_response_id_is_idempotent() {
        let session = r#"
{"type":"token_usage_record","timestamp":"2026-09-07T16:22:11.563Z","payload":{"response_id":"resp_a","usage":{"input_tokens":2000,"output_tokens":200}}}
{"type":"token_usage_record","timestamp":"2026-09-07T16:22:12.000Z","payload":{"response_id":"resp_a","usage":{"input_tokens":2000,"output_tokens":200}}}
"#;
        assert_eq!(
            codex_scan_from_lines(&Prices::empty(), lines(session).into_iter())
                .turns
                .len(),
            1
        );
    }

    #[test]
    fn codex_reports_the_subscription_window_it_recorded() {
        let session = r#"
{"type":"event_msg","timestamp":"2026-07-25T17:11:24.844Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1,"output_tokens":1}},"rate_limits":{"primary":{"used_percent":49.0,"window_minutes":10080,"resets_at":1785259461},"plan_type":"prolite"}}}
{"type":"event_msg","timestamp":"2026-07-25T18:11:24.844Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1,"output_tokens":1}},"rate_limits":{"primary":{"used_percent":52.5,"window_minutes":10080,"resets_at":1785259461},"plan_type":"prolite"}}}
"#;
        let windows = codex_scan_from_lines(&Prices::empty(), lines(session).into_iter()).rate_limits;
        assert_eq!(windows.len(), 1, "this session reports only a primary window");
        assert_eq!(windows[0].used_percent, 52.5, "the newest report in the file");
        assert_eq!(windows[0].window_minutes, 10080);
        assert_eq!(windows[0].plan_type.as_deref(), Some("prolite"));
    }

    // Real sessions carry BOTH windows on one payload — verified against
    // ~/.codex/sessions: primary is the few-hour window, secondary the week.
    // Reading only `primary` dropped the quota a subscriber actually runs out
    // of.
    #[test]
    fn codex_reports_the_hourly_and_the_weekly_window_together() {
        let session = r#"
{"type":"event_msg","timestamp":"2026-07-25T18:11:24.844Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1,"output_tokens":1}},"rate_limits":{"primary":{"used_percent":8.0,"window_minutes":300,"resets_at":1789539196},"secondary":{"used_percent":45.0,"window_minutes":10080,"resets_at":1790125996},"plan_type":"pro"}}}
"#;
        let windows = codex_scan_from_lines(&Prices::empty(), lines(session).into_iter()).rate_limits;
        assert_eq!(windows.len(), 2);
        assert_eq!((windows[0].used_percent, windows[0].window_minutes), (8.0, 300));
        assert_eq!((windows[1].used_percent, windows[1].window_minutes), (45.0, 10080));
        // The plan is reported once, beside the windows, and belongs to both.
        assert!(windows.iter().all(|w| w.plan_type.as_deref() == Some("pro")));
    }

    // One payload's windows are kept as a SET: a later payload replaces both,
    // never leaving an hourly figure from one moment beside a weekly from
    // another.
    #[test]
    fn a_newer_report_replaces_both_windows_at_once() {
        let session = r#"
{"type":"event_msg","timestamp":"2026-07-25T17:11:24.844Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1,"output_tokens":1}},"rate_limits":{"primary":{"used_percent":1.0,"window_minutes":300,"resets_at":1},"secondary":{"used_percent":2.0,"window_minutes":10080,"resets_at":2}}}}
{"type":"event_msg","timestamp":"2026-07-25T18:11:24.844Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1,"output_tokens":1}},"rate_limits":{"primary":{"used_percent":9.0,"window_minutes":300,"resets_at":3},"secondary":{"used_percent":9.5,"window_minutes":10080,"resets_at":4}}}}
"#;
        let windows = codex_scan_from_lines(&Prices::empty(), lines(session).into_iter()).rate_limits;
        assert_eq!(
            windows.iter().map(|w| w.used_percent).collect::<Vec<_>>(),
            vec![9.0, 9.5]
        );
    }

    #[test]
    fn an_unpriced_model_is_counted_in_tokens_but_not_in_cost() {
        let transcript = r#"
{"type":"assistant","timestamp":"2026-09-11T17:01:25.929Z","message":{"id":"m","model":"some-local-llama","usage":{"input_tokens":1000,"output_tokens":100}}}
"#;
        let turns = claude_turns_from_lines(&Prices::empty(), lines(transcript).into_iter());
        assert_eq!(turns[0].cost_usd, None);
        let mut totals = TokenTotals::default();
        totals.add(&turns[0].clone().into());
        assert_eq!(totals.input_tokens, 1000);
        assert_eq!(totals.cost_usd, 0.0);
        assert_eq!(totals.unpriced_turns, 1, "surfaced, not silently zero");
    }

    #[test]
    fn a_missing_agent_home_is_no_usage_rather_than_an_error() {
            let summary = collect_usage(Path::new("/nonexistent-home-for-tests"), None, 0, 0);
        assert!(summary.agents.is_empty());
        assert_eq!(summary.scanned_files, 0);
    }
}

// ─── What this workbench itself spent ────────────────────────────────────
//
// Separate from the two scanners above, and the reason they were not enough:
// those read the Claude Code and Codex CLIs' own transcripts, which record work
// done in a terminal — usage this app neither caused nor can see. The app's own
// runtime keeps its turns in the bundled OpenCode's SQLite database, so a figure
// meant to answer "what did this workbench cost me" has to come from here.

/// Where the bundled runtime keeps its turns, relative to the runtime root.
const WORKBENCH_DB: [&str; 3] = ["xdg-data", "opencode", "opencode.db"];

/// Assistant turns the workbench ran, totalled into the two windows.
///
/// Cost is OpenCode's own figure, used only when it is above zero: it fills
/// `cost` for providers whose prices it knows (measured on a real database:
/// xAI and DeepSeek carry costs, a subscription provider carries zeros) and
/// leaves zero otherwise. Pricing those zeros from our own table would invent a
/// charge for a plan the user may already pay flat — so they count as tokens
/// and as `unpriced_turns`, never as $0.00.
/// The same turns, grouped by the conversation that ran them.
///
/// One extra pass over the same table rather than a join in the totals query:
/// the two answer different questions, and keeping them apart means the total
/// can never disagree with itself because of a grouping mistake.
pub fn collect_session_spend(runtime_root: &Path, week_start_ms: i64) -> Vec<SessionSpend> {
    let db = WORKBENCH_DB.iter().fold(runtime_root.to_path_buf(), |p, part| p.join(part));
    if !db.exists() {
        return Vec::new();
    }
    let Ok(connection) = rusqlite::Connection::open_with_flags(
        &db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    ) else {
        return Vec::new();
    };
    let Ok(mut statement) = connection.prepare(
        "SELECT json_extract(data,'$.sessionID'), \
                json_extract(data,'$.time.created'), \
                json_extract(data,'$.cost'), \
                json_extract(data,'$.tokens.input'), \
                json_extract(data,'$.tokens.output'), \
                json_extract(data,'$.tokens.cache.read'), \
                json_extract(data,'$.tokens.cache.write') \
         FROM message \
         WHERE json_extract(data,'$.role') = 'assistant' \
           AND json_extract(data,'$.time.created') >= ?1",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = statement.query_map([week_start_ms], |row| {
        Ok((
            row.get::<_, Option<String>>(0)?.unwrap_or_default(),
            Turn {
                timestamp_ms: row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                input_tokens: row.get::<_, Option<i64>>(3)?.unwrap_or(0).max(0) as u64,
                output_tokens: row.get::<_, Option<i64>>(4)?.unwrap_or(0).max(0) as u64,
                cache_read_tokens: row.get::<_, Option<i64>>(5)?.unwrap_or(0).max(0) as u64,
                cache_write_tokens: row.get::<_, Option<i64>>(6)?.unwrap_or(0).max(0) as u64,
                cost_usd: row.get::<_, Option<f64>>(2)?.filter(|cost| *cost > 0.0),
            },
        ))
    }) else {
        return Vec::new();
    };

    let mut by_session: HashMap<String, TokenTotals> = HashMap::new();
    for (session_id, turn) in rows.flatten() {
        if session_id.is_empty() {
            continue;
        }
        by_session.entry(session_id).or_default().add(&turn);
    }
    let mut spend: Vec<SessionSpend> = by_session
        .into_iter()
        .map(|(session_id, week)| SessionSpend { session_id, week })
        .collect();
    // Heaviest first: the conversation worth looking at is the first one read.
    spend.sort_by(|a, b| {
        b.week
            .cost_usd
            .partial_cmp(&a.week.cost_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| total_tokens(&b.week).cmp(&total_tokens(&a.week)))
    });
    spend
}

/// Every token a window holds, however it was billed.
fn total_tokens(totals: &TokenTotals) -> u64 {
    totals.input_tokens + totals.output_tokens + totals.cache_read_tokens + totals.cache_write_tokens
}

pub fn collect_workbench_usage(
    runtime_root: &Path,
    today_start_ms: i64,
    week_start_ms: i64,
) -> Option<AgentUsage> {
    let db = WORKBENCH_DB.iter().fold(runtime_root.to_path_buf(), |p, part| p.join(part));
    if !db.exists() {
        return None;
    }
    // Read-only: the app's own sidecar has this database open, and a reader must
    // never be the reason a turn fails to write.
    let connection = rusqlite::Connection::open_with_flags(
        &db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .ok()?;

    // The window filter runs in SQLite rather than in Rust so a long-lived
    // database is not pulled through JSON parsing row by row.
    let mut statement = connection
        .prepare(
            "SELECT json_extract(data,'$.time.created'), \
                    json_extract(data,'$.cost'), \
                    json_extract(data,'$.tokens.input'), \
                    json_extract(data,'$.tokens.output'), \
                    json_extract(data,'$.tokens.cache.read'), \
                    json_extract(data,'$.tokens.cache.write') \
             FROM message \
             WHERE json_extract(data,'$.role') = 'assistant' \
               AND json_extract(data,'$.time.created') >= ?1",
        )
        .ok()?;

    let rows = statement
        .query_map([week_start_ms], |row| {
            Ok(Turn {
                timestamp_ms: row.get::<_, Option<i64>>(0)?.unwrap_or(0),
                // Cache reads are billed apart from fresh input, and OpenCode
                // reports input EXCLUSIVE of them — so they are added, not split
                // out of, the input figure (the opposite of Codex's shape).
                input_tokens: row.get::<_, Option<i64>>(2)?.unwrap_or(0).max(0) as u64,
                output_tokens: row.get::<_, Option<i64>>(3)?.unwrap_or(0).max(0) as u64,
                cache_read_tokens: row.get::<_, Option<i64>>(4)?.unwrap_or(0).max(0) as u64,
                cache_write_tokens: row.get::<_, Option<i64>>(5)?.unwrap_or(0).max(0) as u64,
                cost_usd: row.get::<_, Option<f64>>(1)?.filter(|cost| *cost > 0.0),
            })
        })
        .ok()?;

    let mut today = TokenTotals::default();
    let mut week = TokenTotals::default();
    for turn in rows.flatten() {
        week.add(&turn);
        if turn.timestamp_ms >= today_start_ms {
            today.add(&turn);
        }
    }
    if week == TokenTotals::default() {
        return None;
    }
    Some(AgentUsage {
        agent: WORKBENCH_AGENT.to_owned(),
        today,
        week,
    })
}

/// The id the UI keys the workbench's own row off.
pub const WORKBENCH_AGENT: &str = "workbench";
