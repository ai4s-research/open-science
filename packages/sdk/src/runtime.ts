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
  SessionPage,
  SessionQuery,
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
  /** Create a session, optionally giving the runtime a concise initial title. */
  createSession(title?: string): Promise<string>;
  /** The RECENT conversations, newest first, across every workspace folder,
   *  archived ones excluded. Bounded — a multi-year history is never held in
   *  memory; reach the rest through `querySessions`. */
  listSessions(): Promise<SessionMeta[]>;
  /** One page of conversation history, searched and paged on the server. */
  querySessions(query?: SessionQuery): Promise<SessionPage>;
  /** Archive a conversation, or restore it with `false`. Archiving never
   *  deletes anything — the conversation stays searchable. */
  setSessionArchived(sessionId: string, archived: boolean): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  /** Give a session a title of the user's choosing. */
  renameSession(sessionId: string, title: string): Promise<void>;
  getMessages(sessionId: string): Promise<HistoryMessage[]>;
  /** `agent` pins a specific agent for the turn (e.g. the read-only "plan"
   *  agent); omit for the runtime default. `model` ("provider/model") pins the
   *  turn to the current default, overriding a session's stale creation-time
   *  binding; omit to use the session/runtime default. `variant` picks a
   *  per-turn reasoning-effort level (a name from the model's `variants`); omit
   *  for the model's default effort. See lib/runtime.ts. */
  sendPrompt(
    sessionId: string,
    text: string,
    agent?: string,
    model?: string | null,
    variant?: string | null,
  ): Promise<void>;
  abortSession(sessionId: string): Promise<void>;
  /** Revert the session to (and including) `messageID`, dropping it and every
   *  message after it (and rolling back any files they changed). Used to edit a
   *  past user message: revert to it, then `sendPrompt` the corrected text.
   *  The session must be idle first (abort a running turn before calling). */
  revert(sessionId: string, messageID: string, partID?: string): Promise<void>;
  /** Undo the last revert (restore the dropped messages and files). */
  unrevert(sessionId: string): Promise<void>;

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
