import { describe, expect, it } from "vitest";
import {
  BROWSER_IDLE_TIMEOUT_MS,
  BROWSER_NAMESPACE,
  buildBrowserMcpConfig,
} from "./browser";
import { applyBrowserLease as lease } from "../../../../runtime/osd-plugin/browser";
import { ShellOrigins } from "../../../../runtime/osd-plugin/origin";

/** The guard the plugin's `tool.execute.before` hook runs on every call. */
const applyBrowserLease = async (tool: string, args: unknown, sessionID: string): Promise<void> =>
  lease(tool, args, sessionID);

describe("buildBrowserMcpConfig", () => {
  it("owns one namespace and reclaims an idle browser", () => {
    const config = buildBrowserMcpConfig({
      proxyBin: "/bin/open-science-desktop",
      bin: "/bin/agent-browser",
    });
    if (config.type !== "local") throw new Error("expected local MCP config");

    expect(config.environment).toMatchObject({
      AGENT_BROWSER_NAMESPACE: BROWSER_NAMESPACE,
      AGENT_BROWSER_IDLE_TIMEOUT_MS: BROWSER_IDLE_TIMEOUT_MS,
      AGENT_BROWSER_NO_WEBMCP: "1",
    });
  });

  it("rejects the upstream-incompatible profile and allowlist combination", () => {
    expect(() =>
      buildBrowserMcpConfig({
        proxyBin: "/bin/open-science-desktop",
        bin: "/bin/agent-browser",
        profileDir: "Default",
        allowedDomains: ["example.com"],
      }),
    ).toThrow("A Chrome profile cannot be combined with a domain allowlist");
  });

  it("keeps an allowlist available for an isolated browser", () => {
    const config = buildBrowserMcpConfig({
      proxyBin: "/bin/open-science-desktop",
      bin: "/bin/agent-browser",
      allowedDomains: [" example.com ", "biorxiv.org"],
    });
    if (config.type !== "local") throw new Error("expected local MCP config");

    expect(config.environment?.AGENT_BROWSER_ALLOWED_DOMAINS).toBe(
      "example.com,biorxiv.org",
    );
  });
});

describe("browser lease plugin", () => {
  it("replaces model-owned launch and session overrides with the conversation lease", async () => {
    const args: Record<string, unknown> = {
      url: "https://example.com",
      allowedDomains: ["example.com"],
      session: "titles",
      namespace: "other",
      restoreSave: "never",
      extraArgs: ["--allowed-domains", "example.com"],
      timeoutMs: 5000,
    };

    await applyBrowserLease(
      "open-science-browser_agent_browser_open",
      args,
      "ses_123abc",
    );

    expect(args).toEqual({
      url: "https://example.com",
      timeoutMs: 5000,
      session: "osd-ses_123abc",
    });
  });

  it("prevents close-all and keeps cleanup inside the current lease", async () => {
    const args: Record<string, unknown> = { all: true, session: "another-chat" };
    await applyBrowserLease("open-science-browser_agent_browser_close", args, "ses_current");
    expect(args).toEqual({ session: "osd-ses_current" });
  });

  it("creates a stable safe lease name", async () => {
    const args: Record<string, unknown> = {};
    await applyBrowserLease("open-science-browser_agent_browser_open", args, "ses/a b");
    expect(args.session).toBe("osd-ses-a-b");
  });

  it("does not alter another connector's arguments", async () => {
    const args = { session: "keep", allowedDomains: ["example.com"] };
    await applyBrowserLease("another-browser_open", args, "ses_123abc");
    expect(args).toEqual({ session: "keep", allowedDomains: ["example.com"] });
  });
});

describe("ShellOrigins (the conversation a shell command runs for)", () => {
  it("hands each shell the session whose tool call started it, once", () => {
    const origins = new ShellOrigins();
    origins.expect("osd session send x", "ses_a");
    origins.expect("ls", "ses_b");
    expect(origins.take("ls")).toBe("ses_b");
    expect(origins.take("osd session send x")).toBe("ses_a");
    expect(origins.take("ls")).toBeUndefined();
  });

  it("gives a terminal the user opened no origin, and forgets calls no shell claimed", () => {
    let now = 0;
    const origins = new ShellOrigins(1000, 2, () => now);
    expect(origins.take("vim")).toBeUndefined();
    origins.expect("denied", "ses_a");
    now = 5000;
    expect(origins.take("denied")).toBeUndefined();
    origins.expect("a", "s1");
    origins.expect("b", "s2");
    origins.expect("c", "s3");
    expect(origins.take("a")).toBeUndefined();
    expect(origins.take("c")).toBe("s3");
  });
});
