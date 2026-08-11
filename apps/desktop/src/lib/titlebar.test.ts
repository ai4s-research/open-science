import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

// The lights themselves are NATIVE — their position comes from the Tauri window
// config, not from CSS. macOS merges `tauri.macos.conf.json` over the base by
// REPLACING the whole `windows` array, so a value changed in one file and not
// the other silently diverges. The visible symptom is the collapse button and
// the Screen tabs sitting a few points below the lights, which has regressed
// once already.
describe("traffic-light position (native, config-driven)", () => {
  const read = (rel: string) =>
    JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")) as {
      app: { windows: { trafficLightPosition?: { x: number; y: number } }[] };
    };
  const base = read("../../src-tauri/tauri.conf.json").app.windows[0]!;
  const mac = read("../../src-tauri/tauri.macos.conf.json").app.windows[0]!;

  it("is identical in the base and macOS window configs", () => {
    expect(mac.trafficLightPosition).toEqual(base.trafficLightPosition);
  });

  it("sits where the strip centres its own content", () => {
    // Measured against a real window: the strips centre their content in
    // TITLEBAR_HEIGHT_PX, and this is the y that puts the lights on that same
    // line. Pinned so a future edit cannot drift them apart unnoticed.
    expect(base.trafficLightPosition?.y).toBe(26);
  });
});
