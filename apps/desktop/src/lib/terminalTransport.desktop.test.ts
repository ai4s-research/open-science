import { describe, expect, it, vi } from "vitest";

// The desktop transport, over Tauri's own Channel: it hands messages over in
// order and moves on only once the handler returns.
const logged = vi.hoisted(() => [] as string[]);
vi.mock("./tauri", () => ({ isTauri: true, logDebug: async (m: string) => void logged.push(m) }));
vi.mock("./webMode", () => ({ isGatewayWeb: false }));
const deliver = vi.hoisted(() => ({ to: null as ((m: unknown) => void) | null }));
vi.mock("@tauri-apps/api/core", async (actual) => {
  const callbacks = new Map<number, (m: unknown) => void>();
  let next = 0;
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {
    transformCallback: (f: (m: unknown) => void) => (callbacks.set(++next, f), next),
    unregisterCallback() {},
  };
  return {
    ...(await actual<typeof import("@tauri-apps/api/core")>()),
    invoke: async (cmd: string, args: { onEvent?: { id: number } }) => {
      if (cmd === "terminal_subscribe" && args.onEvent) deliver.to = callbacks.get(args.onEvent.id)!;
    },
  };
});

const { terminalTransport } = await import("./terminalTransport");

describe("desktop terminal output", () => {
  it("keeps coming after the handler throws once, and the error is logged", async () => {
    const seen: string[] = [];
    let thrown = false;
    await terminalTransport.subscribe("p1", {
      onData: (chunk) => {
        if (chunk === "b" && !thrown) {
          thrown = true;
          throw new Error("xterm threw");
        }
        seen.push(chunk);
      },
      onControl() {},
      onReset() {},
      onExit() {},
    });
    // Each message reaches the page in a call of its own.
    ["a", "b", "c", "d"].forEach((data, index) => {
      try {
        deliver.to!({ index, message: { kind: "data", data } });
      } catch {
        // uncaught in the app
      }
    });
    expect(seen).toEqual(["a", "c", "d"]);
    expect(logged.join("\n")).toContain("[terminal p1] output handler threw: Error: xterm threw");
  });
});
