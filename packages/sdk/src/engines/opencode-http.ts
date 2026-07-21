// packages/sdk/src/engines/opencode-http.ts
//
// HTTP+SSE transport for OpenCode-class runtimes. This is the code that used
// to live in OpenCodeClient, extracted so a future second HTTP-speaking
// runtime can reuse it. OpenCodeClient (the façade) will compose this.
//
// Migration is incremental (Task 2.3): methods move here one at a time, each
// committed with its test. Until migration is complete, this class throws on
// every method; once complete, OpenCodeClient forwards to it.

import type { TransportSpec } from "../runtime-def";
import { BaseAgentRuntime } from "../base-runtime";
import type {
  AgentInfo, CommandInfo, HistoryMessage, OpenCodeEvent,
  PermissionAskedEvent, PermissionReply, QuestionAskedEvent,
  RuntimeStatus, SessionMeta, SkillInfo,
} from "../types";

export type OpenCodeHttpTransport = Extract<TransportSpec, { kind: "opencode-http" }>;

export class OpenCodeHttpEngine extends BaseAgentRuntime {
  constructor(private transport: OpenCodeHttpTransport) {
    super();
  }

  // Placeholders — replaced in Task 2.3, one method per step. Each throws so
  // accidental use during migration fails loudly rather than silently no-op'ing.

  // ---- lifecycle ----
  // getStatus / onStatus / onEvent are inherited from BaseAgentRuntime and
  // already correct (they are protocol-agnostic plumbing). Only connect and
  // close are HTTP-specific and need migration.
  async connect(): Promise<void> { throw new Error("OpenCodeHttpEngine.connect: not migrated yet"); }
  close(): void { throw new Error("OpenCodeHttpEngine.close: not migrated yet"); }

  // ---- sessions ----
  async createSession(): Promise<string> { throw new Error("OpenCodeHttpEngine.createSession: not migrated yet"); }
  async listSessions(): Promise<SessionMeta[]> { throw new Error("OpenCodeHttpEngine.listSessions: not migrated yet"); }
  async deleteSession(_sessionId: string): Promise<void> { throw new Error("OpenCodeHttpEngine.deleteSession: not migrated yet"); }
  async getMessages(_sessionId: string): Promise<HistoryMessage[]> { throw new Error("OpenCodeHttpEngine.getMessages: not migrated yet"); }
  async sendPrompt(_sessionId: string, _text: string, _agent?: string, _model?: string | null): Promise<void> { throw new Error("OpenCodeHttpEngine.sendPrompt: not migrated yet"); }
  async abortSession(_sessionId: string): Promise<void> { throw new Error("OpenCodeHttpEngine.abortSession: not migrated yet"); }
  async revert(_sessionId: string, _messageID: string, _partID?: string): Promise<void> { throw new Error("OpenCodeHttpEngine.revert: not migrated yet"); }
  async unrevert(_sessionId: string): Promise<void> { throw new Error("OpenCodeHttpEngine.unrevert: not migrated yet"); }

  // ---- capability discovery ----
  async listSkills(): Promise<SkillInfo[]> { throw new Error("OpenCodeHttpEngine.listSkills: not migrated yet"); }
  async listAgents(): Promise<AgentInfo[]> { throw new Error("OpenCodeHttpEngine.listAgents: not migrated yet"); }
  async listCommands(): Promise<CommandInfo[]> { throw new Error("OpenCodeHttpEngine.listCommands: not migrated yet"); }

  // ---- model selection ----
  async getDefaultModel(): Promise<string | null> { throw new Error("OpenCodeHttpEngine.getDefaultModel: not migrated yet"); }
  async setDefaultModel(_model: string): Promise<void> { throw new Error("OpenCodeHttpEngine.setDefaultModel: not migrated yet"); }

  // ---- agent-driven execution ----
  async runShell(_sessionId: string, _command: string, _agent?: string): Promise<void> { throw new Error("OpenCodeHttpEngine.runShell: not migrated yet"); }
  async runCommand(_sessionId: string, _command: string, _args?: string): Promise<void> { throw new Error("OpenCodeHttpEngine.runCommand: not migrated yet"); }

  // ---- interactive requests ----
  async listQuestions(_sessionId?: string): Promise<QuestionAskedEvent[]> { throw new Error("OpenCodeHttpEngine.listQuestions: not migrated yet"); }
  async listPermissions(_sessionId?: string): Promise<PermissionAskedEvent[]> { throw new Error("OpenCodeHttpEngine.listPermissions: not migrated yet"); }
  async answerQuestion(_requestId: string, _answers: string[][]): Promise<void> { throw new Error("OpenCodeHttpEngine.answerQuestion: not migrated yet"); }
  async rejectQuestion(_requestId: string): Promise<void> { throw new Error("OpenCodeHttpEngine.rejectQuestion: not migrated yet"); }
  async replyPermission(_requestId: string, _reply: PermissionReply): Promise<void> { throw new Error("OpenCodeHttpEngine.replyPermission: not migrated yet"); }
}

// Type assertion: the engine structurally satisfies AgentRuntime. If the
// interface changes and this engine isn't updated, tsc fails here.
import type { AgentRuntime } from "../runtime";
const _satisfiesAgentRuntime: AgentRuntime = null as unknown as OpenCodeHttpEngine;
void _satisfiesAgentRuntime;
