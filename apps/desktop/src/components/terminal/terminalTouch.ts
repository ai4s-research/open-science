/** How far a finger may drift and still count as a tap, in CSS px. */
const TAP_SLOP_PX = 10;
/** A press longer than this is a long-press (select, menu), not a tap. */
const TAP_MAX_MS = 500;
/** The visible page this much shorter than the window means the keyboard is up. */
const KEYBOARD_MIN_PX = 120;

function keyboardShown(): boolean {
  const vv = window.visualViewport;
  return !!vv && window.innerHeight - vv.height > KEYBOARD_MIN_PX;
}

/**
 * On a touch screen, the terminal's keyboard comes up on a TAP only.
 *
 * xterm focuses its hidden textarea on any mousedown, and a phone synthesizes
 * one for a short swipe it reads as a tap, so scrolling the terminal kept
 * throwing the keyboard over the very lines being read. The app also focuses
 * the terminal itself (on mount, on take-over). So the textarea stays focused
 * as usual but asks for no keyboard (`inputmode="none"`) until a deliberate
 * tap — one finger, under 10 px of drift, under half a second — switches it to
 * text and refocuses inside that gesture, which is what opens the keyboard.
 * Losing focus (the keyboard dismissed by tapping elsewhere) makes it quiet again.
 *
 * Returns the cleanup. A no-op without a coarse pointer, so a desktop with a
 * mouse is untouched.
 */
export function installTapToType(container: HTMLElement, textarea: HTMLTextAreaElement | undefined): () => void {
  if (!textarea || !window.matchMedia?.("(pointer: coarse)").matches) return () => {};
  const quiet = () => {
    textarea.inputMode = "none";
  };
  quiet();
  let start: { x: number; y: number; at: number } | null = null;
  let moved = false;
  const onStart = (e: TouchEvent) => {
    const t = e.touches.length === 1 ? e.touches[0] : undefined;
    start = t ? { x: t.clientX, y: t.clientY, at: Date.now() } : null;
    moved = false;
  };
  const onMove = (e: TouchEvent) => {
    const t = e.touches[0];
    if (start && t && Math.hypot(t.clientX - start.x, t.clientY - start.y) > TAP_SLOP_PX) moved = true;
  };
  const onEnd = () => {
    const tap = start && !moved && Date.now() - start.at <= TAP_MAX_MS;
    start = null;
    if (!tap || (textarea.inputMode === "text" && document.activeElement === textarea && keyboardShown())) return;
    // Blur first: the blur handler quiets it, and a field that is already
    // focused does not raise the keyboard just because its inputmode changed.
    textarea.blur();
    textarea.inputMode = "text";
    textarea.focus({ preventScroll: true });
  };
  const opts = { capture: true, passive: true } as const;
  container.addEventListener("touchstart", onStart, opts);
  container.addEventListener("touchmove", onMove, opts);
  container.addEventListener("touchend", onEnd, opts);
  textarea.addEventListener("blur", quiet);
  return () => {
    container.removeEventListener("touchstart", onStart, opts);
    container.removeEventListener("touchmove", onMove, opts);
    container.removeEventListener("touchend", onEnd, opts);
    textarea.removeEventListener("blur", quiet);
  };
}
