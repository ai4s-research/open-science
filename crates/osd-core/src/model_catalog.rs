//! Keeps the runtime's model catalog current, and tells the picker about it.
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
//!
//! OpenCode reads the catalog once, when it starts: replacing the file, or
//! asking it to dispose its instances, changes nothing it serves (measured on
//! 1.19.4). A new list therefore takes effect on the next sidecar start, and
//! `apply` makes that happen now, only when no conversation is running.
//!
//! Each download is compared with the file it replaces; models that appeared
//! are kept for a week in `model-catalog.json` so the picker can mark them new.

use crate::env::Env;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

/// What OpenCode 1.19.4 fetches (`OPENCODE_MODELS_URL` default + `/api.json`).
const CATALOG_URL: &str = "https://models.opencode.ai/api.json";
const TIMEOUT: Duration = Duration::from_secs(120);
/// How often a long-running app checks again.
const INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// A catalog this fresh is not downloaded again by the background check (the
/// app relaunched, or OpenCode's own refresh just succeeded). A check the user
/// asks for always downloads.
const FRESH_MS: u64 = 60 * 60 * 1000;
const RETRY_DELAYS: [Duration; 2] = [Duration::from_secs(10), Duration::from_secs(60)];
/// How long a model that appeared counts as new.
const NEW_FOR_MS: u64 = 7 * 24 * 60 * 60 * 1000;
/// Sessions touched this recently are the only ones that can be running.
const ACTIVE_WINDOW_MS: u64 = 60 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogError {
    /// `timeout` | `proxy` | `offline` | `server` | `invalid`
    pub kind: String,
    pub message: String,
    pub at: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NewModel {
    /// `provider/model`, the picker's key.
    pub key: String,
    /// Epoch ms the download that brought it landed.
    pub at: u64,
}

/// What the picker shows.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogStatus {
    /// Epoch ms the catalog file was last written (by us or by OpenCode).
    pub updated_at: Option<u64>,
    pub checking: bool,
    /// The most recent attempt failed; cleared by the next success.
    pub last_error: Option<CatalogError>,
    /// Models that appeared within the last week, newest first.
    pub new_models: Vec<NewModel>,
    /// Epoch ms the running sidecar started (0 = none). A new model with a
    /// later `at` is downloaded but not loaded yet.
    pub runtime_started_at: u64,
}

/// Persisted next to the catalog.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    #[serde(default)]
    new_models: BTreeMap<String, u64>,
    #[serde(default)]
    last_error: Option<CatalogError>,
}

/// One download at a time; a second caller waits for it and reads its result.
static REFRESH: Mutex<()> = Mutex::new(());
static CHECKING: AtomicBool = AtomicBool::new(false);
/// One apply at a time, so two clients cannot restart the runtime twice.
static APPLY: Mutex<()> = Mutex::new(());

/// Start the background refresher once per process.
pub fn start(env: &Env) {
    static STARTED: std::sync::Once = std::sync::Once::new();
    STARTED.call_once(|| {
        let env = env.clone();
        std::thread::spawn(move || loop {
            for delay in std::iter::once(Duration::ZERO).chain(RETRY_DELAYS) {
                std::thread::sleep(delay);
                if refresh(&env, false).last_error.is_none() {
                    break;
                }
            }
            std::thread::sleep(INTERVAL);
        });
    });
}

pub fn status(env: &Env) -> CatalogStatus {
    let runtime_started_at = crate::runtime::runtime_started_at(env.runtime()).unwrap_or(0);
    let checking = CHECKING.load(Ordering::SeqCst);
    let Ok(root) = crate::runtime::runtime_root(env) else {
        return CatalogStatus {
            updated_at: None,
            checking,
            last_error: None,
            new_models: Vec::new(),
            runtime_started_at,
        };
    };
    let saved = load_saved(&root);
    let now = now_ms();
    let mut new_models: Vec<NewModel> = saved
        .new_models
        .into_iter()
        .filter(|(_, at)| now.saturating_sub(*at) < NEW_FOR_MS)
        .map(|(key, at)| NewModel { key, at })
        .collect();
    new_models.sort_by(|a, b| b.at.cmp(&a.at).then(a.key.cmp(&b.key)));
    CatalogStatus {
        updated_at: modified_ms(&catalog_path(&root)),
        checking,
        last_error: saved.last_error,
        new_models,
        runtime_started_at,
    }
}

/// Download the catalog (`force`, or when the cached one is over an hour old)
/// and record what changed. Returns the status after.
pub fn refresh(env: &Env, force: bool) -> CatalogStatus {
    let _one = REFRESH.lock().unwrap_or_else(|e| e.into_inner());
    if let Ok(root) = crate::runtime::runtime_root(env) {
        let age = modified_ms(&catalog_path(&root)).map(|t| now_ms().saturating_sub(t));
        if force || age.is_none_or(|a| a >= FRESH_MS) {
            CHECKING.store(true, Ordering::SeqCst);
            let result = download(env);
            let mut saved = load_saved(&root);
            match result.and_then(|body| install(&root, &body, &mut saved)) {
                Ok(added) => {
                    saved.last_error = None;
                    crate::debug_log::append(env, &format!("model catalog: updated, {added} new"));
                }
                Err(e) => {
                    crate::debug_log::append(env, &format!("model catalog: {}", e.message));
                    saved.last_error = Some(e);
                }
            }
            let now = now_ms();
            saved
                .new_models
                .retain(|_, at| now.saturating_sub(*at) < NEW_FOR_MS);
            let _ = save(&root, &saved);
            CHECKING.store(false, Ordering::SeqCst);
        }
    }
    status(env)
}

/// What `apply` did.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ApplyOutcome {
    /// The runtime already serves the newest catalog.
    Current,
    /// A conversation is running (or that could not be ruled out); try later.
    Busy,
    /// The runtime was restarted on the new catalog.
    Applied,
}

/// Restart the runtime so it loads a catalog downloaded after it started,
/// only when no conversation is running anywhere (desktop or web, any project).
pub fn apply(env: &Env) -> Result<ApplyOutcome, String> {
    let _one = APPLY.lock().unwrap_or_else(|e| e.into_inner());
    let st = status(env);
    let stale =
        st.runtime_started_at > 0 && st.updated_at.is_some_and(|u| u > st.runtime_started_at);
    if !stale {
        return Ok(ApplyOutcome::Current);
    }
    if !runtime_idle(env) {
        return Ok(ApplyOutcome::Busy);
    }
    crate::runtime::restart_runtime(env)?;
    crate::debug_log::append(env, "model catalog: runtime restarted to load the new list");
    Ok(ApplyOutcome::Applied)
}

/// True only when every recently active project reports no session at work.
/// OpenCode keeps session status per project directory, so each one touched in
/// the last hour is asked; any failure counts as busy.
fn runtime_idle(env: &Env) -> bool {
    let Some(base) = crate::runtime::sidecar_url(env.runtime()) else {
        return true;
    };
    let pw = crate::runtime::server_password();
    let Ok(client) = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
    else {
        return false;
    };
    let get = |url: reqwest::Url| -> Option<serde_json::Value> {
        let resp = client
            .get(url)
            .basic_auth("opencode", Some(pw))
            .send()
            .ok()?;
        serde_json::from_str(&resp.error_for_status().ok()?.text().ok()?).ok()
    };
    let Some(sessions) = reqwest::Url::parse_with_params(
        &format!("{base}/experimental/session"),
        &[("limit", "100")],
    )
    .ok()
    .and_then(get) else {
        return false;
    };
    let mut dirs = recent_directories(&sessions, now_ms());
    if let Ok(ws) = crate::runtime::workspace_path(env) {
        if !dirs.contains(&ws) {
            dirs.push(ws);
        }
    }
    dirs.iter().all(|dir| {
        reqwest::Url::parse_with_params(&format!("{base}/session/status"), &[("directory", dir)])
            .ok()
            .and_then(get)
            .is_some_and(|map| all_idle(&map))
    })
}

fn recent_directories(sessions: &serde_json::Value, now: u64) -> Vec<String> {
    let mut dirs: Vec<String> = Vec::new();
    for s in sessions.as_array().into_iter().flatten() {
        let updated = s["time"]["updated"].as_u64().unwrap_or(0);
        if now.saturating_sub(updated) > ACTIVE_WINDOW_MS {
            continue;
        }
        if let Some(dir) = s["directory"].as_str() {
            if !dirs.iter().any(|d| d == dir) {
                dirs.push(dir.to_string());
            }
        }
    }
    dirs
}

/// `/session/status` lists sessions that are not idle (`busy`, `retry`).
fn all_idle(map: &serde_json::Value) -> bool {
    map.as_object()
        .is_some_and(|m| m.values().all(|s| s["type"].as_str() == Some("idle")))
}

fn download(env: &Env) -> Result<String, CatalogError> {
    let fail = |kind: &str, message: String| CatalogError {
        kind: kind.into(),
        message,
        at: now_ms(),
    };
    let proxy = crate::runtime::sidecar_proxy(env);
    let mut builder = reqwest::blocking::Client::builder()
        .user_agent(format!("open-science-desktop/{}", env.version()))
        .timeout(TIMEOUT);
    builder = match &proxy {
        Some(url) => builder.proxy(
            reqwest::Proxy::all(url).map_err(|e| fail("proxy", format!("proxy {url}: {e}")))?,
        ),
        None => builder.no_proxy(),
    };
    let client = builder
        .build()
        .map_err(|e| fail("offline", e.to_string()))?;
    let classify = |e: reqwest::Error| {
        let kind = if e.is_timeout() {
            "timeout"
        } else if e.is_status() {
            "server"
        } else if proxy.is_some() && e.is_connect() {
            "proxy"
        } else {
            "offline"
        };
        fail(kind, e.to_string())
    };
    client
        .get(CATALOG_URL)
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.text())
        .map_err(classify)
}

/// Validate, diff against the file it replaces, write. Returns how many models
/// appeared.
fn install(root: &Path, body: &str, saved: &mut Saved) -> Result<usize, CatalogError> {
    let invalid = |message: String| CatalogError {
        kind: "invalid".into(),
        message,
        at: now_ms(),
    };
    let next: serde_json::Value = serde_json::from_str(body).map_err(|e| invalid(e.to_string()))?;
    validate(&next).map_err(invalid)?;
    let path = catalog_path(root);
    // No previous file (a first launch) means nothing to call new.
    let previous = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
    let added = previous.map(|p| added_keys(&p, &next)).unwrap_or_default();
    crate::runtime::write_atomic(&path, body).map_err(invalid)?;
    let now = now_ms();
    for key in &added {
        saved.new_models.entry(key.clone()).or_insert(now);
    }
    Ok(added.len())
}

/// Never replace a working catalog with something that is not one: a captive
/// portal page, a truncated body, an error JSON.
fn validate(v: &serde_json::Value) -> Result<(), String> {
    let has_models = |p: &str| {
        v.get(p)
            .and_then(|p| p.get("models"))
            .is_some_and(|m| m.is_object())
    };
    if has_models("openai") && has_models("anthropic") {
        Ok(())
    } else {
        Err("not a model catalog".into())
    }
}

/// Picker keys (`provider/model`) in `next` but not `prev`. OpenCode also lists
/// each `experimental.modes` entry as its own model (`gpt-6.1-sol-fast`).
fn added_keys(prev: &serde_json::Value, next: &serde_json::Value) -> Vec<String> {
    let before: HashSet<String> = model_keys(prev).into_iter().collect();
    model_keys(next)
        .into_iter()
        .filter(|k| !before.contains(k))
        .collect()
}

fn model_keys(catalog: &serde_json::Value) -> Vec<String> {
    let mut keys = Vec::new();
    for (provider, entry) in catalog.as_object().into_iter().flatten() {
        for (id, model) in entry["models"].as_object().into_iter().flatten() {
            keys.push(format!("{provider}/{id}"));
            for mode in model["experimental"]["modes"]
                .as_object()
                .into_iter()
                .flatten()
                .map(|m| m.0)
            {
                keys.push(format!("{provider}/{id}-{mode}"));
            }
        }
    }
    keys
}

fn catalog_path(root: &Path) -> PathBuf {
    crate::model_prices::catalog_path(root)
}

fn saved_path(root: &Path) -> PathBuf {
    root.join("model-catalog.json")
}

fn load_saved(root: &Path) -> Saved {
    std::fs::read_to_string(saved_path(root))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(root: &Path, saved: &Saved) -> Result<(), String> {
    let json = serde_json::to_string(saved).map_err(|e| e.to_string())?;
    crate::runtime::write_atomic(&saved_path(root), &json)
}

fn modified_ms(path: &Path) -> Option<u64> {
    let t = std::fs::metadata(path).and_then(|m| m.modified()).ok()?;
    Some(t.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_a_catalog_and_refuses_anything_else() {
        let ok = json!({"openai":{"models":{"gpt-6.1-sol":{}}},"anthropic":{"models":{}}});
        assert!(validate(&ok).is_ok());
        assert!(validate(&json!({"error":"rate limited"})).is_err());
        assert!(validate(&json!({"openai":{"models":{}}})).is_err());
    }

    #[test]
    fn new_models_include_their_modes_and_only_what_appeared() {
        let prev = json!({"openai":{"models":{"gpt-6.1-sol":{}}}});
        let next = json!({"openai":{"models":{
            "gpt-6.1-sol":{},
            "gpt-6.1-terra":{"experimental":{"modes":{"fast":{}}}}
        }},"xai":{"models":{"grok-5":{}}}});
        let mut added = added_keys(&prev, &next);
        added.sort();
        assert_eq!(
            added,
            [
                "openai/gpt-6.1-terra",
                "openai/gpt-6.1-terra-fast",
                "xai/grok-5"
            ]
        );
    }

    #[test]
    fn install_records_new_models_but_not_on_a_first_download() {
        let root =
            std::env::temp_dir().join(format!("osd-catalog-{}-{}", std::process::id(), now_ms()));
        let a = json!({"openai":{"models":{"a":{}}},"anthropic":{"models":{}}}).to_string();
        let b = json!({"openai":{"models":{"a":{},"b":{}}},"anthropic":{"models":{}}}).to_string();
        let mut saved = Saved::default();
        assert_eq!(install(&root, &a, &mut saved).unwrap(), 0);
        assert_eq!(install(&root, &b, &mut saved).unwrap(), 1);
        assert!(saved.new_models.contains_key("openai/b"));
        // A body that is not a catalog leaves the installed one alone.
        assert_eq!(
            install(&root, "<html>", &mut saved).unwrap_err().kind,
            "invalid"
        );
        assert_eq!(std::fs::read_to_string(catalog_path(&root)).unwrap(), b);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn only_recently_touched_projects_are_asked() {
        let now = 10 * ACTIVE_WINDOW_MS;
        let sessions = json!([
            {"directory":"/a","time":{"updated": now - 1000}},
            {"directory":"/a","time":{"updated": now - 2000}},
            {"directory":"/b","time":{"updated": now - 2 * ACTIVE_WINDOW_MS}},
            {"directory":"/c","time":{"updated": now}}
        ]);
        assert_eq!(recent_directories(&sessions, now), ["/a", "/c"]);
    }

    #[test]
    fn a_busy_or_retrying_session_is_not_idle() {
        assert!(all_idle(&json!({})));
        assert!(all_idle(&json!({"ses_1":{"type":"idle"}})));
        assert!(!all_idle(&json!({"ses_1":{"type":"busy"}})));
        assert!(!all_idle(&json!({"ses_1":{"type":"retry","attempt":2}})));
        assert!(!all_idle(&json!("unexpected")));
    }
}
