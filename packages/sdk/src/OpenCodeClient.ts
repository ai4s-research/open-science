import type {
  AgentInfo,
  CommandInfo,
  HistoryMessage,
  McpConfig,
  McpServer,
  OAuthAuthorization,
  OpenCodeClientOptions,
  OpenCodePart,
  OpenCodeRawEvent,
  PermissionReply,
  PromptFile,
  ProviderAuthMethod,
  ProviderCatalogEntry,
  ProviderInfo,
  QuestionAskedEvent,
  PermissionAskedEvent,
  RetryAction,
  SessionMeta,
  SessionPage,
  SessionQuery,
  SkillInfo,
  ToolCallStatus,
} from "./types";
import type { MessageUsage } from "@ai4s/shared";
import { DEFAULT_OPENCODE_URL } from "./types";
import type { AgentRuntime } from "./runtime";
import { BaseAgentRuntime } from "./base-runtime";

export type CustomProviderModality = "text" | "audio" | "image" | "video" | "pdf";

/** A model on a custom endpoint. A caller that knows nothing but the id passes
 *  the id; one that knows the window, the pricing or the modalities passes them
 *  too, and they reach the runtime's own model record rather than being guessed
 *  at. Nothing here is required, because nothing about a self-hosted endpoint
 *  can be assumed. */
export interface CustomProviderModel {
  id: string;
  name?: string;
  context?: number;
  cost?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  };
  modalities?: {
    input?: CustomProviderModality[];
    output?: CustomProviderModality[];
  };
  reasoning?: boolean;
  variants?: Record<string, Record<string, unknown>>;
}

/**
 * An error from an OpenCode API call, carrying the HTTP status so a caller can
 * tell "this is already gone" (404) from a real failure. Answering a permission
 * request that the runtime has already resolved is the former, and it must not
 * read to the user as a broken action.
 */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** True when `err` is an API failure with this HTTP status. */
export function isApiStatus(err: unknown, status: number): boolean {
  return err instanceof Error && (err as { status?: unknown }).status === status;
}

/** The blind context window earlier versions wrote for custom-endpoint models
 *  whose real limit was unknown. We no longer write it (a wrong guess is worse
 *  than none — see addCustomProvider), and clearDefaultCustomModelContextLimits
 *  resets configs still carrying it. Match the exact shape we used to write so
 *  cleanup never touches a probed or hand-set limit. */
const LEGACY_BLIND_CONTEXT = 128_000;

/** Host UI contract exposed by the app-owned `present_artifact` tool. A tool
 *  description alone is not reliable enough: models sometimes mistake reading
 *  a file or linking its path for displaying it. Attach this concise reminder
 *  to every normal prompt so presentation requests produce a real UI event. */
const ARTIFACT_PRESENTATION_SYSTEM = `Open Science Desktop can display workspace files through the present_artifact tool.
- If the user asks to show, display, render, preview, or open an artifact in the chat/conversation, call present_artifact with display="inline".
- If the user asks for a panel or side-by-side view in the current Screen, call present_artifact with display="panel", target="current-screen", and the placement they asked for: placement="bottom" for below/underneath/a bottom panel, otherwise placement="right".
- If the artifact is already shown in a panel and the user asks to move it, call present_artifact again with the new placement; the host moves the open panel.
- If the user asks for a new Screen, call it with target="new-screen". If they ask for a new or dedicated Session, call it with target="new-session"; the host creates the Session.
- If you generate the artifact, create the file first, then call present_artifact in the same turn.
- Reading a file, mentioning its path, or attaching a link does not display it. Never claim an artifact is displayed unless present_artifact completed successfully.`;

/** The slice of OpenCode's global config we read and write for custom
 *  providers. Extra keys in an entry are preserved via spread on write. */
type CustomProviderConfig = Record<
  string,
  {
    models?: Record<string, CustomProviderModelConfig>;
    [key: string]: unknown;
  }
>;

type CustomProviderModelConfig = {
  id?: string;
  name?: string;
  limit?: { context: number; output: number };
  cost?: { input: number; output: number; cache_read?: number; cache_write?: number };
  modalities?: { input?: string[]; output?: string[] };
  reasoning?: boolean;
  variants?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
};

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

/** OpenCode's error objects nest the human-readable message at
 *  error.data.message; keep the first line (some errors append a stack). */
function errorText(error: unknown): string | undefined {
  const err = error as { name?: string; message?: string; data?: { message?: string } } | undefined;
  const full = err?.data?.message ?? err?.message ?? err?.name;
  return typeof full === "string" && full ? full.split("\n")[0] : undefined;
}

/** The `action` a retry status may carry, kept only when it has the one field
 *  the app decides anything on. Every other field is optional and passed
 *  through as-is when it is a string, so a runtime that adds one loses
 *  nothing and a runtime that renames one cannot inject a non-string. */
function retryAction(raw: unknown): RetryAction | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const it = raw as Record<string, unknown>;
  if (typeof it.reason !== "string" || !it.reason) return undefined;
  const action: RetryAction = { reason: it.reason };
  for (const field of ["provider", "title", "message", "label", "link"] as const) {
    const value = it[field];
    if (typeof value === "string" && value) action[field] = value;
  }
  return action;
}

/** OpenCode's own token shape on an assistant message (both in history and on
 *  every `message.updated`). Flattened into `MessageUsage` so callers never
 *  reach through `cache.` — and so a runtime that omits a field reads as 0
 *  rather than NaN in a sum. */
interface RawTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

/** Normalize a message's `tokens`/`cost` into `MessageUsage`.
 *
 *  Returns undefined when the runtime reported no tokens at all — a user
 *  message, an ACP turn, a mock. An all-zero `tokens` object is NOT undefined:
 *  a turn that was aborted before the first response really did use nothing,
 *  and reporting that is different from having no data. */
function toUsage(tokens: RawTokens | undefined, cost: unknown): MessageUsage | undefined {
  if (!tokens || typeof tokens !== "object") return undefined;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    input: n(tokens.input),
    output: n(tokens.output),
    reasoning: n(tokens.reasoning),
    cacheRead: n(tokens.cache?.read),
    cacheWrite: n(tokens.cache?.write),
    cost: n(cost),
  };
}

/** Split a "provider/model" default-model string into the `{providerID, modelID}`
 *  shape the prompt API expects. Returns undefined when the string is empty or
 *  has no provider prefix (so the caller omits the key and the server falls back
 *  to its own default). Splits on the FIRST slash: a model id may contain more. */
function parseModel(model?: string | null): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const i = model.indexOf("/");
  if (i <= 0 || i >= model.length - 1) return undefined;
  return { providerID: model.slice(0, i), modelID: model.slice(i + 1) };
}

/** Canonical low→high ordering of reasoning-effort variants across providers
 *  (OpenAI none/minimal/…/xhigh, Anthropic low/…/max, etc.). Known names sort by
 *  this rank; anything unrecognized keeps its original order after the known set,
 *  so a compact effort control can lay the levels out in a sensible progression. */
const VARIANT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
function orderVariants(names: string[]): string[] {
  const rank = (n: string) => {
    const i = VARIANT_ORDER.indexOf(n);
    return i === -1 ? VARIANT_ORDER.length : i;
  };
  return [...names].sort((a, b) => rank(a) - rank(b) || names.indexOf(a) - names.indexOf(b));
}

/** Sessions requested per `/experimental/session` page. Above the server's own
 *  unparameterized default (100), so the usual case is one round trip. */
const SESSION_PAGE = 200;

/** Recent conversations kept in memory for the sidebar. Deliberately small: a
 *  session costs ~645 bytes on the wire, so a multi-year history is megabytes
 *  (measured: 3.1 MB at 5k) and re-fetching it on every refresh would grow
 *  without bound. Everything beyond this window is reached through the
 *  History page, which pages and searches on the server. */
const RECENT_WINDOW = 200;

/** Pages the recent window will walk looking for enough NON-archived
 *  conversations before giving up. Only bites if a user has archived
 *  thousands of consecutive sessions. */
const RECENT_MAX_PAGES = 5;

/** Smallest page actually requested from the server, whatever the caller asked
 *  for. The cursor overlaps the millisecond it stopped in, so a page has to be
 *  bigger than the run of sessions sharing that millisecond or the walk cannot
 *  advance at all. 50 is far past anything real (the 5k load test averaged ~1.5
 *  per millisecond) and costs ~32 KB. */
const MIN_FETCH = 50;

/** Our own bookkeeping on a session, kept in OpenCode's `metadata`. The server
 *  returns it with the session list (no extra request), it survives a
 *  reinstall, and it reaches the gateway web client like everything else.
 *
 *  OpenCode's OWN `time.archived` is deliberately NOT used: verified against
 *  the pinned 1.17.13 that once set it cannot be cleared through the API
 *  (`null`, `0` and `{}` all leave the session hidden, and there is no
 *  unarchive route), which would make archiving a one-way door. */
const META_NS = "ai4s";

/**
 * The single boundary between the app and the OpenCode agent runtime.
 * Talks to a running `opencode serve` over its HTTP + SSE API. The UI must go
 * through this class, never the transport directly (see AGENTS.md guardrails).
 */
export class OpenCodeClient extends BaseAgentRuntime implements AgentRuntime {
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
  private abort: AbortController | null = null;
  private es: EventSource | null = null;
  /** Pending self-heal of a dead event stream (see reconnectSoon). */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** True between close() and the next connect() — stops self-healing. */
  private closed = false;
  private readonly customFetch: boolean;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  /** messageID → role, learned from message.updated, to skip echoed user parts. */
  private readonly roles = new Map<string, string>();
  /** partID → accumulated text of a streaming text part. OpenCode publishes the
   *  full part only at text-start (empty) and text-end; every token in between
   *  arrives as a message.part.delta that must be summed here — otherwise the
   *  app shows nothing until the whole passage is finished. */
  private readonly textStreams = new Map<
    string,
    { sessionId: string; text: string; messageID?: string }
  >();
  /** partID → accumulated reasoning text. Reasoning parts stream the same way as
   *  text (field "text" deltas) but were dropped because they were never seeded
   *  here — so the model's thinking never reached the UI. */
  private readonly reasoningStreams = new Map<string, { sessionId: string; text: string }>();
  /** sessionId → the step-start part ids seen this turn. Its size is the current
   *  step number; cleared on session.idle. Deduped because a part can update more
   *  than once. */
  private readonly stepParts = new Map<string, Set<string>>();

  constructor(opts: OpenCodeClientOptions = {}) {
    super();
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
  async createSession(title?: string): Promise<string> {
    // The directory decides where the session lives and works — without it the
    // server would put it in the process's boot folder, not the active one.
    const res = await this.fetchWithTimeout(`${this.baseUrl}/session${this.dirQuery()}`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(title ? { title } : {}),
    });
    if (!res.ok) throw await this.apiError(res, "Failed to create session");
    const json = (await res.json()) as { id: string };
    return json.id;
  }

  /** Fork a completed checkpoint so a specialist can work with the parent's
   *  context without occupying or writing into the foreground conversation. */
  async forkSession(sessionId: string, beforeMessageId?: string): Promise<string> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/fork${this.dirQuery()}`,
      {
        method: "POST",
        headers: this.headers(true),
        // OpenCode's boundary is exclusive: the named message is NOT copied.
        body: JSON.stringify(beforeMessageId ? { messageID: beforeMessageId } : {}),
      },
    );
    if (!res.ok) throw await this.apiError(res, "Failed to fork session");
    const json = (await res.json()) as { id: string };
    return json.id;
  }

  /** The recent conversations the sidebar shows: newest first, across every
   *  workspace folder, archived ones excluded. Bounded by RECENT_WINDOW — the
   *  whole history is never held in memory (see the constant). */
  async listSessions(): Promise<SessionMeta[]> {
    const page = await this.querySessions({ limit: RECENT_WINDOW });
    return page.sessions.slice(0, RECENT_WINDOW);
  }

  /** One page of conversation history, newest first, across every workspace
   *  folder. Searching and paging happen on the SERVER (measured against 5038
   *  live sessions: a 200-row page in 18 ms, a title search in 1 ms, the whole
   *  history in 26 gap-free pages), so the app never holds a multi-year
   *  history to find something in it.
   *
   *  Archived conversations are dropped unless `archived` is set. That filter
   *  runs here, not on the server: the server's own `archived` flag is
   *  one-way (see META_NS), so ours lives in `metadata`, which the list
   *  already returns. Pages are topped up so filtering never hands back a
   *  nearly-empty page and makes the user click "load more" repeatedly. */
  async querySessions(query: SessionQuery = {}): Promise<SessionPage> {
    const limit = query.limit ?? SESSION_PAGE;
    const out: SessionMeta[] = [];
    const seen = new Set<string>();
    let cursor = query.cursor ?? null;
    for (let attempt = 0; attempt < RECENT_MAX_PAGES; attempt++) {
      const raw = await this.rawSessionPage({
        ...query,
        limit: Math.max(limit, MIN_FETCH),
        cursor,
      });
      // The +1 cursor deliberately re-reads the shared millisecond it stopped
      // in, so a top-up round always overlaps the previous one by at least a
      // row — dedupe here or the loop can spin without making progress.
      const fresh = raw.sessions.filter((s) => !seen.has(s.id));
      fresh.forEach((s) => seen.add(s.id));
      out.push(...(query.archived ? fresh : fresh.filter((s) => s.archived == null)));
      cursor = raw.nextCursor;
      if (cursor === null || out.length >= limit || fresh.length === 0) break;
    }
    return { sessions: out, nextCursor: cursor };
  }

  /** One HTTP page, unfiltered.
   *
   *  The plain `/session` list is scoped to the folder the sidecar's cwd
   *  resolves to, so history would appear to change when the user switches
   *  projects; `/experimental/session` lists every project's sessions. Falls
   *  back to `/session` on a server without the experimental route. */
  private async rawSessionPage(query: SessionQuery): Promise<SessionPage> {
    const limit = query.limit ?? SESSION_PAGE;
    const params = new URLSearchParams({ limit: String(limit) });
    if (query.cursor != null) params.set("cursor", String(query.cursor));
    if (query.search) params.set("search", query.search);

    let res = await this.fetchWithTimeout(`${this.baseUrl}/experimental/session?${params}`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      // No experimental route means no paging either: answer its one list and
      // report no next page.
      if (query.cursor != null) return { sessions: [], nextCursor: null };
      res = await this.fetchWithTimeout(`${this.baseUrl}/session`, { headers: this.headers() });
    }
    if (!res.ok) throw await this.apiError(res, "Failed to list sessions");
    const arr = (await res.json()) as Array<{
      id: string;
      title?: string;
      slug?: string;
      directory?: string;
      parentID?: string | null;
      metadata?: Record<string, unknown>;
      time?: { created?: number; updated?: number };
    }>;
    const sessions = arr.map((s) => {
      const mine = (s.metadata?.[META_NS] ?? {}) as { archived?: number };
      return {
        id: s.id,
        title: s.title ?? "Untitled",
        slug: s.slug,
        directory: s.directory,
        parentId: s.parentID ?? undefined,
        created: s.time?.created,
        updated: s.time?.updated,
        ...(typeof mine.archived === "number" ? { archived: mine.archived } : {}),
        ...(s.metadata ? { metadata: s.metadata } : {}),
      } satisfies SessionMeta;
    });

    // The cursor is exclusive ("strictly older than"), and thousands of
    // sessions can share one millisecond — 1699 of 5038 did in the load test.
    // Cursoring on the last row's own timestamp therefore DROPS the rest of
    // that millisecond (8 sessions vanished); +1 re-reads the run instead, and
    // callers dedupe by id. Same page count, no silent loss.
    const last = sessions[sessions.length - 1]?.updated;
    const nextCursor = sessions.length < limit || last == null ? null : last + 1;
    return { sessions, nextCursor };
  }

  /** Archive a conversation (or restore it with `false`). Recorded in the
   *  session's `metadata`, preserving anything else stored there. */
  async setSessionArchived(sessionId: string, archived: boolean): Promise<void> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}`,
      { headers: this.headers() },
    );
    if (!res.ok) throw await this.apiError(res, "Failed to read the session");
    const current = (await res.json()) as { metadata?: Record<string, unknown> };
    // PATCH replaces `metadata` wholesale, so merge rather than overwrite —
    // another client's keys must survive our edit.
    const metadata: Record<string, unknown> = { ...(current.metadata ?? {}) };
    const mine = { ...((metadata[META_NS] as Record<string, unknown>) ?? {}) };
    if (archived) mine.archived = Date.now();
    else delete mine.archived;
    if (Object.keys(mine).length > 0) metadata[META_NS] = mine;
    else delete metadata[META_NS];

    const patch = await this.fetchWithTimeout(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}`,
      { method: "PATCH", headers: this.headers(true), body: JSON.stringify({ metadata }) },
    );
    if (!patch.ok) throw await this.apiError(patch, "Failed to archive the session");
  }

  /** Add an app-produced text part to a completed assistant message. This is a
   *  persistence operation only: unlike sendPrompt it starts no model turn. */
  async appendTextPart(
    sessionId: string,
    messageId: string,
    text: string,
    partId = OpenCodeClient.partId(),
  ): Promise<string> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}` +
        `/message/${encodeURIComponent(messageId)}/part/${encodeURIComponent(partId)}` +
        this.dirQuery(),
      {
        method: "PATCH",
        headers: this.headers(true),
        body: JSON.stringify({
          id: partId,
          sessionID: sessionId,
          messageID: messageId,
          type: "text",
          text,
          synthetic: true,
          // MUST be a two-level record, namespaced like every other thing we
          // store (META_NS). A PART's metadata is not private to us the way a
          // session's is: the runtime forwards an assistant text part's
          // metadata to the model as `providerMetadata`, whose schema is
          // `Record<string, Record<string, JSONValue>>`. This field used to be
          // the flat `{ source: "ai4s.background-review" }`, and a string where
          // a record belongs made the AI SDK reject the ENTIRE conversation
          // with "Invalid prompt: The messages do not match the ModelMessage[]
          // schema" — on the next turn and every turn after it, because the
          // part is on disk. That was #114: a background review silently ended
          // the conversation it was reviewing. Reproduced against the pinned
          // runtime, both ways round.
          metadata: { [META_NS]: { source: "background-review" } },
        }),
      },
    );
    if (!res.ok) throw await this.apiError(res, "Failed to persist background result");
    return partId;
  }

  /** OpenCode only requires the `prt` prefix, but matching its ascending ID
   *  shape keeps a newly appended part ordered after the checkpoint's parts. */
  private static partId(): string {
    const stamp = (BigInt(Date.now()) * 0x1000n + 1n).toString(16).padStart(12, "0");
    const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    const bytes = new Uint8Array(14);
    globalThis.crypto.getRandomValues(bytes);
    let random = "";
    for (const byte of bytes) random += alphabet[byte % alphabet.length];
    return `prt_${stamp}${random}`;
  }

  /** Rename a session (PATCH /session/:id). OpenCode titles a new session
   *  "New session - <timestamp>" and only replaces that once the model has
   *  summarized the first turn — which can silently not happen (#63), leaving
   *  an unreadable history. This is the user's own way out. */
  async renameSession(sessionId: string, title: string): Promise<void> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}`,
      {
        method: "PATCH",
        headers: this.headers(true),
        body: JSON.stringify({ title }),
      },
    );
    if (!res.ok) throw await this.apiError(res, "Failed to rename session");
  }

  /** Re-home an existing session into another workspace folder, so a
   *  conversation that started loose can be filed under a project (#62).
   *  `moveChanges: false` — the session's workspace files stay where they are;
   *  only the conversation moves, which is what "add to project" means here. */
  async moveSession(sessionId: string, directory: string): Promise<void> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/experimental/control-plane/move-session`,
      {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({ sessionID: sessionId, destination: { directory }, moveChanges: false }),
      },
    );
    if (!res.ok) throw await this.apiError(res, "Failed to move session");
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
      info: {
        id?: string;
        role: "user" | "assistant";
        time?: { completed?: number; created?: number };
        error?: unknown;
        agent?: string;
        cost?: number;
        tokens?: RawTokens;
      };
      parts: HistoryMessage["parts"];
    }>;
    return arr.map((m) => {
      const error = errorText(m.info.error);
      const usage = toUsage(m.info.tokens, m.info.cost);
      return {
        role: m.info.role,
        ...(m.info.id ? { id: m.info.id } : {}),
        completed: m.info.time?.completed,
        created: m.info.time?.created,
        ...(error ? { error } : {}),
        ...(m.info.agent ? { agent: m.info.agent } : {}),
        ...(usage ? { usage } : {}),
        parts: m.parts ?? [],
      };
    });
  }

  /** Revert the session to (and including) a message: OpenCode drops that
   *  message and everything after it, rolling back any workspace files it
   *  touched. This is how the app edits a past user message — revert to it,
   *  then send the corrected text. The session must be idle (abort first);
   *  reverting a busy session is rejected by OpenCode. `partID` reverts to a
   *  specific part within the message; omit to revert the whole message. */
  async revert(sessionId: string, messageID: string, partID?: string): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/revert`,
      {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({ messageID, ...(partID ? { partID } : {}) }),
      },
    );
    if (!res.ok) throw await this.apiError(res, "Failed to revert the message");
  }

  /** Undo the last revert — restores the reverted messages and files. */
  async unrevert(sessionId: string): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/unrevert`,
      { method: "POST", headers: this.headers(true), body: "{}" },
    );
    if (!res.ok) throw await this.apiError(res, "Failed to restore the reverted messages");
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

  /** Every skill OpenCode has really loaded for this workspace: built-in,
   *  the app's bundled packs, `.opencode/skills/`, and the home-level
   *  `~/.claude/skills` + `~/.agents/skills` it auto-loads.
   *
   *  `/skill` (not the experimental `/api/skill`): the v2 list is built only
   *  from config-declared sources — config dirs plus `.opencode/skill(s)` —
   *  so home-level skills are missing from it even though sessions (which run
   *  on this same v1 API) load and use them (#61). */
  async listSkills(): Promise<SkillInfo[]> {
    // Scope to the workspace: skill instances are created lazily per directory,
    // and the unscoped endpoint answers from an instance that may have none.
    const res = await this.fetchImpl(`${this.baseUrl}/skill${this.dirQuery()}`, {
      headers: this.headers(),
    });
    if (!res.ok) throw await this.apiError(res, "Failed to list skills");
    // v1 answers with a bare array; tolerate the v2 envelope so a server
    // pinned to either shape still lists.
    const body = (await res.json()) as SkillInfo[] | { data?: SkillInfo[] };
    const skills = Array.isArray(body) ? body : body.data ?? [];
    // Discovery order is scan order (concurrent globs) — sort so the list the
    // user sees is stable across reloads.
    return [...skills].sort((a, b) => a.name.localeCompare(b.name));
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
      providers?: Array<{
        id: string;
        name?: string;
        // OpenCode carries a per-model `variants` map (variant name → provider
        // options) built from models.dev + config; a model with no reasoning
        // levels has none. We surface just the ordered names.
        models?: Record<
          string,
          {
            name?: string;
            variants?: Record<string, unknown>;
            limit?: { context?: number };
          }
        >;
      }>;
    };
    return (body.providers ?? []).map((p) => ({
      id: p.id,
      name: p.name ?? p.id,
      models: Object.entries(p.models ?? {}).map(([id, m]) => ({
        id,
        name: m.name ?? id,
        variants: orderVariants(Object.keys(m.variants ?? {})),
        // 0 and "absent" mean the same thing here — OpenCode reports an unknown
        // window as 0 — so normalise to 0 and let callers test one value.
        contextLimit: m.limit?.context ?? 0,
      })),
    }));
  }

  /**
   * Register a custom endpoint (self-hosted / OpenAI-compatible / Anthropic-
   * compatible / local Ollama) in OpenCode's global config. Applies live.
   */
  async addCustomProvider(
    id: string,
    opts: {
      name: string;
      npm: string;
      baseURL: string;
      apiKey?: string;
      models: ReadonlyArray<string | CustomProviderModel>;
      /** Context window per model id (e.g. probed from the endpoint). */
      contexts?: Record<string, number>;
    },
  ): Promise<void> {
    // Only pin model.limit.context when we actually know it: a caller-provided
    // value (probed from the endpoint or typed by the user) wins, else a real
    // limit already in the config is kept, else we write nothing (context stays
    // 0). A guessed default is worse than none — OpenCode's overflow accounting
    // treats our number as the hard window: too low manufactures a context-
    // overflow and aborts turns on models with a larger real window (#52); too
    // high never helps a smaller one. Known values come from the probe
    // (Ollama/vLLM/LM Studio report their window) or the user; when both are
    // absent, leaving context 0 makes OpenCode skip the accounting entirely.
    const existing = await this.customProviderModels(id);
    const models = Object.fromEntries(
      opts.models.map((input) => {
        const model = typeof input === "string" ? { id: input } : input;
        const previous = existing[model.id];
        const context = opts.contexts?.[model.id] ?? model.context;
        const limit =
          context && context > 0
            ? { context, output: previous?.limit?.output ?? 0 }
            : previous?.limit;
        const metadata =
          typeof input === "string"
            ? {}
            : {
                ...(model.cost !== undefined ? { cost: model.cost } : {}),
                ...(model.modalities !== undefined ? { modalities: model.modalities } : {}),
                ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
                ...(model.variants !== undefined ? { variants: model.variants } : {}),
              };
        return [
          model.id,
          {
            ...(previous ?? {}),
            name: model.name ?? model.id,
            ...(limit ? { limit } : {}),
            ...metadata,
          },
        ];
      }),
    );
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

  /** Context limits already configured for a custom provider's models, keyed by
   *  model id. Best-effort: an unreadable config just means "no limits set". */
  private async customProviderModels(id: string): Promise<Record<string, CustomProviderModelConfig>> {
    const cfg = await this.customProviderConfig();
    return cfg[id]?.models ?? {};
  }

  private async customProviderConfig(): Promise<CustomProviderConfig> {
    const res = await this.fetchImpl(`${this.baseUrl}/global/config`, { headers: this.headers() });
    if (!res.ok) return {};
    const cfg = (await res.json()) as { provider?: CustomProviderConfig };
    return cfg.provider ?? {};
  }

  /**
   * Undo the blind context limit older versions wrote for custom models whose
   * real window was unknown (#52). That guessed ceiling sits below large models'
   * real window, so OpenCode's overflow accounting manufactured a context-
   * overflow and aborted turns that used to work. We reset only limits matching
   * the exact default we used to write — {context:128000, output:0} — back to
   * context 0, which makes OpenCode skip overflow accounting (the pre-guess
   * behavior); probed or hand-set limits are left untouched. We write context 0
   * rather than dropping the key because OpenCode merges config patches (remeda
   * mergeDeep), so an omitted key would keep the stale value. Idempotent (a
   * reset entry no longer matches) and best-effort: call it after connecting.
   */
  async clearDefaultCustomModelContextLimits(): Promise<void> {
    const isBlindDefault = (limit?: { context: number; output: number }) =>
      limit != null && limit.context === LEGACY_BLIND_CONTEXT && limit.output === 0;
    const cfg = await this.customProviderConfig();
    const patch: CustomProviderConfig = {};
    for (const [pid, entry] of Object.entries(cfg)) {
      const models = entry.models ?? {};
      if (!Object.values(models).some((m) => isBlindDefault(m.limit))) continue;
      patch[pid] = {
        ...entry,
        models: Object.fromEntries(
          Object.entries(models).map(([mid, m]) =>
            isBlindDefault(m.limit) ? [mid, { ...m, limit: { context: 0, output: 0 } }] : [mid, m],
          ),
        ),
      };
    }
    if (Object.keys(patch).length === 0) return;
    const res = await this.fetchImpl(`${this.baseUrl}/global/config`, {
      method: "PATCH",
      headers: this.headers(true),
      body: JSON.stringify({ provider: patch }),
    });
    if (!res.ok) throw await this.apiError(res, "Failed to reset default model context limits");
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

  /** Read a provider's configured AWS-style region, when present. */
  async getProviderRegion(providerID: string): Promise<string | null> {
    const res = await this.fetchImpl(`${this.baseUrl}/global/config`, { headers: this.headers() });
    if (!res.ok) throw await this.apiError(res, "Failed to read provider region");
    const cfg = (await res.json()) as {
      provider?: Record<string, { options?: { region?: unknown } }>;
    };
    const region = cfg.provider?.[providerID]?.options?.region;
    return typeof region === "string" && region ? region : null;
  }

  /** Set a provider's AWS-style region in the global config. Applies live. */
  async setProviderRegion(providerID: string, region: string): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/global/config`, {
      method: "PATCH",
      headers: this.headers(true),
      body: JSON.stringify({
        provider: { [providerID]: { options: { region } } },
      }),
    });
    if (!res.ok) throw await this.apiError(res, "Failed to set provider region");
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

  /** Drop the server's cached provider list so a credential stored outside
   *  this client's own auth calls (e.g. a browser login whose callback never
   *  reached us) shows up in listProviders. */
  async refreshProviderCache(): Promise<void> {
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

  /** Build an Error carrying the server's diagnostic message, when it has one.
   *  Two shapes reach here: OpenCode's own (`{ name, data: { message } }`) and
   *  the gateway's (`{ error }`) — when the web client's call is refused by
   *  gateway policy rather than by OpenCode, the reason is in `error`, and
   *  dropping it turns an explained refusal into a bare status code (#119). */
  private async apiError(res: Response, what: string): Promise<Error> {
    let detail = "";
    try {
      const body = (await res.json()) as {
        data?: { message?: string };
        message?: string;
        error?: string;
      };
      detail = body.data?.message ?? body.message ?? body.error ?? "";
    } catch {
      /* not JSON — keep the status alone */
    }
    return new ApiError(`${what} (${res.status}${detail ? `: ${detail}` : ""})`, res.status);
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

  /** Send a prompt into a session; output streams back via onEvent (SSE).
   *  `agent` pins the turn to a specific agent (e.g. "plan"); omitted, the
   *  server resolves its default — the key is left out entirely so build-mode
   *  requests stay byte-identical to before.
   *
   *  `model` ("provider/model") pins the turn to the current default model.
   *  OpenCode persists a `session.model` at session creation, so switching the
   *  global default does NOT rebind existing sessions — an old session would
   *  keep answering on its creation-time provider/model. Passing the current
   *  default on every turn overrides that stale binding without mutating the
   *  server's stored rows. Omitted/unparseable, the key is left out and the
   *  server falls back to the session/global default. */
  async sendPrompt(
    sessionId: string,
    text: string,
    agent?: string,
    model?: string | null,
    variant?: string | null,
    files?: PromptFile[],
  ): Promise<void> {
    const m = parseModel(model);
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/prompt_async`,
      {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({
          // Attachments ride as `file` parts so a vision model actually sees
          // them; the text still names them, so the agent can also open the
          // workspace copy with its own tools (#88).
          parts: [
            { type: "text", text },
            ...(files ?? []).map((f) => ({
              type: "file",
              mime: f.mime,
              filename: f.filename,
              url: f.url,
            })),
          ],
          ...(agent ? { agent } : {}),
          ...(m ? { model: m } : {}),
          system: ARTIFACT_PRESENTATION_SYSTEM,
          // Per-turn reasoning effort; OpenCode maps the variant name to the
          // provider's native param. Omitted → the model's default effort.
          ...(variant ? { variant } : {}),
        }),
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
        const info = props.info as
          | {
              id?: string;
              role?: string;
              sessionID?: string;
              agent?: string;
              cost?: number;
              tokens?: RawTokens;
              time?: { created?: number; completed?: number };
            }
          | undefined;
        if (info?.id && info.role) this.roles.set(info.id, info.role);
        // An assistant message republishes its running token totals here on
        // every update — this is the ONLY place the protocol reports them, so
        // dropping the event is what left the app unable to show how much of
        // the context window a conversation had eaten.
        if (info?.role === "assistant" && info.id && info.sessionID) {
          const usage = toUsage(info.tokens, info.cost);
          if (usage)
            this.emit({
              type: "message.usage",
              sessionId: String(info.sessionID),
              messageID: String(info.id),
              usage,
              ...(info.time?.created ? { created: info.time.created } : {}),
              ...(info.time?.completed ? { completed: info.time.completed } : {}),
            });
        }
        // A user message surfaces its id (so the app can tag the live block for
        // editing) and its agent (so the per-session agent mode stays in sync —
        // plan_exit "Yes" injects a build one). Emitted for every user message,
        // carrying whichever fields are present.
        if (info?.role === "user" && info.sessionID && (info.id || typeof info.agent === "string")) {
          this.emit({
            type: "message.agent",
            sessionId: String(info.sessionID),
            ...(info.id ? { messageID: info.id } : {}),
            ...(typeof info.agent === "string" ? { agent: info.agent } : {}),
          });
        }
        break;
      }
      case "message.part.updated": {
        const part = props.part as
          | (OpenCodePart & { sessionID?: string; messageID?: string })
          | undefined;
        if (!part) return;
        // The user's own message is echoed here; the app already shows it
        // locally. Compaction is the exception and must be checked FIRST:
        // OpenCode's SessionCompaction.create opens a message with role "user"
        // purely to hang the marker off, so this guard used to swallow every
        // compaction before it could be emitted.
        if (
          part.type !== "compaction" &&
          part.messageID &&
          this.roles.get(String(part.messageID)) === "user"
        )
          return;
        const sessionId = String(part.sessionID ?? "");
        if (part.type === "text") {
          const t = part as { id: string; text: string };
          // The message id rides along in the stream state: every later delta
          // re-emits the whole text, and the fold upserts by part id — so an
          // event that forgot the id would blank it out again.
          const messageID = part.messageID ? String(part.messageID) : undefined;
          this.textStreams.set(t.id, { sessionId, text: t.text ?? "", messageID });
          this.emit({
            type: "text.updated",
            sessionId,
            partId: t.id,
            text: t.text ?? "",
            ...(messageID ? { messageID } : {}),
          });
        } else if (part.type === "reasoning") {
          // Seed the reasoning stream so its "text" deltas accumulate (below),
          // and surface the thinking the app used to discard.
          const r = part as unknown as { id: string; text?: string };
          this.reasoningStreams.set(r.id, { sessionId, text: r.text ?? "" });
          this.emit({ type: "reasoning.updated", sessionId, partId: r.id, text: r.text ?? "" });
        } else if (part.type === "compaction") {
          // The runtime summarized the older turns to stay inside the context
          // window and kept going. Surface it as a marker so the conversation
          // reads continuously instead of ending in an "exceeds context
          // window" abort (#62).
          const c = part as unknown as { auto?: boolean; overflow?: boolean };
          this.emit({
            type: "session.compacted",
            sessionId,
            auto: c.auto !== false,
            ...(c.overflow ? { overflow: true } : {}),
          });
        } else if (part.type === "step-start") {
          // A new model step began — count it (deduped) so the UI can show
          // "step N" and prove the turn is progressing rather than hung.
          const sp = part as unknown as { id: string };
          let seen = this.stepParts.get(sessionId);
          if (!seen) this.stepParts.set(sessionId, (seen = new Set()));
          if (!seen.has(sp.id)) {
            seen.add(sp.id);
            this.emit({ type: "step.updated", sessionId, step: seen.size });
          }
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
        // One streamed token. Both text and reasoning parts stream via the
        // "text" field; each was seeded above, so route the delta to whichever
        // stream owns this part.
        const d = props as { partID?: string; field?: string; delta?: string };
        if (d.field !== "text" || !d.partID || typeof d.delta !== "string") return;
        const partId = String(d.partID);
        const acc = this.textStreams.get(partId);
        if (acc) {
          acc.text += d.delta;
          this.emit({
            type: "text.updated",
            sessionId: acc.sessionId,
            partId,
            text: acc.text,
            ...(acc.messageID ? { messageID: acc.messageID } : {}),
          });
          return;
        }
        const racc = this.reasoningStreams.get(partId);
        if (racc) {
          racc.text += d.delta;
          this.emit({ type: "reasoning.updated", sessionId: racc.sessionId, partId, text: racc.text });
        }
        break;
      }
      case "session.idle": {
        const sessionId = String(props.sessionID ?? "");
        // The turn is over — its text/reasoning parts can no longer receive
        // deltas, and its step count resets for the next turn.
        for (const [partId, acc] of this.textStreams)
          if (acc.sessionId === sessionId) this.textStreams.delete(partId);
        for (const [partId, acc] of this.reasoningStreams)
          if (acc.sessionId === sessionId) this.reasoningStreams.delete(partId);
        this.stepParts.delete(sessionId);
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
        // OpenCode nests the human-readable message at error.data.message.
        // Keep the first line — OpenCode appends a stack trace to some errors.
        this.emit({
          type: "error",
          sessionId: String(props.sessionID ?? ""),
          message: errorText(props.error) ?? "session error",
        });
        break;
      }
      case "session.status": {
        // A failed model call being retried server-side: the ONLY sign of life
        // while a broken provider fails every attempt, so dropping these leaves
        // the UI on a bare "Working…". ("busy" and "idle" statuses carry
        // nothing session.idle doesn't already.)
        //
        // `action` rides the same payload and is the difference between "the
        // provider hiccuped" and "this account cannot make this call at all"
        // (Zen's free allowance spent, a Go plan's limit reached). Keeping only
        // the message throws that away and leaves the app free to call a
        // terminal condition a retry.
        const status = props.status as
          | {
              type?: string;
              attempt?: number;
              message?: string;
              next?: number;
              action?: Record<string, unknown>;
            }
          | undefined;
        if (status?.type !== "retry") break;
        const action = retryAction(status.action);
        this.emit({
          type: "session.retry",
          sessionId: String(props.sessionID ?? ""),
          attempt: status.attempt ?? 0,
          message: status.message ?? "provider error",
          nextAt: status.next ?? 0,
          ...(action ? { action } : {}),
        });
        break;
      }
      default:
        break; // server.connected and others are ignored
    }
  }
}
