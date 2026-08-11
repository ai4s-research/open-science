import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useUiStore } from "@/lib/store";
import { useIsMobile } from "@/lib/useIsMobile";

vi.mock("@/lib/tauri", () => ({ isTauri: true }));

const setWidth = (px: number) => {
  Object.defineProperty(window, "innerWidth", { value: px, configurable: true });
};

afterEach(() => {
  setWidth(1024); // jsdom's default
  useUiStore.setState({ zoom: 1 });
});

describe("useIsMobile", () => {
  it("is mobile only below the breakpoint at 100% zoom", () => {
    setWidth(1200);
    expect(renderHook(() => useIsMobile()).result.current).toBe(false);
    setWidth(700);
    expect(renderHook(() => useIsMobile()).result.current).toBe(true);
    // Exactly at the breakpoint counts as mobile, matching `max-width: 768px`.
    setWidth(768);
    expect(renderHook(() => useIsMobile()).result.current).toBe(true);
  });

  it("keeps the desktop layout when zoom shrinks the CSS viewport (#63)", () => {
    // A 1200 px window at 175%: the CSS viewport is ~686 px, so a plain
    // `max-width: 768px` query would flip the whole shell into phone layout —
    // overlay sidebar, bottom-sheet pickers — for a window that is not narrow.
    useUiStore.setState({ zoom: 1.75 });
    setWidth(Math.round(1200 / 1.75));
    expect(renderHook(() => useIsMobile()).result.current).toBe(false);
  });

  it("still reports mobile for a genuinely narrow zoomed window", () => {
    // 700 px window at 150% — narrow on its own terms, so phone layout is right.
    useUiStore.setState({ zoom: 1.5 });
    setWidth(Math.round(700 / 1.5));
    expect(renderHook(() => useIsMobile()).result.current).toBe(true);
  });

  it("does not flash phone layout in the frames before a zoom-out applies", () => {
    // The store's factor lands one render before the webview has resized, so the
    // new zoom is briefly paired with the OLD innerWidth. An 800 px window going
    // to 50%: 800 × 0.5 = 400, which alone would read as a phone — on a window
    // that is about to have MORE room, not less.
    useUiStore.setState({ zoom: 0.5 });
    setWidth(800); // not yet 1600
    expect(renderHook(() => useIsMobile()).result.current).toBe(false);
    // And once the resize lands, the settled answer is the same.
    setWidth(1600);
    expect(renderHook(() => useIsMobile()).result.current).toBe(false);
  });

  it("treats zooming out as more room, not less", () => {
    // 900 px window at 75%: 1200 CSS px. Was already desktop, stays desktop.
    useUiStore.setState({ zoom: 0.75 });
    setWidth(1200);
    expect(renderHook(() => useIsMobile()).result.current).toBe(false);
  });
});
