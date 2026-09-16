/**
 * Find text in rendered content — a conversation, a preview — without touching
 * the DOM that React owns.
 *
 * Matches are `Range`s, and they are drawn as rectangles in one overlay this
 * module appends to the searched element. Nothing is wrapped in `<mark>`:
 * wrapping would fight React on the next render, break text selection across
 * the seams, and re-run every message component. The overlay is a leaf the
 * module creates and destroys; the document underneath is untouched.
 */

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

/**
 * Paint `ranges`, with `current` marked apart.
 *
 * The matches are drawn as rectangles in an overlay this module owns, the way
 * an editor draws its own decorations (VS Code, CodeMirror, PDF.js all do it
 * this way). It replaced the CSS Custom Highlight API, which registers the
 * matches with the engine and leaves the painting to it: in WKWebView the
 * engine kept the old matches lit after the registry had dropped them, so a
 * closed search stayed highlighted and a previous query's hits sat next to the
 * current one's. Erasing an overlay is removing nodes from the document, which
 * no engine can leave on screen.
 */
export function paintHighlights(
  ranges: Range[],
  current: Range | null,
  scope?: Element | null,
  token?: object,
): void {
  // Not the live search: a bar left open in another pane must not paint its
  // matches back over the one the reader is looking at.
  if (token && owner !== token) return;
  if (!(scope instanceof HTMLElement)) return;

  const overlay = overlayFor(scope);
  // Rebuilt whole, never patched: two generations of a search can then never
  // be on screen at once.
  overlay.replaceChildren();
  if (ranges.length === 0) return;

  const box = scope.getBoundingClientRect();
  // Page zoom (⌘+/-) scales what `getClientRects` reports but not the lengths
  // the overlay is positioned with, so the two are reconciled here.
  const scale = scope.offsetWidth > 0 ? box.width / scope.offsetWidth : 1;
  // A screen above and below as well: the reader scrolls a little without a
  // repaint catching up, and a rectangle for each of two thousand matches
  // costs far more than anyone can see at once.
  const margin = scope.clientHeight;
  const doc = scope.ownerDocument;
  const hits = doc.createDocumentFragment();

  for (const range of ranges) {
    const bounds = range.getBoundingClientRect();
    if (bounds.bottom < box.top - margin || bounds.top > box.bottom + margin) continue;
    for (const rect of range.getClientRects()) {
      if (rect.width === 0 || rect.height === 0) continue;
      const hit = doc.createElement("div");
      hit.className = range === current ? "osd-find-hit osd-find-hit-current" : "osd-find-hit";
      hit.style.left = `${(rect.left - box.left) / scale + scope.scrollLeft}px`;
      hit.style.top = `${(rect.top - box.top) / scale + scope.scrollTop}px`;
      hit.style.width = `${rect.width / scale}px`;
      hit.style.height = `${rect.height / scale}px`;
      hits.appendChild(hit);
    }
  }
  overlay.appendChild(hits);
}

export function clearHighlights(scope?: Element | null): void {
  if (!(scope instanceof HTMLElement)) return;
  scope.querySelector(`:scope > [${OVERLAY}]`)?.remove();
}

/** Marks the overlay, so it is found again and never searched. */
const OVERLAY = "data-osd-find-overlay";

/** The overlay lives inside the searched element and scrolls with it, so the
 *  rectangles stay on their words without a scroll handler moving them. */
function overlayFor(scope: HTMLElement): HTMLElement {
  const existing = scope.querySelector<HTMLElement>(`:scope > [${OVERLAY}]`);
  if (existing) return existing;

  const view = scope.ownerDocument.defaultView;
  // Absolute positions inside it are only meaningful if it is a containing
  // block; a scroll container is `static` by default.
  if (view && view.getComputedStyle(scope).position === "static") {
    scope.style.position = "relative";
  }
  const overlay = scope.ownerDocument.createElement("div");
  overlay.setAttribute(OVERLAY, "");
  // It holds no text and takes no clicks: neither find, nor a screen reader,
  // nor the mouse has any business in it.
  overlay.setAttribute("data-find-skip", "");
  overlay.setAttribute("aria-hidden", "true");
  scope.appendChild(overlay);
  return overlay;
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
 * One search owns the highlights at a time.
 *
 * The overlay is per element, but a reader is searching one thing: two panes
 * each hold a conversation and each can have a find bar open. Without an owner
 * the bar left open in the background repaints its
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
export function clearFind(scope: Element | null): void {
  clearHighlights(scope);
  const view = scope?.ownerDocument?.defaultView ?? (typeof window === "undefined" ? null : window);
  const selection = view?.getSelection();
  if (!scope || !selection || selection.rangeCount === 0) return;
  if (scope.contains(selection.getRangeAt(0).commonAncestorContainer)) {
    selection.removeAllRanges();
  }
}
