import { describe, expect, it, vi } from "vitest";
import { OpenCodeClient } from "@ai4s/sdk";
import type { WorkspaceOps } from "@ai4s/sdk";
import type { DirEntry } from "@ai4s/shared";

describe("WorkspaceOps interface contract", () => {
  it("is satisfied by an object with the four methods", () => {
    const ops: WorkspaceOps = {
      async listDir(_rel: string): Promise<DirEntry[]> { return []; },
      async readFile(_rel: string) { return { text: "" }; },
      async writeFile(_path: string, _content: string): Promise<void> {},
      async deleteFile(_path: string): Promise<void> {},
    };
    expect(typeof ops.listDir).toBe("function");
    expect(typeof ops.readFile).toBe("function");
    expect(typeof ops.writeFile).toBe("function");
    expect(typeof ops.deleteFile).toBe("function");
  });
});

describe("OpenCodeClient WorkspaceOps forwarding", () => {
  it("listDir forwards to invoke('list_dir', { rel, root: 'workspace' })", async () => {
    const invoke = vi.fn().mockResolvedValue([
      { path: "foo.txt", name: "foo.txt", is_dir: false, size: 10, modified: 0 },
    ]);
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));

    const c = new OpenCodeClient({ baseUrl: "http://x" });
    const out = await c.listDir("");
    expect(invoke).toHaveBeenCalledWith("list_dir", { rel: "", root: "workspace" });
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("foo.txt");
    vi.doUnmock("@tauri-apps/api/core");
  });

  it("readFile returns { text } when encoding === 'utf8'", async () => {
    const invoke = vi.fn().mockResolvedValue({
      path: "a.txt", mime: "text/plain", encoding: "utf8", data: "hello", size: 5,
    });
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));

    const c = new OpenCodeClient({ baseUrl: "http://x" });
    const out = await c.readFile("a.txt");
    expect(invoke).toHaveBeenCalledWith("read_artifact", { path: "a.txt", root: "workspace" });
    expect(out).toEqual({ text: "hello" });
    vi.doUnmock("@tauri-apps/api/core");
  });

  it("readFile returns { artifact } when encoding === 'base64'", async () => {
    const invoke = vi.fn().mockResolvedValue({
      path: "a.png", mime: "image/png", encoding: "base64", data: "AAAA", size: 3,
    });
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));

    const c = new OpenCodeClient({ baseUrl: "http://x" });
    const out = await c.readFile("a.png");
    expect(out).toEqual({ artifact: { path: "a.png", mime: "image/png", encoding: "base64", data: "AAAA", size: 3 } });
    vi.doUnmock("@tauri-apps/api/core");
  });
});

describe("OpenCodeClient WorkspaceOps write/delete", () => {
  it("writeFile forwards to invoke('write_workspace_file', { path, content, root: 'workspace' })", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));

    const c = new OpenCodeClient({ baseUrl: "http://x" });
    await c.writeFile("notes.txt", "hi");
    expect(invoke).toHaveBeenCalledWith("write_workspace_file", { path: "notes.txt", content: "hi", root: "workspace" });
    vi.doUnmock("@tauri-apps/api/core");
  });

  it("deleteFile forwards to invoke('delete_workspace_file', { path, root: 'workspace' })", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));

    const c = new OpenCodeClient({ baseUrl: "http://x" });
    await c.deleteFile("notes.txt");
    expect(invoke).toHaveBeenCalledWith("delete_workspace_file", { path: "notes.txt", root: "workspace" });
    vi.doUnmock("@tauri-apps/api/core");
  });
});
