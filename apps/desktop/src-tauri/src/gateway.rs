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
    GatewayState::new(assets, Some(on_sessions_changed))
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
) -> Result<GatewayStatus, String> {
    osd_core::gateway::set_gateway_config(&env_of(&app), state.inner(), enabled, lan, mode, port)
}

#[tauri::command(async)]
pub fn regenerate_gateway_token(
    app: AppHandle,
    state: State<'_, GatewayState>,
) -> Result<GatewayStatus, String> {
    osd_core::gateway::regenerate_gateway_token(&env_of(&app), state.inner())
}
