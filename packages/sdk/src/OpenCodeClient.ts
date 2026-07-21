import type {
  AgentInfo,
  CommandInfo,
  HistoryMessage,
  McpConfig,
  McpServer,
  OAuthAuthorization,
  OpenCodeClientOptions,
  PermissionReply,
  ProviderAuthMethod,
  ProviderCatalogEntry,
  ProviderInfo,
  QuestionAskedEvent,
  PermissionAskedEvent,
  SessionMeta,
  SkillInfo,
} from "./types";
import { DEFAULT_OPENCODE_URL } from "./types";
import type { AgentRuntime } from "./runtime";
import { BaseAgentRuntime } from "./base-runtime";
import type { WorkspaceOps, DirEntry, ArtifactFile } from "./workspace";
import { OpenCodeHttpEngine, type OpenCodeHttpTransport } from "./engines/opencode-http";

/**
 * The single boundary between the app and the OpenCode agent runtime. Talks to
 * a running `opencode serve` over its HTTP + SSE API. The UI must go through
 * this class, never the transport directly (see AGENTS.md guardrails).
 *
 * As of the runtime-evolution refactor, this class is a **façade**: it owns NO
 * transport state of its own. The constructor builds an {@link OpenCodeHttpEngine}
 * parameterized by the host's transport (baseUrl/directory/password) plus the
 * runtime-level knobs (fetch/timeout/username), and every {@link AgentRuntime}
 * method forwards to that engine — including the listener plumbing
 * (getStatus/onStatus/onEvent), so store-level subscriptions land on the engine
 * where emits actually happen.
 *
 * Two method families STAY on the façade, by design (they are OUTSIDE the
 * runtime-agnostic `AgentRuntime` contract — see docs/rfc/agent-runtime.md):
 *  - OpenCode-specific configuration: providers, MCP servers, OAuth. These borrow
 *    the engine's HTTP helpers (`engine.headers`, `engine.fetch`,
 *    `engine.apiError`, `engine.dirQuery`, `engine.disposeInstance`) so there is
 *    ONE auth/timeout policy — the façade holds no fetch/auth state of its own.
 *  - {@link WorkspaceOps}: `listDir`/`readFile`/`writeFile`/`deleteFile`. The
 *    desktop host owns the filesystem, so these forward to the Tauri commands
 *    and are unrelated to the engine.
 */
export class OpenCodeClient extends BaseAgentRuntime implements AgentRuntime, WorkspaceOps {
  private readonly engine: OpenCodeHttpEngine;
  /** The transport spec the engine was built from. Kept on the façade so a
   *  future runtime registry (Step 3) can introspect how to (re)build it. */
  private readonly transport: OpenCodeHttpTransport;

  constructor(opts: OpenCodeClientOptions = {}) {
    super();
    this.transport = {
      kind: "opencode-http",
      baseUrl: (opts.baseUrl ?? DEFAULT_OPENCODE_URL).replace(/\/$/, ""),
      directory: opts.directory,
      password: opts.password,
    };
    this.engine = new OpenCodeHttpEngine(this.transport, {
      fetchImpl: opts.fetchImpl,
      connectTimeoutMs: opts.connectTimeoutMs,
      requestTimeoutMs: opts.requestTimeoutMs,
      username: opts.username,
    });
  }

  // ---- listener plumbing (forward to the engine) ----
  // The store registers `client.onStatus(...)` / `client.onEvent(...)`; the
  // engine is where status transitions and event emits actually happen. Forward
  // registration so subscriptions land on the right object. (The façade still
  // extends BaseAgentRuntime, so it COULD hold listeners of its own — but nobody
  // ever emits to the façade, hence the forward.)
  getStatus() {
    return this.engine.getStatus();
  }
  onStatus(listener: (status: import("./types").RuntimeStatus) => void): () => void {
    return this.engine.onStatus(listener);
  }
  onEvent(listener: (event: import("./types").OpenCodeEvent) => void): () => void {
    return this.engine.onEvent(listener);
  }

  // ---- lifecycle (forward) ----
  connect(): Promise<void> {
    return this.engine.connect();
  }
  close(): void {
    return this.engine.close();
  }

  // ---- sessions (forward) ----
  createSession(): Promise<string> {
    return this.engine.createSession();
  }
  listSessions(): Promise<SessionMeta[]> {
    return this.engine.listSessions();
  }
  deleteSession(sessionId: string): Promise<void> {
    return this.engine.deleteSession(sessionId);
  }
  getMessages(sessionId: string): Promise<HistoryMessage[]> {
    return this.engine.getMessages(sessionId);
  }
  sendPrompt(sessionId: string, text: string, agent?: string, model?: string | null): Promise<void> {
    return this.engine.sendPrompt(sessionId, text, agent, model);
  }
  abortSession(sessionId: string): Promise<void> {
    return this.engine.abortSession(sessionId);
  }
  revert(sessionId: string, messageID: string, partID?: string): Promise<void> {
    return this.engine.revert(sessionId, messageID, partID);
  }
  unrevert(sessionId: string): Promise<void> {
    return this.engine.unrevert(sessionId);
  }

  // ---- capability discovery (forward) ----
  listSkills(): Promise<SkillInfo[]> {
    return this.engine.listSkills();
  }
  listAgents(): Promise<AgentInfo[]> {
    return this.engine.listAgents();
  }
  listCommands(): Promise<CommandInfo[]> {
    return this.engine.listCommands();
  }

  // ---- model selection (forward) ----
  getDefaultModel(): Promise<string | null> {
    return this.engine.getDefaultModel();
  }
  setDefaultModel(model: string): Promise<void> {
    return this.engine.setDefaultModel(model);
  }

  // ---- agent-driven execution (forward) ----
  runShell(sessionId: string, command: string, agent?: string): Promise<void> {
    return this.engine.runShell(sessionId, command, agent);
  }
  runCommand(sessionId: string, command: string, args?: string): Promise<void> {
    return this.engine.runCommand(sessionId, command, args);
  }

  // ---- interactive requests (forward) ----
  listQuestions(sessionId?: string): Promise<QuestionAskedEvent[]> {
    return this.engine.listQuestions(sessionId);
  }
  listPermissions(sessionId?: string): Promise<PermissionAskedEvent[]> {
    return this.engine.listPermissions(sessionId);
  }
  answerQuestion(requestId: string, answers: string[][]): Promise<void> {
    return this.engine.answerQuestion(requestId, answers);
  }
  rejectQuestion(requestId: string): Promise<void> {
    return this.engine.rejectQuestion(requestId);
  }
  replyPermission(requestId: string, reply: PermissionReply): Promise<void> {
    return this.engine.replyPermission(requestId, reply);
  }

  // ---- OpenCode-specific configuration (NOT on the AgentRuntime interface) ----
  // These stay on the façade — they are configuration of a specific runtime
  // (OpenCode), not "an agent runtime" in general. They reuse the engine's
  // HTTP helpers so there is one auth/timeout/fetch policy. The engine's
  // `fetch` is the un-tightened fetch (per-call abort possible, e.g. OAuth).

  /** Providers OpenCode can use right now, with their models. */
  async listProviders(): Promise<ProviderInfo[]> {
    const e = this.engine;
    const res = await e.fetch(`${e.baseUrl()}/config/providers`, {
      headers: e.headers(),
    });
    if (!res.ok) throw await e.apiError(res, "Failed to list providers");
    const body = (await res.json()) as {
      providers?: Array<{ id: string; name?: string; models?: Record<string, { name?: string }> }>;
    };
    return (body.providers ?? []).map((p) => ({
      id: p.id,
      name: p.name ?? p.id,
      models: Object.entries(p.models ?? {}).map(([id, m]) => ({ id, name: m.name ?? id })),
    }));
  }

  /**
   * Register a custom endpoint (self-hosted / OpenAI-compatible / Anthropic-
   * compatible / local Ollama) in OpenCode's global config. Applies live.
   */
  async addCustomProvider(
    id: string,
    opts: { name: string; npm: string; baseURL: string; apiKey?: string; models: string[] },
  ): Promise<void> {
    const e = this.engine;
    const models = Object.fromEntries(opts.models.map((m) => [m, { name: m }]));
    const provider = {
      [id]: {
        name: opts.name,
        npm: opts.npm,
        options: { baseURL: opts.baseURL, ...(opts.apiKey ? { apiKey: opts.apiKey } : {}) },
        models,
      },
    };
    const res = await e.fetch(`${e.baseUrl()}/global/config`, {
      method: "PATCH",
      headers: e.headers(true),
      body: JSON.stringify({ provider }),
    });
    if (!res.ok) throw await e.apiError(res, "Failed to add the provider");
  }

  /** Ids of custom providers defined in the global config (removable via the app). */
  async listCustomProviderIds(): Promise<string[]> {
    const e = this.engine;
    const res = await e.fetch(`${e.baseUrl()}/global/config`, { headers: e.headers() });
    if (!res.ok) return [];
    const cfg = (await res.json()) as { provider?: Record<string, unknown> };
    return Object.keys(cfg.provider ?? {});
  }

  /** Configured MCP servers with live status, joined with their config. */
  async listMcpServers(): Promise<McpServer[]> {
    const e = this.engine;
    const [statusRes, cfgRes] = await Promise.all([
      e.fetch(`${e.baseUrl()}/mcp`, { headers: e.headers() }),
      e.fetch(`${e.baseUrl()}/global/config`, { headers: e.headers() }),
    ]);
    if (!statusRes.ok) throw await e.apiError(statusRes, "Failed to list MCP servers");
    const status = (await statusRes.json()) as Record<string, { status?: string }>;
    const cfg = cfgRes.ok
      ? ((await cfgRes.json()) as { mcp?: Record<string, McpConfig> })
      : { mcp: {} };
    const names = new Set([...Object.keys(status), ...Object.keys(cfg.mcp ?? {})]);
    return [...names].sort().map((name) => ({
      name,
      status: status[name]?.status ?? "pending",
      config: cfg.mcp?.[name],
    }));
  }

  /** Add (or update) an MCP server in the global config. Applies live. */
  async addMcpServer(name: string, config: McpConfig): Promise<void> {
    const e = this.engine;
    const res = await e.fetch(`${e.baseUrl()}/global/config`, {
      method: "PATCH",
      headers: e.headers(true),
      body: JSON.stringify({ mcp: { [name]: config } }),
    });
    if (!res.ok) throw await e.apiError(res, "Failed to add the MCP server");
  }

  /** The full provider catalog (~150 entries) and which ids are connected. */
  async listProviderCatalog(): Promise<{ all: ProviderCatalogEntry[]; connected: string[] }> {
    const e = this.engine;
    const res = await e.fetch(`${e.baseUrl()}/provider`, { headers: e.headers() });
    if (!res.ok) throw await e.apiError(res, "Failed to list the provider catalog");
    const body = (await res.json()) as {
      all?: Array<{ id: string; name?: string; env?: string[] }>;
      connected?: string[];
    };
    return {
      all: (body.all ?? []).map((p) => ({ id: p.id, name: p.name ?? p.id, env: p.env ?? [] })),
      connected: body.connected ?? [],
    };
  }

  /** Every provider OpenCode knows how to connect, with its auth methods. */
  async listAuthMethods(): Promise<Record<string, ProviderAuthMethod[]>> {
    const e = this.engine;
    const res = await e.fetch(`${e.baseUrl()}/provider/auth`, { headers: e.headers() });
    if (!res.ok) throw await e.apiError(res, "Failed to list auth methods");
    return (await res.json()) as Record<string, ProviderAuthMethod[]>;
  }

  /** Store an API key for a provider. */
  async setProviderApiKey(providerID: string, key: string): Promise<void> {
    const e = this.engine;
    const res = await e.fetch(`${e.baseUrl()}/auth/${encodeURIComponent(providerID)}`, {
      method: "PUT",
      headers: e.headers(true),
      body: JSON.stringify({ type: "api", key }),
    });
    if (!res.ok) throw await e.apiError(res, "Failed to save the key");
    await e.disposeInstance();
  }

  /** Remove a provider's stored credentials. */
  async removeProviderAuth(providerID: string): Promise<void> {
    const e = this.engine;
    const res = await e.fetch(`${e.baseUrl()}/auth/${encodeURIComponent(providerID)}`, {
      method: "DELETE",
      headers: e.headers(),
    });
    if (!res.ok) throw await e.apiError(res, "Failed to disconnect");
    await e.disposeInstance();
  }

  /** Start an OAuth login; returns the URL to open and how it completes. */
  async oauthAuthorize(
    providerID: string,
    method: number,
    inputs?: Record<string, string>,
  ): Promise<OAuthAuthorization> {
    const e = this.engine;
    const res = await e.fetch(
      `${e.baseUrl()}/provider/${encodeURIComponent(providerID)}/oauth/authorize`,
      { method: "POST", headers: e.headers(true), body: JSON.stringify({ method, inputs }) },
    );
    if (!res.ok) throw await e.apiError(res, "Failed to start the login");
    return (await res.json()) as OAuthAuthorization;
  }

  /** Complete an OAuth login (pass the pasted code for "code" flows). For
   *  "auto" flows this call WAITS until the browser redirect finishes — pass
   *  a `signal` so a cancelled login doesn't leak the pending request. */
  async oauthCallback(
    providerID: string,
    method: number,
    code?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const e = this.engine;
    const res = await e.fetch(
      `${e.baseUrl()}/provider/${encodeURIComponent(providerID)}/oauth/callback`,
      {
        method: "POST",
        headers: e.headers(true),
        body: JSON.stringify({ method, code }),
        signal,
      },
    );
    if (!res.ok) throw await e.apiError(res, "Login did not complete");
    await e.disposeInstance();
  }

  /** Drop the server's cached provider list so a credential stored outside
   *  this client's own auth calls (e.g. a browser login whose callback never
   *  reached us) shows up in listProviders. */
  async refreshProviderCache(): Promise<void> {
    await this.engine.disposeInstance();
  }

  // ---- WorkspaceOps (RFC runtime-evolution.md §4) ----
  // The desktop host owns the filesystem, so OpenCodeClient exposes file ops
  // by forwarding to the existing Tauri commands. No Rust changes. A remote
  // runtime would implement these over its own transport.
  async listDir(relPath: string): Promise<DirEntry[]> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<DirEntry[]>("list_dir", { rel: relPath, root: "workspace" });
  }

  async readFile(relPath: string): Promise<{ text: string } | { artifact: ArtifactFile }> {
    const { invoke } = await import("@tauri-apps/api/core");
    const a = await invoke<ArtifactFile>("read_artifact", { path: relPath, root: "workspace" });
    return a.encoding === "utf8" ? { text: a.data } : { artifact: a };
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    // TODO(binary): requires extending write_workspace_file Rust command to
    // accept bytes. Text-only for now (covers notebook autosave, provenance
    // writes, generated reports — the common case).
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("write_workspace_file", { path: relPath, content, root: "workspace" });
  }

  async deleteFile(relPath: string): Promise<void> {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("delete_workspace_file", { path: relPath, root: "workspace" });
  }
}
