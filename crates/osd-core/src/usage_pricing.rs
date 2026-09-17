//! Token prices, in USD per million tokens.
//!
//! Two sources, in this order:
//!
//! 1. **The catalog the bundled runtime already keeps** (`model_prices`) — the
//!    models.dev cache OpenCode writes under the runtime root and prices its
//!    own turns from. Preferred, so the workbench's `$.cost` and the figures
//!    computed here cannot disagree about the same model, and so a vendor price
//!    change reaches this app without anyone editing Rust.
//!
//! 2. **The table below**, ported from Orca (MIT,
//!    `src/main/{claude,codex}-usage/*-model-pricing.ts`), for the three things
//!    the catalog does not answer — measured against the cached file, not
//!    assumed:
//!
//!      * Retired ids. models.dev drops a model when the vendor stops serving
//!        it (`claude-opus-4`, `claude-sonnet-4`, `claude-haiku-3`, …) and a
//!        transcript written last month still names them.
//!      * Anthropic's above-200k tier. OpenAI rows carry `tiers`;
//!        `claude-sonnet-4-5` carries none, though it bills one.
//!      * The 1-hour-TTL cache write. Anthropic rows carry a single
//!        `cache_write`, which is the 5-minute rate.
//!
//! A model neither source can place prices as `None` rather than as zero: an
//! unpriced model must read as "not counted", never as "free".

use crate::model_prices::{ModelCost, Prices};

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

/// Which normalized ids bill a tier past 200k.
///
/// Kept here rather than read from the catalog because the catalog does not
/// state it for Anthropic: OpenAI rows carry `tiers` / `context_over_200k`,
/// `claude-sonnet-4-5` carries neither. So the tier is this build's own
/// knowledge whichever source filled the base rates.
fn long_context_tier(normalized: &str) -> Option<ClaudeAboveThreshold> {
    matches!(normalized, "claude-sonnet-4-5" | "claude-sonnet-4").then_some(SONNET_LONG_CONTEXT)
}

/// Build the rates from a catalog row, deriving only what the catalog omits.
fn pricing_from_catalog(cost: ModelCost, normalized: &str) -> ClaudePricing {
    ClaudePricing {
        input: cost.input,
        output: cost.output,
        // Anthropic states both, and they are not derivable: `claude-fable-5-1`
        // reads cached input at 0.25 where `claude-fable-5` reads it at 1.0,
        // which no ratio of the $10 input price produces.
        cache_read: cost.cache_read.unwrap_or(cost.input / 10.0),
        cache_write: cost.cache_write.unwrap_or(cost.input * 1.25),
        // Not in the catalog at all — one `cache_write` per row, the 5-minute
        // one. The hour is twice base input, as it has been since it shipped.
        cache_write_1h: cost.input * 2.0,
        above: long_context_tier(normalized),
    }
}

fn builtin_claude_pricing(normalized: &str) -> Option<ClaudePricing> {
    let flat = |input: f64, output: f64| ClaudePricing {
        input,
        output,
        cache_read: input / 10.0,
        cache_write: input * 1.25,
        cache_write_1h: input * 2.0,
        above: None,
    };
    Some(match normalized {
        // 5.1 reads cached input at a quarter of what 5 does — the one place
        // `input / 10` is not merely imprecise but wrong by 4x, and the reason
        // these two ids are no longer folded together.
        "claude-fable-5-1" => ClaudePricing {
            cache_read: 0.25,
            ..flat(10.0, 50.0)
        },
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
            above: long_context_tier(normalized),
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

/// A bare id, or one whose only suffix is a release date — as opposed to a
/// point release this build has not heard of.
///
/// The distinction is load-bearing for a family whose price CHANGED at a point
/// release: `claude-opus-4-20250514` is the legacy $15 model, while an unknown
/// `claude-opus-4-9` is far more likely to be the current line than a return to
/// the old price.
fn is_base_or_dated(normalized: &str, base: &str) -> bool {
    let stem = normalized.trim_end_matches("-thinking");
    stem.ends_with(base)
        || stem
            .rsplit('-')
            .next()
            .is_some_and(|tail| tail.len() == 8 && tail.starts_with("20"))
}

/// Map a transcript's model id onto a catalog id / a row of the table above.
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

    // Ordered most-specific first: `fable-5-1` must win before the `fable-5`
    // catch-all, and `opus-4-8` before `opus-4`.
    if has("fable-5-1") {
        return Some("claude-fable-5-1");
    }
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
        return Some(if is_base_or_dated(&n, "opus-4") {
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
        // Bare or dated `sonnet-4` is the model that bills a tier above 200k.
        // Routing it to 4.6 — which does not — dropped that tier and left the
        // `claude-sonnet-4` row below unreachable.
        return Some(if is_base_or_dated(&n, "sonnet-4") {
            "claude-sonnet-4"
        } else {
            "claude-sonnet-4-6"
        });
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

/// The catalog first, on the id as written and then on the normalized one; the
/// built-in table only for what the catalog has retired or never carried.
fn claude_pricing(prices: &Prices, model: &str) -> Option<ClaudePricing> {
    let normalized = normalize_claude_model(model)?;
    // The id as written wins when the catalog carries it verbatim
    // (`claude-sonnet-4-5-20250929` is a row of its own), since that is the
    // vendor's own statement about that exact snapshot.
    let exact = prices.anthropic(model.trim().to_ascii_lowercase().as_str());
    if let Some(cost) = exact.or_else(|| prices.anthropic(normalized)) {
        return Some(pricing_from_catalog(cost, normalized));
    }
    builtin_claude_pricing(normalized)
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

/// Cost of one Claude turn, or `None` when neither source can price the model.
///
/// `cache_write_1h_tokens` is the 1-hour-TTL subset of `cache_write_tokens`.
pub fn claude_cost_usd(
    prices: &Prices,
    model: Option<&str>,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
    cache_write_1h_tokens: u64,
) -> Option<f64> {
    let pricing = claude_pricing(prices, model?)?;
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

/// Catalog ids to try for a transcript's model name, most faithful first.
///
/// Codex writes `gpt-5.3-codex` (a catalog row of its own) but also dated and
/// variant spellings that are not rows; stripping the suffix back to the base
/// family is what lets those land on the vendor's own price instead of on the
/// table below.
fn codex_catalog_ids(normalized: &str) -> Vec<String> {
    let mut ids = vec![normalized.to_string()];
    for suffix in ["-codex-spark", "-codex"] {
        if let Some(base) = normalized.strip_suffix(suffix) {
            ids.push(base.to_string());
        }
    }
    // `gpt-5.1-codex-20260101` → `gpt-5.1-codex` → `gpt-5.1`.
    if let Some((head, tail)) = normalized.rsplit_once('-') {
        if tail.len() == 8 && tail.starts_with("20") {
            ids.push(head.to_string());
            for suffix in ["-codex-spark", "-codex"] {
                if let Some(base) = head.strip_suffix(suffix) {
                    ids.push(base.to_string());
                }
            }
        }
    }
    ids
}

/// Codex prices by family; a dated or `-codex` suffix bills as its base model.
///
/// Reached only for an id the catalog does not carry. Note what it still does
/// not express, as it never did: `gpt-5.4` and `gpt-5.4-pro` bill double past
/// 272k, which the catalog states in `tiers` and this does not read.
fn builtin_codex_pricing(n: &str) -> Option<CodexPricing> {
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

fn codex_pricing(prices: &Prices, model: &str) -> Option<CodexPricing> {
    let n = model.trim().to_ascii_lowercase();
    for id in codex_catalog_ids(&n) {
        if let Some(cost) = prices.openai(&id) {
            return Some(CodexPricing {
                input: cost.input,
                // OpenAI states the cached rate; a tenth of input is only the
                // shape it has happened to take.
                cached_input: cost.cache_read.unwrap_or(cost.input / 10.0),
                output: cost.output,
            });
        }
    }
    builtin_codex_pricing(&n)
}

/// Cost of one Codex turn, or `None` when neither source can price the model.
///
/// `cached_input_tokens` is the cached SUBSET of `input_tokens` — Codex reports
/// the two that way, so the uncached remainder is what bills at the full rate.
pub fn codex_cost_usd(
    prices: &Prices,
    model: Option<&str>,
    input_tokens: u64,
    cached_input_tokens: u64,
    output_tokens: u64,
) -> Option<f64> {
    let pricing = codex_pricing(prices, model?)?;
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

    /// No catalog: exercises the built-in table, which is what a fresh install
    /// runs on until the runtime has started once.
    fn builtin() -> Prices {
        Prices::empty()
    }

    #[test]
    fn prices_a_dated_sonnet_id() {
        // 1M input at $3 is exactly $3 — the arithmetic, not a fixture.
        let cost = claude_cost_usd(
            &builtin(),
            Some("claude-sonnet-4-6-20260514"),
            1_000_000,
            0,
            0,
            0,
            0,
        );
        assert_eq!(cost, Some(3.0));
    }

    #[test]
    fn unknown_models_are_uncounted_not_free() {
        assert_eq!(
            claude_cost_usd(&builtin(), Some("llama-3"), 1_000, 1_000, 0, 0, 0),
            None
        );
        assert_eq!(
            codex_cost_usd(&builtin(), Some("mistral-large"), 1_000, 0, 1_000),
            None
        );
        assert_eq!(claude_cost_usd(&builtin(), None, 1_000, 0, 0, 0, 0), None);
    }

    #[test]
    fn cache_reads_are_a_tenth_of_input() {
        let prices = builtin();
        let read =
            claude_cost_usd(&prices, Some("claude-sonnet-4-6"), 0, 0, 1_000_000, 0, 0).unwrap();
        let input =
            claude_cost_usd(&prices, Some("claude-sonnet-4-6"), 1_000_000, 0, 0, 0, 0).unwrap();
        assert!((read * 10.0 - input).abs() < 1e-9);
    }

    #[test]
    fn fable_5_1_reads_cache_at_a_quarter_rather_than_a_tenth() {
        // The two share an input price and do NOT share a cache-read price, so
        // folding them onto one row billed 5.1's cached reads at 4x.
        let prices = builtin();
        let five_one =
            claude_cost_usd(&prices, Some("claude-fable-5-1"), 0, 0, 1_000_000, 0, 0).unwrap();
        let five = claude_cost_usd(&prices, Some("claude-fable-5"), 0, 0, 1_000_000, 0, 0).unwrap();
        assert!((five_one - 0.25).abs() < 1e-9, "$0.25/M, not $1.00/M");
        assert!((five - 1.0).abs() < 1e-9);
        // And the input price is still the same $10/M for both.
        assert_eq!(
            claude_cost_usd(&prices, Some("claude-fable-5-1"), 1_000_000, 0, 0, 0, 0),
            claude_cost_usd(&prices, Some("claude-fable-5"), 1_000_000, 0, 0, 0, 0)
        );
    }

    #[test]
    fn one_hour_cache_writes_cost_more_than_five_minute_ones() {
        let prices = builtin();
        let five = claude_cost_usd(&prices, Some("claude-opus-5"), 0, 0, 0, 1_000_000, 0).unwrap();
        let hour = claude_cost_usd(
            &prices,
            Some("claude-opus-5"),
            0,
            0,
            0,
            1_000_000,
            1_000_000,
        )
        .unwrap();
        assert!(hour > five, "1h writes bill at 2x base, 5m at 1.25x");
    }

    #[test]
    fn sonnet_4_5_bills_the_long_context_tier_but_4_6_does_not() {
        // 400k input: half under the 200k threshold, half over.
        let prices = builtin();
        let tiered =
            claude_cost_usd(&prices, Some("claude-sonnet-4-5"), 400_000, 0, 0, 0, 0).unwrap();
        let flat =
            claude_cost_usd(&prices, Some("claude-sonnet-4-6"), 400_000, 0, 0, 0, 0).unwrap();
        assert!((flat - 1.2).abs() < 1e-9, "400k * $3/M");
        assert!(
            (tiered - (0.6 + 1.2)).abs() < 1e-9,
            "200k at $3, 200k at $6"
        );
    }

    #[test]
    fn bare_sonnet_4_keeps_its_long_context_tier() {
        // It used to be routed to 4.6, which bills no tier, so a >200k Sonnet 4
        // turn was charged at the flat rate and the `claude-sonnet-4` row was
        // unreachable.
        let prices = builtin();
        for id in ["claude-sonnet-4", "claude-sonnet-4-20250514"] {
            let cost = claude_cost_usd(&prices, Some(id), 400_000, 0, 0, 0, 0).unwrap();
            assert!((cost - (0.6 + 1.2)).abs() < 1e-9, "{id} bills the tier");
        }
        // An unknown point release still bills as the current line, as for opus.
        let current = claude_cost_usd(&prices, Some("claude-sonnet-4-9"), 400_000, 0, 0, 0, 0);
        assert_eq!(current, Some(1.2), "no tier for the current Sonnet line");
    }

    #[test]
    fn legacy_opus_4_keeps_its_old_price_and_point_releases_do_not() {
        let prices = builtin();
        let legacy = claude_cost_usd(
            &prices,
            Some("claude-opus-4-20250514"),
            1_000_000,
            0,
            0,
            0,
            0,
        );
        let current = claude_cost_usd(&prices, Some("claude-opus-4-9"), 1_000_000, 0, 0, 0, 0);
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
        let prices = builtin();
        let all_cached =
            codex_cost_usd(&prices, Some("gpt-5.1-codex"), 1_000_000, 1_000_000, 0).unwrap();
        let none_cached = codex_cost_usd(&prices, Some("gpt-5.1-codex"), 1_000_000, 0, 0).unwrap();
        assert!((all_cached - 0.125).abs() < 1e-9);
        assert!((none_cached - 1.25).abs() < 1e-9);
    }

    #[test]
    fn codex_cached_count_cannot_exceed_input() {
        // A malformed row claiming more cached than input must not go negative.
        let cost = codex_cost_usd(&builtin(), Some("gpt-5.1"), 1_000, 999_999, 0).unwrap();
        assert!(cost >= 0.0);
    }

    #[test]
    fn codex_pro_is_not_read_as_the_base_model() {
        let prices = builtin();
        let pro = codex_cost_usd(&prices, Some("gpt-5.4-pro"), 1_000_000, 0, 0).unwrap();
        let base = codex_cost_usd(&prices, Some("gpt-5.4"), 1_000_000, 0, 0).unwrap();
        assert!((pro - 30.0).abs() < 1e-9);
        assert!((base - 2.5).abs() < 1e-9);
    }

    #[test]
    fn a_codex_id_falls_back_through_its_suffixes_to_a_catalog_row() {
        // What the lookup order has to do to reach `gpt-5.3-codex`'s own row,
        // and `gpt-5.1`'s when the transcript names a dated codex build.
        assert_eq!(
            codex_catalog_ids("gpt-5.3-codex"),
            vec!["gpt-5.3-codex", "gpt-5.3"]
        );
        assert_eq!(
            codex_catalog_ids("gpt-5.1-codex-20260101"),
            vec!["gpt-5.1-codex-20260101", "gpt-5.1-codex", "gpt-5.1"]
        );
    }
}
