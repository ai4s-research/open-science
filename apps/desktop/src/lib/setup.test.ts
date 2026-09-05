// The setup store owns the long-running uv provisioning flows so they survive
// page navigation. These guard the two properties that broke before: a second
// concurrent start must not race the first into the same env dir, and the
// busy/generation lifecycle must be observable regardless of which page reads.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addMcpServer: vi.fn(async () => {}),
  loadCatalog: vi.fn(async () => {}),
  connectRetry: vi.fn(async () => true),
  /** Resolves ⇒ an entry existed and was removed; rejects ⇒ nothing to remove. */
  removeConfigEntry: vi.fn(async () => {}),
  agentBrowserBin: vi.fn(async () => "/bin/agent-browser"),
  browserMcpBin: vi.fn(async () => "/bin/open-science-desktop"),
  closeAgentBrowser: vi.fn(async () => {}),
  detectChrome: vi.fn(async () => ({ path: "/Chrome", kind: "chrome" })),
  getProxySetting: vi.fn(async () => ({ effective: null })),
  /** Resolver for the in-flight setupJupyter promise, so tests hold it open. */
  resolveSetup: (() => {}) as () => void,
  setupJupyter: vi.fn(),
  setupScienceMcp: vi.fn(async () => "/env/bin/python"),
  startMcpOAuth: vi.fn(async () => ({
    authorizationUrl: "https://elicit.com/oauth/authorize?state=x",
    oauthState: "x",
  })),
  listMcpServers: vi.fn(async (): Promise<Array<{ name: string; status: string }>> => [
    { name: "elicit", status: "connected" },
  ]),
  openExternal: vi.fn(async () => {}),
}));

mocks.setupJupyter.mockImplementation(
  () => new Promise<void>((r) => (mocks.resolveSetup = () => r())),
);

vi.mock("./runtime", () => ({
  getClient: () => ({
    addMcpServer: mocks.addMcpServer,
    startMcpOAuth: mocks.startMcpOAuth,
    listMcpServers: mocks.listMcpServers,
  }),
  useRuntimeStore: {
    getState: () => ({ loadCatalog: mocks.loadCatalog, connectRetry: mocks.connectRetry }),
  },
}));
vi.mock("./tauri", () => ({
  setupJupyter: mocks.setupJupyter,
  startJupyter: async () => ({
    url: "http://127.0.0.1:9",
    token: "tok",
    mcp_command: "/env/bin/jupyter-mcp-server",
  }),
  setupScienceMcp: mocks.setupScienceMcp,
  watchSetupProgress: async () => () => {},
  removeConfigEntry: mocks.removeConfigEntry,
  agentBrowserBin: mocks.agentBrowserBin,
  browserMcpBin: mocks.browserMcpBin,
  closeAgentBrowser: mocks.closeAgentBrowser,
  detectChrome: mocks.detectChrome,
  getProxySetting: mocks.getProxySetting,
  openExternal: mocks.openExternal,
}));
vi.mock("./scienceConnectors", () => ({
  SCIENCE_CONNECTORS: [
    { id: "papers", label: "Papers", pkg: "paper-search-mcp" },
    {
      id: "elicit",
      label: "Elicit",
      type: "remote",
      url: "https://elicit.com/api/mcp",
      auth: "oauth",
    },
  ],
  connectorConfig: (c: { type?: string; url?: string }) =>
    c.type === "remote"
      ? { type: "remote", url: c.url, enabled: true }
      : { type: "local", command: ["/env/bin/python"], enabled: true },
}));
vi.mock("./toast", () => ({ toast: { success: () => {}, error: () => {} } }));

import { useSetupStore } from "./setup";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setupJupyter.mockImplementation(
    () => new Promise<void>((r) => (mocks.resolveSetup = () => r())),
  );
  // A couple of tests below override this to "pending" to exercise the OAuth
  // wait loop — restore the happy-path default so it never leaks between tests.
  mocks.listMcpServers.mockResolvedValue([{ name: "elicit", status: "connected" }]);
  useSetupStore.setState({ jupyterBusy: false, connectorId: null, line: null, generation: 0 });
});

describe("setup store", () => {
  it("marks busy while provisioning Jupyter and clears + bumps generation after", async () => {
    const gen0 = useSetupStore.getState().generation;
    const run = useSetupStore.getState().enableJupyter();
    expect(useSetupStore.getState().jupyterBusy).toBe(true); // set synchronously

    mocks.resolveSetup();
    await run;

    const s = useSetupStore.getState();
    expect(s.jupyterBusy).toBe(false);
    expect(s.line).toBeNull();
    expect(s.generation).toBe(gen0 + 1);
    expect(mocks.addMcpServer).toHaveBeenCalledWith("jupyter", expect.anything());
  });

  it("ignores a second concurrent enableJupyter — no colliding provisioning run", async () => {
    const p1 = useSetupStore.getState().enableJupyter();
    const p2 = useSetupStore.getState().enableJupyter(); // guarded: returns at once
    await p2; // the guarded call resolves without waiting on the first
    expect(mocks.setupJupyter).toHaveBeenCalledTimes(1);

    mocks.resolveSetup();
    await p1;
    expect(mocks.setupJupyter).toHaveBeenCalledTimes(1);
  });

  it("tracks the connector being provisioned and clears it when done", async () => {
    const run = useSetupStore.getState().enableConnector("papers", "key123");
    expect(useSetupStore.getState().connectorId).toBe("papers");
    await run;
    expect(useSetupStore.getState().connectorId).toBeNull();
    expect(mocks.addMcpServer).toHaveBeenCalledWith("papers", expect.anything());
  });

  // A remote (OAuth) connector skips uv/pip entirely: register the URL, start
  // the flow, open the browser, then poll listMcpServers instead of holding
  // one request open for the length of the login (see startMcpOAuth's own
  // doc comment for why — a webview's fetch has a shorter idle timeout).
  it("registers a remote connector, opens the browser, and waits for connected status", async () => {
    const run = useSetupStore.getState().enableConnector("elicit");
    expect(useSetupStore.getState().connectorId).toBe("elicit");
    await run;

    expect(mocks.addMcpServer).toHaveBeenCalledWith("elicit", {
      type: "remote",
      url: "https://elicit.com/api/mcp",
      enabled: true,
    });
    expect(mocks.startMcpOAuth).toHaveBeenCalledWith("elicit");
    expect(mocks.openExternal).toHaveBeenCalledWith(
      "https://elicit.com/oauth/authorize?state=x",
    );
    expect(mocks.setupScienceMcp).not.toHaveBeenCalled(); // nothing to pip-install
    const s = useSetupStore.getState();
    expect(s.connectorId).toBeNull();
    expect(s.line).toBeNull();
  });

  it("times out and clears busy state when the browser sign-in never completes", async () => {
    mocks.listMcpServers.mockResolvedValue([{ name: "elicit", status: "pending" }]);
    vi.useFakeTimers();
    try {
      const run = useSetupStore.getState().enableConnector("elicit");
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000); // past MCP_OAUTH_WAIT_MS
      await run;
    } finally {
      vi.useRealTimers();
    }
    expect(useSetupStore.getState().connectorId).toBeNull();
  });

  // The config PATCH deep-merges the nested `environment`, so a re-add can only
  // add/overwrite keys, never drop one. Turning "Show the browser window" off
  // just omits AGENT_BROWSER_HEADED — the merge would keep the stale "true".
  // Removing the entry first (then re-adding) rewrites the environment clean.
  it("rewrites the browser entry from scratch on reconfigure — removes before re-adding", async () => {
    await useSetupStore.getState().enableBrowser({ headed: false, useSystemChrome: true });

    expect(mocks.removeConfigEntry).toHaveBeenCalledWith("mcp", "open-science-browser");
    expect(mocks.closeAgentBrowser).toHaveBeenCalledOnce();
    // An existing entry was removed, so we wait for the restarted sidecar.
    expect(mocks.connectRetry).toHaveBeenCalled();
    // Remove must precede the re-add, or the add merges into the stale entry.
    expect(mocks.removeConfigEntry.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.addMcpServer.mock.invocationCallOrder[0],
    );
    // The freshly written config carries no headed flag → it starts headless.
    const calls = mocks.addMcpServer.mock.calls as unknown as Array<
      [string, { environment?: Record<string, string> }]
    >;
    const [, config] = calls[calls.length - 1];
    expect(config.environment?.AGENT_BROWSER_HEADED).toBeUndefined();
  });

  it("first enable has no entry to remove — skips the sidecar wait, still adds", async () => {
    mocks.removeConfigEntry.mockRejectedValueOnce(new Error("not in the config's mcp section"));

    await useSetupStore.getState().enableBrowser({ headed: true, useSystemChrome: true });

    expect(mocks.connectRetry).not.toHaveBeenCalled();
    expect(mocks.addMcpServer).toHaveBeenCalledWith("open-science-browser", expect.anything());
  });
});
