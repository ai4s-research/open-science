import { describe, expect, it } from "vitest";
import {
  BROWSER_IDLE_TIMEOUT_MS,
  BROWSER_NAMESPACE,
  buildBrowserMcpConfig,
} from "./browser";
import {
  applyBrowserLease,
  browserLeaseSession,
} from "../../../../runtime/browser-plugin/browser-guard";

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
  it("replaces model-owned launch and session overrides with the conversation lease", () => {
    const args: Record<string, unknown> = {
      url: "https://example.com",
      allowedDomains: ["example.com"],
      session: "titles",
      namespace: "other",
      restoreSave: "never",
      extraArgs: ["--allowed-domains", "example.com"],
      timeoutMs: 5000,
    };

    applyBrowserLease(
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

  it("prevents close-all and keeps cleanup inside the current lease", () => {
    const args: Record<string, unknown> = { all: true, session: "another-chat" };
    applyBrowserLease("open-science-browser_agent_browser_close", args, "ses_current");
    expect(args).toEqual({ session: "osd-ses_current" });
  });

  it("creates a stable safe lease name", () => {
    expect(browserLeaseSession("ses/a b")).toBe("osd-ses-a-b");
  });

  it("does not alter another connector's arguments", () => {
    const args = { session: "keep", allowedDomains: ["example.com"] };
    applyBrowserLease("another-browser_open", args, "ses_123abc");
    expect(args).toEqual({ session: "keep", allowedDomains: ["example.com"] });
  });
});
