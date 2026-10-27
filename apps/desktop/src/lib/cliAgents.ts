// Coding agents the machine may already have, and how to drive each one.
//
// Borrowed in shape from Orca (`src/shared/tui-agent-config.ts`, MIT): an agent
// is not an integration written per vendor, it is a COMMAND that may or may not
// be installed, described by a row in a table. Orca runs them as TUI processes
// in a terminal; this app drives the same binaries over ACP, so a conversation
// with them uses the app's own thread and composer (`lib/acpTransport.ts`).
//
// Adding an agent is a row here. Nothing else in the app needs to know it.
import { useEffect } from "react";
import { create } from "zustand";
import { isTauri } from "./tauri";
import type { TerminalAgentKind } from "./layout";
import {
  CLAUDE_ACP_PACKAGE,
  loadAcpAgents,
  saveAcpAgents,
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
  /** The vendor's own install command, shown under "Available to install" and
   *  run in a terminal on request. Windows gets its own when the vendor ships one. */
  install: { unix: string; windows?: string };
}

export const CLI_AGENTS: readonly CliAgent[] = [
  {
    id: "cli-claude-code",
    name: "Claude Code",
    detect: "claude",
    command: "npx",
    args: ["-y", CLAUDE_ACP_PACKAGE],
    install: {
      unix: "curl -fsSL https://claude.ai/install.sh | bash",
      windows: "irm https://claude.ai/install.ps1 | iex",
    },
  },
  {
    id: "cli-codex",
    name: "Codex",
    detect: "codex",
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp"],
    install: { unix: "npm install -g @openai/codex" },
  },
  {
    id: "cli-gemini",
    name: "Gemini CLI",
    detect: "gemini",
    command: "gemini",
    args: ["--acp"],
    install: { unix: "npm install -g @google/gemini-cli" },
  },
  // pi has no ACP mode of its own; pi-acp (github.com/svkozak/pi-acp) bridges
  // it and needs pi 0.81 or later. Checked 2026-10-27 against pi 0.84.2:
  // protocol 1, loadSession, model and thought_level selectors.
  {
    id: "cli-pi",
    name: "pi",
    detect: "pi",
    command: "npx",
    args: ["-y", "pi-acp"],
    install: { unix: "npm install -g @earendil-works/pi-coding-agent" },
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

/** The terminal program behind a catalog agent, when its sessions can move
 *  between a terminal and a conversation (`claude --resume`, `codex resume`,
 *  `pi --session`). */
export function terminalKindOf(agentId: string): TerminalAgentKind | null {
  // An account's conversation (`cli-claude-code~acct-1`) is still Claude Code.
  const base = agentId.split("~")[0];
  const detect = CLI_AGENTS.find((a) => a.id === base)?.detect;
  return detect === "claude" || detect === "codex" || detect === "pi" ? detect : null;
}

/** The install command for this machine's shell. */
export function installCommand(agent: CliAgent, windows: boolean): string {
  return (windows && agent.install.windows) || agent.install.unix;
}

interface DetectedAgentsStore {
  /** Null until the first probe answers. */
  detected: CliAgent[] | null;
  /** Probe PATH again: after an install, or when the user asks. */
  redetect: () => Promise<CliAgent[]>;
}

let detection: Promise<CliAgent[]> | null = null;

/** Which catalog agents are installed, shared by every menu that lists them.
 *  Probed once per run, and again only on `redetect`: every composer asking
 *  would walk PATH per pane. */
export const useDetectedAgents = create<DetectedAgentsStore>((set) => ({
  detected: null,
  redetect: async () => {
    detection = detectCliAgents().catch(() => []);
    const found = await detection;
    set({ detected: found });
    return found;
  },
}));

/** `detectCliAgents`, asked once per run unless `redetect` asks again. */
export function detectCliAgentsOnce(): Promise<CliAgent[]> {
  if (!detection) {
    detection = detectCliAgents().catch(() => []);
    void detection.then((found) => useDetectedAgents.setState({ detected: found }));
  }
  return detection;
}

/** The installed catalog agents, probing on first use. Null while the first
 *  probe runs, and off the desktop app, where there is no PATH to look at:
 *  null means "unknown", never "none". */
export function useInstalledAgents(): CliAgent[] | null {
  const detected = useDetectedAgents((s) => s.detected);
  useEffect(() => {
    if (isTauri && detected === null) void detectCliAgentsOnce();
  }, [detected]);
  return isTauri ? detected : null;
}

/** The catalog entry an ACP agent id belongs to, if any. */
export function catalogAgent(agentId: string): CliAgent | undefined {
  return CLI_AGENTS.find((a) => a.id === agentId);
}

/**
 * Make sure this agent has a configured entry, and return it.
 *
 * Its entry is created on first use rather than up front: a user who never
 * picks Gemini should not find a Gemini row in their settings. An existing
 * entry is overwritten, so a catalog fix reaches a machine that used the old
 * command once.
 */
export function ensureCliAgent(agent: CliAgent): AcpAgentConfig {
  const entry: AcpAgentConfig = {
    id: agent.id,
    name: agent.name,
    command: agent.command,
    args: agent.args,
  };
  const existing = loadAcpAgents();
  saveAcpAgents(
    existing.some((a) => a.id === entry.id)
      ? existing.map((a) => (a.id === entry.id ? entry : a))
      : [...existing, entry],
  );
  return entry;
}
