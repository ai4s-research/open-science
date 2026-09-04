// The web client, compiled in by build.rs, behind the gateway's `Assets` trait.
use osd_core::gateway::Assets;

include!(concat!(env!("OUT_DIR"), "/assets.rs"));

pub struct Embedded;

impl Assets for Embedded {
    fn get(&self, path: &str) -> Option<(Vec<u8>, String)> {
        let path = path.trim_start_matches('/');
        let (_, bytes) = ASSETS.iter().find(|(p, _)| *p == path)?;
        Some((bytes.to_vec(), mime_of(path).to_string()))
    }
}

/// Whether this build carries a web client at all.
pub fn is_empty() -> bool {
    ASSETS.is_empty()
}

/// Content type by extension. Only the types a Vite build actually emits —
/// anything else is served as a byte stream rather than guessed at, and
/// `nosniff` (which the gateway always sends) makes a wrong guess fatal.
fn mime_of(path: &str) -> &'static str {
    match path.rsplit_once('.').map(|(_, ext)| ext) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") | Some("map") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("wasm") => "application/wasm",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_embedded_asset_has_a_real_content_type() {
        // `nosniff` means a wrong or missing type breaks the page silently, so
        // no shipped asset may fall through to the byte-stream default.
        let unknown: Vec<&str> = ASSETS
            .iter()
            .map(|(p, _)| *p)
            .filter(|p| mime_of(p) == "application/octet-stream")
            .collect();
        assert!(unknown.is_empty(), "no content type for: {unknown:?}");
    }

    #[test]
    fn a_build_with_a_web_client_serves_its_entry_point() {
        // Skipped on a build with no `dist/` — see build.rs.
        if is_empty() {
            return;
        }
        let (bytes, mime) = Embedded.get("index.html").expect("index.html is embedded");
        assert!(mime.starts_with("text/html"));
        assert!(String::from_utf8_lossy(&bytes).contains("<head>"));
        assert!(Embedded.get("nope.js").is_none());
    }
}
