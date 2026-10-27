// Adding an account: open or copy the link, paste the code, and see it being
// checked; a failure stays on screen with its reason.
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { CLI_AGENTS } from "@/lib/cliAgents";
import { useAccountsStore } from "@/lib/agentAccounts";
import { AgentAccounts } from "./AgentAccounts";

const invoke = vi.hoisted(() => vi.fn());
const copyText = vi.hoisted(() => vi.fn(async () => {}));
const handlers = vi.hoisted(() => new Map<string, (e: { payload: unknown }) => void>());

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  isTauri: true,
  openExternal: vi.fn(),
}));
vi.mock("@/lib/clipboard", () => ({ copyText }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, handler: (e: { payload: unknown }) => void) => {
    handlers.set(event, handler);
    return () => handlers.delete(event);
  },
}));

const LINK = "https://claude.com/cai/oauth/authorize?code=true&x=1";
const say = (line: string) => act(() => handlers.get("agent-login:line")?.({ payload: { loginId: "acct-2", line } }));
const done = (payload: object) => act(() => handlers.get("agent-login:done")?.({ payload: { loginId: "acct-2", ...payload } }));
const claude = CLI_AGENTS.find((a) => a.id === "cli-claude-code")!;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  handlers.clear();
  copyText.mockClear();
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "agent_accounts") return { default: { email: "me@lab.org", plan: "max" }, accounts: [] };
    if (cmd === "agent_account_login") return "acct-2";
    return null;
  });
  useAccountsStore.setState({ byKind: {}, defaults: {} });
});

async function startAdding() {
  const user = userEvent.setup();
  render(<AgentAccounts agent={claude} />);
  await user.click(await screen.findByRole("button", { name: "Add account" }));
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("agent_account_login", { kind: "claude" }));
  await say(`If the browser didn't open, visit: ${LINK}`);
  await say("Paste code here if prompted >");
  return user;
}

describe("adding a Claude Code account", () => {
  it("copies the sign-in link in one click", async () => {
    const user = await startAdding();

    await user.click(screen.getByRole("button", { name: "Copy link" }));

    expect(copyText).toHaveBeenCalledWith(LINK);
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("shows the code being checked, and asks again when it is refused", async () => {
    const user = await startAdding();

    await user.type(screen.getByLabelText("Code from the page"), "abc#123");
    await user.click(screen.getByRole("button", { name: "Done" }));

    expect(invoke).toHaveBeenCalledWith("agent_account_login_input", { loginId: "acct-2", text: "abc#123" });
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
    expect(screen.getByLabelText("Code from the page")).toBeDisabled();

    // Claude Code says why and prompts again.
    await say("OAuth error: Invalid code");
    await say("Paste code here if prompted >");
    expect(screen.getByText("OAuth error: Invalid code")).toBeInTheDocument();
    expect(screen.getByLabelText("Code from the page")).toBeEnabled();
  });

  it("keeps a failure on screen with its reason and a way to start again", async () => {
    const user = await startAdding();

    await done({ error: "duplicate-default", detail: "me@lab.org" });

    expect(
      screen.getByText("me@lab.org is this agent's own sign-in already. Sign in with another account."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start again" }));
    await vi.waitFor(() =>
      expect(invoke.mock.calls.filter(([cmd]) => cmd === "agent_account_login")).toHaveLength(2),
    );
  });
});
