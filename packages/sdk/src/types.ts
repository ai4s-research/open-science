import type { MessageUsage, RuntimeStatus, ToolCallStatus } from "@ai4s/shared";

export type { RuntimeStatus, ToolCallStatus };

/** Pinned OpenCode release this client targets. */
export const OPENCODE_VERSION = "1.18.18";

/** OpenCode server defaults (`opencode serve`). */
export const DEFAULT_OPENCODE_URL = "http://127.0.0.1:4096";

// ---- Normalized events (OpenCode SSE → app) ----
// OpenCode emits idempotent "updated" events (full current value), not deltas, so
// text/tool events carry a stable id and the app upserts by that id.

export interface TextUpdatedEvent {
  type: "text.updated";
  sessionId: string;
  partId: string;
  text: string;
  /** The assistant message this text belongs to. It is what lets a later
   *  `message.usage` find the block to stamp its tokens onto. */
  messageID?: string;
}
/** The model's reasoning ("thinking") for a step — streamed like text but kept
 *  separate so the UI can show it dimmed, apart from the final answer. Without
 *  surfacing this, "what is the agent doing?" between tool calls is invisible. */
export interface ReasoningUpdatedEvent {
  type: "reasoning.updated";
  sessionId: string;
  partId: string;
  text: string;
}
/** A model "step" boundary (AI-SDK `step-start`). One turn can run several steps
 *  — each an LLM call, often followed by tool calls — so `step` (1-based) tells
 *  the user the turn is progressing, not frozen. */
export interface StepUpdatedEvent {
  type: "step.updated";
  sessionId: string;
  step: number;
}
export interface ToolUpdatedEvent {
  type: "tool.updated";
  sessionId: string;
  callId: string;
  tool: string;
  status: ToolCallStatus;
  title?: string;
  /** Tool arguments (e.g. a write tool's `filePath` + `content`). */
  input?: Record<string, unknown>;
  /** Tool result text, when the tool returned one. */
  output?: string;
  /** Accumulated stdout tail while the tool is still running (bash streams it
   *  via `state.metadata.output` on every update — verified on 1.17.13). */
  partialOutput?: string;
  /** Unified diff an edit tool reports in `state.metadata.diff`. */
  diff?: string;
  /** Epoch ms the tool started / finished (`state.time`). */
  startedAt?: number;
  endedAt?: number;
  /** A `task` tool's spawned subagent session — that session's interactive
   *  requests (question/permission) belong to THIS conversation. */
  childSessionId?: string;
}
export interface SessionIdleEvent {
  type: "session.idle";
  sessionId: string;
}
/** A user message landed carrying its agent — including the build message
 *  OpenCode injects itself when the plan_exit question is answered Yes. The
 *  app syncs its per-session agent-mode state from this (never from question
 *  text, which is locale/version-brittle). */
export interface MessageAgentEvent {
  type: "message.agent";
  sessionId: string;
  /** The user message's id, when known — lets the app tag the live message
   *  block so it can later be edited (revert + resend). */
  messageID?: string;
  /** Agent the user message carries; absent when OpenCode didn't set one. */
  agent?: string;
}

/** What the runtime says the user can DO about a failed attempt, when it knows.
 *  OpenCode fills this in for the two account-state failures it can recognise
 *  from the response body, and only those: `free_tier_limit` (Zen's free
 *  allowance is spent) and `account_rate_limit` (a Go plan's limit, with a
 *  reset time in `message`). Both are terminal for the retry loop's purposes —
 *  the attempts run out without the condition changing — so an app that shows
 *  only "retrying" is telling the user to wait for something that will not
 *  happen. `provider` is the provider id whose call failed. */
export interface RetryAction {
  /** `free_tier_limit` or `account_rate_limit` on the pinned runtime; any other
   *  value is a newer runtime's, and means no more than "the runtime knows". */
  reason: string;
  provider?: string;
  title?: string;
  /** The runtime's own actionable sentence (English; it is not localized). */
  message?: string;
  label?: string;
  link?: string;
}

/** The turn's model call failed and the server is retrying it. These status
 *  events are the only sign of life while every attempt fails, so without them
 *  the UI shows a bare "Working…". Measured on the pinned runtime: exponential
 *  backoff from 2s, capped at 30s without `retry-after` headers, and
 *  `RETRY_MAX_RETRIES = 5` — after which the failure arrives as a session
 *  error. */
export interface SessionRetryEvent {
  type: "session.retry";
  sessionId: string;
  attempt: number;
  /** The provider's error message for the failed attempt. */
  message: string;
  /** Epoch ms of the next scheduled attempt. */
  nextAt: number;
  /** Present when the runtime recognised an account-state cause. */
  action?: RetryAction;
}

// ---- Interactive requests (the agent asks; the user must answer) ----
// OpenCode blocks the run until answered. Two kinds: a `question` (pick from
// options) and a `permission` (approve a command / file write / etc.).

export interface QuestionOption {
  label: string;
  description?: string;
}
export interface QuestionItem {
  question: string;
  header: string;
  options: QuestionOption[];
  /** Allow selecting more than one option. */
  multiple?: boolean;
  /** Allow a free-text answer in addition to the options. */
  custom?: boolean;
}
export interface QuestionAskedEvent {
  type: "question.asked";
  sessionId: string;
  requestId: string;
  questions: QuestionItem[];
}
/** A question was answered or rejected elsewhere — clear it from the UI. */
export interface QuestionResolvedEvent {
  type: "question.resolved";
  sessionId: string;
  requestId: string;
}

export interface PermissionAskedEvent {
  type: "permission.asked";
  sessionId: string;
  requestId: string;
  /** e.g. "bash", "write", "edit" — what the agent wants to do. */
  action: string;
  /** The concrete targets (a command line, file paths). */
  resources: string[];
}
export interface PermissionResolvedEvent {
  type: "permission.resolved";
  sessionId: string;
  requestId: string;
}
export interface RuntimeErrorEvent {
  type: "error";
  sessionId?: string;
  message: string;
}

/** The runtime compacted the conversation's older turns to stay inside the
 *  model's context window. Emitted so the thread can show one quiet marker
 *  instead of the user hitting "Input exceeds context window". */
export interface CompactedEvent {
  type: "session.compacted";
  sessionId: string;
  /** True when the runtime decided on its own, false when the user asked. */
  auto: boolean;
  /** The context had already overflowed rather than merely neared the limit. */
  overflow?: boolean;
}

/** Running token totals for an assistant turn. OpenCode republishes the whole
 *  message on every update, so this arrives repeatedly during a turn and one
 *  last time with the final numbers — the app just overwrites.
 *
 *  Without it the app cannot answer "how full is the context" at all: the
 *  numbers exist only here and in history, nowhere else in the protocol. */
export interface MessageUsageEvent {
  type: "message.usage";
  sessionId: string;
  messageID: string;
  usage: MessageUsage;
  /** Epoch ms from the message's own clock — `completed` unset while running. */
  created?: number;
  completed?: number;
}

export type OpenCodeEvent =
  | TextUpdatedEvent
  | ReasoningUpdatedEvent
  | CompactedEvent
  | MessageUsageEvent
  | StepUpdatedEvent
  | ToolUpdatedEvent
  | SessionIdleEvent
  | MessageAgentEvent
  | SessionRetryEvent
  | RuntimeErrorEvent
  | QuestionAskedEvent
  | QuestionResolvedEvent
  | PermissionAskedEvent
  | PermissionResolvedEvent;

/** Approve a permission once, always (persist a rule), or reject it. */
export type PermissionReply = "once" | "always" | "reject";

// ---- REST shapes the app consumes ----

export interface SessionMeta {
  id: string;
  title: string;
  slug?: string;
  /** Workspace folder this session operates in (absolute path). */
  directory?: string;
  /** Set on subagent sessions: the session whose task tool spawned this one. */
  parentId?: string;
  /** Epoch ms the session was created / last updated (from OpenCode's `time`).
   *  Drives "Updated" timestamps and recency ordering. */
  created?: number;
  updated?: number;
  /** Epoch ms the user archived this conversation; absent when active.
   *  Archived conversations are kept and searchable — just out of the way. */
  archived?: number;
  /** The model this session is bound to (from the list endpoint's `model`),
   *  e.g. for context-limit controls. */
  model?: { id?: string; providerID?: string };
  /** The runtime's whole metadata object, so a write can merge instead of
   *  clobbering keys another client owns. */
  metadata?: Record<string, unknown>;
}

/** One page of conversation history. Both the filter and the paging run on the
 *  server so a multi-year history never has to be held in memory. */
export interface SessionQuery {
  /** Rows per page. */
  limit?: number;
  /** Page from here (an epoch-ms `updated`); omit for the newest page. */
  cursor?: number | null;
  /** Server-side title search. */
  search?: string;
  /** Include archived conversations (they are excluded by default). */
  archived?: boolean;
}

export interface SessionPage {
  sessions: SessionMeta[];
  /** Cursor for the next page, or null when the history is exhausted. */
  nextCursor: number | null;
}

export interface SkillInfo {
  name: string;
  description: string;
  location?: string;
}

export interface AgentInfo {
  name: string;
  description: string;
  mode?: string;
}

/** A slash command the runtime can run. GET /command merges every source:
 *  config commands, skills, and MCP prompts — one list for the composer's
 *  "/" palette. */
export interface CommandInfo {
  name: string;
  description?: string;
  /** Where it came from, e.g. "command" | "skill" | "mcp". */
  source?: string;
  /** Agent the command pins, when it does. */
  agent?: string;
  /** The prompt text the command expands to. OpenCode stores that EXPANSION
   *  as the user message in history — the template lets the app reverse-map
   *  it back to the "/name" the user actually typed. */
  template?: string;
}

/** A message loaded from history (GET /session/:id/message). */
export interface HistoryMessage {
  role: "user" | "assistant";
  /** OpenCode's message id — the handle for reverting/editing a user message
   *  (`POST /session/:id/revert`). Absent only on synthetic/mock messages. */
  id?: string;
  /** Epoch ms when the message finished — unset while it is still streaming.
   *  On the LAST message this is the server's truth for "is the turn over". */
  completed?: number;
  /** Epoch ms when the message was created. Needed to tell a turn that is
   *  streaming RIGHT NOW from one that was streaming when its runtime died:
   *  both persist identically (assistant, no `completed`, no `error`), and
   *  only the timestamp says whether any live process could still be producing
   *  it. See `turnStillStreaming`. */
  created?: number;
  /** The error that ended this assistant turn, when it failed. Without it a
   *  failed turn whose live session.error was missed (SSE reconnect, app
   *  restart) reloads as an empty reply with no explanation at all. */
  error?: string;
  /** Agent that drove this message ("build" / "plan" / …) — required upstream
   *  on user messages; the app derives a session's agent mode from the last
   *  user message when (re)opening it. */
  agent?: string;
  /** Token accounting for an assistant message. Assistant-only, and absent on
   *  runtimes that don't report it (ACP) or on mock/synthetic messages. */
  usage?: MessageUsage;
  parts: HistoryPart[];
}
export interface HistoryPart {
  type: string;
  text?: string;
  /** True on runtime-generated text (e.g. the "tool was executed by the user"
   *  marker a "!" shell run leaves in history) — not something the user typed. */
  synthetic?: boolean;
  /** OpenCode marks a part the model must not see again. The converter drops
   *  these before building the request, so they cannot malform it. */
  ignored?: boolean;
  tool?: string;
  /** The provider's id for this tool call — what pairs the call with its
   *  result. Every tool part carries one; a part without it cannot be turned
   *  into a valid message. */
  callID?: string;
  state?: {
    status?: string;
    title?: string;
    input?: Record<string, unknown>;
    output?: string;
    /** Why the tool failed, on `status: "error"`. Carried into the request as
     *  the tool result, so it is as load-bearing as `output` is. */
    error?: string;
    /** Epoch ms the tool started/finished — persisted with the part.
     *  `compacted` is set once compaction has cleared this result's text; from
     *  then on the request carries a placeholder and `output` no longer
     *  matters. */
    time?: { start?: number; end?: number; compacted?: number };
    /** Tool-specific extras (bash stdout tail, edit diff, task session link).
     *  `sessionId` is the subagent session a `task` tool spawned — the live
     *  event stream reads the same field, and without it here a RELOADED
     *  conversation loses every link to its subagents' own transcripts.
     *  `interrupted` marks a tool the user stopped: its `output` (not
     *  `state.error`) is what the model is shown. */
    metadata?: {
      output?: string;
      diff?: string;
      sessionId?: string;
      interrupted?: boolean;
    };
  };
}

export interface OpenCodeClientOptions {
  /** Base URL of a running `opencode serve`, e.g. http://127.0.0.1:4096 */
  baseUrl?: string;
  /** Optional OPENCODE_SERVER_PASSWORD (basic auth). */
  password?: string;
  username?: string;
  /** Inject fetch (defaults to global fetch; browser + node both have it). */
  fetchImpl?: typeof fetch;
  /** Max time to wait for the SSE handshake before retrying. */
  connectTimeoutMs?: number;
  /** Max time to wait for short HTTP requests such as session creation. */
  requestTimeoutMs?: number;
  /**
   * Workspace directory the server should scope skill discovery to. OpenCode
   * initializes per-directory instances lazily; without this, /api/skill can
   * return an empty list until something else touches the workspace instance.
   */
  directory?: string;
}

/**
 * A file sent as a real multimodal part of a turn, so a vision-capable model
 * sees the image itself rather than a filename in the prose (#88).
 *
 * `url` MUST be a `data:` URL. OpenCode accepts a `file://` url and answers 204,
 * then stores no message at all — the turn is silently lost — so the bytes ride
 * in the request.
 */
export interface PromptFile {
  /** Name shown to the model; the workspace file name it was read from. */
  filename: string;
  /** e.g. "image/png". */
  mime: string;
  /** `data:<mime>;base64,<…>`. */
  url: string;
}

// ---- Provider / model configuration (OpenCode-native, one source of truth) ----

export interface ProviderModelInfo {
  id: string;
  name: string;
  /** Reasoning-effort variant names this model exposes, ordered low→high as
   *  OpenCode reports them (e.g. ["minimal","low","medium","high"]). Empty when
   *  the model has no selectable reasoning levels. Pass one as `sendPrompt`'s
   *  `variant` to pick a per-turn effort; OpenCode maps it to the provider's
   *  native param (OpenAI reasoningEffort, Anthropic thinking, …). `listProviders`
   *  always sets it (possibly []); optional so terse fixtures can omit it. */
  variants?: string[];
  /** Context window in tokens, or 0 when OpenCode does not know it — which it
   *  does not for any model missing from models.dev whose limit nobody typed
   *  in, i.e. most custom endpoints. Load-bearing, not decorative: OpenCode
   *  skips auto-compaction outright on a zero window (`limit.context === 0`
   *  short-circuits its threshold check), so the conversation grows unbounded
   *  and long agentic turns eventually stall sending it. Surfaced so the UI can
   *  say so instead of leaving the user with a spinner. */
  contextLimit?: number;
  /** False when the provider still advertises this model but no longer serves
   *  it, so picking it can only fail. `listProviders` never sets this — the
   *  runtime's catalog cannot tell — it is filled in by whoever can ask the
   *  provider directly (the app does, for OpenCode Zen). Undefined means
   *  nobody knows, which every consumer must read as available. */
  available?: boolean;
}

/** A provider OpenCode can use right now (auth present or public). */
export interface ProviderInfo {
  id: string;
  name: string;
  models: ProviderModelInfo[];
}

/** Extra input an auth method needs before starting (e.g. Copilot deployment). */
export interface AuthPrompt {
  type: "select" | "text";
  key: string;
  message: string;
  options?: Array<{ label: string; value: string; hint?: string }>;
}

export interface ProviderAuthMethod {
  type: "oauth" | "api";
  label: string;
  prompts?: AuthPrompt[];
}

/** Catalog entry: a provider OpenCode knows how to talk to (not necessarily connected). */
export interface ProviderCatalogEntry {
  id: string;
  name: string;
  /** Env var(s) that would carry the API key, e.g. ["ANTHROPIC_API_KEY"]. */
  env: string[];
}

export interface OAuthAuthorization {
  url: string;
  /** "auto" — callback completes on its own; "code" — the user pastes a code. */
  method: "auto" | "code";
  instructions: string;
}

// ---- MCP servers ----

export type McpConfig =
  | { type: "local"; command: string[]; enabled?: boolean; environment?: Record<string, string> }
  | { type: "remote"; url: string; enabled?: boolean; headers?: Record<string, string> };

export interface McpServer {
  name: string;
  /** e.g. "connected" | "failed" | "disabled" | "pending" */
  status: string;
  config?: McpConfig;
}

/** Result of starting an OAuth flow for a remote MCP server (`POST /mcp/{name}/auth`).
 *  Open `authorizationUrl` in the user's browser; `listMcpServers` reports
 *  "connected" once the callback lands — see `mcp.auth.authenticate` in the
 *  OpenCode API, which this deliberately avoids (its single request stays open
 *  until login completes, longer than a webview's own fetch idle timeout). */
export interface McpOAuthStart {
  authorizationUrl: string;
  oauthState: string;
}

// ---- Raw OpenCode wire shapes (subset we consume) ----

export interface OpenCodeRawEvent {
  type: string;
  properties?: Record<string, unknown>;
}

export interface OpenCodeTextPart {
  id: string;
  type: "text";
  text: string;
}
export interface OpenCodeToolPart {
  id: string;
  type: "tool";
  callID: string;
  tool: string;
  state: { status: "pending" | "running" | "completed" | "error"; title?: string };
}
export type OpenCodePart = OpenCodeTextPart | OpenCodeToolPart | { type: string };
