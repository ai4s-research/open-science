import { describe, expect, it } from "vitest";
import { applyLinePrefix, applyLinePrefixToBlock, wrapSelection } from "./markdownEdits";

describe("the markdown toolbar's line markers", () => {
  it("adds a marker to a plain line", () => {
    expect(applyLinePrefix("Notes", "# ")).toBe("# Notes");
    expect(applyLinePrefix("Notes", "- ")).toBe("- Notes");
  });

  it("replaces the marker a line already has", () => {
    // A heading becomes a quote, not a quoted heading.
    expect(applyLinePrefix("## Notes", "> ")).toBe("> Notes");
    expect(applyLinePrefix("- Notes", "1. ")).toBe("1. Notes");
    expect(applyLinePrefix("- [ ] Notes", "- ")).toBe("- Notes");
  });

  it("takes the marker off again when it is already that one", () => {
    expect(applyLinePrefix("# Notes", "# ")).toBe("Notes");
    expect(applyLinePrefix("> Notes", "> ")).toBe("Notes");
  });

  it("keeps a nested item nested", () => {
    expect(applyLinePrefix("    - deep", "1. ")).toBe("    1. deep");
  });

  it("clears every marker when asked for a plain paragraph", () => {
    expect(applyLinePrefix("### Notes", "")).toBe("Notes");
    expect(applyLinePrefix("- [x] done", "")).toBe("done");
  });

  it("numbers an ordered list down the selection", () => {
    expect(applyLinePrefixToBlock("one\ntwo\nthree", "1. ")).toBe("1. one\n2. two\n3. three");
  });

  it("finishes a half-formatted selection rather than undoing it", () => {
    // Only the first line is a bullet; the button should make them all bullets.
    expect(applyLinePrefixToBlock("- one\ntwo", "- ")).toBe("- one\n- two");
  });

  it("removes the marker only when the whole selection carries it", () => {
    expect(applyLinePrefixToBlock("- one\n- two", "- ")).toBe("one\ntwo");
  });
});

describe("the markdown toolbar's character styles", () => {
  it("wraps a selection and keeps it selected", () => {
    const r = wrapSelection("bold me", "**", "**");
    expect(r.text).toBe("**bold me**");
    expect(r.text.slice(r.from, r.to)).toBe("bold me");
  });

  it("puts the caret between the markers when nothing is selected", () => {
    const r = wrapSelection("", "**", "**");
    expect(r.text).toBe("****");
    expect(r.from).toBe(2);
    expect(r.to).toBe(2);
  });

  it("unwraps text that already carries the markers", () => {
    const r = wrapSelection("**bold me**", "**", "**");
    expect(r.text).toBe("bold me");
    expect(r.text.slice(r.from, r.to)).toBe("bold me");
  });

  it("builds a link with the text selected and a placeholder target", () => {
    const r = wrapSelection("Orca", "[", "](url)");
    expect(r.text).toBe("[Orca](url)");
    expect(r.text.slice(r.from, r.to)).toBe("Orca");
  });
});
