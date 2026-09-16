import { beforeEach, describe, expect, it } from "vitest";
import { findRanges, MAX_MATCHES } from "./findInPage";

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
