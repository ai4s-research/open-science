// A minimal OpenCode 2 server for tests and local dev. Node-only.
// Implements the `/api/*` endpoints the app uses and streams turns as the real
// server does. Every event shape here is copied from a recorded OpenCode 2.2.5
// stream; the comments say where the real server differs in ways tests skip.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface MockOpenCode {
  port: number;
  /** Every request seen, as "METHOD /path?query" — lets tests assert call order. */
  requests: string[];
  /** Parsed prompt bodies, in order — lets tests assert the wire shape. */
  promptBodies: unknown[];
  /** Every JSON body sent with a request, keyed "METHOD /path". */
  bodies: Array<{ request: string; body: unknown }>;
  close: () => Promise<void>;
}

type Json = Record<string, unknown>;

export function startMockOpenCode(port = 0): Promise<MockOpenCode> {
  const clients = new Set<ServerResponse>();
  const requests: string[] = [];
  const promptBodies: unknown[] = [];
  const bodies: Array<{ request: string; body: unknown }> = [];
  const sessions = new Map<string, Json>();
  const messages: Record<string, Json[]> = {};
  let seq = 0;

  const frame = (res: ServerResponse, obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const dirOf = (sessionID: string) =>
    ((sessions.get(sessionID)?.location as { directory?: string } | undefined)?.directory) ?? "/ws/mock";
  /** One event, enveloped the way the server sends it. */
  const push = (type: string, data: Json, located = true) => {
    const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined;
    const ev = {
      id: `evt_${++seq}`,
      created: 1_000 + seq,
      type,
      ...(located && sessionID ? { location: { directory: dirOf(sessionID) } } : {}),
      data,
    };
    clients.forEach((c) => frame(c, ev));
  };

  const tokens = (output: number) => ({ input: 3000, output, reasoning: 0, cache: { read: 118000, write: 2100 } });

  // A turn: two streamed text deltas, one tool call, a second step, usage on
  // each step's end, and the execution's end. `session.execution.*` carries no
  // location on the real server either.
  const streamTurn = (sessionID: string) => {
    push("session.execution.started", { sessionID }, false);
    push("session.step.started", { sessionID, agent: "build", assistantMessageID: "m1", started: 1 });
    push("session.text.started", { sessionID, assistantMessageID: "m1", ordinal: 0 });
    push("session.text.delta", { sessionID, assistantMessageID: "m1", ordinal: 0, delta: "Planning " });
    push("session.text.delta", { sessionID, assistantMessageID: "m1", ordinal: 0, delta: "the analysis. " });
    push("session.text.ended", { sessionID, assistantMessageID: "m1", ordinal: 0, text: "Planning the analysis. " });
    push("session.tool.input.started", { sessionID, assistantMessageID: "m1", id: "c1", name: "literature-search" });
    push("session.tool.called", { sessionID, assistantMessageID: "m1", id: "c1", input: { query: "OpenAlex" }, executed: false });
    push("session.tool.success", {
      sessionID,
      assistantMessageID: "m1",
      id: "c1",
      content: [{ type: "text", text: "12 papers" }],
      executed: false,
    });
    push("session.step.ended", { sessionID, assistantMessageID: "m1", finish: "tool-calls", tokens: tokens(12), cost: 0.1 });
    push("session.step.started", { sessionID, agent: "build", assistantMessageID: "m2", started: 3 });
    push("session.text.started", { sessionID, assistantMessageID: "m2", ordinal: 0 });
    push("session.text.ended", { sessionID, assistantMessageID: "m2", ordinal: 0, text: "Wrote data/corpus.csv and drafted report.md." });
    push("session.step.ended", { sessionID, assistantMessageID: "m2", finish: "stop", tokens: tokens(900), cost: 0.42 });
    push("session.execution.succeeded", { sessionID }, false);
    messages[sessionID] = [
      { id: "msg_u1", type: "user", time: { created: 1 }, text: "run a literature review" },
      {
        id: "m1",
        type: "assistant",
        agent: "build",
        model: { id: "mock-model", providerID: "mock" },
        time: { created: 1, completed: 2 },
        content: [
          { type: "text", text: "Planning the analysis. " },
          {
            type: "tool",
            id: "c1",
            name: "literature-search",
            state: { status: "completed", input: { query: "OpenAlex" }, content: [{ type: "text", text: "12 papers" }] },
            time: { created: 1, ran: 1, completed: 2 },
          },
        ],
        cost: 0.1,
        tokens: tokens(12),
      },
      {
        id: "m2",
        type: "assistant",
        agent: "build",
        model: { id: "mock-model", providerID: "mock" },
        time: { created: 3, completed: 4 },
        content: [{ type: "text", text: "Wrote data/corpus.csv and drafted report.md." }],
        cost: 0.42,
        tokens: tokens(900),
      },
      { id: "msg_idle", type: "idle", time: { created: 5 }, outcome: "succeeded" },
    ];
  };

  // A turn the runtime compacts on its own, then carries on.
  const streamCompactedTurn = (sessionID: string) => {
    push("session.execution.started", { sessionID }, false);
    push("session.compaction.started", { sessionID, reason: "auto" });
    push("session.compaction.ended", { sessionID, reason: "auto", text: "summary" });
    push("session.step.started", { sessionID, agent: "build", assistantMessageID: "m3", started: 1 });
    push("session.text.ended", { sessionID, assistantMessageID: "m3", ordinal: 0, text: "Carrying on." });
    push("session.step.ended", { sessionID, assistantMessageID: "m3", finish: "stop", tokens: tokens(5), cost: 0 });
    push("session.execution.succeeded", { sessionID }, false);
    messages[sessionID] = [
      { id: "mc", type: "compaction", status: "completed", reason: "auto", summary: "summary", time: { created: 1 } },
      { id: "m3", type: "assistant", agent: "build", time: { created: 2, completed: 3 }, content: [{ type: "text", text: "Carrying on." }] },
      { id: "msg_idle", type: "idle", time: { created: 4 }, outcome: "succeeded" },
    ];
  };

  // A turn whose model call fails: a retry is scheduled, then the execution
  // fails, and the stored step carries the error (all a reload has to show).
  const streamFlakyTurn = (sessionID: string) => {
    const error = { type: "api", message: "no channel available for this model" };
    push("session.execution.started", { sessionID }, false);
    push("session.retry.scheduled", { sessionID, assistantMessageID: "mf", attempt: 2, at: 1234, error });
    push("session.execution.failed", { sessionID, error }, false);
    messages[sessionID] = [
      { id: "msg_u", type: "user", time: { created: 1 }, text: "flaky" },
      { id: "mf", type: "assistant", agent: "build", time: { created: 1, completed: 2 }, content: [], error },
      { id: "msg_idle", type: "idle", time: { created: 3 }, outcome: "failed" },
    ];
  };

  // A turn refused because the account cannot make the call at all: the
  // retry status names the cause, the provider and the way out — the shape
  // OpenCode emits for Zen's spent free allowance (#117).
  const streamQuotaTurn = (sessionID: string) => {
    const message = "Free usage exceeded, subscribe to Go";
    push("session.execution.started", { sessionID }, false);
    push("session.status", {
      sessionID,
      status: {
        type: "retry",
        attempt: 1,
        message,
        next: 1234,
        action: {
          reason: "free_tier_limit",
          provider: "opencode",
          title: "Free limit reached",
          message: "Subscribe to OpenCode Go for reliable access…",
          label: "subscribe",
          link: "https://opencode.ai/go",
        },
      },
    });
    push("session.execution.failed", { sessionID, error: { type: "api", message } }, false);
  };

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (!body) return resolve(undefined);
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(body);
        }
      });
    });

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    const path = url.split("?")[0];
    const method = req.method ?? "GET";
    requests.push(`${method} ${url}`);

    if (method === "GET" && path === "/api/event") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      frame(res, { id: "evt_0", type: "server.connected", data: {} });
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    // No OpenCode 1 history to convert.
    if (method === "GET" && path === "/api/experimental/migration/v1") {
      return json(res, 200, { status: "completed" });
    }
    // A login waiting on the browser: never settles.
    if (method === "GET" && /^\/api\/integration\/slow\/connect\/oauth\/[^/]+$/.test(path)) {
      return json(res, 200, { data: { status: "pending", time: { created: 1, expires: 2 } } });
    }

    const body = method === "GET" || method === "DELETE" ? undefined : await readBody(req);
    if (body !== undefined) bodies.push({ request: `${method} ${path}`, body });

    if (method === "POST" && path === "/api/session") {
      const b = (body ?? {}) as Json;
      const id = "ses_mock";
      const s = { id, title: (b.title as string) ?? "New session", location: b.location ?? { directory: "/ws/mock" }, time: { created: 1, updated: 1 } };
      sessions.set(id, s);
      return json(res, 200, { data: s });
    }
    if (method === "GET" && path === "/api/session") {
      return json(res, 200, { data: [...sessions.values()], cursor: { next: null } });
    }
    const sm = path.match(/^\/api\/session\/([^/]+)(\/.*)?$/);
    if (sm) {
      const sessionID = decodeURIComponent(sm[1]);
      const rest = sm[2] ?? "";
      if (rest === "" && method === "GET") {
        const s = sessions.get(sessionID);
        return s ? json(res, 200, { data: s }) : json(res, 404, { _tag: "SessionNotFoundError", sessionID, message: "not found" });
      }
      if (rest === "" && method === "PATCH") return json(res, 200, { data: sessions.get(sessionID) ?? {} });
      if (rest === "" && method === "DELETE") {
        sessions.delete(sessionID);
        return json(res, 200, {});
      }
      if (rest === "/message" && method === "GET")
        return json(res, 200, { data: messages[sessionID] ?? [], cursor: { next: null } });
      if (rest === "/inbox" && method === "GET") return json(res, 200, { data: [] });
      if (rest === "/prompt" && method === "POST") {
        promptBodies.push(body);
        const text = String((body as Json | undefined)?.text ?? "");
        json(res, 200, { data: { id: "msg_u1", sessionID, type: "user", payload: { text }, delivery: "steer" } });
        push("session.inbox.enqueued", { inboxID: "msg_u1", sessionID, item: { type: "user", payload: { text }, delivery: "steer" } });
        const turn = text.includes("flaky")
          ? streamFlakyTurn
          : text.includes("out of quota")
            ? streamQuotaTurn
            : text.includes("compact")
              ? streamCompactedTurn
              : streamTurn;
        setTimeout(() => turn(sessionID), 5);
        return;
      }
      if (rest === "/command" && method === "POST") {
        // Answered at once, as OpenCode 2 does; the turn runs after it, and
        // the session's busy/idle stamps say when it starts and ends.
        json(res, 200, { data: {} });
        const time = sessions.get(sessionID)?.time as { busy?: number; idle?: number } | undefined;
        setTimeout(() => {
          if (time) time.busy = Date.now();
          streamTurn(sessionID);
          setTimeout(() => {
            if (time) time.idle = Date.now();
          }, 200);
        }, 50);
        return;
      }
      if (rest === "/shell" && method === "POST") {
        const command = String((body as Json | undefined)?.command ?? "");
        json(res, 200, { data: {} });
        const shell = { id: "sh_1", command, status: "running" };
        push("session.shell.started", { sessionID, shell });
        push("session.shell.ended", { sessionID, shell: { ...shell, status: "exited" }, output: { output: "/ws/mock\n" } });
        return;
      }
      if (["/agent", "/model", "/interrupt", "/compact", "/revert/stage", "/revert/commit", "/synthetic"].includes(rest) && method === "POST")
        return json(res, 200, { data: {} });
      if (rest === "/revert" && method === "DELETE") return json(res, 200, {});
      if (rest === "/fork" && method === "POST") return json(res, 200, { data: { id: "ses_fork" } });
      return json(res, 404, {});
    }

    if (method === "GET" && path === "/api/skill") {
      // Discovery order, unsorted, as the server returns it.
      return json(res, 200, {
        data: [
          { id: "home-skill", name: "home-skill", description: "From ~/.claude/skills.", path: "/home/u/.claude/skills/home-skill/SKILL.md", content: "" },
          { id: "customize-opencode", name: "customize-opencode", description: "Configure OpenCode.", path: "<built-in>", content: "" },
        ],
      });
    }
    if (method === "GET" && path === "/api/agent") {
      return json(res, 200, {
        data: [
          { id: "build", name: "build", description: "Default agent.", mode: "primary", hidden: false },
          { id: "title", name: "title", mode: "primary", hidden: true },
        ],
      });
    }
    if (method === "GET" && path === "/api/command") {
      return json(res, 200, {
        data: [
          { name: "init", description: "guided AGENTS.md setup" },
          { name: "analyze-data", description: "Analyze a dataset end to end." },
        ],
      });
    }
    if (method === "GET" && path === "/api/model") {
      return json(res, 200, {
        data: [
          {
            id: "mock-model",
            modelID: "mock-model",
            providerID: "mock",
            name: "Mock Model",
            type: "chat",
            enabled: true,
            variants: [],
            limit: { context: 200000, output: 8000 },
            cost: [{ input: 1, output: 2, cache: { read: 0, write: 0 } }],
          },
        ],
      });
    }
    if (method === "GET" && path === "/api/model/default") {
      return json(res, 200, { data: { id: "mock-model", providerID: "mock" } });
    }
    if (method === "GET" && path === "/api/provider") {
      return json(res, 200, { data: [{ id: "mock", name: "Mock Provider", activation: "auto", package: "x" }] });
    }
    if (method === "GET" && path === "/api/integration") {
      return json(res, 200, {
        data: [
          {
            id: "mock",
            name: "Mock Provider",
            methods: [{ type: "key", label: "Manually enter API Key" }, { type: "env", names: ["MOCK_API_KEY"] }],
            connections: [{ type: "credential", id: "cred_mock" }],
          },
          {
            id: "anthropic",
            name: "Anthropic",
            methods: [{ id: "claude", type: "oauth", label: "Claude Pro/Max" }, { type: "key" }, { type: "env", names: ["ANTHROPIC_API_KEY"] }],
            connections: [],
          },
          { id: "slow", name: "Slow", methods: [{ id: "browser", type: "oauth", label: "Browser" }], connections: [] },
        ],
      });
    }
    // A provider whose key the server rejects — carries a diagnostic message.
    if (method === "POST" && path === "/api/integration/bad/connect/key")
      return json(res, 400, { _tag: "InvalidRequestError", message: "invalid key format" });
    if (method === "POST" && /^\/api\/integration\/[^/]+\/connect\/key$/.test(path)) return json(res, 200, { data: {} });
    const oauth = path.match(/^\/api\/integration\/([^/]+)\/connect\/oauth$/);
    if (method === "POST" && oauth) {
      return json(res, 200, {
        data: { attemptID: `att_${oauth[1]}`, url: "https://login.example/authorize", instructions: "", mode: "auto", time: { created: 1, expires: 2 } },
      });
    }
    if (method === "GET" && /^\/api\/integration\/[^/]+\/connect\/oauth\/[^/]+$/.test(path))
      return json(res, 200, { data: { status: "complete", time: { created: 1, expires: 2 } } });
    if (method === "GET" && path === "/api/credential")
      return json(res, 200, { data: [{ id: "cred_mock", integrationID: "mock", label: "key", active: true, value: {} }] });
    if (method === "DELETE" && /^\/api\/credential\/[^/]+$/.test(path)) return json(res, 200, {});
    if (method === "GET" && path === "/api/mcp")
      return json(res, 200, { data: [{ name: "jupyter", status: { status: "connected" } }] });
    if (method === "GET" && (path === "/api/form" || path === "/api/permission/request")) return json(res, 200, { data: [] });

    json(res, 404, {});
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        port: actualPort,
        requests,
        promptBodies,
        bodies,
        close: () =>
          new Promise((r) => {
            for (const c of clients) c.end();
            clients.clear();
            server.close(() => r());
          }),
      });
    });
  });
}
