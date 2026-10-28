import { beforeAll, describe, expect, it, vi } from "vitest";

// The desktop shell finds what exists (see locate_local in osd-core).
const invoke = vi.hoisted(() =>
  vi.fn(async (_cmd: string, args: { path: string; cwd?: string }) =>
    args.path === String.raw`D:\data\shot.png`
      ? { root: "disk", rel: "D:/data/shot.png", is_dir: false }
      : args.path === String.raw`src\main.rs` && args.cwd === String.raw`C:\Users\me\repo`
        ? { root: "home", rel: "repo/src/main.rs", is_dir: false }
        : null,
  ),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./tauri", async (orig) => ({ ...(await orig<object>()), isTauri: true }));
vi.mock("./artifactFile", async (orig) => ({ ...(await orig<object>()), resolveArtifactPath: async () => null }));

// The link finder as it runs on Windows: the platform is read once, at import.
vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
const links = await import("./links");
const terminal = await import("@/components/terminal/terminalLinks");

const texts = (line: string) => links.linkCandidates(line).map((s) => s.text);

/** Rows as the terminal holds them, one cell per character. */
const rows = (lines: string[]) => (y: number) => {
  const text = lines[y - 1];
  return text === undefined ? null : { text, cells: [...text].map((_, x) => ({ x, width: 1, style: "" })), wrapped: false };
};

describe("links on Windows", () => {
  beforeAll(() => expect(links.IS_WINDOWS).toBe(true));

  it("finds full paths on a drive, with either slash, never a drive inside a word", () => {
    expect(texts(String.raw`saved C:\Users\me\out\fig.png and D:/data/run.log`)).toEqual([
      String.raw`C:\Users\me\out\fig.png`,
      "D:/data/run.log",
    ]);
    expect(texts(String.raw`ab:\x`)).toEqual([String.raw`\x`]);
  });

  it("finds relative paths written with backslashes", () => {
    expect(texts(String.raw`error in src\app\main.ts:12 and .\out\a.png or ..\b.md`)).toEqual([
      String.raw`src\app\main.ts`,
      String.raw`.\out\a.png`,
      String.raw`..\b.md`,
    ]);
  });

  it("takes full paths on a drive as anchors", () => {
    expect(links.anchorPaths(String.raw`cd C:\Users\me\repo && type D:/data/x.md and \x`)).toEqual([
      "D:/data/x.md",
      String.raw`C:\Users\me\repo`,
    ]);
  });

  it("opens a full path on any drive, and a relative one in the terminal's folder", async () => {
    expect(await links.resolveLink(String.raw`D:\data\shot.png`, { cwd: null })).toEqual({
      kind: "path", path: "D:/data/shot.png", root: "disk", isDir: false, display: String.raw`D:\data\shot.png`,
    });
    expect(await links.resolveLink(String.raw`src\main.rs`, { cwd: String.raw`C:\Users\me\repo` })).toEqual({
      kind: "path", path: "repo/src/main.rs", root: "home", isDir: false, display: String.raw`src\main.rs`,
    });
  });

  it("puts back a path a TUI broke after a backslash", () => {
    const line = terminal.logicalLine(rows(["  ⎿  D:\\data\\workspace\\commander-entry\\", "     before-fix.png"]), 2, 40);
    expect(terminal.lineCandidates(line).map((s) => s.text)).toContain(
      String.raw`D:\data\workspace\commander-entry\before-fix.png`,
    );
  });
});
