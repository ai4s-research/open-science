import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { createImeGate } from "./terminalKeys";

type Step = { key: [string, KeyboardEventInit] } | { commit: string } | "tick";

// Replays a key/IME trace on a real xterm and returns what reached the shell.
async function replay(steps: Step[], withGate: boolean): Promise<string[]> {
  const term = new Terminal({ allowProposedApi: true });
  if (withGate) {
    const gate = createImeGate(term);
    term.attachCustomKeyEventHandler((event) => {
      gate(event);
      return true;
    });
  }
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  term.open(parent);
  const sent: string[] = [];
  term.onData((d) => sent.push(d));
  const ta = term.textarea!;
  const tick = () => new Promise((r) => setTimeout(r, 5));
  for (const step of steps) {
    if (step === "tick") await tick();
    else if ("commit" in step) {
      ta.value += step.commit;
      ta.dispatchEvent(new InputEvent("input", { data: step.commit, inputType: "insertText", composed: true }));
    } else {
      const [type, init] = step.key;
      ta.dispatchEvent(new KeyboardEvent(type, { bubbles: true, ...init }));
    }
  }
  await tick();
  term.dispose();
  parent.remove();
  return sent;
}

const shift: Step = { key: ["keydown", { key: "Shift", code: "ShiftLeft", keyCode: 16, shiftKey: true }] };
const ime = (type: string, code: string): Step => ({ key: [type, { key: "Process", code, keyCode: 229, shiftKey: true }] });

// macOS Pinyin commits full-width punctuation BEFORE the key's own keydown
// (xtermjs/xterm.js#6144, real-device trace).
// "tick" stands for the gap between a person's keystrokes.
const shiftTwice: Step[] = [shift, { commit: "？" }, ime("keydown", "Slash"), ime("keyup", "Slash"), "tick", { commit: "？" }, ime("keydown", "Slash"), ime("keyup", "Slash")];

// Shift+9 still down when 0 is pressed: （ then ） with the keys overlapping.
const rollover: Step[] = [shift, { commit: "（" }, ime("keydown", "Digit9"), "tick", { commit: "）" }, ime("keydown", "Digit0"), ime("keyup", "Digit9"), ime("keyup", "Digit0")];

// An IME that commits AFTER the keydown: xterm's textarea check sends it, so the
// gate must still hold the input event back or the text goes twice.
const commitAfterKeydown: Step[] = [ime("keydown", "Comma"), { commit: "，" }, "tick", ime("keyup", "Comma")];

describe("IME punctuation", () => {
  it("xterm still drops it on its own (remove the workaround once this fails)", async () => {
    expect(await replay(shiftTwice, false)).toEqual(["？"]);
    expect(await replay(rollover, false)).toEqual([]);
  });

  it("reaches the shell on the first press with Shift held", async () => {
    expect(await replay(shiftTwice, true)).toEqual(["？", "？"]);
  });

  it("reaches the shell when keys overlap", async () => {
    expect(await replay(rollover, true)).toEqual(["（", "）"]);
  });

  it("goes once when the IME commits after the keydown", async () => {
    expect(await replay(commitAfterKeydown, true)).toEqual(["，"]);
  });
});
