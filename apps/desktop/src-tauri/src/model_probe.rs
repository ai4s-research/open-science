// Tauri commands over `osd_core::model_probe`. Both probes are blocking HTTP
// calls to a possibly-unreachable host, so both run off the UI thread.
use osd_core::model_probe::ProbedModel;

#[tauri::command]
pub async fn probe_endpoint_models(
    base_url: String,
    api_key: Option<String>,
    kind: String,
) -> Result<Vec<ProbedModel>, String> {
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
