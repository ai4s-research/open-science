import { describe, expect, it } from "vitest";
import {
  BROWSER_IDLE_TIMEOUT_MS,
  BROWSER_NAMESPACE,
  buildBrowserMcpConfig,
} from "./browser";
import * as guard from "../../../../runtime/browser-plugin/browser-guard";

/** Drive the guard the way OpenCode does — through the registered hook. The
 *  helpers behind it are deliberately not exported; see the export test. */
const applyBrowserLease = async (
  tool: string,
  args: unknown,
  sessionID: string,
): Promise<void> => {
  const hook = (await guard.BrowserGuardPlugin())["tool.execute.before"];
  await hook({ tool, sessionID }, { args });
};

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
  // The guard shipped in v0.4.0 and never once loaded: OpenCode's external
  // plugin loader calls EVERY export as a plugin factory, so the exported
  // helpers ran with no arguments and threw `tool.startsWith is not a
  // function` — 51 ERROR lines in one local log across four days, each one a
  // run with no lease injection at all. It fails at ERROR and the run
  // continues, which is why nothing surfaced in the UI; what the user sees
  // instead is the proxy rejecting every browser call it guards, since the
  // lease it validates is the one this plugin was supposed to attach. Hence
  // the export-shape test, and driving the rest through the hook.
  it("exports the plugin factory and nothing else", () => {
    expect(Object.keys(guard)).toEqual(["BrowserGuardPlugin"]);
  });

  it("survives the loader calling every export with no arguments", async () => {
    for (const value of Object.values(guard)) {
      await expect((value as () => unknown)()).resolves.toBeDefined();
    }
  });

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
