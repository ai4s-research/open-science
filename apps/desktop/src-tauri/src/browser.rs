// Browser control via the bundled agent-browser sidecar (Vercel Labs). We do
// NOT drive Chrome ourselves — agent-browser exposes an MCP stdio server the
// OpenCode agent talks to. This module only does the desktop-side glue the
// frontend can't: resolve the sidecar's on-disk path (OpenCode, not Tauri,
// spawns it, so it needs an absolute command), enumerate the user's Chrome
// profiles, detect an installed executable for a separate managed process, and
// (fallback) download a browser when none is present. All MCP wiring itself is
// registered from the
// frontend via OpenCodeClient.addMcpServer, mirroring the science connectors.
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

/// Shared with `src/lib/browser.ts`. The fixed namespace lets the app reclaim
/// only its own browser sessions, without touching a user's agent-browser CLI.
const BROWSER_NAMESPACE: &str = "open-science-desktop";

fn close_args() -> [&'static str; 4] {
    ["--namespace", BROWSER_NAMESPACE, "close", "--all"]
}

/// One Chrome profile as agent-browser reports it. `directory` is what gets
/// passed as AGENT_BROWSER_PROFILE (e.g. "Default", "Profile 4"); `name` is the
/// human label (person / account name) for the picker.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct BrowserProfile {
    pub directory: String,
    pub name: String,
}

/// An installed Chromium-family executable agent-browser can use for its own
/// process (avoids downloading Chrome for Testing). It never attaches to the
/// user's already-running browser.
#[derive(Clone, serde::Serialize)]
pub struct ChromeInfo {
    pub path: String,
    /// "chrome" | "chromium" | "edge" | "brave" — shown so the user knows what
    /// will be driven.
    pub kind: String,
}

/// Envelope agent-browser prints for `--json` commands.
#[derive(serde::Deserialize)]
struct ProfilesEnvelope {
    #[serde(default)]
    data: Vec<BrowserProfile>,
    #[serde(default)]
    success: bool,
}

/// Absolute path to the bundled agent-browser sidecar. OpenCode spawns the MCP
/// server itself (it is not on PATH), so the frontend needs the real path to
/// put in the MCP `command`. Tauri places externalBin next to the app
/// executable with the target-triple suffix stripped.
#[tauri::command]
pub fn agent_browser_bin(_app: AppHandle) -> Result<String, String> {
    crate::runtime::sidecar_bin("agent-browser")
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| {
            "agent-browser sidecar not found next to the app. \
             Run scripts/dev/fetch-agent-browser.sh and rebuild."
                .to_string()
        })
}

/// Absolute path to this desktop executable. A second invocation with
/// `--browser-mcp` runs only the ownership proxy and never starts Tauri.
#[tauri::command]
pub fn browser_mcp_bin() -> Result<String, String> {
    std::env::current_exe()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|e| format!("could not resolve browser MCP proxy: {e}"))
}

/// Close every browser session owned by this app. Used before reconfiguration
/// and when Browser Control is disabled. "No active sessions" is a successful
/// no-op in agent-browser.
#[tauri::command]
pub async fn close_agent_browser(app: AppHandle) -> Result<(), String> {
    let out = app
        .shell()
        .sidecar("agent-browser")
        .map_err(|e| format!("agent-browser sidecar not found: {e}"))?
        .args(close_args())
        .output()
        .await
        .map_err(|e| format!("could not close browser sessions: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            "could not close browser sessions".to_string()
        } else {
            format!("could not close browser sessions: {stderr}")
        })
    }
}

/// Best-effort exit cleanup. Spawn instead of waiting so a stuck helper can
/// never hold the desktop app open; the short-lived CLI closes the namespaced
/// daemon after the UI process has gone away.
pub fn close_agent_browser_on_exit() {
    let Some(bin) = crate::runtime::sidecar_bin("agent-browser") else {
        return;
    };
    let _ = crate::runtime::quiet_command(bin)
        .args(close_args())
        .spawn();
}

/// List the user's Chrome profiles via `agent-browser profiles --json`. Returns
/// an empty list (not an error) when no Chrome / no profiles exist, so the UI
/// can fall back to the download flow.
#[tauri::command]
pub async fn agent_browser_profiles(app: AppHandle) -> Result<Vec<BrowserProfile>, String> {
    let out = app
        .shell()
        .sidecar("agent-browser")
        .map_err(|e| format!("agent-browser sidecar not found: {e}"))?
        .args(["profiles", "--json"])
        .output()
        .await
        .map_err(|e| format!("agent-browser profiles failed: {e}"))?;
    if !out.status.success() {
        // No Chrome installed is a normal state, not an error.
        return Ok(Vec::new());
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    match serde_json::from_str::<ProfilesEnvelope>(stdout.trim()) {
        Ok(env) if env.success => Ok(env.data),
        _ => Ok(Vec::new()),
    }
}

/// First installed Chromium-family browser found in the platform's standard
/// locations, or None. Used to set AGENT_BROWSER_EXECUTABLE_PATH so we reuse
/// the user's Chrome instead of downloading one.
#[tauri::command]
pub fn detect_chrome() -> Option<ChromeInfo> {
    for (kind, candidates) in chrome_candidates() {
        for c in candidates {
            let p = PathBuf::from(&c);
            if p.exists() {
                return Some(ChromeInfo {
                    path: c,
                    kind: kind.to_string(),
                });
            }
        }
    }
    None
}

/// Platform-specific executable locations, most-preferred browser first.
fn chrome_candidates() -> Vec<(&'static str, Vec<String>)> {
    let home = std::env::var("HOME").unwrap_or_default();
    #[cfg(target_os = "macos")]
    {
        let user = |app: &str| format!("{home}{app}");
        vec![
            (
                "chrome",
                vec![
                    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".into(),
                    user("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
                ],
            ),
            (
                "edge",
                vec!["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge".into()],
            ),
            (
                "brave",
                vec![
                    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser".into(),
                ],
            ),
            (
                "chromium",
                vec!["/Applications/Chromium.app/Contents/MacOS/Chromium".into()],
            ),
        ]
    }
    #[cfg(target_os = "windows")]
    {
        let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into());
        let pf86 = std::env::var("ProgramFiles(x86)")
            .unwrap_or_else(|_| "C:\\Program Files (x86)".into());
        let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
        vec![
            (
                "chrome",
                vec![
                    format!("{pf}\\Google\\Chrome\\Application\\chrome.exe"),
                    format!("{pf86}\\Google\\Chrome\\Application\\chrome.exe"),
                    format!("{local}\\Google\\Chrome\\Application\\chrome.exe"),
                ],
            ),
            (
                "edge",
                vec![
                    format!("{pf86}\\Microsoft\\Edge\\Application\\msedge.exe"),
                    format!("{pf}\\Microsoft\\Edge\\Application\\msedge.exe"),
                ],
            ),
            (
                "brave",
                vec![format!(
                    "{pf}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
                )],
            ),
        ]
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = home;
        vec![
            (
                "chrome",
                vec![
                    "/usr/bin/google-chrome".into(),
                    "/usr/bin/google-chrome-stable".into(),
                    "/opt/google/chrome/chrome".into(),
                ],
            ),
            (
                "chromium",
                vec![
                    "/usr/bin/chromium".into(),
                    "/usr/bin/chromium-browser".into(),
                    "/snap/bin/chromium".into(),
                ],
            ),
            ("edge", vec!["/usr/bin/microsoft-edge".into()]),
            ("brave", vec!["/usr/bin/brave-browser".into()]),
        ]
    }
}

/// No output for this long during a Chrome download = wedged, not slow.
const STALL_SECS: u64 = 600;

/// Download a browser via `agent-browser install` (Chrome for Testing) when no
/// system Chrome is present. Streams progress as `setup-progress` (task
/// "browser") and honors the app's proxy setting so the download works behind a
/// proxy. Kills + fails on a long silence rather than hanging the UI forever.
#[tauri::command]
pub async fn setup_browser_chrome(app: AppHandle) -> Result<(), String> {
    let mut cmd = app
        .shell()
        .sidecar("agent-browser")
        .map_err(|e| format!("agent-browser sidecar not found: {e}"))?
        .args(["install"]);
    for (k, v) in crate::runtime::sidecar_proxy_env(&app) {
        cmd = cmd.env(k, v);
    }
    let (mut rx, child) = cmd
        .spawn()
        .map_err(|e| format!("browser install failed to start: {e}"))?;

    let mut last = String::new();
    loop {
        let event = match tokio::time::timeout(Duration::from_secs(STALL_SECS), rx.recv()).await {
            Err(_) => {
                let _ = child.kill();
                return Err(format!(
                    "browser download stalled — no output for {} minutes. Check your \
                     network/proxy and retry.",
                    STALL_SECS / 60
                ));
            }
            Ok(None) => return Err(format!("browser install exited without a status: {last}")),
            Ok(Some(event)) => event,
        };
        match event {
            CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                for line in String::from_utf8_lossy(&bytes).split(['\n', '\r']) {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    last = line.to_string();
                    let _ = app.emit(
                        "setup-progress",
                        crate::uv::SetupProgress {
                            task: "browser",
                            line: line.to_string(),
                        },
                    );
                }
            }
            CommandEvent::Terminated(status) => {
                return if status.code == Some(0) {
                    Ok(())
                } else {
                    Err(format!("browser install failed: {last}"))
                };
            }
            _ => {}
        }
    }
}
