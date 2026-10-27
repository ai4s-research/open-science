import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tauri", () => ({ isTauri: false }));
const who = vi.hoisted(() => ({ account: "dana" as string | null, source: "desktop" as "desktop" | "own" }));
vi.mock("./webMode", () => ({
  isGatewayWeb: true,
  gatewayOrigin: () => "http://gw",
  gatewayToken: () => "tok",
  gatewayPost: vi.fn(async () => ({ created: true })),
  signedInAccount: () => who.account,
  layoutSource: () => who.source,
}));

const { terminalTransport } = await import("./terminalTransport");
const { gatewayPost } = await import("./webMode");

/** A gateway's `/v1/mux`: each tab stream it opens is a body the test writes
 *  frames into; `onAdd` answers a subscription with frames of its own. */
function fakeMux(onAdd: (key: string, stream: number, send: (frame: object | null) => void) => void) {
  const enc = new TextEncoder();
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/mux")) {
      const n = streams.length;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            streams.push(c);
            c.enqueue(enc.encode(`data: {"mux":"m${n}"}\n\n`));
          },
        }),
      );
    }
    const n = Number(url.match(/\/v1\/mux\/m(\d+)$/)?.[1]);
    const { add } = JSON.parse(String(init?.body)) as { add?: { key: string }[] };
    for (const { key } of add ?? []) {
      onAdd(key, n, (frame) => (frame ? streams[n].enqueue(enc.encode(`data: ${JSON.stringify(frame)}\n\n`)) : streams[n].close()));
    }
    return new Response("{}");
  });
  /** End every tab stream, as the gateway going away would. */
  const closeAll = () =>
    streams.forEach((c) => {
      try {
        c.close();
      } catch {
        /* that one had already ended */
      }
    });
  return Object.assign(fetchMock, { closeAll });
}

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  window.localStorage.setItem("os_terminal_client", "abcdefabcdef");
  who.account = "dana";
  who.source = "desktop";
});

describe("the web transport", () => {
  it("with the token, uses the pane id itself — the same shell as the desktop window's — and never ends it", async () => {
    who.account = null;
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await terminalTransport.open("p3", undefined, 80, 24)).toEqual({ created: true });
    expect(gatewayPost).toHaveBeenLastCalledWith("/v1/terminals/p3", { cwd: null, cols: 80, rows: 24 });
    await terminalTransport.close("p3");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("with the token on its own Screens, opens shells of its own, and a later switch does not re-route them", async () => {
    who.account = null;
    who.source = "own";
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await terminalTransport.open("p8", undefined, 80, 24);
    expect(gatewayPost).toHaveBeenLastCalledWith("/v1/terminals/wabcdefabcdef-p8", { cwd: null, cols: 80, rows: 24 });
    who.source = "desktop"; // switched back to the window's Screens
    await terminalTransport.close("p8");
    expect(fetchMock).toHaveBeenCalledWith("http://gw/v1/terminals/wabcdefabcdef-p8", {
      method: "DELETE",
      headers: { Authorization: "Bearer tok" },
    });
  });

  it("with an account, names its shells per browser, so pane ids from other clients never collide", async () => {
    window.localStorage.removeItem("os_terminal_client");
    await terminalTransport.write("p3", "x");
    const id = window.localStorage.getItem("os_terminal_client")!;
    expect(id).toMatch(/^[a-z0-9]{12}$/);
    expect(gatewayPost).toHaveBeenLastCalledWith(`/v1/terminals/w${id}-p3/input`, { data: "x" });
  });

  it("talks to /v1/terminals with the bearer token, never a token in the URL", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await terminalTransport.open("leaf-1", "/work", 80, 24);
    await terminalTransport.write("leaf-1", "ls\n");
    await terminalTransport.close("leaf-1");
    expect(gatewayPost).toHaveBeenCalledWith("/v1/terminals/wabcdefabcdef-leaf-1", { cwd: "/work", cols: 80, rows: 24 });
    expect(gatewayPost).toHaveBeenCalledWith("/v1/terminals/wabcdefabcdef-leaf-1/input", { data: "ls\n" });
    expect(fetchMock).toHaveBeenCalledWith("http://gw/v1/terminals/wabcdefabcdef-leaf-1", {
      method: "DELETE",
      headers: { Authorization: "Bearer tok" },
    });
  });

  it("re-reads a dropped stream, clearing the screen before the replay", async () => {
    const fetchMock = fakeMux((k, stream, send) => {
        send({ k, open: true });
        if (stream === 0) {
          send({ k, d: "first" });
          send(null); // the tab's stream drops, the shell lives on
        } else {
          send({ k, d: "replayed" });
          send({ k, exit: true });
        }
      });
    vi.stubGlobal("fetch", fetchMock);
    const events: string[] = [];
    await terminalTransport.subscribe("leaf-1", {
      onData: (c) => events.push(c),
      onReset: () => events.push("<reset>"),
      onExit: () => events.push("<exit>"),
    });
    await vi.waitFor(() => expect(events).toEqual(["first", "<reset>", "replayed", "<exit>"]), { timeout: 3000 });
    fetchMock.closeAll(); // the next test starts with no tab stream
  });

  it("ends, rather than retrying forever, when the terminal is gone", async () => {
    const fetchMock = fakeMux((k, _stream, send) => send({ k, gone: true }));
    vi.stubGlobal("fetch", fetchMock);
    const onExit = vi.fn();
    await terminalTransport.subscribe("leaf-2", { onData() {}, onReset() {}, onExit });
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledOnce());
    // It asked over the tab's one stream, for this pane's shell.
    const adds = fetchMock.mock.calls.filter(([url]) => /\/v1\/mux\/m\d+$/.test(String(url)));
    expect(JSON.parse(String(adds[0][1]?.body))).toEqual({
      add: [{ key: expect.any(String), kind: "terminal", id: "wabcdefabcdef-leaf-2" }],
    });
  });
});
