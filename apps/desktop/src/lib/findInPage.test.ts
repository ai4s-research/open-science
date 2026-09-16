import { beforeEach, describe, expect, it } from "vitest";
import {
  claimFind,
  paintHighlights,
  clearFind,
  findRanges,
  MAX_MATCHES,
  ownsFind,
  releaseFind,
  revealRange,
} from "./findInPage";

function content(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

const PLAIN = { caseSensitive: false, regex: false };

describe("finding text in rendered content", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("finds every occurrence, in document order", () => {
    const root = content("<p>alpha beta</p><p>beta gamma</p>");
    const ranges = findRanges(root, "beta", PLAIN);

    expect(ranges).toHaveLength(2);
    expect(ranges[0].toString()).toBe("beta");
    expect(ranges[0].startContainer.nodeValue).toBe("alpha beta");
    expect(ranges[1].startContainer.nodeValue).toBe("beta gamma");
  });

  it("ignores case unless asked", () => {
    const root = content("<p>Beta and beta</p>");
    expect(findRanges(root, "beta", PLAIN)).toHaveLength(2);
    expect(findRanges(root, "beta", { ...PLAIN, caseSensitive: true })).toHaveLength(1);
  });

  it("treats the query as text, not a pattern, unless asked", () => {
    const root = content("<p>a.b and axb</p>");
    // Without this, searching for a filename would match half the paragraph.
    expect(findRanges(root, "a.b", PLAIN)).toHaveLength(1);
    expect(findRanges(root, "a.b", { ...PLAIN, regex: true })).toHaveLength(2);
  });

  it("finds nothing for a half-typed regular expression", () => {
    const root = content("<p>anything</p>");
    // The user is still typing "(foo)"; an error is not the answer.
    expect(findRanges(root, "(", { ...PLAIN, regex: true })).toEqual([]);
  });

  it("cannot be made to loop by a pattern that matches nothing", () => {
    const root = content("<p>abc</p>");
    // `a*` matches the empty string at every position; advancing by zero would
    // hang the app rather than show a result.
    expect(findRanges(root, "x*", { ...PLAIN, regex: true })).toEqual([]);
  });

  it("leaves script and style text out — that is not content", () => {
    const root = content("<style>.beta{}</style><p>beta</p><script>var beta=1</script>");
    expect(findRanges(root, "beta", PLAIN)).toHaveLength(1);
  });

  it("stops at a bound rather than highlighting a whole transcript", () => {
    const root = content(`<p>${"x ".repeat(MAX_MATCHES + 50)}</p>`);
    expect(findRanges(root, "x", PLAIN)).toHaveLength(MAX_MATCHES);
  });

  it("finds nothing for an empty query", () => {
    expect(findRanges(content("<p>beta</p>"), "", PLAIN)).toEqual([]);
  });
});

describe("leaving a find", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    window.getSelection()?.removeAllRanges();
  });

  it("drops the selection find made, not only the highlights", () => {
    const root = content("<p>alpha beta</p>");
    const range = findRanges(root, "beta", PLAIN)[0]!;
    revealRange(range);
    expect(window.getSelection()?.isCollapsed).toBe(false);

    clearFind(root);

    // Clearing the highlights alone left the last match SELECTED, which looks
    // exactly like a highlight that refused to go away.
    expect(window.getSelection()?.rangeCount ?? 0).toBe(0);
  });

  it("leaves a selection the user made elsewhere alone", () => {
    const root = content("<p>alpha</p>");
    const elsewhere = content("<p id=other>the user's own selection</p>");
    const range = document.createRange();
    range.selectNodeContents(elsewhere.querySelector("#other")!);
    window.getSelection()?.addRange(range);

    clearFind(root);

    // Closing a find bar is no reason to take a selection that was never ours.
    expect(window.getSelection()?.rangeCount).toBe(1);
  });
});

describe("who owns the highlights", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    window.getSelection()?.removeAllRanges();
  });

  it("gives them to the bar that opened last", () => {
    const background = {};
    const foreground = {};
    claimFind(background);
    claimFind(foreground);

    // Two panes, two conversations, one document-wide highlight registry: the
    // bar left open in the background must not paint over the visible one.
    expect(ownsFind(background)).toBe(false);
    expect(ownsFind(foreground)).toBe(true);
  });

  it("keeps the live search when a background bar closes", () => {
    const root = content("<p>alpha beta</p>");
    const background = {};
    const foreground = {};
    claimFind(background);
    claimFind(foreground);
    revealRange(findRanges(root, "beta", PLAIN)[0]!);

    releaseFind(background, root);

    expect(window.getSelection()?.rangeCount).toBe(1);
    expect(ownsFind(foreground)).toBe(true);
  });

  it("clears everything when the live search closes", () => {
    const root = content("<p>alpha beta</p>");
    const foreground = {};
    claimFind(foreground);
    revealRange(findRanges(root, "beta", PLAIN)[0]!);

    releaseFind(foreground, root);

    expect(window.getSelection()?.rangeCount ?? 0).toBe(0);
    expect(ownsFind(foreground)).toBe(false);
  });
});

describe("painting the matches", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps its rectangles in one overlay it owns, and takes it away again", () => {
    const root = content("<p>alpha beta</p>");
    const ranges = findRanges(root, "beta", PLAIN);

    paintHighlights(ranges, ranges[0] ?? null, root);
    // The conversation's own DOM is React's; find adds one leaf beside it and
    // never wraps a word.
    expect(root.querySelectorAll("[data-osd-find-overlay]")).toHaveLength(1);
    expect(root.querySelector("p")!.innerHTML).toBe("alpha beta");

    clearFind(root);

    // Erasing a search is removing nodes from the document — not asking the
    // engine to stop painting something it was told about.
    expect(root.querySelector("[data-osd-find-overlay]")).toBeNull();
  });

  it("draws one generation at a time", () => {
    const root = content("<p>alpha beta</p>");
    paintHighlights(findRanges(root, "alpha", PLAIN), null, root);
    paintHighlights(findRanges(root, "beta", PLAIN), null, root);

    // The overlay is rebuilt whole, so a previous query's hits cannot be left
    // on screen next to the current one's.
    expect(root.querySelectorAll("[data-osd-find-overlay]")).toHaveLength(1);
  });

  it("is never searched itself", () => {
    const root = content("<p>alpha</p>");
    paintHighlights(findRanges(root, "alpha", PLAIN), null, root);
    const overlay = root.querySelector("[data-osd-find-overlay]")!;

    expect(overlay.getAttribute("data-find-skip")).not.toBeNull();
    expect(overlay.getAttribute("aria-hidden")).toBe("true");
  });
});
