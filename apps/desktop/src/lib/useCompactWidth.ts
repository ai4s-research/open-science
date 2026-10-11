import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * True while the observed element is narrower than `minPx` — the cue for a
 * toolbar to keep its icons and drop their labels.
 *
 * Measured on the element itself, not the viewport: what decides whether
 * "Approve for me · Build · GPT-5.6 sol" fits is the width of THAT pane, and a
 * pane is narrow for reasons a media query cannot see (a sibling pane, an open
 * inspector, the sidebar). Pane count is not a proxy either — a lone pane in a
 * small window is just as cramped.
 *
 * The first measurement happens in a layout effect, before the browser paints.
 * Waiting for the ResizeObserver's first callback instead meant every mount
 * painted the wide layout and corrected a frame later, so switching to a Screen
 * with tiled panes visibly flashed the composer and the session header from
 * icon+label down to icon.
 *
 * `laidOut` is that same guarantee for an element that mounts with NO layout:
 * an inactive Screen stays mounted but display:none, so its panes measure zero
 * until it is shown. Pass the flag that turns the box on and the measurement
 * happens in the layout effect of that very render — the observer's callback
 * would land a frame late, which is exactly the flash above.
 */
export function useCompactWidth(
  ref: RefObject<HTMLElement | null>,
  minPx: number,
  laidOut = true,
): boolean {
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Only a positive width is a real measurement. Zero means the element is
    // not laid out yet — a hidden ancestor, or a test environment with no
    // layout at all — and treating that as "narrow" would collapse a toolbar
    // that is about to be perfectly wide. Leave it to the observer.
    const width = el.getBoundingClientRect().width;
    if (width > 0) setCompact(width < minPx);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      // Zero is not a measurement here either — an inactive Screen is mounted
      // but display:none, and reading that as "narrow" would collapse the
      // toolbar, then expand it a frame after the Screen is shown again.
      const observed = entry?.contentRect.width ?? 0;
      if (observed > 0) setCompact(observed < minPx);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, minPx, laidOut]);
  return compact;
}

/** Width a one-line flex row's children need side by side, unshrunk: each
 *  child's own box plus the row's gaps and padding. Children must be
 *  `shrink-0`, or a squeezed child reports its squeezed width. */
function naturalWidth(row: HTMLElement): number {
  const style = getComputedStyle(row);
  const kids = Array.from(row.children).filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el.getClientRects().length > 0,
  );
  const gap = parseFloat(style.columnGap) || 0;
  const pad = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  return kids.reduce((sum, el) => sum + el.offsetWidth, 0) + gap * Math.max(0, kids.length - 1) + pad;
}

/**
 * True while a toolbar row's items, labels and all, do not fit it — the cue to
 * drop the labels and keep the icons.
 *
 * A fixed breakpoint (useCompactWidth) cannot decide this for a row whose
 * contents vary: a fresh draft carries a folder chip, a long model name is
 * twice a short one, and at 440px a pane with both overflowed — the model chip
 * squeezed until its "· effort ⌄" spilled over the send button. So the row is
 * measured: labelled, its items' natural width against the room it has; once
 * compact, what the labels cost (learned when they were dropped) is added back
 * to decide whether they fit again. Both run before paint, so a wrong guess is
 * corrected in the same frame, and learning the cost from the same content
 * means it cannot flip back and forth.
 *
 * `laidOut`: as for useCompactWidth — re-attach when a hidden Screen returns.
 */
export function useLabelsOverflow(ref: RefObject<HTMLElement | null>, laidOut = true): boolean {
  const [compact, setCompact] = useState(false);
  const compactRef = useRef(false);
  /** Natural width with labels, last time they were shown. */
  const labelled = useRef(0);
  /** What the labels add over the compact row; learned on the first compact measure. */
  const labelCost = useRef<number | null>(null);

  const measure = () => {
    const row = ref.current;
    if (!row) return;
    const room = row.clientWidth;
    // Zero is no measurement: a hidden Screen, or a test without layout.
    if (room <= 0) return;
    const natural = naturalWidth(row);
    if (!compactRef.current) {
      labelled.current = natural;
      if (natural > room) {
        compactRef.current = true;
        labelCost.current = null;
        setCompact(true);
      }
      return;
    }
    labelCost.current ??= labelled.current - natural;
    if (natural + labelCost.current <= room) {
      compactRef.current = false;
      setCompact(false);
    }
  };

  // Mount: measure once synchronously (pre-paint, same guarantee the old
  // every-render effect gave the first frame). After that, re-measure only
  // when something that can change the need actually changes — the row's own
  // size (ResizeObserver) or its labels (MutationObserver: a model pick swaps
  // label text; a class flip can change the font). The old every-render
  // measure ran on EVERY streamed token of any session on the page (#157).
  useLayoutEffect(() => {
    const row = ref.current;
    if (!row) return;
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `measure` reads refs only
  }, [ref, laidOut]);

  useLayoutEffect(() => {
    const row = ref.current;
    if (!row || typeof MutationObserver === "undefined") return;
    const mo = new MutationObserver(measure);
    mo.observe(row, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `measure` reads refs only
  }, [ref, laidOut]);

  return compact;
}
