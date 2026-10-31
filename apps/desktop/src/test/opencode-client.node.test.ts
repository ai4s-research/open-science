// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenCodeClient, type ConfigStore, type OpenCodeEvent } from "@ai4s/sdk";
import { startMockOpenCode, type MockOpenCode } from "@ai4s/sdk/mock-server";

let server: MockOpenCode;

// A fresh server per test: it broadcasts turn events to ALL connected SSE
// clients, so a shared server would let one test's (timer-driven) turn stream
// into another test's client.
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

const base = () => `http://127.0.0.1:${server.port}`;

/** A config file in memory, merged the way the host's store merges. */
function memoryConfig(initial: Record<string, unknown> = {}) {
  const state = structuredClone(initial);
  const patches: Record<string, unknown>[] = [];
  const merge = (a: Record<string, unknown>, b: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(b)) {
      const p = a[k];
      if (v && typeof v === "object" && !Array.isArray(v) && p && typeof p === "object" && !Array.isArray(p))
        merge(p as Record<string, unknown>, v as Record<string, unknown>);
      else a[k] = v;
    }
  };
  const store: ConfigStore = {
    read: async () => structuredClone(state),
    patch: async (patch) => {
      patches.push(structuredClone(patch));
      merge(state, patch);
    },
  };
  return { store, state, patches };
}

/** A client whose every request is answered from `routes` ("METHOD /path" →
 *  JSON body), recording what it sent. */
function stubbed(routes: Record<string, unknown>, opts: { status?: number } = {}) {
  const calls: Array<{ request: string; body?: unknown }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const request = `${init?.method ?? "GET"} ${url.pathname}`;
    calls.push({ request, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const hit = routes[request];
    if (hit === undefined) return new Response(JSON.stringify({}), { status: 404 });
    return new Response(JSON.stringify(hit), { status: opts.status ?? 200 });
  };
  return { fetchImpl, calls };
}

describe("OpenCodeClient ↔ OpenCode server", () => {
  it("connects, creates a session, sends a prompt, and streams normalized events", async () => {
    const events: OpenCodeEvent[] = [];
    const client = new OpenCodeClient({ baseUrl: base() });
    client.onEvent((e) => events.push(e));

    await client.connect();
    expect(client.getStatus()).toBe("ready");

    const sessionId = await client.createSession();
    expect(sessionId).toBe("ses_mock");

    await client.sendPrompt(sessionId, "run a literature review");
    await waitFor(() => events.some((e) => e.type === "session.idle"));

    const types = events.map((e) => e.type);
    for (const t of ["user.message", "step.updated", "text.updated", "tool.updated", "message.usage"]) expect(types).toContain(t);

    // Text streams live: each delta yields the accumulated text, it does not
    // sit silent until the full text arrives at the end.
    const first = events
      .filter((e): e is Extract<OpenCodeEvent, { type: "text.updated" }> => e.type === "text.updated" && e.messageID === "m1")
      .map((e) => e.text);
    expect(first).toContain("Planning ");
    expect(first[first.length - 1]).toBe("Planning the analysis. ");

    const toolDone = events.find(
      (e): e is Extract<OpenCodeEvent, { type: "tool.updated" }> => e.type === "tool.updated" && e.status === "success",
    );
    expect(toolDone).toMatchObject({ tool: "literature-search", output: "12 papers", input: { query: "OpenAlex" } });

    // Two steps, counted in order.
    expect(events.filter((e) => e.type === "step.updated").map((e) => (e as { step: number }).step)).toEqual([1, 2]);

    client.close();
    expect(client.getStatus()).toBe("offline");
  });

  it("lists slash commands", async () => {
    const client = new OpenCodeClient({ baseUrl: base() });
    const commands = await client.listCommands();
    expect(commands.map((c) => c.name)).toEqual(["init", "analyze-data"]);
  });

  it("lists skills sorted by name, with where each was found", async () => {
    const client = new OpenCodeClient({ baseUrl: base() });
    const skills = await client.listSkills();
    expect(skills.map((s) => s.name)).toEqual(["customize-opencode", "home-skill"]);
    expect(skills[1].location).toContain(".claude/skills");
  });

  it("lists the agents a user can pick, not the runtime's hidden ones", async () => {
    const client = new OpenCodeClient({ baseUrl: base() });
    expect(await client.listAgents()).toEqual([{ name: "build", description: "Default agent.", mode: "primary" }]);
  });

  it("asks for folder-scoped reads in this client's folder", async () => {
    const client = new OpenCodeClient({ baseUrl: base(), directory: "/ws/dir" });
    await client.listSkills();
    expect(server.requests).toContain(`GET /api/skill?location%5Bdirectory%5D=%2Fws%2Fdir`);
  });

  it("listProviders groups chat models by provider, with ordered variants, windows and prices", async () => {
    const model = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      modelID: id,
      providerID: "openai",
      name: id.toUpperCase(),
      type: "chat",
      enabled: true,
      variants: [],
      limit: { context: 0, output: 0 },
      cost: [],
      ...extra,
    });
    const { fetchImpl } = stubbed({
      "GET /api/model": {
        data: [
          // Deliberately scrambled, `max` not last and an unknown level, to
          // prove the order is ours and nothing is an allowlist (#74).
          model("gpt-5.6-sol", { variants: [{ id: "max" }, { id: "low" }, { id: "none" }, { id: "xhigh" }, { id: "high" }, { id: "medium" }] }),
          model("future", { variants: [{ id: "low" }, { id: "ultra" }, { id: "high" }] }),
          model("windowed", { limit: { context: 256000, output: 32000 } }),
          model("free", { providerID: "opencode", cost: [{ input: 0, output: 0 }] }),
          model("half-free", { providerID: "opencode", cost: [{ input: 0, output: 2 }] }),
          model("image-model", { type: "image" }),
          model("disabled", { enabled: false }),
        ],
      },
      "GET /api/provider": { data: [{ id: "openai", name: "OpenAI" }, { id: "opencode", name: "OpenCode Zen" }] },
    });
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:1", fetchImpl });
    const providers = await client.listProviders();
    const openai = providers.find((p) => p.id === "openai")!;
    expect(openai.name).toBe("OpenAI");
    const m = (id: string) => providers.flatMap((p) => p.models).find((x) => x.id === id);
    expect(m("gpt-5.6-sol")?.variants).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(m("future")?.variants).toEqual(["low", "high", "ultra"]);
    // 0 and "absent" both mean an unknown window.
    expect(m("windowed")?.contextLimit).toBe(256000);
    expect(m("gpt-5.6-sol")?.contextLimit).toBe(0);
    // Free only when every price tier is zero; no price is "not known".
    expect(m("free")?.free).toBe(true);
    expect(m("half-free")?.free).toBe(false);
    expect(m("gpt-5.6-sol")?.free).toBeUndefined();
    // Models that cannot run a session are not offered.
    expect(m("image-model")).toBeUndefined();
    expect(m("disabled")).toBeUndefined();
  });

  it("persists a background review as a synthetic message that starts no turn, metadata namespaced", async () => {
    // #114: a part's metadata reached the model as `providerMetadata`, and a
    // flat string where a record belongs made the provider reject the whole
    // conversation. Every value stays an object, one level down.
    const { fetchImpl, calls } = stubbed({ "POST /api/session/ses_1/synthetic": { data: {} } });
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:1", fetchImpl });

    await client.appendTextPart("ses_1", "msg_1", "```review\n{}\n```", "prt_1");

    const sent = calls[0].body as { text: string; resume: boolean; metadata: Record<string, unknown> };
    expect(sent.text).toBe("```review\n{}\n```");
    expect(sent.resume).toBe(false);
    for (const value of Object.values(sent.metadata)) {
      expect(typeof value).toBe("object");
      expect(Array.isArray(value)).toBe(false);
    }
    expect(sent.metadata).toEqual({ ai4s: { source: "background-review", messageID: "msg_1", partID: "prt_1" } });
  });

  it("runs a shell command: a bash tool result streams back", async () => {
    const events: OpenCodeEvent[] = [];
    const client = new OpenCodeClient({ baseUrl: base() });
    client.onEvent((e) => events.push(e));
    await client.connect();
    await client.createSession();
    await client.runShell("ses_mock", "pwd");
    await waitFor(() => events.some((e) => e.type === "tool.updated" && e.status === "success"));
    const bash = events.filter(
      (e): e is Extract<OpenCodeEvent, { type: "tool.updated" }> => e.type === "tool.updated" && e.tool === "bash",
    );
    expect(bash.map((e) => e.status)).toEqual(["running", "success"]);
    expect(bash[1].output).toContain("/ws/mock");
    expect(bash[1].input).toEqual({ command: "pwd" });
    client.close();
  });

  it("runs a slash command by name, with its arguments as text", async () => {
    const events: OpenCodeEvent[] = [];
    const client = new OpenCodeClient({ baseUrl: base() });
    client.onEvent((e) => events.push(e));
    await client.connect();
    await client.createSession();
    await client.runCommand("ses_mock", "init", "focus on tests");
    await waitFor(() => events.some((e) => e.type === "session.idle"));
    expect(server.bodies.find((b) => b.request === "POST /api/session/ses_mock/command")?.body).toEqual({
      name: "init",
      text: "focus on tests",
    });
    expect(events.map((e) => e.type)).toContain("text.updated");
    client.close();
  });

  it("maps a finished turn's history, and interrupts a session", async () => {
    const events: OpenCodeEvent[] = [];
    const client = new OpenCodeClient({ baseUrl: base() });
    client.onEvent((e) => events.push(e));
    await client.connect();
    const sessionId = await client.createSession();
    await client.sendPrompt(sessionId, "run a literature review");
    await waitFor(() => events.some((e) => e.type === "session.idle"));
    const messages = await client.getMessages(sessionId);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(messages[0]).toMatchObject({ id: "msg_u1", agent: "build", parts: [{ type: "text", text: "run a literature review" }] });
    const tool = messages[1].parts.find((p) => p.type === "tool");
    expect(tool).toMatchObject({
      tool: "literature-search",
      callID: "c1",
      state: { status: "completed", output: "12 papers", input: { query: "OpenAlex" }, time: { start: 1, end: 2 } },
    });
    // The turn is over — the reconcile signal.
    expect(messages[2].completed).toBe(4);
    await expect(client.abortSession(sessionId)).resolves.toBeUndefined();
    expect(server.requests).toContain("POST /api/session/ses_mock/interrupt");
    client.close();
  });

  it("surfaces a failing model call: retry, session error, and the history error", async () => {
    const events: OpenCodeEvent[] = [];
    const client = new OpenCodeClient({ baseUrl: base() });
    client.onEvent((e) => events.push(e));
    await client.connect();
    const sessionId = await client.createSession();
    await client.sendPrompt(sessionId, "flaky provider call");
    await waitFor(() => events.some((e) => e.type === "session.idle"));

    const retry = events.find((e) => e.type === "session.retry");
    expect(retry).toMatchObject({ sessionId, attempt: 2, message: "no channel available for this model", nextAt: 1234 });
    expect(retry && "action" in retry ? retry.action : undefined).toBeUndefined();
    expect(events.find((e) => e.type === "error")).toMatchObject({ sessionId, message: "no channel available for this model" });

    // A reload after the live error was missed must still explain the failure.
    const last = (await client.getMessages(sessionId)).slice(-1)[0]!;
    expect(last.role).toBe("assistant");
    expect(last.error).toBe("no channel available for this model");
    client.close();
  });

  it("carries the account-state action a retry status names, not just its message", async () => {
    // Without the action, "the free allowance is spent" and "the provider
    // hiccuped" are the same event to the app (#117).
    const events: OpenCodeEvent[] = [];
    const client = new OpenCodeClient({ baseUrl: base() });
    client.onEvent((e) => events.push(e));
    await client.connect();
    const sessionId = await client.createSession();
    await client.sendPrompt(sessionId, "a turn that is out of quota");
    await waitFor(() => events.some((e) => e.type === "session.idle"));
    expect(events.find((e) => e.type === "session.retry")).toMatchObject({
      sessionId,
      message: "Free usage exceeded, subscribe to Go",
      action: { reason: "free_tier_limit", provider: "opencode", link: "https://opencode.ai/go" },
    });
    client.close();
  });

  it("reports an error status when the server is unreachable", async () => {
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:1" });
    await expect(client.connect()).rejects.toBeTruthy();
    expect(client.getStatus()).toBe("error");
  });

  it("signs a provider in and out through its integration", async () => {
    const client = new OpenCodeClient({ baseUrl: base() });
    server.requests.length = 0;
    await client.setProviderApiKey("mock", "sk-123");
    expect(server.requests).toEqual(["POST /api/integration/mock/connect/key"]);
    expect(server.bodies.slice(-1)[0]?.body).toEqual({ key: "sk-123" });

    server.requests.length = 0;
    await client.removeProviderAuth("mock");
    expect(server.requests).toEqual(["GET /api/credential", "DELETE /api/credential/cred_mock"]);
  });

  it("lists the provider catalog and each provider's sign-in methods", async () => {
    const client = new OpenCodeClient({ baseUrl: base() });
    const catalog = await client.listProviderCatalog();
    expect(catalog.connected).toEqual(["mock"]);
    expect(catalog.all.find((p) => p.id === "anthropic")).toEqual({ id: "anthropic", name: "Anthropic", env: ["ANTHROPIC_API_KEY"] });
    const methods = await client.listAuthMethods();
    expect(methods.anthropic).toEqual([
      { type: "oauth", label: "Claude Pro/Max" },
      { type: "api", label: "API key" },
    ]);
  });

  it("runs a browser login to completion", async () => {
    const client = new OpenCodeClient({ baseUrl: base() });
    const auth = await client.oauthAuthorize("anthropic", 0);
    expect(auth).toEqual({ url: "https://login.example/authorize", method: "auto", instructions: "" });
    expect(server.bodies.slice(-1)[0]?.body).toEqual({ methodID: "claude" });
    await expect(client.oauthCallback("anthropic", 0)).resolves.toBeUndefined();
  });

  it("cancels a pending browser-login wait via the AbortSignal", async () => {
    const client = new OpenCodeClient({ baseUrl: base() });
    await client.oauthAuthorize("slow", 0);
    const abort = new AbortController();
    const pending = client.oauthCallback("slow", 0, undefined, abort.signal);
    await waitFor(() => server.requests.some((r) => r.startsWith("GET /api/integration/slow/connect/oauth/")));
    abort.abort();
    await expect(pending).rejects.toThrow();
  });

  it("surfaces the server's diagnostic message when saving a key fails", async () => {
    const client = new OpenCodeClient({ baseUrl: base() });
    await expect(client.setProviderApiKey("bad", "nope")).rejects.toThrow(/invalid key format/);
  });

  it("sends Basic auth on API calls when a password is set", async () => {
    const seen: (string | undefined)[] = [];
    const capturing: typeof fetch = (input, init) => {
      seen.push((init?.headers as Record<string, string> | undefined)?.["Authorization"]);
      return fetch(input, init);
    };
    const client = new OpenCodeClient({ baseUrl: base(), password: "pw-secret", fetchImpl: capturing });
    await client.createSession();
    expect(seen[0]).toBe("Basic " + Buffer.from("opencode:pw-secret").toString("base64"));
  });

  it("creates a session in this client's folder, with the title it is given", async () => {
    const { fetchImpl, calls } = stubbed({ "POST /api/session": { data: { id: "ses_dedicated" } } });
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:1", fetchImpl, directory: "/work/p" });
    await expect(client.createSession("Result review")).resolves.toBe("ses_dedicated");
    expect(calls[0].body).toEqual({ title: "Result review", location: { directory: "/work/p" } });
    const bare = stubbed({ "POST /api/session": { data: { id: "ses_x" } } });
    await new OpenCodeClient({ baseUrl: "http://127.0.0.1:1", fetchImpl: bare.fetchImpl }).createSession();
    expect(bare.calls[0].body).toEqual({});
  });

  it("keeps the EventSource stream when a password is set, authenticating via auth_token", async () => {
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
      const client = new OpenCodeClient({ baseUrl: base(), password: "pw-secret", directory: "/ws/dir" });
      await client.connect();
      expect(client.getStatus()).toBe("ready");
      const token = Buffer.from("opencode:pw-secret").toString("base64");
      expect(urls[0]).toBe(`${base()}/api/event?auth_token=${encodeURIComponent(token)}`);
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
      const client = new OpenCodeClient({ baseUrl: base(), connectTimeoutMs: 10 });
      await expect(client.connect()).rejects.toThrow("Timed out opening OpenCode event stream");
      expect(client.getStatus()).toBe("error");
    } finally {
      delete (globalThis as { EventSource?: unknown }).EventSource;
    }
  });

  const hangingFetch = ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })) as typeof fetch;

  it("times out a hanging session creation request", async () => {
    const client = new OpenCodeClient({ baseUrl: base(), fetchImpl: hangingFetch, requestTimeoutMs: 10 });
    await expect(client.createSession()).rejects.toThrow("Timed out waiting for OpenCode");
  });

  it("times out a hanging history request", async () => {
    const client = new OpenCodeClient({ baseUrl: base(), fetchImpl: hangingFetch, requestTimeoutMs: 10 });
    await expect(client.getMessages("ses_hung")).rejects.toThrow("Timed out waiting for OpenCode");
  });
});

// The numbers exist only on each step's end and in history, so a client that
// narrows them away leaves the app unable to say how full the context is.
describe("token usage", () => {
  it("surfaces each step's totals as message.usage", async () => {
    const events: OpenCodeEvent[] = [];
    const client = new OpenCodeClient({ baseUrl: base() });
    client.onEvent((e) => events.push(e));
    await client.connect();
    const sessionId = await client.createSession();
    await client.sendPrompt(sessionId, "run a literature review");
    await waitFor(() => events.some((e) => e.type === "session.idle"));

    const usage = events.filter((e): e is Extract<OpenCodeEvent, { type: "message.usage" }> => e.type === "message.usage");
    expect(usage.map((u) => u.messageID)).toEqual(["m1", "m2"]);
    expect(usage[1]).toMatchObject({
      created: 3,
      usage: { input: 3000, output: 900, reasoning: 0, cacheRead: 118000, cacheWrite: 2100, cost: 0.42 },
    });
    expect(usage[1].completed).toBeTypeOf("number");
    client.close();
  });

  it("ties streamed text to its message", async () => {
    const events: OpenCodeEvent[] = [];
    const client = new OpenCodeClient({ baseUrl: base() });
    client.onEvent((e) => events.push(e));
    await client.connect();
    const sessionId = await client.createSession();
    await client.sendPrompt(sessionId, "run a literature review");
    await waitFor(() => events.some((e) => e.type === "session.idle"));
    const text = events.filter((e): e is Extract<OpenCodeEvent, { type: "text.updated" }> => e.type === "text.updated");
    expect(text.every((e) => e.messageID === "m1" || e.messageID === "m2")).toBe(true);
    client.close();
  });

  it("recovers the same usage from history", async () => {
    const events: OpenCodeEvent[] = [];
    const client = new OpenCodeClient({ baseUrl: base() });
    client.onEvent((e) => events.push(e));
    await client.connect();
    const sessionId = await client.createSession();
    await client.sendPrompt(sessionId, "run a literature review");
    await waitFor(() => events.some((e) => e.type === "session.idle"));
    const msgs = await client.getMessages(sessionId);
    expect(msgs.slice(-1)[0]?.usage).toEqual({ input: 3000, output: 900, reasoning: 0, cacheRead: 118000, cacheWrite: 2100, cost: 0.42 });
    // A user message has no tokens at all — not a zeroed-out object.
    expect(msgs.find((m) => m.role === "user")?.usage).toBeUndefined();
    client.close();
  });
});

describe("compaction", () => {
  it("emits session.compacted live and reads back as the marker the thread draws", async () => {
    const events: OpenCodeEvent[] = [];
    const client = new OpenCodeClient({ baseUrl: base() });
    client.onEvent((e) => events.push(e));
    await client.connect();
    const sessionId = await client.createSession();
    await client.sendPrompt(sessionId, "compact the context");
    await waitFor(() => events.some((e) => e.type === "session.idle"));
    expect(events.filter((e) => e.type === "session.compacted")).toEqual([
      { type: "session.compacted", sessionId: "ses_mock", auto: true },
    ]);
    const history = await client.getMessages(sessionId);
    expect(history[0]).toMatchObject({ role: "user", parts: [{ type: "compaction", auto: true }] });
    client.close();
  });

  it("compacts with the session's own model, binding one first when given", async () => {
    const { fetchImpl, calls } = stubbed({
      "POST /api/session/ses_1/model": { data: {} },
      "POST /api/session/ses_1/compact": { data: {} },
    });
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:1", fetchImpl });
    await client.compactSession("ses_1", "openrouter", "qwen/qwen3-coder");
    expect(calls.map((c) => c.request)).toEqual(["POST /api/session/ses_1/model", "POST /api/session/ses_1/compact"]);
    // Split on the FIRST slash: a model id may contain more of them.
    expect(calls[0].body).toEqual({ model: { providerID: "openrouter", id: "qwen/qwen3-coder" } });
    await client.compactSession("ses_1");
    expect(calls.slice(-1)[0]?.request).toBe("POST /api/session/ses_1/compact");
  });
});

describe("binding a session's agent and model (#8: old sessions follow the current default)", () => {
  it("binds them on the session before the prompt, once, and only when given", async () => {
    const client = new OpenCodeClient({ baseUrl: base() });
    await client.connect();
    const sessionId = await client.createSession();
    server.requests.length = 0;

    await client.sendPrompt(sessionId, "plan the analysis", "plan", "anthropic/claude-opus-4-8", "high");
    await client.sendPrompt(sessionId, "again", "plan", "anthropic/claude-opus-4-8", "high");
    await client.sendPrompt(sessionId, "no pins");
    await client.sendPrompt(sessionId, "bad model", undefined, "malformed-no-slash");

    expect(server.requests.filter((r) => !r.startsWith("GET"))).toEqual([
      "POST /api/session/ses_mock/agent",
      "POST /api/session/ses_mock/model",
      "POST /api/session/ses_mock/prompt",
      "POST /api/session/ses_mock/prompt",
      "POST /api/session/ses_mock/prompt",
      "POST /api/session/ses_mock/prompt",
    ]);
    const sent = (r: string) => server.bodies.find((b) => b.request === r)?.body;
    expect(sent("POST /api/session/ses_mock/agent")).toEqual({ agent: "plan" });
    expect(sent("POST /api/session/ses_mock/model")).toEqual({
      model: { providerID: "anthropic", id: "claude-opus-4-8", variant: "high" },
    });
    expect(server.promptBodies[0]).toEqual({ text: "plan the analysis" });
    client.close();
  });
});

describe("image attachments (#88: a vision model must see the figure, not its name)", () => {
  it("sends each attachment inline beside the text, and none when there are none", async () => {
    const client = new OpenCodeClient({ baseUrl: base() });
    await client.connect();
    const sessionId = await client.createSession();
    await client.sendPrompt(sessionId, "inspect this figure", undefined, null, null, [
      { filename: "pasted.png", mime: "image/png", url: "data:image/png;base64,UE5H" },
    ]);
    await client.sendPrompt(sessionId, "no attachment");
    expect(server.promptBodies).toEqual([
      {
        text: "inspect this figure",
        // A data: URL, carried inline — never a file:// the runtime may not reach.
        files: [{ uri: "data:image/png;base64,UE5H", name: "pasted.png", source: { type: "inline" } }],
      },
      { text: "no attachment" },
    ]);
    client.close();
  });
});

describe("config (default model, custom providers, regions)", () => {
  it("reads and writes the default model in the config file", async () => {
    const { store, state } = memoryConfig({ model: "mock/a" });
    const client = new OpenCodeClient({ baseUrl: base(), config: store });
    expect(await client.getDefaultModel()).toBe("mock/a");
    await client.setDefaultModel("mock/b");
    expect(state.model).toBe("mock/b");
  });

  it("falls back to the runtime's default when no config store is given", async () => {
    const client = new OpenCodeClient({ baseUrl: base() });
    expect(await client.getDefaultModel()).toBe("mock/mock-model");
    await expect(client.setDefaultModel("mock/b")).rejects.toThrow(/not writable here/);
  });

  it("reads and writes a provider region", async () => {
    const { store, patches } = memoryConfig({
      provider: { "amazon-bedrock": { options: { region: "eu-west-1", profile: "research" } } },
    });
    const client = new OpenCodeClient({ baseUrl: base(), config: store });
    await expect(client.getProviderRegion("amazon-bedrock")).resolves.toBe("eu-west-1");
    await expect(client.getProviderRegion("openai")).resolves.toBeNull();
    await client.setProviderRegion("amazon-bedrock", "ap-northeast-1");
    expect(patches).toEqual([{ provider: { "amazon-bedrock": { options: { region: "ap-northeast-1" } } } }]);
  });

  it("joins MCP servers' live status with their config", async () => {
    const { store } = memoryConfig({ mcp: { jupyter: { type: "local", command: ["jupyter-mcp"] }, off: { type: "remote", url: "https://x" } } });
    const client = new OpenCodeClient({ baseUrl: base(), config: store });
    expect(await client.listMcpServers()).toEqual([
      { name: "jupyter", status: "connected", config: { type: "local", command: ["jupyter-mcp"] } },
      { name: "off", status: "pending", config: { type: "remote", url: "https://x" } },
    ]);
  });

  it("surfaces the host's refusal reason when a write is not allowed", async () => {
    // #119: from the web client the gateway refuses config writes, and says why.
    const store: ConfigStore = {
      read: async () => ({}),
      patch: async () => {
        throw new Error("provider/model config is managed on the desktop");
      },
    };
    const client = new OpenCodeClient({ baseUrl: base(), config: store });
    await expect(
      client.addCustomProvider("custom", { name: "Custom", npm: "@ai-sdk/openai-compatible", baseURL: "https://x/v1", models: ["sol"] }),
    ).rejects.toThrow("provider/model config is managed on the desktop");
  });
});

describe("custom-model context limits (#52: never pin a guessed window)", () => {
  const add = (client: OpenCodeClient, models: Parameters<OpenCodeClient["addCustomProvider"]>[1]["models"], contexts?: Record<string, number>) =>
    client.addCustomProvider("custom", {
      name: "Custom",
      npm: "@ai-sdk/openai-compatible",
      baseURL: "https://example.test/v1",
      models,
      ...(contexts ? { contexts } : {}),
    });
  const lastModels = (patches: Record<string, unknown>[]) =>
    (patches.slice(-1)[0]!.provider as Record<string, { models: Record<string, unknown> }>).custom.models;

  it("writes no context limit when the model window is unknown", async () => {
    const { store, patches } = memoryConfig();
    await add(new OpenCodeClient({ baseUrl: base(), config: store }), ["sol"]);
    expect(lastModels(patches).sol).toEqual({ name: "sol" });
  });

  it("pins a probed/typed context window exactly", async () => {
    const { store, patches } = memoryConfig();
    await add(new OpenCodeClient({ baseUrl: base(), config: store }), ["sol"], { sol: 1_500_000 });
    expect(lastModels(patches).sol).toEqual({ name: "sol", limit: { context: 1_500_000, output: 0 } });
  });

  it("carries a described model's own metadata, and invents nothing for a bare id", async () => {
    const { store, patches } = memoryConfig();
    await add(new OpenCodeClient({ baseUrl: base(), config: store }), [
      { id: "big", context: 200_000, reasoning: true, modalities: { input: ["text", "image"] }, variants: { fast: { thinking: { type: "disabled" } } } },
      "small",
    ]);
    const models = lastModels(patches);
    expect(models.big).toMatchObject({
      name: "big",
      limit: { context: 200_000, output: 0 },
      reasoning: true,
      modalities: { input: ["text", "image"] },
      variants: { fast: { thinking: { type: "disabled" } } },
    });
    expect(models.small).toEqual({ name: "small" });
    expect(models.big).not.toHaveProperty("cost");
  });

  it("keeps what is already configured for a model it is re-saving", async () => {
    const { store, patches } = memoryConfig({
      provider: { custom: { models: { big: { name: "big", limit: { context: 200_000, output: 0 }, cost: { input: 1, output: 2 } } } } },
    });
    await add(new OpenCodeClient({ baseUrl: base(), config: store }), ["big"]);
    expect(lastModels(patches).big).toMatchObject({ limit: { context: 200_000, output: 0 }, cost: { input: 1, output: 2 } });
  });

  it("resets the blind 128k default to 0, leaves real limits alone, and is idempotent", async () => {
    const { store, patches, state } = memoryConfig({
      provider: {
        custom: {
          name: "Custom",
          models: {
            sol: { name: "sol", limit: { context: 128_000, output: 0 } },
            local: { name: "local", limit: { context: 131_072, output: 0 } },
            bare: { name: "bare" },
          },
        },
      },
    });
    const client = new OpenCodeClient({ baseUrl: base(), config: store });
    await client.clearDefaultCustomModelContextLimits();
    const models = (state.provider as Record<string, { models: Record<string, { limit?: unknown }> }>).custom.models;
    expect(models.sol.limit).toEqual({ context: 0, output: 0 });
    expect(models.local.limit).toEqual({ context: 131_072, output: 0 });
    expect(models.bare.limit).toBeUndefined();
    expect(patches).toHaveLength(1);
    await client.clearDefaultCustomModelContextLimits();
    expect(patches).toHaveLength(1);
    expect(await client.listCustomProviderIds()).toEqual(["custom"]);
  });
});
