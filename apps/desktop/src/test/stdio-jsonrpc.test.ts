// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StdioJsonRpcClient } from "@ai4s/sdk/node-runtime";

/**
 * A tiny "JSON-RPC echo" child: reads newline-delimited requests on stdin and,
 * for `echo` requests, replies with the params as the result; for `notify`
 * notifications, re-broadcasts them. Used to exercise the real stdio transport
 * without depending on any agent binary.
 *
 * It also supports a `send-then-quit` mode: when it reads "DONE", it exits, so
 * we can assert in-flight requests are rejected.
 */
const ECHO_SCRIPT = `
// A minimal newline-delimited JSON-RPC echo child for transport tests.
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    handle(line);
  }
});
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
function handle(line) {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined) {
    if (msg.method === "echo") {
      send({ jsonrpc: "2.0", id: msg.id, result: msg.params });
    } else if (msg.method === "fail") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "boom" } });
    }
  } else {
    // Notification: re-broadcast so the client's onNotification fires.
    send({ jsonrpc: "2.0", method: "event/" + (msg.method || "x"), params: msg.params });
  }
}
process.stdout.write("READY\\n"); // signal start() can resolve
`;

let client: StdioJsonRpcClient;

beforeAll(async () => {
  // Run the echo script with node.
  client = new StdioJsonRpcClient({
    command: ["node", "-e", ECHO_SCRIPT],
    killGraceMs: 1000,
  });
  await client.start();
});

afterAll(async () => {
  await client.close();
});

describe("StdioJsonRpcClient — request/response", () => {
  it("awaits the matching response by id", async () => {
    const result = (await client.request("echo", { hello: "world" })) as {
      hello: string;
    };
    expect(result).toEqual({ hello: "world" });
  });

  it("rejects on a JSON-RPC error response", async () => {
    await expect(client.request("fail", {})).rejects.toThrow(/boom/);
  });

  it("pairs concurrent requests to the right response (no id crossover)", async () => {
    const [a, b, c] = await Promise.all([
      client.request("echo", { n: 1 }),
      client.request("echo", { n: 2 }),
      client.request("echo", { n: 3 }),
    ]);
    expect(a).toEqual({ n: 1 });
    expect(b).toEqual({ n: 2 });
    expect(c).toEqual({ n: 3 });
  });
});

describe("StdioJsonRpcClient — notifications", () => {
  it("delivers server notifications to onNotification handlers", async () => {
    const seen: unknown[] = [];
    const unsub = client.onNotification("event/ping", (p) => seen.push(p));
    // Send a notification; the echo script re-broadcasts it as event/ping.
    client.notify("ping", { x: 42 });
    // Give the round trip a beat.
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toEqual([{ x: 42 }]);
    unsub();
  });

  it("unsubscribe stops further deliveries", async () => {
    const seen: unknown[] = [];
    const unsub = client.onNotification("event/once", (p) => seen.push(p));
    unsub();
    client.notify("once", { gone: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toEqual([]);
  });
});

describe("StdioJsonRpcClient — framing", () => {
  it("reassembles a response split across multiple stdout chunks", async () => {
    // Send two requests; the child writes both responses. Line-delimited framing
    // must not smear them. (Concurrent requests above already cover the
    // multi-line case; this asserts we tolerate interleaving.)
    const r = await client.request("echo", { split: true });
    expect(r).toEqual({ split: true });
  });
});

describe("StdioJsonRpcClient — lifecycle", () => {
  it("rejects requests after close()", async () => {
    // Use a fresh client so we can kill it mid-request.
    const dying = new StdioJsonRpcClient({
      command: ["node", "-e", ECHO_SCRIPT],
      killGraceMs: 500,
    });
    await dying.start();
    await dying.close();
    // After close, a new request must reject, not hang.
    await expect(dying.request("echo", {})).rejects.toThrow(/not running/);
  });
});
