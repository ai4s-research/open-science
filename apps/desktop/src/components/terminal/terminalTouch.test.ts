import { afterEach, describe, expect, it, vi } from "vitest";
import { installTapToType } from "./terminalTouch";

function touch(target: HTMLElement, type: string, x = 0, y = 0, fingers = 1) {
  const e = new Event(type, { bubbles: true });
  const list = Array.from({ length: type === "touchend" ? 0 : fingers }, () => ({ clientX: x, clientY: y }));
  Object.defineProperty(e, "touches", { value: list });
  target.dispatchEvent(e);
}

function setup(coarse: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: coarse && q === "(pointer: coarse)" }));
  const container = document.createElement("div");
  const textarea = document.createElement("textarea");
  container.appendChild(textarea);
  document.body.appendChild(container);
  const cleanup = installTapToType(container, textarea);
  return { container, textarea, cleanup };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("terminal keyboard on a touch screen", () => {
  it("asks for no keyboard while the app focuses the terminal itself", () => {
    const { textarea } = setup(true);
    textarea.focus();
    expect(document.activeElement).toBe(textarea);
    expect(textarea.inputMode).toBe("none");
  });

  it("raises the keyboard on a tap", () => {
    const { container, textarea } = setup(true);
    touch(container, "touchstart", 100, 100);
    touch(container, "touchmove", 104, 103);
    touch(container, "touchend");
    expect(textarea.inputMode).toBe("text");
    expect(document.activeElement).toBe(textarea);
  });

  it("keeps it down while scrolling, and after the field loses focus", () => {
    const { container, textarea } = setup(true);
    touch(container, "touchstart", 100, 300);
    touch(container, "touchmove", 100, 200);
    touch(container, "touchend");
    expect(textarea.inputMode).toBe("none");

    touch(container, "touchstart", 100, 100);
    touch(container, "touchend");
    expect(textarea.inputMode).toBe("text");
    textarea.blur();
    expect(textarea.inputMode).toBe("none");
  });

  it("does not count a long press or a two-finger touch as a tap", () => {
    const { container, textarea } = setup(true);
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    touch(container, "touchstart", 100, 100);
    now.mockReturnValue(800);
    touch(container, "touchend");
    expect(textarea.inputMode).toBe("none");
    now.mockRestore();

    touch(container, "touchstart", 100, 100, 2);
    touch(container, "touchend");
    expect(textarea.inputMode).toBe("none");
  });

  it("leaves a mouse-driven desktop alone", () => {
    const { container, textarea, cleanup } = setup(false);
    touch(container, "touchstart");
    touch(container, "touchend");
    expect(textarea.inputMode).toBe("");
    cleanup();
  });
});
