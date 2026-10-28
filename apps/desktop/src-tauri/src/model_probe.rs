// Tauri commands over `osd_core::model_probe`. Both probes are blocking HTTP
// calls to a possibly-unreachable host, so both run off the UI thread.
use osd_core::model_probe::ProbeResult;

#[tauri::command]
pub async fn probe_endpoint_models(
    base_url: String,
    api_key: Option<String>,
    kind: String,
) -> Result<ProbeResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        osd_core::model_probe::probe_endpoint_models(&base_url, api_key.as_deref(), &kind)
    })
    .await
    .map_err(|e| format!("model probe task failed: {e}"))?
}

#[tauri::command]
pub async fn zen_models() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(osd_core::model_probe::fetch_zen_models)
        .await
        .map_err(|e| format!("zen model list task failed: {e}"))?
}

// The model catalog: status is a cheap local read; refresh downloads (up to
// two minutes); apply may restart the runtime. All off the UI thread.
use osd_core::model_catalog::{ApplyOutcome, CatalogStatus};

#[tauri::command]
pub async fn model_catalog_status(app: tauri::AppHandle) -> Result<CatalogStatus, String> {
    let env = crate::env_of(&app);
    tauri::async_runtime::spawn_blocking(move || osd_core::model_catalog::status(&env))
        .await
        .map_err(|e| format!("model catalog task failed: {e}"))
}

#[tauri::command]
pub async fn model_catalog_refresh(app: tauri::AppHandle) -> Result<CatalogStatus, String> {
    let env = crate::env_of(&app);
    tauri::async_runtime::spawn_blocking(move || osd_core::model_catalog::refresh(&env, true))
        .await
        .map_err(|e| format!("model catalog task failed: {e}"))
}

#[tauri::command]
pub async fn model_catalog_apply(app: tauri::AppHandle) -> Result<ApplyOutcome, String> {
    let env = crate::env_of(&app);
    tauri::async_runtime::spawn_blocking(move || osd_core::model_catalog::apply(&env))
        .await
        .map_err(|e| format!("model catalog task failed: {e}"))?
}
