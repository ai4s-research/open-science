//! macOS-only window chrome fixes.

use tauri::{Manager, Window};

/// Fallback for a config with no `trafficLightPosition` at all. The real value
/// is READ from the window config below — this used to be a hardcoded copy of
/// it, which silently won over the JSON and drifted out of sync with it twice.
const TRAFFIC_LIGHT_X: f64 = 13.0;
const TRAFFIC_LIGHT_Y: f64 = 26.0;

/// The configured inset for `window`, from the SAME config the window was built
/// from (on macOS that is `tauri.conf.json` merged with `tauri.macos.conf.json`).
fn configured_inset(window: &Window) -> (f64, f64) {
    window
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == window.label())
        .and_then(|w| w.traffic_light_position.as_ref())
        .map(|p| (p.x, p.y))
        .unwrap_or((TRAFFIC_LIGHT_X, TRAFFIC_LIGHT_Y))
}

/// Re-pin the traffic lights to the configured inset.
///
/// tao re-applies the inset only from the content view's `drawRect:`, which
/// does not fire reliably on a transparent window with a vibrancy material —
/// on some machines the lights snap back to the native default position (top
/// of the window) and drift away from the titlebar strip's collapse button.
/// This mirrors tao's `inset_traffic_lights` and is called from window events
/// (focus, resize, theme change), which cover launch, zoom and the in-app
/// theme switch.
pub fn reapply_traffic_light_inset(window: &Window) {
    let (inset_x, inset_y) = configured_inset(window);
    let w = window.clone();
    // AppKit is main-thread-only; window events usually arrive there already.
    let _ = window.run_on_main_thread(move || unsafe {
        use objc2_app_kit::{NSWindow, NSWindowButton};
        let Ok(ptr) = w.ns_window() else { return };
        let ns = &*ptr.cast::<NSWindow>();
        let Some(close) = ns.standardWindowButton(NSWindowButton::CloseButton) else {
            return;
        };
        let Some(mini) = ns.standardWindowButton(NSWindowButton::MiniaturizeButton) else {
            return;
        };
        let Some(zoom) = ns.standardWindowButton(NSWindowButton::ZoomButton) else {
            return;
        };
        let Some(container) = close.superview().and_then(|v| v.superview()) else {
            return;
        };
        // Grow the (hidden) titlebar container so the buttons can sit
        // `inset_y` below the window top, then walk the three buttons to
        // `inset_x` keeping their native spacing.
        let close_rect = close.frame();
        let titlebar_height = close_rect.size.height + inset_y;
        let mut container_rect = container.frame();
        container_rect.size.height = titlebar_height;
        container_rect.origin.y = ns.frame().size.height - titlebar_height;
        container.setFrame(container_rect);
        let spacing = mini.frame().origin.x - close_rect.origin.x;
        for (i, button) in [&*close, &*mini, &*zoom].into_iter().enumerate() {
            let mut rect = button.frame();
            rect.origin.x = inset_x + i as f64 * spacing;
            button.setFrameOrigin(rect.origin);
        }
    });
}
