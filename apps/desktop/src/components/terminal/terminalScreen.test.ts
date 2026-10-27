import { describe, expect, it } from "vitest";
import { openEscape } from "./terminalScreen";

describe("openEscape", () => {
  it("is empty between sequences", () => {
    for (const text of ["", "plain", "\x1b[1;31mred", "\x1b[38;2;1;2;3m", "\x1b]0;title\x07", "\x1b]8;;\x1b\\", "\x1b(B", "\x1b7"]) {
      expect(openEscape(text)).toBe("");
    }
  });

  it("returns a sequence the text cuts off", () => {
    for (const text of ["a\x1b", "a\x1b[38;2;171;43", "\x1b]0;tit", "\x1bP$q m", "\x1b("]) {
      expect(openEscape(text)).not.toBe("");
    }
    // Finished by what follows in the next chunk.
    expect(openEscape(openEscape("a\x1b[38;2;171;43") + ";63mb")).toBe("");
  });
});
