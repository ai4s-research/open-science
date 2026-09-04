import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  Download,
  ExternalLink,
  FolderOpen,
  Loader2,
  Minus,
  NotebookPen,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import type {
  CustomProviderModel,
  McpServer,
  OAuthAuthorization,
  ProviderAuthMethod,
  ProviderCatalogEntry,
  ProviderInfo,
} from "@ai4s/sdk";
import { CUSTOM_PROVIDER_PRESETS, OPENCODE_VERSION } from "@ai4s/sdk";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { useUiStore, ZOOM_MAX, ZOOM_MIN } from "@/lib/store";
import { shippedLocales } from "@/i18n/config";
import { getClient, useRuntimeStore } from "@/lib/runtime";
import { useUpdateStore } from "@/lib/update";
import {
  agentBrowserProfiles,
  closeAgentBrowser,
  detectChrome,
  setupBrowserChrome,
  type BrowserProfile,
  type ChromeInfo,
  importOpenCodeLogin,
  isMacUA,
  isTauri,
  jupyterStatus,
  openExternal,
  logDebug,
  openWorkspaceBase,
  pickFolder,
  providerAuthExists,
  pythonInterpreter,
  removeConfigEntry,
  setPythonPath,
  setWorkspaceBase,
  workspaceBase,
  type JupyterStatus,
  type PythonInterpreter,
  getProxySetting,
  type ProxyMode,
  type ProxySetting,
  getMirrorSetting,
  setMirrorSetting,
  type MirrorSetting,
  probeEndpointModels,
  type ProbedModel,
} from "@/lib/tauri";
import { useSetupStore } from "@/lib/setup";
import { isGatewayWeb } from "@/lib/webMode";
import { customProviderId } from "@/lib/customProviderId";
import { listProvidersWithAvailability } from "@/lib/zenModels";
import { RemoteComputeCard } from "@/components/settings/RemoteComputeCard";
import { RemoteAccessCard } from "@/components/settings/RemoteAccessCard";
import { TerminalCliCard } from "@/components/settings/TerminalCliCard";
import { ConversationSyncCard } from "@/components/settings/ConversationSyncCard";
import { AcpAgentsCard } from "@/components/settings/AcpAgentsCard";
import { ModalCard } from "@/components/settings/ModalCard";
import { DataFlowCard } from "@/components/settings/DataFlowCard";
import { ModelBrowser } from "@/components/settings/ModelBrowser";
import { fallbackDefaultModel } from "@/components/settings/modelCatalog";
import { ProviderManagerCard } from "@/components/settings/ProviderManagerCard";
import { AgentModelsCard } from "@/components/settings/AgentModelsCard";
import { MemoryCard } from "@/components/settings/MemoryCard";
import { Row, Section, Switch } from "@/components/settings/Section";
import { isDesktopOnlySection, resolveSection } from "@/components/settings/sections";
import { chipCls, inputCls, selectCls } from "@/components/settings/inputCls";
import { SCIENCE_CONNECTORS } from "@/lib/scienceConnectors";
import {
  BROWSER_MCP_ID,
  BROWSER_DISPLAY_NAMES,
  PRIVATE_BROWSER,
} from "@/lib/browser";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";

/**
 * Settings. ONE configuration surface: everything talks to the bundled
 * OpenCode's own config/auth API — no separate "model key" concept.
 */
export function SettingsPage() {
  // Which settings section is on screen — the sidebar is the navigation.
  const section = resolveSection(useParams().section);
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const locale = useUiStore((s) => s.locale);
  const setLocale = useUiStore((s) => s.setLocale);
  const zoom = useUiStore((s) => s.zoom);
  const zoomBy = useUiStore((s) => s.zoomBy);
  const resetZoom = useUiStore((s) => s.resetZoom);
  const { t } = useTranslation(["settings", "common"]);
  // Select each field individually. A bare `useRuntimeStore()` subscribed to the
  // WHOLE store, so every unrelated mutation (session events, streaming, idle
  // checks) re-rendered this page — in the packaged WKWebView that repaint storm
  // made the native <select>/<input>/<button> controls flicker and blank out on
  // scroll. These are the only fields the page actually reads.
  const status = useRuntimeStore((s) => s.status);
  const switching = useRuntimeStore((s) => s.switching);
  const serverUrl = useRuntimeStore((s) => s.serverUrl);
  const setServerUrl = useRuntimeStore((s) => s.setServerUrl);
  const connect = useRuntimeStore((s) => s.connect);
  const disconnect = useRuntimeStore((s) => s.disconnect);
  const defaultModel = useRuntimeStore((s) => s.defaultModel);
  const loadCatalog = useRuntimeStore((s) => s.loadCatalog);
  const runtimeKind = useRuntimeStore((s) => s.runtimeKind);
  const autoReview = useRuntimeStore((s) => s.autoReview);
  const setAutoReview = useRuntimeStore((s) => s.setAutoReview);
  const connected = status === "ready";
  const updateEnabled = useUpdateStore((s) => s.enabled);
  const setUpdateEnabled = useUpdateStore((s) => s.setEnabled);
  const updateBadgeEnabled = useUpdateStore((s) => s.badgeEnabled);
  const setUpdateBadgeEnabled = useUpdateStore((s) => s.setBadgeEnabled);
  const updateStatus = useUpdateStore((s) => s.status);
  const updateError = useUpdateStore((s) => s.error);
  const currentVersion = useUpdateStore((s) => s.currentVersion);
  const latestUpdate = useUpdateStore((s) => s.latest);
  const hasUpdate = useUpdateStore((s) => s.hasUpdate);
  const showUpdateBadge = useUpdateStore((s) => s.showBadge);
  const lastCheckedAt = useUpdateStore((s) => s.lastCheckedAt);
  const checkForUpdates = useUpdateStore((s) => s.check);
  const dismissUpdateBadge = useUpdateStore((s) => s.dismissBadge);
  const updateTone =
    hasUpdate || updateStatus === "error" ? "error" : updateStatus === "checking" ? "accent" : "ok";
  const updateLabel = hasUpdate
    ? t("updates.available")
    : updateStatus === "checking"
      ? t("updates.checking")
      : updateStatus === "error"
        ? t("updates.failed")
        : t("updates.upToDate");

  // Long-running uv provisioning lives in a store, not here: navigating away
  // must not discard the "setting up…" state or sever the progress stream.
  const jupyterBusy = useSetupStore((s) => s.jupyterBusy);
  const enablingConnector = useSetupStore((s) => s.connectorId);
  const browserBusy = useSetupStore((s) => s.browserBusy);
  const setupLine = useSetupStore((s) => s.line);
  const setupGeneration = useSetupStore((s) => s.generation);

  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  // The Models card's own lifecycle. "ready" is sticky across later refresh
  // failures (keep the last good list); a server-URL change resets it so a
  // different runtime can never render the previous runtime's catalog.
  const [catalogState, setCatalogState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [authMethods, setAuthMethods] = useState<Record<string, ProviderAuthMethod[]>>({});
  const [catalog, setCatalog] = useState<ProviderCatalogEntry[]>([]);
  const [customIds, setCustomIds] = useState<string[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [jupyter, setJupyter] = useState<JupyterStatus | null>(null);
  // Browser control (agent-browser): detected Chrome + profiles, and the choices
  // the card collects before enabling.
  const [browserProfiles, setBrowserProfiles] = useState<BrowserProfile[]>([]);
  const [chrome, setChrome] = useState<ChromeInfo | null>(null);
  const [browserProfile, setBrowserProfile] = useState(""); // "" ⇒ isolated
  const [browserHeaded, setBrowserHeaded] = useState(false);
  const [browserTools, setBrowserTools] = useState("core");
  const [browserDomains, setBrowserDomains] = useState(""); // one pattern per line
  // The interpreter local Python kernels resolve to + the manual override input.
  const [pyInfo, setPyInfo] = useState<PythonInterpreter | null>(null);
  const [pyPath, setPyPath] = useState("");
  const [savingPy, setSavingPy] = useState(false);
  // API keys typed for key-requiring connectors, keyed by connector id.
  const [connectorKeys, setConnectorKeys] = useState<Record<string, string>>({});

  // Add-MCP-server form.
  const [mName, setMName] = useState("");
  const [mType, setMType] = useState<"local" | "remote">("local");
  const [mTarget, setMTarget] = useState("");
  const [wsPath, setWsPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The store owns "a model switch failed" (modelSwitchError): after a failed
  // apply the browser stays on screen for a retry instead of collapsing into
  // the connect prompt, no matter how the attempt failed.
  const modelSwitchError = useRuntimeStore((s) => s.modelSwitchError);
  const modelSurfaceAvailable =
    connected || switching || (status === "error" && modelSwitchError !== null);
  const modelControlsBusy = busy || switching;

  // Custom endpoint form (self-hosted / Ollama / OpenAI- or Anthropic-compatible).
  const [showCustom, setShowCustom] = useState(false);
  const [cName, setCName] = useState("");
  const [cNpm, setCNpm] = useState("@ai-sdk/openai-compatible");
  const [cUrl, setCUrl] = useState("");
  const [cKey, setCKey] = useState("");
  const [cModels, setCModels] = useState("");
  // Optional context window for hand-typed model ids; probed models carry
  // their own (cContexts). Empty → the SDK's 128k default.
  const [cCtx, setCCtx] = useState("");
  const [cDetected, setCDetected] = useState<ProbedModel[] | null>(null);
  const [cDetecting, setCDetecting] = useState(false);
  const [cContexts, setCContexts] = useState<Record<string, number>>({});
  const [cPresetId, setCPresetId] = useState("");
  const [cModelMetadata, setCModelMetadata] = useState<Record<string, CustomProviderModel>>({});

  // Connect-a-provider flow state.
  const [providerManagerOpen, setProviderManagerOpen] = useState(false);
  const [connectQuery, setConnectQuery] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [bedrockRegion, setBedrockRegion] = useState("");
  const [bedrockRegionLoading, setBedrockRegionLoading] = useState(false);
  const [promptInputs, setPromptInputs] = useState<Record<string, string>>({});
  const [oauth, setOauth] = useState<
    (OAuthAuthorization & { providerID: string; methodIndex: number }) | null
  >(null);
  const [codeInput, setCodeInput] = useState("");
  // A pending browser-login wait: `oauthGen` invalidates it (cancel, restart,
  // or connecting some other way), `oauthAbort` also cancels its in-flight
  // callback request so retries never stack pending waits on the sidecar.
  const oauthGen = useRef(0);
  const oauthAbort = useRef<AbortController | null>(null);

  const refresh = useCallback(async (): Promise<ProviderInfo[] | null> => {
    const client = getClient();
    if (!client) return null;
    // The model catalog (listProviders) is what the Models card renders — only
    // its failure means "catalog unavailable", and only when there is no last
    // good list to keep showing. The rest is auxiliary settings data.
    let fresh: ProviderInfo[] | null = null;
    try {
      fresh = await listProvidersWithAvailability(client);
      setProviders(fresh);
      setCatalogState("ready");
    } catch {
      setCatalogState((s) => (s === "ready" ? s : "unavailable"));
    }
    try {
      const [m, c, custom, mcp] = await Promise.all([
        client.listAuthMethods(),
        client.listProviderCatalog(),
        client.listCustomProviderIds(),
        client.listMcpServers().catch(() => []),
      ]);
      setAuthMethods(m);
      setCatalog(c.all);
      setCustomIds(custom);
      setMcpServers(mcp);
      setJupyter(await jupyterStatus());
    } catch {
      /* runtime not ready yet */
    }
    return fresh;
  }, []);

  // Re-refresh when a provisioning run finishes (setupGeneration bumps) so a
  // newly-enabled MCP shows up even if setup completed while this page was
  // closed — the flow itself lives in the setup store.
  useEffect(() => {
    if (connected) void refresh();
  }, [connected, refresh, setupGeneration]);
  // A different server URL means a different runtime: drop the cached catalog
  // so its models can never be shown against (or written to) the new server.
  useEffect(() => {
    setProviders([]);
    setCatalogState("loading");
  }, [serverUrl]);
  useEffect(() => {
    // The BASE folder — contains projects/ and sessions/. (The per-session
    // active folder shows in the conversation header.)
    void workspaceBase().then(setWsPath);
  }, []);
  const refreshPython = useCallback(() => {
    void pythonInterpreter().then(setPyInfo);
  }, []);
  // Also on setupGeneration: a fresh jupyter-env may now back the local kernel.
  useEffect(refreshPython, [refreshPython, setupGeneration]);

  // Detect Chrome + profiles once connected, and re-detect after a provisioning
  // run (a Chrome download can appear between renders).
  useEffect(() => {
    if (!isTauri || !connected) return;
    void agentBrowserProfiles().then(setBrowserProfiles);
    void detectChrome().then((c) => {
      setChrome(c);
      // With no system Chrome, the only workable choice is the private browser.
      if (!c) setBrowserProfile((p) => (p === PRIVATE_BROWSER ? p : PRIVATE_BROWSER));
    });
  }, [connected, setupGeneration]);

  // The registered MCP entry is the source of truth for browser settings.
  const browserServer = mcpServers.find((s) => s.name === BROWSER_MCP_ID) ?? null;
  const browserEnabled = browserServer !== null;
  const browserConfigSig = JSON.stringify(browserServer?.config ?? null);
  // When enabled, mirror the live config into the form so the page shows the
  // current settings and edits start from them (not stale defaults).
  useEffect(() => {
    const cfg = browserServer?.config;
    if (!cfg || cfg.type !== "local") return;
    const env = cfg.environment ?? {};
    // No executable path pinned ⇒ it's the private (downloaded) browser.
    setBrowserProfile(
      env.AGENT_BROWSER_EXECUTABLE_PATH ? (env.AGENT_BROWSER_PROFILE ?? "") : PRIVATE_BROWSER,
    );
    setBrowserHeaded(env.AGENT_BROWSER_HEADED === "true");
    setBrowserDomains(
      (env.AGENT_BROWSER_ALLOWED_DOMAINS ?? "")
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean)
        .join("\n"),
    );
    const ti = cfg.command.indexOf("--tools");
    setBrowserTools(ti >= 0 && cfg.command[ti + 1] ? cfg.command[ti + 1] : "core");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserConfigSig]);

  const savePythonPath = async (path: string) => {
    setSavingPy(true);
    try {
      await setPythonPath(path);
      setPyPath("");
      toast.success(path ? t("toast.interpreterSet") : t("toast.overrideCleared"));
      refreshPython();
    } catch (e) {
      toast.error(`${t("toast.couldNotSetInterpreter")}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSavingPy(false);
    }
  };

  const changeWorkspaceBase = async () => {
    const picked = await pickFolder();
    if (!picked) return;
    try {
      setWsPath(await setWorkspaceBase(picked));
      toast.success(t("toast.folderSet"));
    } catch (err) {
      toast.error(`${t("toast.couldNotSetFolder")}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Network proxy for the sidecar (follow system / custom / direct).
  const [proxy, setProxy] = useState<ProxySetting | null>(null);
  const [proxyUrlInput, setProxyUrlInput] = useState("");
  const refreshProxy = useCallback(() => {
    void getProxySetting().then((p) => {
      setProxy(p);
      if (p) setProxyUrlInput(p.url);
    });
  }, []);
  useEffect(refreshProxy, [refreshProxy]);

  const applyProxy = (mode: ProxyMode, url: string) =>
    run(t("toast.couldNotSetProxy"), async () => {
      await useRuntimeStore.getState().setProxySetting(mode, url);
      refreshProxy();
      toast.success(t("toast.proxyApplied"));
    });

  /** Mode select: system/none apply immediately; custom just reveals the URL
   *  field — it applies on Save/Enter once a URL is typed. */
  const changeProxyMode = (mode: ProxyMode) => {
    if (!proxy) return;
    if (mode === "custom") {
      setProxy({ ...proxy, mode: "custom" });
      return;
    }
    void applyProxy(mode, "");
  };
  const validProxyUrl = /^(https?|socks5):\/\/\S+:\d+\/?$/i.test(proxyUrlInput.trim());

  // uv download mirrors, used only when provisioning Python tools (Jupyter,
  // science databases). Optional; a blank field clears that mirror.
  const [mirror, setMirror] = useState<MirrorSetting | null>(null);
  const [pypiInput, setPypiInput] = useState("");
  const [pythonInput, setPythonInput] = useState("");
  useEffect(() => {
    void getMirrorSetting().then((m) => {
      setMirror(m);
      if (m) {
        setPypiInput(m.pypi);
        setPythonInput(m.python);
      }
    });
  }, []);
  const validMirror = (u: string) => u.trim() === "" || /^https?:\/\/\S+$/i.test(u.trim());
  const mirrorDirty =
    !!mirror && (pypiInput.trim() !== mirror.pypi || pythonInput.trim() !== mirror.python);
  const applyMirror = () =>
    run(t("toast.couldNotSetMirror"), async () => {
      await setMirrorSetting(pypiInput.trim(), pythonInput.trim());
      setMirror({ pypi: pypiInput.trim(), python: pythonInput.trim() });
      toast.success(t("toast.mirrorSaved"));
    });

  // The one post-change sequence — run() and the background OAuth wait must
  // stay in lockstep, so they share it instead of each keeping a copy.
  const refreshAll = async () => {
    const fresh = await refresh();
    await loadCatalog();
    // A provider change can strand the configured default model (provider
    // removed, or its models renamed): every later send then fails with
    // "model not found" (#18). Re-point it at the closest surviving model
    // while the change that broke it is still on screen.
    const { defaultModel: current, setDefaultModel } = useRuntimeStore.getState();
    const next = fresh && current ? fallbackDefaultModel(fresh, current) : null;
    if (!next) return;
    try {
      await setDefaultModel(next);
      toast.success(t("toast.defaultModelReset", { old: current, model: next }));
    } catch (e) {
      toast.error(`${t("toast.couldNotSetModel")}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      await refreshAll();
    } catch (e) {
      toast.error(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // Any action that cancels, restarts or bypasses the oauth flow must call
  // this: it invalidates the pending browser wait and aborts its request.
  const invalidateOauthWait = () => {
    oauthGen.current++;
    oauthAbort.current?.abort();
    oauthAbort.current = null;
  };

  const saveModel = async (model: string): Promise<boolean> => {
    // The store masks the whole apply with `switching` and records any failure
    // in `modelSwitchError`; this page only presents the outcome.
    try {
      await useRuntimeStore.getState().setDefaultModel(model);
      toast.success(t("toast.defaultModelSet", { model }));
      return true;
    } catch (error) {
      toast.error(`${t("toast.couldNotSetModel")}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  const saveKey = (providerID: string) =>
    run(t("toast.couldNotSaveKey"), async () => {
      if (providerID === "amazon-bedrock") {
        await getClient()!.setProviderRegion(providerID, bedrockRegion.trim());
      }
      await getClient()!.setProviderApiKey(providerID, keyInput.trim());
      cancelOAuth(); // a pending browser login for this panel is now moot
      setKeyInput("");
      setConnectQuery("");
      toast.success(t("toast.providerConnected", { providerID }));
    });

  const startOAuth = (providerID: string, methodIndex: number, inputs?: Record<string, string>) =>
    run(t("toast.couldNotStartLogin"), async () => {
      // Re-clicking while THIS login is already waiting must not re-authorize:
      // a second authorize supersedes the pending one server-side, and some
      // provider plugins (xai) then tear down the loopback callback server the
      // new attempt just handed to the browser — every retry would fail. The
      // existing wait keeps covering the flow; let it finish.
      if (
        oauth &&
        oauth.providerID === providerID &&
        oauth.methodIndex === methodIndex &&
        oauthAbort.current
      )
        return;
      invalidateOauthWait(); // this flow replaces any pending one
      const gen = oauthGen.current;
      const auth = await getClient()!.oauthAuthorize(providerID, methodIndex, inputs);
      if (gen !== oauthGen.current) return; // cancelled while starting
      setOauth({ ...auth, providerID, methodIndex });
      await openExternal(auth.url);
      // "auto" flows finish on the browser redirect — the callback call below
      // WAITS for it, so run it in the background (never through `busy`, which
      // would lock the whole page for as long as the browser tab stays open).
      if (auth.method !== "code" && gen === oauthGen.current)
        void waitForBrowserLogin(providerID, methodIndex, gen);
    });

  // Provider plugins hold a browser login open for minutes (xai: 5). Match
  // that window when re-attaching a dropped callback wait below.
  const OAUTH_WAIT_MS = 5 * 60 * 1000;

  const waitForBrowserLogin = async (providerID: string, methodIndex: number, gen: number) => {
    const deadline = Date.now() + OAUTH_WAIT_MS;
    const active = () => gen === oauthGen.current;
    // Ground truth that the login landed: the sidecar writes the provider's
    // token to its credential store the moment the browser flow completes —
    // even when the callback wait below never hears about it (loopback port
    // collision, proxy, dropped redirect). The browser then shows "success"
    // while the app looks frozen (#17). Only conclusive for a provider that
    // had no credentials when the wait began.
    const hadAuth = await providerAuthExists(providerID);
    const loginLanded = async () => !hadAuth && (await providerAuthExists(providerID));

    // The callback POST hangs open until the browser redirect lands, but the
    // webview's native fetch enforces its own idle timeout (~60s in WKWebView)
    // — far shorter than the provider's login window, and a slow browser login
    // (2FA, consent) used to surface as "login did not complete" even though
    // the browser then finished successfully. A network-level drop is NOT a
    // failed login: the server keeps the pending attempt and a re-POST resumes
    // waiting on it (opencode's ProviderAuth.callback re-invokes the stored
    // pending closure; it is never consumed). Retry those; HTTP errors are the
    // provider's real verdict and stay terminal.
    type Verdict = { ok: boolean; viaStore: boolean; error?: unknown };
    const callbackVerdict = async (): Promise<Verdict | null> => {
      let lastError: unknown = new Error("Timed out waiting for the browser login");
      while (Date.now() < deadline && active()) {
        const abort = new AbortController();
        oauthAbort.current = abort;
        try {
          await getClient()!.oauthCallback(providerID, methodIndex, undefined, abort.signal);
          if (!active()) {
            // Cancelled in the UI, but the login DID complete — refresh silently
            // so the now-connected provider still shows up in the list.
            await refreshAll();
            return null;
          }
          return { ok: true, viaStore: false };
        } catch (e) {
          if (!active()) return null; // cancelled — the abort is expected
          // Webview fetch failures (idle timeout, transient drop) are TypeError;
          // apiError() throws plain Error for the server's HTTP verdicts.
          if (e instanceof TypeError) {
            lastError = e;
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }
          return { ok: false, viaStore: false, error: e };
        } finally {
          if (oauthAbort.current === abort) oauthAbort.current = null;
        }
      }
      // The login window closed without a verdict from the server.
      return active() ? { ok: false, viaStore: false, error: lastError } : null;
    };

    // Race the server's verdict against the credential store: whichever
    // reports first settles the wait. The watcher only ever reports success —
    // silence just leaves the callback in charge.
    let verdict = await new Promise<Verdict | null>((resolve) => {
      void callbackVerdict().then(resolve);
      void (async () => {
        while (Date.now() < deadline && active()) {
          await new Promise((r) => setTimeout(r, 2000));
          if (!active()) return;
          if (await loginLanded()) return resolve({ ok: true, viaStore: true });
        }
      })();
    });
    if (verdict === null || !active()) return; // cancelled
    if (!verdict.ok && (await loginLanded())) {
      // The server said failure (or timed out), but the credential store says
      // the login landed — the callback signal was lost, not the login.
      verdict = { ok: true, viaStore: true };
    }
    if (!active()) return; // superseded while re-checking the store
    invalidateOauthWait(); // settled either way — stop the losing strategy
    setOauth(null);
    if (!verdict.ok) {
      const err = verdict.error;
      toast.error(`${t("toast.loginDidNotComplete")}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // A store-confirmed login skipped oauthCallback's cache invalidation — the
    // provider list would still answer from the pre-login cache.
    if (verdict.viaStore) await getClient()?.refreshProviderCache();
    toast.success(t("toast.providerConnected", { providerID }));
    await refreshAll();
  };

  const cancelOAuth = () => {
    invalidateOauthWait();
    setOauth(null);
    setCodeInput("");
  };

  const completeOAuth = () =>
    run(t("toast.loginDidNotComplete"), async () => {
      if (!oauth) return;
      const { providerID, methodIndex } = oauth;
      invalidateOauthWait(); // the pasted code supersedes any browser wait
      await getClient()!.oauthCallback(providerID, methodIndex, codeInput.trim() || undefined);
      toast.success(t("toast.providerConnected", { providerID }));
      setOauth(null);
      setCodeInput("");
    });

  const disconnectProvider = (providerID: string) =>
    run(t("toast.couldNotRemove"), async () => {
      const custom = customIds.includes(providerID);
      // #37 diagnostics: record removals so a repro (e.g. "removing one provider
      // makes every key stop being recognized") shows the provider set before and
      // after, distinguishing a config vs. auth-store mismatch.
      void logDebug(`[provider] disconnect ${providerID} (custom=${custom})`);
      if (custom) {
        // Custom endpoints live in the config file; removal restarts the sidecar.
        await removeConfigEntry("provider", providerID);
        await useRuntimeStore.getState().connectRetry();
        // A custom provider's id is derived from its display name, and a key set
        // via the key panel is stored separately in the auth store keyed by that
        // id. Removing only the config entry leaves that credential behind, so
        // re-adding the endpoint appears to "only work when the name matches
        // exactly" — the stale key silently re-attaches (#37). Clear it too.
        // Best-effort: most custom providers carry their key inline (no auth
        // entry), and DELETE on a missing one is expected to fail.
        await getClient()!.removeProviderAuth(providerID).catch(() => undefined);
      } else {
        await getClient()!.removeProviderAuth(providerID);
      }
      try {
        const provs = await getClient()!.listProviders();
        void logDebug(`[provider] after removing ${providerID}: providers=[${provs.map((p) => p.id).join(",")}]`);
      } catch (e) {
        void logDebug(`[provider] post-remove probe failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      toast.success(t("toast.providerRemoved", { providerID }));
    });

  // Ask the endpoint itself which models it serves (and their context windows
  // where reported — Ollama native, vLLM, OpenRouter). Results render as
  // toggleable chips; contexts ride along into saveCustom.
  const fetchCustomModels = async () => {
    if (!cUrl.trim()) {
      toast.error(t("toast.endpointFieldsRequired"));
      return;
    }
    setCDetecting(true);
    try {
      const found = await probeEndpointModels(
        cUrl.trim(),
        cKey.trim() || undefined,
        cNpm === "@ai-sdk/anthropic" ? "anthropic" : "openai",
      );
      setCDetected(found);
      setCContexts((prev) => {
        const next = { ...prev };
        for (const m of found) if (m.context) next[m.id] = m.context;
        return next;
      });
    } catch (err) {
      toast.error(`${t("toast.couldNotFetchModels")}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCDetecting(false);
    }
  };

  const modelList = (s: string) => s.split(",").map((v) => v.trim()).filter(Boolean);

  const applyCustomPreset = (presetId: string) => {
    setCPresetId(presetId);
    const preset = CUSTOM_PROVIDER_PRESETS.find((p) => p.id === presetId);
    if (!preset) {
      setCModelMetadata({});
      return;
    }
    setCName(preset.name);
    setCNpm(preset.npm);
    setCUrl(preset.baseURL);
    setCModels(preset.models.map((m) => m.id).join(", "));
    setCCtx("");
    setCContexts(
      Object.fromEntries(
        preset.models
          .filter((m) => m.context !== undefined)
          .map((m) => [m.id, m.context as number]),
      ),
    );
    setCModelMetadata(Object.fromEntries(preset.models.map((m) => [m.id, m])));
    setCDetected(null);
  };

  const toggleDetectedModel = (id: string) => {
    const models = modelList(cModels);
    const next = models.includes(id) ? models.filter((m) => m !== id) : [...models, id];
    setCModels(next.join(", "));
  };

  const saveCustom = () =>
    run(t("toast.couldNotAddEndpoint"), async () => {
      const id = customProviderId(cName);
      const models = modelList(cModels);
      if (!id || !cUrl.trim() || models.length === 0) {
        toast.error(t("toast.endpointFieldsRequired"));
        return;
      }
      // Per-model context: probed value first, else the optional typed one.
      const typedCtx = Number.parseInt(cCtx.trim(), 10);
      const contexts: Record<string, number> = {};
      for (const m of models) {
        const ctx = cContexts[m] ?? (Number.isFinite(typedCtx) && typedCtx > 0 ? typedCtx : 0);
        if (ctx > 0) contexts[m] = ctx;
      }
      const modelSpecs = models.map((m) => cModelMetadata[m] ?? m);
      await getClient()!.addCustomProvider(id, {
        name: cName.trim(),
        npm: cNpm,
        baseURL: cUrl.trim(),
        apiKey: cKey.trim() || undefined,
        models: modelSpecs,
        contexts,
      });
      toast.success(t("toast.endpointAdded", { name: cName.trim() }));
      setShowCustom(false);
      setCName("");
      setCUrl("");
      setCKey("");
      setCModels("");
      setCCtx("");
      setCDetected(null);
      setCContexts({});
      setCPresetId("");
      setCModelMetadata({});
    });

  const addMcp = () =>
    run(t("toast.couldNotAddMcp"), async () => {
      const name = mName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const target = mTarget.trim();
      if (!name || !target) {
        toast.error(t("toast.mcpFieldsRequired"));
        return;
      }
      await getClient()!.addMcpServer(
        name,
        mType === "local"
          ? { type: "local", command: target.split(/\s+/), enabled: true }
          : { type: "remote", url: target, enabled: true },
      );
      toast.success(t("toast.mcpAdded", { name }));
      setMName("");
      setMTarget("");
    });

  // The provisioning flows themselves live in the setup store so they outlive
  // this page. The connector's API key is dropped from UI state up front — the
  // store already holds the value it needs, so it never lingers here.
  const enableConnector = (id: string) => {
    const key = connectorKeys[id];
    setConnectorKeys((k) => ({ ...k, [id]: "" }));
    void useSetupStore.getState().enableConnector(id, key);
  };

  const enableBrowserControl = () => {
    const useSystemChrome = browserProfile !== PRIVATE_BROWSER;
    void useSetupStore.getState().enableBrowser({
      profileDir: useSystemChrome && browserProfile ? browserProfile : undefined,
      headed: browserHeaded,
      tools: browserTools,
      useSystemChrome,
      allowedDomains: browserDomains
        .split(/[\n,]/)
        .map((d) => d.trim())
        .filter(Boolean),
    });
  };

  const disableBrowser = () =>
    run(t("toast.couldNotRemoveMcp"), async () => {
      await closeAgentBrowser();
      await removeConfigEntry("mcp", BROWSER_MCP_ID);
      await useRuntimeStore.getState().connectRetry();
      toast.success(t("toast.mcpRemoved", { name: t("browser.label") }));
    });

  // Pre-download a private browser when no system Chrome exists (agent-browser
  // would otherwise fetch one silently on first use). Streams via setup-progress.
  const downloadBrowser = () =>
    run(t("browser.couldNotDownload"), async () => {
      await setupBrowserChrome();
      setChrome(await detectChrome());
      toast.success(t("browser.downloaded"));
    });

  const removeMcp = (name: string) =>
    run(t("toast.couldNotRemoveMcp"), async () => {
      await removeConfigEntry("mcp", name);
      await useRuntimeStore.getState().connectRetry();
      toast.success(t("toast.mcpRemoved", { name }));
    });

  const importLogin = () =>
    run(t("toast.importFailed"), async () => {
      const found = await importOpenCodeLogin();
      if (!found) {
        toast.error(t("toast.noOpenCodeLoginFound"));
        return;
      }
      // The sidecar restarted with the imported credentials — reconnect.
      await useRuntimeStore.getState().connectRetry();
      toast.success(t("toast.importedLogin"));
    });

  // Resolve the search box to a catalog entry (by id or exact name).
  const q = connectQuery.trim().toLowerCase();
  const selected =
    catalog.find((p) => p.id === q) ?? catalog.find((p) => p.name.toLowerCase() === q) ?? null;
  const validBedrockRegion =
    selected?.id !== "amazon-bedrock" ||
    /^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/.test(bedrockRegion.trim());
  useEffect(() => {
    if (selected?.id !== "amazon-bedrock") return;
    const client = getClient();
    if (!client) return;
    let active = true;
    setBedrockRegionLoading(true);
    void client
      .getProviderRegion(selected.id)
      .then((region) => {
        if (active) setBedrockRegion(region ?? "");
      })
      .catch(() => {
        if (active) setBedrockRegion("");
      })
      .finally(() => {
        if (active) setBedrockRegionLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selected?.id]);
  // Every provider takes an API key via PUT /auth; special flows (OAuth) add to
  // that. Keep each method's index in the provider's FULL upstream list — the
  // authorize call is by that index, and filtering re-numbers positions (a
  // provider whose api method precedes an oauth one would authorize the wrong
  // method).
  const oauthMethods: Array<{ method: ProviderAuthMethod; index: number }> = selected
    ? (authMethods[selected.id] ?? [])
        .map((method, index) => ({ method, index }))
        .filter(({ method }) => method.type === "oauth")
    : [];

  // The web client's navigation hides these, but the route still resolves — a
  // typed or shared `/settings/connectors` would otherwise render a card whose
  // every write the gateway refuses, the same dead end as #119. Placed after
  // every hook so the hook order never changes with the section.
  if (isGatewayWeb && isDesktopOnlySection(section)) {
    return (
      <div className="h-full select-none overflow-y-auto">
        <div className="mx-auto max-w-2xl px-4 pb-16 pt-4 sm:px-8">
          <h1 className="font-serif text-2xl text-text">{t(`nav.${section}`)}</h1>
          <p className="mt-4 text-[13px] leading-relaxed text-muted">{t("nav.desktopOnly")}</p>
        </div>
      </div>
    );
  }

  return (
    // `select-none`: Settings is chrome, not a document. Right-clicking or
    // dragging across a label used to leave stray highlight behind; the inputs
    // opt back in globally (see index.css).
    <div className="h-full select-none overflow-y-auto">
      {/* Modest top padding: the AppShell titlebar strip already clears 48px. */}
      <div className="mx-auto max-w-2xl px-4 pb-16 pt-4 sm:px-8">
        <h1 className="font-serif text-2xl text-text">{t(`nav.${section}`)}</h1>

        {/* ---- Agent runtime (server + proxy + mirrors, one grouped card) ---- */}
        {section === "runtime" && (
        <Section title={t("runtime.title")} hint={t("runtime.hint")} flush>
          <div className="divide-y divide-faint">
            {/* Server URL + connection status */}
            <Row
              title={t("runtime.serverLabel")}
              hint={
                <span className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      connected ? "bg-ok" : status === "error" ? "bg-error" : "bg-muted",
                    )}
                  />
                  <span className="capitalize">{status}</span>
                  {connected && defaultModel && (
                    <>
                      <span className="text-border">·</span>
                      <span className="font-mono">{defaultModel}</span>
                    </>
                  )}
                  {/* The bundled agent runtime, so a user with their own OpenCode
                      install can tell the two apart (#74). Shown on the desktop
                      only: the web client talks to whatever the host bundles. */}
                  {isTauri && (
                    <>
                      <span className="text-border">·</span>
                      <span className="font-mono">{`OpenCode ${OPENCODE_VERSION}`}</span>
                    </>
                  )}
                </span>
              }
            >
              <div className="mt-2.5 flex items-center gap-2">
                <input
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  placeholder={t("runtime.serverUrlPlaceholder")}
                  className={inputCls("flex-1 font-mono")}
                />
                {connected ? (
                  <button onClick={disconnect} className={btnGhost()}>
                    {t("runtime.disconnect")}
                  </button>
                ) : (
                  <button onClick={connect} className={btnAccent()}>
                    {t("runtime.connect")}
                  </button>
                )}
              </div>
            </Row>

            {/* Network proxy: follow system / custom / direct. Mode is a right-side
                chip; a custom URL field appears below only when "custom" is picked. */}
            {isTauri && proxy && (
              <Row
                title={t("runtime.proxyLabel")}
                hint={
                  proxy.mode === "none"
                    ? t("runtime.proxyDirectHint")
                    : proxy.effective
                      ? t("runtime.proxyEffective", { url: proxy.effective })
                      : t("runtime.proxyNoneDetected")
                }
                control={
                  <select
                    value={proxy.mode}
                    onChange={(e) => changeProxyMode(e.target.value as ProxyMode)}
                    disabled={busy}
                    aria-label={t("runtime.proxyLabel")}
                    className={chipCls("shrink-0")}
                  >
                    <option value="system">{t("runtime.proxySystem")}</option>
                    <option value="custom">{t("runtime.proxyCustom")}</option>
                    <option value="none">{t("runtime.proxyNone")}</option>
                  </select>
                }
              >
                {proxy.mode === "custom" && (
                  <div className="mt-2.5 flex items-center gap-2">
                    <input
                      value={proxyUrlInput}
                      onChange={(e) => setProxyUrlInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && validProxyUrl) void applyProxy("custom", proxyUrlInput.trim());
                      }}
                      placeholder={t("runtime.proxyPlaceholder")}
                      className={inputCls("flex-1 font-mono")}
                    />
                    <button
                      className={btnAccent()}
                      onClick={() => void applyProxy("custom", proxyUrlInput.trim())}
                      disabled={busy || !validProxyUrl}
                    >
                      <Check size={13} /> {t("common:actions.save")}
                    </button>
                  </div>
                )}
              </Row>
            )}

            {/* uv download mirrors — always visible; optional, applies on Save. */}
            {isTauri && mirror && (
              <Row title={t("runtime.mirrorTitle")} hint={t("runtime.mirrorHint")}>
                <div className="mt-2.5 space-y-2.5">
                  <label className="block">
                    <span className="mb-1 block text-xs text-muted">{t("runtime.mirrorPypi")}</span>
                    <input
                      value={pypiInput}
                      onChange={(e) => setPypiInput(e.target.value)}
                      placeholder={t("runtime.mirrorPypiPlaceholder")}
                      className={inputCls("w-full font-mono")}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-muted">{t("runtime.mirrorPython")}</span>
                    <input
                      value={pythonInput}
                      onChange={(e) => setPythonInput(e.target.value)}
                      placeholder={t("runtime.mirrorPythonPlaceholder")}
                      className={inputCls("w-full font-mono")}
                    />
                  </label>
                  <div className="flex justify-end">
                    <button
                      className={btnAccent()}
                      onClick={() => void applyMirror()}
                      disabled={busy || !mirrorDirty || !validMirror(pypiInput) || !validMirror(pythonInput)}
                    >
                      <Check size={13} /> {t("common:actions.save")}
                    </button>
                  </div>
                </div>
              </Row>
            )}
          </div>
        </Section>
        )}

        {/* ---- Models ---- */}
        {section === "models" && (
        <Section title={t("model.title")} hint={t("model.hint")}>
          {!modelSurfaceAvailable ? (
            <p className="text-[13px] text-muted">{t("model.connectPrompt")}</p>
          ) : catalogState === "unavailable" ? (
            <p className="text-[13px] text-muted">{t("model.catalogUnavailable")}</p>
          ) : catalogState === "loading" ? (
            <p className="text-[13px] text-muted">{t("model.catalogLoading")}</p>
          ) : (
            <ModelBrowser
              providers={providers}
              defaultModel={defaultModel}
              busy={modelControlsBusy}
              onSelect={saveModel}
              onManageProviders={() => setProviderManagerOpen(true)}
            />
          )}
        </Section>
        )}

        {/* ---- One model per agent (a fast reviewer, a strong main agent) ---- */}
        {section === "models" && isTauri && <AgentModelsCard providers={providers} />}

        {/* ---- Persistent memory layers ---- */}
        {section === "memory" && <MemoryCard />}

        {/* ---- Providers ---- */}
        {section === "models" && (
        <ProviderManagerCard
          providers={providers}
          // The web client can only read this surface, so say so up front
          // instead of describing writes it cannot make (#119).
          hint={isGatewayWeb ? t("providers.webHint") : undefined}
          expanded={providerManagerOpen}
          onExpandedChange={setProviderManagerOpen}
        >
          {!connected ? (
            <p className="px-4 py-3 text-[13px] text-muted">{t("providers.connectPrompt")}</p>
          ) : (
            <>
              <div>
                {providers.map((p, i) => (
                  <div
                    key={p.id}
                    className={cn(
                      "flex h-10 items-center gap-2.5 bg-surface px-3 text-[13px]",
                      i > 0 && "border-t border-faint",
                    )}
                  >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok" />
                    <span className="font-medium text-text">{p.name}</span>
                    <span className="text-xs text-muted">
                      {/* Counts what the picker will offer — a model the
                          provider has retired is not one of them. */}
                      {t("providers.modelCount", {
                        count: p.models.filter((m) => m.available !== false).length,
                      })}
                    </span>
                    <div className="flex-1" />
                    {p.id === "opencode" ? (
                      <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted ring-1 ring-border">
                        {t("providers.builtInFree")}
                      </span>
                    ) : isGatewayWeb ? null : (
                      <button
                        className="text-xs text-muted transition-colors hover:text-error"
                        onClick={() => void disconnectProvider(p.id)}
                        disabled={busy}
                        title={t("providers.removeTitle")}
                      >
                        {t("common:actions.remove")}
                      </button>
                    )}
                  </div>
                ))}

                {isGatewayWeb ? (
                  /* Every write here is refused by the gateway by design —
                     API keys and provider config never cross the wire — so the
                     web client shows what is connected and says where to change
                     it, instead of forms that 403 on submit (#119). */
                  <p
                    className={cn(
                      "p-3 text-[13px] leading-relaxed text-muted",
                      // Only a separator from the rows above — as the card's
                      // first child it would double the container's own border.
                      providers.length > 0 && "border-t border-faint",
                    )}
                  >
                    {t("providers.webNote")}
                  </p>
                ) : (
                  <>
                  {/* Connect a provider */}
                  <div className="border-t border-faint p-3">
                    <div className="relative">
                      <Search
                        size={13}
                        className="pointer-events-none absolute left-3 top-1/2 -mt-[6.5px] text-muted"
                      />
                      <input
                        list="provider-catalog"
                        value={connectQuery}
                        onChange={(e) => {
                          setConnectQuery(e.target.value);
                          cancelOAuth();
                          setPromptInputs({});
                        }}
                        placeholder={t("providers.searchPlaceholder", { count: catalog.length })}
                        className={inputCls("w-full pl-8")}
                      />
                      <datalist id="provider-catalog">
                        {catalog.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </datalist>
                    </div>

                    {selected && (
                      <div className="mt-2 space-y-2">
                        {oauthMethods.map(({ method: m, index: i }) =>
                          m.type === "oauth" ? (
                            <div key={i} className="space-y-1.5">
                              {(m.prompts ?? []).map((pr) =>
                                pr.type === "select" ? (
                                  <select
                                    key={pr.key}
                                    value={promptInputs[pr.key] ?? ""}
                                    onChange={(e) =>
                                      setPromptInputs((s) => ({ ...s, [pr.key]: e.target.value }))
                                    }
                                    className={selectCls("w-full")}
                                  >
                                    <option value="">{pr.message}</option>
                                    {(pr.options ?? []).map((o) => (
                                      <option key={o.value} value={o.value}>
                                        {o.label}
                                        {o.hint ? ` — ${o.hint}` : ""}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <input
                                    key={pr.key}
                                    value={promptInputs[pr.key] ?? ""}
                                    onChange={(e) =>
                                      setPromptInputs((s) => ({ ...s, [pr.key]: e.target.value }))
                                    }
                                    placeholder={pr.message}
                                    className={inputCls("w-full")}
                                  />
                                ),
                              )}
                              <button
                                className={btnGhost("gap-1.5")}
                                onClick={() => void startOAuth(selected.id, i, promptInputs)}
                                disabled={busy}
                              >
                                <ExternalLink size={12} /> {m.label}
                              </button>
                            </div>
                          ) : null,
                        )}

                        {selected.id === "amazon-bedrock" && (
                          <input
                            value={bedrockRegion}
                            onChange={(e) => setBedrockRegion(e.target.value)}
                            aria-label={t("providers.bedrockRegionLabel")}
                            placeholder={t("providers.bedrockRegionPlaceholder")}
                            className={inputCls("w-full font-mono")}
                            disabled={bedrockRegionLoading}
                          />
                        )}

                        <div className="flex items-center gap-2">
                          <input
                            type="password"
                            value={keyInput}
                            onChange={(e) => setKeyInput(e.target.value)}
                            placeholder={`${selected.name} ${t("providers.apiKeyLabel")}${selected.env[0] ? ` (${selected.env[0]})` : ""}`}
                            className={inputCls("flex-1 font-mono")}
                          />
                          <button
                            className={btnAccent()}
                            onClick={() => void saveKey(selected.id)}
                            disabled={
                              busy ||
                              bedrockRegionLoading ||
                              !keyInput.trim() ||
                              !validBedrockRegion
                            }
                          >
                            <Check size={13} /> {t("common:actions.save")}
                          </button>
                        </div>
                      </div>
                    )}

                    {oauth && (
                      <div className="mt-2 space-y-2 rounded-input bg-surface-2 p-3">
                        <p className="text-xs leading-relaxed text-muted">{oauth.instructions}</p>
                        {oauth.method === "code" ? (
                          <>
                            <input
                              value={codeInput}
                              onChange={(e) => setCodeInput(e.target.value)}
                              placeholder={t("providers.pasteCode")}
                              className={inputCls("w-full font-mono")}
                            />
                            <button
                              className={btnAccent()}
                              onClick={() => void completeOAuth()}
                              disabled={busy || !codeInput.trim()}
                            >
                              {busy ? (
                                <Loader2 size={12} className="animate-spin" />
                              ) : (
                                <Check size={13} />
                              )}
                              {t("providers.completeLogin")}
                            </button>
                          </>
                        ) : (
                          <div className="flex items-center gap-2 text-xs text-muted">
                            <Loader2 size={12} className="shrink-0 animate-spin" />
                            {t("providers.waitingForBrowser")}
                            <button
                              className="text-muted underline transition-colors hover:text-text"
                              onClick={cancelOAuth}
                            >
                              {t("common:actions.cancel")}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Custom endpoint */}
                  <div className="border-t border-faint">
                    <button
                      className="flex h-10 w-full items-center gap-2 px-3 text-left text-[13px] text-muted transition-colors hover:text-text"
                      onClick={() => setShowCustom((s) => !s)}
                      aria-expanded={showCustom}
                    >
                      <ChevronRight
                        size={13}
                        className={cn("transition-transform", showCustom && "rotate-90")}
                      />
                      {t("providers.customEndpoint")}
                      <span className="text-xs text-muted/70">
                        {t("providers.customEndpointHint")}
                      </span>
                    </button>
                    {showCustom && (
                      <div className="space-y-2 px-3 pb-3">
                        <div className="flex gap-2">
                          <input
                            value={cName}
                            onChange={(e) => setCName(e.target.value)}
                            placeholder={t("providers.customNamePlaceholder")}
                            className={inputCls("flex-1")}
                          />
                          <select
                            value={cNpm}
                            onChange={(e) => setCNpm(e.target.value)}
                            className={selectCls("w-[190px]")}
                          >
                            <option value="@ai-sdk/openai-compatible">{t("providers.openaiCompatible")}</option>
                            <option value="@ai-sdk/anthropic">{t("providers.anthropicCompatible")}</option>
                          </select>
                        </div>
                        <input
                          value={cUrl}
                          onChange={(e) => setCUrl(e.target.value)}
                          placeholder={t("providers.customUrlPlaceholder")}
                          className={inputCls("w-full font-mono")}
                        />
                        <div className="flex gap-2">
                          <input
                            type="password"
                            value={cKey}
                            onChange={(e) => setCKey(e.target.value)}
                            placeholder={t("providers.customKeyPlaceholder")}
                            className={inputCls("flex-1 font-mono")}
                          />
                          <input
                            value={cModels}
                            onChange={(e) => setCModels(e.target.value)}
                            placeholder={t("providers.customModelsPlaceholder")}
                            className={inputCls("flex-1 font-mono")}
                          />
                        </div>
                        <div className="flex gap-2">
                          <input
                            inputMode="numeric"
                            value={cCtx}
                            onChange={(e) => setCCtx(e.target.value.replace(/[^0-9]/g, ""))}
                            placeholder={t("providers.customContextPlaceholder")}
                            className={inputCls("flex-1 font-mono")}
                          />
                          {isTauri && (
                            <button
                              className={btnGhost()}
                              onClick={() => void fetchCustomModels()}
                              disabled={cDetecting || !cUrl.trim()}
                            >
                              {cDetecting ? t("providers.fetchingModels") : t("providers.fetchModels")}
                            </button>
                          )}
                        </div>
                        {cDetected !== null && (
                          <div className="flex flex-wrap gap-1.5">
                            {cDetected.length === 0 && (
                              <span className="text-xs text-muted">{t("providers.noModelsFound")}</span>
                            )}
                            {cDetected.map((m) => {
                              const selected = modelList(cModels).includes(m.id);
                              return (
                                <button
                                  key={m.id}
                                  onClick={() => toggleDetectedModel(m.id)}
                                  aria-pressed={selected}
                                  className={cn(
                                    "rounded-full border px-2.5 py-1 font-mono text-xs transition-colors",
                                    selected
                                      ? "border-accent bg-accent/10 text-text"
                                      : "border-faint text-muted hover:text-text",
                                  )}
                                >
                                  {m.id}
                                  {m.context ? (
                                    <span className="text-muted"> · {`${Math.round(m.context / 1000)}k`}</span>
                                  ) : null}
                                </button>
                              );
                            })}
                          </div>
                        )}
                        <div className="flex items-center gap-2">
                          <button className={btnAccent()} onClick={() => void saveCustom()} disabled={busy}>
                            {t("providers.addEndpoint")}
                          </button>
                          {/* A shortcut, and deliberately not the first thing in
                              this form: it only fills the fields above, all of
                              which stay editable, and a provider reaches the app
                              the same way whether or not it is listed here. Given
                              the top slot it would read as the way to add an
                              endpoint, which would put the handful of vendors we
                              happen to carry ahead of every other. */}
                          <select
                            aria-label={t("providers.customPresetLabel")}
                            value={cPresetId}
                            onChange={(e) => applyCustomPreset(e.target.value)}
                            className={chipCls("ml-auto pr-1 text-xs text-muted")}
                          >
                            <option value="">{t("providers.customPresetPlaceholder")}</option>
                            {CUSTOM_PROVIDER_PRESETS.map((preset) => (
                              <option key={preset.id} value={preset.id}>
                                {t(preset.labelKey)}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    )}
                  </div>
                  </>
                )}
              </div>

              {isTauri && (
                <button
                  className="flex items-center gap-1.5 border-t border-faint px-3 py-2.5 text-xs text-muted transition-colors hover:text-text"
                  onClick={() => void importLogin()}
                  disabled={busy}
                >
                  <Download size={12} />
                  {t("providers.importLogin")}
                </button>
              )}
            </>
          )}
        </ProviderManagerCard>
        )}

        {/* ---- MCP servers ---- */}
        {section === "connectors" && (
        <Section title={t("mcp.title")} hint={t("mcp.hint")} flush>
          {!connected ? (
            <p className="px-4 py-3 text-[13px] text-muted">{t("mcp.connectPrompt")}</p>
          ) : (
            <div>
              {/* Curated open-source science connectors — one-click enable. */}
              {isTauri &&
                SCIENCE_CONNECTORS.filter((c) => !mcpServers.some((s) => s.name === c.id)).map(
                  (c) => {
                    const keyMissing = Boolean(c.apiKeyEnv) && !connectorKeys[c.id]?.trim();
                    return (
                      <div
                        key={c.id}
                        className="border-b border-faint bg-surface px-3 py-2.5 text-[13px]"
                      >
                        <div className="flex items-center gap-2.5">
                          <Search size={14} className="shrink-0 text-muted" />
                          <div className="min-w-0 flex-1">
                            <span className="font-medium text-text">{c.label}</span>
                            <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted ring-1 ring-border">
                              {c.discipline}
                            </span>
                            <span className="ml-1.5 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted ring-1 ring-border">
                              {t("mcp.openSource")}
                            </span>
                            <div className="truncate text-xs text-muted">{c.description}</div>
                            <div className="truncate font-mono text-[11px] text-muted/70">
                              {c.source}
                              {c.installNote ? ` · ${c.installNote}` : ""}
                            </div>
                          </div>
                          <button
                            className={btnAccent("h-8")}
                            onClick={() => void enableConnector(c.id)}
                            disabled={enablingConnector !== null || busy || keyMissing}
                            title={keyMissing ? t("mcp.enterKeyFirstTitle") : undefined}
                          >
                            {enablingConnector === c.id ? (
                              <>
                                <Loader2 size={12} className="animate-spin" /> {t("mcp.settingUp")}
                              </>
                            ) : (
                              t("mcp.enable")
                            )}
                          </button>
                        </div>
                        {c.apiKeyEnv && (
                          <div className="mt-2 flex items-center gap-2 pl-6">
                            <input
                              type="password"
                              value={connectorKeys[c.id] ?? ""}
                              onChange={(e) =>
                                setConnectorKeys((k) => ({ ...k, [c.id]: e.target.value }))
                              }
                              placeholder={`${c.apiKeyEnv} ${t("mcp.freeKeySuffix")}`}
                              className="h-8 min-w-0 flex-1 rounded-input border border-transparent bg-surface-2 px-2 font-mono text-[12px] text-text outline-none placeholder:text-muted/60 focus:border-accent/55 focus:bg-surface"
                            />
                            {c.apiKeyUrl && (
                              <a
                                href={c.apiKeyUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-accent hover:underline"
                              >
                                <ExternalLink size={11} /> {t("mcp.getFreeKey")}
                              </a>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  },
                )}
              {/* Featured: one-click Jupyter (shown until its MCP entry exists). */}
              {isTauri && !mcpServers.some((s) => s.name === "jupyter") && (
                <div className="flex items-center gap-2.5 border-b border-faint bg-surface px-3 py-2.5 text-[13px]">
                  <NotebookPen size={14} className="shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <span className="font-medium text-text">{t("mcp.jupyterLabel")}</span>
                    <span className="ml-2 text-xs text-muted">
                      {t("mcp.jupyterDescription")}
                    </span>
                  </div>
                  <button
                    className={btnAccent("h-8")}
                    onClick={() => void useSetupStore.getState().enableJupyter()}
                    disabled={jupyterBusy || busy}
                  >
                    {jupyterBusy ? (
                      <>
                        <Loader2 size={12} className="animate-spin" /> {t("mcp.settingUp")}
                      </>
                    ) : jupyter?.installed ? (
                      t("mcp.enable")
                    ) : (
                      t("mcp.setUpAndEnable")
                    )}
                  </button>
                </div>
              )}
              {/* Live uv output while a provisioning run is in flight — a
                  300 MB download must never look like a frozen spinner. */}
              {(jupyterBusy || enablingConnector !== null) && (
                <div className="flex items-center gap-2 border-b border-faint bg-surface-2/50 px-3 py-1.5">
                  <Loader2 size={11} className="shrink-0 animate-spin text-muted" />
                  <span className="truncate font-mono text-[11px] text-muted">
                    {setupLine ?? t("mcp.startingDownload")}
                  </span>
                </div>
              )}
              {mcpServers.map((s, i) => (
                <div
                  key={s.name}
                  className={cn(
                    "flex h-10 items-center gap-2.5 bg-surface px-3 text-[13px]",
                    i > 0 && "border-t border-faint",
                  )}
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      s.status === "connected"
                        ? "bg-ok"
                        : s.status === "failed"
                          ? "bg-error"
                          : "bg-muted",
                    )}
                  />
                  <span className="font-medium text-text">{s.name}</span>
                  <span className="text-xs text-muted">
                    {s.config?.type ?? "?"} · {s.status}
                  </span>
                  <span className="max-w-[260px] flex-1 truncate text-right font-mono text-[11px] text-muted/70">
                    {s.config?.type === "local"
                      ? s.config.command.join(" ")
                      : s.config?.type === "remote"
                        ? s.config.url
                        : ""}
                  </span>
                  <button
                    className="shrink-0 text-xs text-muted transition-colors hover:text-error"
                    onClick={() => void removeMcp(s.name)}
                    disabled={busy}
                  >
                    {t("common:actions.remove")}
                  </button>
                </div>
              ))}

              <div
                className={cn(
                  "space-y-2 p-3",
                  mcpServers.length > 0 && "border-t border-faint",
                )}
              >
                <div className="flex gap-2">
                  <input
                    value={mName}
                    onChange={(e) => setMName(e.target.value)}
                    placeholder={t("mcp.namePlaceholder")}
                    className={inputCls("flex-1")}
                  />
                  <select
                    value={mType}
                    onChange={(e) => setMType(e.target.value as "local" | "remote")}
                    className={selectCls("w-[110px]")}
                  >
                    <option value="local">{t("mcp.typeLocal")}</option>
                    <option value="remote">{t("mcp.typeRemote")}</option>
                  </select>
                </div>
                <div className="flex gap-2">
                  <input
                    value={mTarget}
                    onChange={(e) => setMTarget(e.target.value)}
                    placeholder={
                      mType === "local"
                        ? t("mcp.commandPlaceholder")
                        : t("mcp.urlPlaceholder")
                    }
                    className={inputCls("flex-1 font-mono")}
                  />
                  <button className={btnAccent()} onClick={() => void addMcp()} disabled={busy}>
                    {t("mcp.addServer")}
                  </button>
                </div>
              </div>
            </div>
          )}
        </Section>
        )}

        {/* ---- Browser control (agent-browser) — its own page, reconfigurable ---- */}
        {section === "browser" && (
        <Section title={t("browser.title")} hint={t("browser.hint")} flush>
          {!connected ? (
            <p className="px-4 py-3 text-[13px] text-muted">{t("mcp.connectPrompt")}</p>
          ) : (
            <div className="divide-y divide-faint">
              {/* Browse as — reuse a Chrome login, run isolated, or a separate
                  private (downloaded) browser that never touches Chrome. */}
              <Row
                title={t("browser.browseAs")}
                hint={
                  <>
                    {browserProfile === PRIVATE_BROWSER
                      ? t("browser.privateNote")
                      : browserProfile
                        ? t("browser.reuseNote", {
                            name:
                              browserProfiles.find((p) => p.directory === browserProfile)?.name ??
                              browserProfile,
                          })
                        : t("browser.isolatedNote")}
                    {chrome ? (
                      <span className="mt-1 block">
                        {t("browser.detected")}:{" "}
                        <span className="text-text">
                          {BROWSER_DISPLAY_NAMES[chrome.kind] ?? chrome.kind}
                        </span>
                      </span>
                    ) : (
                      <span className="mt-1 block">{t("browser.noChromeWillDownload")}</span>
                    )}
                  </>
                }
              >
                <div className="mt-2.5 flex items-center gap-2">
                  <select
                    value={browserProfile}
                    onChange={(e) => setBrowserProfile(e.target.value)}
                    aria-label={t("browser.browseAs")}
                    className={selectCls("min-w-0 flex-1")}
                  >
                    {chrome && <option value="">{t("browser.isolated")}</option>}
                    {chrome &&
                      browserProfiles.map((p) => (
                        <option key={p.directory} value={p.directory}>
                          {p.name} · {p.directory}
                        </option>
                      ))}
                    <option value={PRIVATE_BROWSER}>{t("browser.privateBrowser")}</option>
                  </select>
                  {browserProfile === PRIVATE_BROWSER && (
                    <button
                      className={btnGhost("gap-1.5")}
                      onClick={() => void downloadBrowser()}
                      disabled={browserBusy || busy}
                    >
                      <Download size={13} /> {t("browser.download")}
                    </button>
                  )}
                </div>
              </Row>

              {/* Capabilities (tool profile) */}
              <Row title={t("browser.capabilities")}>
                <select
                  value={browserTools}
                  onChange={(e) => setBrowserTools(e.target.value)}
                  aria-label={t("browser.capabilities")}
                  className={selectCls("mt-2.5 w-full")}
                >
                  <option value="core">{t("browser.capCore")}</option>
                  <option value="core,network">{t("browser.capNetwork")}</option>
                  <option value="all">{t("browser.capAll")}</option>
                </select>
              </Row>

              {/* Allowed domains — the safety guardrail */}
              <Row title={t("browser.allowedDomains")} hint={t("browser.allowedDomainsHint")}>
                <textarea
                  value={browserDomains}
                  onChange={(e) => setBrowserDomains(e.target.value)}
                  rows={3}
                  placeholder={t("browser.allowedDomainsPlaceholder")}
                  aria-label={t("browser.allowedDomains")}
                  className="mt-2.5 w-full rounded-input border border-transparent bg-surface-2 px-2.5 py-2 font-mono text-[12px] text-text outline-none placeholder:text-muted/50 focus:border-accent/55 focus:bg-surface"
                />
              </Row>

              {/* Show the window */}
              <Row
                title={t("browser.showWindow")}
                control={
                  <Switch
                    checked={browserHeaded}
                    onChange={setBrowserHeaded}
                    label={t("browser.showWindow")}
                  />
                }
              />

              {/* Status + actions */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 text-xs",
                    browserEnabled ? "text-ok" : "text-muted",
                  )}
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      browserEnabled ? "bg-ok" : "bg-muted",
                    )}
                  />
                  {browserEnabled ? t("browser.enabledStatus") : t("browser.disabledStatus")}
                </span>
                {(browserBusy || busy) && setupLine && (
                  <span className="inline-flex min-w-0 items-center gap-1.5 text-muted">
                    <Loader2 size={11} className="shrink-0 animate-spin" />
                    <span className="truncate font-mono text-[11px]">{setupLine}</span>
                  </span>
                )}
                <div className="flex-1" />
                {browserEnabled && (
                  <button
                    className={btnGhost("hover:text-error")}
                    onClick={() => void disableBrowser()}
                    disabled={busy || browserBusy}
                  >
                    {t("browser.disable")}
                  </button>
                )}
                <button
                  className={btnAccent()}
                  onClick={enableBrowserControl}
                  disabled={browserBusy || busy}
                >
                  {browserBusy ? (
                    <>
                      <Loader2 size={12} className="animate-spin" /> {t("mcp.settingUp")}
                    </>
                  ) : browserEnabled ? (
                    t("browser.apply")
                  ) : (
                    t("mcp.enable")
                  )}
                </button>
              </div>
            </div>
          )}
        </Section>
        )}

        {/* ---- Workspace ---- */}
        {section === "general" && (
        <Section title={t("workspace.title")} hint={t("workspace.hint")}>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 select-all truncate font-mono text-[13px] leading-9 text-muted">
              {wsPath ?? t("workspace.unavailable")}
            </span>
            {wsPath && (
              <>
                <button className={btnGhost("gap-1.5")} onClick={() => void changeWorkspaceBase()}>
                  {t("workspace.change")}
                </button>
                <button className={btnGhost("gap-1.5")} onClick={() => void openWorkspaceBase()}>
                  <FolderOpen size={13} /> {t("workspace.reveal")}
                </button>
              </>
            )}
          </div>
        </Section>
        )}

        {/* ---- Review ---- */}
        {section === "general" && runtimeKind !== "acp" && (
        <Section title={t("review.title")} hint={t("review.hint")} flush>
          <div className="divide-y divide-faint">
            <Row
              title={t("review.autoTitle")}
              hint={t("review.autoHint")}
              control={
                <Switch
                  checked={autoReview}
                  onChange={setAutoReview}
                  label={t("review.autoTitle")}
                />
              }
            />
          </div>
        </Section>
        )}

        {/* ---- Conversation sync across the user's own machines (#124) ---- */}
        {/* Desktop only: it needs a folder on this machine and a local runtime
            to import into, so the gateway web client hides it rather than
            offering a control that cannot work. */}
        {section === "general" && isTauri && runtimeKind !== "acp" && <ConversationSyncCard />}

        {/* ---- Which agent this app drives: OpenCode, or an ACP agent (#14) ---- */}
        {section === "runtime" && <AcpAgentsCard />}

        {/* ---- Local Python kernel ---- */}
        {section === "runtime" && isTauri && (
          <Section title={t("python.title")} hint={t("python.hint")}>
            <div className="flex items-center gap-2 text-[13px]">
              <span
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  pyInfo?.resolved ? "bg-ok" : "bg-error",
                )}
              />
              {pyInfo?.resolved ? (
                <>
                  <span className="min-w-0 flex-1 select-all truncate font-mono text-[12px] text-text">
                    {pyInfo.resolved}
                  </span>
                  <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted ring-1 ring-border">
                    {pyInfo.source === "manual"
                      ? t("python.sourceManual")
                      : pyInfo.source === "jupyter-env"
                        ? t("python.sourceAppManaged")
                        : t("python.sourceAutoDetected")}
                  </span>
                </>
              ) : (
                <span className="min-w-0 flex-1 text-error">
                  {pyInfo?.error ?? t("python.checking")}
                </span>
              )}
            </div>
            <div className="mt-3 flex gap-2">
              <input
                value={pyPath}
                onChange={(e) => setPyPath(e.target.value)}
                placeholder={pyInfo?.configured ?? t("python.pathPlaceholder")}
                className={inputCls("flex-1 font-mono")}
                spellCheck={false}
              />
              <button
                className={btnAccent()}
                onClick={() => void savePythonPath(pyPath.trim())}
                disabled={savingPy || !pyPath.trim()}
              >
                {savingPy ? <Loader2 size={12} className="animate-spin" /> : t("python.useThisPython")}
              </button>
              {pyInfo?.configured && (
                <button
                  className={btnGhost()}
                  onClick={() => void savePythonPath("")}
                  disabled={savingPy}
                >
                  {t("python.clearOverride")}
                </button>
              )}
            </div>
          </Section>
        )}

        {section === "compute" && (
          <>
            <RemoteComputeCard />
            <ModalCard />
          </>
        )}

        {/* ---- Remote access (API gateway: CLI / LAN web / tunnel) ---- */}
        {section === "remote" && (
          <>
            <RemoteAccessCard />
            <TerminalCliCard />
          </>
        )}

        {/* ---- Privacy & data flow ---- */}
        {section === "privacy" && <DataFlowCard model={defaultModel} workspace={wsPath} />}

        {/* ---- Appearance ---- */}
        {section === "appearance" && (
        <Section title={t("appearance.title")} flush>
          <div className="divide-y divide-faint">
            <Row title={t("appearance.themeLabel")}
              control={
                <div className="inline-flex shrink-0 gap-0.5">
                  {/* eslint-disable-next-line i18next/no-literal-string -- internal theme-mode keys, not display text (the visible label is t(`appearance.theme.${mode}`)) */}
                  {(["light", "warm", "dark"] as const).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => setTheme(mode)}
                      className={cn(
                        "rounded-[7px] px-4 py-1.5 text-[13px] transition-colors",
                        theme === mode ? "bg-surface-2 text-text" : "text-muted hover:text-text",
                      )}
                    >
                      {t(`appearance.theme.${mode}`)}
                    </button>
                  ))}
                </div>
              }
            />
            <Row title={t("language.label")}
              control={
                <select
                  value={locale}
                  onChange={(e) => setLocale(e.target.value)}
                  aria-label={t("language.label")}
                  className={chipCls()}
                >
                  {shippedLocales().map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.nativeName}
                    </option>
                  ))}
                </select>
              }
            />
            {/* Zoom is desktop-only: in a browser the browser's own zoom rules. */}
            {isTauri && (
              <Row
                title={t("appearance.zoom.label")}
                hint={t("appearance.zoom.hint", { mod: isMacUA() ? "⌘" : "Ctrl" })}
                control={
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      className={btnGhost("h-8 w-8 justify-center px-0")}
                      onClick={() => zoomBy(-1)}
                      disabled={zoom <= ZOOM_MIN}
                      aria-label={t("appearance.zoom.out")}
                    >
                      <Minus size={13} />
                    </button>
                    <span className="w-11 text-center text-[13px] tabular-nums text-text">
                      {/* eslint-disable-next-line i18next/no-literal-string -- "%" unit glue, not prose */}
                      {Math.round(zoom * 100)}%
                    </span>
                    <button
                      className={btnGhost("h-8 w-8 justify-center px-0")}
                      onClick={() => zoomBy(1)}
                      disabled={zoom >= ZOOM_MAX}
                      aria-label={t("appearance.zoom.in")}
                    >
                      <Plus size={13} />
                    </button>
                    {zoom !== 1 && (
                      <button className={btnGhost("h-8")} onClick={resetZoom}>
                        {t("appearance.zoom.reset")}
                      </button>
                    )}
                  </div>
                }
              />
            )}
          </div>
        </Section>
        )}

        {/* ---- App updates ---- */}
        {section === "general" && (
        <Section title={t("updates.title")} hint={t("updates.hint")} flush>
          <div className="divide-y divide-faint">
            <Row
              title={
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      updateTone === "error" ? "bg-error" : updateTone === "accent" ? "bg-accent" : "bg-ok",
                    )}
                  />
                  {updateLabel}
                </span>
              }
              hint={[
                t("updates.currentVersion", { version: currentVersion }),
                latestUpdate && t("updates.latestVersion", { version: latestUpdate.version }),
                latestUpdate?.publishedAt &&
                  t("updates.publishedAt", {
                    date: new Date(latestUpdate.publishedAt).toLocaleString(locale),
                  }),
                lastCheckedAt &&
                  t("updates.lastChecked", { date: new Date(lastCheckedAt).toLocaleString(locale) }),
              ]
                .filter(Boolean)
                .join(" · ")}
              control={
                <div className="flex shrink-0 flex-wrap justify-end gap-2">
                  <button
                    className={btnGhost("gap-1.5")}
                    onClick={() => void checkForUpdates({ manual: true })}
                    disabled={updateStatus === "checking"}
                  >
                    {updateStatus === "checking" ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <RefreshCw size={13} />
                    )}
                    {t("updates.checkNow")}
                  </button>
                  {latestUpdate?.url && (
                    <button
                      className={btnGhost("gap-1.5")}
                      onClick={() => void openExternal(latestUpdate.url)}
                    >
                      <ExternalLink size={13} /> {t("updates.openRelease")}
                    </button>
                  )}
                  {showUpdateBadge && (
                    <button className={btnGhost()} onClick={dismissUpdateBadge}>
                      {t("updates.hideBadge")}
                    </button>
                  )}
                </div>
              }
            >
              {updateStatus === "error" && updateError && (
                <div className="mt-2 text-xs text-error">
                  {t("updates.checkFailed", { message: updateError })}
                </div>
              )}
            </Row>
            <Row
              title={t("updates.autoCheck")}
              hint={t("updates.autoCheckHint")}
              control={
                <Switch
                  checked={updateEnabled}
                  onChange={setUpdateEnabled}
                  label={t("updates.autoCheck")}
                />
              }
            />
            <Row
              title={t("updates.showBadge")}
              hint={t("updates.showBadgeHint")}
              control={
                <Switch
                  checked={updateBadgeEnabled}
                  onChange={setUpdateBadgeEnabled}
                  label={t("updates.showBadge")}
                />
              }
            />
            <div className="px-4 py-3 text-xs leading-relaxed text-muted">{t("updates.privacy")}</div>
          </div>
        </Section>
        )}
      </div>
    </div>
  );
}

/* ---- Shared bits: one look for every control on this page ---- */


// Hover/disabled states use background + text COLOR, never `opacity`. The CSS
// `opacity` property promotes an element to its own GPU compositing layer; in
// the packaged macOS WKWebView, hovering one such button (an opacity
// transition) forced a recomposite that mis-repainted the neighbouring
// disabled (`opacity-50`) buttons — they visibly flickered. Alpha backgrounds
// (`bg-accent/90`) are a plain paint, so no layer is promoted and nothing
// flickers.
const btnGhost = (extra = "") =>
  cn(
    "flex h-9 shrink-0 items-center gap-1 rounded-input border border-transparent bg-surface-2 px-3.5",
    "text-[13px] text-text transition-colors hover:bg-border/50 disabled:text-muted",
    extra,
  );

const btnAccent = (extra = "") =>
  cn(
    "flex h-9 shrink-0 items-center gap-1.5 rounded-input bg-accent px-3.5 text-[13px] font-medium",
    "text-accent-fg transition-colors hover:bg-accent/90 disabled:bg-accent/50",
    extra,
  );
