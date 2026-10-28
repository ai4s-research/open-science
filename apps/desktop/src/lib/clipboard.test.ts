import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

describe("copyText in a browser", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("copies through a hidden field on plain http, where navigator.clipboard is missing", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    let selected = "";
    document.execCommand = vi.fn(() => {
      const field = document.querySelector("textarea")!;
      selected = field.value.slice(field.selectionStart, field.selectionEnd);
      return true;
    });
    await copyText("[OSD session] a · ses_a · /w/a");
    expect(selected).toBe("[OSD session] a · ses_a · /w/a");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("throws when the copy is refused, so the caller can say so", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    document.execCommand = vi.fn(() => false);
    await expect(copyText("x")).rejects.toThrow();
  });
});
