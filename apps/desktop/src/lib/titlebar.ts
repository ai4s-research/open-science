import type { CSSProperties } from "react";

/** macOS overlay-titlebar geometry. The native traffic lights sit at a fixed
 *  window position (tauri `trafficLightPosition`) and do NOT scale with the
 *  webview page zoom (Cmd/Ctrl +/-). So any strip that clears them counter-
 *  scales its height and left inset by 1/--zoom (owned by ZoomProvider) to keep
 *  the collapse/expand button pinned to the lights at every zoom level. */
export const TITLEBAR_HEIGHT_PX = 48; // matches Tailwind h-12
export const TRAFFIC_LIGHT_INSET_PX = 78; // clears the three-button cluster

/** Inline style for a macOS overlay-titlebar strip. When `clearsLights` is
 *  true the strip insets past the traffic lights; otherwise it uses a small pad
 *  (matches pl-2). Both dimensions divide by --zoom so the strip covers the same
 *  PHYSICAL area (where the lights actually are) at every page zoom.
 *
 *  The height is a MINIMUM, not a fixed size. Page zoom leaves CSS pixel values
 *  untouched — it only scales rendering — so above 100% the counter-scaled
 *  height shrinks below what the strip's own buttons and text need, and a fixed
 *  height made them spill over the row below (#63: the chat header distorting
 *  after a zoom change). As a minimum it still grows the strip to clear the
 *  lights when zoomed OUT, and simply yields to the content when zoomed in —
 *  where the lights need less CSS space anyway. */
export function overlayTitlebarStyle(clearsLights: boolean): CSSProperties {
  return {
    minHeight: `calc(${TITLEBAR_HEIGHT_PX}px / var(--zoom))`,
    paddingLeft: clearsLights
      ? `calc(${TRAFFIC_LIGHT_INSET_PX}px / var(--zoom))`
      : "calc(0.5rem / var(--zoom))",
  };
}
