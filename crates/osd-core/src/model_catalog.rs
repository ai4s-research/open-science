//! Keeps the runtime's model catalog current.
//!
//! The picker's model list comes from the catalog OpenCode caches at
//! `xdg-cache/opencode/models.json`. OpenCode refreshes that file itself, but
//! gives the ~6 MB download 10 seconds, and on any failure keeps the old file
//! without a word. On a slow or proxied connection every attempt times out
//! (436 `TimeoutError`s in one user log, 2026-10-28), so the list stays weeks
//! old and new models never appear, whatever the user's subscription.
//!
//! So the app downloads the same file itself, with a generous timeout and the
//! proxy the sidecar is configured with, and writes it where OpenCode reads it.
//! OpenCode loads the catalog when it starts, so a new list shows up on the
//! next launch.

use crate::env::Env;
use std::time::Duration;

/// What OpenCode 1.19.4 fetches (`OPENCODE_MODELS_URL` default + `/api.json`).
const CATALOG_URL: &str = "https://models.opencode.ai/api.json";
const TIMEOUT: Duration = Duration::from_secs(120);
/// How often a long-running app checks again.
const INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// A catalog this fresh is not downloaded again (the app relaunched, or
/// OpenCode's own refresh just succeeded).
const FRESH: Duration = Duration::from_secs(60 * 60);
const RETRY_DELAYS: [Duration; 2] = [Duration::from_secs(10), Duration::from_secs(60)];

/// Start the background refresher once per process.
pub fn start(env: &Env) {
    static STARTED: std::sync::Once = std::sync::Once::new();
    STARTED.call_once(|| {
        let env = env.clone();
        std::thread::spawn(move || loop {
            refresh_with_retries(&env);
            std::thread::sleep(INTERVAL);
        });
    });
}

fn refresh_with_retries(env: &Env) {
    for delay in std::iter::once(Duration::ZERO).chain(RETRY_DELAYS) {
        std::thread::sleep(delay);
        match refresh(env) {
            Ok(Some(msg)) => {
                crate::debug_log::append(env, &format!("model catalog: {msg}"));
                return;
            }
            Ok(None) => return,
            Err(e) => crate::debug_log::append(env, &format!("model catalog: {e}")),
        }
    }
}

/// Download and install the catalog unless the cached one is fresh.
/// `Ok(None)` = nothing to do.
fn refresh(env: &Env) -> Result<Option<String>, String> {
    let path = crate::model_prices::catalog_path(&crate::runtime::runtime_root(env)?);
    let age = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok());
    if age.is_some_and(|a| a < FRESH) {
        return Ok(None);
    }
    let mut builder = reqwest::blocking::Client::builder()
        .user_agent(format!("open-science-desktop/{}", env.version()))
        .timeout(TIMEOUT);
    builder = match crate::runtime::sidecar_proxy(env) {
        Some(url) => {
            builder.proxy(reqwest::Proxy::all(&url).map_err(|e| format!("bad proxy {url}: {e}"))?)
        }
        None => builder.no_proxy(),
    };
    let body = builder
        .build()
        .map_err(|e| format!("could not create HTTP client: {e}"))?
        .get(CATALOG_URL)
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.text())
        .map_err(|e| format!("download failed: {e}"))?;
    validate(&body)?;
    crate::runtime::write_atomic(&path, &body)?;
    Ok(Some(format!("updated ({} bytes)", body.len())))
}

/// Never replace a working catalog with something that is not one — a captive
/// portal page, a truncated body, an error JSON.
fn validate(body: &str) -> Result<(), String> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("not a catalog: {e}"))?;
    let has_models = |p: &str| {
        v.get(p)
            .and_then(|p| p.get("models"))
            .is_some_and(|m| m.is_object())
    };
    if has_models("openai") && has_models("anthropic") {
        Ok(())
    } else {
        Err("not a catalog: openai/anthropic entries missing".into())
    }
}

#[cfg(test)]
mod tests {
    use super::validate;

    #[test]
    fn accepts_a_catalog_and_refuses_anything_else() {
        let ok = r#"{"openai":{"models":{"gpt-6.1-sol":{}}},"anthropic":{"models":{}}}"#;
        assert!(validate(ok).is_ok());
        assert!(validate("<html>login</html>").is_err());
        assert!(validate(r#"{"error":"rate limited"}"#).is_err());
        assert!(validate(r#"{"openai":{"models":{}}}"#).is_err());
        assert!(validate(&ok[..ok.len() - 5]).is_err());
    }
}
