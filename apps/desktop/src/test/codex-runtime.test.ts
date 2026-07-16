// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { CodexRuntime, type OpenCodeEvent } from "@ai4s/sdk";

/**
 * A mock codex app-server for protocol-translation tests. Speaks the JSON-RPC
 * methods CodexRuntime expects (initialize, thread/start, thread/send,
 * thread/cancel, approveCommand) and, crucially, emits the NOTIFICATIONS that
 * exercise CodexRuntime's event translation: thread/message, thread/command,
 * thread/commandApprovalRequest, thread/completed.
 *
 * It is our best-effort reconstruction of the codex wire shape — the same shape
 * CodexRuntime targets — so if codex's real fields differ, BOTH this mock and
 * CodexRuntime would change together.
 */
const MOCK_CODEX = `
const delays = (ms) => new Promise((r) => setTimeout(r, ms));
let buf = "";
let nextId = 0;
const pendingTurns = new Map(); // request id -> thread_id (turns awaiting completion)
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim()) await handle(JSON.parse(line));
  }
});
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
function notify(method, params) { send({ jsonrpc: "2.0", method, params }); }

async function handle(msg) {
  if (msg.id !== undefined) {
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
    } else if (msg.method === "thread/start") {
      const tid = "thread-" + (++nextId);
      send({ jsonrpc: "2.0", id: msg.id, result: { id: tid } });
    } else if (msg.method === "thread/send") {
      const tid = msg.params.thread_id;
      // Hold the turn response until the turn "completes" via notifications.
      // Emit streamed text, a tool call, then complete.
      notify("thread/message", { thread_id: tid, delta: "Hello " });
      notify("thread/message", { thread_id: tid, delta: "world." });
      notify("thread/command", { thread_id: tid, id: "cmd-1", command: "ls", state: "running" });
      notify("thread/command", { thread_id: tid, id: "cmd-1", command: "ls", state: "done", output: "file.txt" });
      notify("thread/completed", { thread_id: tid });
      send({ jsonrpc: "2.0", id: msg.id, result: { done: true } });
    } else if (msg.method === "thread/cancel") {
      send({ jsonrpc: "2.0", id: msg.id, result: { cancelled: true } });
    } else if (msg.method === "approveCommand") {
      send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
    } else {
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  }
}
process.stdout.write("READY\\n");
`;

/** A second mock that injects a command-approval request mid-turn. */
const MOCK_CODEX_APPROVAL = `
let buf = "";
let nextId = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim()) await handle(JSON.parse(line));
  }
});
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
function notify(method, params) { send({ jsonrpc: "2.0", method, params }); }
async function handle(msg) {
  if (msg.id !== undefined) {
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
    } else if (msg.method === "thread/start") {
      const tid = "thread-" + (++nextId);
      send({ jsonrpc: "2.0", id: msg.id, result: { id: tid } });
    } else if (msg.method === "thread/send") {
      const tid = msg.params.thread_id;
      // The agent wants to run rm; codex pauses and asks the client to approve.
      notify("thread/commandApprovalRequest", { thread_id: tid, id: "appr-1", command: "rm -rf /tmp/x" });
      // Turn response withheld until approveCommand arrives — but to keep the
      // test bounded we complete immediately after requesting approval.
      notify("thread/completed", { thread_id: tid });
      send({ jsonrpc: "2.0", id: msg.id, result: { done: true } });
    } else {
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  }
}
process.stdout.write("READY\\n");
`;

let rt: CodexRuntime;

afterAll(async () => {
  rt?.close();
});

describe("CodexRuntime — protocol translation", () => {
  it("connect, createSession, and stream a turn into normalized events", async () => {
    const events: OpenCodeEvent[] = [];
    rt = new CodexRuntime({ command: ["node", "-e", MOCK_CODEX] });
    rt.onEvent((e) => events.push(e));
    await rt.connect();
    expect(rt.getStatus()).toBe("ready");

    const sid = await rt.createSession();
    expect(sid).toBe("thread-1");

    // sendPrompt awaits turn completion; notifications stream in first.
    await rt.sendPrompt(sid, "hi");

    // Text deltas accumulate into text.updated events (full value each time).
    const texts = events.filter((e) => e.type === "text.updated");
    expect(texts.length).toBe(2);
    expect((texts[0] as { text: string }).text).toBe("Hello ");
    expect((texts[1] as { text: string }).text).toBe("Hello world.");

    // A tool call surfaces as tool.updated (running then success).
    const tools = events.filter((e) => e.type === "tool.updated");
    expect(tools.length).toBe(2);
    expect((tools[0] as { status: string }).status).toBe("running");
    expect((tools[1] as { status: string }).status).toBe("success");

    // The turn ends with session.idle (composer unlocks).
    const idle = events.find((e) => e.type === "session.idle");
    expect(idle).toBeTruthy();
    expect((idle as { sessionId: string }).sessionId).toBe(sid);
  });

  it("maps a command-approval request to permission.asked", async () => {
    const events: OpenCodeEvent[] = [];
    const approvalRt = new CodexRuntime({ command: ["node", "-e", MOCK_CODEX_APPROVAL] });
    approvalRt.onEvent((e) => events.push(e));
    await approvalRt.connect();
    const sid = await approvalRt.createSession();
    await approvalRt.sendPrompt(sid, "clean up");

    const asked = events.find((e) => e.type === "permission.asked") as
      | { action: string; resources: string[] }
      | undefined;
    expect(asked).toBeTruthy();
    expect(asked!.action).toBe("bash");
    expect(asked!.resources).toEqual(["rm -rf /tmp/x"]);

    // listPermissions surfaces it too (recovery path).
    const pending = await approvalRt.listPermissions();
    expect(pending.length).toBe(1);
    expect(pending[0].resources).toEqual(["rm -rf /tmp/x"]);

    // Replying clears it without throwing.
    await approvalRt.replyPermission("appr-1", "reject");
    approvalRt.close();
  });

  it("status transitions through connecting → ready → offline", async () => {
    const statuses: string[] = [];
    const s = new CodexRuntime({ command: ["node", "-e", MOCK_CODEX] });
    const unsub = s.onStatus((st) => statuses.push(st));
    expect(s.getStatus()).toBe("offline");
    await s.connect();
    expect(s.getStatus()).toBe("ready");
    s.close();
    expect(s.getStatus()).toBe("offline");
    // connecting then ready fired on connect; offline on close.
    expect(statuses).toContain("connecting");
    expect(statuses).toContain("ready");
    expect(statuses).toContain("offline");
    unsub();
  });
});
