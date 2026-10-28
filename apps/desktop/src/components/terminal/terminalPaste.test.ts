import { describe, expect, it } from "vitest";
import { pathsToPaste, quotePath } from "./terminalPaste";

describe("quotePath", () => {
  it("leaves a plain path as is", () => {
    expect(quotePath("/Users/a/data/report-1.pdf", false)).toBe("/Users/a/data/report-1.pdf");
  });

  it("quotes spaces and non-ASCII names for a POSIX shell", () => {
    expect(quotePath("/Users/a/Juejun Hu 简报.pdf", false)).toBe("'/Users/a/Juejun Hu 简报.pdf'");
  });

  it("escapes a single quote inside a POSIX path", () => {
    expect(quotePath("/tmp/it's.txt", false)).toBe("'/tmp/it'\\''s.txt'");
  });

  it("double-quotes a Windows path with a space", () => {
    expect(quotePath("C:\\Users\\a\\My Docs\\x.pdf", true)).toBe('"C:\\Users\\a\\My Docs\\x.pdf"');
    expect(quotePath("C:\\x.pdf", true)).toBe("C:\\x.pdf");
  });
});

describe("pathsToPaste", () => {
  it("joins several files, each followed by a space", () => {
    expect(pathsToPaste(["/a.pdf", "/b c.pdf"], false)).toBe("/a.pdf '/b c.pdf' ");
  });

  it("is empty when no files were copied", () => {
    expect(pathsToPaste([], false)).toBe("");
  });
});
