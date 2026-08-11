// The app's configured MCP servers, in ACP's dialect (#14).
//
// ACP takes MCP servers PER SESSION (`session/new` / `session/load`), where
// OpenCode holds them in its global config: same connectors, two shapes. Without
// this translation an ACP agent runs with no connectors at all — the science
// databases the user configured are simply invisible to it, which reads as the
// feature being broken rather than unimplemented.
//
// Transport support is capability-gated by the agent, not by us: every agent
// MUST support stdio, while HTTP and SSE are optional (`mcpCapabilities`), so
// the filtering happens in `AcpRuntime` where the negotiated capabilities live.
import type { McpConfig } from "../types";

/** ACP's stdio MCP server. `command` is an executable, `args` are separate — the
 *  string is never handed to a shell. */
export interface AcpStdioMcpServer {
  name: string;
  command: string;
  args: string[];
  /** REQUIRED by the schema, empty list and all. The published zod schema has
   *  `env: z.array(...)` with no `.optional()`, so an agent that validates with
   *  the official SDK — codex-acp does — rejects `session/new` outright when it
   *  is missing. Found by driving our own agent with that library. */
  env: Array<{ name: string; value: string }>;
}
/** ACP's HTTP/SSE MCP server. Allowed only when the agent advertises the
 *  matching `mcpCapabilities` entry. */
export interface AcpRemoteMcpServer {
  type: "http" | "sse";
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
}
export type AcpMcpServer = AcpStdioMcpServer | AcpRemoteMcpServer;

/** A named key/value map as ACP's list-of-pairs. */
function pairs(record: Record<string, string> | undefined): Array<{ name: string; value: string }> {
  return Object.entries(record ?? {}).map(([name, value]) => ({ name, value }));
}

/**
 * OpenCode's MCP config → ACP's `mcpServers`.
 *
 * Disabled entries are dropped: "disabled" means the user turned that connector
 * off, and an agent that cannot see OpenCode's config would otherwise have it
 * quietly switched back on. A local entry with an empty command is dropped too —
 * there is nothing to run, and ACP requires `command`.
 *
 * SSE is not produced: OpenCode's `remote` type is a plain URL, and HTTP is what
 * the spec tells new agents to support. An agent without `mcpCapabilities.http`
 * simply does not receive those entries (see `AcpRuntime`).
 */
export function toAcpMcpServers(mcp: Record<string, McpConfig> | undefined): AcpMcpServer[] {
  const out: AcpMcpServer[] = [];
  for (const [name, config] of Object.entries(mcp ?? {})) {
    if (!config || config.enabled === false) continue;
    if (config.type === "local") {
      const [command, ...args] = config.command ?? [];
      if (!command) continue;
      // `env` is always sent, even empty — see the field's own comment.
      out.push({ name, command, args, env: pairs(config.environment) });
      continue;
    }
    if (config.type === "remote") {
      if (!config.url) continue;
      out.push({ type: "http", name, url: config.url, headers: pairs(config.headers) });
    }
  }
  return out;
}
