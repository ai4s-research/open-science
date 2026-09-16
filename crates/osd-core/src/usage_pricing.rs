//! Token prices, in USD per million tokens.
//!
//! Ported from Orca (MIT, `src/main/{claude,codex}-usage/*-model-pricing.ts`),
//! trimmed to the models a transcript on disk can actually name. A model this
//! table cannot place prices as `None` rather than as zero: an unpriced model
//! must read as "not counted", never as "free".

/// Claude's long-context tier, where a model has one.
const LONG_CONTEXT_THRESHOLD_TOKENS: f64 = 200_000.0;

pub struct ClaudePricing {
    input: f64,
    output: f64,
    cache_read: f64,
    /// 5-minute TTL cache write (1.25x base input).
    cache_write: f64,
    /// 1-hour TTL cache write (2x base input).
    cache_write_1h: f64,
    /// Present only where the model bills a higher rate past the threshold.
    above: Option<ClaudeAboveThreshold>,
}

struct ClaudeAboveThreshold {
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    cache_write_1h: f64,
}

/// Sonnet 4 and 4.5 bill above 200k at a higher rate; 4.6 and later do not.
const SONNET_LONG_CONTEXT: ClaudeAboveThreshold = ClaudeAboveThreshold {
    input: 6.0,
    output: 22.5,
    cache_read: 0.6,
    cache_write: 7.5,
    cache_write_1h: 12.0,
};

fn claude_pricing(normalized: &str) -> Option<ClaudePricing> {
    let flat = |input: f64, output: f64| ClaudePricing {
        input,
        output,
        cache_read: input / 10.0,
        cache_write: input * 1.25,
        cache_write_1h: input * 2.0,
        above: None,
    };
    Some(match normalized {
        "claude-fable-5" => flat(10.0, 50.0),
        "claude-opus-5" => flat(5.0, 25.0),
        // Sonnet 5 bills its full 1M window at flat rates — no long-context tier.
        "claude-sonnet-5" => flat(2.0, 10.0),
        "claude-opus-4-8" | "claude-opus-4-7" | "claude-opus-4-6" | "claude-opus-4-5" => {
            flat(5.0, 25.0)
        }
        "claude-opus-4-1" | "claude-opus-4" => flat(15.0, 75.0),
        "claude-sonnet-4-6" => flat(3.0, 15.0),
        "claude-sonnet-4-5" | "claude-sonnet-4" => ClaudePricing {
            above: Some(SONNET_LONG_CONTEXT),
            ..flat(3.0, 15.0)
        },
        "claude-sonnet-3-7" | "claude-sonnet-3-5" => flat(3.0, 15.0),
        "claude-haiku-4-5" => flat(1.0, 5.0),
        "claude-haiku-3-5" => flat(0.8, 4.0),
        "claude-haiku-3" => ClaudePricing {
            cache_read: 0.03,
            cache_write: 0.3,
            cache_write_1h: 0.5,
            ..flat(0.25, 1.25)
        },
        _ => return None,
    })
}

/// Map a transcript's model id onto a row of the table above.
///
/// Substring matching rather than exact ids: Claude Code writes dated and
/// suffixed variants (`claude-sonnet-4-5-20250929`, `…-thinking`) that no fixed
/// list keeps up with, and an unrecognised id costs the whole turn.
fn normalize_claude_model(model: &str) -> Option<&'static str> {
    let lower = model.trim().to_ascii_lowercase();
    let lower = lower
        .strip_prefix("anthropic/")
        .or_else(|| lower.strip_prefix("anthropic:"))
        .unwrap_or(&lower);
    let n = lower.replace('.', "-");
    let has = |needle: &str| n.contains(needle);

    // Ordered most-specific first: `opus-4-8` must win before the `opus-4` catch-all.
    if has("fable-5") {
        return Some("claude-fable-5");
    }
    if has("opus-5") {
        return Some("claude-opus-5");
    }
    for (needle, id) in [
        ("opus-4-8", "claude-opus-4-8"),
        ("opus-4-7", "claude-opus-4-7"),
        ("opus-4-6", "claude-opus-4-6"),
        ("opus-4-5", "claude-opus-4-5"),
        ("opus-4-1", "claude-opus-4-1"),
    ] {
        if has(needle) {
            return Some(id);
        }
    }
    if has("opus-4") {
        // A bare `opus-4`/`opus-4-20250514` is the legacy $15 model; any other
        // point release is priced as the current Opus line rather than as legacy.
        let legacy = n.ends_with("opus-4")
            || n.ends_with("opus-4-thinking")
            || n.trim_end_matches("-thinking")
                .rsplit('-')
                .next()
                .is_some_and(|tail| tail.len() == 8 && tail.starts_with("20"));
        return Some(if legacy {
            "claude-opus-4"
        } else {
            "claude-opus-4-8"
        });
    }
    if has("sonnet-5") {
        return Some("claude-sonnet-5");
    }
    if has("sonnet-4-6") {
        return Some("claude-sonnet-4-6");
    }
    if has("sonnet-4-5") {
        return Some("claude-sonnet-4-5");
    }
    if has("sonnet-4") {
        return Some("claude-sonnet-4-6");
    }
    if has("sonnet-3-7") {
        return Some("claude-sonnet-3-7");
    }
    // Legacy version-first ids (`claude-3-5-sonnet-20241022`) are still on disk.
    if has("sonnet-3-5") || has("3-5-sonnet") {
        return Some("claude-sonnet-3-5");
    }
    if has("haiku-4-5") {
        return Some("claude-haiku-4-5");
    }
    if has("haiku-3-5") || has("3-5-haiku") {
        return Some("claude-haiku-3-5");
    }
    if has("haiku-3") {
        return Some("claude-haiku-3");
    }
    None
}

fn tiered(tokens: f64, base: f64, above: Option<f64>, threshold: Option<f64>) -> f64 {
    match (above, threshold) {
        (Some(above_price), Some(threshold)) => {
            let below = tokens.min(threshold);
            let over = (tokens - threshold).max(0.0);
            below * base + over * above_price
        }
        _ => tokens * base,
    }
}

/// Cost of one Claude turn, or `None` when the model is not in the table.
///
/// `cache_write_1h_tokens` is the 1-hour-TTL subset of `cache_write_tokens`.
pub fn claude_cost_usd(
    model: Option<&str>,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
    cache_write_1h_tokens: u64,
) -> Option<f64> {
    let pricing = claude_pricing(normalize_claude_model(model?)?)?;
    let threshold = pricing
        .above
        .as_ref()
        .map(|_| LONG_CONTEXT_THRESHOLD_TOKENS);
    let (write_1h, write_5m) = {
        let all = cache_write_tokens as f64;
        let hour = (cache_write_1h_tokens as f64).min(all);
        (hour, all - hour)
    };
    // Both TTL buckets share one long-context allowance; giving each its own
    // would make a split bucket cheaper than the same tokens billed all at 5m.
    let hour_share = if cache_write_tokens > 0 {
        write_1h / cache_write_tokens as f64
    } else {
        0.0
    };
    let above = pricing.above.as_ref();
    Some(
        (tiered(
            input_tokens as f64,
            pricing.input,
            above.map(|a| a.input),
            threshold,
        ) + tiered(
            output_tokens as f64,
            pricing.output,
            above.map(|a| a.output),
            threshold,
        ) + tiered(
            cache_read_tokens as f64,
            pricing.cache_read,
            above.map(|a| a.cache_read),
            threshold,
        ) + tiered(
            write_5m,
            pricing.cache_write,
            above.map(|a| a.cache_write),
            threshold.map(|t| t * (1.0 - hour_share)),
        ) + tiered(
            write_1h,
            pricing.cache_write_1h,
            above.map(|a| a.cache_write_1h),
            threshold.map(|t| t * hour_share),
        )) / 1_000_000.0,
    )
}

struct CodexPricing {
    input: f64,
    cached_input: f64,
    output: f64,
}

/// Codex prices by family; a dated or `-codex` suffix bills as its base model.
fn codex_pricing(model: &str) -> Option<CodexPricing> {
    let n = model.trim().to_ascii_lowercase();
    let price = |input: f64, cached_input: f64, output: f64| CodexPricing {
        input,
        cached_input,
        output,
    };
    let has = |needle: &str| n.contains(needle);
    // Most specific first: `gpt-5.4-pro` must not be read as `gpt-5.4`.
    Some(match () {
        _ if has("gpt-5.5-pro") || has("gpt-5.4-pro") => price(30.0, 30.0, 180.0),
        _ if has("gpt-5.6-luna") => price(1.0, 0.1, 6.0),
        _ if has("gpt-5.6-sol") || has("gpt-5.5") => price(5.0, 0.5, 30.0),
        _ if has("gpt-5.6-terra") || has("gpt-5.4") && !has("mini") && !has("nano") => {
            price(2.5, 0.25, 15.0)
        }
        _ if has("gpt-5.4-mini") => price(0.75, 0.075, 4.5),
        _ if has("gpt-5.4-nano") => price(0.2, 0.02, 1.25),
        _ if has("gpt-5.3") || has("gpt-5.2") => price(1.75, 0.175, 14.0),
        _ if has("gpt-5.1") || has("gpt-5") => price(1.25, 0.125, 10.0),
        _ => return None,
    })
}

/// Cost of one Codex turn, or `None` when the model is not in the table.
///
/// `cached_input_tokens` is the cached SUBSET of `input_tokens` — Codex reports
/// the two that way, so the uncached remainder is what bills at the full rate.
pub fn codex_cost_usd(
    model: Option<&str>,
    input_tokens: u64,
    cached_input_tokens: u64,
    output_tokens: u64,
) -> Option<f64> {
    let pricing = codex_pricing(model?)?;
    let cached = cached_input_tokens.min(input_tokens) as f64;
    let uncached = input_tokens as f64 - cached;
    Some(
        (uncached * pricing.input
            + cached * pricing.cached_input
            + output_tokens as f64 * pricing.output)
            / 1_000_000.0,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prices_a_dated_sonnet_id() {
        // 1M input at $3 is exactly $3 — the arithmetic, not a fixture.
        let cost = claude_cost_usd(Some("claude-sonnet-4-6-20260514"), 1_000_000, 0, 0, 0, 0);
        assert_eq!(cost, Some(3.0));
    }

    #[test]
    fn unknown_models_are_uncounted_not_free() {
        assert_eq!(
            claude_cost_usd(Some("llama-3"), 1_000, 1_000, 0, 0, 0),
            None
        );
        assert_eq!(codex_cost_usd(Some("mistral-large"), 1_000, 0, 1_000), None);
        assert_eq!(claude_cost_usd(None, 1_000, 0, 0, 0, 0), None);
    }

    #[test]
    fn cache_reads_are_a_tenth_of_input() {
        let read = claude_cost_usd(Some("claude-sonnet-4-6"), 0, 0, 1_000_000, 0, 0).unwrap();
        let input = claude_cost_usd(Some("claude-sonnet-4-6"), 1_000_000, 0, 0, 0, 0).unwrap();
        assert!((read * 10.0 - input).abs() < 1e-9);
    }

    #[test]
    fn one_hour_cache_writes_cost_more_than_five_minute_ones() {
        let five = claude_cost_usd(Some("claude-opus-5"), 0, 0, 0, 1_000_000, 0).unwrap();
        let hour = claude_cost_usd(Some("claude-opus-5"), 0, 0, 0, 1_000_000, 1_000_000).unwrap();
        assert!(hour > five, "1h writes bill at 2x base, 5m at 1.25x");
    }

    #[test]
    fn sonnet_4_5_bills_the_long_context_tier_but_4_6_does_not() {
        // 400k input: half under the 200k threshold, half over.
        let tiered = claude_cost_usd(Some("claude-sonnet-4-5"), 400_000, 0, 0, 0, 0).unwrap();
        let flat = claude_cost_usd(Some("claude-sonnet-4-6"), 400_000, 0, 0, 0, 0).unwrap();
        assert!((flat - 1.2).abs() < 1e-9, "400k * $3/M");
        assert!(
            (tiered - (0.6 + 1.2)).abs() < 1e-9,
            "200k at $3, 200k at $6"
        );
    }

    #[test]
    fn legacy_opus_4_keeps_its_old_price_and_point_releases_do_not() {
        let legacy = claude_cost_usd(Some("claude-opus-4-20250514"), 1_000_000, 0, 0, 0, 0);
        let current = claude_cost_usd(Some("claude-opus-4-9"), 1_000_000, 0, 0, 0, 0);
        assert_eq!(legacy, Some(15.0));
        assert_eq!(
            current,
            Some(5.0),
            "unknown point releases bill as current Opus"
        );
    }

    #[test]
    fn codex_charges_the_cached_subset_at_the_cached_rate() {
        // 1M input of which 1M is cached: all of it bills at $0.125/M.
        let all_cached = codex_cost_usd(Some("gpt-5.1-codex"), 1_000_000, 1_000_000, 0).unwrap();
        let none_cached = codex_cost_usd(Some("gpt-5.1-codex"), 1_000_000, 0, 0).unwrap();
        assert!((all_cached - 0.125).abs() < 1e-9);
        assert!((none_cached - 1.25).abs() < 1e-9);
    }

    #[test]
    fn codex_cached_count_cannot_exceed_input() {
        // A malformed row claiming more cached than input must not go negative.
        let cost = codex_cost_usd(Some("gpt-5.1"), 1_000, 999_999, 0).unwrap();
        assert!(cost >= 0.0);
    }

    #[test]
    fn codex_pro_is_not_read_as_the_base_model() {
        let pro = codex_cost_usd(Some("gpt-5.4-pro"), 1_000_000, 0, 0).unwrap();
        let base = codex_cost_usd(Some("gpt-5.4"), 1_000_000, 0, 0).unwrap();
        assert!((pro - 30.0).abs() < 1e-9);
        assert!((base - 2.5).abs() < 1e-9);
    }
}
