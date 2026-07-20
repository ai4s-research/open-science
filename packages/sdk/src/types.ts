import type { RuntimeStatus, ToolCallStatus } from "@ai4s/shared";

export type { RuntimeStatus, ToolCallStatus };

/** Pinned OpenCode release this client targets. */
export const OPENCODE_VERSION = "1.17.13";

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
/** The turn's model call failed and the server is retrying it — OpenCode backs
 *  off exponentially with NO attempt cap, so without surfacing these the UI
 *  shows a bare "Working…" forever while every attempt fails. */
/** A user message landed carrying its agent — including the build message
 *  OpenCode injects itself when the plan_exit question is answered Yes. The
 *  app syncs its per-session agent-mode state from this (never from question
 *  text, which is locale/version-brittle). */
export interface MessageAgentEvent {
  type: "message.agent";
  sessionId: string;
  agent: string;
}

export interface SessionRetryEvent {
  type: "session.retry";
  sessionId: string;
  attempt: number;
  /** The provider's error message for the failed attempt. */
  message: string;
  /** Epoch ms of the next scheduled attempt. */
  nextAt: number;
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

export type OpenCodeEvent =
  | TextUpdatedEvent
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
  /** Epoch ms when the message finished — unset while it is still streaming.
   *  On the LAST message this is the server's truth for "is the turn over". */
  completed?: number;
  /** The error that ended this assistant turn, when it failed. Without it a
   *  failed turn whose live session.error was missed (SSE reconnect, app
   *  restart) reloads as an empty reply with no explanation at all. */
  error?: string;
  /** Agent that drove this message ("build" / "plan" / …) — required upstream
   *  on user messages; the app derives a session's agent mode from the last
   *  user message when (re)opening it. */
  agent?: string;
  parts: HistoryPart[];
}
export interface HistoryPart {
  type: string;
  text?: string;
  /** True on runtime-generated text (e.g. the "tool was executed by the user"
   *  marker a "!" shell run leaves in history) — not something the user typed. */
  synthetic?: boolean;
  tool?: string;
  state?: {
    status?: string;
    title?: string;
    input?: Record<string, unknown>;
    output?: string;
    /** Epoch ms the tool started/finished — persisted with the part. */
    time?: { start?: number; end?: number };
    /** Tool-specific extras (bash stdout tail, edit diff, task session link). */
    metadata?: { output?: string; diff?: string };
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

// ---- Provider / model configuration (OpenCode-native, one source of truth) ----

export interface ProviderModelInfo {
  id: string;
  name: string;
  variants: string[];
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
