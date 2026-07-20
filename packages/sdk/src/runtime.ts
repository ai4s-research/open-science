import type {
  AgentInfo,
  CommandInfo,
  HistoryMessage,
  OpenCodeEvent,
  PermissionAskedEvent,
  PermissionReply,
  QuestionAskedEvent,
  RuntimeStatus,
  SessionMeta,
  SkillInfo,
} from "./types";

/**
 * The runtime-agnostic boundary between the app UI and the agent runtime.
 *
 * `AGENTS.md` mandates that the UI never calls OpenCode directly — it goes
 * through `packages/sdk`. This interface makes that seam explicit: it covers
 * ONLY the surface a generic agent runtime must expose (lifecycle, sessions,
 * capability discovery, model selection, and interactive requests).
 *
 * Provider / MCP / OAuth configuration is deliberately OUT of scope — those are
 * configuration of a specific runtime (OpenCode today), not of "an agent
 * runtime" in general. Callers that need them go through the concrete
 * `OpenCodeClient` (e.g. `getClient()`), which `implements AgentRuntime`.
 *
 * See `docs/rfc/agent-runtime.md` for the rationale. The sole implementation
 * today is `OpenCodeClient`; no second runtime is planned. This is Phase 1 —
 * formalize the seam, change no behavior.
 */
export interface AgentRuntime {
  // ---- lifecycle ----
  connect(): Promise<void>;
  close(): void;
  getStatus(): RuntimeStatus;
  onStatus(listener: (status: RuntimeStatus) => void): () => void;
  onEvent(listener: (event: OpenCodeEvent) => void): () => void;

  // ---- sessions (a conversation) ----
  createSession(): Promise<string>;
  listSessions(): Promise<SessionMeta[]>;
  deleteSession(sessionId: string): Promise<void>;
  getMessages(sessionId: string): Promise<HistoryMessage[]>;
  /** `agent` pins a specific agent for the turn (e.g. the read-only "plan"
   *  agent); omit for the runtime default. `model` ("provider/model") pins the
   *  turn to the current default, overriding a session's stale creation-time
   *  binding; omit to use the session/runtime default.
   *  `variant` is an optional reasoning variant ID, e.g. "high", "max". */
  sendPrompt(sessionId: string, text: string, agent?: string, model?: string | null, variant?: string | null): Promise<void>;
  abortSession(sessionId: string): Promise<void>;

  // ---- capability discovery (what this runtime can do) ----
  listSkills(): Promise<SkillInfo[]>;
  listAgents(): Promise<AgentInfo[]>;
  listCommands(): Promise<CommandInfo[]>;

  // ---- model selection ----
  getDefaultModel(): Promise<string | null>;
  setDefaultModel(model: string): Promise<void>;

  // ---- agent-driven execution (a full turn, not a single prompt) ----
  /** Run a shell command in the session's workspace; no model turn. */
  runShell(sessionId: string, command: string, agent?: string): Promise<void>;
  /** Run a slash command (config command / skill / MCP prompt) as a full turn. */
  runCommand(sessionId: string, command: string, args?: string): Promise<void>;

  // ---- interactive requests (the agent asks; the user must answer) ----
  /** Pending questions in the workspace (recovery on open). */
  listQuestions(sessionId?: string): Promise<QuestionAskedEvent[]>;
  /** Pending permission requests in the workspace (recovery on open). */
  listPermissions(sessionId?: string): Promise<PermissionAskedEvent[]>;
  answerQuestion(requestId: string, answers: string[][]): Promise<void>;
  rejectQuestion(requestId: string): Promise<void>;
  /** Reply to a permission request: allow once, allow always, or reject. */
  replyPermission(requestId: string, reply: PermissionReply): Promise<void>;
}
