// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MINIMAX_CUSTOM_PROVIDER_PRESETS,
  OpenCodeClient,
  type OpenCodeEvent,
} from "@ai4s/sdk";
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

    // The server-side retry loop is unbounded — its status events are the only
    // sign of life while every attempt fails, so they must reach the app.
    expect(events.find((e) => e.type === "session.retry")).toMatchObject({
      sessionId,
      attempt: 2,
      message: "no channel available for this model",
    });
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

  it("serializes the curated MiniMax model metadata", async () => {
    const { fetchImpl, patches } = mockGlobalConfig();
    const preset = MINIMAX_CUSTOM_PROVIDER_PRESETS.find((p) => p.id === "minimax-global-anthropic")!;
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:1", fetchImpl });

    await client.addCustomProvider(preset.providerId, {
      name: preset.name,
      npm: preset.npm,
      baseURL: preset.baseURL,
      models: preset.models,
    });

    const models = patches[patches.length - 1].provider.minimax.models!;
    expect(models["MiniMax-M3"]).toMatchObject({
      name: "MiniMax-M3",
      limit: { context: 1_000_000, output: 0 },
      cost: { input: 0.6, output: 2.4, cache_read: 0.12 },
      modalities: { input: ["text", "image", "video"] },
      reasoning: true,
      variants: {
        adaptive: { thinking: { type: "adaptive" } },
        disabled: { thinking: { type: "disabled" } },
      },
    });
    expect(models["MiniMax-M2.7"]).toMatchObject({
      name: "MiniMax-M2.7",
      limit: { context: 204_800, output: 0 },
      cost: { input: 0.3, output: 1.2, cache_read: 0.06, cache_write: 0.375 },
      modalities: { input: ["text"] },
      reasoning: true,
    });
    expect(models["MiniMax-M2.7"]).not.toHaveProperty("variants");
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
