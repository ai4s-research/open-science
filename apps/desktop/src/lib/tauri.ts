// Thin bridge to the Tauri Rust side. In a plain browser these are no-ops so the
// app still runs in `pnpm dev`; in the packaged desktop app they invoke Rust commands.

import { isGatewayWeb, gatewayGet, gatewayPost } from "./webMode";

export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface OpenCodeCredentials {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export type ConfigureResult =
  | { ok: true; path: string }
  | { ok: false; reason: "not-desktop" }
  | { ok: false; reason: "error"; message: string };

/** Start the bundled OpenCode sidecar (desktop only). Returns its base URL.
 *  Reuses a runtime it believes is running — see restartRuntime for when that
 *  belief is wrong. */
export async function startRuntime(): Promise<string | null> {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("start_runtime");
}

/** Epoch ms the current sidecar started, 0 when none is running. Used to tell
 *  a turn that is streaming now from one left half-written by a runtime that
 *  has since died — see `turnStillStreaming`. */
export async function runtimeStartedAt(): Promise<number> {
  if (!isTauri) return 0;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<number>("runtime_started_at");
}

/** Kill whatever sidecar is there and spawn a fresh one on a new port. For the
 *  case startRuntime cannot fix: the process is alive but has stopped serving,
 *  so nothing terminates, nothing clears the lifecycle, and reconnecting dials
 *  a port that will never answer. Returns the new base URL. */
export async function restartRuntime(): Promise<string | null> {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("restart_runtime");
}

/** A sidecar that exited, with its own last words. `exits` counts every one
 *  since the app started: a runtime that is slow to listen has none, one that
 *  refuses to start has a new one per attempt (#118). */
export async function runtimeFailure(): Promise<{ exits: number; message: string } | null> {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<{ exits: number; message: string } | null>("runtime_failure");
}

/** The config that was moved aside because neither side could read it, once.
 *  Reading it clears it — the user is told when it happens, not every launch. */
export async function takeConfigQuarantineNotice(): Promise<string | null> {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("take_config_quarantine_notice");
}

/**
 * Per-run password the sidecar requires on every request (desktop only —
 * browser dev talks to a user-run, passwordless `opencode serve`). Held in
 * memory on both sides; never persisted.
 */
export async function runtimePassword(): Promise<string | null> {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("runtime_password");
}

export interface ProbedModel {
  id: string;
  /** Context window in tokens, when the endpoint reports one. */
  context?: number | null;
}

/**
 * Ask a custom endpoint which models it serves, with context windows where
 * the server reports them (desktop only — the probe runs in Rust because
 * local model servers rarely send CORS headers). `kind` is "openai" or
 * "anthropic", matching the form's compatibility select.
 */
export async function probeEndpointModels(
  baseUrl: string,
  apiKey: string | undefined,
  kind: "openai" | "anthropic",
): Promise<ProbedModel[]> {
  if (!isTauri) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ProbedModel[]>("probe_endpoint_models", { baseUrl, apiKey, kind });
}

/**
 * Model ids OpenCode Zen actually serves right now (desktop only — opencode.ai
 * sends no CORS headers, so the request runs in Rust). Throws when the list
 * cannot be fetched; callers must fail open rather than hide every model.
 */
export async function zenServedModelIds(): Promise<string[]> {
  if (!isTauri) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string[]>("zen_models");
}

/**
 * Pick local files via the native dialog and copy them into the agent
 * workspace (desktop only). Returns the workspace file names; [] on cancel.
 */
export async function addFilesToWorkspace(): Promise<string[]> {
  if (!isTauri) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string[]>("add_files_to_workspace");
}

/**
 * Write text into the workspace as a file (desktop only), deduplicating the
 * name on collision. Returns the actual file name written.
 */
export async function addTextToWorkspace(filename: string, content: string): Promise<string> {
  if (!isTauri) throw new Error("not running in the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("add_text_to_workspace", { filename, content });
}

/** Write binary content (base64) into the workspace as `filename` (deduplicated).
 *  Used for pasted images. Returns the actual name written. */
export async function addBinaryToWorkspace(filename: string, base64: string): Promise<string> {
  if (!isTauri) throw new Error("not running in the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("add_binary_to_workspace", { filename, base64 });
}

/** Copy explicit local file paths into the workspace (deduplicated). Used by
 *  drag-and-drop. Returns the names written. */
export async function addPathsToWorkspace(paths: string[]): Promise<string[]> {
  if (!isTauri) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string[]>("add_paths_to_workspace", { paths });
}

/**
 * Explicitly import the user's OpenCode CLI login into the app's private
 * runtime (desktop only). Returns false when no CLI login exists; the sidecar
 * is restarted on success.
 */
export async function importOpenCodeLogin(): Promise<boolean> {
  if (!isTauri) return false;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("import_opencode_login");
}

/** How agent actions get approved — the composer's Codex-style switch.
 *  "approve": dangerous shell commands (delete / install / remote / privilege)
 *  and web fetches prompt first, as does any path outside the workspace except
 *  the OS temp dirs. "full": nothing prompts, paths outside the workspace
 *  included. */
export type ApprovalMode = "approve" | "full";

/** The approval mode OpenCode's config currently holds ("approve" until changed). */
export async function getApprovalMode(): Promise<ApprovalMode> {
  if (!isTauri) return "approve";
  const { invoke } = await import("@tauri-apps/api/core");
  const mode = await invoke<string>("get_approval_mode");
  return mode === "full" ? "full" : "approve";
}

/** Switch the approval mode; the sidecar restarts — the caller must reconnect. */
export async function setApprovalMode(mode: ApprovalMode): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_approval_mode", { mode });
}

/** Write one exported conversation into a folder the user picked. Returns the
 *  file that was actually written — the name is derived from the title and
 *  de-duplicated, so nothing is silently overwritten. */
export async function writeExportFile(
  directory: string,
  name: string,
  contents: string,
): Promise<string> {
  if (!isTauri) throw new Error("Exporting needs the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("write_export_file", { directory, name, contents });
}

/** The two memory layers. "global" is one Markdown file the runtime loads into
 *  every conversation; "project" is that folder's own AGENTS.md, loaded only
 *  for sessions working inside it. Session-only context is the conversation
 *  itself — it needs no file. */
export type MemoryScope = "global" | "project";

/** A memory layer's text; "" when it was never written. */
export async function readMemory(
  scope: MemoryScope,
  directory?: string | null,
): Promise<string> {
  if (!isTauri) return "";
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("read_memory", { scope, directory: directory ?? null });
}

/** Replace a memory layer. Saving an empty document clears it. */
export async function writeMemory(
  scope: MemoryScope,
  directory: string | null,
  text: string,
): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("write_memory", { scope, directory, text });
}

/** Add a block to a memory layer, keeping what is already there. */
export async function appendMemory(
  scope: MemoryScope,
  directory: string | null,
  text: string,
): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("append_memory", { scope, directory, text });
}

/** Whether memory is applied to conversations at all. */
export async function getMemoryEnabled(): Promise<boolean> {
  if (!isTauri) return false;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("get_memory_enabled");
}

/** Apply / stop applying memory; the sidecar restarts, so the caller reconnects. */
export async function setMemoryEnabled(enabled: boolean): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_memory_enabled", { enabled });
}

/** Per-agent model overrides, `{ agent: "provider/model" }`. Agents that are
 *  absent follow the default model. */
export async function getAgentModels(): Promise<Record<string, string>> {
  if (!isTauri) return {};
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<Record<string, string>>("get_agent_models");
}

/** Pin one agent to a model, or pass "" to clear the override. Restarts the
 *  sidecar — agents are built when it loads its config. */
export async function setAgentModel(agent: string, model: string): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_agent_model", { agent, model });
}

/** Per-agent reasoning-effort overrides, `{ agent: "high" }`. Agents that are
 *  absent run their model's default effort (#71). */
export async function getAgentVariants(): Promise<Record<string, string>> {
  if (!isTauri) return {};
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<Record<string, string>>("get_agent_variants");
}

/** Pin one agent to a reasoning-effort variant, or pass "" to clear it. */
export async function setAgentVariant(agent: string, variant: string): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_agent_variant", { agent, variant });
}

/** Network proxy for the sidecar: follow the OS, a fixed URL, or direct. */
export type ProxyMode = "system" | "custom" | "none";
export interface ProxySetting {
  mode: ProxyMode;
  /** The custom URL (empty unless mode is "custom"). */
  url: string;
  /** The proxy the sidecar would use right now; null ⇒ direct. */
  effective: string | null;
}

/** The persisted proxy setting (desktop only; null in browser). */
export async function getProxySetting(): Promise<ProxySetting | null> {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<ProxySetting>("get_proxy_setting");
}

/** Persist the proxy setting; the sidecar restarts — the caller must reconnect. */
export async function setProxySetting(mode: ProxyMode, url: string): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_proxy_setting", { mode, url });
}

/** Remote Access gateway — one authenticated API for CLI / LAN web / tunnel.
 *  See docs/rfc/remote-access-gateway.md. */
export type GatewayMode = "full" | "read-only";
export interface GatewayStatus {
  enabled: boolean;
  /** false = loopback only (127.0.0.1); true = bound to the LAN (0.0.0.0). */
  lan: boolean;
  mode: GatewayMode;
  running: boolean;
  port: number | null;
  /** User-configured port; null means use the default (4098). */
  configuredPort: number | null;
  loopbackUrl: string | null;
  /** The LAN URL (with the detected local IP) when `lan` is on and reachable. */
  lanUrl: string | null;
  /** The bearer token clients authenticate with (blank until first enabled). */
  token: string;
}

/** Current gateway status (desktop only; null in browser). */
export async function getGatewayStatus(): Promise<GatewayStatus | null> {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<GatewayStatus>("gateway_status");
}

/** Absolute path of the bundled ACP agent script an external editor spawns
 *  (#14, server direction), or null when it is not present. */
export async function acpServerScript(): Promise<string | null> {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<string | null>("acp_server_script");
}

/** How `osd` became reachable from a terminal — see `cli_shim.rs`. */
export type CliPathRoute = "already-on-path" | "shell-profile" | "user-environment" | "unreachable";

/** Where the bundled `osd` command is, and what was touched to make a terminal
 *  find it. The app arranges this on launch; the UI only reports it. */
export interface CliShimStatus {
  /** The bundled `osd` beside the app binary, or null in a build without it. */
  binary: string | null;
  /** The wrapper's path, whether or not it is there yet. */
  shim: string;
  installed: boolean;
  /** A file that is not ours already has that name. */
  occupied: boolean;
  route: CliPathRoute;
  /** The profile file that was extended, when that is how PATH was arranged. */
  profile: string | null;
  /** Shown only when nothing automatic worked: the line to add by hand. */
  pathHint: string | null;
}

/** Current state of the `osd` command (desktop only; null in browser). */
export async function getCliShimStatus(): Promise<CliShimStatus | null> {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<CliShimStatus>("cli_shim_status");
}

/** Redo the install — for an app that moved, or a launch that failed. */
export async function installCliShim(): Promise<CliShimStatus | null> {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<CliShimStatus>("install_cli_shim");
}

/** Enable/disable + set binding and access mode; (re)binds the server. */
export async function setGatewayConfig(
  enabled: boolean,
  lan: boolean,
  mode: GatewayMode,
  port?: number | null,
): Promise<GatewayStatus | null> {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<GatewayStatus>("set_gateway_config", { enabled, lan, mode, port: port ?? null });
}

/** Rotate the bearer token (old clients must re-enter the new one). */
export async function regenerateGatewayToken(): Promise<GatewayStatus | null> {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<GatewayStatus>("regenerate_gateway_token");
}

/** uv download mirrors used only when provisioning Python tools (empty ⇒ default). */
export interface MirrorSetting {
  /** PyPI index URL (UV_DEFAULT_INDEX). */
  pypi: string;
  /** Python-download mirror (UV_PYTHON_INSTALL_MIRROR). */
  python: string;
}

/** The persisted uv mirrors (desktop only; null in browser). */
export async function getMirrorSetting(): Promise<MirrorSetting | null> {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<MirrorSetting>("get_mirror_setting");
}

/** Persist the uv mirrors; blank fields clear. No sidecar restart. */
export async function setMirrorSetting(pypi: string, python: string): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_mirror_setting", { pypi, python });
}

/** Whether the bundled runtime's credential store has an entry for this
 *  provider — ground truth that a browser login landed even when its OAuth
 *  callback was lost. False in browser dev (and on any read failure). */
export async function providerAuthExists(providerID: string): Promise<boolean> {
  if (!isTauri) return false;
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<boolean>("provider_auth_exists", { providerId: providerID });
  } catch {
    return false;
  }
}

/** Per-session goal-mode state, as the bundled goal plugin records it.
 *  Passed through verbatim from goals.json — the plugin owns the schema. */
export interface GoalState {
  objective: string;
  /** The plugin's status enum (its schema owns the literals). */
  status: "active" | "paused" | "budgetLimited" | "usageLimited" | "complete" | "unmet" | string;
  autoTurns?: number | null;
  blocker?: string | null;
  completionEvidence?: string | null;
  lastStatus?: string | null;
}

/** The session's current goal (null when none / in browser dev). Reads the
 *  plugin's state file directly — a status pill must not cost a model turn. */
export async function goalState(sessionId: string): Promise<GoalState | null> {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<GoalState | null>("goal_state", { sessionId });
  } catch {
    return null;
  }
}

/** Pause / resume / clear the session's goal from the UI (no model turn).
 *  Continuation only fires while status is "active", so pause stops the loop
 *  at the next idle. Returns the new state (null after clear). */
export async function goalUpdate(
  sessionId: string,
  action: "pause" | "resume" | "clear",
): Promise<GoalState | null> {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<GoalState | null>("goal_update", { sessionId, action });
}

/** Remove a provider/mcp entry from the global OpenCode config (restarts the sidecar). */
export async function removeConfigEntry(section: "provider" | "mcp", key: string): Promise<void> {
  if (!isTauri) throw new Error("not running in the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("remove_config_entry", { section, key });
}

export interface JupyterStatus {
  installed: boolean;
  running: boolean;
  url: string | null;
  token: string | null;
  mcp_command: string | null;
}

/** State of the app-managed Jupyter environment (desktop only). */
export async function jupyterStatus(): Promise<JupyterStatus | null> {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<JupyterStatus>("jupyter_status");
}

/** Provision the isolated Jupyter env via bundled uv (first run: minutes, ~hundreds of MB). */
export async function setupJupyter(): Promise<void> {
  if (!isTauri) throw new Error("not running in the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("setup_jupyter");
}

/** Start the managed headless jupyter-lab (idempotent). */
export async function startJupyter(): Promise<JupyterStatus> {
  if (!isTauri) throw new Error("not running in the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<JupyterStatus>("start_jupyter");
}

/** Open the app-managed JupyterLab in the system browser, starting the server
 *  if needed. Returns false when Jupyter has not been set up yet (the caller
 *  should point the user at Settings). Same env the agent drives, same files.
 *
 *  `notebook` is a path RELATIVE TO THE LAB ROOT (the active workspace) — pass
 *  it to open that file directly (`/lab/tree/<path>`); omit to land on the lab
 *  home. Only pass a path you know is under the workspace root. */
export async function openJupyterLab(notebook?: string): Promise<boolean> {
  if (!isTauri) return false;
  const st = await jupyterStatus();
  if (!st?.installed) return false;
  const s = await startJupyter(); // idempotent; yields the fixed url + token
  if (!s.url || !s.token) return false;
  const rel = notebook?.trim().replace(/^\/+/, "");
  // Encode each segment but keep the "/" separators so nested paths resolve.
  const tree = rel ? "/tree/" + rel.split("/").map(encodeURIComponent).join("/") : "";
  await openExternal(`${s.url}/lab${tree}?token=${encodeURIComponent(s.token)}`);
  return true;
}

/** The interpreter local Python kernels resolve to, and where it came from. */
export interface PythonInterpreter {
  /** The manual override, if one is set (even when it no longer runs). */
  configured: string | null;
  /** What cells would actually run on right now. */
  resolved: string | null;
  source: "manual" | "system" | "jupyter-env" | null;
  error: string | null;
}

export async function pythonInterpreter(): Promise<PythonInterpreter | null> {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<PythonInterpreter>("python_interpreter");
}

/** Set (empty clears) the manual Python interpreter override. Validated on save. */
export async function setPythonPath(path: string): Promise<void> {
  if (!isTauri) throw new Error("not running in the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_python_path", { path });
}

/** One live output line from a provisioning run (jupyter / science MCP env, or
 *  an agent-browser Chrome download). */
export interface SetupProgress {
  task: "jupyter" | "science" | "browser";
  line: string;
}

/** Subscribe to setup progress lines; returns the unlisten function. */
export async function watchSetupProgress(
  cb: (p: SetupProgress) => void,
): Promise<() => void> {
  if (!isTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<SetupProgress>("setup-progress", (e) => cb(e.payload));
}

/** Managed interpreter path for the shared science-MCP env, or null if not yet
 *  provisioned (desktop only). */
export async function scienceMcpPython(): Promise<string | null> {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("science_mcp_python");
}

/** Provision one open-source MCP pip package into the shared isolated env and
 *  return the managed Python path to launch it with (desktop only). */
export async function setupScienceMcp(pkg: string): Promise<string> {
  if (!isTauri) throw new Error("not running in the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("setup_science_mcp", { package: pkg });
}

// ---- Browser control (bundled agent-browser sidecar) ----

/** A Chrome profile agent-browser can reuse. `directory` is passed as
 *  AGENT_BROWSER_PROFILE ("Default", "Profile 4"); `name` is the account label. */
export interface BrowserProfile {
  directory: string;
  name: string;
}

/** An installed Chromium-family browser we can reuse instead of downloading. */
export interface ChromeInfo {
  path: string;
  kind: "chrome" | "chromium" | "edge" | "brave" | string;
}

/** Absolute path to the bundled agent-browser sidecar (for the MCP command).
 *  Throws in browser dev; the caller only needs it inside the desktop app. */
export async function agentBrowserBin(): Promise<string> {
  if (!isTauri) throw new Error("not running in the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("agent_browser_bin");
}

/** Absolute path to the desktop executable's browser MCP proxy mode. */
export async function browserMcpBin(): Promise<string> {
  if (!isTauri) throw new Error("not running in the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("browser_mcp_bin");
}

/** The user's Chrome profiles (empty when no Chrome / not desktop). */
export async function agentBrowserProfiles(): Promise<BrowserProfile[]> {
  if (!isTauri) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<BrowserProfile[]>("agent_browser_profiles");
  } catch {
    return [];
  }
}

/** Close every browser session in Open Science Desktop's private namespace. */
export async function closeAgentBrowser(): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("close_agent_browser");
}

/** First installed Chrome/Chromium/Edge/Brave, or null. Its executable can run
 *  a separate managed browser and avoids a Chrome-for-Testing download. */
export async function detectChrome(): Promise<ChromeInfo | null> {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<ChromeInfo | null>("detect_chrome");
  } catch {
    return null;
  }
}

/** Download a browser (Chrome for Testing) when none is installed. Streams
 *  progress as `setup-progress` (task "browser") and honors the proxy setting. */
export async function setupBrowserChrome(): Promise<void> {
  if (!isTauri) throw new Error("not running in the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("setup_browser_chrome");
}

/** Auto-start Jupyter on launch when it was enabled before. Silent no-op otherwise. */
export async function ensureJupyter(): Promise<void> {
  try {
    const s = await jupyterStatus();
    if (s?.installed && !s.running) await startJupyter();
  } catch {
    /* Jupyter is optional — never block the app on it */
  }
}

/** Open an http(s) URL in the system browser (never navigates the webview). */
export async function openExternal(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return;
  if (isTauri) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_url", { url });
    } catch {
      /* opening a link must never break the app */
    }
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export interface LatestRelease {
  version: string;
  url: string;
  name: string | null;
  publishedAt: string | null;
}

export async function latestRelease(): Promise<LatestRelease | null> {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<LatestRelease>("latest_release");
}

export type SaveResult =
  | { kind: "saved"; path: string }
  | { kind: "canceled" }
  | { kind: "not-desktop" };

/** Save text via the native "Save As" dialog (desktop only). Throws on write failure. */
export async function saveTextFile(filename: string, content: string): Promise<SaveResult> {
  if (!isTauri) return { kind: "not-desktop" };
  const { invoke } = await import("@tauri-apps/api/core");
  const path = await invoke<string | null>("save_text_file", { filename, content });
  return path ? { kind: "saved", path } : { kind: "canceled" };
}

/** The active workspace directory (desktop only; null in browser). */
export async function workspacePath(): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string>("workspace_path");
  } catch {
    return null;
  }
}

/** The base folder containing `projects/` and `sessions/` (desktop only). */
export async function workspaceBase(): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string>("workspace_base");
  } catch {
    return null;
  }
}

/** Choose the base folder new session workspaces are created under.
 *  Returns the canonical path. Throws in the browser. */
export async function setWorkspaceBase(path: string): Promise<string> {
  if (!isTauri) throw new Error("not running in the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("set_workspace_base", { path });
}

/** Reveal the base workspace folder in the OS file manager. */
export async function openWorkspaceBase(): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_workspace_base");
}

/** Switch the active workspace folder (creates it if needed; the runtime
 *  rescopes via `?directory=` — no restart). Returns the canonical path.
 *  Throws in the browser. */
export async function setWorkspace(path: string): Promise<string> {
  if (!isTauri) throw new Error("not running in the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("set_workspace", { path });
}

/** Record which session owns the active workspace (written to
 *  `.openscience/session.txt`) so skill helpers can attribute remote runs. */
export async function markSession(sessionId: string): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("mark_session", { sessionId });
}

/** Best-effort local git checkpoint for the active workspace. Returns false
 *  when there were no changes. Never configures a remote or pushes. */
export async function commitWorkspaceSnapshot(message: string): Promise<boolean> {
  if (!isTauri) return false;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("commit_workspace_snapshot", { message });
}

/** Install a pasted SKILL.md into the app profile's user skills dir, where
 *  OpenCode finds it from every workspace, and restart the sidecar so it is
 *  discovered now. Returns the installed skill's name; throws when the text is
 *  not a SKILL.md (no frontmatter `name:`) or the name is already bundled. */
export async function installSkillMarkdown(text: string): Promise<string> {
  if (!isTauri) throw new Error("not running in the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("install_skill_markdown", { text });
}

/** Skill names already in the active workspace's `.opencode/skills/`. */
export async function workspaceSkillNames(): Promise<string[]> {
  if (!isTauri) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string[]>("workspace_skill_names");
}

/** Move skills the agent just wrote into the workspace into the profile's user
 *  skills dir (skipping `known`, the pre-install listing), so they survive the
 *  session folder. Restarts the sidecar when it adopted anything. */
export async function adoptWorkspaceSkills(known: string[]): Promise<string[]> {
  if (!isTauri) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string[]>("adopt_workspace_skills", { known });
}

/** Create a new dated folder under `<base>/sessions` and switch to it. */
export async function newDatedWorkspace(name: string): Promise<string> {
  if (!isTauri) throw new Error("not running in the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("new_dated_workspace", { name });
}

/** A project: a named workspace folder under `<base>/projects`, marked by its
 *  `.openscience/project.json`. Legacy root-level projects remain readable. */
export interface ProjectInfo {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  /** Absolute workspace folder (canonical, matches session `directory`). For a
   *  copy import this is the managed copy; for in-place it is the source. */
  path: string;
  /** True when this project was brought in from elsewhere (a copy-import, or a
   *  in-place import) — drives the "imported" badge. */
  imported: boolean;
  /** Where an imported project was brought in from (shown as a hint). Absent for
   *  app-created projects. */
  importedFrom?: string;
  /** Whether an imported project is a managed copy or used in place. */
  importMode?: ProjectImportMode;
  /** Whether this project is pinned to the sidebar. */
  pinned: boolean;
}

/** Create a project folder (with metadata, harness and an initial git
 *  snapshot). Does not switch the active workspace. */
export async function createProject(name: string): Promise<ProjectInfo> {
  // The web client creates projects through the gateway: a project is a folder
  // plus metadata on the SERVER, which is exactly where a headless install has
  // no desktop to fall back to (#81).
  if (isGatewayWeb) {
    const created = await gatewayPost<ProjectInfo>("/v1/projects", { name });
    if (!created) throw new Error("the gateway did not return the new project");
    return created;
  }
  if (!isTauri) throw new Error("not running in the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ProjectInfo>("create_project", { name });
}

export type ProjectImportMode = "copy" | "in-place";

/** Import an existing folder as either a managed copy or an in-place project. */
export async function importProject(
  path: string,
  mode: ProjectImportMode,
): Promise<ProjectInfo> {
  if (!isTauri) throw new Error("not running in the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ProjectInfo>("import_project", { path, mode });
}

/** Every structured or legacy project, sorted by name. */
export async function listProjects(): Promise<ProjectInfo[]> {
  if (isGatewayWeb) return (await gatewayGet<ProjectInfo[]>("/v1/projects")) ?? [];
  if (!isTauri) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ProjectInfo[]>("list_projects");
}

/** Rename a project's display name (keyed by id; the folder never moves). */
export async function renameProject(id: string, name: string): Promise<void> {
  if (!isTauri) throw new Error("not running in the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("rename_project", { id, name });
}

/** Open a project's workspace folder in the OS file manager (Finder / Explorer /
 *  Linux file manager). Resolved server-side from the project id. */
export async function openProjectFolder(id: string): Promise<void> {
  if (!isTauri) throw new Error("not running in the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_project_folder", { id });
}

/** Pin/unpin a project to the sidebar. */
export async function setProjectPinned(id: string, pinned: boolean): Promise<void> {
  if (!isTauri) throw new Error("not running in the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_project_pinned", { id, pinned });
}

/** Remove a project from the index. Files on disk are NOT deleted (an imported
 *  project's external repo is untouched; an app-created project's folder stays,
 *  demoted to a plain folder). */
export async function deleteProject(id: string): Promise<void> {
  if (!isTauri) throw new Error("not running in the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("delete_project", { id });
}

/** Native folder picker; null on cancel or in the browser. */
export async function pickFolder(): Promise<string | null> {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("pick_folder");
}

export interface ToolStatus {
  name: string;
  found: boolean;
  version?: string | null;
  /** The app's own copy (bundled uv / managed Jupyter env), not one on the user's PATH. */
  managed?: boolean;
}

/** Detect scientific/runtime tools on the user's system (desktop only). */
export async function detectTools(): Promise<ToolStatus[]> {
  if (!isTauri) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ToolStatus[]>("detect_tools");
}

/** Host aliases from the user's ~/.ssh/config (desktop only). */
export async function listSshHosts(): Promise<string[]> {
  if (!isTauri) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string[]>("list_ssh_hosts");
}

export interface GpuInfo {
  name: string;
  mem_total_mib: number;
  mem_used_mib: number;
  util_pct: number;
}

/** One live SSH probe of a remote machine (capabilities + usage snapshot). */
export interface ComputeProbe {
  reachable: boolean;
  message: string | null;
  /** The host answered but wants a password or a one-time code — offer a
   *  sign-in rather than an ssh error the user cannot act on (#73). */
  needs_sign_in: boolean;
  os: string | null;
  cores: number | null;
  load1: number | null;
  mem_total_bytes: number | null;
  mem_avail_bytes: number | null;
  disk_total_bytes: number | null;
  disk_free_bytes: number | null;
  gpus: GpuInfo[];
  slurm: string | null;
}

/** Static capability cache the agent reads to pick a machine. */
export interface MachineCaps {
  cores: number | null;
  mem_total_bytes: number | null;
  gpus: string[];
  slurm: string | null;
}

export interface Machine {
  host: string;
  label: string | null;
  caps: MachineCaps | null;
}

/** A Slurm queue entry. */
export interface ComputeJob {
  id: string;
  state: string;
  time: string;
  partition: string;
  name: string;
}

/** Saved remote machines (migrates a legacy hpc.json on first read). */
export async function computeMachines(): Promise<Machine[]> {
  if (!isTauri) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<Machine[]>("compute_machines");
}

/** Save (or update the label of) a remote machine. */
export async function addComputeMachine(host: string, label?: string): Promise<void> {
  if (!isTauri) throw new Error("not running in the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("add_compute_machine", { host, label: label ?? null });
}

export async function removeComputeMachine(host: string): Promise<void> {
  if (!isTauri) throw new Error("not running in the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("remove_compute_machine", { host });
}

/** Probe a machine over SSH; also caches its static caps for the agent. */
export async function computeProbe(host: string): Promise<ComputeProbe> {
  if (!isTauri) throw new Error("not running in the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ComputeProbe>("compute_probe", { host });
}

/** A Slurm host's queue. */
export async function computeJobs(host: string): Promise<ComputeJob[]> {
  if (!isTauri) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ComputeJob[]>("compute_jobs", { host });
}

export async function computeCancel(host: string, jobId: string): Promise<void> {
  if (!isTauri) throw new Error("not running in the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("compute_cancel", { host, jobId });
}

// ---- Interactive SSH sign-in (#73) ----

/** One host's shared-connection state. `prompt` is the server's own question,
 *  verbatim (Duo, PAM and campus OTP flows all word it differently), and
 *  `notice` the non-secret lines around it. */
export interface SshSession {
  host: string;
  status: "connecting" | "prompt" | "connected" | "failed";
  prompt: string | null;
  notice: string | null;
  error: string | null;
}

/** Whether this platform can share one authenticated connection across every
 *  later command. False on Windows, whose bundled OpenSSH has no ControlMaster —
 *  a sign-in there would have to be repeated for every single command. */
export async function sshSharingSupported(): Promise<boolean> {
  if (!isTauri) return false;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("ssh_sharing_supported");
}

export async function sshSessions(): Promise<SshSession[]> {
  if (!isTauri) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SshSession[]>("ssh_sessions");
}

/** Start (or adopt) the shared connection for a host. Returns as soon as ssh is
 *  running — the sign-in itself reports progress through `ssh:state` events,
 *  because a pushed second factor waits on a human. */
export async function sshConnect(host: string): Promise<void> {
  if (!isTauri) throw new Error("not running in the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("ssh_connect", { host });
}

/** Answer the pending question. The secret goes straight into ssh's terminal:
 *  never a process argument, never logged, never stored. */
export async function sshAnswer(host: string, secret: string): Promise<void> {
  if (!isTauri) throw new Error("not running in the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("ssh_answer", { host, secret });
}

/** Close the shared connection (also the cancel path for a dismissed dialog). */
export async function sshDisconnect(host: string): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("ssh_disconnect", { host });
}

export interface ModalStatus {
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  hint: string | null;
}

/** Detect whether the user's Modal CLI is installed and authenticated. */
export async function modalStatus(): Promise<ModalStatus | null> {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ModalStatus>("modal_status");
}

/** Copy a bundled example project into the workspace (idempotent; never
 *  overwrites user edits). Returns the workspace directory name. */
export async function installExample(name: string): Promise<string> {
  if (!isTauri) throw new Error("not running in the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("install_example", { name });
}

/** Append a diagnostic line to <app-data>/debug.log (desktop only; no-op in browser). */
export async function logDebug(message: string): Promise<void> {
  if (!isTauri) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("log_debug", { message });
  } catch {
    /* never let diagnostics break the app */
  }
}

/** Sync the native window appearance with the in-app theme so the macOS
 *  vibrancy material behind the translucent sidebar matches (warm and light
 *  are both light appearances). */
export async function setWindowTheme(dark: boolean): Promise<void> {
  if (!isTauri) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTheme(dark ? "dark" : "light");
  } catch (e) {
    // Best-effort — without it the material follows the system appearance.
    // Loud in the console: a denied capability here looks like a CSS bug.
    console.warn("setWindowTheme failed:", e);
  }
}

/** Set the webview page zoom (desktop only). We own zoom ourselves rather than
 *  Tauri's `zoomHotkeysEnabled` so the titlebar strips can counter-scale by the
 *  same factor — the native traffic lights don't zoom (see ZoomProvider). */
export async function setWebviewZoom(factor: number): Promise<void> {
  if (!isTauri) return;
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    await getCurrentWebview().setZoom(factor);
  } catch (e) {
    // Best-effort — a denied capability just leaves the page at 100%.
    console.warn("setWebviewZoom failed:", e);
  }
}

/** True when the current UA is macOS (traffic lights live in the window chrome). */
export function isMacUA(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");
}

/** Whether the macOS traffic lights overlap our content and need a left inset.
 *  Only in the packaged macOS webview (overlay titlebar) AND when not fullscreen
 *  — native fullscreen slides the lights away, so the inset would be an empty
 *  gap (the sidebar/expand buttons floated oddly indented in fullscreen). */
export function trafficLightsPresent(tauri: boolean, mac: boolean, fullscreen: boolean): boolean {
  return tauri && mac && !fullscreen;
}

/** Watch the window's fullscreen state (desktop only). Reports the current
 *  value immediately and on every enter/leave — fullscreen resizes the window,
 *  so a resize listener catches it. Returns an unlisten fn; in a plain browser
 *  it reports `false` once and unlisten is a no-op. */
export async function watchFullscreen(cb: (fullscreen: boolean) => void): Promise<() => void> {
  if (!isTauri) {
    cb(false);
    return () => {};
  }
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  const sync = async () => {
    try {
      cb(await win.isFullscreen());
    } catch {
      // Window gone or API unavailable — keep the last known value.
    }
  };
  await sync();
  return win.onResized(() => void sync());
}

/** Write the provider key/model into OpenCode's config via the Rust command. */
export async function configureOpenCode(
  creds: OpenCodeCredentials,
): Promise<ConfigureResult> {
  if (!isTauri) return { ok: false, reason: "not-desktop" };
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const path = await invoke<string>("configure_opencode", {
      provider: creds.provider,
      apiKey: creds.apiKey,
      model: creds.model,
      baseUrl: creds.baseUrl ?? null,
    });
    return { ok: true, path };
  } catch (e) {
    return { ok: false, reason: "error", message: e instanceof Error ? e.message : String(e) };
  }
}
