import { useEffect, useState, type RefObject } from "react";

/**
 * True while the observed element is narrower than `minPx` — the cue for a
 * toolbar to keep its icons and drop their labels.
 *
 * Measured on the element itself, not the viewport: what decides whether
 * "Approve for me · Build · GPT-5.6 sol" fits is the width of THAT pane, and a
 * pane is narrow for reasons a media query cannot see (a sibling pane, an open
 * inspector, the sidebar). Pane count is not a proxy either — a lone pane in a
 * small window is just as cramped.
 */
export function useCompactWidth(ref: RefObject<HTMLElement | null>, minPx: number): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      setCompact((entry?.contentRect.width ?? 0) < minPx);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, minPx]);
  return compact;
}
