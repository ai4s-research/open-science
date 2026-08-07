// AcpRuntime: drive ANY agent that speaks the Agent Client Protocol (#14, #25).
//
// This is the second `AgentRuntime` alongside `OpenCodeClient`, and the point of
// the seam: the UI, provenance and run recording already talk to `AgentRuntime`,
// so "support Codex / Gemini CLI / Claude Code" becomes "configure a command"
// rather than "write another adapter".
//
// It takes a TRANSPORT rather than spawning the agent itself. The webview has no
// `child_process`, and the gateway web client (a phone) has no local process at
// all — so the child is supervised where the OpenCode sidecar already is, on the
// Rust side, and relayed here. Node tests inject a stdio transport that really
// does spawn one (`./stdio`), which is how this is verified against real agents.
//
// Everything optional in ACP is CAPABILITY-GATED, never assumed: the spec says
// a Client MUST check `initialize`'s capabilities before calling `session/list`,
// `session/load` or `session/delete`, and agents differ widely. So each of those
// has one code path when the agent advertises it and an honest fallback when it
// does not — see `supportsSessionList` / `supportsSessionReplay` below. (An
// earlier draft of this file hard-coded "v1 cannot list or replay"; that was
// read off one agent build, and both are stable v1 methods — codex-acp
// advertises `loadSession`, `sessionCapabilities.{list,delete,resume,close}`.)
//
// What ACP genuinely has no equivalent for, and is therefore honest about rather
// than faked: revert/unrevert, skills, archiving, and running a shell command
// outside a turn. Model selection is NOT in that list: `session/set_config_option`
// is v1's stable way to change a model, reasoning level or permission mode, and
// the options come from the agent (`configOptions`), never from our own catalog.
import { BaseAgentRuntime } from "../base-runtime";
import type { AgentRuntime } from "../runtime";
import type {
  AgentInfo,
  CommandInfo,
  HistoryMessage,
  HistoryPart,
  PermissionAskedEvent,
  PermissionReply,
  QuestionAskedEvent,
  SessionMeta,
  SessionPage,
  SessionQuery,
  SkillInfo,
  ToolCallStatus,
} from "../types";
import type { AcpMcpServer } from "./mcp";
import {
  ACP_PROTOCOL_VERSION,
  JsonRpcError,
  JsonRpcPeer,
  type AcpAgentCapabilities,
  type AcpAgentInfo,
  type AcpAuthMethod,
  type AcpCommand,
  type AcpConfigOption,
  type AcpConfigOptionsResult,
  type AcpInitializeResult,
  type AcpModelInfo,
  type AcpNewSessionResult,
  type AcpPermissionRequest,
  type AcpPromptResult,
  type AcpSessionListResult,
  type AcpSessionNotification,
  type AcpSessionUpdate,
  type AcpToolCallUpdate,
  type JsonRpcTransport,
} from "./protocol";

/** A turn has no deadline: an agent legitimately works for many minutes. */
const NO_TIMEOUT = 0;

/** ACP's `auth_required` error code: the agent needs a sign-in before it will
 *  do this. Its own sign-in — see `explainAuthRequired`. */
const AUTH_REQUIRED = -32000;

export interface AcpRuntimeOptions {
  transport: JsonRpcTransport;
  /** Workspace folder NEW sessions are created in — ACP takes it per session
   *  (`session/new`'s `cwd`), which is exactly our per-session workspace. It is
   *  a default, not a binding: the spec requires the session's `cwd` to be used
   *  "regardless of where the Agent subprocess was spawned", so one agent
   *  process serves sessions in many folders and `setCwd` just moves the target
   *  for the next one. */
  cwd: string;
  /** Optional label for errors and Settings ("Codex", "Gemini CLI"). Falls back
   *  to whatever the agent calls itself in `initialize`. */
  name?: string;
}

/** Pages of `session/list` to walk. A bound, not a policy: an agent with a
 *  runaway cursor must not spin here, and 20 pages is far past any sidebar. */
const MAX_SESSION_PAGES = 20;

interface SessionState {
  title: string;
  /** The folder THIS session was created in (`session/new`'s cwd). Per session,
   *  not per process — sessions in different projects share one agent child. */
  cwd: string;
  /** The agent's own selectors for this session (model, reasoning level, mode),
   *  as last reported by `session/new`, `config_option_update`, or a set. */
  configOptions: AcpConfigOption[];
  /** Accumulated text per `messageId`. ACP streams agent_message_chunk as
   *  DELTAS (verified against codex-acp 1.1.9), while our `text.updated` carries
   *  the full current value and the app upserts by `partId` — so the runtime
   *  accumulates, exactly as `OpenCodeClient` does for its own deltas. */
  text: Map<string, string>;
  reasoning: Map<string, string>;
  models: AcpModelInfo[];
  currentModelId?: string;
  /** Resolve for the in-flight `session/prompt`, so `abortSession` can settle. */
  promptRunning: boolean;
  /** Turns started, so a chunk that carries NO `messageId` can still be keyed to
   *  its own turn. Verified against codex-acp 1.1.9: its pre-answer notices (a
   *  skills-budget warning) arrive id-less, and a single shared fallback key
   *  would glue every such notice in the session into one growing block. */
  turn: number;
}

export class AcpRuntime extends BaseAgentRuntime implements AgentRuntime {
  private readonly peer: JsonRpcPeer;
  private readonly sessions = new Map<string, SessionState>();
  /** Folder the NEXT `session/new` uses. Mutable (`setCwd`): the workspace moves
   *  while the agent process stays. */
  private cwd: string;
  private readonly label?: string;
  /** Sessions the AGENT told us about (`session/list`), by id: their folder and
   *  title. Not sessions of ours — this is what lets a conversation created in
   *  an earlier run be restored into the folder it belongs to. */
  private readonly known = new Map<string, { cwd: string; title: string }>();
  /** MCP servers every session is created with. ACP takes them per session
   *  where OpenCode holds them globally, so they are set once and sent with
   *  each `session/new` / `session/load`. */
  private mcpServers: AcpMcpServer[] = [];
  /** Sessions being replayed by `session/load` right now. While a session has a
   *  collector, its `session/update` notifications are HISTORY, not live events,
   *  and must be collected instead of emitted — emitting them would append the
   *  whole past conversation to a thread that is already showing it. */
  private readonly replays = new Map<string, ReplayCollector>();
  private agentInfo?: AcpAgentInfo;
  private agentCapabilities?: AcpAgentCapabilities;
  /** Sign-in methods the agent listed at `initialize`, so a refusal can name
   *  them ("it offers ChatGPT") instead of leaving the user guessing. */
  private authMethods: AcpAuthMethod[] = [];
  private commands: CommandInfo[] = [];
  /** Permission requests the agent is blocked on, keyed by our own request id.
   *  ACP answers a permission by RESPONDING to the agent's request, so the
   *  resolver has to be held until the user replies. */
  private readonly permissions = new Map<
    string,
    { event: PermissionAskedEvent; options: AcpPermissionRequest["options"]; resolve: (v: unknown) => void }
  >();
  private permissionSeq = 0;

  constructor(opts: AcpRuntimeOptions) {
    super();
    this.cwd = opts.cwd;
    this.label = opts.name;
    this.peer = new JsonRpcPeer(opts.transport, {
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params) => this.onAgentRequest(method, params),
      onClose: (reason) => {
        this.setStatus("offline");
        // Every session's turn dies with the process; say so once rather than
        // leaving the UI spinning on a turn that can never finish.
        for (const [id, s] of this.sessions) {
          if (!s.promptRunning) continue;
          s.promptRunning = false;
          this.emit({ type: "error", sessionId: id, message: reason ?? "the agent exited" });
          this.emit({ type: "session.idle", sessionId: id });
        }
      },
    });
  }

  /** What the agent calls itself, for Settings and error messages. */
  get displayName(): string {
    return this.label ?? this.agentInfo?.title ?? this.agentInfo?.name ?? "ACP agent";
  }

  /** Whether the agent can replay a past conversation (`initialize`'s
   *  `loadSession`) — what decides whether reopening a session shows its
   *  history at all. See `getMessages`. */
  get supportsSessionReplay(): boolean {
    return this.agentCapabilities?.loadSession === true;
  }

  /** Whether the agent keeps its own session history and will list it
   *  (`sessionCapabilities.list`). The spec signals support by the key being
   *  PRESENT (its value is an empty object), so this tests presence. */
  get supportsSessionList(): boolean {
    return this.agentCapabilities?.sessionCapabilities?.list !== undefined;
  }

  /** Whether `session/delete` may be called (`sessionCapabilities.delete`).
   *  Without it, "delete" can only forget the session locally. */
  get supportsSessionDelete(): boolean {
    return this.agentCapabilities?.sessionCapabilities?.delete !== undefined;
  }

  /** Whether a session can be restored WITHOUT replaying its history
   *  (`sessionCapabilities.resume`) — what makes a conversation still on screen
   *  usable again after the agent process changed. */
  get supportsSessionResume(): boolean {
    return this.agentCapabilities?.sessionCapabilities?.resume !== undefined;
  }

  /**
   * The MCP servers new sessions should connect to — this app's own connectors,
   * translated by `toAcpMcpServers`. Replaces the previous list, so a connector
   * the user turned off stops reaching sessions created after that.
   */
  setMcpServers(servers: AcpMcpServer[]): void {
    this.mcpServers = servers;
  }

  /**
   * The subset this agent can actually connect to. Every agent MUST support
   * stdio; HTTP and SSE are optional (`mcpCapabilities`), and sending one an
   * agent never advertised is a protocol violation on our side — so an
   * unsupported transport is dropped rather than hopefully sent.
   */
  private mcpForRequest(): AcpMcpServer[] {
    const caps = (this.agentCapabilities?.mcpCapabilities ?? {}) as Record<string, unknown>;
    return this.mcpServers.filter((server) => {
      if (!("type" in server)) return true; // stdio: always supported
      return caps[server.type] === true;
    });
  }

  /** Point new sessions at another workspace folder. Existing sessions keep
   *  their own `cwd` — the agent binds it per session, so nothing is restarted
   *  and no live conversation moves. */
  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  /** Models the agent reported beside the session, if any. Display only: a model
   *  is CHANGED through `configOptions` (`setConfigOption`), which is where a
   *  modern agent exposes it. */
  modelsFor(sessionId: string): AcpModelInfo[] {
    return this.sessions.get(sessionId)?.models ?? [];
  }

  /** The agent's own selectors for a session — model, reasoning level,
   *  permission mode, whatever it chose to expose. Empty when it exposes none. */
  configOptionsFor(sessionId: string): AcpConfigOption[] {
    return this.sessions.get(sessionId)?.configOptions ?? [];
  }

  /**
   * Change one of the agent's session selectors (`session/set_config_option`).
   *
   * The agent answers with the COMPLETE option list, which replaces ours —
   * options can depend on each other (picking a model can change which
   * reasoning levels exist), so merging our stale copy would show levels the
   * agent no longer offers. Returns the new list.
   */
  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<AcpConfigOption[]> {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`unknown session ${sessionId}`);
    const result = await this.peer.request<AcpConfigOptionsResult>("session/set_config_option", {
      sessionId,
      configId,
      value,
    });
    state.configOptions = result?.configOptions ?? state.configOptions;
    return state.configOptions;
  }

  // ---- lifecycle ----

  async connect(): Promise<void> {
    // Idempotent: the app reconnects whenever the workspace moves, and this
    // runtime now OUTLIVES those moves (one agent process, cwd per session). A
    // second `initialize` on a live peer is at best wasted and at worst an
    // error the agent is entitled to return.
    if (this.getStatus() === "ready") return;
    this.setStatus("connecting");
    try {
      const result = await this.peer.request<AcpInitializeResult>("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        // Both false on purpose for this slice: with `fs` advertised the agent
        // would send us `fs/read_text_file` / `fs/write_text_file` requests, and
        // answering those means handing an external process file access from
        // inside the app — which AGENTS.md puts behind approval. The agent still
        // reads and writes through its OWN tools, which stay subject to its own
        // permission requests, and those we do answer.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      this.agentInfo = result.agentInfo;
      this.agentCapabilities = result.agentCapabilities;
      this.authMethods = result.authMethods ?? [];
      if (result.protocolVersion !== ACP_PROTOCOL_VERSION) {
        // Not fatal: v1 is what every agent tested answers, and a higher number
        // means the agent is newer, not incompatible. Recorded, not enforced.
        this.emit({
          type: "error",
          message: `${this.displayName} negotiated ACP protocol version ${result.protocolVersion}, not ${ACP_PROTOCOL_VERSION}`,
        });
      }
      this.setStatus("ready");
    } catch (err) {
      this.setStatus("offline");
      throw err;
    }
  }

  close(): void {
    this.peer.close();
    this.setStatus("offline");
  }

  // ---- sessions ----

  async createSession(title?: string): Promise<string> {
    const cwd = this.cwd;
    let result: AcpNewSessionResult;
    try {
      result = await this.peer.request<AcpNewSessionResult>("session/new", {
        cwd,
        mcpServers: this.mcpForRequest(),
      });
    } catch (err) {
      // The first thing a signed-out agent refuses, and the first thing the
      // user sees — so this is where the dead end has to become an instruction.
      throw this.explainAuthRequired(err);
    }
    this.sessions.set(result.sessionId, {
      // ACP's own title (when the agent has one) arrives via `session/list`; the
      // app's is kept here so a brand-new session has a name before then.
      title: title ?? "New session",
      cwd,
      configOptions: result.configOptions ?? [],
      text: new Map(),
      reasoning: new Map(),
      models: result.models?.availableModels ?? [],
      currentModelId: result.models?.currentModelId,
      promptRunning: false,
      turn: 0,
    });
    return result.sessionId;
  }

  async forkSession(_sessionId: string, _messageId?: string): Promise<string> {
    throw new Error(`${this.displayName} does not support session forks`);
  }

  /**
   * The agent's sessions, when it keeps any (`sessionCapabilities.list`), merged
   * with the ones created here.
   *
   * Deliberately UNFILTERED by cwd, though `session/list` accepts that filter:
   * the sidebar groups sessions by folder itself, and filtering would hide every
   * conversation belonging to a project the user is not currently standing in.
   * A listing failure falls back to the local sessions rather than emptying the
   * sidebar — a transient RPC error must not read as "your history is gone".
   */
  async listSessions(): Promise<SessionMeta[]> {
    const local = (): SessionMeta[] =>
      [...this.sessions.entries()].map(([id, s]) => ({ id, title: s.title, directory: s.cwd }));
    if (!this.supportsSessionList) return local();
    try {
      const listed = new Map<string, SessionMeta>();
      let cursor: string | undefined;
      for (let page = 0; page < MAX_SESSION_PAGES; page++) {
        const result = await this.peer.request<AcpSessionListResult>(
          "session/list",
          cursor ? { cursor } : {},
        );
        for (const info of result?.sessions ?? []) {
          if (!info?.sessionId) continue;
          const known = this.sessions.get(info.sessionId);
          const updated = info.updatedAt ? Date.parse(info.updatedAt) : NaN;
          // Remember where it lives: restoring it later has to name the folder
          // it belongs to, which is not the one we happen to be standing in.
          if (info.cwd)
            this.known.set(info.sessionId, {
              cwd: info.cwd,
              title: info.title || known?.title || "Session",
            });
          listed.set(info.sessionId, {
            id: info.sessionId,
            title: info.title || known?.title || "Session",
            directory: info.cwd,
            ...(Number.isFinite(updated) ? { updated } : {}),
          });
        }
        cursor = result?.nextCursor ?? undefined;
        if (!cursor) break;
      }
      // A session created seconds ago may not be listed yet (agents write their
      // history when a turn produces something); keep ours so the conversation
      // the user is in cannot vanish from the sidebar mid-turn.
      for (const meta of local()) if (!listed.has(meta.id)) listed.set(meta.id, meta);
      return [...listed.values()];
    } catch {
      return local();
    }
  }

  async querySessions(_query?: SessionQuery): Promise<SessionPage> {
    return { sessions: await this.listSessions(), nextCursor: null };
  }

  async setSessionArchived(_sessionId: string, _archived: boolean): Promise<void> {
    throw new Error(`${this.displayName} does not support archiving conversations`);
  }

  async deleteSession(sessionId: string): Promise<void> {
    // Forget it locally either way: an agent that cannot delete must still not
    // keep showing a conversation the user deleted in this app.
    const known = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (!this.supportsSessionDelete) return;
    try {
      await this.peer.request("session/delete", { sessionId });
    } catch (err) {
      // Put it back: the agent still has it, so hiding it here would make the
      // sidebar disagree with the next `session/list`.
      if (known) this.sessions.set(sessionId, known);
      throw err;
    }
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) s.title = title;
  }

  /**
   * A past conversation, from `session/load` when the agent advertises
   * `loadSession`.
   *
   * ACP replays history as `session/update` NOTIFICATIONS — the same shape a
   * live turn streams — and only then answers the request. So the notifications
   * for this session are diverted into a collector for the duration (emitting
   * them would append the whole conversation to the thread that is displaying
   * it), and the collected turns are returned as history instead.
   *
   * Every replayed message is marked completed: an assistant message with no
   * completion time is how this app recognises a turn still in flight, and a
   * reopened session would otherwise show "Working…" with a Stop button for a
   * turn that ended days ago.
   */
  async getMessages(sessionId: string): Promise<HistoryMessage[]> {
    if (!this.supportsSessionReplay) return [];
    const state = this.sessions.get(sessionId);
    // Never replay a session that is mid-turn. A replay diverts this session's
    // notifications into the collector, so loading a running turn would swallow
    // the tokens it is streaming — and the caller (a reconnect reconciling
    // "is this turn over") reads an empty history as "still running", which is
    // exactly right here.
    if (state?.promptRunning) return [];
    // Register the session BEFORE loading: the replay carries its selectors and
    // title, which have nowhere to land otherwise — this session exists on the
    // agent (it came from `session/list`), this client just never made it.
    if (!state) {
      const remembered = this.known.get(sessionId);
      this.sessions.set(sessionId, this.blankState(remembered?.cwd ?? this.cwd, remembered?.title));
    }
    const collector = new ReplayCollector();
    this.replays.set(sessionId, collector);
    try {
      await this.peer.request("session/load", {
        sessionId,
        cwd: state?.cwd ?? this.cwd,
        // Reconnected per load, exactly as on `session/new`: the spec has the
        // Client restate them, and a session reopened without its connectors
        // would answer the next prompt with fewer tools than it had before.
        mcpServers: this.mcpForRequest(),
      });
    } catch {
      // A refused or timed-out load leaves the thread as it was — better than
      // replacing a conversation with a half-replayed one.
      return [];
    } finally {
      // Always: while an entry is here, live events for this session are being
      // swallowed as "history".
      this.replays.delete(sessionId);
    }
    return collector.finish();
  }

  /**
   * A session this runtime can act on, restoring it first if the agent process
   * has no record of it.
   *
   * That happens routinely, and used to strand the conversation: the agent child
   * restarts (a crash, switching agents and back), the thread is still on screen
   * because it lives in this app's memory, and the next prompt went to a session
   * the new process had never heard of. `session/resume` is the right repair —
   * it restores the context and reconnects the MCP servers WITHOUT replaying the
   * history we are already showing. An agent that only offers `session/load` is
   * loaded instead and its replay discarded, for the same reason.
   */
  private async ensureSession(sessionId: string): Promise<SessionState> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    if (!this.supportsSessionResume && !this.supportsSessionReplay) {
      throw new Error(`unknown session ${sessionId}`);
    }
    const remembered = this.known.get(sessionId);
    const cwd = remembered?.cwd ?? this.cwd;
    // Registered BEFORE the call: the agent reports the session's selectors and
    // title while restoring it, and those updates have nowhere to land
    // otherwise. Removed again if the restore fails, so a dead id cannot look
    // like a live session.
    const state = this.blankState(cwd, remembered?.title);
    this.sessions.set(sessionId, state);
    try {
      if (this.supportsSessionResume) {
        await this.peer.request("session/resume", {
          sessionId,
          cwd,
          mcpServers: this.mcpForRequest(),
        });
      } else {
        // Load replays the whole conversation; divert it, or the past would
        // arrive as live events on top of the thread already showing it.
        this.replays.set(sessionId, new ReplayCollector());
        try {
          await this.peer.request("session/load", {
            sessionId,
            cwd,
            mcpServers: this.mcpForRequest(),
          });
        } finally {
          this.replays.delete(sessionId);
        }
      }
    } catch (err) {
      this.sessions.delete(sessionId);
      // A logout can strand an existing session too — the spec says so.
      throw this.explainAuthRequired(err);
    }
    return state;
  }

  /**
   * An `auth_required` refusal, turned into something the user can act on.
   *
   * The agent's sign-in is the AGENT's — Codex's ChatGPT login, Gemini's Google
   * account — and this app holds no credentials for it, so there is nothing to
   * fix in Settings. Deliberately NOT wired to ACP's `authenticate`: every
   * client surveyed treats an external login as the normal case (agent-shell
   * sends no authenticate request at all by default), and a user who configured
   * `npx …` as the agent command has the terminal that login needs. What was
   * missing was only the sentence saying so — the raw refusal is a dead end.
   *
   * Anything that is not `auth_required` passes through untouched.
   */
  private explainAuthRequired(err: unknown): unknown {
    if (!(err instanceof JsonRpcError) || err.code !== AUTH_REQUIRED) return err;
    const offers = this.authMethods.map((m) => m.name ?? m.id).filter(Boolean);
    return new Error(
      `${this.displayName} is not signed in: ${err.message}. ` +
        `Its sign-in is its own — run the agent's login command in a terminal` +
        (offers.length > 0 ? ` (it offers ${offers.join(", ")})` : "") +
        `, then reconnect in Settings → Runtime.`,
    );
  }

  /** A session record with nothing learned yet. */
  private blankState(cwd: string, title = "Session"): SessionState {
    return {
      title,
      cwd,
      configOptions: [],
      text: new Map(),
      reasoning: new Map(),
      models: [],
      promptRunning: false,
      turn: 0,
    };
  }

  async appendTextPart(
    _sessionId: string,
    _messageId: string,
    _text: string,
    _partId?: string,
  ): Promise<string> {
    throw new Error(`${this.displayName} does not support synthetic message parts`);
  }

  async sendPrompt(
    sessionId: string,
    text: string,
    _agent?: string,
    _model?: string | null,
    _variant?: string | null,
  ): Promise<void> {
    const state = await this.ensureSession(sessionId);
    state.promptRunning = true;
    state.turn += 1;
    // `agent`, `model` and `variant` are deliberately dropped, not silently
    // approximated: ACP v1 has no per-turn agent, no `session/set_model`, and no
    // effort vocabulary. codex-acp folds effort INTO the model id, so honouring
    // `variant` would mean guessing another agent's id grammar.
    try {
      const result = await this.peer.request<AcpPromptResult>(
        "session/prompt",
        { sessionId, prompt: [{ type: "text", text }] },
        NO_TIMEOUT,
      );
      state.promptRunning = false;
      if (result?.stopReason && result.stopReason !== "end_turn" && result.stopReason !== "cancelled") {
        // "max_tokens", "refusal", … — the turn ended for a reason the user has
        // to know about, in the agent's own word for it.
        this.emit({ type: "error", sessionId, message: `the turn stopped: ${result.stopReason}` });
      }
      this.emit({ type: "session.idle", sessionId });
    } catch (err) {
      state.promptRunning = false;
      const explained = this.explainAuthRequired(err);
      this.emit({
        type: "error",
        sessionId,
        message: explained instanceof Error ? explained.message : String(explained),
      });
      this.emit({ type: "session.idle", sessionId });
    }
  }

  async abortSession(sessionId: string): Promise<void> {
    // A notification, not a request: ACP's `session/cancel` has no response, and
    // the turn's own `session/prompt` settles with stopReason "cancelled".
    this.peer.notify("session/cancel", { sessionId });
  }

  async revert(_sessionId: string, _messageID: string, _partID?: string): Promise<void> {
    throw new Error(`${this.displayName} does not support reverting messages`);
  }

  async unrevert(_sessionId: string): Promise<void> {
    throw new Error(`${this.displayName} does not support reverting messages`);
  }

  // ---- compaction & usage (not ACP concepts) ----

  async compactSession(_sessionId: string): Promise<void> {
    throw new Error(`${this.displayName} does not support compacting sessions`);
  }

  async getSessionInfo(): Promise<Record<string, never>> {
    return {}; // ACP carries no token accounting the app could read here.
  }

  async setModelContextLimit(): Promise<void> {
    throw new Error(`${this.displayName} does not support changing the context limit`);
  }

  async getModelContextLimit(): Promise<number> {
    return 0; // Unknown; the UI shows "auto".
  }

  // ---- capability discovery ----

  async listSkills(): Promise<SkillInfo[]> {
    return []; // Not an ACP concept; an agent's skills are its own business.
  }

  async listAgents(): Promise<AgentInfo[]> {
    // ACP has no sub-agent catalog. Reporting the connected agent itself keeps
    // the UI's "which agent am I talking to" honest without inventing modes.
    return [{ name: this.agentInfo?.name ?? "acp", description: this.displayName }];
  }

  async listCommands(): Promise<CommandInfo[]> {
    // Filled from `available_commands_update`, which arrives unprompted right
    // after `session/new` (verified against codex-acp: plan, mcp, skills,
    // status, review, …).
    return this.commands;
  }

  // ---- model selection ----

  async getDefaultModel(): Promise<string | null> {
    for (const s of this.sessions.values()) if (s.currentModelId) return s.currentModelId;
    return null;
  }

  async setDefaultModel(_model: string): Promise<void> {
    throw new Error(
      `${this.displayName} owns its own model choice — ACP has no model-setting method (see docs/rfc/multi-agent-acp.md)`,
    );
  }

  // ---- agent-driven execution ----

  async runShell(_sessionId: string, _command: string, _agent?: string): Promise<void> {
    // Running a command OUTSIDE a turn has no ACP equivalent. The agent's own
    // shell tool still works — it just goes through a prompt.
    throw new Error(`${this.displayName} does not support running a shell command outside a turn`);
  }

  async runCommand(sessionId: string, command: string, args?: string): Promise<void> {
    // ACP's own commands are invoked as prompt text, which is how the agents
    // that advertise them expect it (`/review`, `/plan`).
    await this.sendPrompt(sessionId, args ? `/${command} ${args}` : `/${command}`);
  }

  // ---- interactive requests ----

  async listQuestions(_sessionId?: string): Promise<QuestionAskedEvent[]> {
    return []; // ACP has no "question" kind; everything is a permission request.
  }

  async listPermissions(sessionId?: string): Promise<PermissionAskedEvent[]> {
    return [...this.permissions.values()]
      .map((p) => p.event)
      .filter((e) => !sessionId || e.sessionId === sessionId);
  }

  async answerQuestion(_requestId: string, _answers: string[][]): Promise<void> {
    throw new Error(`${this.displayName} does not ask questions`);
  }

  async rejectQuestion(_requestId: string): Promise<void> {
    throw new Error(`${this.displayName} does not ask questions`);
  }

  async replyPermission(requestId: string, reply: PermissionReply): Promise<void> {
    const entry = this.permissions.get(requestId);
    if (!entry) return; // already answered, or resolved by the agent giving up
    this.permissions.delete(requestId);
    const option = pickPermissionOption(entry.options, reply);
    // The reply IS the response to the agent's blocked request.
    entry.resolve(
      option
        ? { outcome: { outcome: "selected", optionId: option } }
        : { outcome: { outcome: "cancelled" } },
    );
    this.emit({ type: "permission.resolved", sessionId: entry.event.sessionId, requestId });
  }

  // ---- inbound ----

  private onNotification(method: string, params: unknown): void {
    if (method !== "session/update") return;
    const note = params as AcpSessionNotification;
    if (!note?.sessionId || !note.update) return;
    this.applyUpdate(note.sessionId, note.update);
  }

  private applyUpdate(sessionId: string, update: AcpSessionUpdate): void {
    const state = this.sessions.get(sessionId);
    // Session STATE, not conversation: which model/mode the session is on, and
    // what it is called. Handled BEFORE the replay diversion below, because a
    // reopened session must show the selectors it is actually running with —
    // they arrive during the replay, and swallowing them as "history" would
    // leave the composer offering the previous session's model.
    if (update.sessionUpdate === "config_option_update") {
      // The agent sends the COMPLETE list, so it replaces ours rather than
      // merging: options depend on each other (a model decides which reasoning
      // levels exist).
      if (state) state.configOptions = (update.configOptions as AcpConfigOption[] | undefined) ?? [];
      return;
    }
    if (update.sessionUpdate === "session_info_update") {
      // The agent named (or renamed) the session — usually from the first
      // prompt. This is the title the sidebar shows until the next
      // `session/list`.
      const title = update.title as string | undefined;
      if (state && title) state.title = title;
      return;
    }
    // A `session/load` is in flight for this session: these updates are its
    // REPLAY, not new activity. Collect them as history; emitting them would
    // duplicate the conversation into the thread that asked for it.
    const replay = this.replays.get(sessionId);
    if (replay) {
      replay.apply(update);
      return;
    }
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const partId = update.messageId ?? `message@${state?.turn ?? 0}`;
        const text = accumulate(state?.text, partId, update.content?.text ?? "");
        this.emit({ type: "text.updated", sessionId, partId, text });
        return;
      }
      case "agent_thought_chunk": {
        const partId = update.messageId ?? `thought@${state?.turn ?? 0}`;
        const text = accumulate(state?.reasoning, partId, update.content?.text ?? "");
        this.emit({ type: "reasoning.updated", sessionId, partId, text });
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        const call = update as unknown as AcpToolCallUpdate;
        if (!call.toolCallId) return;
        this.emit({
          type: "tool.updated",
          sessionId,
          callId: call.toolCallId,
          tool: call.kind ?? call.title ?? "tool",
          status: mapToolStatus(call.status),
          title: call.title,
          input: call.rawInput,
          output: toolOutput(call),
        });
        return;
      }
      case "available_commands_update": {
        this.commands = (update.availableCommands ?? []).map((c: AcpCommand) => ({
          name: c.name,
          description: c.description,
          source: "command",
        }));
        return;
      }
      // Deliberately ignored: `plan` (no thread block for it yet),
      // `usage_update` (agent-specific bookkeeping), `current_mode_update`
      // (superseded by config options), and `user_message_chunk` — live, the
      // app already shows what the user sent; during a replay it is history and
      // never reaches here (see the collector above).
      default:
        return;
    }
  }

  private onAgentRequest(method: string, params: unknown): Promise<unknown> | unknown {
    if (method !== "session/request_permission") {
      throw new Error(`unsupported: ${method}`);
    }
    const req = params as AcpPermissionRequest;
    const requestId = `acp-perm-${++this.permissionSeq}`;
    const event: PermissionAskedEvent = {
      type: "permission.asked",
      sessionId: req.sessionId,
      requestId,
      action: req.toolCall?.kind ?? req.toolCall?.title ?? "run",
      resources: permissionResources(req.toolCall),
    };
    return new Promise((resolve) => {
      this.permissions.set(requestId, { event, options: req.options, resolve });
      this.emit(event);
    });
  }
}

/**
 * Turns a `session/load` replay back into conversation history.
 *
 * ACP replays a past conversation as the same `session/update` notifications a
 * live turn streams, so this is the inverse of the live fold: chunks accumulate
 * into message parts instead of being emitted, and a `user_message_chunk` is
 * what ends one turn and starts the next.
 *
 * The shapes it produces are the app's history shapes (`type: "text" |
 * "reasoning" | "tool"`, tool status in the runtime's own vocabulary), so a
 * replayed conversation renders through exactly the same path as an OpenCode
 * one — no ACP-specific branch in the thread.
 */
class ReplayCollector {
  private readonly messages: HistoryMessage[] = [];
  /** The turn being built. Parts are keyed so a later chunk or tool update
   *  lands on the part it belongs to rather than appending a new one. */
  private assistant: HistoryMessage | null = null;
  private parts = new Map<string, HistoryPart>();
  private userMessage: HistoryMessage | null = null;
  private userId: string | undefined;

  apply(update: AcpSessionUpdate): void {
    switch (update.sessionUpdate) {
      case "user_message_chunk":
        return this.user(update.messageId, update.content?.text ?? "");
      case "agent_message_chunk":
        return this.assistantText("text", update.messageId, update.content?.text ?? "");
      case "agent_thought_chunk":
        return this.assistantText("reasoning", update.messageId, update.content?.text ?? "");
      case "tool_call":
      case "tool_call_update":
        return this.tool(update as unknown as AcpToolCallUpdate);
      // Everything else in a replay is bookkeeping (commands, config, usage):
      // it says nothing about what was said.
      default:
        return;
    }
  }

  /** The collected conversation, every message marked finished. */
  finish(completedAt = Date.now()): HistoryMessage[] {
    for (const m of this.messages) m.completed = completedAt;
    return this.messages;
  }

  private user(messageId: string | undefined, text: string): void {
    // Consecutive chunks of the SAME user message append; a new id (or the
    // first chunk after an assistant turn) starts a new one.
    if (this.userMessage && (messageId === undefined || messageId === this.userId)) {
      const part = this.userMessage.parts[0];
      part.text = (part.text ?? "") + text;
      return;
    }
    const message: HistoryMessage = { role: "user", parts: [{ type: "text", text }] };
    if (messageId) message.id = messageId;
    this.messages.push(message);
    this.userMessage = message;
    this.userId = messageId;
    // A user message ends the previous turn: what follows belongs to a new one.
    this.assistant = null;
    this.parts.clear();
  }

  private assistantText(type: "text" | "reasoning", messageId: string | undefined, delta: string): void {
    const message = this.ensureAssistant();
    const key = `${type}:${messageId ?? "@"}`;
    let part = this.parts.get(key);
    if (!part) {
      part = { type, text: "" };
      this.parts.set(key, part);
      message.parts.push(part);
    }
    part.text = (part.text ?? "") + delta;
  }

  private tool(call: AcpToolCallUpdate): void {
    if (!call.toolCallId) return;
    const message = this.ensureAssistant();
    const key = `tool:${call.toolCallId}`;
    let part = this.parts.get(key);
    if (!part) {
      part = { type: "tool", tool: call.kind ?? call.title ?? "tool", state: {} };
      this.parts.set(key, part);
      message.parts.push(part);
    }
    // `tool_call_update` carries only what CHANGED, so each field is merged
    // rather than assigned — an update with no title must not erase the one the
    // original `tool_call` gave.
    if (call.kind || call.title) part.tool = call.kind ?? part.tool;
    const state = (part.state ??= {});
    if (call.status) state.status = historyToolStatus(call.status);
    if (call.title) state.title = call.title;
    if (call.rawInput) state.input = call.rawInput;
    const output = toolOutput(call);
    if (output) state.output = output;
  }

  private ensureAssistant(): HistoryMessage {
    if (this.assistant) return this.assistant;
    const message: HistoryMessage = { role: "assistant", parts: [] };
    this.messages.push(message);
    this.assistant = message;
    this.userMessage = null;
    this.userId = undefined;
    this.parts.clear();
    return message;
  }
}

/** ACP tool status → the vocabulary the app's HISTORY reader expects
 *  ("running" | "completed" | "error"), which is the runtime's own, not ACP's. */
function historyToolStatus(status: string): string {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "error";
    case "in_progress":
      return "running";
    default:
      return status;
  }
}

/** Append a delta and return the accumulated value. */
function accumulate(store: Map<string, string> | undefined, key: string, delta: string): string {
  if (!store) return delta;
  const next = (store.get(key) ?? "") + delta;
  store.set(key, next);
  return next;
}

/** ACP tool statuses → ours. ACP uses "pending" | "in_progress" | "completed" |
 *  "failed"; anything unknown is treated as still running, which is the safe
 *  reading (a tool that never reports completion must not look finished). */
export function mapToolStatus(status?: string): ToolCallStatus {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "failed";
    case "pending":
      return "pending";
    default:
      return "running";
  }
}

/** The text an ACP tool call reported, flattened — its `content` is a list of
 *  blocks, each either a bare `text` or a nested content block. */
function toolOutput(call: AcpToolCallUpdate): string | undefined {
  const parts = (call.content ?? [])
    .map((c) => c.content?.text ?? c.text ?? "")
    .filter((t) => t.length > 0);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** What the permission is ABOUT, for the approval dialog: the command line or
 *  file path the agent named, falling back to the tool's own title. */
function permissionResources(call?: AcpToolCallUpdate): string[] {
  if (!call) return [];
  const raw = call.rawInput ?? {};
  const named = ["command", "filePath", "file_path", "path", "abs_path"]
    .map((k) => raw[k])
    .find((v) => typeof v === "string" && v.length > 0);
  if (typeof named === "string") return [named];
  return call.title ? [call.title] : [];
}

/**
 * Our three-way reply → one of the agent's own option ids.
 *
 * ACP does not name its options: the agent sends a list and we must pick an
 * `optionId` from it, so the mapping goes through each option's `kind`
 * ("allow_once" | "allow_always" | "reject_once" | "reject_always"). Falling
 * back to position would be wrong in the one case that matters — picking
 * "always allow" when the user said "once".
 */
export function pickPermissionOption(
  options: AcpPermissionRequest["options"],
  reply: PermissionReply,
): string | undefined {
  const wanted =
    reply === "once" ? ["allow_once", "allow_always"] : reply === "always" ? ["allow_always"] : ["reject_once", "reject_always"];
  for (const kind of wanted) {
    const hit = (options ?? []).find((o) => o.kind === kind);
    if (hit) return hit.optionId;
  }
  // No option of the kind we need. Rejecting has a safe fallback — cancel, which
  // `replyPermission` sends when this returns undefined — but allowing does not,
  // so an unmatched allow must NOT silently become some other option.
  return undefined;
}
