import type {
  AgentInfo,
  CommandInfo,
  ConfigStore,
  HistoryMessage,
  HistoryPart,
  McpConfig,
  McpOAuthStart,
  McpServer,
  OAuthAuthorization,
  EventStreamOpener,
  GoalInfo,
  HistoryUpgrade,
  OpenCodeClientOptions,
  OpenCodeRawEvent,
  PermissionReply,
  PromptFile,
  ProviderAuthMethod,
  ProviderCatalogEntry,
  ProviderInfo,
  QuestionAskedEvent,
  QuestionItem,
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

// The client for OpenCode 2's HTTP + SSE API (`/api/*`). It translates that
// API into the app's own vocabulary — the events in `types.ts` and the
// v1-shaped `HistoryMessage` — so nothing above this file knows which OpenCode
// it is talking to. The translation is the whole job: OpenCode 2 replaced
// message parts with typed messages, streams turns as `session.*` events, and
// renamed tools (`bash` → `shell`, `task` → `subagent`).

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

/** Our own bookkeeping on a session, kept in OpenCode's `metadata`. The server
 *  returns it with the session list (no extra request), it survives a
 *  reinstall and the v1 → v2 data migration, and it reaches the gateway web
 *  client like everything else. Archiving lives here rather than in
 *  OpenCode's own `archived` so conversations archived before the upgrade
 *  stay archived. */
const META_NS = "ai4s";

/** Sessions requested per page. */
const SESSION_PAGE = 200;

/** Recent conversations kept in memory for the sidebar. Deliberately small: a
 *  multi-year history is megabytes, and re-fetching it on every refresh would
 *  grow without bound. Everything beyond this window is reached through the
 *  History page, which pages and searches on the server. */
const RECENT_WINDOW = 200;

/** Pages the recent window will walk looking for enough NON-archived
 *  conversations before giving up. Only bites if a user has archived
 *  thousands of consecutive sessions. */
const RECENT_MAX_PAGES = 5;

/** Messages requested per history page — the most the server allows. */
const MESSAGE_PAGE = 200;

/** How often a running shell tool's output is re-read, so a long command shows
 *  its output as it goes instead of looking hung. */
const SHELL_POLL_MS = 1000;

/** How often a slash command's turn is checked, and how long a command may
 *  take to start one before it counts as a command that starts none. */
const COMMAND_POLL_MS = 500;
const COMMAND_START_GRACE_MS = 3000;

// ---- translation: OpenCode 2 → the app's vocabulary ----

/** Tools OpenCode 2 renamed. The app (its tool cards, its history, its
 *  artifact detection) speaks the old names. */
const TOOL_ALIASES: Record<string, string> = {
  shell: "bash",
  subagent: "task",
  todo: "todowrite",
};

export function appToolName(name: string): string {
  return TOOL_ALIASES[name] ?? name;
}

/** Tool input in the field names the app reads. OpenCode 2 names a file
 *  `path` where the app reads `filePath`, and a subagent `agent` where it
 *  reads `subagent_type`; both names are kept so nothing that already reads
 *  the new one loses it. */
export function appToolInput(name: string, input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const out: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  if (typeof out.path === "string" && out.filePath === undefined) out.filePath = out.path;
  if (name === "subagent" && typeof out.agent === "string" && out.subagent_type === undefined)
    out.subagent_type = out.agent;
  return out;
}

/** The text a tool returned: its text contents joined. File contents carry a
 *  uri the model reads; the app shows the text. */
function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((c) => (c && typeof c === "object" && (c as { type?: unknown }).type === "text"
      ? String((c as { text?: unknown }).text ?? "")
      : ""))
    .join("");
  return text || undefined;
}

/** The unified diff an edit/write/patch tool reports: one file diff per entry. */
function metadataDiff(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const m = metadata as { diff?: unknown; files?: unknown };
  if (typeof m.diff === "string" && m.diff) return m.diff;
  if (!Array.isArray(m.files)) return undefined;
  const diff = m.files
    .map((f) => (f && typeof f === "object" ? String((f as { patch?: unknown }).patch ?? "") : ""))
    .filter(Boolean)
    .join("\n");
  return diff || undefined;
}

/** A subagent's session, from the progress or result metadata it reports. */
function metadataSession(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const m = metadata as { sessionID?: unknown; sessionId?: unknown };
  const id = m.sessionID ?? m.sessionId;
  return typeof id === "string" && id ? id : undefined;
}

/** The first line of an OpenCode error's message (some append a stack). Reads
 *  both shapes: OpenCode 2's `{ type, message }` and the `{ data: { message } }`
 *  older payloads and some HTTP errors still use. */
function errorText(error: unknown): string | undefined {
  const err = error as { name?: string; message?: string; data?: { message?: string } } | undefined;
  const full = err?.data?.message ?? err?.message ?? err?.name;
  return typeof full === "string" && full ? full.split("\n")[0] : undefined;
}

/** A user message as it was typed: a skill run by "/name" travels as an
 *  attachment, so the name is put back in front of its words. */
function typedText(text: string, skills?: Array<{ id?: string }>): string {
  const names = (skills ?? []).map((s) => s.id).filter((id): id is string => !!id);
  return names.length ? [...names.map((id) => `/${id}`), text].filter(Boolean).join(" ") : text;
}

/** A stored reply's error. A user interrupt is kept in OpenCode 1's words
 *  (OpenCode 2 says "Step interrupted"), which readers know is no failure. */
const ABORTED_TEXT ="The operation was aborted.";
function messageErrorText(error: unknown): string | undefined {
  return (error as { type?: string } | undefined)?.type === "aborted" ? ABORTED_TEXT : errorText(error);
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

/** OpenCode's token shape (history and `session.step.ended`). Flattened into
 *  `MessageUsage` so callers never reach through `cache.` — and so a runtime
 *  that omits a field reads as 0 rather than NaN in a sum. */
interface RawTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

/** Normalize `tokens`/`cost` into `MessageUsage`. Undefined when the runtime
 *  reported no tokens at all; an all-zero object is real data (a step aborted
 *  before the first response used nothing). */
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

/** Split a "provider/model" string into OpenCode's model reference. Undefined
 *  when the string is empty or has no provider prefix. Splits on the FIRST
 *  slash: a model id may contain more. */
function parseModel(model?: string | null): { providerID: string; id: string } | undefined {
  if (!model) return undefined;
  const i = model.indexOf("/");
  if (i <= 0 || i >= model.length - 1) return undefined;
  return { providerID: model.slice(0, i), id: model.slice(i + 1) };
}

/** Canonical low→high ordering of reasoning-effort variants across providers.
 *  Known names sort by this rank; anything unrecognized keeps its original
 *  order after the known set. */
const VARIANT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
function orderVariants(names: string[]): string[] {
  const rank = (n: string) => {
    const i = VARIANT_ORDER.indexOf(n);
    return i === -1 ? VARIANT_ORDER.length : i;
  };
  return [...names].sort((a, b) => rank(a) - rank(b) || names.indexOf(a) - names.indexOf(b));
}

/** Same folder, compared as OpenCode reports it: a trailing slash is not a
 *  different folder, and macOS reports `/var` and `/tmp` under `/private`. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").replace(/^\/private(?=\/(var|tmp)\/)/, "");
  return norm(a) === norm(b);
}

// ---- OpenCode 2 wire shapes (the subset this client reads) ----

interface WireSession {
  id: string;
  parentID?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  time?: { created?: number; updated?: number };
  model?: { id?: string; providerID?: string; variant?: string };
  location?: { directory?: string };
}

type WireToolState =
  | { status: "streaming"; input?: string }
  | { status: "running"; input?: Record<string, unknown>; metadata?: Record<string, unknown> }
  | { status: "completed"; input?: Record<string, unknown>; content?: unknown; metadata?: Record<string, unknown> }
  | { status: "error"; input?: Record<string, unknown>; error?: unknown; content?: unknown; metadata?: Record<string, unknown> };

type WireContent =
  | { type: "text"; text?: string }
  | { type: "reasoning"; text?: string }
  | { type: "tool"; id?: string; name?: string; state?: WireToolState; time?: { created?: number; ran?: number; completed?: number } };

interface WireMessage {
  id: string;
  type: string;
  time?: { created?: number; completed?: number };
  metadata?: Record<string, unknown>;
  // user / synthetic
  text?: string;
  /** A synthetic message's one-line notice (a goal's kickoff has one). */
  description?: string;
  files?: Array<{ mime?: string; name?: string; data?: string; source?: { type?: string; uri?: string } }>;
  /** Skills the user ran by "/name" (OpenCode 2 sends them as attachments). */
  skills?: Array<{ id?: string }>;
  // assistant
  agent?: string;
  content?: WireContent[];
  cost?: number;
  tokens?: RawTokens;
  error?: unknown;
  // shell
  command?: string;
  status?: string;
  shellID?: string;
  output?: { output?: string };
  // compaction
  reason?: string;
}

interface WireForm {
  id: string;
  sessionID: string;
  title?: string;
  fields?: Array<{
    key: string;
    type: string;
    title?: string;
    description?: string;
    options?: Array<{ value: string; label: string; description?: string }>;
    custom?: boolean;
  }>;
}

interface WirePermission {
  id: string;
  sessionID: string;
  action?: string;
  resources?: string[];
}

/** The tool states the app's history reader knows. */
function historyToolStatus(status: string | undefined): string {
  if (status === "streaming") return "pending";
  return status ?? "pending";
}

/** OpenCode 2's typed messages, rewritten as the app's history: user and
 *  assistant messages with parts. Exported for the tests, which pin the
 *  translation down against recorded payloads. */
export function toHistory(wire: WireMessage[]): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  // A step is its own assistant message, and a turn only ends at an `idle`
  // record. A turn still running when history is read therefore ends in a
  // COMPLETED step — which the app would take for a finished turn. Track the
  // last assistant message since the last turn boundary so it can be
  // reopened when no `idle` closed the turn.
  let openAssistant: HistoryMessage | null = null;
  let turnClosed = true;
  // The agent each user message ran under: the next assistant step names it.
  let pendingUsers: HistoryMessage[] = [];
  let agent: string | undefined;

  const assignAgent = (name: string | undefined) => {
    if (!name) return;
    agent = name;
    for (const u of pendingUsers) u.agent ??= name;
    pendingUsers = [];
  };

  for (const m of wire) {
    const created = m.time?.created;
    switch (m.type) {
      case "agent-switched":
        assignAgent(m.agent);
        break;
      case "user": {
        const parts: HistoryPart[] = [{ type: "text", text: typedText(m.text ?? "", m.skills) }];
        for (const f of m.files ?? []) parts.push({ type: "file", text: f.name ?? "" });
        const msg: HistoryMessage = { role: "user", id: m.id, ...(created ? { created } : {}), parts };
        pendingUsers.push(msg);
        out.push(msg);
        turnClosed = false;
        openAssistant = null;
        break;
      }
      case "synthetic": {
        const mine = (m.metadata?.[META_NS] ?? {}) as { source?: unknown };
        if (mine.source === "background-review") {
          // The app's own background review, persisted after its checkpoint:
          // it reads back as the assistant's text, as it did when it was a
          // part appended to the checkpoint message.
          out.push({
            role: "assistant",
            id: m.id,
            ...(created ? { created, completed: created } : {}),
            parts: [{ type: "text", text: m.text ?? "", synthetic: true }],
          });
        } else if (m.metadata?.source === "goal" && m.description?.startsWith("Goal: ")) {
          // A goal's kickoff: the user typed `/goal <objective>`, and that is
          // what the thread shows, not the kickoff prompt it expanded to.
          const msg: HistoryMessage = {
            role: "user",
            id: m.id,
            ...(created ? { created } : {}),
            parts: [{ type: "text", text: `/goal ${m.description.slice("Goal: ".length)}` }],
          };
          pendingUsers.push(msg);
          out.push(msg);
          turnClosed = false;
          openAssistant = null;
        }
        // Every other synthetic input — a goal's continuation, a finished
        // background subagent's notice — is the runtime talking to the model.
        // The thread never showed those, and as a user-role message the app
        // would read it as the marker of a "!" shell run. It still starts a
        // turn, which only an idle record ends.
        else {
          turnClosed = false;
          openAssistant = null;
        }
        break;
      }
      case "assistant": {
        assignAgent(m.agent);
        const parts: HistoryPart[] = [];
        for (const c of m.content ?? []) {
          if (c.type === "text") parts.push({ type: "text", text: c.text ?? "" });
          else if (c.type === "reasoning") parts.push({ type: "reasoning", text: c.text ?? "" });
          else if (c.type === "tool") {
            const name = c.name ?? "";
            const st = c.state;
            const input = st && typeof st.input === "object" ? appToolInput(name, st.input) : undefined;
            const metadata = st && "metadata" in st ? st.metadata : undefined;
            const output = st && "content" in st ? contentText(st.content) : undefined;
            const diff = metadataDiff(metadata);
            const child = metadataSession(metadata);
            parts.push({
              type: "tool",
              tool: appToolName(name),
              callID: c.id ?? "",
              state: {
                status: historyToolStatus(st?.status),
                ...(input ? { input } : {}),
                ...(output !== undefined ? { output } : {}),
                ...(st?.status === "error" ? { error: errorText(st.error) ?? "Tool failed" } : {}),
                time: {
                  ...(c.time?.ran ?? c.time?.created ? { start: c.time?.ran ?? c.time?.created } : {}),
                  ...(c.time?.completed ? { end: c.time.completed } : {}),
                },
                ...(diff || child ? { metadata: { ...(diff ? { diff } : {}), ...(child ? { sessionId: child } : {}) } } : {}),
              },
            });
          }
        }
        const error = messageErrorText(m.error);
        const usage = toUsage(m.tokens, m.cost);
        const msg: HistoryMessage = {
          role: "assistant",
          id: m.id,
          ...(created ? { created } : {}),
          ...(m.time?.completed ? { completed: m.time.completed } : {}),
          ...(error ? { error } : {}),
          ...(m.agent ? { agent: m.agent } : {}),
          ...(usage ? { usage } : {}),
          parts,
        };
        out.push(msg);
        openAssistant = msg;
        break;
      }
      case "shell": {
        // A "!" command the user ran: the app reads it as a synthetic user
        // marker followed by a bash tool result, as OpenCode 1 stored it.
        const status = m.status === "running" ? "running" : m.status === "exited" ? "completed" : "error";
        out.push({ role: "user", id: `${m.id}:user`, ...(created ? { created } : {}), parts: [{ type: "text", text: "", synthetic: true }] });
        out.push({
          role: "assistant",
          id: m.id,
          ...(created ? { created } : {}),
          ...(m.time?.completed ? { completed: m.time.completed } : {}),
          parts: [
            {
              type: "tool",
              tool: "bash",
              callID: m.shellID ?? m.id,
              state: {
                status,
                input: { command: m.command ?? "" },
                ...(m.output?.output !== undefined ? { output: m.output.output } : {}),
                ...(status === "error" ? { error: m.status === "timeout" ? "Timed out" : "Stopped" } : {}),
                time: { ...(created ? { start: created } : {}), ...(m.time?.completed ? { end: m.time.completed } : {}) },
              },
            },
          ],
        });
        break;
      }
      case "compaction":
        if (m.status === "running") break;
        out.push({
          role: "user",
          id: m.id,
          ...(created ? { created } : {}),
          parts: [{ type: "compaction", auto: m.reason !== "manual" }],
        });
        break;
      case "idle":
        turnClosed = true;
        openAssistant = null;
        break;
      default:
        break; // model/location switches, system notes, skill activations
    }
  }
  // The turn the history ends in is still running: its last step's
  // `completed` is not the turn's.
  if (!turnClosed && openAssistant) delete openAssistant.completed;
  for (const u of pendingUsers) if (agent) u.agent ??= agent;
  return out;
}

/** A form, in the shape of the app's question cards: one question per field. */
function toQuestions(form: WireForm): QuestionItem[] {
  return (form.fields ?? []).map((f) => {
    const options =
      f.type === "boolean"
        ? [{ label: "Yes" }, { label: "No" }]
        : (f.options ?? []).map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) }));
    return {
      question: f.title ?? f.description ?? f.key,
      header: form.title ?? "",
      options,
      multiple: f.type === "multiselect",
      // A field without options is answered in words.
      custom: f.custom ?? (options.length === 0),
    };
  });
}

/**
 * The single boundary between the app and the OpenCode agent runtime.
 * Talks to a running `opencode serve` over its HTTP + SSE API. The UI must go
 * through this class, never the transport directly (see AGENTS.md guardrails).
 */
export class OpenCodeClient extends BaseAgentRuntime implements AgentRuntime {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly authHeader: string | null;
  /** Base64 `opencode:password` for `?auth_token=` — the EventSource cannot set
   *  headers, and the server accepts the same Basic payload as a query param. */
  private readonly authToken: string | null;
  /** Workspace folder this client is scoped to. OpenCode serves many folders
   *  from ONE process: folder-scoped reads carry `location[directory]`, a new
   *  session is created in it, and the (global) event stream is filtered to
   *  the sessions that live in it. */
  private readonly directory: string | null;
  private readonly config: ConfigStore | null;
  private abort: AbortController | null = null;
  private es: EventSource | null = null;
  /** Closes a stream opened through `eventStream` (see OpenCodeClientOptions). */
  private closeStream: (() => void) | null = null;
  private readonly eventStream: EventStreamOpener | null;
  /** Pending self-heal of a dead event stream (see reconnectSoon). */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** True between close() and the next connect() — stops self-healing. */
  private closed = false;
  private readonly customFetch: boolean;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly onHistoryUpgrade: ((progress: HistoryUpgrade | null) => void) | null;

  // ---- event-stream state ----
  /** sessionID → its folder. The stream is global; this is how a client keeps
   *  to its own folder's sessions. */
  private readonly sessionDirs = new Map<string, string>();
  /** Events for a session whose folder is still being looked up, in order. */
  private readonly held = new Map<string, OpenCodeRawEvent[]>();
  /** `${messageID}#${ordinal}` → accumulated streaming text. */
  private readonly textStreams = new Map<string, { sessionId: string; text: string; messageID: string }>();
  private readonly reasoningStreams = new Map<string, { sessionId: string; text: string }>();
  /** sessionId → the assistant messages (steps) begun this turn. */
  private readonly stepParts = new Map<string, Set<string>>();
  /** callID → what a tool call is, learned when it starts: its later events
   *  carry only the id. */
  private readonly toolCalls = new Map<
    string,
    {
      sessionId: string;
      /** The app's name for the tool, and OpenCode's own (inputs differ by it). */
      tool: string;
      wire: string;
      input?: Record<string, unknown>;
      startedAt?: number;
      child?: string;
    }
  >();
  /** callID → the poller reading a running shell tool's output. */
  private readonly shellPolls = new Map<string, ReturnType<typeof setInterval>>();
  /** step id → when it began, for the usage stamped at its end. */
  private readonly stepStarted = new Map<string, number>();
  /** requestID → sessionID for open questions (forms) and permission asks:
   *  OpenCode answers them under the session, the app knows only the id. */
  private readonly requestSessions = new Map<string, string>();
  /** formID → its fields, to turn the app's chosen labels into values. */
  private readonly forms = new Map<string, WireForm>();
  /** sessionID → the agent/model it is bound to, as this client last set it. */
  private readonly boundAgent = new Map<string, string>();
  private readonly boundModel = new Map<string, string>();
  /** providerID → the OAuth attempt `oauthAuthorize` started. */
  private readonly oauthAttempts = new Map<string, { attemptID: string; mode: "auto" | "code" }>();

  constructor(opts: OpenCodeClientOptions = {}) {
    super();
    this.baseUrl = (opts.baseUrl ?? DEFAULT_OPENCODE_URL).replace(/\/$/, "");
    this.customFetch = !!opts.fetchImpl;
    // Bind to globalThis — an unbound `fetch` reference throws "Illegal invocation" in browsers.
    this.fetchImpl = (opts.fetchImpl ?? globalThis.fetch).bind(globalThis);
    // OpenCode 2's username is always "opencode".
    this.authToken = opts.password ? btoa(`${opts.username ?? "opencode"}:${opts.password}`) : null;
    this.authHeader = this.authToken ? `Basic ${this.authToken}` : null;
    this.directory = opts.directory ?? null;
    this.config = opts.config ?? null;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 5000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15000;
    this.eventStream = opts.eventStream ?? null;
    this.onHistoryUpgrade = opts.onHistoryUpgrade ?? null;
  }

  // ---- transport ----

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h["Content-Type"] = "application/json";
    if (this.authHeader) h["Authorization"] = this.authHeader;
    return h;
  }

  /** `path` plus a query string; `scoped` adds this client's folder as the
   *  `location` OpenCode resolves folder-scoped reads in. */
  private url(path: string, query: Record<string, string | undefined> = {}, scoped = false): string {
    const params = new URLSearchParams();
    if (scoped && this.directory) params.set("location[directory]", this.directory);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, v);
    const q = params.toString();
    return `${this.baseUrl}${path}${q ? `?${q}` : ""}`;
  }

  private sessionPath(sessionId: string, rest = ""): string {
    return `/api/session/${encodeURIComponent(sessionId)}${rest}`;
  }

  private async fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs = this.requestTimeoutMs): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const outer = init.signal;
    const onOuter = () => controller.abort();
    outer?.addEventListener("abort", onOuter);
    try {
      return await this.fetchImpl(input, { ...init, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted && !outer?.aborted) throw new Error("Timed out waiting for OpenCode");
      throw err;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuter);
    }
  }

  private get(url: string): Promise<Response> {
    return this.fetchWithTimeout(url, { headers: this.headers() });
  }

  private send(method: string, url: string, body?: unknown): Promise<Response> {
    return this.fetchWithTimeout(url, {
      method,
      headers: this.headers(body !== undefined),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  /** A response's `data`, failing with the server's reason when not ok. */
  private async data<T>(res: Response, what: string): Promise<T> {
    if (!res.ok) throw await this.apiError(res, what);
    const body = (await res.json()) as { data?: T };
    return body.data as T;
  }

  /** Build an Error carrying the server's diagnostic message, when it has one.
   *  Shapes that reach here: OpenCode 2's (`{ _tag, message }`), older
   *  `{ data: { message } }`, and the gateway's (`{ error }`) — when the web
   *  client's call is refused by gateway policy rather than by OpenCode, the
   *  reason is in `error`, and dropping it turns an explained refusal into a
   *  bare status code (#119). */
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

  /** The /api/event stream URL; auth rides as auth_token (EventSource has no headers). */
  private eventUrl(): string {
    return this.url("/api/event", this.authToken ? { auth_token: this.authToken } : {});
  }

  // ---- event stream ----

  /** Open the SSE event stream. Resolves once the server acknowledges. */
  async connect(): Promise<void> {
    this.closed = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.setStatus("connecting");
    try {
      await this.awaitHistoryUpgrade();
    } catch (err) {
      this.setStatus("error");
      throw err;
    }
    return this.openStream();
  }

  /** OpenCode 2 serves while it converts OpenCode 1 history in the background,
   *  and a session it has not reached yet answers 404: the first launch after
   *  the upgrade showed "Session not found" for the tab it reopened. So the
   *  client is not ready until the conversion is over. A server without this
   *  endpoint (a gateway that does not pass it) has nothing to wait for; a
   *  conversion that failed leaves what it did convert, so that ends it too. */
  private async awaitHistoryUpgrade(): Promise<void> {
    for (;;) {
      const res = await this.get(this.url("/api/experimental/migration/v1"));
      const body = (await res.json().catch(() => null)) as {
        status?: string;
        progress?: { numerator?: number | null; denominator?: number | null };
      } | null;
      if (!res.ok || body?.status !== "running") break;
      this.onHistoryUpgrade?.({ done: body.progress?.numerator ?? null, total: body.progress?.denominator ?? null });
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (this.closed) throw new Error("Closed while OpenCode was upgrading history");
    }
    this.onHistoryUpgrade?.(null);
  }

  private openStream(): Promise<void> {
    // Someone else carries the stream: the same open / message / error rules
    // as the EventSource below, reconnection included.
    const opener = this.eventStream;
    if (opener) {
      return new Promise((resolve, reject) => {
        let opened = false;
        let finished = false;
        let stop: (() => void) | null = null;
        const release = () => {
          stop?.();
          if (this.closeStream === stop) this.closeStream = null;
        };
        const timer = setTimeout(() => {
          if (finished) return;
          finished = true;
          this.setStatus("error");
          release();
          reject(new Error("Timed out opening OpenCode event stream"));
        }, this.connectTimeoutMs);
        stop = opener(this.directory, {
          onOpen: () => {
            if (finished) return;
            opened = true;
            finished = true;
            clearTimeout(timer);
            this.setStatus("ready");
            resolve();
          },
          onMessage: (data) => this.handleFrame(data),
          onError: () => {
            if (!opened) {
              if (finished) return;
              finished = true;
              clearTimeout(timer);
              this.setStatus("error");
              release();
              reject(new Error("Could not open OpenCode event stream"));
            } else if (this.closeStream === stop) {
              release();
              this.reconnectSoon();
            }
          },
        });
        this.closeStream = stop;
      });
    }

    // Prefer EventSource in a real webview/browser (reliable SSE, incl. macOS
    // WKWebView). Fall back to streaming fetch for node/tests.
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
        es.onmessage = (ev) => this.handleFrame(ev.data);
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
            // Take over reconnection ourselves: EventSource's own retry never
            // recovers when the server ends the stream terminally (a sidecar
            // restart). Reopen with backoff; a deliberate close() cancels it.
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
            reject(new Error(`OpenCode /api/event returned ${res.status}`));
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
    this.closeStream?.();
    this.closeStream = null;
    this.abort?.abort();
    this.abort = null;
    for (const timer of this.shellPolls.values()) clearInterval(timer);
    this.shellPolls.clear();
    this.setStatus("offline");
  }

  /** Reopen the event stream after it died post-open, with backoff. Gives up
   *  into "error" so the banner offers the manual Connect. */
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
          const dataLines = chunk
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim());
          if (dataLines.length > 0) this.handleFrame(dataLines.join("\n"));
        }
      }
    } catch {
      // aborted or connection dropped
    } finally {
      this.setStatus("offline");
    }
  }

  private handleFrame(data: string): void {
    let raw: OpenCodeRawEvent;
    try {
      raw = JSON.parse(data) as OpenCodeRawEvent;
    } catch {
      return; // malformed frame
    }
    if (raw && typeof raw.type === "string") this.accept(raw);
  }

  /** Keep to this client's folder. The stream carries every folder's events;
   *  most say where they happened, and those that do not are attributed by
   *  their session. A session not seen yet is looked up once, and its events
   *  wait (in order) for the answer rather than being guessed at. */
  private accept(ev: OpenCodeRawEvent): void {
    const mine = this.directory;
    if (!mine) return this.normalize(ev);
    const sid = sessionOf(ev);
    const where = ev.location?.directory;
    if (sid && where) this.sessionDirs.set(sid, where);
    if (!sid) {
      if (!where || samePath(where, mine)) this.normalize(ev);
      return;
    }
    const known = this.sessionDirs.get(sid);
    if (known !== undefined) {
      if (samePath(known, mine)) this.normalize(ev);
      return;
    }
    const queue = this.held.get(sid);
    if (queue) {
      queue.push(ev);
      return;
    }
    this.held.set(sid, [ev]);
    void this.sessionDirectory(sid).then((dir) => {
      // Unknown even to the server: deliver rather than drop — a duplicate is
      // folded idempotently, a lost event is not recovered.
      this.sessionDirs.set(sid, dir ?? mine);
      const pending = this.held.get(sid) ?? [];
      this.held.delete(sid);
      for (const e of pending) this.accept(e);
    });
  }

  private async sessionDirectory(sessionId: string): Promise<string | undefined> {
    try {
      const res = await this.get(this.url(this.sessionPath(sessionId)));
      if (!res.ok) return undefined;
      const s = (await res.json()) as { data?: WireSession };
      return s.data?.location?.directory;
    } catch {
      return undefined;
    }
  }

  // ---- sessions ----

  /** Create a new agent session in this client's folder, returning its id. */
  async createSession(title?: string): Promise<string> {
    const s = await this.data<WireSession>(
      await this.send("POST", this.url("/api/session"), {
        ...(title ? { title } : {}),
        ...(this.directory ? { location: { directory: this.directory } } : {}),
      }),
      "Failed to create session",
    );
    if (this.directory) this.sessionDirs.set(s.id, this.directory);
    return s.id;
  }

  /** Fork a completed checkpoint so a specialist can work with the parent's
   *  context without occupying or writing into the foreground conversation.
   *  The boundary is exclusive: the named message is NOT copied. */
  async forkSession(sessionId: string, beforeMessageId?: string): Promise<string> {
    const s = await this.data<WireSession>(
      await this.send("POST", this.url(this.sessionPath(sessionId, "/fork")), beforeMessageId ? { before: beforeMessageId } : {}),
      "Failed to fork session",
    );
    return s.id;
  }

  /** The recent conversations the sidebar shows: newest first, across every
   *  workspace folder, archived ones excluded. Bounded by RECENT_WINDOW. */
  async listSessions(): Promise<SessionMeta[]> {
    const page = await this.querySessions({ limit: RECENT_WINDOW });
    return page.sessions.slice(0, RECENT_WINDOW);
  }

  /** One page of conversation history, newest first, across every workspace
   *  folder. Searching and paging run on the server. Archived conversations
   *  are dropped unless `archived` is set — that flag is ours (META_NS), so
   *  the filter runs here, and pages are topped up so filtering never hands
   *  back a nearly-empty page. */
  async querySessions(query: SessionQuery = {}): Promise<SessionPage> {
    const limit = query.limit ?? SESSION_PAGE;
    const out: SessionMeta[] = [];
    const seen = new Set<string>();
    let cursor = query.cursor ?? null;
    for (let attempt = 0; attempt < RECENT_MAX_PAGES; attempt++) {
      const params: Record<string, string | undefined> = { limit: String(limit), order: "desc" };
      if (cursor != null) {
        params.cursor = String(cursor);
        delete params.order; // a cursor carries its own order
      }
      if (query.search) params.search = query.search;
      const res = await this.get(this.url("/api/session", params));
      if (!res.ok) throw await this.apiError(res, "Failed to list sessions");
      const body = (await res.json()) as { data?: WireSession[]; cursor?: { next?: string | null } };
      const rows = body.data ?? [];
      const fresh = rows.filter((s) => !seen.has(s.id));
      fresh.forEach((s) => seen.add(s.id));
      for (const s of fresh) if (s.location?.directory) this.sessionDirs.set(s.id, s.location.directory);
      const metas = fresh.map(toSessionMeta);
      out.push(...(query.archived ? metas : metas.filter((s) => s.archived == null)));
      cursor = rows.length < limit ? null : body.cursor?.next ?? null;
      if (cursor === null || out.length >= limit || fresh.length === 0) break;
    }
    return { sessions: out, nextCursor: cursor };
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    const res = await this.get(this.url(this.sessionPath(sessionId)));
    if (res.status === 404) return false;
    if (!res.ok) throw await this.apiError(res, "Failed to read the session");
    return true;
  }

  /** Archive a conversation (or restore it with `false`). Recorded in the
   *  session's `metadata`, preserving anything else stored there. */
  async setSessionArchived(sessionId: string, archived: boolean): Promise<void> {
    const current = await this.data<WireSession>(
      await this.get(this.url(this.sessionPath(sessionId))),
      "Failed to read the session",
    );
    // PATCH replaces `metadata` wholesale, so merge rather than overwrite —
    // another client's keys must survive our edit.
    const metadata: Record<string, unknown> = { ...(current.metadata ?? {}) };
    const mine = { ...((metadata[META_NS] as Record<string, unknown>) ?? {}) };
    if (archived) mine.archived = Date.now();
    else delete mine.archived;
    if (Object.keys(mine).length > 0) metadata[META_NS] = mine;
    else delete metadata[META_NS];
    const res = await this.send("PATCH", this.url(this.sessionPath(sessionId)), { metadata });
    if (!res.ok) throw await this.apiError(res, "Failed to archive the session");
  }

  /** Persist an app-produced text after a completed checkpoint. A persistence
   *  operation only: unlike sendPrompt it starts no model turn. Stored as a
   *  synthetic message tagged as ours, which history reads back as the
   *  assistant's text. `messageId` is the checkpoint it belongs to. */
  async appendTextPart(
    sessionId: string,
    messageId: string,
    text: string,
    partId = OpenCodeClient.partId(),
  ): Promise<string> {
    const res = await this.send("POST", this.url(this.sessionPath(sessionId, "/synthetic")), {
      text,
      resume: false,
      // Namespaced like everything else we store (META_NS), and two levels
      // deep: a flat string where a record belongs once made the provider
      // reject the whole conversation (#114).
      metadata: { [META_NS]: { source: "background-review", messageID: messageId, partID: partId } },
    });
    if (!res.ok) throw await this.apiError(res, "Failed to persist background result");
    return partId;
  }

  /** A fresh id for an appended text, ascending like OpenCode's own. */
  private static partId(): string {
    const stamp = (BigInt(Date.now()) * 0x1000n + 1n).toString(16).padStart(12, "0");
    const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    const bytes = new Uint8Array(14);
    globalThis.crypto.getRandomValues(bytes);
    let random = "";
    for (const byte of bytes) random += alphabet[byte % alphabet.length];
    return `prt_${stamp}${random}`;
  }

  /** Rename a session — the user's own way out when the runtime's generated
   *  title is unreadable (#63). */
  async renameSession(sessionId: string, title: string): Promise<void> {
    const res = await this.send("PATCH", this.url(this.sessionPath(sessionId)), { title });
    if (!res.ok) throw await this.apiError(res, "Failed to rename session");
  }

  /** Delete a session. */
  async deleteSession(sessionId: string): Promise<void> {
    const res = await this.send("DELETE", this.url(this.sessionPath(sessionId)));
    if (!res.ok) throw await this.apiError(res, "Failed to delete session");
  }

  /** Load a session's whole history, oldest first. */
  async getMessages(sessionId: string): Promise<HistoryMessage[]> {
    const wire: WireMessage[] = [];
    let cursor: string | null = null;
    for (;;) {
      const params: Record<string, string> = { limit: String(MESSAGE_PAGE) };
      if (cursor) params.cursor = cursor;
      else params.order = "asc";
      const res = await this.get(this.url(this.sessionPath(sessionId, "/message"), params));
      if (!res.ok) throw await this.apiError(res, "Failed to load messages");
      const body = (await res.json()) as { data?: WireMessage[]; cursor?: { next?: string | null } };
      const rows = body.data ?? [];
      wire.push(...rows);
      cursor = body.cursor?.next ?? null;
      if (rows.length < MESSAGE_PAGE || !cursor) break;
    }
    // What appendTextPart stored waits in the session's inbox until the next
    // turn delivers it into history; until then it is read from there.
    const inbox = await this.get(this.url(this.sessionPath(sessionId, "/inbox")));
    if (inbox.ok) {
      const items = ((await inbox.json()) as {
        data?: Array<{ id: string; type: string; time?: { created?: number }; payload?: { text?: string; metadata?: Record<string, unknown> } }>;
      }).data ?? [];
      for (const item of items) {
        const mine = (item.payload?.metadata?.[META_NS] ?? {}) as { source?: unknown };
        if (item.type !== "synthetic" || mine.source !== "background-review") continue;
        wire.push({ id: item.id, type: "synthetic", time: item.time, text: item.payload?.text, metadata: item.payload?.metadata });
      }
    }
    return toHistory(wire);
  }

  /** Revert the session to (and including) a message: OpenCode drops that
   *  message and everything after it, rolling back the workspace files they
   *  touched. This is how the app edits a past user message — revert, then
   *  send the corrected text. The session must be idle (abort first).
   *
   *  OpenCode 2 stages a revert and keeps listing the staged messages until
   *  it is committed; the app drops them at once, so this commits too — a
   *  reload must not bring back what the user just removed. */
  async revert(sessionId: string, messageID: string, _partID?: string): Promise<void> {
    const staged = await this.send("POST", this.url(this.sessionPath(sessionId, "/revert/stage")), {
      messageID,
      files: true,
    });
    if (!staged.ok) throw await this.apiError(staged, "Failed to revert the message");
    const committed = await this.send("POST", this.url(this.sessionPath(sessionId, "/revert/commit")));
    if (!committed.ok) throw await this.apiError(committed, "Failed to revert the message");
  }

  /** Cancel a revert that is staged but not committed. `revert` commits, so
   *  this only matters for a revert staged by another client. */
  async unrevert(sessionId: string): Promise<void> {
    const res = await this.send("DELETE", this.url(this.sessionPath(sessionId, "/revert")));
    if (!res.ok) throw await this.apiError(res, "Failed to restore the reverted messages");
  }

  /** Interrupt the session's current turn. A no-op on an idle session. */
  async abortSession(sessionId: string): Promise<void> {
    const res = await this.send("POST", this.url(this.sessionPath(sessionId, "/interrupt")));
    if (!res.ok) throw await this.apiError(res, "Failed to interrupt the session");
  }

  /** Compact a session's conversation: OpenCode summarizes the older turns
   *  with the session's own model, so later turns run on a bounded context
   *  (the fix for long sessions that stall on giant prompts). A session that
   *  has not bound a model yet is first bound to the one given, or the
   *  default. */
  async compactSession(sessionId: string, providerID?: string, modelID?: string): Promise<void> {
    const model = providerID && modelID ? `${providerID}/${modelID}` : null;
    if (model) await this.bindModel(sessionId, model, null);
    const res = await this.send("POST", this.url(this.sessionPath(sessionId, "/compact")), {});
    if (!res.ok) throw await this.apiError(res, "Failed to compact the session");
  }

  // ---- capability discovery ----

  /** Every skill OpenCode has loaded for this workspace: built-in, the app's
   *  bundled packs, `.opencode/skills/`, and the home-level skill folders. */
  async listSkills(): Promise<SkillInfo[]> {
    const rows = await this.skillRows();
    // Discovery order is scan order — sort so the list is stable across reloads.
    return rows
      .map((s) => ({ name: s.name ?? s.id, description: s.description ?? "", ...(s.path ? { location: s.path } : {}) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Agents a user can pick: hidden ones (title, compaction, summary) are the
   *  runtime's own. */
  async listAgents(): Promise<AgentInfo[]> {
    const rows = await this.data<Array<{ id: string; name?: string; description?: string; mode?: string; hidden?: boolean }>>(
      await this.get(this.url("/api/agent", {}, true)),
      "Failed to list agents",
    );
    return (rows ?? [])
      .filter((a) => !a.hidden)
      .map((a) => ({ name: a.id, description: a.description ?? "", ...(a.mode ? { mode: a.mode } : {}) }));
  }

  /** Slash commands the runtime can run: config commands and MCP prompts,
   *  then skills. OpenCode 1 listed skills as commands; OpenCode 2 keeps them
   *  apart, so they are merged back here. A command wins a shared name. */
  async listCommands(): Promise<CommandInfo[]> {
    const [rows, skills] = await Promise.all([
      this.data<Array<{ name: string; description?: string }>>(
        await this.get(this.url("/api/command", {}, true)),
        "Failed to list commands",
      ),
      this.skillRows().catch(() => []),
    ]);
    const commands: CommandInfo[] = (rows ?? []).map((c) => ({
      name: c.name,
      ...(c.description ? { description: c.description } : {}),
    }));
    const taken = new Set(commands.map((c) => c.name));
    for (const s of skills) {
      if (taken.has(s.id)) continue;
      commands.push({ name: s.id, source: "skill", ...(s.description ? { description: s.description } : {}) });
    }
    return commands;
  }

  private async skillRows(): Promise<Array<{ id: string; name?: string; description?: string; path?: string }>> {
    return (
      (await this.data<Array<{ id: string; name?: string; description?: string; path?: string }>>(
        await this.get(this.url("/api/skill", {}, true)),
        "Failed to list skills",
      )) ?? []
    );
  }

  // ---- model selection ----

  /** The configured default model ("provider/model"), or null when unset. */
  async getDefaultModel(): Promise<string | null> {
    if (this.config) {
      const model = (await this.config.read()).model;
      return typeof model === "string" && model ? model : null;
    }
    const res = await this.get(this.url("/api/model/default", {}, true));
    if (!res.ok) throw await this.apiError(res, "Failed to read config");
    const body = (await res.json()) as { data?: { providerID?: string; id?: string } | null };
    return body.data?.providerID && body.data.id ? `${body.data.providerID}/${body.data.id}` : null;
  }

  /** Set the default model in OpenCode's global (app-profile) config. The
   *  runtime picks the edit up within a second; the event stream stays open. */
  async setDefaultModel(model: string): Promise<void> {
    await this.patchConfig({ model }, "Failed to set model");
  }

  /** Providers OpenCode can use right now, with their models. */
  async listProviders(): Promise<ProviderInfo[]> {
    const [modelsRes, providersRes] = await Promise.all([
      this.get(this.url("/api/model", {}, true)),
      this.get(this.url("/api/provider", {}, true)),
    ]);
    const models = await this.data<
      Array<{
        id: string;
        providerID: string;
        name?: string;
        type?: string;
        enabled?: boolean;
        variants?: Array<{ id: string }>;
        limit?: { context?: number };
        cost?: Array<{ input?: number; output?: number }>;
      }>
    >(modelsRes, "Failed to list providers");
    const providers = providersRes.ok
      ? ((await providersRes.json()) as { data?: Array<{ id: string; name?: string }> }).data ?? []
      : [];
    const names = new Map(providers.map((p) => [p.id, p.name ?? p.id]));
    const byProvider = new Map<string, ProviderInfo>();
    for (const m of models ?? []) {
      // Chat models only: image and decision models cannot run a session.
      if (m.enabled === false || (m.type && m.type !== "chat")) continue;
      let p = byProvider.get(m.providerID);
      if (!p) {
        p = { id: m.providerID, name: names.get(m.providerID) ?? m.providerID, models: [] };
        byProvider.set(m.providerID, p);
      }
      const tiers = Array.isArray(m.cost) ? m.cost : [];
      p.models.push({
        id: m.id,
        name: m.name ?? m.id,
        variants: orderVariants((m.variants ?? []).map((v) => v.id)),
        // 0 and "absent" mean the same thing: an unknown window.
        contextLimit: m.limit?.context ?? 0,
        ...(tiers.length > 0 ? { free: tiers.every((t) => t.input === 0 && t.output === 0) } : {}),
      });
    }
    return [...byProvider.values()];
  }

  // ---- config (custom providers, MCP servers, regions) ----

  private async readConfig(): Promise<Record<string, unknown>> {
    if (!this.config) return {};
    try {
      return await this.config.read();
    } catch {
      return {};
    }
  }

  private async patchConfig(patch: Record<string, unknown>, what: string): Promise<void> {
    if (!this.config) throw new Error(`${what}: settings are not writable here`);
    try {
      await this.config.patch(patch);
    } catch (err) {
      throw new Error(`${what} (${err instanceof Error ? err.message : String(err)})`);
    }
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
    // value wins, else a real limit already in the config is kept, else we
    // write nothing. A guessed default is worse than none — the runtime treats
    // our number as the hard window (#52).
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
    await this.patchConfig(
      {
        provider: {
          [id]: {
            name: opts.name,
            npm: opts.npm,
            options: { baseURL: opts.baseURL, ...(opts.apiKey ? { apiKey: opts.apiKey } : {}) },
            models,
          },
        },
      },
      "Failed to add the provider",
    );
  }

  /** Model entries already configured for a custom provider, keyed by id. */
  private async customProviderModels(id: string): Promise<Record<string, CustomProviderModelConfig>> {
    const cfg = await this.customProviderConfig();
    return cfg[id]?.models ?? {};
  }

  private async customProviderConfig(): Promise<CustomProviderConfig> {
    const cfg = await this.readConfig();
    return (cfg.provider as CustomProviderConfig | undefined) ?? {};
  }

  /**
   * Undo the blind context limit older versions wrote for custom models whose
   * real window was unknown (#52): reset only limits matching the exact default
   * we used to write — {context:128000, output:0} — back to context 0, which
   * makes the runtime skip overflow accounting. Context 0 is written rather
   * than the key dropped because the config patch merges. Idempotent and
   * best-effort: call it after connecting.
   */
  async clearDefaultCustomModelContextLimits(): Promise<void> {
    if (!this.config) return;
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
    await this.patchConfig({ provider: patch }, "Failed to reset default model context limits");
  }

  /** Ids of custom providers defined in the global config (removable via the app). */
  async listCustomProviderIds(): Promise<string[]> {
    return Object.keys(await this.customProviderConfig());
  }

  /** Configured MCP servers with live status, joined with their config. */
  async listMcpServers(): Promise<McpServer[]> {
    const [statusRes, cfg] = await Promise.all([this.get(this.url("/api/mcp", {}, true)), this.readConfig()]);
    const rows = await this.data<Array<{ name: string; status?: { status?: string } }>>(
      statusRes,
      "Failed to list MCP servers",
    );
    const status = new Map((rows ?? []).map((r) => [r.name, r.status?.status ?? "pending"]));
    const configured = (cfg.mcp as Record<string, McpConfig> | undefined) ?? {};
    const names = new Set([...status.keys(), ...Object.keys(configured)]);
    return [...names].sort().map((name) => ({
      name,
      status: status.get(name) ?? "pending",
      ...(configured[name] ? { config: configured[name] } : {}),
    }));
  }

  /** Add (or update) an MCP server in the global config. Applies live. */
  async addMcpServer(name: string, config: McpConfig): Promise<void> {
    await this.patchConfig({ mcp: { [name]: config } }, "Failed to add the MCP server");
  }

  /** Start OAuth for an already-registered remote MCP server: open the
   *  returned `authorizationUrl` in the user's browser, then poll
   *  `listMcpServers` for `status === "connected"`. OpenCode 2 runs MCP sign-in
   *  as an integration of the server's own. */
  async startMcpOAuth(name: string): Promise<McpOAuthStart> {
    const rows = await this.data<Array<{ name: string; integrationID?: string }>>(
      await this.get(this.url("/api/mcp", {}, true)),
      "Failed to start MCP sign-in",
    );
    const integration = rows?.find((r) => r.name === name)?.integrationID;
    if (!integration) throw new Error(`Failed to start MCP sign-in (${name} does not use OAuth)`);
    const auth = await this.oauthStart(integration, undefined);
    return { authorizationUrl: auth.url, oauthState: auth.attemptID };
  }

  // ---- provider sign-in (OpenCode 2 "integrations") ----

  private async integrations(): Promise<
    Array<{
      id: string;
      name?: string;
      methods?: Array<{ id?: string; type: string; label?: string; names?: string[]; form?: Array<{ key: string; type: string; title?: string; options?: Array<{ value: string; label: string }> }> }>;
      connections?: Array<{ type: string; id?: string }>;
    }>
  > {
    return (
      (await this.data(await this.get(this.url("/api/integration", {}, true)), "Failed to list the provider catalog")) ?? []
    );
  }

  /** Every provider OpenCode knows how to connect, and which are connected. */
  async listProviderCatalog(): Promise<{ all: ProviderCatalogEntry[]; connected: string[] }> {
    const rows = await this.integrations();
    return {
      all: rows.map((r) => ({
        id: r.id,
        name: r.name ?? r.id,
        env: (r.methods ?? []).flatMap((m) => (m.type === "env" ? m.names ?? [] : [])),
      })),
      connected: rows.filter((r) => (r.connections ?? []).length > 0).map((r) => r.id),
    };
  }

  /** Every provider's sign-in methods, in the order `oauthAuthorize` indexes. */
  async listAuthMethods(): Promise<Record<string, ProviderAuthMethod[]>> {
    const rows = await this.integrations();
    return Object.fromEntries(
      rows.map((r) => [
        r.id,
        (r.methods ?? [])
          .filter((m) => m.type === "oauth" || m.type === "key")
          .map((m) => ({
            type: m.type === "oauth" ? ("oauth" as const) : ("api" as const),
            label: m.label ?? (m.type === "key" ? "API key" : "Sign in"),
            ...(m.form?.length
              ? {
                  prompts: m.form.map((f) => ({
                    type: f.options?.length ? ("select" as const) : ("text" as const),
                    key: f.key,
                    message: f.title ?? f.key,
                    ...(f.options?.length ? { options: f.options.map((o) => ({ label: o.label, value: o.value })) } : {}),
                  })),
                }
              : {}),
          })),
      ]),
    );
  }

  /** Store an API key for a provider. Applies live. */
  async setProviderApiKey(providerID: string, key: string): Promise<void> {
    const res = await this.send(
      "POST",
      this.url(`/api/integration/${encodeURIComponent(providerID)}/connect/key`, {}, true),
      { key },
    );
    if (!res.ok) throw await this.apiError(res, "Failed to save the key");
  }

  /** Read a provider's configured AWS-style region, when present. */
  async getProviderRegion(providerID: string): Promise<string | null> {
    const cfg = await this.customProviderConfig();
    const region = (cfg[providerID]?.options as { region?: unknown } | undefined)?.region;
    return typeof region === "string" && region ? region : null;
  }

  /** Set a provider's AWS-style region in the global config. Applies live. */
  async setProviderRegion(providerID: string, region: string): Promise<void> {
    await this.patchConfig({ provider: { [providerID]: { options: { region } } } }, "Failed to set provider region");
  }

  /** Remove a provider's stored credentials. */
  async removeProviderAuth(providerID: string): Promise<void> {
    const creds = await this.data<Array<{ id: string; integrationID: string }>>(
      await this.get(this.url("/api/credential")),
      "Failed to disconnect",
    );
    for (const c of (creds ?? []).filter((c) => c.integrationID === providerID)) {
      const res = await this.send("DELETE", this.url(`/api/credential/${encodeURIComponent(c.id)}`));
      if (!res.ok && res.status !== 404) throw await this.apiError(res, "Failed to disconnect");
    }
  }

  private async oauthStart(
    integrationID: string,
    method: number | undefined,
    inputs?: Record<string, string>,
  ): Promise<{ attemptID: string; url: string; instructions: string; mode: "auto" | "code" }> {
    const rows = await this.integrations();
    const oauth = (rows.find((r) => r.id === integrationID)?.methods ?? []).filter(
      (m) => m.type === "oauth" || m.type === "key",
    );
    // `method` indexes the list `listAuthMethods` returned; an MCP server's
    // sign-in has one method.
    const chosen = method === undefined ? oauth.find((m) => m.type === "oauth") : oauth[method];
    if (!chosen?.id || chosen.type !== "oauth") throw new Error("Failed to start the login (no such sign-in method)");
    const auth = await this.data<{ attemptID: string; url: string; instructions: string; mode: "auto" | "code" }>(
      await this.send("POST", this.url(`/api/integration/${encodeURIComponent(integrationID)}/connect/oauth`, {}, true), {
        methodID: chosen.id,
        ...(inputs && Object.keys(inputs).length ? { answer: inputs } : {}),
      }),
      "Failed to start the login",
    );
    this.oauthAttempts.set(integrationID, { attemptID: auth.attemptID, mode: auth.mode });
    return auth;
  }

  /** Start an OAuth login; returns the URL to open and how it completes. */
  async oauthAuthorize(providerID: string, method: number, inputs?: Record<string, string>): Promise<OAuthAuthorization> {
    const auth = await this.oauthStart(providerID, method, inputs);
    return { url: auth.url, method: auth.mode, instructions: auth.instructions ?? "" };
  }

  /** Complete an OAuth login (pass the pasted code for "code" flows). For
   *  "auto" flows this call WAITS until the browser redirect finishes — pass
   *  a `signal` so a cancelled login doesn't leak the wait. */
  async oauthCallback(providerID: string, _method: number, code?: string, signal?: AbortSignal): Promise<void> {
    const attempt = this.oauthAttempts.get(providerID);
    if (!attempt) throw new Error("Login did not complete (no login in progress)");
    const base = `/api/integration/${encodeURIComponent(providerID)}/connect/oauth/${encodeURIComponent(attempt.attemptID)}`;
    if (attempt.mode === "code" || code) {
      const res = await this.fetchWithTimeout(this.url(`${base}/complete`, {}, true), {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({ code: code ?? null }),
        signal,
      });
      if (!res.ok) throw await this.apiError(res, "Login did not complete");
      this.oauthAttempts.delete(providerID);
      return;
    }
    for (;;) {
      if (signal?.aborted) throw new Error("Login cancelled");
      const res = await this.fetchWithTimeout(this.url(base, {}, true), { headers: this.headers(), signal });
      const state = await this.data<{ status: string; message?: string }>(res, "Login did not complete");
      if (state.status === "complete") {
        this.oauthAttempts.delete(providerID);
        return;
      }
      if (state.status !== "pending")
        throw new Error(`Login did not complete (${state.message ?? state.status})`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  /** Credentials apply live in OpenCode 2; kept so callers need not know. */
  async refreshProviderCache(): Promise<void> {}

  // ---- turns ----

  /** Bind the session's agent and model when they differ from what this client
   *  last bound. OpenCode 2 keeps both on the session rather than per prompt. */
  private async bindAgent(sessionId: string, agent: string): Promise<void> {
    if (this.boundAgent.get(sessionId) === agent) return;
    const res = await this.send("POST", this.url(this.sessionPath(sessionId, "/agent")), { agent });
    if (!res.ok) throw await this.apiError(res, "Failed to select the agent");
    this.boundAgent.set(sessionId, agent);
  }

  private async bindModel(sessionId: string, model: string, variant: string | null | undefined): Promise<void> {
    const ref = parseModel(model);
    if (!ref) return;
    const key = `${model}#${variant ?? ""}`;
    if (this.boundModel.get(sessionId) === key) return;
    const res = await this.send("POST", this.url(this.sessionPath(sessionId, "/model")), {
      model: { ...ref, ...(variant ? { variant } : {}) },
    });
    if (!res.ok) throw await this.apiError(res, "Failed to select the model");
    this.boundModel.set(sessionId, key);
  }

  /** Send a prompt into a session; output streams back via onEvent (SSE).
   *  `agent` pins the turn to an agent (e.g. "plan"); `model`
   *  ("provider/model") and `variant` pin the model and its reasoning effort.
   *  Both are bound on the session first — that is where OpenCode 2 keeps
   *  them — so an old session never answers on a stale creation-time model. */
  async sendPrompt(
    sessionId: string,
    text: string,
    agent?: string,
    model?: string | null,
    variant?: string | null,
    files?: PromptFile[],
  ): Promise<void> {
    if (agent) await this.bindAgent(sessionId, agent);
    if (model) await this.bindModel(sessionId, model, variant);
    const res = await this.send("POST", this.url(this.sessionPath(sessionId, "/prompt")), {
      text,
      // Attachments ride inline (data: URLs) so a vision model actually sees
      // them; the text still names them, so the agent can also open the
      // workspace copy with its own tools (#88).
      ...(files?.length
        ? { files: files.map((f) => ({ uri: f.url, name: f.filename, source: { type: "inline" } })) }
        : {}),
    });
    if (!res.ok) throw await this.apiError(res, "Failed to send prompt");
  }

  /** Run a shell command directly in the session's workspace — no model turn.
   *  The result lands in the session history and streams via onEvent. */
  async runShell(sessionId: string, command: string, _agent = "build"): Promise<void> {
    const res = await this.send("POST", this.url(this.sessionPath(sessionId, "/shell")), { command });
    if (!res.ok) throw await this.apiError(res, "Command failed to run");
  }

  /** Run a slash command (config command / skill / MCP prompt) in a session.
   *  Resolves when the turn it started is over, as the app's turn bookkeeping
   *  expects of it: OpenCode 2 answers the request as soon as the command is
   *  accepted, so this then waits on the session itself. */
  async runCommand(sessionId: string, command: string, args?: string): Promise<void> {
    const before = await this.sessionTimes(sessionId);
    await this.postCommand(sessionId, command, args);
    await this.turnOver(sessionId, before.busy);
  }

  /** A config command runs by name; a skill (OpenCode 2 lists those apart)
   *  runs as a prompt with the skill attached. */
  private async postCommand(sessionId: string, command: string, args?: string): Promise<void> {
    const [commands, skills] = await Promise.all([
      this.data<Array<{ name: string }>>(await this.get(this.url("/api/command", {}, true)), "Failed to list commands"),
      this.skillRows().catch(() => []),
    ]);
    const isSkill = !(commands ?? []).some((c) => c.name === command) && skills.some((s) => s.id === command);
    const res = isSkill
      ? await this.send("POST", this.url(this.sessionPath(sessionId, "/prompt")), {
          text: args ?? "",
          skills: [{ id: command }],
        })
      : await this.send("POST", this.url(this.sessionPath(sessionId, "/command")), {
          name: command,
          text: args ?? "",
        });
    if (!res.ok) throw await this.apiError(res, `Failed to run /${command}`);
  }

  /** When the session last went busy and idle, by the server's clock. */
  private async sessionTimes(sessionId: string): Promise<{ busy: number; idle: number }> {
    const s = await this.data<WireSession & { time?: { busy?: number; idle?: number } }>(
      await this.get(this.url(this.sessionPath(sessionId))),
      "Failed to read the session",
    );
    return { busy: s.time?.busy ?? 0, idle: s.time?.idle ?? 0 };
  }

  /** Wait for the turn that began after `busyBefore` to end. A command that
   *  starts no turn (`/goal pause`) is over once a moment passes without one.
   *  Only the server's own timestamps are compared, never this machine's clock. */
  private async turnOver(sessionId: string, busyBefore: number): Promise<void> {
    const started = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, COMMAND_POLL_MS));
      const { busy, idle } = await this.sessionTimes(sessionId);
      if (busy > busyBefore) {
        if (idle >= busy) return;
      } else if (Date.now() - started > COMMAND_START_GRACE_MS) {
        return;
      }
    }
  }

  // ---- goal mode (OpenCode's built-in /goal) ----

  /** The session's goal, or null when it has none. Read from the goal
   *  plugin's own state (an RPC), so a status display costs no model turn. */
  async getGoal(sessionId: string): Promise<GoalInfo | null> {
    const res = await this.send("POST", this.url("/api/rpc/opencode.goal/get", {}, true), {
      input: { sessionID: sessionId },
    });
    if (!res.ok) throw await this.apiError(res, "Failed to read the goal");
    const out = ((await res.json()) as { output?: GoalInfo | null }).output;
    return out ?? null;
  }

  /** Pause, resume or clear the session's goal. Pause and clear start no
   *  turn; resume sends the goal's own continuation. */
  async updateGoal(sessionId: string, action: "pause" | "resume" | "clear"): Promise<GoalInfo | null> {
    // Not waited on: the pill shows the goal's new state, not the turn.
    await this.postCommand(sessionId, "goal", action);
    return this.getGoal(sessionId);
  }

  // ---- interactive requests (question / permission) ----
  // OpenCode answers both under the session; the app knows only the request
  // id, so each one's session is remembered when it is seen.

  private rememberForm(form: WireForm): QuestionAskedEvent {
    this.forms.set(form.id, form);
    this.requestSessions.set(form.id, form.sessionID);
    return { type: "question.asked", sessionId: form.sessionID, requestId: form.id, questions: toQuestions(form) };
  }

  /** Pending questions in the workspace (recovery on open — an ask can predate connect). */
  async listQuestions(_sessionId?: string): Promise<QuestionAskedEvent[]> {
    const res = await this.get(this.url("/api/form", {}, true));
    if (!res.ok) return [];
    const forms = ((await res.json()) as { data?: WireForm[] }).data ?? [];
    return forms.map((f) => this.rememberForm(f));
  }

  private async requestSession(requestId: string, kind: "form" | "permission"): Promise<string> {
    const known = this.requestSessions.get(requestId);
    if (known) return known;
    if (kind === "form") await this.listQuestions();
    else await this.listPermissions();
    const found = this.requestSessions.get(requestId);
    if (!found) throw new ApiError("That request is no longer open (404)", 404);
    return found;
  }

  /** Answer a question: one array of selected option labels per question, in order. */
  async answerQuestion(requestId: string, answers: string[][]): Promise<void> {
    const sessionId = await this.requestSession(requestId, "form");
    const form = this.forms.get(requestId);
    const answer: Record<string, string | boolean | string[]> = {};
    (form?.fields ?? []).forEach((f, i) => {
      const picked = answers[i] ?? [];
      // A chosen label goes back as its value; a typed answer as itself.
      const value = (label: string) => f.options?.find((o) => o.label === label)?.value ?? label;
      if (f.type === "multiselect") answer[f.key] = picked.map(value);
      else if (f.type === "boolean") answer[f.key] = picked[0] === "Yes";
      else if (picked.length > 0) answer[f.key] = value(picked[0]);
    });
    const res = await this.send(
      "POST",
      this.url(this.sessionPath(sessionId, `/form/${encodeURIComponent(requestId)}/reply`)),
      { answer },
    );
    if (!res.ok) throw await this.apiError(res, "Failed to answer the question");
  }

  /** Reject/dismiss a question (the agent proceeds without an answer). */
  async rejectQuestion(requestId: string): Promise<void> {
    const sessionId = await this.requestSession(requestId, "form");
    const res = await this.send("DELETE", this.url(this.sessionPath(sessionId, `/form/${encodeURIComponent(requestId)}`)));
    if (!res.ok) throw await this.apiError(res, "Failed to reject the question");
  }

  /** Pending permission requests in the workspace (recovery on open). */
  async listPermissions(_sessionId?: string): Promise<PermissionAskedEvent[]> {
    const res = await this.get(this.url("/api/permission/request", {}, true));
    if (!res.ok) return [];
    const rows = ((await res.json()) as { data?: WirePermission[] }).data ?? [];
    return rows.map((p) => {
      this.requestSessions.set(p.id, p.sessionID);
      return {
        type: "permission.asked" as const,
        sessionId: p.sessionID,
        requestId: p.id,
        action: appToolName(p.action ?? "action"),
        resources: p.resources ?? [],
      };
    });
  }

  /** Reply to a permission request: allow once, allow always, or reject. */
  async replyPermission(requestId: string, reply: PermissionReply): Promise<void> {
    const sessionId = await this.requestSession(requestId, "permission");
    const res = await this.send(
      "POST",
      this.url(this.sessionPath(sessionId, `/permission/${encodeURIComponent(requestId)}/reply`)),
      { decision: reply },
    );
    if (!res.ok) throw await this.apiError(res, "Failed to reply to the permission");
  }

  // ---- event translation ----

  private endTurn(sessionId: string): void {
    for (const [key, acc] of this.textStreams) if (acc.sessionId === sessionId) this.textStreams.delete(key);
    for (const [key, acc] of this.reasoningStreams) if (acc.sessionId === sessionId) this.reasoningStreams.delete(key);
    for (const [id, call] of this.toolCalls) {
      if (call.sessionId !== sessionId) continue;
      this.stopShellPoll(id);
      this.toolCalls.delete(id);
    }
    this.stepParts.delete(sessionId);
  }

  private emitTool(
    callId: string,
    status: ToolCallStatus,
    extra: { output?: string; partialOutput?: string; diff?: string; endedAt?: number } = {},
  ): void {
    const call = this.toolCalls.get(callId);
    if (!call) return;
    this.emit({
      type: "tool.updated",
      sessionId: call.sessionId,
      callId,
      tool: call.tool,
      status,
      ...(call.input ? { input: call.input } : {}),
      ...(call.startedAt ? { startedAt: call.startedAt } : {}),
      ...(call.child ? { childSessionId: call.child } : {}),
      ...extra,
    });
  }

  /** Re-read a running shell tool's output while it runs. OpenCode 2 streams
   *  only that a shell exists; its output lives behind the shell's own id. */
  private startShellPoll(callId: string, shellID: string): void {
    if (this.shellPolls.has(callId)) return;
    const poll = async () => {
      try {
        const res = await this.get(this.url(`/api/shell/${encodeURIComponent(shellID)}/output`, {}, true));
        if (!res.ok || !this.shellPolls.has(callId)) return;
        const out = ((await res.json()) as { data?: { output?: string } }).data?.output;
        if (typeof out === "string" && this.toolCalls.has(callId)) this.emitTool(callId, "running", { partialOutput: out });
      } catch {
        /* the next tick tries again */
      }
    };
    this.shellPolls.set(callId, setInterval(poll, SHELL_POLL_MS));
    void poll();
  }

  private stopShellPoll(callId: string): void {
    const timer = this.shellPolls.get(callId);
    if (timer) clearInterval(timer);
    this.shellPolls.delete(callId);
  }

  private normalize(ev: OpenCodeRawEvent): void {
    const d = (ev.data ?? {}) as Record<string, unknown>;
    const sessionId = typeof d.sessionID === "string" ? d.sessionID : "";
    const messageID = typeof d.assistantMessageID === "string" ? d.assistantMessageID : "";
    switch (ev.type) {
      case "session.inbox.enqueued": {
        // A user message entered the session. Its words are surfaced because
        // the message may not be ours — another agent, another tab, the CLI —
        // and the app matches it to its own echo; its id lets the app tag the
        // live block so it can be edited (revert + resend).
        const item = d.item as { type?: string; payload?: { text?: string; skills?: Array<{ id?: string }> } } | undefined;
        const inboxID = typeof d.inboxID === "string" ? d.inboxID : "";
        if (item?.type !== "user" || !inboxID) break;
        this.emit({ type: "message.agent", sessionId, messageID: inboxID });
        this.emit({ type: "user.message", sessionId, messageID: inboxID, text: typedText(item.payload?.text ?? "", item.payload?.skills) });
        break;
      }
      case "session.agent.selected": {
        // Keeps the per-session agent mode in sync, including a switch the
        // runtime makes itself (plan → build).
        const agent = typeof d.agent === "string" ? d.agent : undefined;
        if (agent) {
          this.boundAgent.set(sessionId, agent);
          this.emit({ type: "message.agent", sessionId, agent });
        }
        break;
      }
      case "session.step.started": {
        if (!messageID) break;
        this.stepStarted.set(messageID, typeof d.started === "number" ? d.started : ev.created ?? Date.now());
        let seen = this.stepParts.get(sessionId);
        if (!seen) this.stepParts.set(sessionId, (seen = new Set()));
        if (!seen.has(messageID)) {
          seen.add(messageID);
          this.emit({ type: "step.updated", sessionId, step: seen.size });
        }
        break;
      }
      case "session.step.ended":
      case "session.step.failed": {
        const usage = toUsage(d.tokens as RawTokens | undefined, d.cost);
        if (usage && messageID) {
          const created = this.stepStarted.get(messageID);
          this.emit({
            type: "message.usage",
            sessionId,
            messageID,
            usage,
            ...(created ? { created } : {}),
            ...(ev.created ? { completed: ev.created } : {}),
          });
        }
        this.stepStarted.delete(messageID);
        break;
      }
      case "session.text.started":
      case "session.text.delta":
      case "session.text.ended": {
        const key = `${messageID}#${String(d.ordinal ?? 0)}`;
        let acc = this.textStreams.get(key);
        if (!acc) this.textStreams.set(key, (acc = { sessionId, text: "", messageID }));
        if (ev.type === "session.text.delta") acc.text += typeof d.delta === "string" ? d.delta : "";
        else if (ev.type === "session.text.ended" && typeof d.text === "string") acc.text = d.text;
        this.emit({ type: "text.updated", sessionId, partId: `${messageID}:text:${String(d.ordinal ?? 0)}`, text: acc.text, messageID });
        break;
      }
      case "session.reasoning.started":
      case "session.reasoning.delta":
      case "session.reasoning.ended": {
        const key = `${messageID}#${String(d.ordinal ?? 0)}`;
        let acc = this.reasoningStreams.get(key);
        if (!acc) this.reasoningStreams.set(key, (acc = { sessionId, text: "" }));
        if (ev.type === "session.reasoning.delta") acc.text += typeof d.delta === "string" ? d.delta : "";
        else if (ev.type === "session.reasoning.ended" && typeof d.text === "string") acc.text = d.text;
        this.emit({ type: "reasoning.updated", sessionId, partId: `${messageID}:reasoning:${String(d.ordinal ?? 0)}`, text: acc.text });
        break;
      }
      case "session.tool.input.started": {
        const id = String(d.id ?? "");
        const name = String(d.name ?? "");
        if (!id) break;
        this.toolCalls.set(id, { sessionId, tool: appToolName(name), wire: name, startedAt: ev.created });
        this.emitTool(id, "pending");
        break;
      }
      case "session.tool.called": {
        const id = String(d.id ?? "");
        if (!id) break;
        let call = this.toolCalls.get(id);
        if (!call) {
          const name = String(d.name ?? "");
          call = { sessionId, tool: appToolName(name), wire: name, startedAt: ev.created };
          this.toolCalls.set(id, call);
        }
        call.input = appToolInput(call.wire, d.input);
        call.startedAt = ev.created ?? call.startedAt;
        this.emitTool(id, "running");
        break;
      }
      case "session.tool.progress": {
        const id = String(d.id ?? "");
        const call = this.toolCalls.get(id);
        if (!call) break;
        const child = metadataSession(d.metadata);
        if (child) call.child = child;
        const shellID = (d.metadata as { shellID?: unknown } | undefined)?.shellID;
        if (call.tool === "bash" && typeof shellID === "string") this.startShellPoll(id, shellID);
        else this.emitTool(id, "running");
        break;
      }
      case "session.tool.success":
      case "session.tool.failed": {
        const id = String(d.id ?? "");
        const call = this.toolCalls.get(id);
        if (!call) break;
        this.stopShellPoll(id);
        const child = metadataSession(d.metadata);
        if (child) call.child = child;
        const diff = metadataDiff(d.metadata);
        const output =
          ev.type === "session.tool.failed"
            ? contentText(d.content) ?? errorText(d.error) ?? "Tool failed"
            : contentText(d.content);
        this.emitTool(id, ev.type === "session.tool.success" ? "success" : "failed", {
          ...(output !== undefined ? { output } : {}),
          ...(diff ? { diff } : {}),
          ...(ev.created ? { endedAt: ev.created } : {}),
        });
        break;
      }
      case "session.shell.started":
      case "session.shell.ended": {
        // A "!" command the user ran: shown like the bash tool it was in OpenCode 1.
        const shell = d.shell as { id?: string; command?: string; status?: string } | undefined;
        const id = shell?.id;
        if (!id) break;
        if (!this.toolCalls.has(id))
          this.toolCalls.set(id, {
            sessionId,
            tool: "bash",
            wire: "shell",
            input: { command: shell?.command ?? "" },
            startedAt: ev.created,
          });
        if (ev.type === "session.shell.started") {
          this.emitTool(id, "running");
          break;
        }
        const out = (d.output as { output?: string } | undefined)?.output;
        this.emitTool(id, shell?.status === "exited" ? "success" : "failed", {
          ...(out !== undefined ? { output: out } : {}),
          ...(ev.created ? { endedAt: ev.created } : {}),
        });
        this.toolCalls.delete(id);
        break;
      }
      case "session.compaction.ended":
        this.emit({ type: "session.compacted", sessionId, auto: d.reason !== "manual" });
        break;
      case "session.compaction.failed":
        this.emit({ type: "error", sessionId, message: errorText(d.error) ?? "Compaction failed" });
        break;
      case "session.retry.scheduled": {
        // A failed model call being retried: the ONLY sign of life while a
        // broken provider fails every attempt.
        this.emit({
          type: "session.retry",
          sessionId,
          attempt: typeof d.attempt === "number" ? d.attempt : 0,
          message: errorText(d.error) ?? "provider error",
          nextAt: typeof d.at === "number" ? d.at : 0,
        });
        break;
      }
      case "session.status": {
        // The retry status also says when the account itself is the cause —
        // Zen's free allowance spent, a Go plan's limit — which no retry fixes.
        const status = d.status as
          | { type?: string; attempt?: number; message?: string; next?: number; action?: Record<string, unknown> }
          | undefined;
        if (status?.type !== "retry") break;
        const action = retryAction(status.action);
        this.emit({
          type: "session.retry",
          sessionId,
          attempt: status.attempt ?? 0,
          message: status.message ?? "provider error",
          nextAt: status.next ?? 0,
          ...(action ? { action } : {}),
        });
        break;
      }
      case "session.execution.failed":
        this.emit({ type: "error", sessionId, message: errorText(d.error) ?? "session error" });
        this.endTurn(sessionId);
        this.emit({ type: "session.idle", sessionId });
        break;
      case "session.execution.succeeded":
      case "session.execution.interrupted":
        this.endTurn(sessionId);
        this.emit({ type: "session.idle", sessionId });
        break;
      case "permission.asked": {
        const p = d as unknown as WirePermission;
        if (!p.id) break;
        this.requestSessions.set(p.id, p.sessionID);
        this.emit({
          type: "permission.asked",
          sessionId: p.sessionID,
          requestId: p.id,
          action: appToolName(p.action ?? "action"),
          resources: p.resources ?? [],
        });
        break;
      }
      case "permission.replied":
        this.emit({ type: "permission.resolved", sessionId, requestId: String(d.requestID ?? "") });
        break;
      case "form.created": {
        const form = d.form as WireForm | undefined;
        if (form?.id) this.emit(this.rememberForm(form));
        break;
      }
      case "form.replied":
      case "form.cancelled":
        this.forms.delete(String(d.id ?? ""));
        this.emit({ type: "question.resolved", sessionId, requestId: String(d.id ?? "") });
        break;
      default:
        break; // server.connected, config/catalog updates and the rest
    }
  }
}

/** The session an event belongs to, wherever its payload keeps it. */
function sessionOf(ev: OpenCodeRawEvent): string | undefined {
  const d = ev.data as Record<string, unknown> | undefined;
  if (!d) return undefined;
  if (typeof d.sessionID === "string") return d.sessionID;
  const form = d.form as { sessionID?: unknown } | undefined;
  if (typeof form?.sessionID === "string") return form.sessionID;
  return undefined;
}

function toSessionMeta(s: WireSession): SessionMeta {
  const mine = (s.metadata?.[META_NS] ?? {}) as { archived?: number };
  return {
    id: s.id,
    title: s.title ?? "Untitled",
    ...(s.location?.directory ? { directory: s.location.directory } : {}),
    ...(s.parentID ? { parentId: s.parentID } : {}),
    ...(s.time?.created ? { created: s.time.created } : {}),
    ...(s.time?.updated ? { updated: s.time.updated } : {}),
    ...(s.model ? { model: { id: s.model.id, providerID: s.model.providerID } } : {}),
    ...(typeof mine.archived === "number" ? { archived: mine.archived } : {}),
    ...(s.metadata ? { metadata: s.metadata } : {}),
  };
}
