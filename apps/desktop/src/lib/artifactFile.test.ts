// Every agent message that names a file resolves it on MOUNT, and switching to
// a pane mounts the whole transcript at once. Each miss is a directory walk over
// the workspace, so an uncached call per mention is what made a big workspace
// freeze the UI on every switch (#92).
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("./tauri", () => ({ isTauri: true }));
vi.mock("./webMode", () => ({
  isGatewayWeb: false,
  gatewayToken: () => null,
  gatewayOrigin: () => "",
}));

const { resolveArtifactPath, clearResolvedPaths } = await import("./artifactFile");

describe("resolveArtifactPath caching", () => {
  beforeEach(() => {
    invoke.mockReset();
    clearResolvedPaths();
  });

  it("asks the backend once for a path, however many messages mention it", async () => {
    invoke.mockResolvedValue("figures/loss.png");
    const answers = await Promise.all(
      Array.from({ length: 25 }, () => resolveArtifactPath("loss.png")),
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(new Set(answers)).toEqual(new Set(["figures/loss.png"]));
  });

  it("remembers a miss too — that is the answer that costs a full walk", async () => {
    invoke.mockResolvedValue(null);
    expect(await resolveArtifactPath("nope.png")).toBeNull();
    expect(await resolveArtifactPath("nope.png")).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("does not remember a failure as an answer", async () => {
    invoke.mockRejectedValueOnce(new Error("backend down"));
    await expect(resolveArtifactPath("x.png")).rejects.toThrow("backend down");

    invoke.mockResolvedValue("x.png");
    expect(await resolveArtifactPath("x.png")).toBe("x.png");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("forgets everything when the workspace changes", async () => {
    invoke.mockResolvedValue("a/x.png");
    await resolveArtifactPath("x.png");
    clearResolvedPaths();
    invoke.mockResolvedValue("b/x.png");
    expect(await resolveArtifactPath("x.png")).toBe("b/x.png");
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
