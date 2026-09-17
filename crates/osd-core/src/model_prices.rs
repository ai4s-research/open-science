//! Token prices, read from the catalog the bundled runtime already keeps.
//!
//! OpenCode caches the whole models.dev catalog at
//! `<runtime_root>/xdg-cache/opencode/models.json` — the sibling of the
//! `xdg-data/opencode/opencode.db` this crate already reads, written because
//! the app hands its sidecar an `XDG_CACHE_HOME` under the runtime root
//! (`runtime.rs`). It is the same source OpenCode prices its own turns from, so
//! reading it is what makes the workbench's `$.cost` and the CLI rows' computed
//! cost agree BY CONSTRUCTION rather than by someone keeping a second table in
//! step with the first.
//!
//! Why a file and not a request: a price this app shows must not depend on a
//! network call this app made. Refreshing the catalog is the runtime's job, and
//! it does it on startup.
//!
//! What the catalog does NOT carry, which is why `usage_pricing`'s own table
//! survives as a fallback — all three measured against the cached file:
//!
//!   * The 1-hour-TTL cache write. Anthropic rows carry one `cache_write`,
//!     which is the 5-minute rate.
//!   * Anthropic's above-200k tier. OpenAI rows carry `tiers` /
//!     `context_over_200k`; `claude-sonnet-4-5` carries neither, though it
//!     bills one.
//!   * Retired ids. models.dev drops a model when the vendor stops serving it
//!     (`claude-opus-4`, `claude-sonnet-4`, `claude-haiku-3`, …), and a
//!     transcript from last month still names them.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

/// One model's prices in USD per MILLION tokens, as the catalog states them.
/// The same unit `usage_pricing`'s own table uses, so either source can fill
/// the same arithmetic.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct ModelCost {
    pub input: f64,
    pub output: f64,
    /// Absent for models a provider does not bill cached reads apart for.
    #[serde(default)]
    pub cache_read: Option<f64>,
    /// Anthropic's 5-minute-TTL write. Absent on providers with no write
    /// charge at all (OpenAI states none).
    #[serde(default)]
    pub cache_write: Option<f64>,
}

/// Prices for the two providers whose transcripts this crate scans.
///
/// Held as two small maps rather than the parsed catalog: the file is 4.5 MB
/// over 220 providers, and keeping it resident to answer a question about two
/// of them would be the most expensive thing in a usage scan.
#[derive(Debug, Default, Clone)]
pub struct Prices {
    anthropic: HashMap<String, ModelCost>,
    openai: HashMap<String, ModelCost>,
}

/// Where the runtime leaves the catalog.
pub fn catalog_path(runtime_root: &Path) -> PathBuf {
    runtime_root
        .join("xdg-cache")
        .join("opencode")
        .join("models.json")
}

impl Prices {
    /// No catalog — a fresh install whose runtime has never started, or a
    /// caller with no runtime root at all. Every lookup misses and the built-in
    /// table answers instead, which is the behaviour that predated this module.
    pub fn empty() -> Self {
        Self::default()
    }

    pub fn load(runtime_root: Option<&Path>) -> Self {
        let Some(root) = runtime_root else {
            return Self::empty();
        };
        let Ok(text) = std::fs::read_to_string(catalog_path(root)) else {
            return Self::empty();
        };
        // Deserialized as opaque values and narrowed afterwards, not into a
        // typed catalog: one provider among 220 with a shape this crate did not
        // predict would otherwise fail the whole parse and silently cost every
        // model its price.
        let Ok(catalog) = serde_json::from_str::<HashMap<String, Value>>(&text) else {
            return Self::empty();
        };
        Self {
            anthropic: provider_costs(catalog.get("anthropic")),
            openai: provider_costs(catalog.get("openai")),
        }
    }

    /// True when the catalog was read and held something usable. Only the tests
    /// ask; the lookups below already say so by missing.
    pub fn is_empty(&self) -> bool {
        self.anthropic.is_empty() && self.openai.is_empty()
    }

    pub fn anthropic(&self, model_id: &str) -> Option<ModelCost> {
        self.anthropic.get(model_id).copied()
    }

    pub fn openai(&self, model_id: &str) -> Option<ModelCost> {
        self.openai.get(model_id).copied()
    }
}

fn provider_costs(provider: Option<&Value>) -> HashMap<String, ModelCost> {
    let Some(models) = provider
        .and_then(|provider| provider.get("models"))
        .and_then(Value::as_object)
    else {
        return HashMap::new();
    };
    models
        .iter()
        .filter_map(|(id, model)| {
            let cost = serde_json::from_value::<ModelCost>(model.get("cost")?.clone()).ok()?;
            // A row priced at zero is a free model, and pricing a turn from it
            // would report $0.00 for work that was really uncounted. The same
            // rule the workbench's own figure follows for OpenCode's `$.cost`:
            // above zero, or not a price.
            (cost.input > 0.0 || cost.output > 0.0).then_some((id.clone(), cost))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const CATALOG: &str = r#"{
      "anthropic": {"models": {
        "claude-fable-5-1": {"cost": {"input": 10, "output": 50, "cache_read": 0.25, "cache_write": 12.5}},
        "claude-fable-5":   {"cost": {"input": 10, "output": 50, "cache_read": 1, "cache_write": 12.5}},
        "some-free-model":  {"cost": {"input": 0, "output": 0}}
      }},
      "openai": {"models": {
        "gpt-5.1": {"cost": {"input": 1.25, "output": 10, "cache_read": 0.125}}
      }},
      "a-provider-with-a-shape-we-did-not-predict": {"models": []}
    }"#;

    fn loaded() -> Prices {
        // A directory per call, not per process: these tests run in parallel and
        // each one removes the tree it made, so a shared path had them deleting
        // the catalog out from under each other.
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let unique = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("osd-prices-{}-{unique}", std::process::id()));
        let cache = catalog_path(&dir);
        std::fs::create_dir_all(cache.parent().unwrap()).unwrap();
        std::fs::write(&cache, CATALOG).unwrap();
        let prices = Prices::load(Some(&dir));
        let _ = std::fs::remove_dir_all(&dir);
        prices
    }

    #[test]
    fn reads_the_catalog_the_runtime_already_wrote() {
        let prices = loaded();
        let fable = prices
            .anthropic("claude-fable-5-1")
            .expect("a priced model");
        assert_eq!(fable.input, 10.0);
        assert_eq!(fable.output, 50.0);
        // The whole reason this module exists: 5.1 reads cached input at a
        // quarter of what 5 does, which no `input / 10` rule can produce.
        assert_eq!(fable.cache_read, Some(0.25));
        assert_eq!(
            prices.anthropic("claude-fable-5").unwrap().cache_read,
            Some(1.0)
        );
    }

    #[test]
    fn a_provider_row_of_an_unexpected_shape_costs_only_itself() {
        // The malformed entry must not take the other 219 providers down.
        let prices = loaded();
        assert!(prices.anthropic("claude-fable-5-1").is_some());
        assert_eq!(prices.openai("gpt-5.1").unwrap().input, 1.25);
    }

    #[test]
    fn a_free_model_is_unpriced_rather_than_priced_at_zero() {
        assert!(loaded().anthropic("some-free-model").is_none());
    }

    #[test]
    fn a_missing_catalog_is_no_prices_rather_than_an_error() {
        assert!(Prices::load(None).is_empty());
        assert!(Prices::load(Some(Path::new("/nonexistent-runtime-root"))).is_empty());
    }

    #[test]
    fn a_model_the_catalog_does_not_carry_simply_misses() {
        // Retired ids are the fallback table's job, not this one's.
        assert!(loaded().anthropic("claude-opus-4").is_none());
    }
}
