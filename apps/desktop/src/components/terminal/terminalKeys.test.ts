import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { createKeyTranslator, createPunctuationPassThrough } from "./terminalKeys";

const key = (init: KeyboardEventInit & { type?: string }) =>
  new KeyboardEvent(init.type ?? "keydown", init);

describe("terminal keys", () => {
  it("Shift+Enter starts a new line instead of sending", () => {
    for (const mac of [true, false]) {
      const t = createKeyTranslator(mac);
      expect(t(key({ key: "Enter", code: "Enter", shiftKey: true }))).toBe("\n");
      // Its keypress must not reach xterm too, or "\r" follows the "\n".
      expect(t(key({ type: "keypress", key: "Enter", code: "Enter", shiftKey: true }))).toBe(false);
      expect(t(key({ key: "Enter", code: "Enter" }))).toBeNull();
    }
  });

  it("left Option is Meta on a Mac; right Option still composes", () => {
    const t = createKeyTranslator(true);
    t(key({ key: "Alt", code: "AltLeft", altKey: true }));
    expect(t(key({ key: "π", code: "KeyP", altKey: true }))).toBe("\x1bp");
    expect(t(key({ key: "ı", code: "KeyB", altKey: true, shiftKey: true }))).toBe("\x1bB");
    expect(t(key({ key: "≥", code: "Period", altKey: true }))).toBe("\x1b.");
    t(key({ type: "keyup", key: "Alt", code: "AltLeft" }));

    t(key({ key: "Alt", code: "AltRight", altKey: true }));
    expect(t(key({ key: "€", code: "Digit2", altKey: true, shiftKey: true }))).toBeNull();
    expect(t(key({ key: "´", code: "KeyE", altKey: true }))).toBeNull();
  });

  it("Cmd+←/→/⌫ edit the line on a Mac", () => {
    const t = createKeyTranslator(true);
    expect(t(key({ key: "ArrowLeft", code: "ArrowLeft", metaKey: true }))).toBe("\x01");
    expect(t(key({ key: "ArrowRight", code: "ArrowRight", metaKey: true }))).toBe("\x05");
    expect(t(key({ key: "Backspace", code: "Backspace", metaKey: true }))).toBe("\x15");
    // Copy, paste and the app's own ⌘ shortcuts are not the line editor's.
    expect(t(key({ key: "c", code: "KeyC", metaKey: true }))).toBeNull();
  });

  it("leaves Alt alone off a Mac", () => {
    const t = createKeyTranslator(false);
    t(key({ key: "Alt", code: "AltLeft", altKey: true }));
    expect(t(key({ key: "b", code: "KeyB", altKey: true }))).toBeNull();
  });

  it("a modifier pressed alone never reaches xterm, so the view does not jump to the bottom", () => {
    for (const mac of [true, false]) {
      const t = createKeyTranslator(mac);
      for (const code of ["MetaLeft", "ControlLeft", "ControlRight", "ShiftLeft", "AltRight", "CapsLock"]) {
        // With an input method on, WebKit reports it as an IME key.
        expect(t(key({ key: "Process", code, keyCode: 229 }))).toBe(false);
        expect(t(key({ type: "keyup", key: "Process", code }))).toBeNull();
      }
      // The chord itself is still xterm's.
      expect(t(key({ key: "o", code: "KeyO", ctrlKey: true }))).toBeNull();
    }
    // Swallowing the Option keydown still arms Meta.
    const t = createKeyTranslator(true);
    expect(t(key({ key: "Alt", code: "AltLeft", altKey: true }))).toBe(false);
    expect(t(key({ key: "π", code: "KeyP", altKey: true }))).toBe("\x1bp");
  });
});

describe("punctuation through the input method (xtermjs#4486)", () => {
  const typed = (data: string) => new InputEvent("input", { inputType: "insertText", data });

  it("sends what the browser inserts for a punctuation key, once", () => {
    const input = vi.fn();
    const p = createPunctuationPassThrough({ input } as unknown as Terminal);
    // Chrome + Sogou: the keydown says ".", the input method inserts "。".
    expect(p.key(key({ key: ".", code: "Period", keyCode: 190 } as KeyboardEventInit))).toBe(true);
    expect(p.key(key({ type: "keypress", key: "." }))).toBe(true);
    p.input(typed("。"));
    p.input(typed("。"));
    expect(input.mock.calls).toEqual([["。"]]);
    expect(p.key(key({ type: "keyup", key: "." }))).toBe(false);
  });

  it("leaves letters, digits, modified keys and IME keys to xterm", () => {
    const input = vi.fn();
    const p = createPunctuationPassThrough({ input } as unknown as Terminal);
    for (const init of [
      { key: "a", code: "KeyA" },
      { key: "1", code: "Digit1" },
      { key: " ", code: "Space" },
      { key: "Enter", code: "Enter" },
      { key: ".", code: "Period", ctrlKey: true },
      { key: ".", code: "Period", keyCode: 229 },
    ]) {
      expect(p.key(key(init as KeyboardEventInit))).toBe(false);
      p.input(typed(init.key));
    }
    expect(input).not.toHaveBeenCalled();
  });
});
