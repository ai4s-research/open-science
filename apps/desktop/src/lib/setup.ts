// App-lifetime owner of the long-running uv provisioning flows (isolated
// Jupyter env, science-MCP connectors). This state lived inside SettingsPage
// before, so navigating away — clicking a chat or a history session —
// unmounted the page, discarded the "setting up…" flags, and (worse) severed
// the setup-progress listener, making a still-running download look frozen and
// inviting a second click that collided on the same env dir. Owning it here
// means the download is unaffected by which page is open.
import { create } from "zustand";
import { getClient, useRuntimeStore } from "./runtime";
import {
  setupJupyter,
  startJupyter,
  setupScienceMcp,
  watchSetupProgress,
  agentBrowserBin,
  browserMcpBin,
  detectChrome,
  closeAgentBrowser,
  getProxySetting,
  removeConfigEntry,
  openExternal,
} from "./tauri";
import { SCIENCE_CONNECTORS, connectorConfig } from "./scienceConnectors";
import { BROWSER_MCP_ID, buildBrowserMcpConfig } from "./browser";
import { toast } from "./toast";

/** What the browser settings page collects before enabling / applying. */
export interface EnableBrowserOptions {
  /** Chrome profile directory to reuse; empty ⇒ isolated fresh profile. */
  profileDir?: string;
  /** Show a visible browser window (default headless). */
  headed?: boolean;
  /** agent-browser tool profile(s), comma-separated (default "core"). */
  tools?: string;
  /** Domain allowlist; empty ⇒ unrestricted. */
  allowedDomains?: string[];
  /** Drive the detected system Chrome (true) vs a separate downloaded browser
   *  (false — never touches the user's Chrome). Default true. */
  useSystemChrome?: boolean;
}

interface SetupState {
  /** True while the isolated Jupyter env is being provisioned. */
  jupyterBusy: boolean;
  /** The science connector currently provisioning, by id (null = none). */
  connectorId: string | null;
  /** Latest live uv output line — reassurance during a hundreds-of-MB download. */
  line: string | null;
  /** True while browser control is being enabled. */
  browserBusy: boolean;
  /** Bumped when any provisioning run finishes, so open pages re-read status. */
  generation: number;
  enableJupyter: () => Promise<void>;
  enableConnector: (id: string, apiKey?: string) => Promise<void>;
  enableBrowser: (opts: EnableBrowserOptions) => Promise<void>;
}

/** How long a remote connector's browser sign-in stays worth waiting for —
 *  matches the provider-login window in SettingsPage's own OAuth flow. */
const MCP_OAUTH_WAIT_MS = 5 * 60 * 1000;

/** Poll `listMcpServers` (already-tested, already-polled-elsewhere) until
 *  `name` reports connected, instead of holding one request open across the
 *  whole login — see `startMcpOAuth`'s doc comment for why. */
async function waitForMcpConnected(name: string): Promise<boolean> {
  const deadline = Date.now() + MCP_OAUTH_WAIT_MS;
  for (;;) {
    const servers = await getClient()!.listMcpServers().catch(() => []);
    const status = servers.find((s) => s.name === name)?.status;
    if (status === "connected") return true;
    if (status === "failed") return false;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export const useSetupStore = create<SetupState>((set, get) => ({
  jupyterBusy: false,
  connectorId: null,
  line: null,
  browserBusy: false,
  generation: 0,

  enableJupyter: async () => {
    // One provisioning run at a time: a second `uv venv` / `pip install` into
    // the same env dir races the first and fails.
    if (get().jupyterBusy) return;
    set({ jupyterBusy: true, line: null });
    try {
      toast.success("Setting up Jupyter — first run downloads a few hundred MB, please wait…");
      await setupJupyter();
      const s = await startJupyter();
      if (!s.url || !s.token || !s.mcp_command) throw new Error("setup finished incomplete");
      await getClient()!.addMcpServer("jupyter", {
        type: "local",
        command: [s.mcp_command],
        enabled: true,
        environment: { JUPYTER_URL: s.url, JUPYTER_TOKEN: s.token, ALLOW_IMG_OUTPUT: "true" },
      });
      toast.success("Jupyter MCP enabled — the agent can now drive notebooks.");
      await useRuntimeStore.getState().loadCatalog();
    } catch (e) {
      toast.error(`Jupyter setup failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      set((st) => ({ jupyterBusy: false, line: null, generation: st.generation + 1 }));
    }
  },

  enableConnector: async (id, apiKey) => {
    if (get().connectorId) return; // one connector provisioning at a time
    const c = SCIENCE_CONNECTORS.find((x) => x.id === id);
    if (!c) return;
    set({ connectorId: id, line: null });
    try {
      if (c.type === "remote") {
        // Nothing to install — register the vendor's URL, then send the user
        // to their browser to sign in. `startMcpOAuth` returns immediately
        // (see its own doc comment for why we don't hold the request open).
        await getClient()!.addMcpServer(c.id, connectorConfig(c));
        const { authorizationUrl } = await getClient()!.startMcpOAuth(c.id);
        set({ line: "Waiting for browser sign-in…" });
        await openExternal(authorizationUrl);
        if (!(await waitForMcpConnected(c.id))) {
          throw new Error("Sign-in did not complete in time");
        }
      } else {
        toast.success(`Setting up ${c.label} — first run downloads a managed Python, please wait…`);
        const python = await setupScienceMcp(c.pkg);
        await getClient()!.addMcpServer(c.id, connectorConfig(c, python, apiKey));
      }
      toast.success(`${c.label} enabled — the agent can now use it from chat.`);
      await useRuntimeStore.getState().loadCatalog();
    } catch (e) {
      toast.error(`${c.label} setup failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      set((st) => ({ connectorId: null, line: null, generation: st.generation + 1 }));
    }
  },

  enableBrowser: async (opts) => {
    if (get().browserBusy) return;
    set({ browserBusy: true, line: null });
    try {
      // Resolve the sidecars, browser executable, and network proxy here so the
      // UI stays thin. The managed browser is a separate process even when it
      // starts from a copy of a selected Chrome login.
      const bin = await agentBrowserBin();
      const proxyBin = await browserMcpBin();
      // Only bind the system Chrome when the user chose it; the private-browser
      // mode leaves executablePath unset so agent-browser uses its own download.
      const chrome = opts.useSystemChrome === false ? null : await detectChrome();
      const proxy = (await getProxySetting())?.effective ?? null;
      const config = buildBrowserMcpConfig({
        proxyBin,
        bin,
        profileDir: opts.profileDir,
        executablePath: chrome?.path,
        headed: opts.headed,
        proxy,
        tools: opts.tools,
        allowedDomains: opts.allowedDomains,
      });
      // Reconfiguration owns the whole browser lifecycle. Close any current
      // namespaced daemon before replacing the MCP process and its environment.
      await closeAgentBrowser();
      // addMcpServer PATCHes the config, and OpenCode deep-merges the nested
      // `environment` map — so a reconfigure that DROPS a setting can't take
      // effect on a plain re-add: turning "Show the browser window" off (or
      // switching to the private browser, or clearing the domain allowlist)
      // only omits the env key, and the merge keeps the stale old value. Remove
      // the existing entry first so the environment is rewritten from scratch.
      // removeConfigEntry rewrites the file and restarts the sidecar, so wait
      // for it to come back before re-adding; the first enable has no entry to
      // remove (it rejects) — skip the wait and go straight to the add.
      const hadEntry = await removeConfigEntry("mcp", BROWSER_MCP_ID)
        .then(() => true)
        .catch(() => false);
      if (hadEntry) await useRuntimeStore.getState().connectRetry();
      await getClient()!.addMcpServer(BROWSER_MCP_ID, config);
      toast.success("Browser control enabled — the agent can now drive Chrome from chat.");
      await useRuntimeStore.getState().loadCatalog();
    } catch (e) {
      toast.error(`Browser control setup failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      set((st) => ({ browserBusy: false, line: null, generation: st.generation + 1 }));
    }
  },
}));

// A SINGLE app-lifetime uv-progress listener. Registered once from AppShell so
// a page unmount can never sever it — the old per-page listener died with
// SettingsPage and made a running download look frozen.
let progressUnlisten: (() => void) | null = null;

/** Start the shared uv-progress listener (idempotent). Call once from AppShell. */
export function ensureSetupProgressListener(): void {
  if (progressUnlisten) return;
  progressUnlisten = () => {}; // claim the slot synchronously against a double call
  void watchSetupProgress((p) => useSetupStore.setState({ line: p.line })).then((u) => {
    progressUnlisten = u;
  });
}
