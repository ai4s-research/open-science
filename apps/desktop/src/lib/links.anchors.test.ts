import { describe, expect, it, vi } from "vitest";
import type { ThreadBlock } from "@ai4s/shared";
import { anchorPaths, resolveLink, threadAnchors } from "./links";

// The desktop: paths outside the workspace are looked up by the shell.
const invoke = vi.hoisted(() =>
  vi.fn(async (_cmd: string, args: { path: string; anchors: string[] }) =>
    args.path === "packages/core/src/agent.ts" && args.anchors.includes("/Users/me/repo/README.md")
      ? { root: "home", rel: "repo/packages/core/src/agent.ts", is_dir: false }
      : args.path === "Penguin AI Adventure.png" && args.anchors.includes("/Users/me/Downloads/Penguin")
        ? { root: "home", rel: "Downloads/Penguin AI Adventure.png", is_dir: false }
      : args.path === "/private/tmp/shot.png"
        ? { root: "disk", rel: args.path, is_dir: false }
        : null,
  ),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./tauri", async (orig) => ({ ...(await orig<object>()), isTauri: true, workspaceBase: async () => "/Users/me/OS" }));
vi.mock("./artifactFile", async (orig) => ({ ...(await orig<object>()), listDir: async () => [], resolveArtifactPath: async () => null }));

describe("anchorPaths", () => {
  it("finds absolute paths, most recent first, and leaves URLs, options and routes alone", () => {
    expect(anchorPaths("cd /Users/me/repo && sed -n 1,9p src/a.ts; cat ~/notes/x.md:12")).toEqual([
      "~/notes/x.md",
      "/Users/me/repo",
    ]);
    expect(anchorPaths("see https://x.org/a/b and /v1 or a/b/c")).toEqual([]);
  });

  it("reads a conversation from its last block back", () => {
    const blocks = [
      { kind: "user", text: "源码在 /Users/me/repo，先读它" },
      { kind: "tool-call", title: "Read", status: "done", filePath: "/Users/me/other/b.md" },
      { kind: "agent", markdown: "done" },
    ] as ThreadBlock[];
    expect(threadAnchors(blocks)).toEqual(["/Users/me/other/b.md", "/Users/me/repo"]);
  });
});

describe("a relative path in an answer, against the anchors", () => {
  it("is found in the repo the conversation touched", async () => {
    const anchors = ["/Users/me/repo/README.md"];
    expect(await resolveLink("packages/core/src/agent.ts", { folders: "/Users/me/OS/p", anchors })).toEqual({
      kind: "path", path: "repo/packages/core/src/agent.ts", root: "home", isDir: false, display: "packages/core/src/agent.ts",
    });
  });

  it("opens a full path outside home where it is on disk", async () => {
    expect(await resolveLink("/private/tmp/shot.png", { cwd: "/Users/me" })).toEqual({
      kind: "path", path: "/private/tmp/shot.png", root: "disk", isDir: false, display: "/private/tmp/shot.png",
    });
  });

  it("is found when the writer broke it over lines, and prose is never glued", async () => {
    const anchors = ["/Users/me/repo/README.md"];
    expect(await resolveLink("packages/core/ src/agent.ts", { anchors })).toMatchObject({ path: "repo/packages/core/src/agent.ts" });
    invoke.mockClear();
    expect(await resolveLink("run this, then packages/core/src/agent.ts", { anchors })).toBeNull();
    expect(invoke.mock.calls.map((c) => c[1].path)).not.toContain("packages/core/src/agent.ts");
  });

  it("finds a bare name with spaces next to the file the conversation read", async () => {
    // The anchor stops at the first space; the shell searches from what of it exists.
    const blocks = [
      { kind: "tool-call", title: "Read", status: "success", filePath: "/Users/me/Downloads/Penguin AI Adventure.png" },
    ] as ThreadBlock[];
    expect(await resolveLink("Penguin AI Adventure.png", { anchors: threadAnchors(blocks) })).toMatchObject({
      path: "Downloads/Penguin AI Adventure.png",
    });
  });

  it("without anchors, the shell is not asked about a relative path", async () => {
    invoke.mockClear();
    expect(await resolveLink("packages/core/src/agent.ts", { folders: "/Users/me/OS/p" })).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});
