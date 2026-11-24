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

const { terminalTransport, inOrder } = await import("./terminalTransport");

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

describe("one terminal's requests", () => {
  // A fake transport whose writes take as long as their text says.
  const timed = (log: string[]) => {
    const later = (ms: number, what: string, fail = false) =>
      new Promise<void>((resolve, reject) =>
        setTimeout(() => {
          log.push(what);
          if (fail) reject(new Error(what));
          else resolve();
        }, ms),
      );
    return inOrder({
      ...terminalTransport,
      write: (id, data) => later(Number(data.split(":")[1]), `${id} ${data}`, data.startsWith("fail")),
      resize: (id, cols) => later(0, `${id} resize ${cols}`),
    });
  };

  it("go in the order made, however long each takes", async () => {
    const log: string[] = [];
    const t = timed(log);
    await Promise.all([t.write("p1", "paste:30"), t.write("p1", "key:0"), t.resize("p1", 80, 24)]);
    expect(log).toEqual(["p1 paste:30", "p1 key:0", "p1 resize 80"]);
  });

  it("do not wait for another terminal's", async () => {
    const log: string[] = [];
    const t = timed(log);
    await Promise.all([t.write("p1", "paste:30"), t.write("p2", "key:0")]);
    expect(log).toEqual(["p2 key:0", "p1 paste:30"]);
  });

  it("go on after one fails, which its caller still sees", async () => {
    const log: string[] = [];
    const t = timed(log);
    const failed = t.write("p1", "fail:10");
    const next = t.write("p1", "key:0");
    await expect(failed).rejects.toThrow("fail:10");
    await next;
    expect(log).toEqual(["p1 fail:10", "p1 key:0"]);
  });
});
