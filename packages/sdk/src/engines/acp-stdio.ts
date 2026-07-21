// packages/sdk/src/engines/acp-stdio.ts
//
// ACP (Agent Client Protocol) over stdio for any agent that exposes an
// `acp` subcommand speaking newline-delimited JSON-RPC 2.0 (kimi, gemini-cli,
// future zcode, …). Verified against kimi-code 0.27.0 (`kimi acp`).
//
// Framing: each JSON-RPC message is one line on stdin and stdout. No
// Content-Length headers (kimi rejects them). Notifications carry no `id`;
// requests carry a numeric `id` and we match responses by id.
//
// Scope for this engine's first cut (RFC §3.3, §3.5):
//   - initialize handshake
//   - session/new, session/prompt, session/cancel
//   - session/update events → normalized to OpenCodeEvent
//   - text + thinking + idle + error events only; tool calls logged but not
//     normalized (TODO for a follow-up PR).
//
// Reference: open-design's apps/daemon/src/acp.ts (1,744 lines) is the
// production precedent; we implement a subset, not a port.

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { TransportSpec } from "../runtime-def";
import { BaseAgentRuntime } from "../base-runtime";
import type {
  AgentInfo,
  CommandInfo,
  HistoryMessage,
  PermissionAskedEvent,
  PermissionReply,
  QuestionAskedEvent,
  SessionMeta,
  SkillInfo,
} from "../types";
import type { AgentRuntime } from "../runtime";

export type AcpStdioTransport = Extract<TransportSpec, { kind: "acp-stdio" }>;

export class AcpStdioEngine extends BaseAgentRuntime {
  protected child: ChildProcess | null = null;
  protected nextId = 1;
  protected pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  protected sessionId: string | null = null;

  constructor(protected transport: AcpStdioTransport) {
    super();
  }

  async connect(): Promise<void> {
    this.setStatus("connecting");
    const { command, args, env, cwd } = this.transport;
    this.child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
      ...(cwd ? { cwd } : {}),
    });
    const rl = createInterface({ input: this.child.stdout! });
    rl.on("line", (line) => this.onLine(line));
    this.child.stderr?.on("data", (d) => {
      // Best-effort: surface stderr in debug logs only, not in the UI.
      console.error(`[acp:${command}] stderr: ${d.toString()}`);
    });
    this.child.on("exit", (code) => {
      if (this.getStatus() !== "offline") {
        this.setStatus("offline");
        this.emit({ type: "error", message: `ACP agent exited (code ${code})` });
      }
    });

    // Handshake.
    try {
      const result = await this.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      }) as { agentInfo?: { name?: string; version?: string } };
      void result; // could stash agentInfo for display; not required for connect.
      this.setStatus("ready");
    } catch (e) {
      this.setStatus("error");
      throw e;
    }
  }

  close(): void {
    this.setStatus("offline");
    this.child?.stdin?.end();
    this.child?.kill();
    this.child = null;
  }

  /** Send a JSON-RPC request and await the response. */
  protected request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child?.stdin?.write(msg);
    });
  }

  /** Send a notification (no id, no response). */
  protected notify(method: string, params: unknown): void {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    this.child?.stdin?.write(msg);
  }

  /** Send a response to a server-initiated request. */
  protected respond(id: number, result: unknown): void {
    const msg = JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";
    this.child?.stdin?.write(msg);
  }

  // ---- ACP session methods (the minimum subset for a working turn, RFC §3.3) ----

  async createSession(): Promise<string> {
    // kimi-code 0.27 (and the ACP schema generally) requires `cwd` on
    // session/new — it fails with `Invalid params { cwd: ... }` otherwise.
    // Default to the child process's cwd (which is `transport.cwd` if set,
    // else process.cwd()).
    const cwd = this.transport.cwd ?? process.cwd();
    const result = await this.request("session/new", {
      cwd,
      mcpServers: [],
    }) as { sessionId: string };
    this.sessionId = result.sessionId;
    return result.sessionId;
  }

  async sendPrompt(sessionId: string, text: string, _agent?: string, _model?: string | null): Promise<void> {
    // _agent and _model are ignored on ACP for now — ACP's session/prompt takes
    // a prompt and the model is set via session/set_model (TODO follow-up).
    //
    // kimi-code's session/prompt is a REQUEST whose response ({stopReason:
    // "end_turn"}) signals the turn is over. Text/reasoning chunks arrive as
    // session/update notifications WHILE the request is in flight; we await
    // the response, then emit session.idle so the store folds the turn closed.
    await this.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    this.emit({ type: "session.idle", sessionId });
  }

  async abortSession(sessionId: string): Promise<void> {
    this.notify("session/cancel", { sessionId });
  }

  // ---- AgentRuntime stubs (side-effecting ops ACP can't sensibly no-op throw) ----

  /** ACP has session/list; TODO follow-up. */
  async listSessions(): Promise<SessionMeta[]> { return []; }
  /** No standard ACP method; no-op. */
  async deleteSession(_sessionId: string): Promise<void> {}
  /** ACP has session/info; TODO follow-up. */
  async getMessages(_sessionId: string): Promise<HistoryMessage[]> { return []; }
  async revert(_sessionId: string, _messageID: string, _partID?: string): Promise<void> {
    throw new Error("ACP revert not supported");
  }
  async unrevert(_sessionId: string): Promise<void> {
    throw new Error("ACP unrevert not supported");
  }

  // ---- capability discovery (stubs) ----

  async listSkills(): Promise<SkillInfo[]> { return []; }
  async listAgents(): Promise<AgentInfo[]> { return []; }
  async listCommands(): Promise<CommandInfo[]> { return []; }

  // ---- model selection (stubs) ----

  async getDefaultModel(): Promise<string | null> { return null; }
  async setDefaultModel(_model: string): Promise<void> {
    throw new Error("ACP model switch TODO");
  }

  // ---- agent-driven execution (stubs) ----

  async runShell(_sessionId: string, _command: string, _agent?: string): Promise<void> {
    throw new Error("ACP runShell not supported");
  }
  async runCommand(_sessionId: string, _command: string, _args?: string): Promise<void> {
    throw new Error("ACP runCommand not supported");
  }

  // ---- interactive requests (stubs) ----

  async listQuestions(_sessionId?: string): Promise<QuestionAskedEvent[]> { return []; }
  async listPermissions(_sessionId?: string): Promise<PermissionAskedEvent[]> { return []; }
  async answerQuestion(_requestId: string, _answers: string[][]): Promise<void> {}
  async rejectQuestion(_requestId: string): Promise<void> {}
  async replyPermission(_requestId: string, _reply: PermissionReply): Promise<void> {}


  private onLine(line: string): void {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; } // skip non-JSON
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      // Response to a request.
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "ACP error"));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method && !("id" in msg)) {
      // Notification from the agent.
      this.handleNotification(msg.method, msg.params);
      return;
    }
    // Server-initiated request (e.g. client/request) — auto-respond empty for now.
    if (msg.method && "id" in msg) {
      this.respond(msg.id, {});
      return;
    }
  }

  /** Translate an ACP `session/update` notification into one or more
   *  normalized OpenCodeEvent values.
   *
   *  kimi-code 0.27's actual shape (verified by live probe, not from the
   *  spec's generic sketch):
   *  ```
   *  { sessionId, update: { sessionUpdate: "agent_message_chunk",
   *                         content: { type: "text" | "reasoning", text } } }
   *  ```
   *  The `sessionUpdate` enum discriminates the payload kind; `content` is the
   *  chunk. Other known `sessionUpdate` values (available_commands_update,
   *  etc.) are not normalized in this PR — TODO follow-up.
   *
   *  Turn-end is NOT a notification: `session/prompt` is a REQUEST whose
   *  response (`{ stopReason: "end_turn" }`) signals the turn is over. That's
   *  handled in `sendPrompt`, which emits `session.idle` after the response.
   *
   *  The store's `foldEvent` reducer keys text/reasoning blocks by `partId`
   *  and upserts, so the synthesized ids below must be STABLE across deltas
   *  of the same part — a counter would fragment the stream into one block
   *  per token. */
  protected handleNotification(method: string, params: unknown): void {
    if (method !== "session/update") return;
    const p = params as {
      sessionId?: string;
      update?: {
        sessionUpdate?: string;
        content?: { type?: string; text?: string };
      };
    };
    const sid = p.sessionId ?? this.sessionId ?? "";
    const update = p.update ?? {};

    if (update.sessionUpdate === "agent_message_chunk" && update.content) {
      const c = update.content;
      if (c.type === "text" && c.text !== undefined) {
        this.emit({ type: "text.updated", sessionId: sid, partId: "acp-text", text: c.text });
      } else if (c.type === "reasoning" && c.text !== undefined) {
        this.emit({ type: "reasoning.updated", sessionId: sid, partId: "acp-reasoning", text: c.text });
      }
      // TODO: other content types (tool_call, etc.) — RFC §3.5 defers these.
    }
    // Other sessionUpdate kinds (available_commands_update, etc.) — TODO.
  }
}

// Compile-time proof that AcpStdioEngine structurally satisfies AgentRuntime.
// Inherited from BaseAgentRuntime: getStatus, onEvent, onStatus. Implemented
// here: connect, close, createSession, sendPrompt, abortSession, + stubs.
const _satisfiesAgentRuntime: AgentRuntime = null as unknown as AcpStdioEngine;
void _satisfiesAgentRuntime;

