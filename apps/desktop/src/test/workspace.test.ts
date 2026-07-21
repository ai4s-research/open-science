import { describe, expect, it } from "vitest";
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
