import { describe, expect, it } from "vitest";
import { accountKindOf, asAccountCommand, linkIn, splitAgentId, withAccount } from "./agentAccounts";

describe("an account rides in the conversation's agent id", () => {
  it("round-trips, and no suffix is the default login", () => {
    expect(withAccount("cli-claude-code", "acct-1")).toBe("cli-claude-code~acct-1");
    expect(splitAgentId("cli-claude-code~acct-1")).toEqual({ base: "cli-claude-code", account: "acct-1" });
    expect(withAccount("cli-codex", null)).toBe("cli-codex");
    expect(splitAgentId("cli-codex")).toEqual({ base: "cli-codex", account: null });
  });

  it("only Claude Code and Codex have accounts", () => {
    expect(accountKindOf("cli-claude-code")).toBe("claude");
    expect(accountKindOf("cli-codex")).toBe("codex");
    expect(accountKindOf("cli-pi")).toBeNull();
  });
});

describe("resuming an account's conversation in a terminal", () => {
  it("names the folder and clears the variables that would pick another login", () => {
    expect(asAccountCommand("claude", "/data/acct/home", "claude --resume s1", false)).toBe(
      "env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN -u AWS_BEARER_TOKEN_BEDROCK " +
        "CLAUDE_CONFIG_DIR='/data/acct/home' claude --resume s1",
    );
    expect(asAccountCommand("codex", "C:\\Data\\home", "codex resume s1", true)).toBe(
      'set "OPENAI_API_KEY=" && set "CODEX_API_KEY=" && set "CODEX_HOME=C:\\Data\\home" && codex resume s1',
    );
  });

  it("refuses a folder the shell could not take quoted", () => {
    expect(asAccountCommand("claude", "/data/it's/home", "claude", false)).toBeNull();
    expect(asAccountCommand("claude", 'C:\\a"b', "claude", true)).toBeNull();
  });
});

it("finds the sign-in link in what the command printed", () => {
  expect(linkIn("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&x=1")).toBe(
    "https://claude.com/cai/oauth/authorize?code=true&x=1",
  );
  expect(linkIn("Opening browser to sign in…")).toBeNull();
});

describe("the account a new conversation starts on", () => {
  it("is the one chosen for the agent in Settings, and forgets a removed one", async () => {
    const { useAccountsStore, withDefaultAccount } = await import("./agentAccounts");
    const { acpAgentFor } = await import("./runtime");
    useAccountsStore.getState().setDefault("cli-claude-code", "acct-1");

    expect(withDefaultAccount("cli-claude-code")).toBe("cli-claude-code~acct-1");
    expect(withDefaultAccount("cli-codex")).toBe("cli-codex");
    // A draft with no pick of its own follows the default agent, on its account.
    expect(acpAgentFor({ acpSessions: {}, draftRuntimes: {}, defaultRuntime: "cli-claude-code" }, "draft:x")).toBe(
      "cli-claude-code~acct-1",
    );
    // A pick made in the composer stands as made.
    expect(
      acpAgentFor({ acpSessions: {}, draftRuntimes: { "draft:x": "cli-claude-code" }, defaultRuntime: null }, "draft:x"),
    ).toBe("cli-claude-code");

    useAccountsStore.getState().setDefault("cli-claude-code", null);
    expect(withDefaultAccount("cli-claude-code")).toBe("cli-claude-code");
  });

  it("follows a later account switch when the draft has no explicit pick", async () => {
    const { useAccountsStore } = await import("./agentAccounts");
    const { acpAgentFor } = await import("./runtime");
    // No draftRuntimes entry → falls through to the live default + account.
    useAccountsStore.getState().setDefault("cli-claude-code", "acct-1");
    expect(acpAgentFor({ acpSessions: {}, draftRuntimes: {}, defaultRuntime: "cli-claude-code" }, "draft:y")).toBe(
      "cli-claude-code~acct-1",
    );
    // User switches to acct-2: the same draft now resolves to acct-2.
    useAccountsStore.getState().setDefault("cli-claude-code", "acct-2");
    expect(acpAgentFor({ acpSessions: {}, draftRuntimes: {}, defaultRuntime: "cli-claude-code" }, "draft:y")).toBe(
      "cli-claude-code~acct-2",
    );
    useAccountsStore.getState().setDefault("cli-claude-code", null);
  });
});

describe("terminal resume with an account", () => {
  it("wraps the resume command with the account's env vars", async () => {
    const { resumeCommand } = await import("./layout");
    expect(resumeCommand({ kind: "claude", sessionId: "s1", running: true, accountHome: "/data/acct/home" })).toBe(
      "env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN -u AWS_BEARER_TOKEN_BEDROCK " +
        "CLAUDE_CONFIG_DIR='/data/acct/home' claude --resume s1",
    );
    expect(resumeCommand({ kind: "codex", sessionId: "s2", running: true, accountHome: "/data/codex/home" })).toBe(
      "env -u OPENAI_API_KEY -u CODEX_API_KEY CODEX_HOME='/data/codex/home' codex resume s2",
    );
  });

  it("omits the wrapper when there is no account", async () => {
    const { resumeCommand } = await import("./layout");
    expect(resumeCommand({ kind: "claude", sessionId: "s1", running: true })).toBe("claude --resume s1");
    expect(resumeCommand({ kind: "pi", sessionId: "s3", running: true })).toBe("pi --session s3");
  });
});
