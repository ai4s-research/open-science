// packages/sdk/src/defs/kimi.ts
import type { RuntimeDef } from "../runtime-def";
import { AcpStdioEngine, type AcpStdioTransport } from "../engines/acp-stdio";
import type { AgentRuntime } from "../runtime";
import type { OpenCodeEvent, PermissionReply, RuntimeStatus } from "../types";

/** kimi-code's runtime definition. kimi exposes a standard ACP server via
 *  `kimi acp` (verified against kimi-code 0.27.0). Sessions resume via ACP's
 *  session/load (resumesSessionVia: 'acp-load'). */
export function kimiDef(): RuntimeDef {
  return {
    id: "kimi",
    transport: { kind: "acp-stdio", command: "kimi", args: ["acp"] },
    resumesSessionVia: "acp-load",
  };
}

/** Thin façade that exposes a kimi ACP runtime as AgentRuntime. Mirrors the
 *  OpenCodeClient façade pattern (RFC §5.1). Today this is nearly a 1:1
 *  forwarder; the seam exists so kimi-specific behavior (auth flow, model
 *  listing via ACP) can land later without touching consumers. */
export class KimiRuntime implements AgentRuntime {
  private engine: AcpStdioEngine;

  constructor() {
    const transport = kimiDef().transport;
    if (transport.kind !== "acp-stdio") {
      throw new Error(`kimi runtime requires acp-stdio transport, got ${transport.kind}`);
    }
    this.engine = new AcpStdioEngine(transport as AcpStdioTransport);
  }

  // Lifecycle — forward.
  connect() { return this.engine.connect(); }
  close(): void { return this.engine.close(); }
  getStatus(): RuntimeStatus { return this.engine.getStatus(); }
  onEvent(l: (e: OpenCodeEvent) => void) { return this.engine.onEvent(l); }
  onStatus(l: (s: RuntimeStatus) => void) { return this.engine.onStatus(l); }

  // Sessions + turns — forward to engine.
  createSession() { return this.engine.createSession(); }
  listSessions() { return this.engine.listSessions(); }
  deleteSession(sid: string) { return this.engine.deleteSession(sid); }
  getMessages(sid: string) { return this.engine.getMessages(sid); }
  sendPrompt(sid: string, text: string, agent?: string, model?: string | null) {
    return this.engine.sendPrompt(sid, text, agent, model);
  }
  abortSession(sid: string) { return this.engine.abortSession(sid); }
  revert(sid: string, m: string, p?: string) { return this.engine.revert(sid, m, p); }
  unrevert(sid: string) { return this.engine.unrevert(sid); }

  // Capability discovery.
  listSkills() { return this.engine.listSkills(); }
  listAgents() { return this.engine.listAgents(); }
  listCommands() { return this.engine.listCommands(); }

  // Model selection.
  getDefaultModel() { return this.engine.getDefaultModel(); }
  setDefaultModel(m: string) { return this.engine.setDefaultModel(m); }

  // Agent-driven execution.
  runShell(sid: string, cmd: string, agent?: string) { return this.engine.runShell(sid, cmd, agent); }
  runCommand(sid: string, cmd: string, args?: string) { return this.engine.runCommand(sid, cmd, args); }

  // Interactive requests.
  listQuestions(sid?: string) { return this.engine.listQuestions(sid); }
  listPermissions(sid?: string) { return this.engine.listPermissions(sid); }
  answerQuestion(r: string, a: string[][]) { return this.engine.answerQuestion(r, a); }
  rejectQuestion(r: string) { return this.engine.rejectQuestion(r); }
  replyPermission(r: string, p: PermissionReply) { return this.engine.replyPermission(r, p); }
}
