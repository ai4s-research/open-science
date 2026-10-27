// Configured ACP agents, and which one the app runs (#14, client direction).
//
// An ACP agent is a COMMAND the user asked us to run — not code in this repo
// (docs/rfc/multi-agent-acp.md). So this module owns exactly that: the list of
// configured commands and the one that is currently selected. Starting the
// process is `lib/acpTransport.ts` + `src-tauri/src/acp.rs`; driving it is
// `AcpRuntime` in the SDK.
//
// Stored locally rather than in OpenCode's config: it is app behaviour (which
// runtime the desktop drives), and OpenCode must not be asked to describe a
// runtime that replaces it.
import type { AcpConfigOption } from "@ai4s/sdk/acp";

/** A configured ACP agent. `id` is also the key the Rust supervisor tracks its
 *  child under, so it must stay stable across edits of the same entry. */
export interface AcpAgentConfig {
  id: string;
  /** Display label ("Codex", "Gemini CLI"). */
  name: string;
  /** Executable to run. */
  command: string;
  args: string[];
}

const AGENTS_KEY = "ai4s.acp.agents.v1";

/** Claude Code's ACP adapter. It was published as `@zed-industries/claude-code-acp`
 *  until 0.16.2; that name is deprecated and gets no updates. */
export const CLAUDE_ACP_PACKAGE = "@agentclientprotocol/claude-agent-acp";
const RETIRED_CLAUDE_ACP = /^@zed-industries\/claude-code-acp(@.*)?$/;
const ACTIVE_KEY = "ai4s.acp.active.v1";

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Keep only entries this app can actually start — a hand-edited or truncated
 *  localStorage value must not put a half-built agent in the picker. */
function sanitize(raw: unknown): AcpAgentConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: AcpAgentConfig[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { id, name, command, args } = item as Record<string, unknown>;
    if (typeof id !== "string" || !id) continue;
    if (typeof command !== "string" || !command.trim()) continue;
    if (out.some((a) => a.id === id)) continue; // one child per id in Rust
    out.push({
      id,
      name: typeof name === "string" && name.trim() ? name.trim() : command.trim(),
      command: command.trim(),
      // A saved entry still naming the retired adapter would keep running it.
      args: Array.isArray(args)
        ? args
            .filter((a): a is string => typeof a === "string")
            .map((a) => (RETIRED_CLAUDE_ACP.test(a) ? CLAUDE_ACP_PACKAGE : a))
        : [],
    });
  }
  return out;
}

export function loadAcpAgents(): AcpAgentConfig[] {
  const store = storage();
  if (!store) return [];
  try {
    return sanitize(JSON.parse(store.getItem(AGENTS_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

export function saveAcpAgents(agents: AcpAgentConfig[]): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(AGENTS_KEY, JSON.stringify(sanitize(agents)));
  } catch {
    /* storage full/unavailable never blocks the picker */
  }
}

/** The agent new conversations start on, or null for the bundled OpenCode
 *  runtime. A draft's own pick in the composer overrides it. */
export function activeAcpAgentId(): string | null {
  return storage()?.getItem(ACTIVE_KEY) || null;
}

export function setActiveAcpAgentId(id: string | null): void {
  const store = storage();
  if (!store) return;
  try {
    if (id) store.setItem(ACTIVE_KEY, id);
    else store.removeItem(ACTIVE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * The agent new conversations start on, or null for the bundled OpenCode runtime.
 *
 * A selection naming an agent that is no longer configured resolves to null, not
 * to an error: deleting the selected entry must fall back to OpenCode rather
 * than leave the app with no runtime at all.
 */
export function activeAcpAgent(): AcpAgentConfig | null {
  const id = activeAcpAgentId();
  if (!id) return null;
  return loadAcpAgents().find((a) => a.id === id) ?? null;
}

/** A stable, human-readable id no existing entry uses. Deterministic on purpose —
 *  the id keys a child process, and it appears in debug output. */
export function newAcpAgentId(existing: AcpAgentConfig[]): string {
  for (let n = 1; ; n++) {
    const id = `acp-${n}`;
    if (!existing.some((a) => a.id === id)) return id;
  }
}

/**
 * Split an argument line the way a shell would for the simple cases: whitespace
 * separates, and single or double quotes keep a run together.
 *
 * Deliberately NOT a shell: the arguments go straight to `Command::args`, never
 * through `sh`, so there is nothing here to expand, glob or substitute — which is
 * also why a path with spaces has to be quotable.
 */
export function parseCommandArgs(text: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) args.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) args.push(current);
  return args;
}

/** The inverse, for the editor field: quote any argument that contains spaces. */
export function formatCommandArgs(args: string[]): string {
  return args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
}

const OPTIONS_KEY = "ai4s.acp.options.v1";

/** The selectors each agent last reported (model, reasoning level, mode), by
 *  agent id. An agent sends them only once a session exists; remembering them
 *  lets a new conversation choose before its first message. */
export function loadAcpAgentOptions(): Record<string, AcpConfigOption[]> {
  const store = storage();
  if (!store) return {};
  try {
    const raw: unknown = JSON.parse(store.getItem(OPTIONS_KEY) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, AcpConfigOption[]> = {};
    for (const [id, list] of Object.entries(raw as Record<string, unknown>))
      if (Array.isArray(list)) out[id] = list.filter((o) => o && typeof o.id === "string");
    return out;
  } catch {
    return {};
  }
}

export function saveAcpAgentOptions(options: Record<string, AcpConfigOption[]>): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(OPTIONS_KEY, JSON.stringify(options));
  } catch {
    /* remembered for this run only */
  }
}

/** A conversation that runs on an ACP agent rather than on OpenCode. OpenCode
 *  lists its own sessions; these are the app's record of the others, so they
 *  stay in the sidebar across restarts and reopen on the agent that owns them. */
export interface AcpSessionRecord {
  agentId: string;
  title: string;
  directory?: string;
  updated?: number;
}

const SESSIONS_KEY = "ai4s.acp.sessions.v1";

export function loadAcpSessions(): Record<string, AcpSessionRecord> {
  const store = storage();
  if (!store) return {};
  try {
    const raw: unknown = JSON.parse(store.getItem(SESSIONS_KEY) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, AcpSessionRecord> = {};
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const { agentId, title, directory, updated } = value as Record<string, unknown>;
      if (typeof agentId !== "string" || !agentId) continue;
      out[id] = {
        agentId,
        title: typeof title === "string" && title ? title : "Session",
        ...(typeof directory === "string" && directory ? { directory } : {}),
        ...(typeof updated === "number" && Number.isFinite(updated) ? { updated } : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function saveAcpSessions(records: Record<string, AcpSessionRecord>): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(SESSIONS_KEY, JSON.stringify(records));
  } catch {
    /* storage full/unavailable: the record lives until the app closes */
  }
}
