import { useLayoutEffect, useState, type RefObject } from "react";

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
