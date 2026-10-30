import { describe, expect, it } from "vitest";
import { activateLink, cleanPath, linkCandidates, looksLikePath, useLinkMenu, type LinkTarget } from "./links";

const texts = (line: string) => linkCandidates(line).map((s) => `${s.kind}:${s.text}`);

describe("linkCandidates", () => {
  it("finds URLs and path-looking tokens, a URL winning over the paths inside it", () => {
    expect(texts("see https://github.com/a/b.git and /Users/me/repo/src/main.rs")).toEqual([
      "url:https://github.com/a/b.git",
      "path:/Users/me/repo/src/main.rs",
    ]);
  });

  it("reads a backslash as part of a name off Windows (see links.windows.test)", () => {
    expect(texts(String.raw`saved src\main.rs and a/b\c.txt`)).toEqual(["path:main.rs", "path:a/b", "path:c.txt"]);
  });

  it("trims positions and sentence punctuation, and stops at CJK punctuation", () => {
    expect(texts("error at src/app.ts:12:3.")).toEqual(["path:src/app.ts"]);
    expect(texts("打开 ~/notes/今天.md，然后看 https://x.org/p。")).toEqual([
      "path:~/notes/今天.md",
      "url:https://x.org/p",
    ]);
  });

  it("leaves ordinary words and numbers alone", () => {
    expect(texts("npm run build took 3.14 seconds")).toEqual([]);
    expect(looksLikePath("README.md")).toBe(true);
    expect(looksLikePath("Awesome Prompts_ Penguin AI Adventure.png")).toBe(true);
    expect(looksLikePath("a sentence. Then")).toBe(false);
    expect(looksLikePath("1.2.3")).toBe(false);
    expect(cleanPath("a/b.py:40")).toBe("a/b.py");
    expect(cleanPath("a/b.ts:163-182")).toBe("a/b.ts");
    expect(cleanPath("a/b.ts:12:3.")).toBe("a/b.ts");
    expect(cleanPath("a/b.md#L5-L9")).toBe("a/b.md");
  });
});

describe("activateLink", () => {
  const file: LinkTarget = { kind: "path", path: "repo/a.md", root: "home", isDir: false, display: "a.md" };
  const at = { clientX: 10, clientY: 20, metaKey: false, ctrlKey: false, shiftKey: false };

  it("a plain click opens the menu at the pointer", () => {
    activateLink(file, at);
    expect(useLinkMenu.getState().open).toEqual({ target: file, x: 10, y: 20 });
    useLinkMenu.getState().hide();
  });

  it("a modified click acts at once, without the menu", () => {
    activateLink(file, { ...at, metaKey: true, shiftKey: true });
    expect(useLinkMenu.getState().open).toBeNull();
  });
});
