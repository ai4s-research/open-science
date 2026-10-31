// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { OpenCodeClient, toHistory, type EventStreamOpener, type OpenCodeEvent } from "@ai4s/sdk";

/** An event stream someone else carries (the web client's tab stream): each
 *  open is recorded with its handlers, so the test drives it. */
function carried() {
  const opens: { directory: string | null; h: Parameters<EventStreamOpener>[1]; stop: ReturnType<typeof vi.fn> }[] = [];
  const opener: EventStreamOpener = (directory, h) => {
    const stop = vi.fn();
    opens.push({ directory, h, stop });
    return stop;
  };
  return { opener, opens };
}

/** A connected client fed by hand; `send` delivers one OpenCode 2 event. */
async function fed(opts: { directory?: string; fetchImpl?: typeof fetch } = {}) {
  const { opener, opens } = carried();
  const client = new OpenCodeClient({ baseUrl: "http://gw", eventStream: opener, ...opts });
  const events: OpenCodeEvent[] = [];
  client.onEvent((e) => events.push(e));
  const ready = client.connect();
  opens[0].h.onOpen();
  await ready;
  const send = (type: string, data: Record<string, unknown>, directory?: string) =>
    opens[0].h.onMessage(JSON.stringify({ id: "evt", type, ...(directory ? { location: { directory } } : {}), data }));
  return { client, events, send, opens };
}

describe("OpenCodeClient with a carried event stream", () => {
  it("is ready on open, reads events, and reopens after the stream ends", async () => {
    const { client, events, send, opens } = await fed({ directory: "/work" });
    expect(opens[0].directory).toBe("/work");
    send("session.execution.succeeded", { sessionID: "ses_1" }, undefined);
    // No location: the session's folder is not known yet, so this waits on a
    // lookup — answered below by the fallback (deliver, never drop).
    await vi.waitFor(() => expect(events.some((e) => e.type === "session.idle")).toBe(true));

    opens[0].h.onError();
    expect(opens[0].stop).toHaveBeenCalled();
    await vi.waitFor(() => expect(opens).toHaveLength(2));
    client.close();
    expect(opens[1].stop).toHaveBeenCalled();
  });

  it("fails the connect when the stream cannot open", async () => {
    const { opener, opens } = carried();
    const client = new OpenCodeClient({ baseUrl: "http://gw", eventStream: opener });
    const ready = client.connect();
    opens[0].h.onError();
    await expect(ready).rejects.toThrow(/Could not open/);
    expect(opens[0].stop).toHaveBeenCalled();
  });

  it("surfaces a user message's words and id, so a message sent from elsewhere can be shown and edited", async () => {
    const { client, events, send } = await fed();
    send("session.inbox.enqueued", {
      sessionID: "ses_1",
      inboxID: "msg_u",
      item: { type: "user", payload: { text: "Ask from agent B" }, delivery: "steer" },
    });
    // A synthetic item is bookkeeping, not words.
    send("session.inbox.enqueued", { sessionID: "ses_1", inboxID: "msg_s", item: { type: "synthetic", payload: { text: "x" } } });
    expect(events).toEqual([
      { type: "message.agent", sessionId: "ses_1", messageID: "msg_u" },
      { type: "user.message", sessionId: "ses_1", messageID: "msg_u", text: "Ask from agent B" },
    ]);
    client.close();
  });

  it("keeps to its own folder's sessions on the global stream", async () => {
    const lookups: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      lookups.push(path);
      const dir = path.endsWith("ses_mine") ? "/work" : "/elsewhere";
      return new Response(JSON.stringify({ data: { id: "x", location: { directory: dir } } }), { status: 200 });
    };
    const { client, events, send } = await fed({ directory: "/work/", fetchImpl });
    // Located events decide on their own (a trailing slash is the same folder).
    send("session.text.ended", { sessionID: "ses_a", assistantMessageID: "m", ordinal: 0, text: "mine" }, "/work");
    send("session.text.ended", { sessionID: "ses_b", assistantMessageID: "m", ordinal: 0, text: "theirs" }, "/elsewhere");
    // Unlocated events go by what is known of their session…
    send("session.execution.succeeded", { sessionID: "ses_a" });
    send("session.execution.succeeded", { sessionID: "ses_b" });
    // …and an unknown session is looked up ONCE, its events held in order.
    send("session.step.started", { sessionID: "ses_mine", assistantMessageID: "m1" });
    send("session.execution.succeeded", { sessionID: "ses_mine" });
    send("session.execution.succeeded", { sessionID: "ses_other" });
    await vi.waitFor(() => expect(lookups).toHaveLength(2));
    await vi.waitFor(() => expect(events.filter((e) => e.type === "session.idle")).toHaveLength(2));
    expect(events.filter((e) => e.type === "text.updated").map((e) => (e as { text: string }).text)).toEqual(["mine"]);
    expect(events.filter((e) => e.type === "session.idle").map((e) => (e as { sessionId: string }).sessionId)).toEqual([
      "ses_a",
      "ses_mine",
    ]);
    // Held events kept their order: the step before the turn's end.
    const mine = events.filter((e) => "sessionId" in e && e.sessionId === "ses_mine").map((e) => e.type);
    expect(mine).toEqual(["step.updated", "session.idle"]);
    expect(lookups).toEqual(["/api/session/ses_mine", "/api/session/ses_other"]);
    client.close();
  });

  it("translates tool calls into the app's names and fields", async () => {
    const { client, events, send } = await fed();
    const tool = (type: string, data: Record<string, unknown>) =>
      send(type, { sessionID: "s", assistantMessageID: "m", ...data });
    tool("session.tool.input.started", { id: "t1", name: "write" });
    tool("session.tool.called", { id: "t1", input: { path: "out/report.md", content: "# hi" }, executed: false });
    tool("session.tool.success", {
      id: "t1",
      content: [{ type: "text", text: "Wrote out/report.md" }],
      metadata: { files: [{ file: "out/report.md", patch: "@@ +# hi", additions: 1, deletions: 0, status: "added" }] },
      executed: false,
    });
    tool("session.tool.input.started", { id: "t2", name: "subagent" });
    tool("session.tool.called", { id: "t2", input: { agent: "explore", description: "map", prompt: "go" } });
    tool("session.tool.progress", { id: "t2", metadata: { sessionID: "ses_child", status: "running" } });
    tool("session.tool.failed", { id: "t2", error: { type: "x", message: "child failed" } });

    const write = events.filter((e): e is Extract<OpenCodeEvent, { type: "tool.updated" }> => e.type === "tool.updated" && e.callId === "t1");
    expect(write.map((e) => e.status)).toEqual(["pending", "running", "success"]);
    expect(write[2]).toMatchObject({
      tool: "write",
      input: { path: "out/report.md", filePath: "out/report.md", content: "# hi" },
      output: "Wrote out/report.md",
      diff: "@@ +# hi",
    });
    const task = events.filter((e): e is Extract<OpenCodeEvent, { type: "tool.updated" }> => e.type === "tool.updated" && e.callId === "t2");
    expect(task.slice(-1)[0]).toMatchObject({
      tool: "task",
      status: "failed",
      output: "child failed",
      childSessionId: "ses_child",
      input: { agent: "explore", subagent_type: "explore" },
    });
    client.close();
  });

  it("relays a permission ask and answers it under its session", async () => {
    const replies: Array<{ path: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      replies.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response("{}", { status: 200 });
    };
    const { client, events, send } = await fed({ fetchImpl });
    send("permission.asked", { id: "per_1", sessionID: "ses_1", action: "shell", resources: ["rm -rf x"] });
    expect(events.slice(-1)[0]).toEqual({ type: "permission.asked", sessionId: "ses_1", requestId: "per_1", action: "bash", resources: ["rm -rf x"] });
    await client.replyPermission("per_1", "always");
    expect(replies).toEqual([{ path: "/api/session/ses_1/permission/per_1/reply", body: { decision: "always" } }]);
    send("permission.replied", { sessionID: "ses_1", requestID: "per_1", reply: "always" });
    expect(events.slice(-1)[0]).toEqual({ type: "permission.resolved", sessionId: "ses_1", requestId: "per_1" });
    client.close();
  });

  it("relays a question form as the app's question cards and answers with values", async () => {
    const replies: Array<{ path: string; method?: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      replies.push({ path: new URL(String(input)).pathname, method: init?.method, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response("{}", { status: 200 });
    };
    const { client, events, send } = await fed({ fetchImpl });
    send("form.created", {
      form: {
        id: "frm_1",
        sessionID: "ses_1",
        title: "Choices",
        fields: [
          { key: "colour", type: "string", title: "Pick a colour", options: [{ value: "r", label: "Red" }, { value: "b", label: "Blue" }] },
          { key: "tags", type: "multiselect", title: "Tags", options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }] },
          { key: "ok", type: "boolean", title: "Proceed?" },
          { key: "note", type: "string", title: "Anything else?" },
        ],
      },
    });
    const asked = events.slice(-1)[0] as Extract<OpenCodeEvent, { type: "question.asked" }>;
    expect(asked.sessionId).toBe("ses_1");
    expect(asked.questions.map((q) => [q.question, q.options.map((o) => o.label), q.multiple, q.custom])).toEqual([
      ["Pick a colour", ["Red", "Blue"], false, false],
      ["Tags", ["X", "Y"], true, false],
      ["Proceed?", ["Yes", "No"], false, false],
      ["Anything else?", [], false, true],
    ]);
    await client.answerQuestion("frm_1", [["Blue"], ["X", "Y"], ["Yes"], ["typed words"]]);
    expect(replies.slice(-1)[0]).toEqual({
      path: "/api/session/ses_1/form/frm_1/reply",
      method: "POST",
      body: { answer: { colour: "b", tags: ["x", "y"], ok: true, note: "typed words" } },
    });
    await client.rejectQuestion("frm_1");
    expect(replies.slice(-1)[0]).toMatchObject({ path: "/api/session/ses_1/form/frm_1", method: "DELETE" });
    send("form.replied", { id: "frm_1", sessionID: "ses_1", answer: {} });
    expect(events.slice(-1)[0]).toEqual({ type: "question.resolved", sessionId: "ses_1", requestId: "frm_1" });
    client.close();
  });

  it("finds an unseen request's session from the open requests before answering", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname === "/api/permission/request")
        return new Response(JSON.stringify({ data: [{ id: "per_9", sessionID: "ses_9", action: "edit", resources: [] }] }), { status: 200 });
      return new Response("{}", { status: 200 });
    };
    const client = new OpenCodeClient({ baseUrl: "http://gw", fetchImpl });
    await client.replyPermission("per_9", "once");
    expect(calls).toEqual(["GET /api/permission/request", "POST /api/session/ses_9/permission/per_9/reply"]);
    await expect(client.replyPermission("per_gone", "once")).rejects.toMatchObject({ status: 404 });
  });

  it("reads reasoning and an interrupted turn", async () => {
    const { client, events, send } = await fed();
    send("session.reasoning.started", { sessionID: "s", assistantMessageID: "m", ordinal: 0 });
    send("session.reasoning.delta", { sessionID: "s", assistantMessageID: "m", ordinal: 0, delta: "Think" });
    send("session.reasoning.delta", { sessionID: "s", assistantMessageID: "m", ordinal: 0, delta: "ing" });
    send("session.execution.interrupted", { sessionID: "s", reason: "user" });
    expect(events.filter((e) => e.type === "reasoning.updated").map((e) => (e as { text: string }).text)).toEqual([
      "",
      "Think",
      "Thinking",
    ]);
    expect(events.slice(-1)[0]).toEqual({ type: "session.idle", sessionId: "s" });
    expect(events.some((e) => e.type === "error")).toBe(false);
    client.close();
  });
});

describe("toHistory (OpenCode 2 messages → the app's history)", () => {
  it("leaves the last step open while no idle record has closed the turn", () => {
    const running = toHistory([
      { id: "u", type: "user", time: { created: 1 }, text: "go" },
      { id: "a1", type: "assistant", agent: "plan", time: { created: 2, completed: 3 }, content: [] },
    ]);
    expect(running.slice(-1)[0]?.completed).toBeUndefined();
    // The user message took the agent the turn ran under.
    expect(running[0].agent).toBe("plan");
    const done = toHistory([
      { id: "u", type: "user", time: { created: 1 }, text: "go" },
      { id: "a1", type: "assistant", agent: "build", time: { created: 2, completed: 3 }, content: [] },
      { id: "i", type: "idle", time: { created: 4 } },
    ]);
    expect(done.slice(-1)[0]?.completed).toBe(3);
  });

  it("reads a user shell run as the synthetic marker and bash result the thread expects", () => {
    const h = toHistory([
      { id: "sh", type: "shell", time: { created: 1, completed: 2 }, command: "ls", status: "exited", shellID: "sh_1", output: { output: "a\nb\n" } },
    ]);
    expect(h).toEqual([
      { role: "user", id: "sh:user", created: 1, parts: [{ type: "text", text: "", synthetic: true }] },
      {
        role: "assistant",
        id: "sh",
        created: 1,
        completed: 2,
        parts: [
          {
            type: "tool",
            tool: "bash",
            callID: "sh_1",
            state: { status: "completed", input: { command: "ls" }, output: "a\nb\n", time: { start: 1, end: 2 } },
          },
        ],
      },
    ]);
  });

  it("reads the app's background review back as the assistant's text, a goal's kickoff as the command typed, and hides the rest", () => {
    const h = toHistory([
      { id: "r", type: "synthetic", time: { created: 5 }, text: "```review```", metadata: { ai4s: { source: "background-review" } } },
      { id: "o", type: "synthetic", time: { created: 6 }, text: "note" },
      { id: "g", type: "synthetic", time: { created: 7 }, text: "kickoff…", description: "Goal: ship it", metadata: { source: "goal", goalID: "x" } },
      { id: "c", type: "synthetic", time: { created: 8 }, text: "continue…", metadata: { source: "goal", goalID: "x" } },
      { id: "a", type: "assistant", agent: "build", time: { created: 9, completed: 10 }, content: [{ type: "text", text: "working" }] },
    ]);
    expect(h.map((m) => [m.role, m.parts[0]])).toEqual([
      ["assistant", { type: "text", text: "```review```", synthetic: true }],
      ["user", { type: "text", text: "/goal ship it" }],
      ["assistant", { type: "text", text: "working" }],
    ]);
    // The continuation started a turn no idle record has closed.
    expect(h[2].completed).toBeUndefined();
  });

  it("maps a failed tool and a step error", () => {
    const h = toHistory([
      {
        id: "a",
        type: "assistant",
        time: { created: 1, completed: 2 },
        error: { type: "api", message: "quota\nstack" },
        content: [
          { type: "tool", id: "t", name: "shell", state: { status: "error", input: { command: "x" }, error: { type: "x", message: "boom" } }, time: { created: 1 } },
          { type: "tool", id: "s", name: "edit", state: { status: "streaming", input: "{" }, time: { created: 1 } },
        ],
      },
    ]);
    expect(h[0].error).toBe("quota");
    expect(h[0].parts[0]).toMatchObject({ tool: "bash", state: { status: "error", error: "boom", input: { command: "x" } } });
    expect(h[0].parts[1]).toMatchObject({ tool: "edit", state: { status: "pending" } });
  });
});
