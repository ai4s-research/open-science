// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenCodeClient, type OpenCodeEvent } from "@ai4s/sdk";
import { startMockOpenCode, type MockOpenCode } from "@ai4s/sdk/mock-server";

let server: MockOpenCode;

// A fresh server per test: it broadcasts turn events to ALL connected SSE
// clients, so a single shared server would let one test's (async, timer-driven)
// turn stream into another test's client — an unrelated `session.idle` could
// then satisfy a `waitFor` before the expected events arrive. Per-test isolation
// removes that cross-talk (the cause of this file's flakiness under load).
beforeEach(async () => {
  server = await startMockOpenCode(0);
});
afterEach(async () => {
  await server.close();
});

async function waitFor(pred: () => boolean, timeout = 3000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("OpenCodeClient ↔ OpenCode server", () => {
  it("connects, creates a session, sends a prompt, and streams normalized events", async () => {
    const events: OpenCodeEvent[] = [];
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    client.onEvent((e) => events.push(e));

    await client.connect();
    expect(client.getStatus()).toBe("ready");

    const sessionId = await client.createSession();
    expect(sessionId).toBe("ses_mock");

    await client.sendPrompt(sessionId, "run a literature review");
    await waitFor(() => events.some((e) => e.type === "session.idle"));

    const types = events.map((e) => e.type);
    expect(types).toContain("text.updated");
    expect(types).toContain("tool.updated");

    // Text streams live: each message.part.delta yields the accumulated text,
    // it does not sit silent until the full part arrives at text-end.
    const p1 = events
      .filter((e): e is Extract<OpenCodeEvent, { type: "text.updated" }> =>
        e.type === "text.updated" && e.partId === "p1",
      )
      .map((e) => e.text);
    expect(p1).toContain("Planning ");
    expect(p1[p1.length - 1]).toBe("Planning the analysis. ");

    const toolDone = events.find(
      (e): e is Extract<OpenCodeEvent, { type: "tool.updated" }> =>
        e.type === "tool.updated" && e.status === "success",
    );
    expect(toolDone?.title).toContain("literature-search");

    client.close();
    expect(client.getStatus()).toBe("offline");
  });

  it("lists slash commands (config commands + skills, one merged list)", async () => {
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    const commands = await client.listCommands();
    expect(commands.map((c) => c.name)).toEqual(["init", "analyze-data"]);
    expect(commands[1].source).toBe("skill");
  });

  it("listSkills reads the v1 list, so home-level skills are included (#61)", async () => {
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    const skills = await client.listSkills();
    // Sorted by name, and the ~/.claude/skills entry the v2 route omits is here.
    expect(skills.map((s) => s.name)).toEqual(["customize-opencode", "home-skill"]);
    expect(skills[1].location).toContain(".claude/skills");
  });

  it("listProviders surfaces per-model reasoning variants, ordered low→high", async () => {
    // /config/providers carries a per-model `variants` map (variant name →
    // provider options). We keep just the names, ordered by effort, and a model
    // with no reasoning levels comes back with an empty list.
    const body = {
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          models: {
            // Deliberately scrambled to prove we sort, not echo insertion order.
            "gpt-5": { name: "GPT-5", variants: { high: {}, minimal: {}, low: {}, medium: {} } },
            "gpt-4": { name: "GPT-4" }, // no reasoning levels
          },
        },
      ],
    };
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify(body), { status: 200 });
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:1", fetchImpl });

    const providers = await client.listProviders();
    const models = providers[0].models;
    expect(models.find((m) => m.id === "gpt-5")?.variants).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(models.find((m) => m.id === "gpt-4")?.variants).toEqual([]);
  });

  it("namespaces a background-review part's metadata, because the model is shown it", async () => {
    // #114, reproduced against the pinned runtime: an assistant text part's
    // metadata is forwarded to the model as `providerMetadata`, whose schema is
    // Record<string, Record<string, JSONValue>>. The flat
    // `{ source: "ai4s.background-review" }` this used to send put a string
    // where a record belongs, and the AI SDK then rejected the WHOLE
    // conversation — on that turn and every turn after, since the part is
    // persisted. A background review permanently ended the conversation it had
    // just reviewed. Every value here must be an object, one level down.
    let sent: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response("{}", { status: 200 });
    };
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:1", fetchImpl });

    await client.appendTextPart("ses_1", "msg_1", "```review\n{}\n```", "prt_1");

    const metadata = sent.metadata as Record<string, unknown>;
    expect(Object.keys(metadata).length).toBeGreaterThan(0);
    for (const value of Object.values(metadata)) {
      expect(typeof value).toBe("object");
      expect(value).not.toBeNull();
      expect(Array.isArray(value)).toBe(false);
    }
    expect(metadata).toEqual({ ai4s: { source: "background-review" } });
  });

  it("surfaces each model's context window, and 0 when OpenCode has none", async () => {
    // Load-bearing, not decorative: OpenCode short-circuits auto-compaction on
    // `limit.context === 0`, so a model whose window it does not know never gets
    // compacted and its conversation grows until long turns stall. Observed on a
    // real install — the bundled catalog models report a window, custom-endpoint
    // models report 0. Absent and 0 must normalise to the same thing so callers
    // test one value.
    const body = {
      providers: [
        {
          id: "apevon",
          name: "Apevon",
          models: {
            "gpt-5.6-sol": { name: "Sol", limit: { context: 0, output: 0 } },
            "laguna-s": { name: "Laguna", limit: { context: 256000, output: 32000 } },
            "no-limit-key": { name: "Bare" },
          },
        },
      ],
    };
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify(body), { status: 200 });
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:1", fetchImpl });

    const models = (await client.listProviders())[0].models;
    expect(models.find((m) => m.id === "laguna-s")?.contextLimit).toBe(256000);
    expect(models.find((m) => m.id === "gpt-5.6-sol")?.contextLimit).toBe(0);
    expect(models.find((m) => m.id === "no-limit-key")?.contextLimit).toBe(0);
  });

  it("surfaces a model's whole effort vocabulary including `max` (#74)", async () => {
    // From 1.18 on, OpenCode builds a model's variants from the catalog's own
    // `reasoning_options`, so the top of the range is whatever the catalog says —
    // `max` for the GPT-5.6 family. The bundled 1.17.13 stopped at `xhigh`, which
    // is why the app's effort control did too. Nothing here is an allowlist: the
    // names come from the runtime and only their ORDER is ours.
    const body = {
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          models: {
            "gpt-5.6-sol": {
              name: "GPT-5.6 Sol",
              // Scrambled, and `max` deliberately not last on the wire.
              variants: { max: {}, low: {}, none: {}, xhigh: {}, high: {}, medium: {} },
            },
            // An unknown level must survive rather than be dropped — a future
            // runtime may name one we have never heard of.
            "future-model": { name: "Future", variants: { low: {}, ultra: {}, high: {} } },
          },
        },
      ],
    };
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify(body), { status: 200 });
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:1", fetchImpl });

    const models = (await client.listProviders())[0].models;
    expect(models.find((m) => m.id === "gpt-5.6-sol")?.variants).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    // Known levels keep their progression; the unrecognized one lands after them.
    expect(models.find((m) => m.id === "future-model")?.variants).toEqual([
      "low",
      "high",
      "ultra",
    ]);
  });

  it("runs a shell command: bash tool part + session.idle stream back", async () => {
    const events: OpenCodeEvent[] = [];
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    client.onEvent((e) => events.push(e));
    await client.connect();
    await client.runShell("ses_mock", "pwd");
    await waitFor(() => events.some((e) => e.type === "session.idle"));
    const bash = events.find(
      (e): e is Extract<OpenCodeEvent, { type: "tool.updated" }> =>
        e.type === "tool.updated" && e.tool === "bash",
    );
    expect(bash?.status).toBe("success");
    expect(bash?.output).toContain("/ws/mock");
    client.close();
  });

  it("runs a slash command: a normal agent turn streams back", async () => {
    const events: OpenCodeEvent[] = [];
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    client.onEvent((e) => events.push(e));
    await client.connect();
    await client.runCommand("ses_mock", "init", "focus on tests");
    await waitFor(() => events.some((e) => e.type === "session.idle"));
    expect(events.map((e) => e.type)).toContain("text.updated");
    client.close();
  });

  it("maps time.completed onto history messages and aborts a session", async () => {
    const events: OpenCodeEvent[] = [];
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    client.onEvent((e) => events.push(e));
    await client.connect();
    const sessionId = await client.createSession();
    await client.sendPrompt(sessionId, "run a literature review");
    // Wait for the turn to finish before reading history — the mock writes the
    // stored messages when it streams the turn (on a timer), so reading eagerly
    // races that write (empty history) under load.
    await waitFor(() => events.some((e) => e.type === "session.idle"));
    const messages = await client.getMessages(sessionId);
    const last = messages[messages.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.completed).toBe(2); // the turn is over — the reconcile signal
    await expect(client.abortSession(sessionId)).resolves.toBeUndefined();
    client.close();
  });

  it("surfaces a failing model call: retry status, session error, and the history error", async () => {
    const events: OpenCodeEvent[] = [];
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    client.onEvent((e) => events.push(e));
    await client.connect();
    const sessionId = await client.createSession();
    await client.sendPrompt(sessionId, "flaky provider call");
    await waitFor(() => events.some((e) => e.type === "session.idle"));

    // The status events are the only sign of life while every attempt fails, so
    // they must reach the app. An ordinary provider failure carries no `action`.
    const retry = events.find((e) => e.type === "session.retry");
    expect(retry).toMatchObject({
      sessionId,
      attempt: 2,
      message: "no channel available for this model",
    });
    expect(retry && "action" in retry ? retry.action : undefined).toBeUndefined();
    expect(events.find((e) => e.type === "error")).toMatchObject({
      sessionId,
      message: "no channel available for this model",
    });

    // A reload after the live error was missed must still explain the failure.
    const messages = await client.getMessages(sessionId);
    const last = messages[messages.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.error).toBe("no channel available for this model");
    client.close();
  });

  it("carries the account-state action a retry status names, not just its message", async () => {
    // Without the action, "the free allowance is spent" and "the provider
    // hiccuped" are the same event to the app, and it can only offer to wait
    // out a condition that no number of attempts will change (#117).
    const events: OpenCodeEvent[] = [];
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    client.onEvent((e) => events.push(e));
    await client.connect();
    const sessionId = await client.createSession();
    await client.sendPrompt(sessionId, "a turn that is out of quota");
    await waitFor(() => events.some((e) => e.type === "session.idle"));

    expect(events.find((e) => e.type === "session.retry")).toMatchObject({
      sessionId,
      message: "Free usage exceeded, subscribe to Go",
      action: {
        reason: "free_tier_limit",
        provider: "opencode",
        link: "https://opencode.ai/go",
      },
    });
    client.close();
  });

  it("reports an error status when the server is unreachable", async () => {
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:1" });
    await expect(client.connect()).rejects.toBeTruthy();
    expect(client.getStatus()).toBe("error");
  });

  it("disposes the cached instance after credential changes, so providers refresh", async () => {
    // The server caches its provider list per instance; PUT/DELETE /auth alone
    // leaves it stale (the new provider never appears in the UI). Verified on
    // opencode 1.17.13: POST /instance/dispose makes the change visible.
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.port}` });

    server.requests.length = 0;
    await client.setProviderApiKey("mock", "sk-123");
    expect(server.requests).toEqual(["PUT /auth/mock", "POST /instance/dispose"]);

    server.requests.length = 0;
    await client.removeProviderAuth("mock");
    expect(server.requests).toEqual(["DELETE /auth/mock", "POST /instance/dispose"]);

    server.requests.length = 0;
    await client.oauthCallback("mock", 0);
    expect(server.requests).toEqual([
      "POST /provider/mock/oauth/callback",
      "POST /instance/dispose",
    ]);
  });

  it("disposes the workspace instance too when scoped to a directory", async () => {
    // Sessions run on the per-directory instance — if only the default one
    // were disposed, chats would keep a stale provider list until restart.
    const client = new OpenCodeClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      directory: "/ws/dir",
    });
    server.requests.length = 0;
    await client.setProviderApiKey("mock", "sk-123");
    expect(server.requests).toEqual([
      "PUT /auth/mock",
      "POST /instance/dispose",
      "POST /instance/dispose?directory=%2Fws%2Fdir",
    ]);
  });

  it("cancels a pending browser-login wait via the AbortSignal", async () => {
    // "auto" OAuth callbacks wait for the browser redirect — cancelling in
    // the UI must abort the request, not leak it on the sidecar.
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    server.requests.length = 0;
    const abort = new AbortController();
    const pending = client.oauthCallback("slow", 0, undefined, abort.signal);
    await waitFor(() => server.requests.includes("POST /provider/slow/oauth/callback"));
    abort.abort();
    await expect(pending).rejects.toThrow();
    // An aborted login must not dispose the instance (nothing changed).
    expect(server.requests.filter((r) => r.includes("dispose"))).toEqual([]);
  });

  it("surfaces the server's diagnostic message when saving a key fails", async () => {
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    await expect(client.setProviderApiKey("bad", "nope")).rejects.toThrow(/invalid key format/);
  });

  it("sends Basic auth on API calls when a password is set", async () => {
    // The sidecar now REQUIRES auth (OPENCODE_SERVER_PASSWORD) — every fetch
    // must carry the Authorization header or the server answers 401.
    const seen: (string | undefined)[] = [];
    const capturing: typeof fetch = (input, init) => {
      seen.push((init?.headers as Record<string, string> | undefined)?.["Authorization"]);
      return fetch(input, init);
    };
    const client = new OpenCodeClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      password: "pw-secret",
      fetchImpl: capturing,
    });
    await client.createSession();
    expect(seen[0]).toBe("Basic " + Buffer.from("opencode:pw-secret").toString("base64"));
  });

  it("gives a host-created dedicated session its artifact title", async () => {
    let body: unknown;
    const fetchImpl: typeof fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: "ses_dedicated" }), { status: 200 });
    };
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:1", fetchImpl });
    await expect(client.createSession("Result review")).resolves.toBe("ses_dedicated");
    expect(body).toEqual({ title: "Result review" });
  });

  it("keeps the EventSource stream when a password is set, authenticating via auth_token", async () => {
    // EventSource cannot set headers, but it is the reliable SSE path in the
    // WKWebView — the server accepts the same Basic payload as ?auth_token=.
    const urls: string[] = [];
    class FakeEventSource {
      onopen: (() => void) | null = null;
      onmessage: unknown = null;
      onerror: unknown = null;
      constructor(url: string) {
        urls.push(url);
        setTimeout(() => this.onopen?.(), 0);
      }
      close() {}
    }
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
    try {
      const client = new OpenCodeClient({
        baseUrl: `http://127.0.0.1:${server.port}`,
        password: "pw-secret",
        directory: "/ws/dir",
      });
      await client.connect();
      expect(client.getStatus()).toBe("ready");
      const token = Buffer.from("opencode:pw-secret").toString("base64");
      expect(urls[0]).toContain(`auth_token=${encodeURIComponent(token)}`);
      expect(urls[0]).toContain(`directory=${encodeURIComponent("/ws/dir")}`);
      client.close();
    } finally {
      delete (globalThis as { EventSource?: unknown }).EventSource;
    }
  });

  it("times out a hanging EventSource handshake so boot retry can continue", async () => {
    class HangingEventSource {
      onopen: (() => void) | null = null;
      onmessage: unknown = null;
      onerror: unknown = null;
      close = vi.fn();
      constructor(_url: string) {}
    }
    (globalThis as { EventSource?: unknown }).EventSource = HangingEventSource;
    try {
      const client = new OpenCodeClient({
        baseUrl: `http://127.0.0.1:${server.port}`,
        connectTimeoutMs: 10,
      });
      await expect(client.connect()).rejects.toThrow("Timed out opening OpenCode event stream");
      expect(client.getStatus()).toBe("error");
    } finally {
      delete (globalThis as { EventSource?: unknown }).EventSource;
    }
  });

  it("times out a hanging session creation request", async () => {
    const hangingFetch = ((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      })) as typeof fetch;
    const client = new OpenCodeClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      fetchImpl: hangingFetch,
      requestTimeoutMs: 10,
    });
    await expect(client.createSession()).rejects.toThrow("Timed out waiting for OpenCode");
  });

  it("times out a hanging history request", async () => {
    const hangingFetch = ((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      })) as typeof fetch;
    const client = new OpenCodeClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      fetchImpl: hangingFetch,
      requestTimeoutMs: 10,
    });
    await expect(client.getMessages("ses_hung")).rejects.toThrow("Timed out waiting for OpenCode");
  });
});

// The numbers exist only on the assistant message — nowhere else in the
// protocol — so a client that narrows them away leaves the app unable to say
// how full the context window is at all.
describe("token usage", () => {
  it("surfaces a turn's running totals as message.usage", async () => {
    const events: OpenCodeEvent[] = [];
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    client.onEvent((e) => events.push(e));
    await client.connect();
    const sessionId = await client.createSession();

    await client.sendPrompt(sessionId, "run a literature review");
    await waitFor(() => events.some((e) => e.type === "session.idle"));

    const usage = events.filter(
      (e): e is Extract<OpenCodeEvent, { type: "message.usage" }> => e.type === "message.usage",
    );
    // Republished as the turn runs, ending with the final numbers.
    expect(usage.length).toBeGreaterThan(1);
    expect(usage[usage.length - 1]).toMatchObject({
      messageID: "m1",
      completed: 2,
      usage: { input: 3000, output: 900, reasoning: 0, cacheRead: 118000, cacheWrite: 2100, cost: 0.42 },
    });
    client.close();
  });

  it("ties streamed text to its message, including the parts that arrive as deltas", async () => {
    const events: OpenCodeEvent[] = [];
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    client.onEvent((e) => events.push(e));
    await client.connect();
    const sessionId = await client.createSession();

    await client.sendPrompt(sessionId, "run a literature review");
    await waitFor(() => events.some((e) => e.type === "session.idle"));

    const text = events.filter(
      (e): e is Extract<OpenCodeEvent, { type: "text.updated" }> => e.type === "text.updated",
    );
    // A delta-driven update that forgot the id would blank it out on the block.
    expect(text.every((e) => e.messageID === "m1")).toBe(true);
    client.close();
  });

  it("recovers the same usage from history", async () => {
    const events: OpenCodeEvent[] = [];
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    client.onEvent((e) => events.push(e));
    await client.connect();
    const sessionId = await client.createSession();
    await client.sendPrompt(sessionId, "run a literature review");
    // The turn stores its messages as it ends; reading before that gets the
    // server's empty placeholder.
    await waitFor(() => events.some((e) => e.type === "session.idle"));

    const msgs = await client.getMessages(sessionId);
    const assistant = msgs.find((m) => m.role === "assistant");
    expect(assistant?.usage).toEqual({
      input: 3000,
      output: 900,
      reasoning: 0,
      cacheRead: 118000,
      cacheWrite: 2100,
      cost: 0.42,
    });
    // A user message has no tokens at all — not a zeroed-out object.
    expect(msgs.find((m) => m.role === "user")?.usage).toBeUndefined();
    client.close();
  });
});

// OpenCode's SessionCompaction.create writes a message with role "user" and
// hangs the compaction part off it. The echoed-user-text guard therefore ate
// every compaction marker before it could be emitted — #62 shipped a renderer
// nothing ever fed.
describe("compaction arrives on a user-role message", () => {
  it("emits session.compacted anyway", async () => {
    const events: OpenCodeEvent[] = [];
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    client.onEvent((e) => events.push(e));
    await client.connect();
    const sessionId = await client.createSession();

    await client.sendPrompt(sessionId, "compact the context");
    await waitFor(() => events.some((e) => e.type === "session.idle"));

    expect(events.filter((e) => e.type === "session.compacted")).toEqual([
      { type: "session.compacted", sessionId: "ses_mock", auto: true, overflow: true },
    ]);
    // The marker message carries no text; nothing should be echoed for it.
    expect(events.some((e) => e.type === "text.updated" && e.text === "")).toBe(false);
    client.close();
  });
});

describe("per-prompt agent pinning", () => {
  it("sends the host presentation contract and the optional agent field", async () => {
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    await client.connect();
    const sessionId = await client.createSession();
    const before = server.promptBodies.length;

    await client.sendPrompt(sessionId, "plan the analysis", "plan");
    await client.sendPrompt(sessionId, "run a literature review");

    const bodies = server.promptBodies.slice(before) as Array<Record<string, unknown>>;
    expect(bodies[0]).toMatchObject({
      agent: "plan",
      parts: [{ type: "text", text: "plan the analysis" }],
    });
    expect(bodies[0].system).toContain("call present_artifact with display=\"inline\"");
    expect(bodies[0].system).toContain("target=\"new-screen\"");
    expect(bodies[0].system).toContain("target=\"new-session\"");
    expect(bodies[0].system).toContain("Never claim an artifact is displayed");
    expect(bodies[1].system).toBe(bodies[0].system);
    // Build mode carries no agent key.
    expect(bodies[1]).not.toHaveProperty("agent");
    client.close();
  });
});

describe("provider region config", () => {
  it("reads and writes a provider region through the global config", async () => {
    const requests: Array<{ method: string; body?: unknown }> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const method = init?.method ?? "GET";
      requests.push({
        method,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return new Response(
        JSON.stringify({
          provider: {
            "amazon-bedrock": { options: { region: "eu-west-1", profile: "research" } },
          },
        }),
        { status: 200 },
      );
    };
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:1", fetchImpl });

    await expect(client.getProviderRegion("amazon-bedrock")).resolves.toBe("eu-west-1");
    await client.setProviderRegion("amazon-bedrock", "ap-northeast-1");

    expect(requests).toEqual([
      { method: "GET", body: undefined },
      {
        method: "PATCH",
        body: {
          provider: {
            "amazon-bedrock": { options: { region: "ap-northeast-1" } },
          },
        },
      },
    ]);
  });

  it("returns null when a provider has no configured region", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ provider: { openai: { options: {} } } }), { status: 200 });
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:1", fetchImpl });

    await expect(client.getProviderRegion("amazon-bedrock")).resolves.toBeNull();
  });
});

describe("custom-model context limits (#52: never pin a guessed window)", () => {
  // Mock only /global/config: a GET returns the current provider map, a PATCH
  // deep-merges into it (mirroring OpenCode's remeda mergeDeep) and is recorded.
  function mockGlobalConfig(initialProviders: Record<string, unknown> = {}) {
    const store = structuredClone(initialProviders) as Record<string, Record<string, unknown>>;
    const patches: Array<{ provider: Record<string, { models?: Record<string, unknown> }> }> = [];
    const mergeDeep = (target: Record<string, unknown>, source: Record<string, unknown>) => {
      for (const key of Object.keys(source)) {
        const s = source[key];
        const t = target[key];
        if (s && typeof s === "object" && !Array.isArray(s) && t && typeof t === "object") {
          mergeDeep(t as Record<string, unknown>, s as Record<string, unknown>);
        } else {
          target[key] = s;
        }
      }
      return target;
    };
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (!url.endsWith("/global/config")) return new Response("not found", { status: 404 });
      if ((init?.method ?? "GET").toUpperCase() === "PATCH") {
        const body = JSON.parse(init!.body as string);
        patches.push(body);
        mergeDeep(store, body.provider ?? {});
      }
      return new Response(JSON.stringify({ provider: store }), { status: 200 });
    };
    return { fetchImpl, patches, store };
  }

  it("writes no context limit when the model window is unknown", async () => {
    const { fetchImpl, patches } = mockGlobalConfig();
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:1", fetchImpl });
    await client.addCustomProvider("custom", {
      name: "Custom",
      npm: "@ai-sdk/openai-compatible",
      baseURL: "https://example.test/v1",
      models: ["sol"],
    });
    expect(patches[patches.length - 1].provider.custom.models!.sol).toEqual({ name: "sol" });
  });

  it("pins a probed/typed context window exactly", async () => {
    const { fetchImpl, patches } = mockGlobalConfig();
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:1", fetchImpl });
    await client.addCustomProvider("custom", {
      name: "Custom",
      npm: "@ai-sdk/openai-compatible",
      baseURL: "https://example.test/v1",
      models: ["sol"],
      contexts: { sol: 1_500_000 },
    });
    expect(patches[patches.length - 1].provider.custom.models!.sol).toEqual({
      name: "sol",
      limit: { context: 1_500_000, output: 0 },
    });
  });

  it("carries a described model's own metadata into the runtime's record", async () => {
    // A caller that knows more than an id (a probe that reported the window, a
    // user who filled the form) must be able to say so: the alternative is the
    // runtime guessing, which is what #52 was about. Ids alone still work.
    const { fetchImpl, patches } = mockGlobalConfig();
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:1", fetchImpl });

    await client.addCustomProvider("selfhosted", {
      name: "Self-hosted",
      npm: "@ai-sdk/openai-compatible",
      baseURL: "https://llm.example.internal/v1",
      models: [
        {
          id: "big",
          context: 200_000,
          reasoning: true,
          modalities: { input: ["text", "image"] },
          variants: { fast: { thinking: { type: "disabled" } } },
        },
        "small",
      ],
    });

    const models = patches[patches.length - 1].provider.selfhosted.models!;
    expect(models.big).toMatchObject({
      name: "big",
      limit: { context: 200_000, output: 0 },
      reasoning: true,
      modalities: { input: ["text", "image"] },
      variants: { fast: { thinking: { type: "disabled" } } },
    });
    // Nothing is invented for a model given as a bare id.
    expect(models.small).toEqual({ name: "small" });
    // And no cost is written for either: a rate nobody supplied would be a
    // guess, and a wrong one shows up as wrong money in the usage readout.
    expect(models.big).not.toHaveProperty("cost");
    expect(models.small).not.toHaveProperty("cost");
  });

  it("keeps what is already configured for a model it is re-saving", async () => {
    // Re-adding an endpoint used to rebuild each model from scratch, dropping
    // everything the record held beyond its limit — a hand-set cost or set of
    // modalities disappeared the next time the form was submitted.
    const { fetchImpl, patches } = mockGlobalConfig({
      selfhosted: {
        models: {
          big: {
            name: "big",
            limit: { context: 200_000, output: 0 },
            cost: { input: 1, output: 2 },
          },
        },
      },
    });
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:1", fetchImpl });

    await client.addCustomProvider("selfhosted", {
      name: "Self-hosted",
      npm: "@ai-sdk/openai-compatible",
      baseURL: "https://llm.example.internal/v1",
      models: ["big"],
    });

    expect(patches[patches.length - 1].provider.selfhosted.models!.big).toMatchObject({
      limit: { context: 200_000, output: 0 },
      cost: { input: 1, output: 2 },
    });
  });

  it("keeps a hand-set limit when no window is provided", async () => {
    const { fetchImpl, patches } = mockGlobalConfig({
      custom: { name: "Custom", models: { sol: { name: "sol", limit: { context: 64_000, output: 0 } } } },
    });
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:1", fetchImpl });
    await client.addCustomProvider("custom", {
      name: "Custom",
      npm: "@ai-sdk/openai-compatible",
      baseURL: "https://example.test/v1",
      models: ["sol"],
    });
    expect(patches[patches.length - 1].provider.custom.models!.sol).toEqual({
      name: "sol",
      limit: { context: 64_000, output: 0 },
    });
  });

  it("resets the blind 128k default to 0, leaves real limits alone, and is idempotent", async () => {
    const { fetchImpl, patches, store } = mockGlobalConfig({
      custom: {
        name: "Custom",
        models: {
          sol: { name: "sol", limit: { context: 128_000, output: 0 } }, // blind default → reset
          local: { name: "local", limit: { context: 131_072, output: 0 } }, // probed → keep
          bare: { name: "bare" }, // no limit → untouched
        },
      },
    });
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:1", fetchImpl });
    await client.clearDefaultCustomModelContextLimits();

    const models = (store.custom.models as Record<string, { limit?: unknown }>);
    expect(models.sol.limit).toEqual({ context: 0, output: 0 });
    expect(models.local.limit).toEqual({ context: 131_072, output: 0 });
    expect(models.bare.limit).toBeUndefined();
    expect(patches).toHaveLength(1);

    await client.clearDefaultCustomModelContextLimits();
    expect(patches).toHaveLength(1); // nothing left matching the default → no second PATCH
  });

  // #119: from the gateway-served web client this PATCH is refused by gateway
  // policy, which reports its reason as `{error}`. Swallowing that field left
  // the user with "Failed to add the provider (403)" — indistinguishable from
  // their own API key being rejected, which is what they concluded.
  it("surfaces the gateway's refusal reason, not a bare status", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ error: "provider/model config is managed on the desktop" }), {
        status: 403,
      });
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:1", fetchImpl });
    await expect(
      client.addCustomProvider("custom", {
        name: "Custom",
        npm: "@ai-sdk/openai-compatible",
        baseURL: "https://example.test/v1",
        models: ["sol"],
      }),
    ).rejects.toThrow("provider/model config is managed on the desktop");
  });
});

describe("per-prompt model pinning (#8: old sessions follow the current default)", () => {
  it("sends model as {providerID, modelID} when a default is passed, omits it otherwise", async () => {
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    await client.connect();
    const sessionId = await client.createSession();
    const before = server.promptBodies.length;

    await client.sendPrompt(sessionId, "hi", undefined, "anthropic/claude-opus-4-8");
    await client.sendPrompt(sessionId, "hi again"); // no default → no model key
    await client.sendPrompt(sessionId, "hi", undefined, "malformed-no-slash"); // unparseable → omitted

    const bodies = server.promptBodies.slice(before) as Array<Record<string, unknown>>;
    expect(bodies[0]).toMatchObject({ model: { providerID: "anthropic", modelID: "claude-opus-4-8" } });
    expect(bodies[1]).not.toHaveProperty("model");
    expect(bodies[2]).not.toHaveProperty("model");
    client.close();
  });
});

describe("image attachments (#88: a vision model must see the figure, not its name)", () => {
  it("sends each attachment as a file part beside the text, and none when there are none", async () => {
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    await client.connect();
    const sessionId = await client.createSession();
    const before = server.promptBodies.length;

    await client.sendPrompt(sessionId, "inspect this figure", undefined, null, null, [
      { filename: "pasted.png", mime: "image/png", url: "data:image/png;base64,UE5H" },
    ]);
    await client.sendPrompt(sessionId, "no attachment");

    const bodies = server.promptBodies.slice(before) as Array<{ parts: Array<Record<string, unknown>> }>;
    expect(bodies[0].parts).toEqual([
      { type: "text", text: "inspect this figure" },
      {
        type: "file",
        mime: "image/png",
        filename: "pasted.png",
        // A data: URL, never file:// — OpenCode answers 204 to a file:// url and
        // then stores no message at all, silently losing the turn.
        url: "data:image/png;base64,UE5H",
      },
    ]);
    expect(bodies[1].parts).toEqual([{ type: "text", text: "no attachment" }]);
    client.close();
  });
});
