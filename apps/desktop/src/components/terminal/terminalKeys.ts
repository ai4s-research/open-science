/**
 * Keys a native terminal sends differently from xterm.js out of the box, which
 * Claude Code, Codex and the shell's line editor rely on.
 *
 * - Shift+Enter → "\n" (line feed). xterm sends "\r", the same as Enter, so a
 *   CLI cannot tell them apart and Shift+Enter SENDS instead of starting a new
 *   line. A line feed is what Claude Code's own `/terminal-setup` makes iTerm2
 *   send, and what Claude Code and Codex read as "new line".
 * - macOS, left Option + a letter, digit or `. , / -` → Esc + that key: Meta,
 *   as iTerm2's "Esc+" setting gives it. Readline's word moves (Option+B/F/D)
 *   and Claude Code's Option+P / Option+T need it. Only the LEFT Option: the
 *   right one still composes, so layouts that type `@`, `€` or accents with
 *   Option keep them (why `macOptionIsMeta` stays off for the terminal).
 * - macOS, Cmd+← / Cmd+→ / Cmd+Backspace → start of line / end of line /
 *   delete to start (^A, ^E, ^U), as in any macOS text field and VS Code's
 *   terminal. xterm sends nothing for them.
 * - A modifier pressed on its own (⌘, Ctrl, Shift, Option, Caps Lock, Fn) never
 *   reaches xterm. It sends nothing, but with an input method on (Sogou,
 *   macOS Pinyin) WebKit reports it as an IME key (keyCode 229), which xterm
 *   treats as typing and scrolls to the bottom: pressing ⌘ to click a link or
 *   Ctrl on the way to Ctrl+O threw away the user's place in the scrollback.
 *   Matched on `code`, the physical key, since an IME key's `key` is unreliable.
 *
 * Everything else is left to xterm, which already encodes Option+←/→/⌫,
 * Option+Enter, Shift+Tab and the Ctrl keys the way a native terminal does.
 */

import type { Terminal } from "@xterm/xterm";

const MODIFIER_CODE = /^(?:(?:Meta|OS|Control|Shift|Alt)(?:Left|Right)|CapsLock|Fn|FnLock)$/;

/** A modifier pressed on its own, matched on the physical key. */
export function isModifierKey(event: KeyboardEvent): boolean {
  return MODIFIER_CODE.test(event.code);
}

/**
 * Keeps xterm 5.5 from dropping IME text. Call with every event xterm's custom
 * key handler sees. xterm ignores IME text that arrives while a keydown is
 * "seen" and not yet released, but macOS Pinyin commits full-width
 * punctuation (？：！（）《》) BEFORE that key's own keydown, so the text is
 * dropped whenever another key is still down:
 * - Shift held: a modifier counts as a key, so the first one was lost.
 *   A modifier types nothing, so its keydown never arms the gate.
 * - Keys rolled over (Shift+9 still down when 0 is pressed): 9 holds the gate
 *   and "）" was lost. An IME key outside a composition (keyCode 229) sends
 *   its text through xterm's own textarea check, queued on a timer from its
 *   keydown, so once that check has run nothing else of that key can arrive
 *   and the gate is released. Released only if no other key came since.
 * Upstream: xtermjs/xterm.js#6144, fix in #6200; the test pins the private
 * field so an xterm upgrade that renames it fails loudly.
 */
export function createImeGate(term: Terminal) {
  const release = () => {
    const core = (term as unknown as { _core?: { _keyDownSeen?: boolean } })._core;
    if (core) core._keyDownSeen = false;
  };
  let keydowns = 0;
  return (event: KeyboardEvent): void => {
    if (event.type !== "keydown") return;
    const seen = ++keydowns;
    if (isModifierKey(event)) release();
    else if (event.keyCode === 229 && !event.isComposing) {
      // This handler runs before xterm queues its check, so wait one more turn.
      setTimeout(() => setTimeout(() => seen === keydowns && release()));
    }
  };
}

const META_PUNCTUATION: Record<string, string> = {
  Period: ".",
  Comma: ",",
  Slash: "/",
  Minus: "-",
};

/** The character a key stands for under Meta, from its physical position — on
 *  a Mac the event's `key` is already the composed glyph (Option+P is "π"). */
function metaChar(event: KeyboardEvent): string | null {
  const { code, shiftKey } = event;
  if (/^Key[A-Z]$/.test(code)) {
    const c = code.slice(3);
    return shiftKey ? c : c.toLowerCase();
  }
  if (shiftKey) return null;
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return META_PUNCTUATION[code] ?? null;
}

/**
 * A translator for one terminal. Call it with every event xterm's custom key
 * handler sees: it returns the bytes to send for a key it takes over, `false`
 * for an event that must not reach xterm (the keypress/keyup of a key already
 * taken), and `null` for everything xterm should handle as usual.
 */
export function createKeyTranslator(isMac: boolean) {
  // Which Option is down is only told by the Option key's own event.
  let leftOption = false;
  return (event: KeyboardEvent): string | false | null => {
    if (event.code === "AltLeft") leftOption = event.type === "keydown";
    // A window that lost focus with the key held never sees its keyup.
    else if (!event.altKey) leftOption = false;
    if (isModifierKey(event)) return event.type === "keydown" ? false : null;

    const data = translate(event);
    if (data === null) return null;
    return event.type === "keydown" ? data : false;
  };

  function translate(event: KeyboardEvent): string | null {
    const { key, altKey, ctrlKey, metaKey, shiftKey } = event;
    if (key === "Enter" && shiftKey && !altKey && !ctrlKey && !metaKey) return "\n";
    if (!isMac) return null;
    if (metaKey && !altKey && !ctrlKey && !shiftKey) {
      if (key === "ArrowLeft") return "\x01";
      if (key === "ArrowRight") return "\x05";
      if (key === "Backspace") return "\x15";
      return null;
    }
    if (altKey && leftOption && !ctrlKey && !metaKey) {
      const c = metaChar(event);
      return c === null ? null : `\x1b${c}`;
    }
    return null;
  }
}

/** A plain punctuation key: one printable character that is not a letter,
 *  digit or space, with nothing but Shift held, outside a composition. */
function isPunctuationKey(event: KeyboardEvent): boolean {
  return (
    event.key.length === 1 &&
    !/[\p{L}\p{N}\s]/u.test(event.key) &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.isComposing &&
    event.keyCode !== 229
  );
}

/**
 * Lets the input method type punctuation. Chrome on macOS reports a key that
 * Sogou (and other Chinese input methods) turn into "。" as a plain "." key
 * (keyCode 190, not the IME's 229); xterm sends `key` from the keydown and
 * cancels it, so the input method never inserts "。" and the shell gets ".".
 * Upstream: xtermjs/xterm.js#4486, open.
 *
 * Such a key is left to the browser instead: the keydown and keypress skip
 * xterm, and the text the browser then inserts into xterm's textarea, "。"
 * with the input method, "." without, is sent as typed. Call `key` with
 * every event xterm's custom key handler sees (true: xterm must skip it) and
 * `input` with the textarea's input events, before xterm's own listener.
 */
export function createPunctuationPassThrough(term: Terminal) {
  let armed = false;
  return {
    key(event: KeyboardEvent): boolean {
      if (event.type === "keydown") return (armed = isPunctuationKey(event));
      // The keyup still reaches xterm: it is what ends xterm's "key down" state.
      if (event.type === "keyup") return (armed = false);
      return armed;
    },
    input(event: InputEvent): void {
      if (!armed || event.inputType !== "insertText" || !event.data) return;
      armed = false;
      event.stopPropagation();
      // Emptied, as xterm keeps it for keys it handles: text left behind would
      // be sent again by xterm's next IME key (it diffs the whole value).
      if (event.target instanceof HTMLTextAreaElement) event.target.value = "";
      term.input(event.data);
    },
  };
}
