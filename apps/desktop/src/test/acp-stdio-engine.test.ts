// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

// Mock child_process so we don't actually spawn anything in unit tests.
// The mock must quack like a real ChildProcess enough for the engine's
// `readline.createInterface({ input: child.stdout })` call — Node's readline
// calls `input.resume()` (and `setEncoding`/`isPaused`) at construction time,
// so the mock stdout needs those no-op methods or connect() throws before it
// ever writes the initialize frame.
const mockChild = {
  stdin: { write: vi.fn(), end: vi.fn() },
  stdout: { on: vi.fn(), emit: vi.fn(), resume: vi.fn(), setEncoding: vi.fn(), isPaused: vi.fn(() => false) },
  stderr: { on: vi.fn(), resume: vi.fn() },
  on: vi.fn(),
  killed: false,
  kill: vi.fn(),
  pid: 12345,
};
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => mockChild),
}));

import { AcpStdioEngine } from "@ai4s/sdk";

describe("AcpStdioEngine", () => {
  it("spawns the command and sends initialize on connect()", async () => {
    const engine = new AcpStdioEngine({
      kind: "acp-stdio",
      command: "kimi",
      args: ["acp"],
    });
    // We can't fully drive the handshake in a unit test without simulating
    // stdout frames; just assert spawn + first stdin write. The connect
    // promise is intentionally NOT awaited — the handshake never completes
    // because the mocked stdout never emits an initialize response.
    const connectP = engine.connect();
    // Swallow the eventual rejection (no stdout mock → request times out /
    // rejects when the child is killed) so it doesn't surface as an unhandled
    // rejection in the test runner.
    void connectP.catch(() => {});
    // Allow microtasks to flush.
    await new Promise((r) => setTimeout(r, 10));
    const { spawn } = await import("node:child_process");
    expect(spawn).toHaveBeenCalledWith("kimi", ["acp"], expect.anything());
    expect(mockChild.stdin.write).toHaveBeenCalled();
    const firstWrite = mockChild.stdin.write.mock.calls[0][0].toString();
    expect(firstWrite).toContain('"method":"initialize"');
    // Don't await connectP — handshake won't complete without stdout mock.
    engine.close();
  });
});

describe("AcpStdioEngine event normalization", () => {
  it("session/update with TextDelta → text.updated", () => {
    const engine = new AcpStdioEngine({ kind: "acp-stdio", command: "x", args: [] });
    const events: any[] = [];
    engine.onEvent((e) => events.push(e));
    // Access protected method via any-cast for testing.
    (engine as any).handleNotification("session/update", {
      sessionId: "s1",
      update: { type: "agent", message: { parts: [{ type: "text", text: "hi" }] } },
    });
    expect(events.some((e) => e.type === "text.updated")).toBe(true);
  });

  it("session/update end_of_turn → session.idle", () => {
    const engine = new AcpStdioEngine({ kind: "acp-stdio", command: "x", args: [] });
    const events: any[] = [];
    engine.onEvent((e) => events.push(e));
    (engine as any).handleNotification("session/update", {
      sessionId: "s1",
      update: { type: "agent", stop: { reason: "end_turn" } },
    });
    expect(events.some((e) => e.type === "session.idle")).toBe(true);
  });
});
