// #157: the navigator's preview cache is keyed by BLOCK IDENTITY — a fold
// rebuilds only the block it changed, so historical turns must reuse their
// cached preview while a new block object computes fresh.
import { describe, expect, it } from "vitest";
import { cachedPreview } from "./TurnNavigator";
import type { ThreadBlock } from "@ai4s/shared";

const user = (text: string): ThreadBlock => ({ kind: "user", text }) as ThreadBlock;

describe("cachedPreview (#157)", () => {
  it("strips markdown for a real block (default compute)", () => {
    const b = user("# Title\nsome **bold** text");
    expect(cachedPreview(b, b.kind === "user" ? b.text : "")).toBe("Title some bold text");
  });

  it("computes once per block object, then serves the cache", () => {
    const b = user("words");
    let calls = 0;
    const compute = (t: string) => {
      calls++;
      return t.toUpperCase();
    };
    expect(cachedPreview(b, "words", compute)).toBe("WORDS");
    expect(cachedPreview(b, "words", compute)).toBe("WORDS");
    expect(calls).toBe(1); // the whole point of the cache
  });

  it("treats an empty-string preview as a cache HIT, not a miss", () => {
    // A block whose text strips down to "" must not recompute forever — an
    // `if (hit)` truthiness check would silently defeat the cache here.
    const b = user("");
    let calls = 0;
    const compute = () => {
      calls++;
      return "";
    };
    expect(cachedPreview(b, "", compute)).toBe("");
    expect(cachedPreview(b, "", compute)).toBe("");
    expect(calls).toBe(1);
  });

  it("a new block object computes fresh — identity, not content, is the key", () => {
    let calls = 0;
    const compute = (t: string) => {
      calls++;
      return t;
    };
    const a = user("same words");
    const b = user("same words");
    cachedPreview(a, "same words", compute);
    cachedPreview(b, "same words", compute);
    expect(calls).toBe(2); // different objects: no bleed, no stale reuse
  });
});
