// Open Science AS an ACP agent (#14, server direction), driven by our OWN ACP
// client.
//
// The two halves are wired to each other here: `AcpRuntime` (the client this app
// uses to drive Codex) speaks to `AcpAgentServer` (this app exposed as an agent),
// with a stub `AgentRuntime` underneath standing in for the real one. That makes
// the round trip the test — in particular the delta/accumulate pair, where the
// server must SPLIT our full-value updates into ACP chunks and the client must
// put them back together. A bug in either half shows up as mangled text.
import { describe, expect, it, vi } from "vitest";
import { AcpAgentServer, AcpRuntime, historyNotifications } from "@ai4s/sdk/acp";
import type { JsonRpcTransport, OpenCodeEvent } from "@ai4s/sdk/acp";
import type { AgentRuntime, HistoryMessage, PermissionReply, SessionMeta } from "@ai4s/sdk";

/** Two transports wired to each other, delivering asynchronously like a pipe. */
function pipe(): [JsonRpcTransport, JsonRpcTransport] {
  const listeners: Array<Set<(line: string) => void>> = [new Set(), new Set()];
  const closers: Array<Set<(reason?: string) => void>> = [new Set(), new Set()];
  const make = (self: number, peer: number): JsonRpcTransport => ({
    send(line) {
      queueMicrotask(() => listeners[peer].forEach((l) => l(line.trim())));
    },
    onLine(listener) {
      listeners[self].add(listener);
      return () => listeners[self].delete(listener);
    },
    onClose(listener) {
      closers[self].add(listener);
      return () => closers[self].delete(listener);
    },
    close() {
      closers[peer].forEach((c) => c("closed"));
    },
  });
  return [make(0, 1), make(1, 0)];
}

/** The runtime being exposed: enough of `AgentRuntime` for the server, with the
 *  streaming under the test's control. */
function stubRuntime(history: HistoryMessage[] = []) {
  let emit: (e: OpenCodeEvent) => void = () => {};
  const calls = {
    prompts: [] as Array<{ sessionId: string; text: string }>,
    replies: [] as Array<{ requestId: string; reply: PermissionReply }>,
    aborted: [] as string[],
    deleted: [] as string[],
  };
  const sessions: SessionMeta[] = [
    { id: "ses_1", title: "Trend analysis", directory: "/ws/project", updated: 1_760_000_000_000 },
  ];
  const runtime = {
    onEvent(listener: (e: OpenCodeEvent) => void) {
      emit = listener;
      return () => {
        emit = () => {};
      };
    },
    async createSession() {
      sessions.push({ id: "ses_new", title: "New session", directory: "/ws/project" });
      return "ses_new";
    },
    async listSessions() {
      return sessions;
    },
    async getMessages() {
      return history;
    },
    async deleteSession(id: string) {
      calls.deleted.push(id);
    },
    async sendPrompt(sessionId: string, text: string) {
      calls.prompts.push({ sessionId, text });
    },
    async abortSession(id: string) {
      calls.aborted.push(id);
    },
    async replyPermission(requestId: string, reply: PermissionReply) {
      calls.replies.push({ requestId, reply });
      emit({ type: "permission.resolved", sessionId: "ses_1", requestId });
    },
    async listCommands() {
      return [{ name: "science-review", description: "review the analysis", source: "command" }];
    },
  };
  return { runtime: runtime as unknown as AgentRuntime, calls, fire: (e: OpenCodeEvent) => emit(e) };
}

/** A connected client ↔ server pair over an in-process pipe. */
async function connectedPair(opts?: { history?: HistoryMessage[]; clientCwd?: string }) {
  const [clientSide, serverSide] = pipe();
  const stub = stubRuntime(opts?.history);
  const server = new AcpAgentServer({
    runtime: stub.runtime,
    transport: serverSide,
    workspace: "/ws/project",
    version: "0.3.3",
  });
  const events: OpenCodeEvent[] = [];
  const client = new AcpRuntime({ transport: clientSide, cwd: opts?.clientCwd ?? "/ws/project" });
  client.onEvent((e) => events.push(e));
  await client.connect();
  return { client, server, events, ...stub };
}

describe("Open Science as an ACP agent", () => {
  it("introduces itself and advertises only what it can actually do", async () => {
    const { client } = await connectedPair();
    expect(client.displayName).toBe("Open Science");
    // The runtime really does keep conversations, so these are honest.
    expect(client.supportsSessionReplay).toBe(true);
    expect(client.supportsSessionList).toBe(true);
    expect(client.supportsSessionDelete).toBe(true);
  });

  it("runs a whole turn, and the text survives the delta round trip", async () => {
    const { client, events, fire, calls } = await connectedPair();
    const sessionId = await client.createSession();
    expect(sessionId).toBe("ses_new");

    const turn = client.sendPrompt(sessionId, "Summarize the data");
    await vi.waitFor(() => expect(calls.prompts).toHaveLength(1));
    expect(calls.prompts[0]).toEqual({ sessionId: "ses_new", text: "Summarize the data" });

    // Our runtime emits the FULL current value each time; ACP carries deltas.
    fire({ type: "text.updated", sessionId: "ses_new", partId: "p1", text: "Half " });
    fire({ type: "text.updated", sessionId: "ses_new", partId: "p1", text: "Half an answer." });
    fire({
      type: "tool.updated",
      sessionId: "ses_new",
      callId: "c1",
      tool: "bash",
      status: "success",
      title: "ls",
      input: { command: "ls" },
      output: "a.csv",
    });
    fire({ type: "session.idle", sessionId: "ses_new" });
    await turn;

    // The client re-accumulated exactly what the server split up. Sending the
    // full value as a chunk would have produced "Half Half an answer.".
    const texts = events.filter((e) => e.type === "text.updated") as Array<{ text: string }>;
    expect(texts[texts.length - 1].text).toBe("Half an answer.");
    const tools = events.filter((e) => e.type === "tool.updated") as Array<{
      status: string;
      output?: string;
      title?: string;
    }>;
    expect(tools[tools.length - 1]).toMatchObject({ status: "success", output: "a.csv" });
    expect(events[events.length - 1]).toEqual({ type: "session.idle", sessionId: "ses_new" });
  });

  it("refuses a folder it is not working in, and names the one it is", async () => {
    // The runtime works in ONE folder. An editor opened elsewhere would
    // otherwise get a session whose edits land somewhere it is not showing.
    const { client } = await connectedPair({ clientCwd: "/somewhere/else" });
    await expect(client.createSession()).rejects.toThrow(
      /working in \/ws\/project, not \/somewhere\/else/,
    );
  });

  it("replays a stored conversation to the editor", async () => {
    const history: HistoryMessage[] = [
      { role: "user", id: "m1", parts: [{ type: "text", text: "What changed?" }] },
      {
        role: "assistant",
        id: "m2",
        completed: 1,
        parts: [
          { type: "text", text: "Two files." },
          {
            type: "tool",
            tool: "read",
            state: { status: "completed", title: "read a.csv", output: "42 rows" },
          },
        ],
      },
    ];
    const { client } = await connectedPair({ history });
    const replayed = await client.getMessages("ses_1");

    // Out of our history, through ACP, back into our history: the shapes the
    // thread renders survive the round trip.
    expect(replayed).toMatchObject([
      { role: "user", parts: [{ type: "text", text: "What changed?" }] },
      {
        role: "assistant",
        parts: [
          { type: "text", text: "Two files." },
          { type: "tool", state: { status: "completed", title: "read a.csv", output: "42 rows" } },
        ],
      },
    ]);
    expect(replayed.every((m) => typeof m.completed === "number")).toBe(true);
  });

  it("lists the runtime's sessions with the folder each belongs to", async () => {
    const { client } = await connectedPair();
    expect(await client.listSessions()).toContainEqual({
      id: "ses_1",
      title: "Trend analysis",
      directory: "/ws/project",
      updated: 1_760_000_000_000,
    });
  });

  it("asks the EDITOR for permission and answers the runtime with what it chose", async () => {
    // The point of the server direction: approval happens where the user is
    // working. A permission that could only be answered in the desktop window
    // would hang the editor's turn on a window they may not have open.
    const { client, events, fire, calls } = await connectedPair();
    // The editor is waiting on this turn, which is what makes the approval its
    // to answer.
    const sessionId = await client.createSession();
    void client.sendPrompt(sessionId, "clean the build");
    await vi.waitFor(() => expect(calls.prompts).toHaveLength(1));
    fire({
      type: "permission.asked",
      sessionId,
      requestId: "req-1",
      action: "bash",
      resources: ["rm -rf build"],
    });
    await vi.waitFor(() => expect(events.some((e) => e.type === "permission.asked")).toBe(true));
    const asked = events.find((e) => e.type === "permission.asked") as {
      requestId: string;
      action: string;
      resources: string[];
    };
    expect(asked).toMatchObject({ action: "bash", resources: ["bash rm -rf build"] });

    await client.replyPermission(asked.requestId, "once");
    await vi.waitFor(() => expect(calls.replies).toHaveLength(1));
    expect(calls.replies[0]).toEqual({ requestId: "req-1", reply: "once" });
  });

  it("does not put the desktop's own approvals in front of the editor", async () => {
    // The runtime's event stream is workspace-scoped, so it also carries
    // approvals for work the USER started in the app window. An editor that did
    // not ask for that work must not be asked to approve it — and whichever
    // side answered first would leave the other holding a dead prompt.
    const { events, fire, calls } = await connectedPair();
    fire({
      type: "permission.asked",
      sessionId: "ses_1",
      requestId: "req-desktop",
      action: "bash",
      resources: ["rm -rf build"],
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(events.some((e) => e.type === "permission.asked")).toBe(false);
    // And we never answer on the desktop user's behalf.
    expect(calls.replies).toEqual([]);
  });

  it("says when the editor's own MCP servers are not connected", async () => {
    // Dropping them silently would leave the editor believing tools are
    // available that never arrive; refusing the session would break the
    // integration over something optional. So: create it, and say so where an
    // editor shows agent logs.
    const notices: string[] = [];
    const [clientSide, serverSide] = pipe();
    const stub = stubRuntime();
    new AcpAgentServer({
      runtime: stub.runtime,
      transport: serverSide,
      workspace: "/ws/project",
      onNotice: (m) => notices.push(m),
    });
    const client = new AcpRuntime({ transport: clientSide, cwd: "/ws/project" });
    await client.connect();
    client.setMcpServers([{ name: "filesystem", command: "/bin/mcp", args: [], env: [] }]);
    await client.createSession();

    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/Not connecting 1 MCP server\(s\) sent by the editor \(filesystem\)/);
  });

  it("rejects rather than infers approval when the editor cancels", async () => {
    const { client, events, fire, calls } = await connectedPair();
    const sessionId = await client.createSession();
    void client.sendPrompt(sessionId, "write the file");
    await vi.waitFor(() => expect(calls.prompts).toHaveLength(1));
    fire({
      type: "permission.asked",
      sessionId,
      requestId: "req-2",
      action: "write",
      resources: ["/ws/project/a.py"],
    });
    await vi.waitFor(() => expect(events.some((e) => e.type === "permission.asked")).toBe(true));
    const asked = events.find((e) => e.type === "permission.asked") as { requestId: string };

    // The client cancels (no matching option). Approval must never be inferred.
    await client.replyPermission(asked.requestId, "reject");
    await vi.waitFor(() => expect(calls.replies).toHaveLength(1));
    expect(calls.replies[0].reply).toBe("reject");
  });

  it("ends a cancelled turn as cancelled, and a failed one as an error", async () => {
    const { client, events, fire, calls } = await connectedPair();
    const sessionId = await client.createSession();

    const cancelled = client.sendPrompt(sessionId, "long job");
    await vi.waitFor(() => expect(calls.prompts).toHaveLength(1));
    await client.abortSession(sessionId);
    await vi.waitFor(() => expect(calls.aborted).toEqual([sessionId]));
    fire({ type: "session.idle", sessionId });
    await cancelled;

    // A failed turn answers with an error, not a stop reason: "end_turn" would
    // tell the editor the work finished.
    const failing = client.sendPrompt(sessionId, "again");
    await vi.waitFor(() => expect(calls.prompts).toHaveLength(2));
    fire({ type: "error", sessionId, message: "provider refused" });
    await failing;
    // The client surfaces it as a session error carrying the runtime's own
    // words — which is how our UI shows a failed turn, in either direction.
    const errors = events.filter((e) => e.type === "error") as Array<{ message: string }>;
    expect(errors.some((e) => e.message.includes("provider refused"))).toBe(true);
  });
});

describe("history → ACP notifications", () => {
  it("drops the runtime's own synthetic user marker", () => {
    // The "!" shell echo is the runtime's marker, not something the user wrote;
    // replaying it would put a line in the transcript nobody typed.
    const notes = historyNotifications("s", [
      { role: "user", parts: [{ type: "text", text: "!ls", synthetic: true }] },
      { role: "assistant", parts: [{ type: "text", text: "done" }] },
    ]);
    expect(notes.map((n) => n.update.sessionUpdate)).toEqual(["agent_message_chunk"]);
  });

  it("reports a step frozen mid-run as failed, not as still running", () => {
    // A tool that never reported completion (the runtime restarted) must not
    // spin forever in an editor that has no way to resolve it.
    const notes = historyNotifications("s", [
      { role: "assistant", parts: [{ type: "tool", tool: "bash", state: { status: "running" } }] },
    ]);
    expect(notes[0].update).toMatchObject({ sessionUpdate: "tool_call", status: "failed" });
  });
});
