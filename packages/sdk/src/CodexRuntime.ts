// CodexRuntime: an AgentRuntime backed by the Codex App Server (codex app-server).
//
// PROTOTYPE — see docs/rfc/multi-agent-acp.md. This validates that the
// AgentRuntime interface (packages/sdk/src/runtime.ts) can drive a second,
// non-OpenCode runtime. The transport (StdioJsonRpcClient) is the shared layer
// a future AcpRuntime will also use.
//
// The codex app-server protocol (JSON-RPC 2.0 over stdio) is reconstructed from
// public docs/descriptions, NOT verified against a live `codex app-server` on
// every commit. Method names and event field shapes are our best-effort mapping
// and MUST be confirmed against a real codex before this leaves prototype stage.
// Where the mapping is uncertain, the code says so inline.
//
// Node-only: StdioJsonRpcClient spawns a child process.
import { StdioJsonRpcClient } from "./stdio-jsonrpc";
import { BaseAgentRuntime } from "./base-runtime";
import type {
  AgentInfo,
  CommandInfo,
  HistoryMessage,
  PermissionAskedEvent,
  PermissionReply,
  QuestionAskedEvent,
  SessionMeta,
  SkillInfo,
} from "./types";

/** Options to locate and start the codex app-server. */
export interface CodexRuntimeOptions {
  /**
   * Command to spawn. Defaults to ["codex", "app-server"]. Override for a
   * custom path or to wrap it (e.g. through npx).
   */
  command?: string[];
  /** Extra env for the child (e.g. OPENAI_API_KEY). */
  env?: Record<string, string>;
  /** Working directory — should be the workspace the agent operates in. */
  cwd?: string;
}

/**
 * The pending approval a codex turn is blocked on, if any. The codex app-server
 * pauses the turn and asks the client to approve a command before executing it.
 */
interface PendingApproval {
  /** The id codex assigned to the approval request. */
  id: string;
  /** The shell command (or action) awaiting approval. */
  command: string;
}

/**
 * AgentRuntime implementation over the Codex App Server. Spawns
 * `codex app-server` as a child process, drives it over JSON-RPC, and translates
 * its events into the app's normalized `OpenCodeEvent` stream so the rest of the
 * app (store, provenance, runs, UI) is unchanged.
 *
 * Also serves as the **reference implementation** for a third-party agent
 * runtime — see docs/AGENT_INTEGRATION.md. The listener/status plumbing is
 * inherited from BaseAgentRuntime; this class fills in only codex-specific
 * protocol translation.
 */
export class CodexRuntime extends BaseAgentRuntime {
  private rpc: StdioJsonRpcClient | null = null;
  /** threadId (codex) → accumulated text, so streamed deltas assemble like OpenCode. */
  private readonly textStreams = new Map<string, string>();
  /** threadId → the approval currently blocking it (one at a time per thread). */
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly unsubs: Array<() => void> = [];
  private readonly options: CodexRuntimeOptions;

  constructor(options: CodexRuntimeOptions = {}) {
    super();
    this.options = options;
  }

  /** Spawn codex app-server and run the JSON-RPC `initialize` handshake. */
  async connect(): Promise<void> {
    this.setStatus("connecting");
    const rpc = new StdioJsonRpcClient({
      command: this.options.command ?? ["codex", "app-server"],
      env: this.options.env,
      cwd: this.options.cwd,
    });
    // Surface codex stderr as a debug aid.
    (rpc as unknown as { onStderr: (s: string) => void }).onStderr = (s: string) =>
      void this.onStderr(s);
    this.rpc = rpc;
    this.registerHandlers(rpc);
    try {
      await rpc.start();
      // Handshake: negotiate protocol. The exact field names are our best-effort
      // reconstruction from public docs; confirm against a live codex.
      await rpc.request("initialize", {
        protocolVersion: "2025-03-26",
        clientInfo: { name: "open-science-desktop", version: "0.2.0" },
      });
      this.setStatus("ready");
    } catch (err) {
      this.setStatus("error");
      throw err;
    }
  }

  close(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs.length = 0;
    void this.rpc?.close();
    this.rpc = null;
    this.textStreams.clear();
    this.pendingApprovals.clear();
    this.setStatus("offline");
  }

  // ---- sessions ----
  // Codex app-server models a conversation as a "thread". createSession maps to
  // starting a thread; the returned id is the codex thread id we use throughout.

  async createSession(): Promise<string> {
    this.requireReady();
    const res = (await this.rpc!.request("thread/start", {
      cwd: this.options.cwd,
    })) as { id?: string } | string;
    // Tolerate either a {id} object or a bare id string from the server.
    const id = typeof res === "string" ? res : res?.id;
    if (!id) throw new Error("codex thread/start returned no id");
    return id;
  }

  async listSessions(): Promise<SessionMeta[]> {
    // PROTOTYPE: codex app-server does not expose a thread-list RPC in the public
    // surface we found. The app's history index (SQLite) is the source of truth
    // for past sessions, so returning [] here is honest rather than guessing a
    // method that may not exist. TODO: confirm against live codex.
    return [];
  }

  async deleteSession(_sessionId: string): Promise<void> {
    // PROTOTYPE: no known thread-delete RPC. No-op for now; the app keeps its own
    // history index. TODO: confirm against live codex.
  }

  async getMessages(sessionId: string): Promise<HistoryMessage[]> {
    this.requireReady();
    // PROTOTYPE: we replay what we accumulated during the live stream. A history
    // load across restarts needs the codex thread-load RPC, whose shape we have
    // not confirmed. TODO: verify and replace.
    const text = this.textStreams.get(sessionId);
    if (!text) return [];
    return [
      {
        role: "assistant",
        parts: [{ type: "text", text }],
      },
    ];
  }

  /**
   * Send a prompt into a codex thread. codex streams the turn back as
   * notifications; this call awaits the terminal response (turn done).
   * `agent?`/`model?` from AgentRuntime are accepted but not yet forwarded —
   * codex thread config is set at thread/start; pinning per-turn needs the
   * exact field names confirmed against live codex.
   */
  async sendPrompt(
    sessionId: string,
    text: string,
    _agent?: string,
    _model?: string | null,
  ): Promise<void> {
    this.requireReady();
    // sendPrompt is a request whose RESULT means "turn complete"; the streaming
    // text/tools arrive as notifications meanwhile. `fullOutput` asks codex to
    // emit the complete final message in the response as a convenience.
    await this.rpc!.request("thread/send", {
      thread_id: sessionId,
      prompt: text,
      fullOutput: true,
    });
  }

  async abortSession(sessionId: string): Promise<void> {
    this.requireReady();
    await this.rpc!.request("thread/cancel", { thread_id: sessionId }).catch(
      () => undefined,
    );
  }

  // ---- capability discovery ----
  // These are OpenCode-shaped; codex has no skills/commands concept, so honest
  // empties. `listAgents` could surface codex's built-in agent modes if/when the
  // app-server exposes them.

  async listSkills(): Promise<SkillInfo[]> {
    return [];
  }
  async listAgents(): Promise<AgentInfo[]> {
    return [];
  }
  async listCommands(): Promise<CommandInfo[]> {
    return [];
  }

  // ---- model selection ----
  // PROTOTYPE: codex picks its model from its own config / the thread's settings.
  // The app's model picker is OpenCode-specific today; wiring it to codex needs
  // the codex model-selection RPC, which we have not confirmed. These stubs keep
  // the interface satisfied; TODO once the field names are verified.

  async getDefaultModel(): Promise<string | null> {
    return null;
  }
  async setDefaultModel(_model: string): Promise<void> {
    // No-op in prototype: codex manages its own model selection.
  }

  // ---- agent-driven execution ----
  // `runShell`/`runCommand` are OpenCode-native ("!" shell mode, slash commands).
  // They have no codex equivalent. Throwing here would surface misleadingly in
  // the UI; returning without action is safer for the prototype. TODO: decide
  // whether to map these or disable the surface when codex is active.

  async runShell(_sessionId: string, _command: string, _agent?: string): Promise<void> {
    // No codex equivalent in the prototype.
  }
  async runCommand(
    _sessionId: string,
    _command: string,
    _args?: string,
  ): Promise<void> {
    // No codex equivalent in the prototype.
  }

  // ---- interactive requests ----

  async listQuestions(_sessionId?: string): Promise<QuestionAskedEvent[]> {
    return [];
  }

  async listPermissions(_sessionId?: string): Promise<PermissionAskedEvent[]> {
    // Surface any approvals that arrived before the listener connected.
    const out: PermissionAskedEvent[] = [];
    for (const [sid, a] of this.pendingApprovals) {
      out.push({
        type: "permission.asked",
        sessionId: sid,
        requestId: a.id,
        action: "bash",
        resources: [a.command],
      });
    }
    return out;
  }

  async answerQuestion(_requestId: string, _answers: string[][]): Promise<void> {
    // codex uses command-approval, not multi-option questions. No-op.
  }
  async rejectQuestion(_requestId: string): Promise<void> {
    // codex uses command-approval, not multi-option questions. No-op.
  }

  /** Approve (or reject) a pending command approval. `always` persists a rule in
   *  OpenCode; codex has no such notion, so it's treated as `once`. */
  async replyPermission(requestId: string, reply: PermissionReply): Promise<void> {
    this.requireReady();
    const approved = reply !== "reject";
    // pendingApprovals is keyed by thread id, so find the entry whose approval
    // id matches requestId, then delete by THAT key (not requestId).
    for (const [sid, a] of [...this.pendingApprovals]) {
      if (a.id === requestId) this.pendingApprovals.delete(sid);
    }
    // codex expects a decision on the approval id. Field name best-effort.
    await this.rpc!
      .request("approveCommand", { id: requestId, approved })
      .catch(() => undefined);
  }

  // ---- internals ----

  private requireReady(): void {
    if (this.getStatus() !== "ready" || !this.rpc)
      throw new Error("Codex runtime is not connected");
  }

  private registerHandlers(rpc: StdioJsonRpcClient): void {
    // Streamed text: codex emits per-chunk notifications during a turn. We
    // accumulate into textStreams and re-emit the full accumulated text, matching
    // how OpenCodeClient feeds text.updated (full value, not delta).
    this.unsubs.push(
      rpc.onNotification("thread/message", (params) => {
        const p = params as {
          thread_id?: string;
          delta?: string;
          text?: string;
          role?: string;
        } | undefined;
        const sid = p?.thread_id;
        if (!sid || !p) return;
        const chunk = p.delta ?? p.text ?? "";
        if (!chunk) return;
        const acc = (this.textStreams.get(sid) ?? "") + chunk;
        this.textStreams.set(sid, acc);
        this.emit({ type: "text.updated", sessionId: sid, partId: "text", text: acc });
      }),
    );

    // Tool/command activity. codex reports a command executing and its result;
    // we map both onto tool.updated with running→success. Field names best-effort.
    this.unsubs.push(
      rpc.onNotification("thread/command", (params) => {
        const p = params as {
          thread_id?: string;
          id?: string;
          command?: string;
          state?: string;
          output?: string;
        } | undefined;
        const sid = p?.thread_id;
        if (!sid || !p?.id) return;
        this.emit({
          type: "tool.updated",
          sessionId: sid,
          callId: String(p.id),
          tool: "bash",
          status: p.state === "done" ? "success" : "running",
          title: p.command ?? "command",
          ...(typeof p.output === "string" ? { output: p.output } : {}),
        });
      }),
    );

    // Command approval request: codex pauses the turn and asks the client.
    this.unsubs.push(
      rpc.onNotification("thread/commandApprovalRequest", (params) => {
        const p = params as {
          thread_id?: string;
          id?: string;
          command?: string;
        } | undefined;
        const sid = p?.thread_id;
        if (!sid || !p?.id) return;
        const approval: PendingApproval = {
          id: String(p.id),
          command: p.command ?? "",
        };
        this.pendingApprovals.set(sid, approval);
        this.emit({
          type: "permission.asked",
          sessionId: sid,
          requestId: approval.id,
          action: "bash",
          resources: [approval.command],
        });
      }),
    );

    // Turn complete: codex ends the turn. We surface session.idle so the store
    // unlocks the composer exactly like an OpenCode turn.
    this.unsubs.push(
      rpc.onNotification("thread/completed", (params) => {
        const p = params as { thread_id?: string } | undefined;
        const sid = p?.thread_id;
        if (!sid) return;
        this.emit({ type: "session.idle", sessionId: sid });
      }),
    );
  }

  /** Override hook for stderr logging. */
  protected onStderr(_chunk: string): void {}
}
