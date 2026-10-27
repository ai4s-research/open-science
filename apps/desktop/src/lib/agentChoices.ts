// The agents a conversation can run on, as the composer offers them: the
// bundled OpenCode runtime, the catalog agents installed on this machine, and
// the user's own ACP commands. A catalog agent that is not installed is not
// offered (Settings → Agents lists it under "Available to install"); a saved
// entry for it does not bring it back.
import { loadAcpAgents, type AcpAgentConfig } from "./acpAgents";
import { CLI_AGENTS, catalogAgent, ensureCliAgent, useInstalledAgents } from "./cliAgents";

/** True for an entry that starts one of the catalog agents. */
export function runsCatalogCommand(agent: AcpAgentConfig): boolean {
  const line = [agent.command, ...agent.args].join(" ");
  return CLI_AGENTS.some((c) => [c.command, ...c.args].join(" ") === line);
}

export interface AgentChoice {
  /** ACP agent id, or null for OpenCode. */
  id: string | null;
  name: string;
}

export const OPENCODE_NAME = "OpenCode";

export function useAgentChoices(current: string | null): {
  choices: AgentChoice[];
  /** Resolve a pick: an installed catalog agent gets its configured entry first. */
  pick: (id: string | null) => string | null;
} {
  const installed = useInstalledAgents() ?? [];
  // An entry made from an old one-click preset runs a catalog command under
  // another id: it is that catalog agent, not a custom one.
  const configured = loadAcpAgents();
  const custom = configured.filter((a) => !catalogAgent(a.id) && !runsCatalogCommand(a));
  const choices: AgentChoice[] = [
    { id: null, name: OPENCODE_NAME },
    ...installed.map((a) => ({ id: a.id, name: a.name })),
    ...custom.map((a) => ({ id: a.id, name: a.name })),
  ];
  // A conversation on an agent since uninstalled or removed still names it.
  if (current && !choices.some((c) => c.id === current)) {
    const name = configured.find((a) => a.id === current)?.name ?? catalogAgent(current)?.name;
    choices.push({ id: current, name: name ?? current });
  }

  const pick = (id: string | null) => {
    const cli = id ? installed.find((d) => d.id === id) : undefined;
    if (cli) ensureCliAgent(cli);
    return id;
  };
  return { choices, pick };
}
