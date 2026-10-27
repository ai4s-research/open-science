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
