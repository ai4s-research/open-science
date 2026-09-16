/**
 * Find text in rendered content — a conversation, a preview — without touching
 * the DOM that React owns.
 *
 * Matches are `Range`s handed to the CSS Custom Highlight API, so nothing is
 * wrapped in `<mark>`: wrapping would fight React on the next render, break
 * text selection across the seams, and re-run every message component. The
 * highlight is a paint-time overlay; the document underneath is untouched.
 *
 * Where the API is missing, the current match is still scrolled to and selected
 * — the browser paints a selection natively — so find works, just without the
 * other matches lit up.
 */

/** Registered highlight names. Two, so the current match can be painted
 *  differently from the rest, as every editor does. */
const ALL = "osd-find";
const CURRENT = "osd-find-current";

export interface FindOptions {
  caseSensitive: boolean;
  regex: boolean;
}

/** Every match of `query` inside `root`, in document order. */
export function findRanges(root: Element, query: string, options: FindOptions): Range[] {
  if (!query) return [];
  const pattern = buildPattern(query, options);
  if (!pattern) return [];

  const ranges: Range[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      // Script and style text is not content, and neither is a collapsed box.
      node.parentElement?.closest("script, style, [data-find-skip]")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? "";
    if (!text) continue;
    pattern.lastIndex = 0;
    for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
      // A pattern that can match nothing (`a*`) would loop for ever.
      if (m[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      const range = root.ownerDocument.createRange();
      range.setStart(node, m.index);
      range.setEnd(node, m.index + m[0].length);
      ranges.push(range);
      if (ranges.length >= MAX_MATCHES) return ranges;
    }
  }
  return ranges;
}

/** Enough to navigate; past this the highlights cost more than they inform. */
export const MAX_MATCHES = 2000;

function buildPattern(query: string, options: FindOptions): RegExp | null {
  const flags = options.caseSensitive ? "g" : "gi";
  try {
    return new RegExp(options.regex ? query : escapeRegex(query), flags);
  } catch {
    // A half-typed regex (`(`) is not an error to report — the user is still
    // typing it. No pattern, no matches.
    return null;
  }
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Paint `ranges`, with `current` marked apart. Safe to call when the browser
 *  has no Highlight API — it simply paints nothing. */
export function paintHighlights(
  ranges: Range[],
  current: Range | null,
  scope?: Element | null,
  token?: object,
): void {
  // Not the live search: a bar left open in another pane must not paint its
  // matches back over the registry the visible one just cleared.
  if (token && owner !== token) return;
  const highlights = highlightRegistry();
  if (!highlights) return;
  highlights.set(ALL, new Highlight(...ranges));
  highlights.set(CURRENT, new Highlight(...(current ? [current] : [])));
  repaint(scope);
}

export function clearHighlights(scope?: Element | null): void {
  const highlights = highlightRegistry();
  if (!highlights) return;
  highlights.delete(ALL);
  highlights.delete(CURRENT);
  repaint(scope);
}

/**
 * Make the engine paint `scope` again.
 *
 * Changing the highlight registry does not reliably invalidate the area that
 * was painted with the OLD highlights. On WKWebView — the engine the desktop
 * app runs — the matches stay lit on screen after the registry has dropped
 * them, until something else happens to repaint that region (a scroll, a new
 * message, a hover). That is exactly the report: closing the search does not
 * clear the highlights *immediately*, and a previous query's matches stay lit
 * next to the current one's. The registry is right; the pixels are stale.
 *
 * A compositing-only property forces the subtree to be rastered again. Opacity
 * a thousandth below 1 is imperceptible and moves nothing, so there is no
 * flicker and no reflow; it is put back on the second frame, because restoring
 * it within the same frame would coalesce into no change at all — and no
 * change is no repaint.
 */
function repaint(scope: Element | null | undefined): void {
  if (!(scope instanceof HTMLElement)) return;
  const view = scope.ownerDocument.defaultView;
  if (!view || typeof view.requestAnimationFrame !== "function") return;
  const previous = scope.style.opacity;
  scope.style.opacity = "0.999";
  view.requestAnimationFrame(() => {
    view.requestAnimationFrame(() => {
      scope.style.opacity = previous;
    });
  });
}

function highlightRegistry(): HighlightRegistry | null {
  return typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights : null;
}

/** Bring a match into view and select it.
 *
 *  The selection is what makes find usable where the Highlight API is missing,
 *  and it is also how ⌘C after a find copies what was found. */
export function revealRange(range: Range): void {
  const element =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  element?.scrollIntoView({ block: "center", behavior: "smooth" });
  const selection = range.startContainer.ownerDocument?.defaultView?.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range.cloneRange());
}

/**
 * Put everything back: the highlights AND the selection find made.
 *
 * Clearing the highlights alone left the last match still SELECTED, which
 * looks exactly like a highlight that refused to go away — the search was
 * closed and the text was still lit.
 *
 * Only a selection that lies inside the searched content is dropped. A
 * selection the user made somewhere else is theirs, and closing a find bar is
 * no reason to take it.
 */
/**
 * One search owns the highlights at a time.
 *
 * The registry is the document's, not a component's: two panes each hold a
 * conversation, each can have a find bar open, and both write the same two
 * names. Without an owner the bar left open in the background repaints its
 * matches the moment its conversation streams another block — over the pane
 * the reader is looking at, after that pane's search was closed. The last bar
 * to open owns them; the others go quiet.
 */
let owner: object | null = null;

export function claimFind(token: object): void {
  owner = token;
}

export function ownsFind(token: object): boolean {
  return owner === token;
}

/** Give up ownership and take the highlights with it. A release by a bar that
 *  no longer owns them leaves the current owner's highlights alone. */
export function releaseFind(token: object, scope: Element | null): void {
  if (owner !== token) return;
  owner = null;
  clearFind(scope);
}

export function clearFind(scope: Element | null): void {
  clearHighlights(scope);
  const view = scope?.ownerDocument?.defaultView ?? (typeof window === "undefined" ? null : window);
  const selection = view?.getSelection();
  if (!scope || !selection || selection.rangeCount === 0) return;
  if (scope.contains(selection.getRangeAt(0).commonAncestorContainer)) {
    selection.removeAllRanges();
  }
}
