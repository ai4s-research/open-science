// Discover the models a user-entered custom endpoint serves — and, where the
// server reports it, each model's context window — so the Settings form can
// offer them instead of asking for hand-typed ids (#49). Runs in Rust because
// the webview's fetch is subject to CORS, which local model servers (vLLM,
// LM Studio, llama.cpp) generally do not send headers for.
//
// The same reason puts `zen_models` here: opencode.ai sends no CORS headers
// either, and the model picker needs its list to stop offering models OpenCode
// Zen has retired.

use serde::Serialize;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProbedModel {
    pub id: String,
    /// Context window in tokens, when the server reports one.
    pub context: Option<u64>,
}

#[tauri::command]
pub async fn probe_endpoint_models(
    base_url: String,
    api_key: Option<String>,
    kind: String,
) -> Result<Vec<ProbedModel>, String> {
    tauri::async_runtime::spawn_blocking(move || probe(&base_url, api_key.as_deref(), &kind))
        .await
        .map_err(|e| format!("model probe task failed: {e}"))?
}

/// OpenCode Zen's own serving list — the built-in free provider's gateway.
///
/// The picker's model list comes from the models.dev catalog, which is a
/// SUPERSET of what Zen actually serves: 29 of its 91 zen entries, including 19
/// of the 25 `*-free` ones, are retired and answer the first turn with
/// `401 {"type":"ModelError","message":"Model <id> is not supported"}`
/// (measured 2026-08-15). This endpoint is the authority on what is live.
///
/// Deliberately sent WITHOUT credentials: the answer is then the gateway's full
/// public catalog (it lists the paid models too) rather than an account-scoped
/// view, so a user with a Zen key never has their own models filtered away —
/// and no key leaves the keychain to reach it.
const ZEN_MODELS_URL: &str = "https://opencode.ai/zen/v1/models";

#[tauri::command]
pub async fn zen_models() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(fetch_zen_models)
        .await
        .map_err(|e| format!("zen model list task failed: {e}"))?
}

pub fn fetch_zen_models() -> Result<Vec<String>, String> {
    let body = client()?
        .get(ZEN_MODELS_URL)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("could not reach the OpenCode Zen model list: {e}"))?
        .text()
        .map_err(|e| format!("could not read the OpenCode Zen model list: {e}"))?;
    Ok(parse_openai_models(&body)?.into_iter().map(|m| m.id).collect())
}

fn probe(base_url: &str, api_key: Option<&str>, kind: &str) -> Result<Vec<ProbedModel>, String> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("Base URL is empty".into());
    }
    // Ollama's native API is the only common local server that reports each
    // model's context length, so try it first. Its OpenAI-compatible base is
    // `…:11434/v1`; the native API lives at the root.
    if let Some(models) = probe_ollama(base.trim_end_matches("/v1")) {
        return Ok(models);
    }
    match kind {
        "anthropic" => probe_anthropic(base, api_key),
        _ => probe_openai(base, api_key),
    }
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent("Open Science Desktop model probe")
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("could not create HTTP client: {e}"))
}

/// Ollama native API: GET /api/tags lists models, POST /api/show reports
/// `model_info["<arch>.context_length"]`. Returns None when this is not an
/// Ollama server (any transport/HTTP/parse failure on /api/tags).
fn probe_ollama(root: &str) -> Option<Vec<ProbedModel>> {
    let client = client().ok()?;
    let body = client
        .get(format!("{root}/api/tags"))
        .send()
        .and_then(|r| r.error_for_status())
        .ok()?
        .text()
        .ok()?;
    let names = parse_ollama_tags(&body)?;
    let models = names
        .into_iter()
        .map(|name| {
            // Context length is best-effort per model — a failed /api/show
            // still lists the model, it just falls back to the app default.
            let context = client
                .post(format!("{root}/api/show"))
                .header("content-type", "application/json")
                .body(serde_json::json!({ "model": name }).to_string())
                .send()
                .and_then(|r| r.error_for_status())
                .ok()
                .and_then(|r| r.text().ok())
                .and_then(|body| parse_ollama_show_context(&body));
            ProbedModel { id: name, context }
        })
        .collect();
    Some(models)
}

fn parse_ollama_tags(body: &str) -> Option<Vec<String>> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let models = v.get("models")?.as_array()?;
    Some(
        models
            .iter()
            .filter_map(|m| m.get("name")?.as_str().map(String::from))
            .collect(),
    )
}

fn parse_ollama_show_context(body: &str) -> Option<u64> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let info = v.get("model_info")?.as_object()?;
    info.iter()
        .find(|(k, _)| k.ends_with(".context_length"))
        .and_then(|(_, v)| v.as_u64())
}

/// OpenAI-compatible: GET /models. Context length is non-standard but several
/// servers report it (vLLM `max_model_len`, OpenRouter `context_length`,
/// LM Studio `max_context_length`).
fn probe_openai(base: &str, api_key: Option<&str>) -> Result<Vec<ProbedModel>, String> {
    let mut req = client()?.get(format!("{base}/models"));
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        req = req.bearer_auth(key);
    }
    let body = req
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("could not list models: {e}"))?
        .text()
        .map_err(|e| format!("could not read the model list: {e}"))?;
    parse_openai_models(&body)
}

fn parse_openai_models(body: &str) -> Result<Vec<ProbedModel>, String> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("model list was not JSON: {e}"))?;
    // Standard shape is {data: [...]}; some servers return a bare array.
    let list = v
        .get("data")
        .and_then(|d| d.as_array())
        .or_else(|| v.as_array())
        .ok_or("model list had no data array")?;
    let models: Vec<ProbedModel> = list
        .iter()
        .filter_map(|m| {
            let id = m.get("id")?.as_str()?.to_string();
            let context = ["context_length", "max_model_len", "max_context_length"]
                .iter()
                .find_map(|k| m.get(*k).and_then(|v| v.as_u64()));
            Some(ProbedModel { id, context })
        })
        .collect();
    if models.is_empty() {
        return Err("the endpoint listed no models".into());
    }
    Ok(models)
}

/// Anthropic-compatible: GET /models with x-api-key. No context info.
fn probe_anthropic(base: &str, api_key: Option<&str>) -> Result<Vec<ProbedModel>, String> {
    let mut req = client()?
        .get(format!("{base}/models"))
        .header("anthropic-version", "2023-06-01");
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        req = req.header("x-api-key", key);
    }
    let body = req
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("could not list models: {e}"))?
        .text()
        .map_err(|e| format!("could not read the model list: {e}"))?;
    parse_openai_models(&body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ollama_tags_lists_model_names() {
        let body = r#"{"models":[{"name":"nemotron:latest","size":1},{"name":"qwen3:8b"}]}"#;
        assert_eq!(
            parse_ollama_tags(body),
            Some(vec!["nemotron:latest".to_string(), "qwen3:8b".to_string()])
        );
    }

    #[test]
    fn ollama_show_finds_arch_scoped_context_length() {
        let body = r#"{"model_info":{"general.architecture":"llama","llama.context_length":131072,"llama.embedding_length":4096}}"#;
        assert_eq!(parse_ollama_show_context(body), Some(131072));
    }

    #[test]
    fn ollama_show_without_context_is_none() {
        assert_eq!(parse_ollama_show_context(r#"{"model_info":{}}"#), None);
        assert_eq!(parse_ollama_show_context("not json"), None);
    }

    #[test]
    fn openai_models_with_vllm_and_openrouter_fields() {
        let body = r#"{"data":[
            {"id":"meta-llama/Llama-3.1-8B","object":"model","max_model_len":32768},
            {"id":"nvidia/nemotron","context_length":131072},
            {"id":"plain-model"}
        ]}"#;
        let models = parse_openai_models(body).unwrap();
        assert_eq!(models[0].context, Some(32768));
        assert_eq!(models[1].context, Some(131072));
        assert_eq!(models[2], ProbedModel { id: "plain-model".into(), context: None });
    }

    #[test]
    fn openai_models_bare_array_and_empty() {
        let models = parse_openai_models(r#"[{"id":"m1"}]"#).unwrap();
        assert_eq!(models[0].id, "m1");
        assert!(parse_openai_models(r#"{"data":[]}"#).is_err());
        assert!(parse_openai_models("nope").is_err());
    }

    /// Minimal one-thread HTTP responder: routes a request path prefix to a
    /// canned JSON body (anything else 404s), so probe() runs over real HTTP.
    fn serve(routes: Vec<(&'static str, String)>) -> (String, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            // Serve enough requests for a probe run, then stop.
            for _ in 0..16 {
                let Ok((mut stream, _)) = listener.accept() else { return };
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let path = req.split_whitespace().nth(1).unwrap_or("").to_string();
                let body = routes
                    .iter()
                    .find(|(p, _)| path.starts_with(p))
                    .map(|(_, b)| b.clone());
                let resp = match body {
                    Some(b) => format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{b}",
                        b.len()
                    ),
                    None => "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".to_string(),
                };
                let _ = stream.write_all(resp.as_bytes());
            }
        });
        (base, handle)
    }

    #[test]
    fn probe_prefers_ollama_native_and_reports_context() {
        let (base, _h) = serve(vec![
            (
                "/api/tags",
                r#"{"models":[{"name":"nemotron:latest"}]}"#.to_string(),
            ),
            (
                "/api/show",
                r#"{"model_info":{"llama.context_length":131072}}"#.to_string(),
            ),
        ]);
        // The form's Ollama base URL ends in /v1; the native API must be found
        // at the root anyway.
        let models = probe(&format!("{base}/v1"), None, "openai").unwrap();
        assert_eq!(
            models,
            vec![ProbedModel { id: "nemotron:latest".into(), context: Some(131072) }]
        );
    }

    #[test]
    fn probe_falls_back_to_openai_models_when_not_ollama() {
        let (base, _h) = serve(vec![(
            "/v1/models",
            r#"{"data":[{"id":"vllm-model","max_model_len":32768}]}"#.to_string(),
        )]);
        let models = probe(&format!("{base}/v1"), Some("sk-test"), "openai").unwrap();
        assert_eq!(models, vec![ProbedModel { id: "vllm-model".into(), context: Some(32768) }]);
    }
}

