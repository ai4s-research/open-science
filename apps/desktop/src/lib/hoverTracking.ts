import { useEffect } from "react";

/** Set on the one message the pointer is over, anywhere in the app. The
 *  hover-revealed rows inside it (Copy, the turn's timing/context readout) are
 *  shown by this, not by `:hover` — see index.css. */
const HOVERED = "data-hovered";
/** Marks a message container as something that can be "the one under the
 *  pointer". Put it on the outermost element of a message. */
export const HOVER_HOST = "data-hover-host";

/** How often a standing mark is re-checked against the pointer position. */
const RECHECK_MS = 250;

let current: Element | null = null;
/** Where the pointer was when we last heard from it, so the mark can be
 *  re-checked without one. */
let lastX = 0;
let lastY = 0;
let recheck = 0;

function mark(el: Element | null): void {
  if (el === current) return;
  current?.removeAttribute(HOVERED);
  current = el;
  current?.setAttribute(HOVERED, "");
  // Re-check only while something is marked: one hit-test a few times a second
  // costs nothing next to a hovered row, and nothing at all the rest of the time.
  if (current && !recheck) recheck = window.setInterval(revalidate, RECHECK_MS);
  if (!current && recheck) {
    window.clearInterval(recheck);
    recheck = 0;
  }
}

/**
 * Is the marked message still under the pointer? Asked WITHOUT a pointer event,
 * because the case that survived three fixes has none: scrolling a long
 * conversation with a trackpad moves the content, not the cursor, so the
 * message the pointer was over slides away and no event is dispatched to say
 * so — the row stayed lit wherever it landed. Short conversations never showed
 * it because there was nothing to scroll.
 */
function revalidate(): void {
  // jsdom has no hit-testing; there is nothing to re-check without layout.
  if (!current || typeof document.elementFromPoint !== "function") return;
  const under = document.elementFromPoint(lastX, lastY);
  if (!under || !current.contains(under)) mark(null);
}

function onPointer(event: Event): void {
  const target = event.target instanceof Element ? event.target : null;
  if (event instanceof MouseEvent) {
    lastX = event.clientX;
    lastY = event.clientY;
  }
  mark(target?.closest(`[${HOVER_HOST}]`) ?? null);
}

/**
 * Track which message the pointer is over — one listener, for the whole app.
 *
 * CSS `:hover` cannot be trusted for this, and three reports came from the same
 * root: WebKit keeps the flag on whatever the cursor last touched. Hiding a
 * Screen out from under the pointer delivers no `pointerleave`, a conversation
 * scrolling under a still cursor never re-evaluates, and a tiled pane renders
 * at 75% zoom and hit-tests in its own coordinate space. The result was a Copy
 * button and a whole timing readout left lit — on one Screen, while every other
 * Screen behaved.
 *
 * Per-element enter/leave listeners were the first fix and were not enough:
 * every one of them depends on the engine delivering an event for the boundary
 * that was crossed, which is the very thing going wrong. This listens on the
 * document instead, so ANY pointer movement anywhere re-derives the answer from
 * the event's own target: a mark cannot outlive the next movement, wherever it
 * happens. Marking is a single attribute write, so a long conversation neither
 * re-renders nor reconciles as the pointer travels down it.
 */
export function useHoverTracking(): void {
  useEffect(() => {
    const clear = () => mark(null);
    // Capture phase: a stopped-propagation move inside some widget must not
    // strand a mark somewhere else.
    document.addEventListener("pointermove", onPointer, true);
    document.addEventListener("pointerdown", onPointer, true);
    // The pointer left the window (or the window lost focus) — nothing is under
    // it any more, and no element will be told so. `mouseout` with no related
    // target is the one WebKit reliably fires at the window edge; the others
    // are belt and braces for the paths it does not.
    const onOut = (e: MouseEvent) => !e.relatedTarget && clear();
    document.addEventListener("mouseout", onOut);
    // Content moving under a still pointer is the one case no pointer event
    // reports; re-check immediately rather than waiting for the interval.
    document.addEventListener("scroll", revalidate, true);
    document.addEventListener("wheel", revalidate, true);
    document.documentElement.addEventListener("mouseleave", clear);
    document.addEventListener("pointerleave", clear);
    window.addEventListener("blur", clear);
    return () => {
      clear();
      document.removeEventListener("pointermove", onPointer, true);
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("mouseout", onOut);
      document.removeEventListener("scroll", revalidate, true);
      document.removeEventListener("wheel", revalidate, true);
      document.documentElement.removeEventListener("mouseleave", clear);
      document.removeEventListener("pointerleave", clear);
      window.removeEventListener("blur", clear);
    };
  }, []);
}
