// @vitest-environment node
// Our ACP agent, driven by the OFFICIAL client library (#14, server direction).
//
// Everything else about the server direction is verified against our own client,
// which shares this repo's reading of the protocol — so a shared misreading
// would pass. Here the peer is `@agentclientprotocol/sdk`, the reference
// implementation editors are built on: it validates every message against the
// published schema, so a shape we invented fails at the boundary instead of in
// somebody's editor.
//
// It spawns the SHIPPED artifact (`runtime/acp-server/acp-server.mjs`, the file
// that goes into the app bundle) as a real child process, against a stand-in
// gateway. Skipped when that file has not been built — `pnpm --filter
// @ai4s/desktop build` produces it.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { Readable, Writable } from "node:stream";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const SCRIPT = resolve(__dirname, "../../../../runtime/acp-server/acp-server.mjs");
const built = existsSync(SCRIPT);

/** The gateway routes the agent's `OpenCodeClient` uses, plus a live stream. */
function fakeGateway() {
  let push: (event: unknown) => void = () => {};
  const prompts: string[] = [];
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/v1/whoami") return json({ directory: "/ws/project", mode: "full" });
    if (path === "/api/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "evt_0", type: "server.connected", data: {} })}\n\n`);
      push = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      return;
    }
    const session = { id: "ses_interop", title: "From the editor", location: { directory: "/ws/project" }, time: { created: 1, updated: 1 } };
    if (path === "/api/session" && req.method === "POST") return json({ data: session });
    if (path === "/api/session") return json({ data: [session], cursor: { next: null } });
    if (path === "/api/session/ses_interop") return json({ data: session });
    if (path.endsWith("/message"))
      return json({
        data: [
          { id: "m1", type: "user", time: { created: 1 }, text: "What changed?" },
          { id: "m2", type: "assistant", time: { created: 2, completed: 3 }, content: [{ type: "text", text: "Two files." }] },
        ],
        cursor: { next: null },
      });
    if (path.endsWith("/prompt") && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      return req.on("end", () => {
        prompts.push(body);
        json({ data: { id: "msg_u", sessionID: "ses_interop", type: "user" } });
      });
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  return { server, prompts, event: (e: unknown) => push(e) };
}

let child: ChildProcessWithoutNullStreams | undefined;
let running: Server | undefined;
afterEach(() => {
  child?.kill();
  child = undefined;
  running?.close();
  running = undefined;
});

describe.skipIf(!built)("the shipped agent, against the official ACP client library", () => {
  it("completes a real editor's workflow: initialize → new → prompt → list → load", async () => {
    const gateway = fakeGateway();
    running = gateway.server;
    const port = await new Promise<number>((r) => {
      gateway.server.listen(0, "127.0.0.1", () => {
        const a = gateway.server.address();
        r(typeof a === "object" && a ? a.port : 0);
      });
    });

    child = spawn("node", [SCRIPT, "--url", `http://127.0.0.1:${port}`], {
      env: { ...process.env, OPENSCIENCE_GATEWAY_TOKEN: "interop-token" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderr: string[] = [];
    child.stderr.on("data", (c: Buffer) => stderr.push(c.toString()));

    const updates: Array<Record<string, unknown>> = [];
    const connection = new ClientSideConnection(
      () => ({
        async sessionUpdate(params: { update: Record<string, unknown> }) {
          updates.push(params.update);
        },
        async requestPermission() {
          return { outcome: { outcome: "cancelled" as const } };
        },
        async writeTextFile() {
          throw new Error("not supported");
        },
        async readTextFile() {
          throw new Error("not supported");
        },
      }),
      // The official library speaks WEB streams; a spawned child gives node
      // ones. Same bytes either way — this is the adapter, not a translation.
      ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      ),
    );

    // Every response below is decoded by the official schema: a field we
    // invented, or a required one we omitted, fails right here.
    const init = await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    expect(init.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(init.agentInfo?.title).toBe("Open Science");
    expect(init.agentCapabilities?.loadSession).toBe(true);

    const created = await connection.newSession({
      cwd: "/ws/project",
      mcpServers: [{ name: "editor-side", command: "/bin/mcp", args: [], env: [] }],
    });
    expect(created.sessionId).toBe("ses_interop");
    // The one thing we cannot honour is SAID, on the channel an editor logs.
    await waitFor(() => stderr.join("").includes("Not connecting 1 MCP server"));

    const turn = connection.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "Summarize the data" }],
    });
    await waitFor(() => gateway.prompts.length > 0);
    // OpenCode 2's stream: text deltas keyed by step and ordinal, then the
    // execution's end.
    // `session.execution.*` carries no location, as on the real server.
    const ev = (type: string, data: Record<string, unknown>) =>
      gateway.event({
        id: `evt_${type}`,
        type,
        ...(type.startsWith("session.execution.") ? {} : { location: { directory: "/ws/project" } }),
        data: { sessionID: "ses_interop", ...data },
      });
    ev("session.execution.started", {});
    ev("session.step.started", { agent: "build", assistantMessageID: "m9", started: 1 });
    ev("session.text.started", { assistantMessageID: "m9", ordinal: 0 });
    ev("session.text.delta", { assistantMessageID: "m9", ordinal: 0, delta: "Rising " });
    ev("session.text.delta", { assistantMessageID: "m9", ordinal: 0, delta: "since May." });
    ev("session.text.ended", { assistantMessageID: "m9", ordinal: 0, text: "Rising since May." });
    ev("session.step.ended", { assistantMessageID: "m9", finish: "stop" });
    ev("session.execution.succeeded", {});
    expect((await turn).stopReason).toBe("end_turn");

    // Deltas, as the official library decoded them: concatenating is what an
    // editor does, and it must produce the answer exactly once.
    const chunks = updates.filter((u) => u.sessionUpdate === "agent_message_chunk");
    const text = chunks
      .map((u) => (u.content as { text?: string } | undefined)?.text ?? "")
      .join("");
    expect(text).toBe("Rising since May.");

    const listed = await connection.listSessions({});
    expect(listed.sessions.map((s) => s.sessionId)).toContain("ses_interop");
    expect(listed.sessions[0].cwd).toBe("/ws/project");

    updates.length = 0;
    await connection.loadSession({ sessionId: "ses_interop", cwd: "/ws/project", mcpServers: [] });
    // A replay the editor can render: the user's message, then ours.
    expect(updates.map((u) => u.sessionUpdate)).toEqual([
      "user_message_chunk",
      "agent_message_chunk",
    ]);
  }, 60_000);
});

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}
