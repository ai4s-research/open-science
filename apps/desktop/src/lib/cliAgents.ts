// Coding agents the machine may already have, and how to drive each one.
//
// Borrowed in shape from Orca (`src/shared/tui-agent-config.ts`, MIT): an agent
// is not an integration written per vendor, it is a COMMAND that may or may not
// be installed, described by a row in a table. Orca runs them as TUI processes
// in a terminal; this app has no terminal, so it drives the same binaries over
// ACP — the protocol OSD already speaks (`lib/acpTransport.ts`).
//
// Adding an agent is a row here. Nothing else in the app needs to know it.
import { isTauri } from "./tauri";
import {
  loadAcpAgents,
  saveAcpAgents,
  setActiveAcpAgentId,
  type AcpAgentConfig,
} from "./acpAgents";

export interface CliAgent {
  /** Stable id: also the key the Rust supervisor tracks its child under, so it
   *  must not change once an entry has been used. */
  id: string;
  /** Product name, shown as-is — never translated, like a model id. */
  name: string;
  /** The binary whose presence on PATH means "this machine has it". */
  detect: string;
  /** How to start it speaking ACP. */
  command: string;
  args: string[];
}

export const CLI_AGENTS: readonly CliAgent[] = [
  {
    id: "cli-claude-code",
    name: "Claude Code",
    detect: "claude",
    command: "npx",
    args: ["-y", "@zed-industries/claude-code-acp"],
  },
  {
    id: "cli-codex",
    name: "Codex",
    detect: "codex",
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp"],
  },
  {
    id: "cli-gemini",
    name: "Gemini CLI",
    detect: "gemini",
    command: "gemini",
    args: ["--acp"],
  },
];

/** Which of the catalog this machine can actually run, in catalog order.
 *
 *  Empty off the desktop app: the web client has no PATH to look at, and an
 *  agent it cannot start should not be offered. */
export async function detectCliAgents(): Promise<CliAgent[]> {
  if (!isTauri) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  const found = await invoke<string[]>("detect_commands", {
    commands: CLI_AGENTS.map((agent) => agent.detect),
  });
  return CLI_AGENTS.filter((agent) => found.includes(agent.detect));
}

/**
 * Make this agent the one the app runs, and return the config list to persist.
 *
 * Its entry is created on first use rather than up front: a user who never
 * picks Gemini should not find a Gemini row in their settings. An existing
 * entry is overwritten, so a catalog fix reaches a machine that used the old
 * command once.
 */
export function selectCliAgent(agent: CliAgent): AcpAgentConfig[] {
  const entry: AcpAgentConfig = {
    id: agent.id,
    name: agent.name,
    command: agent.command,
    args: agent.args,
  };
  const existing = loadAcpAgents();
  const next = existing.some((a) => a.id === entry.id)
    ? existing.map((a) => (a.id === entry.id ? entry : a))
    : [...existing, entry];
  saveAcpAgents(next);
  setActiveAcpAgentId(entry.id);
  return next;
}
