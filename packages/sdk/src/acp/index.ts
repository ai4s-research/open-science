// The ACP layer's browser-safe barrel (#14, #25) — both directions.
//
// `./stdio` (the client's spawning transport) and `./serve-stdio` (the agent
// process an editor spawns) are deliberately NOT re-exported here: they own
// `child_process` and `process.stdin`, which the webview does not have. Node
// callers import `@ai4s/sdk/acp/stdio` and `@ai4s/sdk/acp/serve-stdio`.
export { AcpRuntime, mapToolStatus, pickPermissionOption } from "./AcpRuntime";
export { toAcpMcpServers } from "./mcp";
export { AcpAgentServer, acpToolStatus, historyNotifications } from "./server";
export type { AcpAgentServerOptions } from "./server";
export type { AcpMcpServer, AcpRemoteMcpServer, AcpStdioMcpServer } from "./mcp";
export type { AcpRuntimeOptions } from "./AcpRuntime";
export {
  ACP_PROTOCOL_VERSION,
  JsonRpcError,
  JsonRpcPeer,
} from "./protocol";
export type {
  AcpAgentCapabilities,
  AcpAgentInfo,
  AcpAuthMethod,
  AcpCommand,
  AcpConfigOption,
  AcpConfigOptionValue,
  AcpConfigOptionsResult,
  AcpInitializeResult,
  AcpModelInfo,
  AcpNewSessionResult,
  AcpPermissionRequest,
  AcpPromptResult,
  AcpSessionCapabilities,
  AcpSessionInfo,
  AcpSessionListResult,
  AcpSessionNotification,
  AcpSessionUpdate,
  AcpToolCallUpdate,
  JsonRpcTransport,
  PeerHandlers,
} from "./protocol";
export type { OpenCodeEvent, PermissionReply, RuntimeStatus } from "../types";
