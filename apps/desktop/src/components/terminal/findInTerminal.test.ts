import { describe, expect, it, vi } from "vitest";
import { QUERY_MAX_BYTES, queryIsUsable, safeFind, SEARCH_DECORATIONS } from "./findInTerminal";

describe("finding in a terminal", () => {
  it("survives the decoration failure that would otherwise kill the pane", () => {
    // xterm builds a highlight whose width is `cols - matchCol`, and when the
    // viewport is narrower than the column a match starts at, that width goes
    // negative and it throws — synchronously, inside findNext. Thrown from a
    // React handler it takes the whole terminal surface down.
    const find = vi.fn(() => {
      throw new Error("This API only accepts positive integers");
    });

    expect(safeFind(find, "needle")).toBe(false);
  });

  it("lets every other failure through", () => {
    // Swallowing more than the one known bug would hide real breakage.
    const find = vi.fn(() => {
      throw new Error("terminal disposed");
    });

    expect(() => safeFind(find, "needle")).toThrow("terminal disposed");
  });

  it("returns what the search found when nothing goes wrong", () => {
    expect(safeFind(() => true, "needle")).toBe(true);
  });

  it("refuses a query that is a paste accident, not a search", () => {
    expect(queryIsUsable("needle")).toBe(true);
    expect(queryIsUsable("x".repeat(QUERY_MAX_BYTES + 1))).toBe(false);
  });

  it("measures the query in BYTES, not characters", () => {
    // A CJK query is three bytes per character; a character limit would let a
    // query three times the intended size through.
    expect(queryIsUsable("中".repeat(QUERY_MAX_BYTES / 3 + 1))).toBe(false);
  });

  it("spells the highlight colours out, because xterm's defaults vanish", () => {
    // Not the app's CSS variables: xterm requires #RRGGBB, and a `var(...)`
    // would silently render nothing at all.
    for (const colour of Object.values(SEARCH_DECORATIONS)) {
      expect(colour).toMatch(/^#[0-9a-f]{6}$/i);
    }
    // The current match has to stand out from the rest.
    expect(SEARCH_DECORATIONS.activeMatchBackground).not.toBe(SEARCH_DECORATIONS.matchBackground);
  });
});
