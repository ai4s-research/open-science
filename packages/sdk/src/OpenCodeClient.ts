import type {
  AgentInfo,
  CommandInfo,
  HistoryMessage,
  McpConfig,
  McpServer,
  OAuthAuthorization,
  OpenCodeClientOptions,
  OpenCodeEvent,
  OpenCodePart,
  OpenCodeRawEvent,
  PermissionReply,
  ProviderAuthMethod,
  ProviderCatalogEntry,
  ProviderInfo,
  QuestionAskedEvent,
  PermissionAskedEvent,
  RuntimeStatus,
  SessionMeta,
  SkillInfo,
  ToolCallStatus,
} from "./types";
import { DEFAULT_OPENCODE_URL } from "./types";

type EventListener = (event: OpenCodeEvent) => void;
type StatusListener = (status: RuntimeStatus) => void;

function mapToolStatus(status: string): ToolCallStatus {
  switch (status) {
    case "running":
      return "running";
    case "completed":
      return "success";
    case "error":
      return "failed";
    default:
      return "pending";
  }
}

/**
 * The single boundary between the app and the OpenCode agent runtime.
 * Talks to a running `opencode serve` over its HTTP + SSE API. The UI must go
 * through this class, never the transport directly (see AGENTS.md guardrails).
 */
export class OpenCodeClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly authHeader: string | null;
  /** Base64 `user:password` for `?auth_token=` — the EventSource cannot set
   *  headers, and the server accepts the same Basic payload as a query param. */
  private readonly authToken: string | null;
  /** Workspace folder this client is scoped to. OpenCode serves many folders
   *  from ONE process (per-directory instances): the event stream, session
   *  creation and the directory-scoped lookups all carry `?directory=`, so
   *  switching folders is a reconnect — never a sidecar restart. Session-scoped
   *  calls (`/session/:id/…`) need no directory: the server routes them by the
   *  session's own recorded folder (verified live: `pwd` runs in it). */
  private readonly directory: string | null;
  private status: RuntimeStatus = "offline";
  private abort: AbortController | null = null;
  private es: EventSource | null = null;
  /** Pending self-heal of a dead event stream (see reconnectSoon). */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** True between close() and the next connect() — stops self-healing. */
  private closed = false;
  private readonly customFetch: boolean;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly eventListeners = new Set<EventListener>();
  private readonly statusListeners = new Set<StatusListener>();
  /** messageID → role, learned from message.updated, to skip echoed user parts. */
  private readonly roles = new Map<string, string>();
  /** partID → accumulated text of a streaming text part. OpenCode publishes the
   *  full part only at text-start (empty) and text-end; every token in between
   *  arrives as a message.part.delta that must be summed here — otherwise the
   *  app shows nothing until the whole passage is finished. */
  private readonly textStreams = new Map<string, { sessionId: string; text: string }>();

  constructor(opts: OpenCodeClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_OPENCODE_URL).replace(/\/$/, "");
    this.customFetch = !!opts.fetchImpl;
    // Bind to globalThis — an unbound `fetch` reference throws "Illegal invocation" in browsers.
    this.fetchImpl = (opts.fetchImpl ?? globalThis.fetch).bind(globalThis);
    this.authToken = opts.password ? btoa(`${opts.username ?? "opencode"}:${opts.password}`) : null;
    this.authHeader = this.authToken ? `Basic ${this.authToken}` : null;
    this.directory = opts.directory ?? null;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 5000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15000;
  }

  getStatus(): RuntimeStatus {
    return this.status;
  }
  onEvent(l: EventListener): () => void {
    this.eventListeners.add(l);
    return () => this.eventListeners.delete(l);
  }
  onStatus(l: StatusListener): () => void {
    this.statusListeners.add(l);
    return () => this.statusListeners.delete(l);
  }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h["Content-Type"] = "application/json";
    if (this.authHeader) h["Authorization"] = this.authHeader;
    return h;
  }

  private async fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs = this.requestTimeoutMs): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(input, { ...init, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) throw new Error("Timed out waiting for OpenCode");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Open the SSE event stream. Resolves once the server acknowledges. */
  connect(): Promise<void> {
    this.closed = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.setStatus("connecting");

    // Prefer EventSource in a real webview/browser (reliable SSE, incl. macOS
    // WKWebView) — auth rides along as ?auth_token=, since EventSource cannot
    // set headers. Fall back to streaming fetch for node/tests.
    const canUseEventSource = !this.customFetch && typeof EventSource !== "undefined";
    if (canUseEventSource) {
      return new Promise((resolve, reject) => {
        let opened = false;
        let finished = false;
        const es = new EventSource(this.eventUrl());
        this.es = es;
        const timer = setTimeout(() => {
          if (opened || finished) return;
          finished = true;
          this.setStatus("error");
          es.close();
          if (this.es === es) this.es = null;
          reject(new Error("Timed out opening OpenCode event stream"));
        }, this.connectTimeoutMs);
        es.onopen = () => {
          if (finished) return;
          opened = true;
          finished = true;
          clearTimeout(timer);
          this.setStatus("ready");
          resolve();
        };
        es.onmessage = (ev) => {
          try {
            this.normalize(JSON.parse(ev.data) as OpenCodeRawEvent);
          } catch {
            /* ignore malformed frame */
          }
        };
        es.onerror = () => {
          if (!opened) {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            this.setStatus("error");
            es.close();
            this.es = null;
            reject(new Error("Could not open OpenCode event stream"));
          } else {
            // Take over reconnection ourselves. EventSource's built-in retry
            // never recovers when the server ends the stream terminally —
            // e.g. the global-config PATCH (model switch) rebuilds the
            // instance and closes /event moments AFTER acknowledging, killing
            // even a freshly reopened stream; the app then sat in
            // "connecting" until a manual Connect. Reopen a fresh stream
            // with backoff instead (a deliberate close() cancels it).
            es.close();
            if (this.es === es) {
              this.es = null;
              this.reconnectSoon();
            }
          }
        };
      });
    }

    this.abort = new AbortController();
    return new Promise((resolve, reject) => {
      let opened = false;
      const abort = this.abort!;
      const timer = setTimeout(() => {
        if (!opened) abort.abort(new Error("Timed out opening OpenCode event stream"));
      }, this.connectTimeoutMs);
      this.fetchImpl(this.eventUrl(), {
        headers: { Accept: "text/event-stream", ...this.headers() },
        signal: abort.signal,
      })
        .then(async (res) => {
          clearTimeout(timer);
          if (!res.ok || !res.body) {
            this.setStatus("error");
            reject(new Error(`OpenCode /event returned ${res.status}`));
            return;
          }
          this.setStatus("ready");
          opened = true;
          resolve();
          await this.readStream(res.body);
        })
        .catch((err) => {
          clearTimeout(timer);
          if (!opened) {
            this.setStatus("error");
            reject(err instanceof Error ? err : new Error(String(err)));
          } else {
            this.setStatus("offline");
          }
        });
    });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.es?.close();
    this.es = null;
    this.abort?.abort();
    this.abort = null;
    this.setStatus("offline");
  }

  /** Reopen the event stream after it died post-open, with backoff. The first
   *  retry is quick (a plain blip); later ones stretch to cover the server's
   *  instance-rebuild window after a global-config PATCH. Gives up into
   *  "error" so the banner offers the manual Connect. */
  private reconnectSoon(attempt = 0): void {
    if (this.closed || this.reconnectTimer) return;
    this.setStatus("connecting");
    const delay = attempt === 0 ? 250 : Math.min(1000 * attempt, 3000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      this.connect().catch(() => {
        if (attempt + 1 < 8) this.reconnectSoon(attempt + 1);
        else this.setStatus("error");
      });
    }, delay);
  }

  /** Create a new agent session, returning its id. Scoping is by the sidecar's
   *  working directory (set at spawn), not a query param — passing `?directory=`
   *  here routes the turn to a scope whose events the global stream never sees. */
  async createSession(): Promise<string> {
    // The directory decides where the session lives and works — without it the
    // server would put it in the process's boot folder, not the active one.
    const res = await this.fetchWithTimeout(`${this.baseUrl}/session${this.dirQuery()}`, {
      method: "POST",
      headers: this.headers(true),
      body: "{}",
    });
    if (!res.ok) throw await this.apiError(res, "Failed to create session");
    const json = (await res.json()) as { id: string };
    return json.id;
  }

  /** List existing sessions (conversation history), newest first — across ALL
   *  workspace folders. The plain `/session` list is scoped to the project the
   *  sidecar's cwd resolves to, so history would appear to change when the user
   *  switches folders; `/experimental/session` lists every project's sessions
   *  (each item still carries its `directory`). The OpenCode version is pinned,
   *  so the experimental route is stable for us; fall back to `/session` if a
   *  server ever lacks it. */
  async listSessions(): Promise<SessionMeta[]> {
    let res = await this.fetchWithTimeout(`${this.baseUrl}/experimental/session`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      res = await this.fetchWithTimeout(`${this.baseUrl}/session`, { headers: this.headers() });
    }
    if (!res.ok) throw await this.apiError(res, "Failed to list sessions");
    const arr = (await res.json()) as Array<{
      id: string;
      title?: string;
      slug?: string;
      directory?: string;
      parentID?: string | null;
    }>;
    return arr.map((s) => ({
      id: s.id,
      title: s.title ?? "Untitled",
      slug: s.slug,
      directory: s.directory,
      parentId: s.parentID ?? undefined,
    }));
  }

  /** Delete a session. */
  async deleteSession(sessionId: string): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/session/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!res.ok) throw await this.apiError(res, "Failed to delete session");
  }

  /** Load a session's message history. */
  async getMessages(sessionId: string): Promise<HistoryMessage[]> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/message`,
      { headers: this.headers() },
    );
    if (!res.ok) throw await this.apiError(res, "Failed to load messages");
    const arr = (await res.json()) as Array<{
      info: { role: "user" | "assistant"; time?: { completed?: number } };
      parts: HistoryMessage["parts"];
    }>;
    return arr.map((m) => ({
      role: m.info.role,
      completed: m.info.time?.completed,
      parts: m.parts ?? [],
    }));
  }

  /** Interrupt the session's current turn (POST /session/:id/abort). A no-op
   *  on an idle session — the server just answers false. */
  async abortSession(sessionId: string): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/abort`,
      { method: "POST", headers: this.headers(true), body: "{}" },
    );
    if (!res.ok) throw await this.apiError(res, "Failed to interrupt the session");
  }

  /** Real skills loaded by OpenCode (built-in + bundled + user). */
  async listSkills(): Promise<SkillInfo[]> {
    // Scope to the workspace: skill instances are created lazily per directory,
    // and the unscoped endpoint answers from an instance that may have none.
    const query = this.directory ? `?directory=${encodeURIComponent(this.directory)}` : "";
    const res = await this.fetchImpl(`${this.baseUrl}/api/skill${query}`, {
      headers: this.headers(),
    });
    if (!res.ok) throw await this.apiError(res, "Failed to list skills");
    const body = (await res.json()) as { data?: SkillInfo[] };
    return body.data ?? [];
  }

  /** The configured default model ("provider/model"), or null when unset. */
  async getDefaultModel(): Promise<string | null> {
    // Read the same global config that setDefaultModel PATCHes. The instance-
    // scoped /config only reflects a model change after OpenCode rebuilds the
    // instance (~1s later), so reading it right after a switch returns the
    // previous model.
    const res = await this.fetchImpl(`${this.baseUrl}/global/config`, { headers: this.headers() });
    if (!res.ok) throw await this.apiError(res, "Failed to read config");
    const cfg = (await res.json()) as { model?: string };
    return cfg.model ?? null;
  }

  /** Set the default model in OpenCode's global (app-profile) config. */
  async setDefaultModel(model: string): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/global/config`, {
      method: "PATCH",
      headers: this.headers(true),
      body: JSON.stringify({ model }),
    });
    if (!res.ok) throw await this.apiError(res, "Failed to set model");
    // NOTE: deliberately do NOT disposeInstance() here (unlike auth changes).
    // Disposing tears the instance down asynchronously server-side, landing
    // ~1s AFTER the store's connectRetry has already opened a fresh event
    // stream — it kills that stream and EventSource cannot recover, stranding
    // the app in "connecting" until a manual Connect. The model switch is
    // applied by the config PATCH; the reconnect picks it up.
  }

  /** Providers OpenCode can use right now, with their models. */
  async listProviders(): Promise<ProviderInfo[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/config/providers`, {
      headers: this.headers(),
    });
    if (!res.ok) throw await this.apiError(res, "Failed to list providers");
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
    const models = Object.fromEntries(opts.models.map((m) => [m, { name: m }]));
    const provider = {
      [id]: {
        name: opts.name,
        npm: opts.npm,
        options: { baseURL: opts.baseURL, ...(opts.apiKey ? { apiKey: opts.apiKey } : {}) },
        models,
      },
    };
    const res = await this.fetchImpl(`${this.baseUrl}/global/config`, {
      method: "PATCH",
      headers: this.headers(true),
      body: JSON.stringify({ provider }),
    });
    if (!res.ok) throw await this.apiError(res, "Failed to add the provider");
  }

  /** Ids of custom providers defined in the global config (removable via the app). */
  async listCustomProviderIds(): Promise<string[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/global/config`, { headers: this.headers() });
    if (!res.ok) return [];
    const cfg = (await res.json()) as { provider?: Record<string, unknown> };
    return Object.keys(cfg.provider ?? {});
  }

  /** Configured MCP servers with live status, joined with their config. */
  async listMcpServers(): Promise<McpServer[]> {
    const [statusRes, cfgRes] = await Promise.all([
      this.fetchImpl(`${this.baseUrl}/mcp`, { headers: this.headers() }),
      this.fetchImpl(`${this.baseUrl}/global/config`, { headers: this.headers() }),
    ]);
    if (!statusRes.ok) throw await this.apiError(statusRes, "Failed to list MCP servers");
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
    const res = await this.fetchImpl(`${this.baseUrl}/global/config`, {
      method: "PATCH",
      headers: this.headers(true),
      body: JSON.stringify({ mcp: { [name]: config } }),
    });
    if (!res.ok) throw await this.apiError(res, "Failed to add the MCP server");
  }

  /** The full provider catalog (~150 entries) and which ids are connected. */
  async listProviderCatalog(): Promise<{ all: ProviderCatalogEntry[]; connected: string[] }> {
    const res = await this.fetchImpl(`${this.baseUrl}/provider`, { headers: this.headers() });
    if (!res.ok) throw await this.apiError(res, "Failed to list the provider catalog");
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
    const res = await this.fetchImpl(`${this.baseUrl}/provider/auth`, { headers: this.headers() });
    if (!res.ok) throw await this.apiError(res, "Failed to list auth methods");
    return (await res.json()) as Record<string, ProviderAuthMethod[]>;
  }

  /** Store an API key for a provider. */
  async setProviderApiKey(providerID: string, key: string): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/auth/${encodeURIComponent(providerID)}`, {
      method: "PUT",
      headers: this.headers(true),
      body: JSON.stringify({ type: "api", key }),
    });
    if (!res.ok) throw await this.apiError(res, "Failed to save the key");
    await this.disposeInstance();
  }

  /** Remove a provider's stored credentials. */
  async removeProviderAuth(providerID: string): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/auth/${encodeURIComponent(providerID)}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!res.ok) throw await this.apiError(res, "Failed to disconnect");
    await this.disposeInstance();
  }

  /** Start an OAuth login; returns the URL to open and how it completes. */
  async oauthAuthorize(
    providerID: string,
    method: number,
    inputs?: Record<string, string>,
  ): Promise<OAuthAuthorization> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/provider/${encodeURIComponent(providerID)}/oauth/authorize`,
      { method: "POST", headers: this.headers(true), body: JSON.stringify({ method, inputs }) },
    );
    if (!res.ok) throw await this.apiError(res, "Failed to start the login");
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
    const res = await this.fetchImpl(
      `${this.baseUrl}/provider/${encodeURIComponent(providerID)}/oauth/callback`,
      {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({ method, code }),
        signal,
      },
    );
    if (!res.ok) throw await this.apiError(res, "Login did not complete");
    await this.disposeInstance();
  }

  /** The server caches its provider list per instance — a credential change
   *  (PUT/DELETE /auth, OAuth) is invisible to /config/providers until the
   *  instance is disposed. Two instances can hold the stale cache: the default
   *  one (answering the unscoped /config/providers this client reads) and the
   *  workspace one (running this folder's sessions) — dispose both.
   *  Best-effort: the credential is already stored. */
  private async disposeInstance(): Promise<void> {
    for (const q of new Set(["", this.dirQuery()])) {
      await this.fetchImpl(`${this.baseUrl}/instance/dispose${q}`, {
        method: "POST",
        headers: this.headers(true),
        body: "{}",
      }).catch(() => undefined);
    }
  }

  /** Build an Error carrying the server's diagnostic message, when it has one
   *  (OpenCode errors look like `{ name, data: { message } }`). */
  private async apiError(res: Response, what: string): Promise<Error> {
    let detail = "";
    try {
      const body = (await res.json()) as { data?: { message?: string }; message?: string };
      detail = body.data?.message ?? body.message ?? "";
    } catch {
      /* not JSON — keep the status alone */
    }
    return new Error(`${what} (${res.status}${detail ? `: ${detail}` : ""})`);
  }

  /** Real agents configured in OpenCode. */
  async listAgents(): Promise<AgentInfo[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/agent`, { headers: this.headers() });
    if (!res.ok) throw await this.apiError(res, "Failed to list agents");
    return (await res.json()) as AgentInfo[];
  }

  /** Slash commands the runtime can run — config commands, skills and MCP
   *  prompts all surface in this one list (directory-scoped like skills). */
  async listCommands(): Promise<CommandInfo[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/command${this.dirQuery()}`, {
      headers: this.headers(),
    });
    if (!res.ok) throw await this.apiError(res, "Failed to list commands");
    const arr = (await res.json()) as Array<{
      name: string;
      description?: string;
      source?: string;
      agent?: string;
      // A string for config commands and skills; MCP prompts report an
      // argument-schema OBJECT here — only a string is a usable template.
      template?: unknown;
    }>;
    return arr.map((c) => ({
      name: c.name,
      description: c.description,
      source: c.source,
      agent: c.agent,
      template: typeof c.template === "string" ? c.template : undefined,
    }));
  }

  /** Run a shell command directly in the session's workspace — no model turn.
   *  The result lands in the session history as a bash tool part and streams
   *  via onEvent; the POST resolves only when the command finishes. */
  async runShell(sessionId: string, command: string, agent = "build"): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/shell`,
      {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({ agent, command }),
      },
    );
    if (!res.ok) throw await this.apiError(res, "Command failed to run");
  }

  /** Run a slash command (config command / skill / MCP prompt) in a session.
   *  This is a full agent turn; the POST resolves when the turn completes,
   *  while output streams via onEvent along the way. */
  async runCommand(sessionId: string, command: string, args?: string): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/command`,
      {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({ command, ...(args ? { arguments: args } : {}) }),
      },
    );
    if (!res.ok) throw await this.apiError(res, `Failed to run /${command}`);
  }

  /** Send a prompt into a session; output streams back via onEvent (SSE). */
  async sendPrompt(sessionId: string, text: string): Promise<void> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/prompt_async`,
      {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({ parts: [{ type: "text", text }] }),
      },
    );
    if (!res.ok) throw await this.apiError(res, "Failed to send prompt");
  }

  // ---- interactive requests (question / permission) ----
  // OpenCode exposes these as directory-scoped GLOBAL lists (not session-nested):
  // GET/POST /question[/…] and /permission[/…], each scoped by ?directory=. The
  // request id is globally unique; the reply/reject endpoints take it directly.

  /** Append `?directory=<path>` so the server resolves the workspace instance.
   *  Note: the `workspace` param is a `wrk_` id, NOT a path — omit it (directory
   *  alone resolves the instance; sending a path as workspace 500s the server). */
  private dirQuery(): string {
    return this.directory ? `?directory=${encodeURIComponent(this.directory)}` : "";
  }

  /** The /event stream URL: directory scope + auth_token (EventSource has no headers). */
  private eventUrl(): string {
    const params = new URLSearchParams();
    if (this.directory) params.set("directory", this.directory);
    if (this.authToken) params.set("auth_token", this.authToken);
    const q = params.toString();
    return `${this.baseUrl}/event${q ? `?${q}` : ""}`;
  }

  /** Pending questions in the workspace (recovery on open — an ask can predate connect). */
  async listQuestions(_sessionId?: string): Promise<QuestionAskedEvent[]> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/question${this.dirQuery()}`, {
      headers: this.headers(),
    });
    if (!res.ok) return [];
    const arr = (await res.json()) as Array<{
      id: string;
      sessionID: string;
      questions?: QuestionAskedEvent["questions"];
    }>;
    return arr.map((q) => ({
      type: "question.asked" as const,
      sessionId: q.sessionID,
      requestId: q.id,
      questions: q.questions ?? [],
    }));
  }

  /** Answer a question: one array of selected option labels per question, in order. */
  async answerQuestion(requestId: string, answers: string[][]): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/question/${encodeURIComponent(requestId)}/reply${this.dirQuery()}`,
      { method: "POST", headers: this.headers(true), body: JSON.stringify({ answers }) },
    );
    if (!res.ok) throw await this.apiError(res, "Failed to answer the question");
  }

  /** Reject/dismiss a question (the agent proceeds without an answer). */
  async rejectQuestion(requestId: string): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/question/${encodeURIComponent(requestId)}/reject${this.dirQuery()}`,
      { method: "POST", headers: this.headers(true), body: "{}" },
    );
    if (!res.ok) throw await this.apiError(res, "Failed to reject the question");
  }

  /** Pending permission requests in the workspace (recovery on open). */
  async listPermissions(_sessionId?: string): Promise<PermissionAskedEvent[]> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/permission${this.dirQuery()}`, {
      headers: this.headers(),
    });
    if (!res.ok) return [];
    // Same dual field names as the SSE event: `permission`/`patterns` (V2)
    // with `action`/`resources` as the legacy fallback.
    const arr = (await res.json()) as Array<{
      id: string;
      sessionID: string;
      permission?: string;
      patterns?: string[];
      action?: string;
      resources?: string[];
    }>;
    return arr.map((p) => ({
      type: "permission.asked" as const,
      sessionId: p.sessionID,
      requestId: p.id,
      action: p.permission ?? p.action ?? "action",
      resources: p.patterns ?? p.resources ?? [],
    }));
  }

  /** Reply to a permission request: allow once, allow always, or reject. */
  async replyPermission(requestId: string, reply: PermissionReply): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/permission/${encodeURIComponent(requestId)}/reply${this.dirQuery()}`,
      { method: "POST", headers: this.headers(true), body: JSON.stringify({ reply }) },
    );
    if (!res.ok) throw await this.apiError(res, "Failed to reply to the permission");
  }

  // ---- internals ----

  private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const chunk = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          this.handleSseChunk(chunk);
        }
      }
    } catch {
      // aborted or connection dropped
    } finally {
      this.setStatus("offline");
    }
  }

  private handleSseChunk(chunk: string): void {
    const dataLines = chunk
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    if (dataLines.length === 0) return;
    let raw: OpenCodeRawEvent;
    try {
      raw = JSON.parse(dataLines.join("\n"));
    } catch {
      return;
    }
    this.normalize(raw);
  }

  private normalize(raw: OpenCodeRawEvent): void {
    const props = raw.properties ?? {};
    switch (raw.type) {
      case "message.updated": {
        // Learn each message's role so we can skip the echoed user message parts.
        const info = props.info as { id?: string; role?: string } | undefined;
        if (info?.id && info.role) this.roles.set(info.id, info.role);
        break;
      }
      case "message.part.updated": {
        const part = props.part as
          | (OpenCodePart & { sessionID?: string; messageID?: string })
          | undefined;
        if (!part) return;
        // The user's own message is echoed here; the app already shows it locally.
        if (part.messageID && this.roles.get(String(part.messageID)) === "user") return;
        const sessionId = String(part.sessionID ?? "");
        if (part.type === "text") {
          const t = part as { id: string; text: string };
          this.textStreams.set(t.id, { sessionId, text: t.text ?? "" });
          this.emit({ type: "text.updated", sessionId, partId: t.id, text: t.text ?? "" });
        } else if (part.type === "tool") {
          const tp = part as {
            callID: string;
            tool: string;
            state?: {
              status?: string;
              title?: string;
              input?: Record<string, unknown>;
              output?: string;
              time?: { start?: number; end?: number };
              metadata?: { sessionId?: unknown; output?: unknown; diff?: unknown };
            };
          };
          // A task tool's metadata names the subagent session it spawned.
          const meta = tp.state?.metadata;
          const child = meta?.sessionId;
          this.emit({
            type: "tool.updated",
            sessionId,
            callId: tp.callID,
            tool: tp.tool,
            status: mapToolStatus(tp.state?.status ?? "pending"),
            title: tp.state?.title,
            input: tp.state?.input,
            output: typeof tp.state?.output === "string" ? tp.state.output : undefined,
            // While running, bash accumulates its stdout tail here — the live
            // output the UI shows so a long command never looks hung.
            partialOutput: typeof meta?.output === "string" ? meta.output : undefined,
            diff: typeof meta?.diff === "string" ? meta.diff : undefined,
            startedAt: typeof tp.state?.time?.start === "number" ? tp.state.time.start : undefined,
            endedAt: typeof tp.state?.time?.end === "number" ? tp.state.time.end : undefined,
            childSessionId: typeof child === "string" ? child : undefined,
          });
        }
        break;
      }
      case "message.part.delta": {
        // One streamed token. Only text parts are accumulated (reasoning parts
        // never get seeded by message.part.updated, so their deltas fall out).
        const d = props as { partID?: string; field?: string; delta?: string };
        if (d.field !== "text" || !d.partID || typeof d.delta !== "string") return;
        const acc = this.textStreams.get(String(d.partID));
        if (!acc) return;
        acc.text += d.delta;
        this.emit({
          type: "text.updated",
          sessionId: acc.sessionId,
          partId: String(d.partID),
          text: acc.text,
        });
        break;
      }
      case "session.idle": {
        const sessionId = String(props.sessionID ?? "");
        // The turn is over — its text parts can no longer receive deltas.
        for (const [partId, acc] of this.textStreams)
          if (acc.sessionId === sessionId) this.textStreams.delete(partId);
        this.emit({ type: "session.idle", sessionId });
        break;
      }
      // Interactive requests — support V2 (this server) and the bare names.
      case "question.v2.asked":
      case "question.asked": {
        const q = props as {
          id?: string;
          sessionID?: string;
          questions?: Array<{
            question: string;
            header: string;
            options?: Array<{ label: string; description?: string }>;
            multiple?: boolean;
            custom?: boolean;
          }>;
        };
        this.emit({
          type: "question.asked",
          sessionId: String(q.sessionID ?? ""),
          requestId: String(q.id ?? ""),
          questions: (q.questions ?? []).map((it) => ({
            question: it.question,
            header: it.header,
            options: it.options ?? [],
            multiple: it.multiple,
            custom: it.custom,
          })),
        });
        break;
      }
      case "question.v2.replied":
      case "question.v2.rejected":
      case "question.replied":
      case "question.rejected": {
        const q = props as { requestID?: string; id?: string; sessionID?: string };
        this.emit({
          type: "question.resolved",
          sessionId: String(q.sessionID ?? ""),
          requestId: String(q.requestID ?? q.id ?? ""),
        });
        break;
      }
      case "permission.v2.asked":
      case "permission.asked": {
        // The V2 server names the fields `permission` + `patterns`;
        // older payloads used `action` + `resources`. Accept both.
        const p = props as {
          id?: string;
          sessionID?: string;
          permission?: string;
          patterns?: string[];
          action?: string;
          resources?: string[];
        };
        this.emit({
          type: "permission.asked",
          sessionId: String(p.sessionID ?? ""),
          requestId: String(p.id ?? ""),
          action: String(p.permission ?? p.action ?? "action"),
          resources: p.patterns ?? p.resources ?? [],
        });
        break;
      }
      case "permission.v2.replied":
      case "permission.replied": {
        const p = props as { requestID?: string; id?: string; sessionID?: string };
        this.emit({
          type: "permission.resolved",
          sessionId: String(p.sessionID ?? ""),
          requestId: String(p.requestID ?? p.id ?? ""),
        });
        break;
      }
      case "session.error": {
        const err = props.error as
          | { name?: string; message?: string; data?: { message?: string } }
          | undefined;
        // OpenCode nests the human-readable message at error.data.message.
        const full = err?.data?.message ?? err?.message ?? err?.name ?? "session error";
        // Keep the first line — OpenCode appends a stack trace to some errors.
        this.emit({
          type: "error",
          sessionId: String(props.sessionID ?? ""),
          message: full.split("\n")[0],
        });
        break;
      }
      default:
        break; // server.connected and others are ignored
    }
  }

  private emit(event: OpenCodeEvent): void {
    this.eventListeners.forEach((l) => l(event));
  }
  private setStatus(status: RuntimeStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.statusListeners.forEach((l) => l(status));
  }
}
