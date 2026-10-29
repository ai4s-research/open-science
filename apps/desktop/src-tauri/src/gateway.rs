// Tauri commands over `osd_core::gateway`, plus the one thing the core cannot
// supply: the web client itself. The desktop hands the gateway Tauri's own
// embedded assets, so a phone on the LAN gets the identical UI this window is
// running — not a re-implementation.
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};

use osd_core::gateway::{Assets, GatewayState, GatewayStatus};

use crate::env_of;

/// The frontend bundle Tauri compiled into this binary.
struct TauriAssets(AppHandle);

impl Assets for TauriAssets {
    fn get(&self, path: &str) -> Option<(Vec<u8>, String)> {
        let asset = self.0.asset_resolver().get(path.to_string())?;
        Some((asset.bytes, asset.mime_type))
    }
}

/// Build the gateway state for this app handle. Called once, from `setup`,
/// because both hooks need a live handle.
pub fn state_for(app: &AppHandle) -> GatewayState {
    let assets = Arc::new(TauriAssets(app.clone()));
    let emitter = app.clone();
    let on_sessions_changed = Arc::new(move || {
        let _ = emitter.emit("gateway:sessions-changed", ());
    });
    // A token client changed the Screens it shares with this window.
    let layout_emitter = app.clone();
    let on_desktop_layout = Arc::new(move |json: &str| {
        let _ = layout_emitter.emit("gateway:desktop-layout", json.to_string());
    });
    // A client asked the window to show one of its Screens (`osd screen show`).
    let show_emitter = app.clone();
    let on_show_screen = Arc::new(move |id: &str| {
        let _ = show_emitter.emit("gateway:show-screen", id.to_string());
    });
    // `osd settings`: a read for the window to answer, or a change for the
    // user to approve there — so a change also asks for the user's attention.
    let settings_app = app.clone();
    let on_settings = Arc::new(move |json: &str| {
        let _ = settings_app.emit("gateway:settings", json.to_string());
        if json.contains("\"kind\":\"change\"") {
            if let Some(w) = settings_app.get_webview_window("main") {
                let _ = w.request_user_attention(Some(tauri::UserAttentionType::Informational));
            }
        }
    });
    GatewayState::new(assets, Some(on_sessions_changed))
        .with_terminals(Arc::new(crate::terminal::GatewayTerminals(app.clone())))
        .with_desktop_layout_listener(on_desktop_layout)
        .with_show_screen_listener(on_show_screen)
        .with_settings_listener(on_settings)
}

/// The window's answer to an `osd settings` request: the settings it read, or
/// the user's decision on a change.
#[tauri::command]
pub fn settings_answer(app: AppHandle, id: String, answer: serde_json::Value) -> bool {
    osd_core::gateway::settings_answer(&env_of(&app), &id, answer)
}

/// Bring the remote-access gateway back up if the user left it enabled.
pub fn autostart(app: &AppHandle) {
    let state = app.state::<GatewayState>();
    osd_core::gateway::autostart(&env_of(app), state.inner());
}

/// Stop the accept loop on app exit.
pub fn shutdown(app: &AppHandle, state: &GatewayState) {
    osd_core::gateway::shutdown(&env_of(app), state);
}

#[tauri::command]
pub fn gateway_status(app: AppHandle, state: State<'_, GatewayState>) -> GatewayStatus {
    osd_core::gateway::status_of(&env_of(&app), state.inner())
}

/// Absolute path of the bundled ACP agent script (#14, server direction), or
/// None when it is missing.
#[tauri::command]
pub fn acp_server_script(app: AppHandle) -> Option<String> {
    osd_core::gateway::acp_server_script(&env_of(&app))
}

#[tauri::command(async)]
pub fn set_gateway_config(
    app: AppHandle,
    state: State<'_, GatewayState>,
    enabled: bool,
    lan: bool,
    mode: String,
    port: Option<u16>,
    terminal: bool,
) -> Result<GatewayStatus, String> {
    osd_core::gateway::set_gateway_config(&env_of(&app), state.inner(), enabled, lan, mode, port, terminal)
}

#[tauri::command(async)]
pub fn regenerate_gateway_token(
    app: AppHandle,
    state: State<'_, GatewayState>,
) -> Result<GatewayStatus, String> {
    osd_core::gateway::regenerate_gateway_token(&env_of(&app), state.inner())
}

/// Web accounts (Settings › Remote access): names only — hashes never leave
/// the core.
#[tauri::command]
pub fn web_accounts_list(app: AppHandle) -> Result<Vec<String>, String> {
    osd_core::web_accounts::list(&env_of(&app))
}

/// Create an account, or set a new password (which signs it out everywhere).
#[tauri::command(async)]
pub fn web_account_set(app: AppHandle, name: String, password: String) -> Result<(), String> {
    osd_core::web_accounts::set_password(&env_of(&app), &name, &password)
}

#[tauri::command]
pub fn web_account_delete(app: AppHandle, name: String) -> Result<(), String> {
    osd_core::web_accounts::delete(&env_of(&app), &name)
}

/// Who did what through the gateway (Settings › Remote access › Audit), newest first.
#[tauri::command(async)]
pub fn audit_query(app: AppHandle, filter: osd_core::audit::Filter) -> Result<Vec<osd_core::audit::Entry>, String> {
    osd_core::audit::query(&env_of(&app), &filter)
}

/// The window's Screens, which token clients mirror and accounts can copy.
/// Written on every layout change, debounced by the caller.
#[tauri::command]
pub fn publish_desktop_layout(app: AppHandle, layout: String) -> Result<(), String> {
    osd_core::web_accounts::write_desktop_layout(&env_of(&app), &layout).map(|_| ())
}
