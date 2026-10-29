// Reset times read off a CLI's usage panel: "Resets 11:10pm
// (America/Los_Angeles)", "Resets Nov 1 at 3pm (America/Los_Angeles)",
// "resets 17:26 on 4 Nov", "Resets in 2h 5m". Ported from Orca (MIT):
// `claude-pty-reset-parser.ts` and `time-zone-wall-clock.ts`.
//
// One difference: Orca reads a weekday or a bare time in the machine's zone even
// when the panel names another; here the named zone is used wherever one is
// given, so the reset is right when the two differ.
use std::sync::LazyLock;

use chrono::{DateTime, Datelike, Duration, LocalResult, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use regex::Regex;

const MONTHS: &str = r"jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("static pattern")
}

static RESET_LINE: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)resets?\s+(?:at\s+|in\s+)?(.+)"));
/// "Nov1 at 3pm" as the TUI sometimes draws it; the character after the day
/// is captured and put back, standing in for Orca's lookahead.
static MONTH_DAY_COMPACT: LazyLock<Regex> =
    LazyLock::new(|| re(&format!(r"(?i)\b({MONTHS})(\d{{1,2}})(\s*at\s*\d|\D|$)")));
static DAY_AT_TIME: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)(\d{1,2})\s*at\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm))"));
static TIME_BEFORE_ZONE: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)(\d)(am|pm)\("));
static MONTH_DAY_TIME: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(r"(?i)\b({MONTHS})\.?\s+(\d{{1,2}})(?:,?\s*(?:at\s+)?)?(\d{{1,2}})(?::(\d{{2}}))?\s*(am|pm)\b"))
});
static WEEKDAY_TIME: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?i)\b(sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)\.?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b")
});
static TIME_ONLY: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b"));
/// Newer Codex prints 24-hour times ("10:21 on 28 Jul").
static TIME_24H: LazyLock<Regex> = LazyLock::new(|| re(r"\b(\d{1,2}):(\d{2})\b"));
static DAY_MONTH: LazyLock<Regex> = LazyLock::new(|| re(&format!(r"(?i)\b(?:on\s+)?(\d{{1,2}})\s+({MONTHS})\b")));
static RELATIVE: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)^(?:\s*\d+\s*(?:d(?:ays?)?|h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?)\s*)+$"));
static RELATIVE_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)(\d+)\s*(d(?:ays?)?|h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?)"));
static ZONE: LazyLock<Regex> = LazyLock::new(|| re(r"\(([^()]*)\)?\s*$"));
static TRAILING_ZONE: LazyLock<Regex> = LazyLock::new(|| re(r"\s*\([^)]*\)?\s*$"));
static TRAILING_BORDER: LazyLock<Regex> = LazyLock::new(|| re(r"[)\s│]+$"));
static SPACES: LazyLock<Regex> = LazyLock::new(|| re(r"\s+"));

/// The reset under the first label that has one within 14 lines, stopping at
/// the next section, as unix SECONDS.
pub fn reset_after(lines: &[&str], is_label: impl Fn(&str) -> bool, is_section: impl Fn(&str) -> bool) -> Option<i64> {
    reset_after_at(lines, is_label, is_section, Utc::now())
}

fn reset_after_at(
    lines: &[&str],
    is_label: impl Fn(&str) -> bool,
    is_section: impl Fn(&str) -> bool,
    now: DateTime<Utc>,
) -> Option<i64> {
    for (i, line) in lines.iter().enumerate() {
        if !is_label(line) {
            continue;
        }
        for (j, candidate) in lines.iter().enumerate().skip(i).take(14) {
            if j > i && is_section(candidate) {
                break;
            }
            if let Some(m) = RESET_LINE.captures(candidate) {
                return parse_reset(&normalize(&m[1]), now);
            }
        }
    }
    None
}

fn normalize(raw: &str) -> String {
    let text = TRAILING_BORDER.replace(raw.trim(), "");
    let text = SPACES.replace_all(&text, " ");
    let text = MONTH_DAY_COMPACT.replace(&text, "$1 $2$3");
    let text = DAY_AT_TIME.replace(&text, "$1 at $2");
    TIME_BEFORE_ZONE.replace_all(&text, "$1$2 (").into_owned()
}

/// Orca's order: relative, month and day, weekday, a bare 12-hour time, a
/// 24-hour time.
fn parse_reset(text: &str, now: DateTime<Utc>) -> Option<i64> {
    let zone = ZONE.captures(text).and_then(|m| m[1].trim().parse::<Tz>().ok());
    let bare = TRAILING_ZONE.replace(text, "").trim().to_string();
    let at = relative(text, now)
        .or_else(|| month_day(&bare, zone, now))
        .or_else(|| weekday(&bare, zone, now))
        .or_else(|| time_only(&bare, zone, now))
        .or_else(|| twenty_four_hour(&bare, zone, now))?;
    Some(at.timestamp())
}

fn relative(text: &str, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    if !RELATIVE.is_match(text) {
        return None;
    }
    let minutes: i64 = RELATIVE_TOKEN
        .captures_iter(text)
        .filter_map(|m| {
            let amount: i64 = m[1].parse().ok()?;
            Some(match m[2].to_lowercase().chars().next()? {
                'd' => amount * 24 * 60,
                'h' => amount * 60,
                _ => amount,
            })
        })
        .sum();
    (minutes > 0).then(|| now + Duration::minutes(minutes))
}

fn month_index(name: &str) -> Option<u32> {
    let key: String = name.to_lowercase().chars().take(3).collect();
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
        .iter()
        .position(|m| *m == key)
        .map(|i| i as u32 + 1)
}

fn weekday_index(name: &str) -> Option<u32> {
    let key: String = name.to_lowercase().chars().take(3).collect();
    ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].iter().position(|d| *d == key).map(|i| i as u32)
}

/// 12-hour to 24-hour; None for an hour outside 1–12.
fn hour_24(hour: &str, period: &str) -> Option<u32> {
    let hour: u32 = hour.parse().ok()?;
    if !(1..=12).contains(&hour) {
        return None;
    }
    let pm = period.eq_ignore_ascii_case("pm");
    Some(match (hour, pm) {
        (12, false) => 0,
        (12, true) => 12,
        (h, true) => h + 12,
        (h, false) => h,
    })
}

fn minute_of(m: Option<regex::Match>) -> Option<u32> {
    let minute = m.map_or(Some(0), |m| m.as_str().parse().ok())?;
    (minute < 60).then_some(minute)
}

/// A wall-clock time in `zone` (None: this machine's) as an instant. A time a
/// clock change skips does not exist and gives None; one it repeats takes the
/// earlier.
fn wall_clock(date: NaiveDate, hour: u32, minute: u32, zone: Option<Tz>) -> Option<DateTime<Utc>> {
    let naive = date.and_hms_opt(hour, minute, 0)?;
    let pick = |r: LocalResult<DateTime<Utc>>| match r {
        LocalResult::Single(t) | LocalResult::Ambiguous(t, _) => Some(t),
        LocalResult::None => None,
    };
    match zone {
        Some(tz) => pick(tz.from_local_datetime(&naive).map(|t| t.with_timezone(&Utc))),
        None => pick(chrono::Local.from_local_datetime(&naive).map(|t| t.with_timezone(&Utc))),
    }
}

/// Today's date where the reset is read.
fn today(zone: Option<Tz>, now: DateTime<Utc>) -> NaiveDate {
    match zone {
        Some(tz) => now.with_timezone(&tz).date_naive(),
        None => now.with_timezone(&chrono::Local).date_naive(),
    }
}

/// This year's date, or next year's once this year's has passed.
fn next_dated(month: u32, day: u32, hour: u32, minute: u32, zone: Option<Tz>, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let year = today(zone, now).year();
    let this_year = wall_clock(NaiveDate::from_ymd_opt(year, month, day)?, hour, minute, zone)?;
    if this_year > now {
        return Some(this_year);
    }
    wall_clock(NaiveDate::from_ymd_opt(year + 1, month, day)?, hour, minute, zone)
}

/// Today at that time, or tomorrow once today's has passed.
fn next_daily(hour: u32, minute: u32, zone: Option<Tz>, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let date = today(zone, now);
    let at = wall_clock(date, hour, minute, zone)?;
    if at > now {
        return Some(at);
    }
    wall_clock(date.succ_opt()?, hour, minute, zone)
}

fn month_day(text: &str, zone: Option<Tz>, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let m = MONTH_DAY_TIME.captures(text)?;
    let hour = hour_24(&m[3], &m[5])?;
    next_dated(month_index(&m[1])?, m[2].parse().ok()?, hour, minute_of(m.get(4))?, zone, now)
}

fn weekday(text: &str, zone: Option<Tz>, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let m = WEEKDAY_TIME.captures(text)?;
    let target = weekday_index(&m[1])?;
    let hour = hour_24(&m[2], &m[4])?;
    let minute = minute_of(m.get(3))?;
    let date = today(zone, now);
    let ahead = (target + 7 - date.weekday().num_days_from_sunday()) % 7;
    let at = wall_clock(date + Duration::days(ahead as i64), hour, minute, zone)?;
    if at > now {
        return Some(at);
    }
    wall_clock(date + Duration::days(ahead as i64 + 7), hour, minute, zone)
}

fn time_only(text: &str, zone: Option<Tz>, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let m = TIME_ONLY.captures(text)?;
    next_daily(hour_24(&m[1], &m[3])?, minute_of(m.get(2))?, zone, now)
}

fn twenty_four_hour(text: &str, zone: Option<Tz>, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let m = TIME_24H.captures(text)?;
    let hour: u32 = m[1].parse().ok()?;
    let minute: u32 = m[2].parse().ok()?;
    if hour >= 24 || minute >= 60 {
        return None;
    }
    match DAY_MONTH.captures(text) {
        Some(d) => {
            let day: u32 = d[1].parse().ok()?;
            next_dated(month_index(&d[2])?, day, hour, minute, zone, now)
        }
        None => next_daily(hour, minute, zone, now),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-10-28 11:00 UTC: a Wednesday, 04:00 in Los Angeles (PDT).
    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 28, 11, 0, 0).unwrap()
    }

    fn at(text: &str) -> Option<DateTime<Utc>> {
        parse_reset(&normalize(text), now()).map(|s| Utc.timestamp_opt(s, 0).unwrap())
    }

    fn utc(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> Option<DateTime<Utc>> {
        Some(Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap())
    }

    #[test]
    fn reads_claudes_panel_times_in_their_zone() {
        // As Claude 2.1.312 printed them.
        assert_eq!(at("11:10pm (America/Los_Angeles)"), utc(2026, 10, 29, 6, 10));
        assert_eq!(at("Nov 1 at 3pm (America/Los_Angeles)"), utc(2026, 11, 1, 23, 0), "PDT ends after Nov 1, 2am");
        assert_eq!(at("Nov1 at3pm (America/Los_Angeles)"), utc(2026, 11, 1, 23, 0), "drawn without spaces");
    }

    #[test]
    fn a_passed_time_is_the_next_one() {
        assert_eq!(at("3am (America/Los_Angeles)"), utc(2026, 10, 29, 10, 0), "3am today has passed: tomorrow");
        assert_eq!(at("Jan 2 at 9am (UTC)"), utc(2027, 1, 2, 9, 0), "next year");
        assert_eq!(at("Wed 3am (UTC)"), utc(2026, 11, 4, 3, 0), "this Wednesday's has passed: next week");
        assert_eq!(at("Fri 9:30pm (UTC)"), utc(2026, 10, 30, 21, 30));
    }

    #[test]
    fn reads_codexs_24_hour_times_and_relative_ones() {
        assert_eq!(at("17:26 on 4 Nov (UTC)"), utc(2026, 11, 4, 17, 26));
        assert_eq!(at("in 2h 5m"), None, "the 'in' is taken off by the line match, not here");
        assert_eq!(at("2h 5m"), utc(2026, 10, 28, 13, 5));
    }

    #[test]
    fn nonsense_is_no_time() {
        assert_eq!(at("13pm (UTC)"), None);
        assert_eq!(at("soon"), None);
    }

    #[test]
    fn finds_the_reset_under_its_own_label() {
        let lines = ["Current session", " 0% used", " Resets 11:10pm (America/Los_Angeles)", "Current week (all models)", " 26% used"];
        let found = reset_after_at(&lines, |l| l.contains("session"), |l| l.contains("Current"), now());
        assert_eq!(found, utc(2026, 10, 29, 6, 10).map(|t| t.timestamp()));
        // The week has no reset line of its own; the session's is not borrowed.
        let week = reset_after_at(&lines, |l| l.contains("week"), |l| l.contains("Current"), now());
        assert_eq!(week, None);
    }
}
