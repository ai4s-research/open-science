// The accounts Claude Code and Codex can run as (`src-tauri/agent_accounts.rs`).
//
// A conversation runs as one account, chosen when it is created and kept: the
// account is part of the conversation's agent id, `cli-claude-code~acct-3f2a`.
// Everything keyed by agent id (the running process, the options it reported,
// the session record) is then per account without a second key, and a session
// record made on an account resumes on it. No suffix is the agent's own
// default login.
import { create } from "zustand";
import { isTauri } from "./tauri";

export type AccountKind = "claude" | "codex";

export interface AgentIdentity {
  email?: string;
  orgId?: string;
  orgName?: string;
  plan?: string;
}

export interface AgentAccount extends AgentIdentity {
  id: string;
  kind: AccountKind;
  addedAtMs: number;
}

export interface AccountsView {
  /** Who the agent's own folder is signed in as; null when no one is. */
  default: AgentIdentity | null;
  accounts: AgentAccount[];
}

const SEP = "~";

/** Which catalog agents have accounts. */
const KIND_OF: Record<string, AccountKind> = {
  "cli-claude-code": "claude",
  "cli-codex": "codex",
};

export function accountKindOf(baseAgentId: string): AccountKind | null {
  return KIND_OF[baseAgentId] ?? null;
}

/** `cli-claude-code~acct-1` → base `cli-claude-code`, account `acct-1`. */
export function splitAgentId(agentId: string): { base: string; account: string | null } {
  const at = agentId.indexOf(SEP);
  return at < 0 ? { base: agentId, account: null } : { base: agentId.slice(0, at), account: agentId.slice(at + 1) };
}

export function withAccount(baseAgentId: string, account: string | null): string {
  return account ? `${baseAgentId}${SEP}${account}` : baseAgentId;
}

/** What the account is called: its email, or what the agent offers instead. */
export function accountLabel(identity: AgentIdentity | null | undefined, fallback: string): string {
  return identity?.email ?? identity?.orgName ?? fallback;
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

interface AccountsStore {
  byKind: Partial<Record<AccountKind, AccountsView>>;
  load: (kind: AccountKind) => Promise<void>;
  remove: (kind: AccountKind, id: string) => Promise<void>;
}

export const useAccountsStore = create<AccountsStore>((set, get) => ({
  byKind: {},
  load: async (kind) => {
    if (!isTauri) return;
    const view = await call<AccountsView>("agent_accounts", { kind });
    set({ byKind: { ...get().byKind, [kind]: view } });
  },
  remove: async (kind, id) => {
    await call("agent_account_remove", { kind, id });
    await get().load(kind);
  },
}));

/** One sign-in in progress: what the command printed, and how it ended. */
export interface LoginHandlers {
  onLine: (line: string) => void;
  onDone: (result: { account?: AgentAccount; error?: string }) => void;
}

/** Start `claude auth login` / `codex login` in a new account's folder. */
export async function startLogin(
  kind: AccountKind,
  handlers: LoginHandlers,
): Promise<{ loginId: string; input: (text: string) => Promise<void>; cancel: () => Promise<void> }> {
  const { listen } = await import("@tauri-apps/api/event");
  let loginId: string | null = null;
  // Events can arrive before the id comes back; hold them until it does.
  const early: Array<() => void> = [];
  const route = (id: string, run: () => void) => {
    if (loginId === null) early.push(() => id === loginId && run());
    else if (id === loginId) run();
  };
  const unlistenLine = await listen<{ loginId: string; line: string }>("agent-login:line", ({ payload }) =>
    route(payload.loginId, () => handlers.onLine(payload.line)),
  );
  const unlistenDone = await listen<{ loginId: string; account?: AgentAccount; error?: string }>(
    "agent-login:done",
    ({ payload }) =>
      route(payload.loginId, () => {
        unlistenLine();
        unlistenDone();
        handlers.onDone({ account: payload.account, error: payload.error });
      }),
  );
  try {
    loginId = await call<string>("agent_account_login", { kind });
  } catch (err) {
    unlistenLine();
    unlistenDone();
    throw err;
  }
  early.splice(0).forEach((run) => run());
  const id = loginId;
  return {
    loginId: id,
    input: (text) => call("agent_account_login_input", { loginId: id, text }),
    cancel: async () => {
      unlistenLine();
      unlistenDone();
      await call("agent_account_login_cancel", { loginId: id });
    },
  };
}

/** The first web link in a line the sign-in printed. */
export function linkIn(line: string): string | null {
  return line.match(/https:\/\/\S+/)?.[0] ?? null;
}

/** The folder an account runs in, for a terminal that resumes its session. */
export function accountHome(kind: AccountKind, id: string): Promise<string> {
  return call<string>("agent_account_home", { kind, id });
}

/** Variables that pick a login on their own; an account's terminal clears them
 *  (the Rust side does the same for a conversation, `AgentKind::auth_vars`). */
const AUTH_VARS: Record<AccountKind, string[]> = {
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "AWS_BEARER_TOKEN_BEDROCK"],
  codex: ["OPENAI_API_KEY", "CODEX_API_KEY"],
};
const HOME_VAR: Record<AccountKind, string> = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };

/**
 * A command typed into a terminal that runs `command` as the account whose
 * folder is `home`. Typed rather than set on the shell, so the user sees which
 * account it is; POSIX `env` on macOS and Linux, cmd.exe's `set` on Windows
 * (the terminal's shell there is COMSPEC). Null for a folder path the shell
 * could not take quoted.
 */
export function asAccountCommand(kind: AccountKind, home: string, command: string, windows: boolean): string | null {
  if (windows) {
    if (home.includes('"')) return null;
    const clear = AUTH_VARS[kind].map((v) => `set "${v}="`).join(" && ");
    return `${clear} && set "${HOME_VAR[kind]}=${home}" && ${command}`;
  }
  if (home.includes("'")) return null;
  const clear = AUTH_VARS[kind].map((v) => `-u ${v}`).join(" ");
  return `env ${clear} ${HOME_VAR[kind]}='${home}' ${command}`;
}
