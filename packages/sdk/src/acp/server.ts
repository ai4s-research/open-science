// Open Science AS an ACP agent — the server direction of #14.
//
// The other half of `AcpRuntime`: there, this app is the CLIENT driving someone
// else's agent; here, someone else's editor (Zed, JetBrains, Neovim, …) drives
// OUR runtime in ACP's dialect. Both halves ride the one `AgentRuntime` seam, so
// nothing about sessions, streaming, permissions or history is reimplemented —
// this file is a translator, and the thing being translated is already
// normalized.
//
// It is deliberately transport-agnostic (a `JsonRpcTransport`, same as the
// client half): the editor spawns a process and speaks over its stdio, which is
// the only transport ACP v1 stabilizes, but the tests wire both ends together
// in one process without any pipes.
//
// The inverse of the client's hardest detail lives here: our `text.updated`
// carries the FULL current value, while ACP streams DELTAS — so every chunk is
// diffed against what was already sent for that part. Sending the full value as
// a chunk would make an editor render "ok" as "ook".
import type { AgentRuntime } from "../runtime";
import type {
  HistoryMessage,
  OpenCodeEvent,
  PermissionReply,
  SessionMeta,
  ToolCallStatus,
} from "../types";
import { ACP_PROTOCOL_VERSION, JsonRpcPeer, type JsonRpcTransport } from "./protocol";

/** What we call ourselves in `initialize`. */
const AGENT_NAME = "open-science";
const AGENT_TITLE = "Open Science";

/** ACP's `auth_required`; unused here (the gateway token is the auth) but kept
 *  next to the codes we do answer with. */
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/** A JSON-RPC failure with a code the client can branch on. */
class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export interface AcpAgentServerOptions {
  /** The runtime being exposed. Already connected — this class never owns a
   *  connection, so the same server works over the gateway or in-process. */
  runtime: AgentRuntime;
  transport: JsonRpcTransport;
  /** Absolute path of the workspace folder the runtime is scoped to. A session
   *  is refused for any other `cwd` — see `newSession`. */
  workspace: string;
  /** Version reported in `initialize`. */
  version?: string;
  /** Somewhere to say what was NOT honoured — stderr, for a spawned agent. ACP
   *  forbids anything but protocol messages on stdout, and an editor's agent log
   *  is where a user looks when a tool they configured is missing. */
  onNotice?: (message: string) => void;
}

/** One turn the editor is waiting on. */
interface PendingTurn {
  resolve: (result: { stopReason: string }) => void;
  reject: (err: Error) => void;
  /** Text already streamed per part, so the next update sends only the delta. */
  sent: Map<string, string>;
  /** Tool calls announced, so the second update is `tool_call_update`. */
  tools: Set<string>;
  cancelled: boolean;
}

export class AcpAgentServer {
  private readonly peer: JsonRpcPeer;
  private readonly runtime: AgentRuntime;
  private readonly workspace: string;
  private readonly version: string;
  private readonly notice: (message: string) => void;
  /** Turns in flight, by session. ACP allows one turn per session at a time. */
  private readonly turns = new Map<string, PendingTurn>();
  /** Permission requests relayed to the editor, so a resolution elsewhere (the
   *  desktop window answered it) can be dropped instead of answered twice. */
  private readonly relayed = new Set<string>();
  private unsubscribe?: () => void;

  constructor(opts: AcpAgentServerOptions) {
    this.runtime = opts.runtime;
    this.workspace = opts.workspace;
    this.version = opts.version ?? "0";
    this.notice = opts.onNotice ?? (() => {});
    this.peer = new JsonRpcPeer(opts.transport, {
      onRequest: (method, params) => this.onRequest(method, params),
      onNotification: (method, params) => this.onNotification(method, params),
      onClose: () => this.close(),
    });
    this.unsubscribe = this.runtime.onEvent((event) => this.onRuntimeEvent(event));
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const [, turn] of this.turns) turn.reject(new Error("the connection closed"));
    this.turns.clear();
    this.peer.close();
  }

  // ---- inbound: the editor's requests ----

  private onRequest(method: string, params: unknown): Promise<unknown> | unknown {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "initialize":
        return this.initialize();
      case "session/new":
        return this.newSession(p);
      case "session/load":
        return this.loadSession(p);
      case "session/resume":
        return this.resumeSession(p);
      case "session/list":
        return this.listSessions();
      case "session/delete":
        return this.deleteSession(p);
      case "session/prompt":
        return this.prompt(p);
      default:
        // -32601 is what the peer answers for an unknown method; throwing here
        // keeps the same shape for one we know of but do not implement.
        throw new RpcFailure(-32601, `unsupported: ${method}`);
    }
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== "session/cancel") return;
    const sessionId = (params as { sessionId?: string })?.sessionId;
    if (!sessionId) return;
    const turn = this.turns.get(sessionId);
    if (turn) turn.cancelled = true;
    void this.runtime.abortSession(sessionId).catch(() => {
      /* the turn ends either way; the editor sees stopReason cancelled */
    });
  }

  private initialize() {
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentInfo: { name: AGENT_NAME, title: AGENT_TITLE, version: this.version },
      agentCapabilities: {
        // History is real here: the runtime stores every conversation, so a
        // session can be replayed and listed.
        loadSession: true,
        sessionCapabilities: { list: {}, resume: {}, delete: {} },
        // Text only for now: the runtime takes images through its own composer,
        // and claiming a capability we drop would lose the user's attachment.
        promptCapabilities: { image: false, embeddedContext: false },
      },
      // No `authMethods`: whoever spawned this process already holds the
      // gateway token, which is the credential. There is nothing to sign into.
      authMethods: [],
    };
  }

  private async newSession(p: Record<string, unknown>) {
    const cwd = typeof p.cwd === "string" ? p.cwd : "";
    this.requireWorkspace(cwd);
    this.noteUnusedMcp(p.mcpServers);
    const sessionId = await this.runtime.createSession();
    void this.announceCommands(sessionId);
    return { sessionId };
  }

  private async loadSession(p: Record<string, unknown>) {
    const sessionId = this.requireSessionId(p);
    this.requireWorkspace(typeof p.cwd === "string" ? p.cwd : "");
    const messages = await this.runtime.getMessages(sessionId);
    // ACP replays history as notifications and only then answers the request.
    for (const note of historyNotifications(sessionId, messages)) {
      this.peer.notify("session/update", note);
    }
    void this.announceCommands(sessionId);
    return {};
  }

  private async resumeSession(p: Record<string, unknown>) {
    const sessionId = this.requireSessionId(p);
    this.requireWorkspace(typeof p.cwd === "string" ? p.cwd : "");
    // Nothing to restore: the runtime holds the conversation, not this process.
    // The check is still worth making — resuming a session that does not exist
    // must fail here rather than at the first prompt.
    const sessions = await this.runtime.listSessions();
    if (!sessions.some((s) => s.id === sessionId)) {
      throw new RpcFailure(INVALID_PARAMS, `no such session: ${sessionId}`);
    }
    void this.announceCommands(sessionId);
    return {};
  }

  private async listSessions() {
    const sessions = await this.runtime.listSessions();
    return {
      sessions: sessions.map((s: SessionMeta) => ({
        sessionId: s.id,
        cwd: s.directory ?? this.workspace,
        title: s.title,
        ...(s.updated ? { updatedAt: new Date(s.updated).toISOString() } : {}),
      })),
      nextCursor: null,
    };
  }

  private async deleteSession(p: Record<string, unknown>) {
    await this.runtime.deleteSession(this.requireSessionId(p));
    return {};
  }

  /**
   * One turn. The request stays open for its whole duration — that is what ACP
   * means by a prompt — and resolves when the runtime goes idle, which is also
   * where the stop reason comes from.
   */
  private prompt(p: Record<string, unknown>): Promise<{ stopReason: string }> {
    const sessionId = this.requireSessionId(p);
    const text = promptText(p.prompt);
    if (!text.trim()) throw new RpcFailure(INVALID_PARAMS, "the prompt has no text");
    if (this.turns.has(sessionId)) {
      throw new RpcFailure(INVALID_PARAMS, `session ${sessionId} is already answering`);
    }
    return new Promise<{ stopReason: string }>((resolve, reject) => {
      this.turns.set(sessionId, {
        resolve,
        reject,
        sent: new Map(),
        tools: new Set(),
        cancelled: false,
      });
      this.runtime.sendPrompt(sessionId, text).catch((err: unknown) => {
        this.turns.delete(sessionId);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  /** The runtime's slash commands, as ACP's own list. Best-effort: an editor
   *  that never receives it simply offers none. */
  private async announceCommands(sessionId: string): Promise<void> {
    try {
      const commands = await this.runtime.listCommands();
      if (commands.length === 0) return;
      this.peer.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: commands.map((c) => ({
            name: c.name,
            description: c.description ?? "",
          })),
        },
      });
    } catch {
      /* commands are a convenience, never a reason to fail a session */
    }
  }

  /**
   * Say so when the editor sent MCP servers we do not connect.
   *
   * This runtime brings its OWN connectors (configured in the app, shared by
   * every session) and has no way to add per-session ones. Silently dropping
   * them would leave the editor believing tools are available that never
   * arrive; refusing the session outright would break the integration over
   * something optional. So the session is created and the omission is stated
   * where an editor shows agent logs.
   */
  private noteUnusedMcp(servers: unknown): void {
    if (!Array.isArray(servers) || servers.length === 0) return;
    const names = servers
      .map((s) => (s && typeof s === "object" ? (s as { name?: string }).name : undefined))
      .filter((n): n is string => !!n);
    this.notice(
      `Not connecting ${servers.length} MCP server(s) sent by the editor` +
        (names.length > 0 ? ` (${names.join(", ")})` : "") +
        `: ${AGENT_TITLE} uses the connectors configured in the app.`,
    );
  }

  private requireSessionId(p: Record<string, unknown>): string {
    const sessionId = p.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      throw new RpcFailure(INVALID_PARAMS, "sessionId is required");
    }
    return sessionId;
  }

  /**
   * Refuse a folder this runtime is not scoped to.
   *
   * The runtime works in ONE workspace at a time — the folder the desktop is
   * currently in — and an editor opened somewhere else would otherwise get a
   * session whose file edits land in a different directory than the one it is
   * showing. Refusing names the folder to switch to, which the user can do in
   * the app; silently working in the wrong place cannot be undone by the editor.
   */
  private requireWorkspace(cwd: string): void {
    if (!cwd || samePath(cwd, this.workspace)) return;
    throw new RpcFailure(
      INVALID_PARAMS,
      `${AGENT_TITLE} is working in ${this.workspace}, not ${cwd}. ` +
        `Open that folder in ${AGENT_TITLE} (or open ${this.workspace} here) and try again.`,
    );
  }

  // ---- outbound: runtime events → session/update ----

  private onRuntimeEvent(event: OpenCodeEvent): void {
    const sessionId = "sessionId" in event ? event.sessionId : undefined;
    if (!sessionId) return;
    if (event.type === "permission.asked") {
      // Only for a turn THIS editor is waiting on. The runtime's event stream is
      // workspace-scoped, so it also carries approvals for work the user started
      // in the desktop window — relaying those would pop a dialog in an editor
      // that did not ask for the work, and whichever side answered first would
      // leave the other holding a dead prompt. An approval must be attributable
      // to the surface that asked for the action (AGENTS.md).
      if (this.turns.has(event.sessionId)) {
        void this.relayPermission(event.sessionId, event.requestId, event.action, event.resources);
      }
      return;
    }
    if (event.type === "permission.resolved") {
      this.relayed.delete(event.requestId);
      return;
    }
    const turn = this.turns.get(sessionId);
    if (!turn) return; // an event for a session this editor is not driving
    switch (event.type) {
      case "text.updated":
        return this.chunk(turn, sessionId, "agent_message_chunk", event.partId, event.text);
      case "reasoning.updated":
        return this.chunk(turn, sessionId, "agent_thought_chunk", event.partId, event.text);
      case "tool.updated": {
        const first = !turn.tools.has(event.callId);
        turn.tools.add(event.callId);
        this.peer.notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: first ? "tool_call" : "tool_call_update",
            toolCallId: event.callId,
            title: event.title || event.tool,
            kind: event.tool,
            status: acpToolStatus(event.status),
            ...(event.input ? { rawInput: event.input } : {}),
            ...(event.output
              ? { content: [{ type: "content", content: { type: "text", text: event.output } }] }
              : {}),
          },
        });
        return;
      }
      case "question.asked": {
        // ACP has no "question" kind. Rather than stalling the turn silently,
        // the question is shown as agent text — the editor's user can answer it
        // in the desktop window, or cancel.
        const asked = event.questions
          .map((q) => [q.header, q.question, ...q.options.map((o) => `  • ${o.label}`)].filter(Boolean).join("\n"))
          .join("\n\n");
        this.chunk(turn, sessionId, "agent_message_chunk", `question:${event.requestId}`, asked);
        return;
      }
      case "error": {
        // The turn failed. An error response is more honest than a stop reason:
        // "end_turn" would tell the editor the work finished.
        this.turns.delete(sessionId);
        turn.reject(new RpcFailure(INTERNAL_ERROR, event.message));
        return;
      }
      case "session.idle": {
        this.turns.delete(sessionId);
        turn.resolve({ stopReason: turn.cancelled ? "cancelled" : "end_turn" });
        return;
      }
      default:
        return;
    }
  }

  /** Send only what is NEW for this part — ACP streams deltas, our runtime
   *  emits the full current value. */
  private chunk(
    turn: PendingTurn,
    sessionId: string,
    kind: "agent_message_chunk" | "agent_thought_chunk",
    partId: string,
    full: string,
  ): void {
    const already = turn.sent.get(partId) ?? "";
    // A part that SHRANK (a rebuild, a retry) is not a delta — restate it whole
    // under a fresh id rather than sending nonsense.
    const delta = full.startsWith(already) ? full.slice(already.length) : full;
    if (!delta) return;
    turn.sent.set(partId, full);
    this.peer.notify("session/update", {
      sessionId,
      update: { sessionUpdate: kind, messageId: partId, content: { type: "text", text: delta } },
    });
  }

  /**
   * Hand a permission request to the editor and answer the runtime with what it
   * chose. The editor's own approval UI is the point of the server direction —
   * an approval that could only be given in the desktop window would make the
   * editor's turn hang on a window the user may not even have open.
   */
  private async relayPermission(
    sessionId: string,
    requestId: string,
    action: string,
    resources: string[],
  ): Promise<void> {
    if (this.relayed.has(requestId)) return;
    this.relayed.add(requestId);
    try {
      const answer = (await this.peer.request<{ outcome?: { outcome?: string; optionId?: string } }>(
        "session/request_permission",
        {
          sessionId,
          toolCall: {
            toolCallId: `perm-${requestId}`,
            title: [action, ...resources].filter(Boolean).join(" "),
            kind: action,
            rawInput: resources.length > 0 ? { resources } : undefined,
          },
          options: [
            { optionId: "once", name: "Allow once", kind: "allow_once" },
            { optionId: "always", name: "Always allow", kind: "allow_always" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        },
        0,
      )) ?? {};
      // Anything other than a selection — cancelled, or an editor that answered
      // with a shape we do not recognise — is a rejection. Approval must never
      // be inferred.
      const reply: PermissionReply =
        answer.outcome?.outcome === "selected" && isReply(answer.outcome.optionId)
          ? answer.outcome.optionId
          : "reject";
      await this.runtime.replyPermission(requestId, reply);
    } catch {
      // The editor died or refused to answer: reject, so the runtime is not
      // left blocked on a request nobody will ever resolve.
      await this.runtime.replyPermission(requestId, "reject").catch(() => {});
    } finally {
      this.relayed.delete(requestId);
    }
  }
}

function isReply(value: unknown): value is PermissionReply {
  return value === "once" || value === "always" || value === "reject";
}

/** The text of an ACP prompt: its text blocks joined. Other block kinds are
 *  dropped, which is why `promptCapabilities` claims neither images nor
 *  embedded context. */
function promptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return "";
  return prompt
    .map((block) => (block && typeof block === "object" ? (block as { text?: string }).text ?? "" : ""))
    .filter(Boolean)
    .join("\n");
}

/** Our tool status → ACP's. */
export function acpToolStatus(status: ToolCallStatus): string {
  switch (status) {
    case "success":
      return "completed";
    case "failed":
      return "failed";
    case "pending":
      return "pending";
    default:
      return "in_progress";
  }
}

/**
 * A stored conversation as the `session/update` notifications `session/load`
 * must replay. The inverse of the client half's `ReplayCollector`.
 */
export function historyNotifications(
  sessionId: string,
  messages: HistoryMessage[],
): Array<{ sessionId: string; update: Record<string, unknown> }> {
  const out: Array<{ sessionId: string; update: Record<string, unknown> }> = [];
  const push = (update: Record<string, unknown>) => out.push({ sessionId, update });
  for (const [index, message] of messages.entries()) {
    for (const [partIndex, part] of message.parts.entries()) {
      const messageId = message.id ?? `m${index}`;
      if (part.type === "text" && part.text?.trim()) {
        // A synthetic user text is the runtime's own marker (the "!" shell
        // echo), not something the user wrote — it belongs to no transcript.
        if (message.role === "user" && part.synthetic) continue;
        push({
          sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk",
          messageId,
          content: { type: "text", text: part.text },
        });
        continue;
      }
      if (part.type === "reasoning" && part.text?.trim()) {
        push({
          sessionUpdate: "agent_thought_chunk",
          messageId,
          content: { type: "text", text: part.text },
        });
        continue;
      }
      if (part.type === "tool") {
        push({
          sessionUpdate: "tool_call",
          toolCallId: `${messageId}:${partIndex}`,
          title: part.state?.title || part.tool || "tool",
          kind: part.tool ?? "tool",
          status: historyToolStatus(part.state?.status),
          ...(part.state?.input ? { rawInput: part.state.input } : {}),
          ...(part.state?.output
            ? { content: [{ type: "content", content: { type: "text", text: part.state.output } }] }
            : {}),
        });
      }
    }
  }
  return out;
}

/** A stored tool status ("completed" | "error" | "running" | "pending") in
 *  ACP's vocabulary. A frozen step (the runtime restarted mid-call) reads as
 *  failed rather than eternally running. */
function historyToolStatus(status?: string): string {
  switch (status) {
    case "completed":
      return "completed";
    case "error":
      return "failed";
    case "running":
    case "pending":
      return "failed";
    default:
      return "completed";
  }
}

/** Path comparison good enough for "is this the folder we are in": trailing
 *  separators and separator style differ across clients, nothing else may. */
function samePath(a: string, b: string): boolean {
  const key = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  return key(a) === key(b);
}
