import { describe, expect, it } from "vitest";
import { trafficLightsPresent } from "./tauri";
import {
  overlayTitlebarStyle,
  TITLEBAR_HEIGHT_PX,
  TRAFFIC_LIGHT_INSET_PX,
} from "./titlebar";

// The macOS traffic lights sit OVER our content in overlay-titlebar mode, so
// several headers add a ~78px left inset to clear them. In native fullscreen
// the lights hide — the inset then leaves a weird empty gap (the collapsed
// expand button and the sidebar's collapse button both floated indented).
describe("trafficLightsPresent (macOS overlay-titlebar inset)", () => {
  it("true only in the packaged macOS webview AND not fullscreen", () => {
    expect(trafficLightsPresent(true, true, false)).toBe(true);
  });

  it("false in fullscreen — the lights hide, so the inset would be a gap", () => {
    expect(trafficLightsPresent(true, true, true)).toBe(false);
  });

  it("false in a plain browser (pnpm dev) and on non-mac platforms", () => {
    expect(trafficLightsPresent(false, true, false)).toBe(false);
    expect(trafficLightsPresent(true, false, false)).toBe(false);
  });
});

// Page zoom scales rendering but leaves CSS pixel VALUES alone, so a strip
// pinned to `height: 48px / zoom` gets shorter than its own contents above
// 100% and the header spilled into the conversation below it (#63).
describe("overlayTitlebarStyle (zoom)", () => {
  it("constrains the strip's height as a minimum, never a cap", () => {
    const style = overlayTitlebarStyle(true);
    expect(style.minHeight).toBe(`calc(${TITLEBAR_HEIGHT_PX}px / var(--zoom))`);
    expect(style.height).toBeUndefined();
  });

  it("counter-scales the traffic-light inset, which is native and never zooms", () => {
    expect(overlayTitlebarStyle(true).paddingLeft).toBe(
      `calc(${TRAFFIC_LIGHT_INSET_PX}px / var(--zoom))`,
    );
    // Without lights to clear, only a small pad.
    expect(overlayTitlebarStyle(false).paddingLeft).toBe("calc(0.5rem / var(--zoom))");
  });
});
