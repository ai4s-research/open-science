import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  Download,
  ExternalLink,
  FolderOpen,
  Loader2,
  NotebookPen,
  RefreshCw,
  Search,
} from "lucide-react";
import type {
  McpServer,
  OAuthAuthorization,
  ProviderAuthMethod,
  ProviderCatalogEntry,
  ProviderInfo,
} from "@ai4s/sdk";
import { useTranslation } from "react-i18next";
import { useUiStore } from "@/lib/store";
import { shippedLocales } from "@/i18n/config";
import { getClient, useRuntimeStore } from "@/lib/runtime";
import { useUpdateStore } from "@/lib/update";
import {
  importOpenCodeLogin,
  isTauri,
  jupyterStatus,
  openExternal,
  openWorkspaceBase,
  pickFolder,
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
} from "@/lib/tauri";
import { useSetupStore } from "@/lib/setup";
import { RemoteComputeCard } from "@/components/settings/RemoteComputeCard";
import { ModalCard } from "@/components/settings/ModalCard";
import { DataFlowCard } from "@/components/settings/DataFlowCard";
import { ModelBrowser } from "@/components/settings/ModelBrowser";
import { ProviderManagerCard } from "@/components/settings/ProviderManagerCard";
import { SCIENCE_CONNECTORS } from "@/lib/scienceConnectors";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";

/**
 * Settings. ONE configuration surface: everything talks to the bundled
 * OpenCode's own config/auth API — no separate "model key" concept.
 */
export function SettingsPage() {
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const locale = useUiStore((s) => s.locale);
  const setLocale = useUiStore((s) => s.setLocale);
  const { t } = useTranslation(["settings", "common"]);
  // Select each field individually. A bare `useRuntimeStore()` subscribed to the
  // WHOLE store, so every unrelated mutation (session events, streaming, idle
  // checks) re-rendered this page — in the packaged WKWebView that repaint storm
  // made the native <select>/<input>/<button> controls flicker and blank out on
  // scroll. These are the only fields the page actually reads.
  const status = useRuntimeStore((s) => s.status);
  const serverUrl = useRuntimeStore((s) => s.serverUrl);
  const setServerUrl = useRuntimeStore((s) => s.setServerUrl);
  const connect = useRuntimeStore((s) => s.connect);
  const disconnect = useRuntimeStore((s) => s.disconnect);
  const defaultModel = useRuntimeStore((s) => s.defaultModel);
  const loadCatalog = useRuntimeStore((s) => s.loadCatalog);
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
  const setupLine = useSetupStore((s) => s.line);
  const setupGeneration = useSetupStore((s) => s.generation);

  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [authMethods, setAuthMethods] = useState<Record<string, ProviderAuthMethod[]>>({});
  const [catalog, setCatalog] = useState<ProviderCatalogEntry[]>([]);
  const [customIds, setCustomIds] = useState<string[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [jupyter, setJupyter] = useState<JupyterStatus | null>(null);
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

  // Custom endpoint form (self-hosted / Ollama / OpenAI- or Anthropic-compatible).
  const [showCustom, setShowCustom] = useState(false);
  const [cName, setCName] = useState("");
  const [cNpm, setCNpm] = useState("@ai-sdk/openai-compatible");
  const [cUrl, setCUrl] = useState("");
  const [cKey, setCKey] = useState("");
  const [cModels, setCModels] = useState("");

  // Connect-a-provider flow state.
  const [providerManagerOpen, setProviderManagerOpen] = useState(false);
  const [connectQuery, setConnectQuery] = useState("");
  const [keyInput, setKeyInput] = useState("");
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

  const refresh = useCallback(async () => {
    const client = getClient();
    if (!client) return;
    try {
      const [p, m, c, custom, mcp] = await Promise.all([
        client.listProviders(),
        client.listAuthMethods(),
        client.listProviderCatalog(),
        client.listCustomProviderIds(),
        client.listMcpServers().catch(() => []),
      ]);
      setProviders(p);
      setAuthMethods(m);
      setCatalog(c.all);
      setCustomIds(custom);
      setMcpServers(mcp);
      setJupyter(await jupyterStatus());
    } catch {
      /* runtime not ready yet */
    }
  }, []);

  // Re-refresh when a provisioning run finishes (setupGeneration bumps) so a
  // newly-enabled MCP shows up even if setup completed while this page was
  // closed — the flow itself lives in the setup store.
  useEffect(() => {
    if (connected) void refresh();
  }, [connected, refresh, setupGeneration]);
  useEffect(() => {
    // The BASE folder — the parent every session's dated subfolder is created
    // under. (The per-session active folder shows in the conversation header.)
    void workspaceBase().then(setWsPath);
  }, []);
  const refreshPython = useCallback(() => {
    void pythonInterpreter().then(setPyInfo);
  }, []);
  // Also on setupGeneration: a fresh jupyter-env may now back the local kernel.
  useEffect(refreshPython, [refreshPython, setupGeneration]);

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

  // The one post-change sequence — run() and the background OAuth wait must
  // stay in lockstep, so they share it instead of each keeping a copy.
  const refreshAll = async () => {
    await refresh();
    await loadCatalog();
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
    setBusy(true);
    try {
      await useRuntimeStore.getState().setDefaultModel(model);
      toast.success(t("toast.defaultModelSet", { model }));
      return true;
    } catch (error) {
      toast.error(`${t("toast.couldNotSetModel")}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveKey = (providerID: string) =>
    run(t("toast.couldNotSaveKey"), async () => {
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
    // The callback POST hangs open until the browser redirect lands, but the
    // webview's native fetch enforces its own idle timeout (~60s in WKWebView)
    // — far shorter than the provider's login window, and a slow browser login
    // (2FA, consent) used to surface as "login did not complete" even though
    // the browser then finished successfully. A network-level drop is NOT a
    // failed login: the server keeps the pending attempt and a re-POST resumes
    // waiting on it (opencode's ProviderAuth.callback re-invokes the stored
    // pending closure; it is never consumed). Retry those; HTTP errors are the
    // provider's real verdict and stay terminal.
    const deadline = Date.now() + OAUTH_WAIT_MS;
    let lastError: unknown = new Error("Timed out waiting for the browser login");
    while (Date.now() < deadline) {
      const abort = new AbortController();
      oauthAbort.current = abort;
      try {
        await getClient()!.oauthCallback(providerID, methodIndex, undefined, abort.signal);
        if (gen !== oauthGen.current) {
          // Cancelled in the UI, but the login DID complete — refresh silently
          // so the now-connected provider still shows up in the list.
          await refreshAll();
          return;
        }
        setOauth(null);
        toast.success(t("toast.providerConnected", { providerID }));
        await refreshAll();
        return;
      } catch (e) {
        if (gen !== oauthGen.current) return; // cancelled — the abort is expected
        // Webview fetch failures (idle timeout, transient drop) are TypeError;
        // apiError() throws plain Error for the server's HTTP verdicts.
        if (e instanceof TypeError) {
          lastError = e;
          await new Promise((r) => setTimeout(r, 500));
          if (gen !== oauthGen.current) return;
          continue;
        }
        setOauth(null);
        toast.error(`${t("toast.loginDidNotComplete")}: ${e instanceof Error ? e.message : String(e)}`);
        return;
      } finally {
        if (oauthAbort.current === abort) oauthAbort.current = null;
      }
    }
    // The login window closed without a verdict from the server.
    setOauth(null);
    toast.error(
      `${t("toast.loginDidNotComplete")}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
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
      if (customIds.includes(providerID)) {
        // Custom endpoints live in the config file; removal restarts the sidecar.
        await removeConfigEntry("provider", providerID);
        await useRuntimeStore.getState().connectRetry();
      } else {
        await getClient()!.removeProviderAuth(providerID);
      }
      toast.success(t("toast.providerRemoved", { providerID }));
    });

  const saveCustom = () =>
    run(t("toast.couldNotAddEndpoint"), async () => {
      const id = cName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const models = cModels.split(",").map((s) => s.trim()).filter(Boolean);
      if (!id || !cUrl.trim() || models.length === 0) {
        toast.error(t("toast.endpointFieldsRequired"));
        return;
      }
      await getClient()!.addCustomProvider(id, {
        name: cName.trim(),
        npm: cNpm,
        baseURL: cUrl.trim(),
        apiKey: cKey.trim() || undefined,
        models,
      });
      toast.success(t("toast.endpointAdded", { name: cName.trim() }));
      setShowCustom(false);
      setCName("");
      setCUrl("");
      setCKey("");
      setCModels("");
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

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-8 pb-16 pt-8">
        <h1 className="font-serif text-xl text-text">{t("page.title")}</h1>
        <p className="mt-0.5 text-xs text-muted">{t("page.subtitle")}</p>

        {/* ---- Agent runtime ---- */}
        <Card title={t("runtime.title")} hint={t("runtime.hint")}>
          <div className="flex items-center gap-2">
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
          <div className="mt-2.5 flex items-center gap-1.5 text-xs text-muted">
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
          </div>

          {/* Network proxy: follow system / custom / direct. system and none
              apply on select; custom applies on Save (needs a URL first). */}
          {isTauri && proxy && (
            <div className="mt-3 border-t border-border pt-3">
              <div className="flex items-center gap-2">
                <span className="w-28 shrink-0 text-xs text-muted">{t("runtime.proxyLabel")}</span>
                <select
                  value={proxy.mode}
                  onChange={(e) => changeProxyMode(e.target.value as ProxyMode)}
                  disabled={busy}
                  className={cn(inputCls("w-44"), "cursor-pointer")}
                >
                  <option value="system">{t("runtime.proxySystem")}</option>
                  <option value="custom">{t("runtime.proxyCustom")}</option>
                  <option value="none">{t("runtime.proxyNone")}</option>
                </select>
                {proxy.mode === "custom" && (
                  <>
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
                  </>
                )}
              </div>
              <p className="mt-1.5 pl-28 text-[11px] leading-relaxed text-muted">
                {proxy.mode === "none"
                  ? t("runtime.proxyDirectHint")
                  : proxy.effective
                    ? t("runtime.proxyEffective", { url: proxy.effective })
                    : t("runtime.proxyNoneDetected")}
              </p>
            </div>
          )}
        </Card>

        {/* ---- Models ---- */}
        <Card title={t("model.title")} hint={t("model.hint")}>
          {!connected ? (
            <p className="text-[13px] text-muted">{t("model.connectPrompt")}</p>
          ) : (
            <ModelBrowser
              providers={providers}
              defaultModel={defaultModel}
              busy={busy}
              onSelect={saveModel}
              onManageProviders={() => setProviderManagerOpen(true)}
            />
          )}
        </Card>

        {/* ---- Providers ---- */}
        <ProviderManagerCard
          providers={providers}
          expanded={providerManagerOpen}
          disabled={!connected || busy}
          onExpandedChange={setProviderManagerOpen}
        >
          {connected && (
            <>
              <div className="overflow-hidden rounded-input border border-border">
                {providers.map((p, i) => (
                  <div
                    key={p.id}
                    className={cn(
                      "flex h-10 items-center gap-2.5 bg-surface px-3 text-[13px]",
                      i > 0 && "border-t border-border",
                    )}
                  >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok" />
                    <span className="font-medium text-text">{p.name}</span>
                    <span className="text-xs text-muted">
                      {t("providers.modelCount", { count: p.models.length })}
                    </span>
                    <div className="flex-1" />
                    {p.id === "opencode" ? (
                      <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted ring-1 ring-border">
                        {t("providers.builtInFree")}
                      </span>
                    ) : (
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

                {/* Connect a provider */}
                <div className="border-t border-border bg-surface-2/50 p-3">
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
                                  className={inputCls("w-full")}
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
                          disabled={busy || !keyInput.trim()}
                        >
                          <Check size={13} /> {t("common:actions.save")}
                        </button>
                      </div>
                    </div>
                  )}

                  {oauth && (
                    <div className="mt-2 space-y-2 rounded-input border border-border bg-surface p-3">
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
                <div className="border-t border-border">
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
                          className={inputCls("w-[190px]")}
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
                      <button className={btnAccent()} onClick={() => void saveCustom()} disabled={busy}>
                        {t("providers.addEndpoint")}
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {isTauri && (
                <button
                  className="mt-3 flex items-center gap-1.5 text-xs text-muted transition-colors hover:text-text"
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

        {/* ---- MCP servers ---- */}
        <Card title={t("mcp.title")} hint={t("mcp.hint")}>
          {!connected ? (
            <p className="text-[13px] text-muted">{t("mcp.connectPrompt")}</p>
          ) : (
            <div className="overflow-hidden rounded-input border border-border">
              {/* Curated open-source science connectors — one-click enable. */}
              {isTauri &&
                SCIENCE_CONNECTORS.filter((c) => !mcpServers.some((s) => s.name === c.id)).map(
                  (c) => {
                    const keyMissing = Boolean(c.apiKeyEnv) && !connectorKeys[c.id]?.trim();
                    return (
                      <div
                        key={c.id}
                        className="border-b border-border bg-surface px-3 py-2.5 text-[13px]"
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
                              className="h-8 min-w-0 flex-1 rounded-input border border-border bg-surface-2 px-2 font-mono text-[12px] text-text placeholder:text-muted/60"
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
                <div className="flex items-center gap-2.5 border-b border-border bg-surface px-3 py-2.5 text-[13px]">
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
                <div className="flex items-center gap-2 border-b border-border bg-surface-2/50 px-3 py-1.5">
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
                    i > 0 && "border-t border-border",
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
                  "space-y-2 bg-surface-2/50 p-3",
                  mcpServers.length > 0 && "border-t border-border",
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
                    className={inputCls("w-[110px]")}
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
        </Card>

        {/* ---- Workspace ---- */}
        <Card title={t("workspace.title")} hint={t("workspace.hint")}>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                inputCls("flex-1 truncate font-mono leading-9"),
                "select-all bg-surface-2 text-muted",
              )}
            >
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
        </Card>

        {/* ---- Local Python kernel ---- */}
        {isTauri && (
          <Card title={t("python.title")} hint={t("python.hint")}>
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
          </Card>
        )}

        <RemoteComputeCard />

        <ModalCard />

        {/* ---- Privacy & data flow ---- */}
        <DataFlowCard model={defaultModel} workspace={wsPath} />

        {/* ---- Appearance ---- */}
        <Card title={t("appearance.title")}>
          <div className="inline-flex rounded-input border border-border bg-surface-2 p-0.5">
            {/* eslint-disable-next-line i18next/no-literal-string -- internal theme-mode keys, not display text (the visible label is t(`appearance.theme.${mode}`)) */}
            {(["light", "dark"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setTheme(mode)}
                className={cn(
                  "rounded-[5px] px-4 py-1.5 text-[13px] transition-colors",
                  theme === mode ? "bg-surface text-text shadow-card" : "text-muted hover:text-text",
                )}
              >
                {t(`appearance.theme.${mode}`)}
              </button>
            ))}
          </div>
          <div className="mt-4">
            <div className="mb-2 text-xs font-medium text-muted">{t("language.label")}</div>
            <div
              role="group"
              aria-label={t("language.label")}
              className="grid grid-cols-2 gap-1.5 sm:grid-cols-4"
            >
              {shippedLocales().map((l) => {
                const active = locale === l.code;
                return (
                  <button
                    key={l.code}
                    onClick={() => setLocale(l.code)}
                    className={cn(
                      "rounded-input border px-2.5 py-2 text-left text-[13px] transition-colors",
                      active
                        ? "border-accent bg-accent/10 text-text shadow-sm"
                        : "border-border bg-surface text-muted hover:bg-surface-2 hover:text-text",
                    )}
                    aria-pressed={active}
                  >
                    <span className="block truncate font-medium">{l.nativeName}</span>
                    <span className="block truncate text-[10.5px] text-muted">{l.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </Card>

        {/* ---- App updates ---- */}
        <Card title={t("updates.title")} hint={t("updates.hint")}>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1",
                updateTone === "error"
                  ? "bg-error/10 text-error ring-error/20"
                  : updateTone === "accent"
                    ? "bg-accent/10 text-accent ring-accent/20"
                    : "bg-ok/10 text-ok ring-ok/20",
              )}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  updateTone === "error" ? "bg-error" : updateTone === "accent" ? "bg-accent" : "bg-ok",
                )}
              />
              {updateLabel}
            </span>
            <span className="text-xs text-muted">
              {t("updates.currentVersion", { version: currentVersion })}
            </span>
            {latestUpdate && (
              <span className="text-xs text-muted">
                {t("updates.latestVersion", { version: latestUpdate.version })}
              </span>
            )}
          </div>

          {latestUpdate?.publishedAt && (
            <div className="mt-2 text-xs text-muted">
              {t("updates.publishedAt", {
                date: new Date(latestUpdate.publishedAt).toLocaleString(locale),
              })}
            </div>
          )}
          {lastCheckedAt && (
            <div className="mt-1 text-xs text-muted">
              {t("updates.lastChecked", { date: new Date(lastCheckedAt).toLocaleString(locale) })}
            </div>
          )}
          {updateStatus === "error" && updateError && (
            <div className="mt-2 text-xs text-error">
              {t("updates.checkFailed", { message: updateError })}
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className={btnAccent("gap-1.5")}
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

          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <label className="flex items-start gap-2 rounded-input border border-border bg-surface-2 px-3 py-2">
              <input
                type="checkbox"
                checked={updateEnabled}
                onChange={(e) => setUpdateEnabled(e.target.checked)}
                className="mt-0.5 accent-[var(--color-accent)]"
              />
              <span>
                <span className="block text-[13px] font-medium text-text">{t("updates.autoCheck")}</span>
                <span className="block text-xs leading-relaxed text-muted">{t("updates.autoCheckHint")}</span>
              </span>
            </label>
            <label className="flex items-start gap-2 rounded-input border border-border bg-surface-2 px-3 py-2">
              <input
                type="checkbox"
                checked={updateBadgeEnabled}
                onChange={(e) => setUpdateBadgeEnabled(e.target.checked)}
                className="mt-0.5 accent-[var(--color-accent)]"
              />
              <span>
                <span className="block text-[13px] font-medium text-text">{t("updates.showBadge")}</span>
                <span className="block text-xs leading-relaxed text-muted">{t("updates.showBadgeHint")}</span>
              </span>
            </label>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted">{t("updates.privacy")}</p>
        </Card>
      </div>
    </div>
  );
}

/* ---- Shared bits: one look for every control on this page ---- */

const inputCls = (extra = "") =>
  cn(
    "h-9 rounded-input border border-border bg-surface px-3 text-[13px] text-text outline-none",
    "placeholder:text-muted focus:border-accent/60",
    extra,
  );

// Hover/disabled states use background + text COLOR, never `opacity`. The CSS
// `opacity` property promotes an element to its own GPU compositing layer; in
// the packaged macOS WKWebView, hovering one such button (an opacity
// transition) forced a recomposite that mis-repainted the neighbouring
// disabled (`opacity-50`) buttons — they visibly flickered. Alpha backgrounds
// (`bg-accent/90`) are a plain paint, so no layer is promoted and nothing
// flickers.
const btnGhost = (extra = "") =>
  cn(
    "flex h-9 shrink-0 items-center gap-1 rounded-input border border-border bg-surface px-3.5",
    "text-[13px] text-text transition-colors hover:bg-surface-2 disabled:text-muted",
    extra,
  );

const btnAccent = (extra = "") =>
  cn(
    "flex h-9 shrink-0 items-center gap-1.5 rounded-input bg-accent px-3.5 text-[13px] font-medium",
    "text-accent-fg transition-colors hover:bg-accent/90 disabled:bg-accent/50",
    extra,
  );

function Card({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-5 rounded-card border border-border bg-surface shadow-card">
      <header className="border-b border-border px-5 py-3">
        <h2 className="font-serif text-[15px] text-text">{title}</h2>
        {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}
