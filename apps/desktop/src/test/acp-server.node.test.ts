// @vitest-environment node
// The ACP agent process, end to end (#14, server direction).
//
// Everything real except the runtime behind it: a stand-in gateway speaks the
// HTTP+SSE the `OpenCodeClient` expects, `serveStdio` connects to it exactly as
// the shipped `acp-server.mjs` does, and our own `AcpRuntime` drives the result
// over a pipe — the same sequence an editor performs when it spawns the agent.
//
// The point is the seams a unit test cannot see: the gateway handshake, the SSE
// stream that turns server events into ACP notifications, and the line framing
// on real node streams.
import { createServer, type Server } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { AcpRuntime } from "@ai4s/sdk/acp";
import { serveStdio, streamTransport } from "@ai4s/sdk/acp/serve-stdio";
import type { OpenCodeEvent } from "@ai4s/sdk/acp";

/** A stand-in for the desktop's gateway: the handful of routes the client uses,
 *  plus a live event stream the test writes into. */
function fakeGateway() {
  let push: (event: unknown) => void = () => {};
  const prompts: Array<{ sessionId: string; body: string }> = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/v1/whoami") return json({ directory: "/ws/project", mode: "full" });
    if (path === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      // The client treats the first bytes as the handshake.
      res.write(": connected\n\n");
      push = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      return;
    }
    if (path === "/session" && req.method === "POST") return json({ id: "ses_gw" });
    if (path === "/experimental/session")
      return json([{ id: "ses_gw", title: "From the editor", directory: "/ws/project" }]);
    if (path.endsWith("/prompt_async") && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      return req.on("end", () => {
        prompts.push({ sessionId: path.split("/")[2] ?? "", body });
        json({});
      });
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  return { server, prompts, event: (e: unknown) => push(e) };
}

let running: Server | undefined;
afterEach(() => {
  running?.close();
  running = undefined;
});

describe("the ACP agent process an editor spawns", () => {
  it("connects to the gateway and answers a turn over real streams", async () => {
    const gateway = fakeGateway();
    running = gateway.server;
    const port = await new Promise<number>((resolve) => {
      gateway.server.listen(0, "127.0.0.1", () => {
        const address = gateway.server.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });

    // Two pipes standing in for the child's stdin/stdout.
    const toAgent = new PassThrough();
    const fromAgent = new PassThrough();
    const server = await serveStdio({
      url: `http://127.0.0.1:${port}`,
      token: "test-token",
      version: "0.3.3",
      stdin: toAgent,
      stdout: fromAgent,
    });

    const events: OpenCodeEvent[] = [];
    const client = new AcpRuntime({
      transport: streamTransport(fromAgent, toAgent),
      cwd: "/ws/project",
    });
    client.onEvent((e) => events.push(e));
    await client.connect();
    expect(client.displayName).toBe("Open Science");

    const sessionId = await client.createSession();
    expect(sessionId).toBe("ses_gw");

    const turn = client.sendPrompt(sessionId, "Summarize the data");
    // The prompt really reached the gateway, as a prompt the runtime understands.
    await vi_waitFor(() => gateway.prompts.length > 0);
    expect(JSON.parse(gateway.prompts[0].body)).toMatchObject({
      parts: [{ type: "text", text: "Summarize the data" }],
    });

    // Server-sent events → ACP notifications → the client's own event stream.
    gateway.event({
      type: "message.part.updated",
      properties: {
        part: { id: "p1", type: "text", text: "Half ", sessionID: sessionId, messageID: "m1" },
      },
    });
    gateway.event({
      type: "message.part.updated",
      properties: {
        part: {
          id: "p1",
          type: "text",
          text: "Half an answer.",
          sessionID: sessionId,
          messageID: "m1",
        },
      },
    });
    gateway.event({ type: "session.idle", properties: { sessionID: sessionId } });
    await turn;

    const texts = events.filter((e) => e.type === "text.updated") as Array<{ text: string }>;
    expect(texts[texts.length - 1]?.text).toBe("Half an answer.");
    expect(await client.listSessions()).toContainEqual(
      expect.objectContaining({ id: "ses_gw", title: "From the editor" }),
    );

    client.close();
    server.close();
  }, 30_000);
});

/** Poll until a condition holds — the events cross a socket, so nothing here is
 *  synchronous. */
async function vi_waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}
