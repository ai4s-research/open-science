import { create } from "zustand";
import {
  OpenCodeClient,
  DEFAULT_OPENCODE_URL,
  isApiStatus,
  type AgentInfo,
  type AgentRuntime,
  type CommandInfo,
  type HistoryMessage,
  type OpenCodeEvent,
  type PermissionAskedEvent,
  type PermissionReply,
  type ProviderInfo,
  type QuestionAskedEvent,
  type RetryAction,
  type SessionMeta,
  type SkillInfo,
  type ToolCallStatus,
} from "@ai4s/sdk";
import { AcpRuntime, toAcpMcpServers, type AcpConfigOption } from "@ai4s/sdk/acp";
import type {
  ArtifactBlock,
  ReviewerBlock,
  RuntimeStatus,
  ThreadBlock,
  ToolVerb,
} from "@ai4s/shared";
import {
  adoptWorkspaceSkills,
  detectTools as probeTools,
  commitWorkspaceSnapshot,
  createProject as createProjectFolder,
  importProject as importProjectFolder,
  setProjectPinned as setProjectPinnedCmd,
  deleteProject as deleteProjectCmd,
  getAgentModels,
  getAgentVariants,
  getApprovalMode,
  installSkillMarkdown,
  isTauri,
  listProjects,
  logDebug,
  markSession,
  newDatedWorkspace,
  runtimePassword,
  setApprovalMode as persistApprovalMode,
  setProxySetting as persistProxySetting,
  setWorkspace,
  startRuntime,
  restartRuntime,
  runtimeFailure,
  takeConfigQuarantineNotice,
  runtimeStartedAt,
  workspacePath,
  workspaceSkillNames,
  type ApprovalMode,
  type ProjectImportMode,
  type ProjectInfo,
  type ProxyMode,
  type ToolStatus,
} from "./tauri";
import { isGatewayWeb, gatewayToken, gatewayOrigin } from "./webMode";
import { activeAcpAgent } from "./acpAgents";
import { acpTransport } from "./acpTransport";
import { samePath } from "./workspacePath";
import { kernelReset } from "./kernel";
import { moveScrollMemory } from "./scrollMemory";
import { deriveArtifact, deriveArtifactPresentation } from "./artifacts";
import { useLayoutStore } from "./layout";
import { provenanceInputsFromEvent, recordProvenance } from "./provenance";
import { clearResolvedPaths } from "./artifactFile";
import { imageAttachmentParts } from "./promptAttachments";
import { recordRun, runInputFromEvent } from "./runs";
import { splitReview } from "./review";
import { useSshStore } from "./ssh";
import {
  AUTO_REVIEW_KEY,
  AUTO_REVIEW_PROMPT,
  REVIEWER_AGENT,
  autoReviewPrompt,
  isMutatingTool,
  shouldAutoReview,
} from "./autoReview";
import { isGoalInjectedPrompt } from "./goalPrompts";
import { findHistoryDefects, repairTarget } from "./malformedHistory";
import { runSync, syncDir } from "./syncRunner";
import { notifyPermissionRequest } from "./systemNotification";
import { fallbackDefaultModel } from "@/components/settings/modelCatalog";
import { listProvidersWithAvailability, ZEN_PROVIDER_ID } from "./zenModels";
import { toast } from "@/lib/toast";
import i18n from "@/i18n";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const URL_KEY = "ai4s.opencodeUrl";
const HIDDEN_KEY = "ai4s.hiddenExamples";
// The composer's chosen reasoning-effort variant, kept across restarts (favorites
// / recent models persist too, so the effort should as well). Sibling of the
// model-preferences keys in components/settings/modelPreferences.
const REASONING_KEY = "ai4s.models.variant.v1";
/** Per-session model + reasoning-effort overrides, persisted so a restored split
 *  layout keeps each pane's model/effort (they're keyed by real session id,
 *  which survives across runs). */
const SESSION_MODELS_KEY = "ai4s.session.models.v1";
const SESSION_VARIANTS_KEY = "ai4s.session.variants.v1";
function loadRecord<V>(key: string): Record<string, V> {
  if (typeof window === "undefined") return {};
  try {
    const v = JSON.parse(window.localStorage.getItem(key) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
function saveRecord(key: string, rec: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(rec));
  } catch {
    /* storage full/unavailable never blocks a model switch */
  }
}

function initialUrl(): string {
  if (typeof window === "undefined") return DEFAULT_OPENCODE_URL;
  return window.localStorage.getItem(URL_KEY) ?? DEFAULT_OPENCODE_URL;
}
function initialHidden(): string[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(window.localStorage.getItem(HIDDEN_KEY) ?? "[]");
  } catch {
    return [];
  }
}
function initialReasoningVariant(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(REASONING_KEY) || null;
}
function initialAutoReview(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(AUTO_REVIEW_KEY) === "1";
}

export interface Thread {
  blocks: ThreadBlock[];
  index: Record<string, number>;
  loaded: boolean;
}

/** Outcome of installSkill: the skill is already installed, or an agent session
 *  is doing it and the caller should open that session to watch. */
export type InstallSkillResult =
  | { kind: "installed"; name: string }
  | { kind: "session"; id: string };

/** What a session's right pane shows: an artifact inspector, the Files
 *  browser, the Runs ledger, or nothing. Mutually exclusive — one pane. */
export interface PaneState {
  artifact: ArtifactBlock | null;
  showFiles: boolean;
  showRuns: boolean;
  /** The subagent panel: what this conversation's subagents are doing (#63). */
  showAgents: boolean;
}

/** Which runtime the current connection drives: the bundled OpenCode sidecar, or
 *  a user-configured ACP agent (#14). The UI reads it to withhold controls the
 *  ACP dialect cannot honour — a model picker that silently changed nothing
 *  would be worse than no picker (AGENTS.md). */
export type RuntimeKind = "opencode" | "acp";

interface RuntimeState {
  status: RuntimeStatus;
  serverUrl: string;
  runtimeKind: RuntimeKind;
  /** The connected ACP agent's display name, or null on OpenCode. */
  acpAgentName: string | null;
  /** The ACP agent's OWN selectors per session — model, reasoning level,
   *  permission mode — as it reported them (`configOptions`). This is what the
   *  composer offers instead of our model picker: ACP v1 changes a model through
   *  `session/set_config_option`, and the choices belong to the agent. */
  acpConfigOptions: Record<string, AcpConfigOption[]>;
  /** Set one of them. The agent answers with its complete list, which replaces
   *  ours — picking a model can change which reasoning levels exist. */
  setAcpConfigOption: (sessionId: string, configId: string, value: string) => Promise<void>;
  sessions: SessionMeta[];
  currentId: string | null;
  threads: Record<string, Thread>;
  skills: SkillInfo[];
  agents: AgentInfo[];
  /** Per-agent model / reasoning effort from OpenCode's config (Settings →
   *  Models → per agent). Consulted when a pane has no explicit pick, so a
   *  configured agent model is what actually runs the turn (#96). */
  agentModels: Record<string, string>;
  agentVariants: Record<string, string>;
  /** Re-read the per-agent config after Settings writes it. */
  refreshAgentModels: () => Promise<void>;
  /** Apply a change that makes the sidecar reload its config (per-agent model or
   *  effort, an installed skill), keeping the Settings surfaces on screen while
   *  it restarts. Without this the catalog is briefly unreachable and the page
   *  collapses to its connect prompt — every tweak looked like a lost runtime. */
  reloadRuntimeConfig: (apply: () => Promise<void>) => Promise<void>;
  /** Slash commands the runtime can run ("/" palette): config commands,
   *  skills and MCP prompts, one merged list from GET /command. */
  commands: CommandInfo[];
  /** Configured default model ("provider/model"), or null when unset. */
  defaultModel: string | null;
  /** Apply a new default model and transparently reconnect (see impl). */
  setDefaultModel: (model: string) => Promise<void>;
  /** Connected providers and their models (from GET /config/providers, fetched
   *  in loadCatalog). Drives the composer's inline model picker; empty until the
   *  first catalog load. Kept here so the picker and Settings share one source. */
  providers: ProviderInfo[];
  /** Selected per-turn reasoning-effort variant name (e.g. "high"), or null for
   *  the model's default. Sent with the next prompt only if the current model
   *  actually exposes it — variant vocabularies differ across models. */
  reasoningVariant: string | null;
  setReasoningVariant: (variant: string | null) => void;
  /** Run the reviewer agent for one read-only turn whenever a turn changed
   *  workspace files (#72). Off by default: it is a second model turn, so the
   *  user opts in. Persisted locally (it is app behaviour, not sidecar config),
   *  which also makes it work in the gateway web client. */
  autoReview: boolean;
  setAutoReview: (enabled: boolean) => void;
  /** Non-blocking reviewer activity keyed by the foreground parent session. */
  backgroundReviews: Record<string, "queued" | "running">;
  cancelAutoReview: (sessionId: string) => void;
  /** The last failed model switch's error, or null. While set, the Settings
   *  page keeps the model browser on screen (instead of the connect prompt)
   *  so the user can retry. Cleared by any successful reconnect, a successful
   *  switch, a server-URL change, or an explicit disconnect. */
  modelSwitchError: string | null;
  /** The composer's approval switch: "approve" (dangerous commands prompt)
   *  or "full" (everything in-workspace runs). Loaded from OpenCode config. */
  approvalMode: ApprovalMode;
  /** Persist a new approval mode (restarts the sidecar) and reconnect. */
  setApprovalMode: (mode: ApprovalMode) => Promise<void>;
  /** Persist the network-proxy setting (restarts the sidecar) and reconnect. */
  setProxySetting: (mode: ProxyMode, url: string) => Promise<void>;
  tools: ToolStatus[];
  hiddenExamples: string[];
  error: string | null;
  /** Pending interactive requests the agent is blocked on, newest last. */
  questions: QuestionAskedEvent[];
  permissions: PermissionAskedEvent[];
  /** Subagent session → the session whose task tool spawned it, learned from
   *  task tool events (live) and the session list (recovery after reload). */
  sessionParents: Record<string, string>;
  /** Right-pane state per session (DRAFT_KEY for a draft) — each session keeps
   *  its own open artifact / Files browser and gets it back when reopened.
   *  In-memory only: an app restart returns every session to a closed pane. */
  panes: Record<string, PaneState>;
  /** Composer agent switch per session (DRAFT_KEY for a draft); absent = build.
   *  In-memory, but reconciled from the message stream and history: OpenCode's
   *  plan_exit "Yes" continues the session as build — the pill must follow. */
  sessionAgents: Record<string, AgentMode>;
  /** Per-session model override (key = sid or DRAFT_KEY); absent = the global
   *  `defaultModel`. Lets each split pane run a different model without a global
   *  config switch (the model is sent per-turn), so switching one pane's model
   *  never changes the others. In-memory. */
  sessionModels: Record<string, string>;
  /** Per-session reasoning-effort override; absent = the global
   *  `reasoningVariant`. */
  sessionVariants: Record<string, string | null>;
  /** Set a session's model (per-pane); no sidecar config PATCH / reconnect. */
  setSessionModel: (sessionId: string, model: string) => void;
  /** Drop a pane's explicit pick so the turn follows the agent config / default
   *  again — without this a session model could be changed but never undone. */
  clearSessionModel: (sessionId: string) => void;
  /** Set a session's reasoning effort (per-pane). */
  setSessionVariant: (sessionId: string, variant: string | null) => void;
  // The pane/agent setters and turn actions below take an optional `sessionId`
  // so a split pane acts on its OWN session; omitted, they fall back to the
  // focused session (`currentId ?? DRAFT_KEY`) — the single-pane behavior.
  setAgentMode: (mode: AgentMode, sessionId?: string) => void;
  openArtifact: (a: ArtifactBlock, sessionId?: string) => void;
  closeArtifact: (sessionId?: string) => void;
  setShowFiles: (show: boolean, sessionId?: string) => void;
  setShowRuns: (show: boolean, sessionId?: string) => void;
  setShowAgents: (show: boolean, sessionId?: string) => void;
  answerQuestion: (requestId: string, answers: string[][]) => Promise<void>;
  rejectQuestion: (requestId: string) => Promise<void>;
  replyPermission: (requestId: string, reply: PermissionReply) => Promise<void>;
  setServerUrl: (url: string) => void;
  loadCatalog: () => Promise<void>;
  detectTools: () => Promise<void>;
  connect: () => Promise<void>;
  /** Resolves true once connected, false when the retry window is exhausted. */
  connectRetry: (tries?: number) => Promise<boolean>;
  /** Tell the user, once, that an unreadable OpenCode config was moved aside
   *  and rebuilt — otherwise settings they had (providers, MCP servers) are
   *  simply gone with no explanation (#118). */
  reportQuarantinedConfig: () => Promise<void>;
  bootstrap: () => Promise<void>;
  disconnect: () => void;
  refreshSessions: () => Promise<void>;
  startDraft: () => void;
  /** Blank the draft view WITHOUT unpinning the folder the next session
   *  will be created in — only an explicit New may do that (#69). */
  resetDraftView: () => void;
  startDraftInCurrentWorkspace: (key?: string) => void;
  /** Projects: named shared workspaces under `<base>/projects`. Sessions group
   *  under a project by `directory`; multiple sessions share the folder. */
  projects: ProjectInfo[];
  refreshProjects: () => Promise<void>;
  /** Create a project folder and move into it with a fresh pinned draft. */
  createProject: (name: string) => Promise<ProjectInfo | null>;
  importProject: (path: string, mode: ProjectImportMode) => Promise<ProjectInfo | null>;
  setProjectPinned: (id: string, pinned: boolean) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  /** Fresh draft aimed at `path` (a project folder), so the session it creates
   *  lands there. `key` is the draft slot the composer sends under — a pane's
   *  own `draft:<leafId>` when the caller opened one. Skips the reconnect when
   *  the folder is already active. */
  startDraftInWorkspace: (path: string, key?: string) => Promise<void>;
  /** Active workspace folder (absolute path); null in the browser. */
  workspace: string | null;
  /** Web client only: the folder this BROWSER chose to work in (a project the
   *  user opened here). The host's own active folder is never moved from a
   *  remote client — doing so would drag the person sitting at the desktop into
   *  another workspace mid-sentence — so the choice lives here and scopes this
   *  client's stream, its file views and the sessions it creates (#81). */
  webWorkspace: string | null;
  /** Web client only: the gateway token is read-only (GET-only) — every write
   *  (new session, prompt, approval) would 403, so the UI hides/disables them. */
  webReadOnly: boolean;
  /** Folder a pending draft's session must be created in, keyed by draft slot
   *  (`DRAFT_KEY`, or a pane's `draft:<leafId>`). Set when the user picks one —
   *  "+ new session in project X", or the folder picker. A draft with no entry
   *  gets its own fresh dated folder.
   *
   *  Per draft and holding the PATH, not a global boolean (#69): the active
   *  folder follows whatever session was last opened, so a bare "pinned" flag
   *  neither survived a glance at another session (the send landed in that
   *  session's folder) nor stayed out of the way of an unrelated new screen. */
  draftWorkspaces: Record<string, string>;
  /** Point a draft slot at `path` — or, with null, back at a fresh dated folder.
   *  Pure state: unlike `switchWorkspace` it does NOT move the active folder,
   *  because a new pane must not drag the pane the user is still reading into a
   *  different workspace. The send path does the moving, once, if the draft is
   *  still aimed when its first message goes out. */
  aimDraft: (key: string, path: string | null) => void;
  /** A deliberate workspace move is in flight (event-stream reconnect into the
   *  new folder). The UI must not present it as a disconnection — no status
   *  flip, no Connect button, no help card. Real failures surface after the
   *  retry window is exhausted, once this clears. */
  switching: boolean;
  /** A MODEL switch is in flight. Deliberately separate from `switching`, which
   *  covers any workspace move: the model chip spun on every Screen switch,
   *  because moving folders sets that flag too and the chip read it as "your
   *  model is changing". */
  modelSwitching: boolean;
  /** A sendPrompt is in flight for SOME session (click → POST accepted). Kept as
   *  the OR of `sendingSessions` for single-pane call sites; per-pane composers
   *  read `sendingSessions[sessionId]` instead. */
  sending: boolean;
  /** Sessions with a send in flight (POST not yet settled), keyed by id
   *  (DRAFT_KEY for a draft). Lets split panes send concurrently while still
   *  blocking a double-send to the SAME session. */
  sendingSessions: Record<string, true>;
  /** Sessions with an active turn (send accepted, session.idle not yet seen).
   *  Drives the composer lock and the "Working…" indicator. */
  runningSessions: Record<string, true>;
  /** Current model-step number per running session (from `step.updated`), so the
   *  working indicator can show "step N" — proof the turn is progressing, not
   *  hung. Reset when a turn starts and cleared on idle. */
  stepCounts: Record<string, number>;
  /** Sessions whose current turn is a user-typed "!" shell command. Their bash
   *  output shows inline in the thread — the output IS the result the user
   *  asked for. Agent bash steps stay quiet single-line log entries. */
  shellTurns: Record<string, true>;
  /** Sessions whose model call failed and is being retried server-side — this
   *  is what keeps a broken provider from looking like a silent "Working…".
   *  Cleared by the session's next sign of life (stream events, idle, error).
   *  `action` is present when the runtime recognised an account-state cause
   *  (a spent free allowance, a plan limit): the attempts will run out without
   *  it changing, so the UI must not call that "retrying" and leave it there. */
  retryNotices: Record<string, { attempt: number; message: string; action?: RetryAction }>;
  /** Epoch ms the current sidecar started; 0 until known. Anything stored
   *  before it cannot be in flight now. */
  runtimeStartedAt: number;
  /** Switch to an existing folder, or (with `dated`) create a new dated one.
   *  `key` is the draft slot the switch was made for — the folder becomes that
   *  draft's destination. Defaults to the global slot. */
  switchWorkspace: (
    target: ({ path: string } | { dated: string }) & { key?: string },
  ) => Promise<void>;
  /** Ensure a brand-new draft already has its own (pinned) dated folder before
   *  composer files are written into it — otherwise a file added to a draft
   *  lands in the pre-send folder while send would create a different dated one,
   *  orphaning it. No-op once a session exists or the folder is already pinned. */
  ensureDraftWorkspace: () => Promise<void>;
  openSession: (id: string) => Promise<void>;
  /** Load a session's history into its thread WITHOUT switching the foreground
   *  folder/stream — for background split panes so they show their conversation
   *  on launch instead of a skeleton until focused. No-op if already loaded. */
  loadHistory: (id: string) => Promise<void>;
  /** `draftKey` (a `draft:<leafId>` slot) is the per-pane draft this send may
   *  lazily create a session from — passed by tiled panes so each unbound pane
   *  keeps its own draft/thread and creates its own session on first send. */
  /** `attachments` are workspace file names from the composer's chips; the image
   *  ones are also sent as multimodal parts so a vision model sees them (#88). */
  sendPrompt: (
    text: string,
    sessionId?: string,
    draftKey?: string,
    attachments?: string[],
  ) => Promise<string | null>;
  /** Run a "!" shell command directly in the session's workspace folder —
   *  no model turn; the output folds into the thread as a bash tool row. */
  runShell: (command: string, sessionId?: string, draftKey?: string) => Promise<string | null>;
  /** Run a "/" slash command (config command / skill / MCP prompt). */
  runCommand: (name: string, args?: string, sessionId?: string, draftKey?: string) => Promise<string | null>;
  /** Interrupt a session's running turn (Stop button / Esc); the focused
   *  session when `sessionId` is omitted. */
  interrupt: (sessionId?: string) => Promise<void>;
  /** Edit a past user message: revert the session to (and including) that
   *  message — dropping it and everything after, rolling back the files those
   *  turns changed — then resend the corrected text as a new turn. Destructive:
   *  callers must confirm first. `messageID` is the id on the user block. */
  editMessage: (messageID: string, newText: string, sessionId?: string) => Promise<void>;
  /** Revert the session to (and including) a past user message WITHOUT
   *  resending — drops it and everything after and rolls back those turns'
   *  files, leaving the session idle at that point. Returns whether it
   *  succeeded (the caller prefills the composer with the message on success).
   *  Destructive: callers must confirm first. */
  revertMessage: (messageID: string, sessionId?: string) => Promise<boolean>;
  /** Check every session holding a running lock against the server: if its
   *  turn is actually over (idle was missed — SSE reconnect windows, the
   *  directory-scoped event stream), reload the missed history and unlock. */
  reconcileRunning: () => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  /** Retitle a session. Resolves false when the runtime rejected the rename
   *  (the old title stays); the caller shows nothing else. */
  renameSession: (id: string, title: string) => Promise<boolean>;
  /** File an existing conversation under a project folder (#62): the session
   *  moves, its workspace files stay put. Resolves false on failure. */
  moveSessionToWorkspace: (id: string, directory: string) => Promise<boolean>;
  /** Archive a conversation (or restore it). Nothing is deleted — archiving
   *  only takes it out of the sidebar and the default history view. */
  setSessionArchived: (id: string, archived: boolean) => Promise<boolean>;
  hideExample: (id: string) => void;
  /** Install a skill. A pasted SKILL.md is written straight into the profile's
   *  user skills dir (`installed`); anything else (a URL, a description) hands
   *  the job to an agent session (`session`, whose id the caller opens) and is
   *  adopted into that same dir when the session finishes. null on failure. */
  installSkill: (text: string) => Promise<InstallSkillResult | null>;
  /** Ensure a live background event stream for every workspace folder shown in
   *  a split pane (besides the foreground folder), and drop streams for folders
   *  no longer tiled — so sessions across DIFFERENT projects stream live at once.
   *  Desktop only (single-pane on web). */
  syncPaneStreams: (directories: string[]) => void;
}

// The internal store depends only on the runtime-agnostic AgentRuntime contract
// (see docs/rfc/agent-runtime.md). The concrete reference (opencodeClient) is
// kept separately so getClient() can hand Settings/setup the full OpenCode
// provider/MCP surface that lives outside the AgentRuntime contract.
let client: AgentRuntime | null = null;
let opencodeClient: OpenCodeClient | null = null;
/** The live ACP runtime and the agent id it was started for, kept ACROSS
 *  reconnects (#14). The app reconnects whenever the workspace moves — every new
 *  session does — and ACP binds the folder per session (`session/new`'s cwd),
 *  not per process: the spec requires the session's cwd to be used "regardless
 *  of where the Agent subprocess was spawned". So a move re-points `setCwd` and
 *  keeps the child, instead of paying an agent cold start (an `npx` boot) and
 *  killing every session that child was holding. */
let acpRuntime: AcpRuntime | null = null;
let acpRuntimeAgentId: string | null = null;
let openSessionSeq = 0;
/** The model the user last DELIBERATELY switched to, and when. A switch does a
 *  masked reconnect, and connect() fires loadCatalog() un-awaited — so the
 *  self-heal there can run just after `switching` clears, read the reconnecting
 *  instance's not-yet-complete provider list, judge the just-picked model
 *  "dangling", and revert it to an old one (a switch then "doesn't take"; #37).
 *  Remember the choice briefly so the self-heal won't fight it during that
 *  window; a model that is GENUINELY gone still heals once the window lapses,
 *  and the send-time "model not found" error covers the gap meanwhile. */
let lastSwitchModel: string | null = null;
let lastSwitchAt = 0;
const SWITCH_HEAL_GRACE_MS = 15_000;
/** React StrictMode mounts effects twice in development. Share the same boot
 *  promise so duplicate AppShell effects cannot start dueling connect loops. */
let bootstrapInFlight: Promise<void> | null = null;
/** The catalog load currently in flight. connect() fires loadCatalog without
 *  awaiting it, so history could render before the command list arrived — and
 *  history needs it: OpenCode stores a slash command's EXPANDED template as the
 *  user message, and collapsing it back to "/name args" needs the templates.
 *  Without them a reopened session showed the raw expansion (the goal plugin's
 *  whole instruction block instead of the one line the user typed). Awaiting
 *  the in-flight load costs no extra request — it is already running. */
let catalogInFlight: Promise<void> | null = null;
/** Registered once: the remote-access gateway tells us when a LAN/CLI client
 *  created or deleted a session so the sidebar re-lists (no OpenCode event for
 *  session create/delete). See docs/rfc/remote-access-gateway.md. */
let gatewayListenerBound = false;
/** Custom-model context-limit cleanup (#52) runs once per app run — every
 *  reconnect re-enters connect(), and the check is a config round-trip. */
let contextLimitsCleaned = false;
/** Unhook the current client's status listener BEFORE closing it — teardown
 *  emits "offline", and a reconnect attempt must not flash that at the user. */
let clientStatusUnsub: (() => void) | null = null;
/** An agent skill install in flight: the session doing it, and the workspace's
 *  skills as they were before it started. When that session goes idle whatever
 *  it added is adopted into the profile's user skills dir (#61). One at a time —
 *  the Skills page starts one install per click. */
let pendingSkillInstall: { sessionId: string | null; known: string[] } | null = null;

/** Does this text look like a SKILL.md the app can install itself (YAML
 *  frontmatter with a name)? The Rust command owns the strict rules — this only
 *  decides whether to skip the agent. */
function looksLikeSkillFile(text: string): boolean {
  const body = text.replace(/^\uFEFF/, "").trimStart();
  if (!body.startsWith("---")) return false;
  const end = body.indexOf("\n---", 3);
  return end > 0 && /^\s*name:\s*\S/m.test(body.slice(3, end));
}

/** The SDK recovers a dropped stream in ~250ms (OpenCode closes /event ~1s
 *  after a config PATCH while rebuilding its instance). Surfacing that blip
 *  repaints every status consumer, so a ready→connecting flip is held this
 *  long and only shown if the stream does not come back. */
const STATUS_BLIP_GRACE_MS = 2000;

/** Failed reconnect attempts to tolerate before forcing a brand-new sidecar.
 *  Plain retries already cover first boot, a slow start, and a process that
 *  died and was respawned; eight attempts span roughly four seconds, past all
 *  of those. Beyond that the runtime is not coming back on its own — it is
 *  alive but no longer serving, which nothing else in the app can detect. */
const RECONNECT_FORCE_RESTART_AFTER = 8;

/** Sidecar exits, within one reconnect attempt, that mean the next spawn is
 *  doomed too. Three: one death can be a crash worth respawning past (that is
 *  what the loop is for), three in a row is the process refusing to run — a
 *  config it will not start on, a missing binary, a denied permission. Without
 *  this the loop spawns ~120 processes that each exit in milliseconds and then
 *  reports nothing but a failed socket (#118). */
const RECONNECT_GIVE_UP_AFTER_EXITS = 3;
let statusBlipTimer: ReturnType<typeof setTimeout> | null = null;
function clearStatusBlip() {
  if (statusBlipTimer !== null) clearTimeout(statusBlipTimer);
  statusBlipTimer = null;
}
/** connectRetry loops in flight. A failed ATTEMPT inside one is not news — it
 *  is one step of a loop that is still trying — and painting it flips the whole
 *  page (status badge, offline help card, error banner) once per attempt, 250ms
 *  apart. Every launch does that: the sidecar is spawned and dialled before it
 *  listens, so the first two or three attempts always fail (and on a fresh
 *  install, blocked on the macOS TCC prompt, the loop can run for minutes).
 *  While this is non-zero the UI is held at "connecting" and only the loop's
 *  verdict is published. */
let connectRetryDepth = 0;
/** What the last connect() attempt failed with, masked or not — connectRetry
 *  reports it if the whole window is exhausted. */
let lastConnectError: string | null = null;
/** The status the UI is allowed to see right now. */
function visibleStatus(status: RuntimeStatus): RuntimeStatus {
  return connectRetryDepth > 0 && status !== "ready" ? "connecting" : status;
}
/**
 * Drop the current connection. `keep` is the one runtime a reconnect intends to
 * REUSE (the live ACP agent when the selection has not changed): closing it
 * would kill the agent process and every session it holds, only to spawn the
 * same command again a moment later.
 */
function teardownClient(keep?: AgentRuntime | null) {
  clientStatusUnsub?.();
  clientStatusUnsub = null;
  clearStatusBlip();
  if (client && client !== keep) {
    client.close();
    // Closing the ACP runtime kills its child (the transport's `close` stops it),
    // so the module handle must go with it — otherwise the next connect would
    // reuse a runtime whose agent is gone.
    if (client === acpRuntime) {
      acpRuntime = null;
      acpRuntimeAgentId = null;
    }
  }
  client = null;
  opencodeClient = null;
}

// ---- Cross-folder streaming (split panes) ----
// The foreground `client` streams the ACTIVE folder. Split panes showing
// sessions from OTHER folders each get a background stream here, keyed by
// directory, so they update live concurrently. All streams fold through the one
// `sharedEventHandler` — events carry `sessionId` and the store is sid-keyed, so
// N streams need no per-stream demux. Same sidecar → same baseUrl/password.
const streamClients = new Map<string, OpenCodeClient>();
let streamBaseUrl = "";
let streamPassword: string | undefined;
/** The store's event handler, captured once (set/get are stable) so foreground
 *  and every background stream share one folding path. */
let sharedEventHandler: ((event: OpenCodeEvent) => void) | null = null;
function removeStreamClient(dir: string) {
  cancelStreamRetirement(dir);
  const c = streamClients.get(dir);
  if (c) {
    c.close();
    streamClients.delete(dir);
  }
}
/**
 * Folders whose stream is no longer tiled but is kept alive a little longer.
 *
 * Screen switching used to close every background stream and open the incoming
 * screen's from scratch, so flipping between two screens paid a full SSE
 * handshake each way — against a per-directory OpenCode instance that is
 * initialized lazily, i.e. a cold start on the switch's critical path (#92).
 * Retiring on a delay makes a switch back free, and costs one idle EventSource
 * per recently-seen folder for the length of the grace period.
 */
const streamRetirements = new Map<string, ReturnType<typeof setTimeout>>();
const STREAM_RETIREMENT_MS = 60_000;
function cancelStreamRetirement(dir: string) {
  const timer = streamRetirements.get(dir);
  if (timer !== undefined) {
    clearTimeout(timer);
    streamRetirements.delete(dir);
  }
}
function retireStreamClient(dir: string) {
  if (streamRetirements.has(dir) || !streamClients.has(dir)) return;
  streamRetirements.set(
    dir,
    setTimeout(() => {
      streamRetirements.delete(dir);
      removeStreamClient(dir);
    }, STREAM_RETIREMENT_MS),
  );
}
function teardownStreamClients() {
  for (const dir of [...streamRetirements.keys()]) cancelStreamRetirement(dir);
  for (const c of streamClients.values()) c.close();
  streamClients.clear();
}
/** The connected client whose stream owns `sid` — its folder's background
 *  stream, else the foreground client. Session-scoped calls (send/abort/history)
 *  work through any client, but the directory-scoped interactive replies
 *  (question/permission) must go to the matching per-directory instance. */
function clientForSession(get: StoreGet, sid: string): AgentRuntime | null {
  // Subagent asks carry the CHILD sid (which may not be listed in `sessions`
  // yet); resolve to the root session to find the owning folder, mirroring how
  // belongsHere surfaces the ask in the parent's pane.
  const root = rootSessionOf(get().sessionParents, sid);
  const dir = get().sessions.find((x) => x.id === root)?.directory;
  if (dir && dir !== get().workspace) {
    const bg = streamClients.get(dir);
    if (bg) return bg;
  }
  return client;
}
const emptyThread = (): Thread => ({ blocks: [], index: {}, loaded: false });

/** Retire a draft slot's folder — its session was created, or the user asked for
 *  a plain New. Absent means "give the next session a fresh dated folder". */
function forgetDraftFolder(s: RuntimeState, key: string) {
  if (!(key in s.draftWorkspaces)) return {};
  const draftWorkspaces = { ...s.draftWorkspaces };
  delete draftWorkspaces[key];
  return { draftWorkspaces };
}

/** Drop the global draft slot's leftovers: an aborted first message, its pane
 *  and its Build/Plan mode. Deliberately says nothing about the draft's folder —
 *  see `startDraft` vs `resetDraftView` (#69). */
function blankDraft(s: RuntimeState, key: string = DRAFT_KEY) {
  const threads = { ...s.threads };
  delete threads[key];
  const panes = { ...s.panes };
  delete panes[key];
  const sessionAgents = { ...s.sessionAgents };
  delete sessionAgents[key];
  return { currentId: null, threads, panes, sessionAgents };
}
/**
 * Hand the app's own MCP connectors to the ACP agent.
 *
 * ACP takes MCP servers per session; OpenCode keeps them in its global config.
 * That config is read through a THROWAWAY OpenCodeClient — the sidecar is
 * running either way (it backs the workspace, kernels and the gateway), and
 * `getClient()` must keep answering null under an ACP agent so Settings does not
 * offer a provider surface that is not driving anything.
 *
 * Best-effort by design: a connector list that cannot be read must not stop the
 * agent from connecting. The session simply gets the tools the agent brings.
 *
 * A connector's own credentials (env, headers) travel with it — they are what
 * makes it work, and the bundled runtime already launches these servers with
 * them. Nothing else does: the agent is a command the user configured, and no
 * provider API key of ours is ever part of this payload.
 */
async function shareMcpServers(runtime: AcpRuntime, baseUrl: string, password: string | null) {
  try {
    const config = new OpenCodeClient({
      baseUrl,
      password: password ?? undefined,
      // The sidecar is local; a connector list is not worth stalling a connect.
      requestTimeoutMs: 4000,
    });
    const servers = await config.listMcpServers();
    const acp = toAcpMcpServers(
      Object.fromEntries(
        servers.filter((s) => s.config).map((s) => [s.name, s.config!]),
      ),
    );
    runtime.setMcpServers(acp);
    if (acp.length > 0) void logDebug(`acp mcp → ${acp.map((s) => s.name).join(", ")}`);
  } catch (err) {
    void logDebug(`acp mcp skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Mirror the ACP agent's own session selectors into the store, so the composer
 * can offer them. A local read, not an RPC — and it writes only when they
 * actually changed, since this runs on turn boundaries and a needless write
 * repaints every composer.
 */
function syncAcpConfig(set: StoreSet, sessionId: string): void {
  const rt = acpRuntime;
  if (!rt || client !== rt) return;
  const options = rt.configOptionsFor(sessionId);
  set((s) => {
    const current = s.acpConfigOptions[sessionId] ?? [];
    if (JSON.stringify(current) === JSON.stringify(options)) return {};
    return { acpConfigOptions: { ...s.acpConfigOptions, [sessionId]: options } };
  });
}

/** Threads key for the draft conversation — its blocks move to the real
 *  session id once the session exists, so the page never visibly resets. */
export const DRAFT_KEY = "draft";

/** A tiled pane's own draft slot, keyed by its leaf id, so multiple unbound
 *  panes each hold an independent draft (thread/composer/model/agent) and each
 *  create their own session on first send — instead of sharing DRAFT_KEY. */
export const draftKeyFor = (leafId: string): string => `draft:${leafId}`;

/**
 * Folder a pane split off `source` should start in: the folder that pane's own
 * next message would land in. A bound pane contributes its session's folder; an
 * unbound one contributes whatever it is itself aimed at, which is null when it
 * would create a dated folder — so "new folder" propagates as faithfully as a
 * real path does. Null means the new pane makes its own dated folder, which is
 * also what an empty Screen (no source pane at all) gets.
 *
 * Deliberately NOT the active workspace: that follows whichever session was
 * last opened, so it can name a folder the source pane has nothing to do with
 * (#69). Only the pane being split from may decide this.
 */
export function inheritedDraftFolder(
  source: { leafId: string; sessionId: string | null } | null,
  state: Pick<RuntimeState, "sessions" | "draftWorkspaces">,
): string | null {
  if (!source) return null;
  if (source.sessionId) {
    return state.sessions.find((s) => s.id === source.sessionId)?.directory ?? null;
  }
  return state.draftWorkspaces[draftKeyFor(source.leafId)] ?? null;
}

/**
 * Hand a freshly split pane the folder of the pane it came from, and remember
 * that origin so the empty pane can offer the other answer (a new dated folder)
 * as one click — see DraftDestination.
 *
 * Every way of making a split pane must go through here. It used to live in the
 * Cmd+D handler alone, so the header's split buttons produced a pane with no
 * origin: no chooser, and a first message that silently made a dated folder
 * away from the project the user was working in.
 */
export function adoptSourceFolder(
  newLeafId: string | null,
  source: { leafId: string; sessionId: string | null } | null,
): void {
  if (!newLeafId) return;
  const runtime = useRuntimeStore.getState();
  const folder = inheritedDraftFolder(source, runtime);
  if (folder) runtime.aimDraft(draftKeyFor(newLeafId), folder);
}

/** The composer's agent switch: "build" edits and runs; "plan" is OpenCode's
 *  read-only planning agent (edits denied except its plan .md file). */
export type AgentMode = "build" | "plan";
/** One bounded retry for the first POSTs after a sidecar restart — the old
 *  connection occasionally dies mid-handshake ("Load failed"). */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    await sleep(600);
    return await fn();
  }
}
/** Dedup Sets below hold completed callIds/requestIds that never recur, but a
 *  long, tool-heavy session keeps adding to them forever (issue #34: unbounded
 *  frontend state → multi-GB WebContent). Cap each with FIFO eviction of the
 *  oldest — safe, since an evicted id belongs to a finished call. */
const DEDUP_CAP = 4000;
function remember(set: Set<string>, key: string, cap = DEDUP_CAP) {
  set.add(key);
  while (set.size > cap) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

/** Tool calls already written to provenance — success events can repeat per callId. */
const recordedProvenance = new Set<string>();
/** Bash calls already written to the run store — terminal events can repeat per callId. */
const recordedRuns = new Set<string>();
const notifiedPermissions = new Set<string>();
/** A completed presentation tool can be repeated by SSE reconciliation. Layout
 *  mutations are not idempotent, so handle each call exactly once. */
const handledPresentations = new Set<string>();
/** `ssh_connect` calls already relayed to the sign-in dialog (#73). One tool call
 *  emits several `tool.updated` events — the SDK re-emits per part update, so
 *  "pending" then "running" at least — and starting a sign-in is anything but
 *  idempotent: each repeat raced another ssh master for the same ControlPath. */
const relayedSignIns = new Set<string>();

/** Sessions the user just interrupted: the thread already shows "Interrupted",
 *  so the abort's own trailing events (an "aborted" error and one or more
 *  session.idle events) must not add a second line. Armed before the abort POST
 *  and held across every trailing event; the next turn clears it (`turn → sid`). */
const interruptedSessions = new Set<string>();

// ---- Auto-review (#72) ----
// Per-token review state stays outside Zustand so a background reviewer never
// repaints the foreground pane. The store only receives queued/running
// transitions and the final structured result.
/** Sessions whose CURRENT turn has written or edited a workspace file. */
const dirtyTurns = new Set<string>();
/** Exact paths observed on mutating tool events, scoped to the parent turn. */
const dirtyTurnPaths = new Map<string, Set<string>>();
/** Sessions waiting for the single review slot, oldest first. */
const reviewQueue: string[] = [];
/** Paths coalesced while a parent waits for the single review slot. */
const queuedReviewPaths = new Map<string, Set<string>>();
interface BackgroundReviewJob {
  parentId: string;
  checkpointMessageId: string;
  checkpointUserMessageId?: string;
  runtime: AgentRuntime;
  paths: string[];
}
/** Hidden fork id → the foreground checkpoint it reviews. */
const backgroundReviewJobs = new Map<string, BackgroundReviewJob>();
/** Reviews explicitly stopped by the user produce no fallback finding. */
const cancelledBackgroundReviews = new Set<string>();
/** Ignore abort/error trailing events after a hidden review has been folded
 *  back and removed; otherwise they recreate an unreachable child thread. */
const retiredBackgroundReviews = new Set<string>();
/** Synthetic result parts must not make a quiet parent look like it started a
 *  new model turn when their SSE update arrives. */
const backgroundReviewResultParts = new Set<string>();
/** Parent session holding the one global review slot. */
let reviewInFlight: string | null = null;

function mergePaths(target: Map<string, Set<string>>, sid: string, paths: Iterable<string>): void {
  const merged = target.get(sid) ?? new Set<string>();
  for (const path of paths) if (path) merged.add(path);
  if (merged.size > 0) target.set(sid, merged);
}

function takePaths(target: Map<string, Set<string>>, sid: string): string[] {
  const paths = [...(target.get(sid) ?? [])];
  target.delete(sid);
  return paths;
}

/** Forget every trace of a session's review state (session deleted, runtime
 *  torn down) so a queued id can't resurrect a review for a gone session. */
function forgetAutoReview(sid: string) {
  dirtyTurns.delete(sid);
  dirtyTurnPaths.delete(sid);
  queuedReviewPaths.delete(sid);
  const at = reviewQueue.indexOf(sid);
  if (at >= 0) reviewQueue.splice(at, 1);
  if (reviewInFlight === sid) reviewInFlight = null;
  for (const [child, job] of backgroundReviewJobs) {
    if (job.parentId !== sid && child !== sid) continue;
    backgroundReviewJobs.delete(child);
    remember(retiredBackgroundReviews, child);
    void job.runtime.abortSession(child).catch(() => {});
  }
}

/** Longest error text written to debug.log. The diagnostic value is in the first
 *  sentence; some providers append an entire response body. */
const LOG_ERROR_MAX = 300;

/**
 * An error message made safe to persist in debug.log. Provider errors are echoed
 * verbatim from an HTTP response, so one could quote back the credential that
 * failed — and debug.log is a plain file users attach to bug reports, where a key
 * must never appear (AGENTS.md). Known key shapes go first, then any long
 * secret-looking run, then a length cap.
 */
export function redactForLog(message: string): string {
  const redacted = message
    .replace(/\b(sk|pk|rk|ghp|gho|ghs|github_pat|xoxb|xoxp|xapp|glpat|hf)[-_][A-Za-z0-9_-]{6,}/g, "$1-***")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 ***")
    .replace(/[A-Za-z0-9_-]{40,}/g, "***");
  return redacted.length > LOG_ERROR_MAX ? `${redacted.slice(0, LOG_ERROR_MAX)}…` : redacted;
}

/** The AI SDK's wording for a conversation it refused to send. One definition,
 *  because two places act on it: the error text explains it, and the thread
 *  follows it with a diagnosis of the stored history (#114). */
const MALFORMED_HISTORY = /do(es)? not match the ModelMessage\[\] schema/i;

/** How to name the provider an account-state failure belongs to. Zen is the
 *  built-in one and its id says nothing to the person who never chose it. */
function providerLabel(provider: string | undefined): string {
  if (!provider) return "the provider";
  return provider === ZEN_PROVIDER_ID ? "OpenCode Zen, the runtime's built-in provider" : provider;
}

/**
 * A runtime error with the one thing the user cannot work out alone appended.
 * Only for failures whose text is accurate but leaves no way forward — the
 * provider's own wording is always kept, never replaced.
 *
 * `action` is what the runtime said about the last failed attempt, when it said
 * anything (see RetryAction). It is the only trustworthy source for WHICH
 * provider ran out: the final error text names none, so matching text alone can
 * only speak for messages that are provably one provider's (#117).
 */
export function explainRuntimeError(message: string, action?: RetryAction): string {
  // Known cause, straight from the runtime — no guessing from wording.
  if (action?.reason === "free_tier_limit") {
    return (
      `${message} — the free allowance of ${providerLabel(action.provider)} is spent for this ` +
      `account; this is not a quota in this app. Pick a model from a provider you have your own ` +
      `key for in Settings → Models, or add credits.`
    );
  }
  if (action?.reason === "account_rate_limit") {
    return `${message} — until it resets, pick a model from another provider in Settings → Models.`;
  }
  // A dangling default model (its provider removed or renamed) fails every send
  // the same way — point at where the fix lives.
  if (/model not found/i.test(message)) {
    return `${message} Pick an available model in Settings → Models.`;
  }
  // OpenAI answers `invalid_prompt` / "Request blocked." when its content filter
  // rejects the PROMPT — and a prompt is the whole conversation, resent on every
  // turn. So "try again" reproduces it exactly (observed: three identical
  // failures in a row), which reads as the app being broken. The way out is to
  // stop resending the offending history, or to ask a provider that will take it.
  if (/^request blocked\.?$/i.test(message.trim())) {
    return (
      `${message} The provider's content filter rejected this conversation, not just your last message — ` +
      `every retry resends the same history, so it will keep failing. Edit or delete the recent messages, ` +
      `start a new session, or switch to another model or provider.`
    );
  }
  // The AI SDK rejects the whole conversation before any request goes out when
  // one stored part is missing a field the message format requires (#114). The
  // damage is on disk, so every retry resends it and fails identically.
  //
  // This deliberately no longer guesses a cause. It used to say "usually a tool
  // call left without its result", which we published and which is wrong: the
  // runtime backfills an interrupted tool call with a synthetic result, and
  // sessions carrying one keep working for hundreds of messages. The repair
  // block appended alongside this line names the actual part, read from the
  // stored history — a guess in the error text only sent people to delete
  // history that was fine.
  if (MALFORMED_HISTORY.test(message)) {
    return (
      `${message} One stored message in this session no longer has the shape the model requires, and ` +
      `every retry resends it — so retrying cannot work.`
    );
  }
  // The same two causes with no action to go by — a reloaded history, or an
  // error that arrived without one. Zen's free-tier message is a constant of the
  // runtime's own (`GO_UPSELL_MESSAGE`), so the whole sentence is proof of which
  // provider it is about; "free usage exceeded" alone would not be, and naming
  // Zen on some other provider's wording would be a confident lie. The reporter
  // of #117 filed this as the app's own quota being used up.
  if (/free usage exceeded, subscribe to go/i.test(message)) {
    return explainRuntimeError(message, { reason: "free_tier_limit", provider: ZEN_PROVIDER_ID });
  }
  if (/usage limit reached/i.test(message)) {
    return explainRuntimeError(message, { reason: "account_rate_limit" });
  }
  // The request never reached the provider: a DNS failure, a dropped TLS
  // connection, a VPN or proxy closing the socket. Distinct from a provider
  // error, and the user is the only one who can act on it.
  if (/^cannot connect to api\b/i.test(message.trim())) {
    return (
      `${message} The request did not reach the provider — check your network, VPN or proxy. ` +
      `The runtime already retried a few times before reporting this.`
    );
  }
  return message;
}

/** Server-side truth for "is this session's turn over": the last message is an
 *  assistant message that has finished streaming (time.completed set). A last
 *  USER message means a turn was accepted but not yet answered — still running. */
export function turnIsOver(messages: HistoryMessage[]): boolean {
  const last = messages[messages.length - 1];
  return !!last && last.role === "assistant" && !!last.completed;
}

/** Server truth that a session is mid-answer RIGHT NOW: its last message is an
 *  assistant message that has not finished streaming. Deliberately narrower
 *  than `!turnIsOver` — that also reads a trailing USER message as running, a
 *  shape a crashed or never-answered turn leaves behind for good, which would
 *  strand a permanent "Working…" on any session that reloads it (#59). */
export function turnStillStreaming(
  messages: HistoryMessage[],
  runtimeStartedAt?: number,
): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || last.completed || last.error) return false;
  // A turn streaming RIGHT NOW and one that was streaming when its runtime died
  // persist identically: assistant role, no `completed`, no `error`. Nothing in
  // the stored shape can separate them, so quitting the app mid-turn left that
  // session reading as "Working…" on every future load, forever — no error to
  // retry, no process to finish it. Liveness has to come from something that
  // dies with the process: a message created BEFORE the current runtime started
  // cannot be one the current runtime is producing.
  if (runtimeStartedAt && last.created && last.created < runtimeStartedAt) return false;
  return true;
}

/** Streamed events that prove a session's turn is still in flight. Any of them
 *  re-locks a session whose local running flag is missing — see the handler.
 *
 *  Every member is ASSISTANT progress. `message.agent` is deliberately absent
 *  even though it arrives mid-turn: the SDK emits it only for USER messages, so
 *  it cannot witness the assistant working — and OpenCode re-emits the turn's
 *  user message once the turn ENDS, about 40 ms after `session.idle`. Treating
 *  that as activity re-locked the session the instant it finished, leaving a
 *  spinner under a completed answer until `reconcileRunning` polled the server
 *  ~15 s later and rebuilt the whole thread to clear it (observed 62 times in one
 *  user's log). A turn started by ANOTHER client is still caught: by the events
 *  below once the assistant does anything, and by `turnStillStreaming` from
 *  server truth whenever the session is opened. */
const ACTIVITY_EVENTS: ReadonlySet<OpenCodeEvent["type"]> = new Set([
  "text.updated",
  "reasoning.updated",
  "step.updated",
  "tool.updated",
  "session.retry",
  "question.asked",
  "permission.asked",
]);

/** Last SSE arrival per session (monotonic sequence, not wall time). Lets a
 *  failed sync POST tell "the connection died but the turn is alive" (events
 *  kept arriving after the POST began) from "the send never took" — WKWebView
 *  kills any fetch at ~60 s, long before a long agent turn finishes. */
let sseSeq = 0;
const sseLast = new Map<string, number>();
/** When each session's async prompt POST returned, so the event handler can log
 *  first-token latency (see the multi-pane slow-first-token investigation). */
const turnPostAt = new Map<string, number>();

/** Coalescing for live bash output: a running tool emits an event per stdout
 *  write (a progress bar redraws dozens of times a second) — fold at most one
 *  partial-output update per interval per call, latest event wins. */
const LIVE_FOLD_MS = 250;
const liveFoldLast = new Map<string, number>();
const liveFoldPending = new Map<
  string,
  { sessionId: string; timer: number; event: Extract<OpenCodeEvent, { type: "tool.updated" }> }
>();

/** Drop a session's queued partial folds — when its turn ends (idle, error,
 *  interrupt) a late timer must not fold a stale "running" event into a
 *  thread the history reload may have rebuilt. */
function clearLiveFolds(sessionId: string) {
  for (const [callId, p] of liveFoldPending) {
    if (p.sessionId !== sessionId) continue;
    window.clearTimeout(p.timer);
    liveFoldPending.delete(callId);
    liveFoldLast.delete(callId);
  }
}

/** Resolve a (possibly nested) subagent session to its top-level session —
 *  a subagent's question/permission belongs to the conversation the user sees. */
/** Turn exactly one right-pane view on (and every other one off) for a pane.
 *  Turning a view off leaves the rest as they were. An open artifact is closed
 *  whenever a view opens — the pane shows one thing at a time. */
function showOnly(
  s: { panes: Record<string, PaneState>; currentId: string | null },
  sessionId: string | undefined,
  view: "showFiles" | "showRuns" | "showAgents",
  show: boolean,
): { panes: Record<string, PaneState> } {
  const key = sessionId ?? s.currentId ?? DRAFT_KEY;
  const p = s.panes[key];
  const base: PaneState = {
    artifact: show ? null : (p?.artifact ?? null),
    showFiles: false,
    showRuns: false,
    showAgents: false,
  };
  const next: PaneState = show
    ? { ...base, [view]: true }
    : {
        ...base,
        showFiles: p?.showFiles ?? false,
        showRuns: p?.showRuns ?? false,
        showAgents: p?.showAgents ?? false,
        [view]: false,
      };
  return { panes: { ...s.panes, [key]: next } };
}

export function rootSessionOf(parents: Record<string, string>, sessionId: string): string {
  let cur = sessionId;
  for (let hop = 0; parents[cur] && hop < 10; hop++) cur = parents[cur];
  return cur;
}

/** Does an interactive ask belong to the subtree an interrupt just stopped?
 *  Aborting a session takes its subagent sessions down with it — OpenCode's
 *  cancel walks the subtree — so their asks die with the parent's. */
function stoppedAsk(parents: Record<string, string>, stopped: string, askSession: string): boolean {
  return askSession === stopped || rootSessionOf(parents, askSession) === stopped;
}

type StoreSet = {
  (partial: Partial<RuntimeState>): void;
  (fn: (s: RuntimeState) => Partial<RuntimeState>): void;
};
type StoreGet = () => RuntimeState;

/**
 * The one send lifecycle (new → input → send → response), shared by plain
 * prompts, "!" shell commands and "/" slash commands:
 *   1. `echo` lands in the thread IMMEDIATELY — on a draft under DRAFT_KEY,
 *      grafted onto the real session id later, so the page never resets.
 *   2. `sending` is true from click until the POST is accepted (locks the
 *      composer); the session sits in `runningSessions` while the turn runs.
 *   3. Failures land as a red status line inside the conversation.
 * `syncTurn` marks endpoints whose POST resolves only when the turn is OVER
 * (shell/command, unlike prompt_async) — their running lock is set BEFORE the
 * POST and cleared when it settles, because session.idle arrives before the
 * POST resolves and a lock set afterwards would never clear.
 * `shell` additionally marks the turn in `shellTurns` for its duration, so
 * the event fold shows the bash output inline.
 */
async function performTurn(
  set: StoreSet,
  get: StoreGet,
  echo: string,
  post: (sid: string) => Promise<void>,
  syncTurn: boolean,
  shell = false,
  // Explicit target session. When omitted, the turn targets the focused session
  // (`currentId`) and may lazily CREATE it from the draft; when a real id is
  // given (a split pane sending to its own session), creation is skipped.
  target?: string,
  // The per-pane draft slot (`draft:<leafId>`) this send owns. When set, the
  // echo/lock/thread live under it and — if no target — the lazily-created
  // session is grafted FROM it, so each unbound tiled pane is fully independent
  // (its own draft, its own new session on first send) rather than sharing the
  // one global DRAFT_KEY. Legacy single-pane sends omit it → fall back to
  // currentId/DRAFT_KEY exactly as before.
  draftKey?: string,
): Promise<string | null> {
  if (!client) {
    set({ error: "Not connected to the OpenCode runtime." });
    return null;
  }
  // Where the draft's state is grafted from on lazy-create (this pane's own slot,
  // or the legacy global slot for a single-pane send).
  const draftSrc = draftKey ?? DRAFT_KEY;
  const echoKey = target ?? draftKey ?? get().currentId ?? DRAFT_KEY;
  if (get().sendingSessions[echoKey]) return null; // one send at a time per session
  // The lock is held under `echoKey`, but a draft's first send grafts DRAFT_KEY
  // onto the real id mid-turn — track the current key so the lock moves with it
  // (and the finally clears the right one).
  let lockKey = echoKey;
  // Goal mode's resume nudge is a turn the app sends on the session's behalf —
  // echoing it would put words in the user's mouth, and reloaded history hides
  // it too (historyToThread), so the live thread must agree.
  const showEcho = !isGoalInjectedPrompt(echo);
  set((s) => {
    const cur = s.threads[echoKey] ?? emptyThread();
    return {
      sending: true,
      sendingSessions: { ...s.sendingSessions, [echoKey]: true },
      threads: {
        ...s.threads,
        [echoKey]: {
          ...cur,
          loaded: true,
          blocks: showEcho ? [...cur.blocks, { kind: "user", text: echo }] : cur.blocks,
        },
      },
    };
  });
  try {
    // A draft-pane send (draftKey set) always creates its OWN session — never
    // borrow currentId, which may point at a different focused pane and would
    // race the focus effect. Only a legacy (no-draftKey) send reuses currentId.
    let id = target ?? (draftKey ? null : get().currentId);
    if (!id) {
      // Lazy-create the session on the first message (#3), in THIS draft's own
      // folder. A draft the user aimed at a project carries that folder; one
      // that does not gets its own fresh dated folder
      // (~/Documents/OpenScience/sessions/<date-time>) so its files never pile
      // up in the bare base folder.
      const chosen = isTauri ? get().draftWorkspaces[draftSrc] : undefined;
      if (isTauri) {
        set({ switching: true });
        try {
          if (!chosen) {
            await newDatedWorkspace(datedWorkspaceName());
            await kernelReset().catch(() => {});
          } else if (chosen !== get().workspace) {
            // The active folder wandered off — opening any session follows it
            // into that session's folder. Go back to the one this draft was
            // aimed at, or the session lands wherever the user last looked (#69).
            await setWorkspace(chosen);
            await kernelReset().catch(() => {});
          }
          // Always rebuild the scoped client: /new and /clear keep the folder,
          // but the old session route may have just torn down directory-scoped
          // SSE, and a first send must not hang on a stale workspace instance.
          await get().connectRetry();
        } finally {
          set({ switching: false });
        }
        if (get().status !== "ready" || !client) {
          throw new Error("Runtime did not reconnect before creating the session.");
        }
      }
      id = await withRetry(() => client!.createSession());
      set((s) => {
        // Graft this pane's draft conversation (and its pane state) from its own
        // slot (`draftSrc`) onto the real session id.
        const threads = { ...s.threads, [id!]: s.threads[draftSrc] ?? emptyThread() };
        delete threads[draftSrc];
        const panes = { ...s.panes };
        if (panes[draftSrc]) {
          panes[id!] = panes[draftSrc];
          delete panes[draftSrc];
        }
        const sessionAgents = { ...s.sessionAgents };
        if (sessionAgents[draftSrc]) {
          sessionAgents[id!] = sessionAgents[draftSrc];
          delete sessionAgents[draftSrc];
        }
        // The destination has done its job: the session now carries its own
        // folder. Leaving the entry would silently aim this pane's NEXT draft
        // at the same project long after the user moved on.
        const { draftWorkspaces = s.draftWorkspaces } = forgetDraftFolder(s, draftSrc);
        // Move the in-flight send lock too, so a pane keyed on the new id (the
        // draft pane follows currentId onto the real session) still reads itself
        // as sending across the graft — no flicker to an unlocked composer.
        const sendingSessions = { ...s.sendingSessions };
        if (sendingSessions[draftSrc]) {
          sendingSessions[id!] = sendingSessions[draftSrc];
          delete sendingSessions[draftSrc];
        }
        // Carry the draft's per-pane model/effort override onto the real session.
        const sessionModels = { ...s.sessionModels };
        if (sessionModels[draftSrc]) {
          sessionModels[id!] = sessionModels[draftSrc];
          delete sessionModels[draftSrc];
        }
        const sessionVariants = { ...s.sessionVariants };
        if (sessionVariants[draftSrc] !== undefined) {
          sessionVariants[id!] = sessionVariants[draftSrc];
          delete sessionVariants[draftSrc];
        }
        return {
          currentId: id,
          threads,
          panes,
          sessionAgents,
          sendingSessions,
          sessionModels,
          sessionVariants,
          draftWorkspaces,
        };
      });
      lockKey = id;
      // A fresh ACP session reports the agent's own selectors — surface them.
      syncAcpConfig(set, id);
      // The draft's model/effort override moved onto the real id — repersist so
      // a relaunch restores this pane's model, not the global default.
      saveRecord(SESSION_MODELS_KEY, get().sessionModels);
      saveRecord(SESSION_VARIANTS_KEY, get().sessionVariants);
      moveScrollMemory(`chat:${draftSrc}`, `chat:${id}`);
      void get().refreshSessions();
    }
    const sid = id;
    interruptedSessions.delete(sid); // a fresh turn folds its events normally
    void logDebug(`turn → ${sid}`);
    // A fresh turn restarts step counting (the SDK resets its own counter on idle).
    if (get().stepCounts[sid])
      set((s) => {
        const stepCounts = { ...s.stepCounts };
        delete stepCounts[sid];
        return { stepCounts };
      });
    if (syncTurn) {
      set((s) => ({
        runningSessions: { ...s.runningSessions, [sid]: true },
        ...(shell ? { shellTurns: { ...s.shellTurns, [sid]: true as const } } : {}),
      }));
      const mark = sseSeq;
      try {
        await post(sid);
      } catch (err) {
        // The POST rejected — but shell/command POSTs are held open for the
        // WHOLE turn, and WKWebView kills any fetch at ~60 s. If SSE kept
        // streaming this session since the POST began, the turn is alive
        // server-side: keep the running lock (session.idle or a session error
        // will clear it) and don't report a failure that didn't happen.
        if ((sseLast.get(sid) ?? 0) > mark) {
          void logDebug(`turn POST dropped mid-turn, still running → ${sid}`);
          return sid;
        }
        // A genuinely failed POST produces no events — drop both flags here.
        // (On success the session.idle event clears the shell flag, never the
        // POST settling: SSE frames and the POST response race on separate
        // connections, and the bash-output event may land after the POST
        // resolves.)
        set((s) => {
          const runningSessions = { ...s.runningSessions };
          const shellTurns = { ...s.shellTurns };
          delete runningSessions[sid];
          delete shellTurns[sid];
          return { runningSessions, shellTurns };
        });
        throw err;
      }
      set((s) => {
        const runningSessions = { ...s.runningSessions };
        delete runningSessions[sid];
        return { runningSessions };
      });
    } else {
      // Timing probe (concurrent multi-pane first-token investigation): how long
      // the server takes to ACCEPT the async prompt, and — via turnPostAt, read
      // in the event handler — how long until the first streamed token. A slow
      // POST points at a cold/locked directory instance; a fast POST but slow
      // first token points at model/provider or server turn processing.
      const t0 = performance.now();
      void logDebug(`send POST → ${sid} (streams=${streamClients.size})`);
      await post(sid);
      void logDebug(`send POST ok ${sid} ${Math.round(performance.now() - t0)}ms`);
      turnPostAt.set(sid, performance.now());
      set((s) => ({ runningSessions: { ...s.runningSessions, [sid]: true } }));
    }
    void logDebug("turn OK");
    return sid;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void logDebug(`turn FAILED: ${msg}`);
    // The failure belongs next to the message that caused it.
    const key = target ?? draftKey ?? get().currentId ?? DRAFT_KEY;
    set((s) => {
      const cur = s.threads[key] ?? emptyThread();
      return {
        error: msg,
        threads: {
          ...s.threads,
          [key]: {
            ...cur,
            loaded: true,
            blocks: [...cur.blocks, { kind: "status-line", text: `Send failed: ${msg}`, tone: "error" }],
          },
        },
      };
    });
    return target ?? get().currentId;
  } finally {
    // Clear the lock under its CURRENT key (`lockKey` follows the draft→session
    // graft, so this never leaks a stale DRAFT_KEY lock).
    set((s) => {
      const sendingSessions = { ...s.sendingSessions };
      delete sendingSessions[lockKey];
      return { sendingSessions, sending: Object.keys(sendingSessions).length > 0 };
    });
  }
}

/** Take `sid` and its coalesced changed-file scope out of the review queue. */
function dequeueReview(sid: string): string[] | null {
  const at = reviewQueue.indexOf(sid);
  if (at < 0) return null;
  reviewQueue.splice(at, 1);
  return takePaths(queuedReviewPaths, sid);
}

function reviewFence(review: ReviewerBlock): string {
  return `\`\`\`review\n${JSON.stringify({ findings: review.findings, note: review.note })}\n\`\`\``;
}

function backgroundReviewPartId(reviewSid: string): string {
  const time = (BigInt(Date.now()) * 0x1000n).toString(16).padStart(12, "0").slice(-12);
  const suffix = reviewSid.replace(/[^A-Za-z0-9]/g, "").slice(-14).padStart(14, "0");
  return `prt_${time}${suffix}`;
}

/** Move one hidden review's structured result onto its parent checkpoint. The
 *  synthetic part persists with the parent but starts no model turn, so it is
 *  visible after reload and becomes context for the parent's next turn. */
function finishAutoReview(
  set: StoreSet,
  get: StoreGet,
  reviewSid: string,
  completed: boolean,
): boolean {
  const job = backgroundReviewJobs.get(reviewSid);
  if (!job) return false;
  backgroundReviewJobs.delete(reviewSid);
  remember(retiredBackgroundReviews, reviewSid);
  if (reviewInFlight === job.parentId) reviewInFlight = null;

  const cancelled = cancelledBackgroundReviews.delete(reviewSid);
  const blocks = get().threads[reviewSid]?.blocks ?? [];
  const emitted = [...blocks].reverse().find((block): block is ReviewerBlock => block.kind === "reviewer");
  const result = cancelled
    ? null
    : emitted ?? {
        kind: "reviewer" as const,
        findings: [],
        note: completed
          ? "Background review finished without a structured result."
          : "Background review could not complete; no findings were recorded.",
      };
  const partId = backgroundReviewPartId(reviewSid);
  if (result) remember(backgroundReviewResultParts, `${job.parentId}:${partId}`);

  set((s) => {
    const backgroundReviews = { ...s.backgroundReviews };
    delete backgroundReviews[job.parentId];
    const sessionParents = { ...s.sessionParents };
    delete sessionParents[reviewSid];
    const threads = { ...s.threads };
    delete threads[reviewSid];
    const runningSessions = { ...s.runningSessions };
    const stepCounts = { ...s.stepCounts };
    const retryNotices = { ...s.retryNotices };
    const shellTurns = { ...s.shellTurns };
    delete runningSessions[reviewSid];
    delete stepCounts[reviewSid];
    delete retryNotices[reviewSid];
    delete shellTurns[reviewSid];
    if (result) {
      const parent = threads[job.parentId] ?? emptyThread();
      const blocks = [...parent.blocks];
      let insertAt = blocks.length;
      if (job.checkpointUserMessageId) {
        const checkpointUserAt = blocks.findIndex(
          (block) =>
            block.kind === "user" && block.messageID === job.checkpointUserMessageId,
        );
        if (checkpointUserAt >= 0) {
          const nextUserAt = blocks.findIndex(
            (block, index) => index > checkpointUserAt && block.kind === "user",
          );
          if (nextUserAt >= 0) insertAt = nextUserAt;
        }
      }
      blocks.splice(insertAt, 0, result);
      const index = Object.fromEntries(
        Object.entries(parent.index).map(([key, value]) => [
          key,
          value >= insertAt ? value + 1 : value,
        ]),
      );
      index[`review:${partId}`] = insertAt;
      threads[job.parentId] = {
        ...parent,
        blocks,
        index,
        loaded: true,
      };
    }
    return {
      backgroundReviews,
      sessionParents,
      threads,
      runningSessions,
      stepCounts,
      retryNotices,
      shellTurns,
      questions: s.questions.filter((question) => question.sessionId !== reviewSid),
      permissions: s.permissions.filter((permission) => permission.sessionId !== reviewSid),
      sessions: s.sessions.filter((session) => session.id !== reviewSid),
    };
  });

  if (result) {
    void job.runtime
      .appendTextPart(job.parentId, job.checkpointMessageId, reviewFence(result), partId)
      .catch((err) =>
        logDebug(
          `auto-review result not persisted: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }
  drainReviewQueue(set, get);
  return true;
}

/** Release a review that was cancelled while its hidden fork was still being
 * prepared. A later queued review may start only if auto-review is still on. */
function releaseAutoReviewReservation(set: StoreSet, get: StoreGet, sid: string): void {
  if (reviewInFlight === sid) reviewInFlight = null;
  set((s) => {
    const backgroundReviews = { ...s.backgroundReviews };
    delete backgroundReviews[sid];
    return { backgroundReviews };
  });
  drainReviewQueue(set, get);
}

/** Run the reviewer in a hidden fork of the completed parent checkpoint. The
 *  parent remains idle and usable while this independent session streams. */
async function startAutoReview(
  set: StoreSet,
  get: StoreGet,
  sid: string,
  paths: string[],
): Promise<void> {
  const runtime = clientForSession(get, sid);
  if (!runtime) {
    drainReviewQueue(set, get);
    return;
  }
  reviewInFlight = sid;
  set((s) => ({
    backgroundReviews: { ...s.backgroundReviews, [sid]: "running" },
  }));
  let reviewSid: string | null = null;
  try {
    const messages = await runtime.getMessages(sid);
    let checkpointAt = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "assistant" && messages[i]?.id) {
        checkpointAt = i;
        break;
      }
    }
    const checkpoint = checkpointAt >= 0 ? messages[checkpointAt]?.id : undefined;
    if (!checkpoint) throw new Error("The completed checkpoint has no assistant message id");
    // Fork's boundary is exclusive. A newer user message may already exist if
    // the foreground continued immediately; stop before it so the completed
    // assistant checkpoint is included and the newer turn is not.
    const boundary = messages.slice(checkpointAt + 1).find((message) => !!message.id)?.id;
    let checkpointUserMessageId: string | undefined;
    for (let i = checkpointAt - 1; i >= 0; i--) {
      if (messages[i]?.role === "user" && messages[i]?.id) {
        checkpointUserMessageId = messages[i]!.id;
        break;
      }
    }
    if (!get().autoReview || reviewInFlight !== sid) {
      releaseAutoReviewReservation(set, get, sid);
      return;
    }

    // Forking gives the reviewer the completed plan, prompts and response while
    // keeping its reasoning/tools out of the foreground transcript.
    reviewSid = await runtime.forkSession(sid, boundary);
    if (!get().autoReview || reviewInFlight !== sid) {
      void runtime.abortSession(reviewSid).catch(() => {});
      releaseAutoReviewReservation(set, get, sid);
      return;
    }
    backgroundReviewJobs.set(reviewSid, {
      parentId: sid,
      checkpointMessageId: checkpoint,
      checkpointUserMessageId,
      runtime,
      paths,
    });
    const parent = get().sessions.find((session) => session.id === sid);
    set((s) => ({
      sessionParents: { ...s.sessionParents, [reviewSid!]: sid },
      sessions: s.sessions.some((session) => session.id === reviewSid)
        ? s.sessions
        : [
            ...s.sessions,
            {
              id: reviewSid!,
              title: "Background review",
              parentId: sid,
              directory: parent?.directory,
              created: Date.now(),
              updated: Date.now(),
            },
          ],
    }));
    void runtime.renameSession(reviewSid, "Background review").catch(() => {});
    await runtime.setSessionArchived(reviewSid, true).catch((err) =>
      logDebug(
        `auto-review child not archived: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    // No model or effort is passed on purpose: the reviewer's own model and
    // reasoning effort come from its per-agent config (#71), and an explicit
    // per-turn model would override exactly that setting.
    await runtime.sendPrompt(reviewSid, autoReviewPrompt(paths), REVIEWER_AGENT);
    void logDebug(`auto-review ${reviewSid} → ${sid}`);
  } catch (err) {
    void logDebug(`auto-review failed: ${err instanceof Error ? err.message : String(err)}`);
    if (reviewSid && finishAutoReview(set, get, reviewSid, false)) return;
    if (reviewInFlight === sid) reviewInFlight = null;
    set((s) => {
      const backgroundReviews = { ...s.backgroundReviews };
      delete backgroundReviews[sid];
      return { backgroundReviews };
    });
    drainReviewQueue(set, get);
  }
}

/** Start the next waiting review, if the single slot is free. */
function drainReviewQueue(set: StoreSet, get: StoreGet): void {
  if (!get().autoReview) {
    const queued = reviewQueue.splice(0);
    queuedReviewPaths.clear();
    if (queued.length > 0) {
      set((s) => {
        const backgroundReviews = { ...s.backgroundReviews };
        for (const sid of queued) delete backgroundReviews[sid];
        return { backgroundReviews };
      });
    }
    return;
  }
  if (reviewInFlight) return;
  const next = reviewQueue.shift();
  if (next) void startAutoReview(set, get, next, takePaths(queuedReviewPaths, next));
}

/**
 * Auto-review bookkeeping for one `session.idle`. `reviewable` is false when the
 * turn ended in a user interrupt: there is nothing to review, but the slot still
 * has to be released if the interrupted turn WAS the review.
 */
function onTurnIdle(set: StoreSet, get: StoreGet, sid: string, reviewable: boolean): void {
  // Before any of the early returns below. A turn settling is exactly when the
  // mirror is worth refreshing, and both of those returns are ordinary paths —
  // with auto-review on, the normal turn takes one of them, so scheduling at
  // the end of this function meant sync never ran for those users at all.
  scheduleConversationSync(get);
  if (finishAutoReview(set, get, sid, reviewable)) return;
  // This turn's own changes are settled either way, so clear them. A review the
  // session was already OWED is different: the files that earned it are on disk
  // whether or not this turn touched anything, so its queue entry is consumed
  // only on an idle that can actually act on it — otherwise an interrupted or
  // errored turn silently cancels a review earned by an earlier one.
  const dirty = dirtyTurns.delete(sid);
  const paths = takePaths(dirtyTurnPaths, sid);
  // Both are consumed, never one or the other: `dirty || dequeueReview(sid)`
  // short-circuits, so a session that was dirty AND already owed a review kept
  // its queue entry — and the moment that review ended early (interrupted, or
  // dead server-side) the drain turned the leftover into a second paid review of
  // the same state.
  const owed = reviewable ? dequeueReview(sid) : null;
  const changedFiles = reviewable && (dirty || owed !== null);
  const scope = [...new Set([...paths, ...(owed ?? [])])];
  const s = get();
  if (
    reviewable &&
    shouldAutoReview({
      enabled: s.autoReview,
      changedFiles,
      wasReview: false,
      isSubagent: !!s.sessionParents[sid],
      hasReviewer: s.agents.some((a) => a.name === REVIEWER_AGENT),
    })
  ) {
    // The queue is the SET of sessions owed a review, so an id already waiting
    // must not be added twice: each duplicate survives the drain that started
    // its review and becomes a second, redundant paid review of the same state.
    if (reviewInFlight) {
      if (!reviewQueue.includes(sid)) reviewQueue.push(sid);
      mergePaths(queuedReviewPaths, sid, scope);
      set((state) => ({
        backgroundReviews: state.backgroundReviews[sid]
          ? state.backgroundReviews
          : { ...state.backgroundReviews, [sid]: "queued" },
      }));
    } else void startAutoReview(set, get, sid, scope);
    return;
  }
}

/** Mirror conversations out once a turn has settled (#124). Debounced and
 *  fire-and-forget: sync is a background convenience, so it must never delay a
 *  turn, and a failure belongs in the Settings card rather than over the
 *  conversation the user is reading. A no-op until a folder is chosen. */
let syncTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleConversationSync(get: StoreGet): void {
  if (!syncDir()) return;
  if (syncTimer) clearTimeout(syncTimer);
  // A burst of turns (subagents settling one after another) is one pass, not
  // one per session: each pass spawns a process per changed conversation.
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void runSync(get().sessions.map((s) => ({ id: s.id, updated: s.updated }))).catch(() => {});
  }, 4_000);
}

/** Shared core of the two destructive "go back to a past message" actions
 *  (edit-and-resend, and plain revert): stop any running turn, revert the
 *  session to `messageID` — OpenCode drops it and every later message and rolls
 *  back the files those turns changed — then mirror that truncation in the
 *  local thread. Returns whether the revert succeeded. OpenCode rejects a
 *  revert on a busy session, so the abort's trailing session.idle is given a
 *  few short retries to land first. */
async function revertToMessage(
  set: StoreSet,
  get: StoreGet,
  messageID: string,
  sessionId?: string,
): Promise<boolean> {
  const sid = sessionId ?? get().currentId;
  if (!sid || !client) return false;
  const c = client;
  if (get().runningSessions[sid]) await get().interrupt(sid);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await c.revert(sid, messageID);
      break;
    } catch (e) {
      if (attempt === 4) {
        set({ error: e instanceof Error ? e.message : "Failed to revert the message." });
        return false;
      }
      await sleep(200);
    }
  }
  set((s) => {
    const cur = s.threads[sid];
    if (!cur) return {};
    const idx = cur.blocks.findIndex((b) => b.kind === "user" && b.messageID === messageID);
    if (idx < 0) return {};
    return { threads: { ...s.threads, [sid]: { ...cur, blocks: cur.blocks.slice(0, idx) } } };
  });
  return true;
}

/** The repair offer for a history the model refused (#114): the earliest part
 *  that would fail validation, and the message to roll back to. A scan that
 *  recognizes nothing still produces a block — saying "we could not identify
 *  which message" is the honest answer, and silence would read as the app
 *  having nothing to say. */
function historyRepairBlock(messages: HistoryMessage[]): ThreadBlock {
  const [defect] = findHistoryDefects(messages);
  const target = defect ? repairTarget(messages, defect) : undefined;
  return {
    kind: "history-repair",
    ...(defect ? { reason: defect.reason } : {}),
    ...(defect?.tool ? { tool: defect.tool } : {}),
    ...(target
      ? { target: { messageID: target.messageID, text: target.text }, drops: target.drops }
      : {}),
  };
}

/** A live turn was rejected because the stored history is no longer a valid
 *  message list. Read that history back and append the repair offer under the
 *  error line already on screen — the diagnosis needs a round trip, and the
 *  failure must be reported the instant it happens rather than when a fetch
 *  finishes. (A reopened session takes the `historyToThread` path instead,
 *  which already holds the messages.) */
async function diagnoseMalformedHistory(set: StoreSet, sid: string): Promise<void> {
  const c = client;
  if (!c) return;
  let messages: HistoryMessage[];
  try {
    messages = await c.getMessages(sid);
  } catch {
    // The runtime is unreachable; the error line already said what failed, and
    // a second failure notice here would only add noise.
    return;
  }
  const block = historyRepairBlock(messages);
  set((s) => {
    const cur = s.threads[sid];
    if (!cur) return {};
    // The turn may have been repaired, reverted or superseded while the history
    // was in flight; only offer a repair on a thread that still ends in the
    // failure this was called for.
    const last = cur.blocks[cur.blocks.length - 1];
    if (last?.kind !== "status-line" || last.tone !== "error") return {};
    // Retrying fails identically, so a second failure must not stack a second
    // card: drop any earlier offer and keep this one, beside the newest error.
    const blocks = cur.blocks.filter((b) => b.kind !== "history-repair");
    return { threads: { ...s.threads, [sid]: { ...cur, blocks: [...blocks, block] } } };
  });
}

/** The live OpenCode client (Settings talks to the runtime's config API directly). */
export function getClient(): OpenCodeClient | null {
  return opencodeClient;
}

/** The reasoning variant to send with a turn: the user's pick, but only when the
 *  current default model actually exposes it. Variant vocabularies differ per
 *  model (OpenAI has "minimal", Anthropic has "max", many models have none), so
 *  switching to a model without the chosen level cleanly sends nothing and lets
 *  OpenCode apply that model's default effort. */
function variantExposed(
  providers: RuntimeState["providers"],
  model: string | null,
  variant: string | null | undefined,
): string | undefined {
  if (!variant || !model) return undefined;
  const i = model.indexOf("/");
  if (i <= 0) return undefined;
  const m = providers
    .find((p) => p.id === model.slice(0, i))
    ?.models.find((mm) => mm.id === model.slice(i + 1));
  return m?.variants?.includes(variant) ? variant : undefined;
}
/** OpenCode's primary agent when the composer is not in plan mode. */
export const PRIMARY_AGENT = "build";

/**
 * Which agent will actually run this pane's next turn, or null when the catalog
 * has no such agent (an older or custom sidecar). Null means nothing may be
 * inferred from a per-agent setting, so the caller keeps sending the model.
 */
export function agentForTurn(
  state: Pick<RuntimeState, "sessionAgents" | "agents">,
  key: string,
): string | null {
  const name = state.sessionAgents[key] === "plan" ? "plan" : PRIMARY_AGENT;
  return state.agents.some((a) => a.name === name) ? name : null;
}

/** The model + reasoning effort for a session's turn: its own per-pane override
 *  if set, else a configured agent model (#96), else the global default. */
function modelForSession(state: RuntimeState, key: string): { model: string | null; variant: string | undefined } {
  // An agent carrying its own configured model OWNS the turn: sending an
  // explicit per-turn model would override exactly that setting, which is why
  // the `build` row used to do nothing and Plan mode ignored its own model
  // (#96). Only a model picked in THIS conversation outranks it — the same rule
  // the background reviewer already relied on by passing no model at all.
  if (!state.sessionModels[key]) {
    const agent = agentForTurn(state, key);
    if (agent && state.agentModels[agent]) return { model: null, variant: undefined };
  }
  const model = state.sessionModels[key] ?? state.defaultModel;
  const variant = variantExposed(
    state.providers,
    model,
    state.sessionVariants[key] !== undefined ? state.sessionVariants[key] : state.reasoningVariant,
  );
  return { model, variant };
}

/** Context window of the model a session's next turn will actually use, or 0
 *  when nothing knows it.
 *
 *  Deliberately NOT `modelForSession` — that returns `model: null` when a
 *  configured agent owns the model, which is the right thing to SEND and the
 *  wrong thing to look a context window up by. Here the question is only which
 *  model string is in force, so the agent's own setting is resolved instead of
 *  collapsed to null. 0 means unknown (see `ProviderModelInfo.contextLimit`);
 *  callers show tokens without a percentage rather than inventing a limit. */
export function contextLimitFor(state: RuntimeState, key: string): number {
  const agent = agentForTurn(state, key);
  const model =
    state.sessionModels[key] ?? (agent ? state.agentModels[agent] : undefined) ?? state.defaultModel;
  if (!model) return 0;
  const i = model.indexOf("/");
  if (i <= 0) return 0;
  const [providerId, modelId] = [model.slice(0, i), model.slice(i + 1)];
  const found = state.providers
    .find((p) => p.id === providerId)
    ?.models.find((m) => m.id === modelId);
  return found?.contextLimit ?? 0;
}

export const useRuntimeStore = create<RuntimeState>((set, get) => ({
  // The shell dials the runtime the moment it mounts, so on a real launch
  // "connecting" is already true at the first frame — starting at "offline"
  // flashed the "no runtime, run opencode serve" card for as long as the
  // sidecar took to spawn, every time the app was opened. Plain browser dev
  // (no Tauri, no gateway) has nothing to dial and keeps that card.
  status: isTauri || isGatewayWeb ? "connecting" : "offline",
  serverUrl: initialUrl(),
  // Reconciled with the saved selection on every connect; OpenCode until then,
  // which is what a first paint before any connection is actually driving.
  runtimeKind: "opencode",
  acpAgentName: null,
  acpConfigOptions: {},
  setAcpConfigOption: async (sessionId, configId, value) => {
    const rt = acpRuntime;
    if (!rt || client !== rt) return;
    try {
      const options = await rt.setConfigOption(sessionId, configId, value);
      set((s) => ({ acpConfigOptions: { ...s.acpConfigOptions, [sessionId]: options } }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
  sessions: [],
  currentId: null,
  threads: {},
  skills: [],
  agents: [],
  agentModels: {},
  agentVariants: {},
  commands: [],
  defaultModel: null,
  providers: [],
  reasoningVariant: initialReasoningVariant(),
  setReasoningVariant: (variant) => {
    if (typeof window !== "undefined") {
      if (variant) window.localStorage.setItem(REASONING_KEY, variant);
      else window.localStorage.removeItem(REASONING_KEY);
    }
    set({ reasoningVariant: variant });
  },
  autoReview: initialAutoReview(),
  setAutoReview: (enabled) => {
    if (typeof window !== "undefined") {
      if (enabled) window.localStorage.setItem(AUTO_REVIEW_KEY, "1");
      else window.localStorage.removeItem(AUTO_REVIEW_KEY);
    }
    set({ autoReview: enabled });
    if (!enabled) {
      // "Off" is immediate: discard work that has not started and abort the
      // one hidden reviewer that may currently hold the global slot.
      const pending = new Set([...reviewQueue, ...Object.keys(get().backgroundReviews)]);
      for (const sid of pending) get().cancelAutoReview(sid);
      drainReviewQueue(set, get);
    }
  },
  backgroundReviews: {},
  cancelAutoReview: (sessionId) => {
    const queuedAt = reviewQueue.indexOf(sessionId);
    if (queuedAt >= 0) reviewQueue.splice(queuedAt, 1);
    queuedReviewPaths.delete(sessionId);
    const active = [...backgroundReviewJobs.entries()].find(
      ([, job]) => job.parentId === sessionId,
    );
    if (active) {
      const [reviewSid, job] = active;
      cancelledBackgroundReviews.add(reviewSid);
      void job.runtime.abortSession(reviewSid).then(
        () => finishAutoReview(set, get, reviewSid, false),
        () => finishAutoReview(set, get, reviewSid, false),
      );
    } else if (reviewInFlight === sessionId) {
      // The fork is still being created. Clearing the reservation makes
      // startAutoReview abort it as soon as the id arrives.
      reviewInFlight = null;
      drainReviewQueue(set, get);
    }
    set((s) => {
      const backgroundReviews = { ...s.backgroundReviews };
      delete backgroundReviews[sessionId];
      return { backgroundReviews };
    });
  },
  modelSwitchError: null,
  modelSwitching: false,
  approvalMode: "approve",
  tools: [],
  hiddenExamples: initialHidden(),
  error: null,
  questions: [],
  permissions: [],
  sessionParents: {},
  panes: {},
  sessionAgents: {},
  sessionModels: loadRecord<string>(SESSION_MODELS_KEY),
  sessionVariants: loadRecord<string | null>(SESSION_VARIANTS_KEY),
  setSessionModel: (sessionId, model) =>
    set((s) => {
      const sessionModels = { ...s.sessionModels, [sessionId]: model };
      saveRecord(SESSION_MODELS_KEY, sessionModels);
      return { sessionModels };
    }),
  clearSessionModel: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.sessionModels)) return {};
      const sessionModels = { ...s.sessionModels };
      delete sessionModels[sessionId];
      saveRecord(SESSION_MODELS_KEY, sessionModels);
      // The effort was picked FOR that model, so it goes with it.
      const sessionVariants = { ...s.sessionVariants };
      delete sessionVariants[sessionId];
      saveRecord(SESSION_VARIANTS_KEY, sessionVariants);
      return { sessionModels, sessionVariants };
    }),
  setSessionVariant: (sessionId, variant) =>
    set((s) => {
      const sessionVariants = { ...s.sessionVariants, [sessionId]: variant };
      saveRecord(SESSION_VARIANTS_KEY, sessionVariants);
      return { sessionVariants };
    }),
  setAgentMode: (mode, sessionId) =>
    set((s) => ({ sessionAgents: { ...s.sessionAgents, [sessionId ?? s.currentId ?? DRAFT_KEY]: mode } })),
  projects: [],
  workspace: null,
  webWorkspace: null,
  webReadOnly: false,
  draftWorkspaces: {},
  switching: false,
  sending: false,
  sendingSessions: {},
  runningSessions: {},
  stepCounts: {},
  shellTurns: {},
  retryNotices: {},
  runtimeStartedAt: 0,

  // These write the CURRENT session's pane (DRAFT_KEY on a draft), keeping the
  // artifact inspector, the Files browser, and the Runs pane mutually exclusive
  // — one pane at a time.
  openArtifact: (artifact, sessionId) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [sessionId ?? s.currentId ?? DRAFT_KEY]: {
          artifact,
          showFiles: false,
          showRuns: false,
          showAgents: false,
        },
      },
    })),
  closeArtifact: (sessionId) =>
    set((s) => {
      const key = sessionId ?? s.currentId ?? DRAFT_KEY;
      const p = s.panes[key];
      return {
        panes: {
          ...s.panes,
          [key]: {
            artifact: null,
            showFiles: p?.showFiles ?? false,
            showRuns: p?.showRuns ?? false,
            showAgents: p?.showAgents ?? false,
          },
        },
      };
    }),
  // The right pane holds ONE thing: opening any view closes the others.
  setShowFiles: (show, sessionId) => set((s) => showOnly(s, sessionId, "showFiles", show)),
  setShowRuns: (show, sessionId) => set((s) => showOnly(s, sessionId, "showRuns", show)),
  setShowAgents: (show, sessionId) => set((s) => showOnly(s, sessionId, "showAgents", show)),

  answerQuestion: async (requestId, answers) => {
    const q = get().questions.find((x) => x.requestId === requestId);
    if (!q) return;
    // Route to the client whose folder owns the asking session (a split pane in
    // another project has its own directory-scoped instance).
    const c = clientForSession(get, q.sessionId);
    if (!c) return;
    set((s) => ({ questions: s.questions.filter((x) => x.requestId !== requestId) }));
    try {
      await c.answerQuestion(requestId, answers);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
  rejectQuestion: async (requestId) => {
    const q = get().questions.find((x) => x.requestId === requestId);
    if (!q) return;
    const c = clientForSession(get, q.sessionId);
    if (!c) return;
    set((s) => ({ questions: s.questions.filter((x) => x.requestId !== requestId) }));
    try {
      await c.rejectQuestion(requestId);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
  replyPermission: async (requestId, reply) => {
    const p = get().permissions.find((x) => x.requestId === requestId);
    if (!p) return;
    const c = clientForSession(get, p.sessionId);
    if (!c) return;
    // Identical pending asks (same session, action and resources — e.g. three
    // parallel reads into one folder) are ONE question to the user: answer
    // them all with one click instead of re-asking for each tool call.
    const sig = (x: PermissionAskedEvent) =>
      `${x.sessionId}|${x.action}|${x.resources.join("|")}`;
    const batch = get().permissions.filter((x) => sig(x) === sig(p));
    set((s) => ({ permissions: s.permissions.filter((x) => sig(x) !== sig(p)) }));
    const results = await Promise.allSettled(
      batch.map((x) => c.replyPermission(x.requestId, reply)),
    );
    // A 404 means that request is already resolved — the turn moved on, or a
    // duplicate in this batch was answered by the same click. The user's answer
    // landed; reporting it as a failure just alarms them about nothing. Only a
    // real failure, and only if it is not merely a stale sibling, surfaces.
    const failed = results.find(
      (r) => r.status === "rejected" && !isApiStatus(r.reason, 404),
    ) as PromiseRejectedResult | undefined;
    if (failed) {
      const err = failed.reason;
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  setServerUrl: (serverUrl) => {
    if (typeof window !== "undefined") window.localStorage.setItem(URL_KEY, serverUrl);
    set({ serverUrl, modelSwitchError: null });
  },

  reloadRuntimeConfig: async (apply) => {
    set({ switching: true });
    try {
      await apply();
      await get().connectRetry();
      await get().loadCatalog();
    } finally {
      set({ switching: false });
    }
  },

  refreshAgentModels: async () => {
    // Desktop-only config (the helpers answer {} in the browser). Never worth
    // failing a connect over: an unreadable config just means "no overrides",
    // and the send then keeps passing an explicit model, which is the old
    // behavior rather than a broken one.
    try {
      const [agentModels, agentVariants] = await Promise.all([
        getAgentModels(),
        getAgentVariants(),
      ]);
      set({ agentModels, agentVariants });
    } catch {
      /* leave whatever we already had */
    }
  },

  loadCatalog: async () => {
    if (!client) return;
    const run = (async () => {
    void get().refreshAgentModels();
    try {
      const [firstSkills, agents, defaultModel, commands, providers] = await Promise.all([
        client.listSkills(),
        client.listAgents(),
        client.getDefaultModel().catch(() => null),
        client.listCommands().catch(() => []),
        // listProviders is OpenCodeClient-only (not on the AgentRuntime port);
        // opencodeClient is the same instance as `client`, set together.
        opencodeClient
          ? listProvidersWithAvailability(opencodeClient).catch(() => [])
          : Promise.resolve([]),
      ]);
      // A model switch in flight owns `defaultModel`: this read may predate
      // the switch's config write, and applying it would visibly revert the
      // just-selected model.
      set(
        get().switching
          ? { agents, commands, providers }
          : { agents, defaultModel, commands, providers },
      );
      // Self-heal a dangling default model. It can go stale out-of-band — its
      // provider removed, its id renamed, or the config edited outside the app
      // — and then every send fails with "model not found". Settings only
      // re-points it after a provider action, which never runs while the user
      // is just chatting, so heal it here (loadCatalog runs on every connect).
      // Skip while switching (a switch owns the model); an empty providers list
      // (transient read failure) yields no fallback, so it stays untouched. Also
      // skip a model the user just deliberately switched to (within the grace
      // window): right after a switch the reconnecting instance's provider list
      // can be incomplete, and reverting on that transient reads the user's own
      // switch as "dangling" and points it back at an old model (#37).
      const justSwitched =
        defaultModel === lastSwitchModel && Date.now() - lastSwitchAt < SWITCH_HEAL_GRACE_MS;
      if (!get().switching && !justSwitched && defaultModel) {
        const next = fallbackDefaultModel(providers, defaultModel);
        if (next) {
          try {
            await get().setDefaultModel(next);
            toast.success(
              i18n.t("settings:toast.defaultModelReset", { old: defaultModel, model: next }),
            );
          } catch {
            // Leave it stale — the send-time error still guides to Settings.
          }
        }
      }
      let skills = firstSkills;
      // The first workspace-scoped /api/skill call triggers OpenCode's lazy
      // instance init and can answer before the scan finishes — poll briefly.
      for (let i = 0; skills.length === 0 && i < 4; i++) {
        await sleep(400);
        skills = await client.listSkills();
      }
      set({ skills });
    } catch {
      /* ignore transient failures */
    }
    })();
    catalogInFlight = run;
    try {
      await run;
    } finally {
      if (catalogInFlight === run) catalogInFlight = null;
    }
  },

  detectTools: async () => {
    try {
      set({ tools: await probeTools() });
    } catch {
      /* ignore */
    }
  },

  setApprovalMode: async (mode) => {
    // A deliberate restart, like switchWorkspace: `switching` keeps the UI
    // rendering as connected — no status flip, no page flash.
    set({ switching: true });
    try {
      await persistApprovalMode(mode); // writes the config; restarts the sidecar
      set({ approvalMode: mode });
      await get().connectRetry();
    } finally {
      set({ switching: false });
    }
  },

  setProxySetting: async (mode, url) => {
    // Same masked restart as setApprovalMode: the proxy env applies at spawn.
    set({ switching: true });
    try {
      await persistProxySetting(mode, url); // persists; restarts the sidecar
      await get().connectRetry();
    } finally {
      set({ switching: false });
    }
  },

  setDefaultModel: async (model) => {
    if (!client) throw new Error("Not connected to the OpenCode runtime.");
    // #37 diagnostics: record what we ask for so a repro (e.g. switching after a
    // plan's quota runs out) shows the exact target model.
    void logDebug(`[provider] setDefaultModel → ${model}`);
    // Mark this as a deliberate switch so the reconnect's self-heal (loadCatalog)
    // won't revert it against a still-warming provider list (#37).
    lastSwitchModel = model;
    lastSwitchAt = Date.now();
    set({ modelSwitching: true });
    // Applying the model PATCHes OpenCode's global config, which closes the
    // event stream server-side. EventSource's own reconnect does not reliably
    // recover from that — it strands the app in "connecting"/disconnected until
    // a manual Connect. So do a deliberate masked reconnect (a fresh stream,
    // exactly what the manual Connect did): `switching` keeps the UI connected,
    // so switching models never flips the status or blocks the composer.
    set({ switching: true });
    try {
      await client.setDefaultModel(model);
      set({ defaultModel: model });
      if (!(await get().connectRetry())) {
        throw new Error(
          get().error ?? "Runtime did not reconnect after setting the default model.",
        );
      }
      set({ modelSwitchError: null });
      // #37 diagnostics: confirm the switch actually persisted and which providers
      // the runtime now recognizes — pinpoints "switch doesn't take" / "provider
      // not recognized" vs. a stale config-vs-auth mismatch. Best-effort, never
      // fails the switch.
      try {
        const oc = opencodeClient;
        if (oc) {
          const [applied, provs] = await Promise.all([oc.getDefaultModel(), oc.listProviders()]);
          void logDebug(
            `[provider] applied=${applied ?? "null"} providers=[${provs.map((p) => p.id).join(",")}]`,
          );
        }
      } catch (e) {
        void logDebug(`[provider] post-switch probe failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } catch (err) {
      void logDebug(`[provider] setDefaultModel FAILED (${model}): ${err instanceof Error ? err.message : String(err)}`);
      set({ modelSwitchError: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      set({ switching: false, modelSwitching: false });
    }
  },

  connect: async () => {
    // This attempt failed. Inside a retry loop that is a step, not an outcome:
    // the message is kept for connectRetry to report if the window runs out,
    // and the UI stays on "connecting" instead of blinking the offline card.
    const failed = (msg: string) => {
      lastConnectError = msg;
      if (connectRetryDepth > 0) set({ status: "connecting" });
      else set({ error: msg, status: "error" });
    };
    // The runtime SELECTOR, decided before anything is torn down: a live ACP
    // agent for the SAME configured entry is reused across this reconnect
    // (see `acpRuntime`) — the workspace moves, the agent process does not.
    const acpAgent = !isGatewayWeb && isTauri ? activeAcpAgent() : null;
    const reusableAcp =
      acpAgent && acpRuntime && acpRuntimeAgentId === acpAgent.id && acpRuntime.getStatus() === "ready"
        ? acpRuntime
        : null;
    // Quiet teardown of any previous connection: within a (re)connect the
    // status must never pass through "offline" — on first boot the retry loop
    // runs for minutes (macOS TCC) and each flip repaints the whole page.
    teardownClient(reusableAcp);
    let directory: string | null;
    let password: string | null;
    let baseUrl = get().serverUrl;
    // Artifact path resolutions are relative to the workspace folder, so a
    // connect that lands somewhere else must not reuse them (#92).
    const previousWorkspace = get().workspace;
    if (isGatewayWeb) {
      // Web client: same-origin gateway; the pasted token is the OpenCodeClient
      // password, and the workspace directory comes from /v1/whoami.
      baseUrl = gatewayOrigin();
      password = gatewayToken();
      directory = null;
      let readOnly = false;
      try {
        const r = await fetch(`${baseUrl}/v1/whoami`, {
          headers: password ? { Authorization: `Bearer ${password}` } : {},
        });
        if (r.ok) {
          const who = (await r.json()) as { directory?: string; mode?: string };
          // The folder this browser opened, if any; otherwise the host's.
          directory = get().webWorkspace ?? who.directory ?? null;
          // A read-only token 403s every write — surface that in the UI
          // instead of letting "New session" / the composer fail opaquely.
          readOnly = who.mode === "read-only";
        }
      } catch {
        /* whoami is best-effort; the client still connects */
      }
      set({ serverUrl: baseUrl, workspace: directory, webReadOnly: readOnly });
    } else {
      // Scope skill discovery to the sidecar's workspace (null in browser dev).
      directory = await workspacePath();
      set({ workspace: directory, approvalMode: await getApprovalMode() });
      if (!samePath(previousWorkspace, directory)) clearResolvedPaths();
      // The bundled sidecar requires per-run Basic auth; browser dev (no Tauri)
      // gets null and connects to a user-run passwordless server.
      password = await runtimePassword();
    }
    // A configured ACP agent replaces `OpenCodeClient` as THE runtime for this
    // connection (docs/rfc/multi-agent-acp.md) — same `AgentRuntime` seam, so the
    // store, the thread, provenance and runs are unchanged. Desktop only: the
    // agent is a child process on this host, which a phone running the gateway
    // web client does not have.
    let c: AgentRuntime;
    if (acpAgent) {
      // ACP takes the workspace folder per session (`session/new`'s cwd) — so
      // without one there is nothing to create a session in.
      if (!directory) {
        failed("No workspace folder to run the ACP agent in.");
        return;
      }
      let acp: AcpRuntime;
      try {
        if (reusableAcp) {
          // Same agent, still alive: point new sessions at this folder and keep
          // the process. Sessions it already holds keep their own folder — the
          // agent binds cwd per session, so nothing that is running moves.
          reusableAcp.setCwd(directory);
          acp = reusableAcp;
        } else {
          const transport = await acpTransport(acpAgent.id, acpAgent.command, acpAgent.args);
          acp = new AcpRuntime({ transport, cwd: directory, name: acpAgent.name });
          acpRuntime = acp;
          acpRuntimeAgentId = acpAgent.id;
        }
        client = acp;
        c = acp;
        // No OpenCode instance backs this connection: `getClient()` must answer
        // null so Settings' provider/MCP surface hides instead of PATCHing a
        // sidecar that is not driving anything.
        opencodeClient = null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void logDebug(`acp start FAILED (${acpAgent.command}): ${msg}`);
        set({ runtimeKind: "acp", acpAgentName: acpAgent.name });
        failed(msg);
        return;
      }
      // The app's own connectors are per-session in ACP, so the agent has to
      // know them BEFORE any session is created (#14). Awaited only on a fresh
      // child: on a reuse the list is already loaded, and every new session
      // reconnects — paying a config round-trip each time would put the
      // sidecar's latency in front of every "New".
      if (reusableAcp) void shareMcpServers(acp, baseUrl, password);
      else await shareMcpServers(acp, baseUrl, password);
      // The OpenCode catalog belongs to the runtime that is no longer driving:
      // an ACP agent owns its own model choice (v1 changes it through
      // `session/set_config_option`, from the agent's own list), so leaving the
      // old providers on screen would offer a switch that does nothing.
      set({ runtimeKind: "acp", acpAgentName: acpAgent.name, providers: [], defaultModel: null });
    } else {
      const oc = new OpenCodeClient({
        baseUrl,
        directory: directory ?? undefined,
        password: password ?? undefined,
      });
      opencodeClient = oc;
      client = oc;
      c = oc;
      set({ runtimeKind: "opencode", acpAgentName: null });
      // Background streams reuse the same sidecar; the foreground now streams
      // this folder, so drop any background stream that was covering it (avoid a
      // double fold of the same events).
      streamBaseUrl = baseUrl;
      streamPassword = password ?? undefined;
      if (directory) removeStreamClient(directory);
    }
    clientStatusUnsub = c.onStatus((status) => {
      const shown = visibleStatus(status);
      // Log what the runtime said AND what the UI was given, so a report of
      // "it flickered" can be read straight off the log.
      void logDebug(`status → ${status}${shown === status ? "" : ` (held as ${shown})`}`);
      if (status === "connecting" && get().status === "ready") {
        // Hold the flip for STATUS_BLIP_GRACE_MS: if the SDK's own reconnect
        // lands first ("ready" clears the timer), the UI never sees the blip.
        if (statusBlipTimer === null)
          statusBlipTimer = setTimeout(() => {
            statusBlipTimer = null;
            set({ status: "connecting" });
          }, STATUS_BLIP_GRACE_MS);
        return;
      }
      clearStatusBlip();
      set({ status: shown });
    });
    if (!sharedEventHandler)
      sharedEventHandler = (event) => {
      // text.updated fires per streamed token, and a running bash tool fires
      // per stdout write (tqdm redraws dozens of times a second) — logging
      // each one would flood debug.log with an IPC call per event.
      if (
        event.type !== "text.updated" &&
        event.type !== "reasoning.updated" &&
        !(event.type === "tool.updated" && event.status === "running")
      )
        void logDebug(
          `event ← ${event.type}${"sessionId" in event ? " " + event.sessionId : ""}` +
            // An error's TEXT is the whole diagnostic value; logging only "error"
            // meant a real report ("Request blocked." on every retry) could not be
            // explained without reading the runtime's SQLite by hand. Redacted and
            // capped: a provider echoing a credential back must not land on disk.
            (event.type === "error" ? `: ${redactForLog(event.message)}` : ""),
        );
      if (
        "sessionId" in event &&
        event.sessionId &&
        retiredBackgroundReviews.has(event.sessionId)
      )
        return;
      const backgroundReviewParent =
        "sessionId" in event && event.sessionId
          ? backgroundReviewJobs.get(event.sessionId)?.parentId
          : undefined;
      const isBackgroundReviewResult =
        event.type === "text.updated" &&
        backgroundReviewResultParts.has(`${event.sessionId}:${event.partId}`);
      if ("sessionId" in event && event.sessionId) {
        sseLast.set(event.sessionId, ++sseSeq);
        while (sseLast.size > 500) {
          const oldest = sseLast.keys().next().value;
          if (oldest === undefined) break;
          sseLast.delete(oldest);
        }
        // First streamed token after a send → log latency (multi-pane probe).
        const posted = turnPostAt.get(event.sessionId);
        if (posted !== undefined && (event.type === "text.updated" || event.type === "reasoning.updated")) {
          turnPostAt.delete(event.sessionId);
          void logDebug(`first token ← ${event.sessionId} ${Math.round(performance.now() - posted)}ms`);
        }
        // A streamed sign of life re-locks the session even when THIS app never
        // started its turn — after a reload the locks are gone (in-memory only)
        // while the server keeps working. Without this the Stop affordance never
        // comes back and a live turn can no longer be interrupted (#59). A
        // session the user just interrupted is exempt: the abort's own trailing
        // events must not resurrect its lock.
        // A stale re-lock (an SSE replay of a finished turn) is self-healing —
        // reconcileRunning checks the server and unlocks within one poll.
        const active = event.sessionId;
        if (
          ACTIVITY_EVENTS.has(event.type) &&
          !backgroundReviewParent &&
          !isBackgroundReviewResult &&
          !interruptedSessions.has(active) &&
          !get().runningSessions[active]
        ) {
          set((s) => ({ runningSessions: { ...s.runningSessions, [active]: true } }));
        }
      }
      if (event.type === "error") {
        // A session-scoped error belongs IN the conversation (a red status
        // line where the user is looking), and it ends that session's turn so
        // the composer unlocks. Errors without a session keep the banner.
        const sid = event.sessionId;
        // After a user interrupt the abort's own "aborted" error is expected —
        // the thread already says "Interrupted"; don't add a second red line.
        if (sid) clearLiveFolds(sid);
        if (sid && backgroundReviewParent) {
          finishAutoReview(set, get, sid, false);
          set((s) => {
            const runningSessions = { ...s.runningSessions };
            const retryNotices = { ...s.retryNotices };
            delete runningSessions[sid];
            delete retryNotices[sid];
            return { runningSessions, retryNotices };
          });
          return;
        }
        if (sid && interruptedSessions.has(sid)) return;
        // The retry notice this session is carrying (about to be cleared below)
        // is the only place the CAUSE was ever named: the final error text says
        // what failed, the action said why the account could not make the call.
        // Any streamed output between the last attempt and the failure would
        // have cleared the notice first; the two causes that set an action are
        // both refused before a token is produced, so that window stays shut.
        const message = explainRuntimeError(
          event.message,
          sid ? get().retryNotices[sid]?.action : undefined,
        );
        if (sid) {
          // This path ends the turn instead of session.idle (and returns before
          // the fold), so it owes the same auto-review bookkeeping: a turn that
          // died is not reviewed — the work is half-finished — but a REVIEW that
          // died must hand its slot back, or no session is ever reviewed again.
          onTurnIdle(set, get, sid, false);
          set((s) => {
            const cur = s.threads[sid] ?? emptyThread();
            const runningSessions = { ...s.runningSessions };
            delete runningSessions[sid];
            const retryNotices = { ...s.retryNotices };
            delete retryNotices[sid];
            return {
              runningSessions,
              retryNotices,
              threads: {
                ...s.threads,
                [sid]: {
                  ...cur,
                  loaded: true,
                  blocks: [...cur.blocks, { kind: "status-line", text: message, tone: "error" }],
                },
              },
            };
          });
          // This one failure the user cannot act on without help: the bad
          // message is indistinguishable by eye, and every retry resends it.
          if (MALFORMED_HISTORY.test(event.message)) {
            void diagnoseMalformedHistory(set, sid);
          }
        } else {
          set({ error: message });
        }
        return;
      }
      // Interactive requests live outside the thread blocks (transient UI).
      switch (event.type) {
        case "question.asked":
          set((s) => ({
            questions: [...s.questions.filter((q) => q.requestId !== event.requestId), event],
          }));
          return;
        case "question.resolved":
          set((s) => ({ questions: s.questions.filter((q) => q.requestId !== event.requestId) }));
          return;
        case "permission.asked":
          if (!notifiedPermissions.has(event.requestId)) {
            remember(notifiedPermissions, event.requestId);
            void notifyPermissionRequest({ action: event.action, resources: event.resources });
          }
          set((s) => {
            const permissions = [
              ...s.permissions.filter((p) => p.requestId !== event.requestId),
              event,
            ];
            // Mark the tool the agent is blocked on — the newest running/pending
            // step in this session — as waiting-approval, right in the transcript
            // (not just the separate permission card). The permission event has
            // no callID to match on, but the blocked tool is always the latest
            // active one. The next tool.updated restores its real status.
            const sid = event.sessionId;
            const cur = sid ? s.threads[sid] : undefined;
            if (!cur) return { permissions };
            const blocks = [...cur.blocks];
            for (let i = blocks.length - 1; i >= 0; i--) {
              const b = blocks[i];
              if (b.kind === "tool-call" && (b.status === "running" || b.status === "pending")) {
                blocks[i] = { ...b, status: "waiting-approval" };
                return { permissions, threads: { ...s.threads, [sid]: { ...cur, blocks } } };
              }
            }
            return { permissions };
          });
          return;
        case "permission.resolved":
          set((s) => {
            const permissions = s.permissions.filter((p) => p.requestId !== event.requestId);
            const sid = event.sessionId;
            const cur = sid ? s.threads[sid] : undefined;
            if (!cur) return { permissions };
            let changed = false;
            const blocks = cur.blocks.map((b) => {
              if (b.kind === "tool-call" && b.status === "waiting-approval") {
                changed = true;
                return { ...b, status: "running" as const };
              }
              return b;
            });
            return changed
              ? { permissions, threads: { ...s.threads, [sid]: { ...cur, blocks } } }
              : { permissions };
          });
          return;
        case "step.updated":
          set((s) => ({ stepCounts: { ...s.stepCounts, [event.sessionId]: event.step } }));
          return;
        case "session.retry":
          set((s) => ({
            retryNotices: {
              ...s.retryNotices,
              [event.sessionId]: {
                attempt: event.attempt,
                message: event.message,
                ...(event.action ? { action: event.action } : {}),
              },
            },
          }));
          return;
        case "message.agent": {
          // A user message landed. Tag the newest still-untagged user block in
          // this thread with its server id — the optimistic echo from a send
          // starts id-less, and the id is what makes the row editable later.
          // Sends are serialized, so the last untagged block is this message.
          if (event.messageID) {
            const mid = event.messageID;
            set((s) => {
              const cur = s.threads[event.sessionId];
              if (!cur) return {};
              const blocks = [...cur.blocks];
              for (let i = blocks.length - 1; i >= 0; i--) {
                const b = blocks[i];
                if (b.kind === "user" && !b.messageID) {
                  blocks[i] = { ...b, messageID: mid };
                  return { threads: { ...s.threads, [event.sessionId]: { ...cur, blocks } } };
                }
              }
              return {};
            });
          }
          // A user message names its agent. This is how the pill follows
          // OpenCode's own plan_exit "Yes" (it injects a build user message)
          // — and it self-confirms our own sends. Any OTHER agent (the auto-review
          // turn's `reviewer`, or a custom primary) is left alone: the pill only
          // speaks for the two modes it can actually show, and must not claim
          // "Build" because a turn the user did not send ran on something else.
          if (event.agent === "plan" || event.agent === "build") {
            const mode: AgentMode = event.agent;
            if (get().sessionAgents[event.sessionId] !== mode)
              set((s) => ({
                sessionAgents: { ...s.sessionAgents, [event.sessionId]: mode },
              }));
          }
          return;
        }
      }
      const sid = event.sessionId;
      if (!sid) return;
      // Any other sign of life from the session supersedes its retry notice:
      // an attempt is streaming again (text/tool events) or the turn is over.
      if (get().retryNotices[sid]) {
        set((s) => {
          const retryNotices = { ...s.retryNotices };
          delete retryNotices[sid];
          return { retryNotices };
        });
      }
      if (event.type === "session.idle") clearLiveFolds(sid);
      // Idle after a user interrupt: the thread already ends with "Interrupted"
      // — keep the locks clear and skip the fold. An abort can emit MORE than
      // one idle, so the guard must survive every trailing idle (`.has`, not
      // `.delete`); it is cleared when the next turn starts (see `turn → sid`).
      if (event.type === "session.idle" && interruptedSessions.has(sid)) {
        set((s) => {
          const runningSessions = { ...s.runningSessions };
          const shellTurns = { ...s.shellTurns };
          delete runningSessions[sid];
          delete shellTurns[sid];
          return { runningSessions, shellTurns };
        });
        // A turn the user stopped is not reviewed — half-finished work is not
        // what a review is for — but a stopped REVIEW still has to hand back
        // its slot.
        onTurnIdle(set, get, sid, false);
        void get().refreshSessions();
        return;
      }
      // Only a file the agent actually wrote earns a review; a read-only turn
      // (questions, searches, plain analysis) has nothing to audit.
      if (
        event.type === "tool.updated" &&
        !backgroundReviewParent &&
        isMutatingTool(event.tool, event.status)
      ) {
        // Credited to the session at the top of the subagent chain, not to the one
        // that ran the tool. A subagent's own session is never reviewed (see the
        // `isSubagent` gate) because its parent's turn is what gets reviewed — so
        // attributing the write to the child meant a turn that delegated ALL of
        // its file work was reviewed by nobody.
        const root = rootSessionOf(get().sessionParents, sid);
        dirtyTurns.add(root);
        const directPath = str(event.input?.filePath) || str(event.input?.path);
        mergePaths(
          dirtyTurnPaths,
          root,
          directPath
            ? [directPath, ...provenanceInputsFromEvent(event).map((input) => input.path)]
            : provenanceInputsFromEvent(event).map((input) => input.path),
        );
      }
      // The agent reached a compute host that authenticates interactively and
      // asked us to sign in (#73). The dialog opens here, in the conversation the
      // user is already watching, and the tool waits for the shared connection —
      // so the run continues instead of dying on "Permission denied".
      if (
        event.type === "tool.updated" &&
        event.tool === "ssh_connect" &&
        (event.status === "running" || event.status === "pending")
      ) {
        const host = str(event.input?.host);
        if (host && !relayedSignIns.has(event.callId)) {
          remember(relayedSignIns, event.callId);
          void useSshStore.getState().connect(host);
        }
      }
      // A task tool names the subagent session it spawned — remember the
      // parent link so the child's permission/question asks surface in THIS
      // conversation, and refresh the list so the child's title is known.
      if (
        event.type === "tool.updated" &&
        event.childSessionId &&
        get().sessionParents[event.childSessionId] !== sid
      ) {
        const child = event.childSessionId;
        set((s) => ({ sessionParents: { ...s.sessionParents, [child]: sid } }));
        void get().refreshSessions();
      }
      const applyFold = (ev: typeof event) =>
        set((s) => {
          const cur = s.threads[sid] ?? emptyThread();
          const folded = foldEvent(
            { blocks: cur.blocks, index: cur.index },
            ev,
            { shellTurn: !!s.shellTurns[sid] },
          );
          const threads = { ...s.threads, [sid]: { ...cur, ...folded, loaded: true } };
          // The turn is over — unlock the composer and drop the "Working…" row.
          // The shell flag clears HERE (not when the POST settles): within the
          // SSE stream the bash-output event always precedes session.idle.
          //
          // ONLY session.idle may touch these three maps. Cloning them on every
          // folded event handed a NEW identity to every whole-map subscriber on
          // every streamed token — repainting every pane and the sidebar for a
          // BACKGROUND session's stream, which is exactly what #34's per-field
          // selectors exist to prevent. With concurrent subagents that fan-out
          // multiplied per live child and starved the main thread (#50).
          if (ev.type !== "session.idle") return { threads };
          const runningSessions = { ...s.runningSessions };
          const shellTurns = { ...s.shellTurns };
          const stepCounts = { ...s.stepCounts };
          delete runningSessions[sid];
          delete shellTurns[sid];
          delete stepCounts[sid];
          return { runningSessions, shellTurns, stepCounts, threads };
        });
      // A running bash tool streams its stdout tail on every write — dozens
      // of events per second under a progress bar. Fold at most one partial
      // update per LIVE_FOLD_MS per call (latest wins); everything else
      // (status changes, completion) folds immediately and supersedes.
      if (event.type === "tool.updated" && !backgroundReviewParent) {
        if (event.status === "running" && event.partialOutput !== undefined) {
          const now = Date.now();
          const last = liveFoldLast.get(event.callId) ?? 0;
          if (now - last < LIVE_FOLD_MS) {
            const pending = liveFoldPending.get(event.callId);
            if (pending) pending.event = event;
            else {
              const callId = event.callId;
              const timer = window.setTimeout(() => {
                const p = liveFoldPending.get(callId);
                liveFoldPending.delete(callId);
                if (!p) return;
                liveFoldLast.set(callId, Date.now());
                applyFold(p.event);
              }, LIVE_FOLD_MS - (now - last));
              liveFoldPending.set(event.callId, { sessionId: sid, timer, event });
            }
            return;
          }
          liveFoldLast.set(event.callId, now);
        } else {
          const pending = liveFoldPending.get(event.callId);
          if (pending) {
            window.clearTimeout(pending.timer);
            liveFoldPending.delete(event.callId);
          }
          liveFoldLast.delete(event.callId);
        }
      }
      applyFold(event);
      // After the fold, which is what clears this session's running lock — the
      // review claims it again for its own turn.
      if (event.type === "session.idle") onTurnIdle(set, get, sid, true);
      const presentationEventKey =
        event.type === "tool.updated" ? `${sid}:${event.callId}` : null;
      if (
        event.type === "tool.updated" &&
        presentationEventKey &&
        !handledPresentations.has(presentationEventKey)
      ) {
        const presentation = deriveArtifactPresentation(event);
        if (presentation?.display === "panel") {
          remember(handledPresentations, presentationEventKey);
          if (presentation.target === "new-session") {
            void (async () => {
              const sourceDirectory =
                get().sessions.find((session) => session.id === sid)?.directory ?? get().workspace;
              let presentationClient: AgentRuntime | null = client;
              let temporaryClient: OpenCodeClient | null = null;
              try {
                if (sourceDirectory && sourceDirectory !== get().workspace) {
                  presentationClient = streamClients.get(sourceDirectory) ?? null;
                  if (!presentationClient && streamBaseUrl) {
                    temporaryClient = new OpenCodeClient({
                      baseUrl: streamBaseUrl,
                      directory: sourceDirectory,
                      password: streamPassword,
                    });
                    await temporaryClient.connect();
                    presentationClient = temporaryClient;
                  }
                }
                if (!presentationClient) throw new Error("The source workspace is not connected.");
                const title =
                  presentation.artifact.presentation?.title ?? presentation.artifact.filename;
                const dedicatedSessionId = await presentationClient.createSession(title);
                await get().refreshSessions();
                set((state) => ({
                  sessions: state.sessions.some((session) => session.id === dedicatedSessionId)
                    ? state.sessions
                    : [
                        {
                          id: dedicatedSessionId,
                          title,
                          ...(sourceDirectory ? { directory: sourceDirectory } : {}),
                          created: Date.now(),
                          updated: Date.now(),
                        },
                        ...state.sessions,
                      ],
                  threads: {
                    ...state.threads,
                    [dedicatedSessionId]: {
                      ...(state.threads[dedicatedSessionId] ?? emptyThread()),
                      loaded: true,
                    },
                  },
                }));
                useLayoutStore
                  .getState()
                  .presentArtifact(
                    dedicatedSessionId,
                    presentation.artifact,
                    presentation.placement,
                    "new-screen",
                  );
              } finally {
                temporaryClient?.close();
              }
            })().catch((error) =>
              set({ error: error instanceof Error ? error.message : String(error) }),
            );
          } else {
            useLayoutStore
              .getState()
              .presentArtifact(
                sid,
                presentation.artifact,
                presentation.placement,
                presentation.target,
              );
          }
        }
      }
      // A completed live write becomes a provenance version. One apply_patch call
      // can touch many files, so dedupe per (call, path) rather than per call.
      if (event.type === "tool.updated") {
        for (const input of provenanceInputsFromEvent(event)) {
          const key = `${event.callId}:${input.path}`;
          if (recordedProvenance.has(key)) continue;
          remember(recordedProvenance, key);
          void recordProvenance(input, sid, get().defaultModel);
        }
      }
      // A completed experiment execution (bash running code) becomes a run —
      // its reproducibility recipe (once per call).
      if (
        event.type === "tool.updated" &&
        !backgroundReviewParent &&
        !recordedRuns.has(event.callId)
      ) {
        const run = runInputFromEvent(event);
        if (run) {
          remember(recordedRuns, event.callId);
          void recordRun(run, sid, get().defaultModel);
        }
      }
      if (event.type === "session.idle" && !backgroundReviewParent) {
        syncAcpConfig(set, sid);
        void get().refreshSessions();
        // Name the session in the snapshot: a project folder is shared by many
        // sessions, and its git history must say which one made each change.
        const sessionName = get().sessions.find((s) => s.id === sid)?.title || sid;
        void commitWorkspaceSnapshot(`Snapshot session changes (${sessionName})`)
          .then((committed) => {
            if (committed) void logDebug(`git snapshot ✓ ${sid}`);
          })
          .catch((err) =>
            logDebug(`git snapshot skipped for ${sid}: ${err instanceof Error ? err.message : String(err)}`),
          );
      }
      // The agent finished a skill install: it wrote the skill into THIS
      // session's workspace, which the next dated session folder would leave
      // behind — copy it into the profile's user skills dir, where OpenCode
      // finds it from every workspace (#61).
      if (event.type === "session.idle" && pendingSkillInstall?.sessionId === sid) {
        const pending = pendingSkillInstall;
        // Disarmed while the copy runs, so a second idle cannot adopt twice.
        pendingSkillInstall = null;
        void get()
          .reloadRuntimeConfig(async () => {
            const adopted = await adoptWorkspaceSkills(pending.known);
            if (!adopted.length) {
              // The turn may have stopped to ask a question or wait for an
              // approval — stay armed for the turn that finishes the install
              // (unless another install has started meanwhile).
              pendingSkillInstall ??= pending;
              return;
            }
            toast.success(
              i18n.t("pages:skills.install.installed", { name: adopted.join(", ") }),
            );
          })
          .catch((err) => {
            // This used to go only to the debug log, so a skill that never made
            // it out of the session folder simply vanished when the next one was
            // created and the user had nothing to go on (#103).
            const detail = err instanceof Error ? err.message : String(err);
            void logDebug(`skill adoption failed: ${detail}`);
            toast.error(i18n.t("pages:skills.install.adoptFailed", { detail }));
          });
      }
      };
    c.onEvent(sharedEventHandler);
    try {
      void logDebug(`connect → ${get().serverUrl}`);
      await c.connect();
      void logDebug("connect OK");
      // Take the status from the runtime rather than waiting for a transition:
      // a REUSED ACP agent is already "ready", so its idempotent connect emits
      // nothing and the store would sit on the "connecting" this attempt set.
      lastConnectError = null;
      set({ error: null, status: c.getStatus() });
      await get().refreshSessions();
      void get().refreshProjects();
      // Catalog (skills/agents/commands) fills in behind the page — a session
      // switch must not wait on it to show the conversation.
      void get().loadCatalog();
      // Every reconnect is a window where session.idle can have been missed
      // (the event stream is directory-scoped and torn down on purpose) —
      // check any session still holding a running lock against the server.
      void get().reconcileRunning();
      // Older versions wrote a blind 128k context limit for custom-endpoint
      // models with an unknown window; on models whose real window is larger
      // that guess made OpenCode manufacture a context-overflow and abort (#52).
      // Reset those once per run. Desktop only: a gateway web client may hold a
      // read-only token, and the host app does this anyway.
      // (OpenCode config; an ACP agent has no such config to clean.)
      const oc = opencodeClient;
      if (!isGatewayWeb && !contextLimitsCleaned && oc) {
        contextLimitsCleaned = true;
        // Best-effort: deferred into a promise chain so no failure — even a
        // synchronous throw — can flip an otherwise successful connect.
        void Promise.resolve()
          .then(() => oc.clearDefaultCustomModelContextLimits())
          .catch((err) =>
            logDebug(`context-limit cleanup skipped: ${err instanceof Error ? err.message : String(err)}`),
          );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void logDebug(`connect FAILED: ${msg}`);
      failed(msg);
    }
  },

  // First boot can be slow far beyond the process spawn: on a fresh install
  // macOS TCC ("access Documents") blocks the sidecar until the user answers,
  // so the window must cover minutes, not seconds — giving up early strands
  // the user on an error screen that a single manual Connect would fix.
  // Failed attempts are masked (status AND error) for the WHOLE window, not
  // just between attempts: a workspace switch reconnects the event stream on
  // purpose, and flashing "could not open the event stream" at the user
  // mid-switch reads as breakage — while on every launch the first attempts
  // fail against a sidecar that is spawned but not yet listening, which used to
  // strobe the page connecting→error→connecting four times a second. The last
  // error is surfaced only if the whole retry window is exhausted.
  connectRetry: async (tries = 120) => {
    // Same hold the SDK's own reconnect gets: a deliberate reconnect that
    // succeeds immediately must not repaint every status consumer on the way
    // through. Switching Screens goes openSession → setWorkspace →
    // connectRetry, and this line used to flip the indicator to "connecting"
    // and back within a frame or two — a visible stutter on a path where
    // nothing was actually wrong. If the reconnect lands inside the grace,
    // "ready" clears the timer and the flip is never shown.
    if (get().status === "ready") {
      if (statusBlipTimer === null)
        statusBlipTimer = setTimeout(() => {
          statusBlipTimer = null;
          set({ status: "connecting" });
        }, STATUS_BLIP_GRACE_MS);
    } else {
      set({ status: "connecting" });
    }
    // A retry window starting means "trying again", so an error left over from
    // the last one stops being the truth — on screen or as this loop's verdict.
    if (get().error) set({ error: null });
    lastConnectError = null;
    let lastError: string | null = null;
    // Sidecar exits already counted before this loop began. Everything below
    // compares against it, so a crash from an hour ago cannot make this attempt
    // give up early.
    const exitsBefore = (await runtimeFailure())?.exits ?? 0;
    // Hold every attempt's failure back for as long as the loop runs. Only the
    // verdicts below — published with a direct set() — reach the UI.
    connectRetryDepth++;
    try {
      for (let i = 0; i < tries; i++) {
        await get().connect();
        if (get().status === "ready") {
          set({ modelSwitchError: null });
          void get().reportQuarantinedConfig();
          return true;
        }
        // Masked failures report through `lastConnectError`; anything that puts
        // an error in the store directly still counts (the store's `error` was
        // cleared above, so it can only be this loop's).
        lastError = lastConnectError ?? get().error ?? lastError;
        // A runtime that EXITS is not a runtime that is slow to listen, and only
        // the Rust side can tell them apart. Three deaths in one attempt means
        // the next hundred spawns die too — a config the runtime refuses to
        // start on does exactly that (#118) — so stop, and say what it said
        // instead of "could not open the event stream".
        const failure = await runtimeFailure();
        if (failure && failure.exits - exitsBefore >= RECONNECT_GIVE_UP_AFTER_EXITS) {
          set({ status: "error", error: failure.message });
          void logDebug(`connect: giving up after ${failure.exits - exitsBefore} runtime exits`);
          void get().reportQuarantinedConfig();
          return false;
        }
        // The sidecar can die under us (it has crashed on its own — an Effect
        // ServeError, exit 1). Retrying the socket alone then never recovers,
        // because there is nothing listening and nothing puts it back: this
        // loop used to hammer a dead port every second until the user restarted
        // the whole app. startRuntime is the repair — it returns the existing
        // URL when the runtime is alive, and respawns it when it is not, so the
        // call is cheap on the common path and the fix on the broken one.
        if (isTauri && !isGatewayWeb) {
          try {
            // A wedged runtime — alive, so nothing terminates and nothing clears
            // the lifecycle, but no longer serving — is invisible to startRuntime,
            // which hands back the same dead URL forever. Give plain retrying a
            // fair chance first (a restart during normal boot would be pure
            // thrash), then force a fresh process exactly once.
            const url =
              i === RECONNECT_FORCE_RESTART_AFTER
                ? await restartRuntime()
                : await startRuntime();
            if (url && url !== get().serverUrl) set({ serverUrl: url });
            if (i === RECONNECT_FORCE_RESTART_AFTER) {
              set({ runtimeStartedAt: await runtimeStartedAt() });
            }
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
          }
        }
        // Quick retries first — the server is usually up within a second (a
        // reconnect finds it already listening); back off to 1 s for the long
        // tail (first boot blocked on macOS TCC can take minutes).
        await sleep(i < 8 ? 250 : 1000);
      }
      set({ status: "error", error: lastError });
      return false;
    } finally {
      connectRetryDepth--;
    }
  },

  reportQuarantinedConfig: async () => {
    const aside = await takeConfigQuarantineNotice().catch(() => null);
    if (!aside) return;
    void logDebug(`config: unreadable config was moved to ${aside} and rebuilt`);
    toast.error(i18n.t("settings:toast.configRebuilt", { path: aside }));
  },

  bootstrap: () => {
    if (bootstrapInFlight) return bootstrapInFlight;
    const run = (async () => {
      void get().detectTools();
      // Web client (served by the gateway): the sidecar already runs on the host
      // — just connect to the gateway (same origin), no Tauri runtime to start.
      if (isGatewayWeb) {
        set({ serverUrl: gatewayOrigin() });
        await get().connectRetry();
        return;
      }
      if (!isTauri) return;
      void logDebug("bootstrap: starting bundled runtime");
      try {
        const url = await startRuntime();
        void logDebug(`bootstrap: runtime at ${url}`);
        if (url) set({ serverUrl: url });
        // Needed before any session is loaded: it is what separates a live turn
        // from one a dead runtime left half-written.
        set({ runtimeStartedAt: await runtimeStartedAt() });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void logDebug(`bootstrap FAILED: ${msg}`);
        // The status has to move off the launch "connecting": nothing is being
        // dialled any more, and leaving it there would keep telling the user
        // the runtime is on its way while the reason it is not sits underneath.
        set({ error: msg, status: "error" });
        return;
      }
      await get().connectRetry();
      // A remote client (LAN web / CLI) that creates or deletes a session emits
      // no OpenCode session event, so the gateway pings us to re-list — its
      // sessions then show up in the sidebar exactly like locally-made ones.
      if (!gatewayListenerBound) {
        gatewayListenerBound = true;
        try {
          const { listen } = await import("@tauri-apps/api/event");
          await listen("gateway:sessions-changed", () => void get().refreshSessions());
        } catch {
          /* event API unavailable — nothing to sync */
        }
      }
    })();
    bootstrapInFlight = run;
    const clear = () => {
      if (bootstrapInFlight === run) bootstrapInFlight = null;
    };
    void run.then(clear, clear);
    return run;
  },

  disconnect: () => {
    // Closing the event stream does not stop server-side turns. Explicitly
    // abort hidden reviewers first so reconnecting cannot leave paid work
    // running with no UI or completion handler attached.
    for (const [reviewSid, job] of backgroundReviewJobs) {
      remember(retiredBackgroundReviews, reviewSid);
      void job.runtime.abortSession(reviewSid).catch(() => {});
    }
    teardownClient();
    teardownStreamClients();
    // Nothing can be reviewed without a runtime; a stale queue would fire into
    // the next connection.
    dirtyTurns.clear();
    dirtyTurnPaths.clear();
    reviewQueue.length = 0;
    queuedReviewPaths.clear();
    backgroundReviewJobs.clear();
    cancelledBackgroundReviews.clear();
    retiredBackgroundReviews.clear();
    backgroundReviewResultParts.clear();
    reviewInFlight = null;
    set({ status: "offline", modelSwitchError: null, backgroundReviews: {} });
  },

  refreshSessions: async () => {
    if (!client) return;
    try {
      const sessions = await client.listSessions();
      set((s) => {
        // The list also names each subagent session's parent — the recovery
        // path for parent links after a reload (no live task event to learn from).
        const sessionParents = { ...s.sessionParents };
        for (const m of sessions) if (m.parentId) sessionParents[m.id] = m.parentId;
        return { sessions, sessionParents };
      });
    } catch {
      /* ignore transient list failures */
    }
  },

  // "New" opens a blank draft — no session is created until the first message (#3).
  // A fresh draft also drops any pinned folder: back to the dated-folder default.
  aimDraft: (key, path) =>
    set((s) => {
      if (path) return { draftWorkspaces: { ...s.draftWorkspaces, [key]: path } };
      if (!(key in s.draftWorkspaces)) return {};
      const draftWorkspaces = { ...s.draftWorkspaces };
      delete draftWorkspaces[key];
      return { draftWorkspaces };
    }),

  startDraft: () => set((s) => ({ ...blankDraft(s), ...forgetDraftFolder(s, DRAFT_KEY) })),

  // Re-blank the draft VIEW without touching where the next session will live.
  // The folder is chosen at send time from the draft's own entry, but the user picks
  // it much earlier ("+ new session in project X"). Anything between the two
  // that merely resets the view — the focus effect when a pane loses its
  // session — must not reroute the session to a dated folder (#69); only an
  // explicit New may unpin.
  resetDraftView: () => set((s) => blankDraft(s)),

  // Local /new and /clear: clear the visible chat context, but keep the active
  // folder. The first next message creates a new OpenCode session in that same
  // folder; no session, database row, or file is deleted here. `key` is the
  // draft slot to reset — the pane's own `draft:<leafId>` for a tiled pane,
  // the global DRAFT_KEY for the single-pane fallback.
  startDraftInCurrentWorkspace: (key = DRAFT_KEY) =>
    set((s) => {
      const threads = { ...s.threads };
      threads[key] = {
        ...emptyThread(),
        loaded: true,
        blocks: [
          {
            kind: "status-line",
            text: i18n.t("session:localCommand.cleared"),
            tone: "review",
            divider: true,
          },
        ],
      };
      const panes = { ...s.panes };
      delete panes[key];
      const sessionAgents = { ...s.sessionAgents };
      delete sessionAgents[key];
      // /new and /clear deliberately stay put: aim this draft at the folder
      // it is already in, so the next session lands there and not in a dated one.
      const draftWorkspaces = s.workspace
        ? { ...s.draftWorkspaces, [key]: s.workspace }
        : s.draftWorkspaces;
      return { currentId: null, draftWorkspaces, threads, panes, sessionAgents };
    }),

  refreshProjects: async () => {
    if (!isTauri && !isGatewayWeb) return;
    try {
      set({ projects: await listProjects() });
    } catch {
      /* ignore transient scan failures */
    }
  },

  createProject: async (name) => {
    try {
      const project = await createProjectFolder(name);
      void get().refreshProjects();
      await get().switchWorkspace({ path: project.path });
      return project;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  importProject: async (path, mode) => {
    try {
      const project = await importProjectFolder(path, mode);
      void get().refreshProjects();
      await get().switchWorkspace({ path: project.path });
      return project;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  setProjectPinned: async (id, pinned) => {
    // Optimistic: flip locally so the sidebar reacts immediately, then persist.
    set((s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, pinned } : p)) }));
    try {
      await setProjectPinnedCmd(id, pinned);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
    void get().refreshProjects();
  },

  deleteProject: async (id) => {
    try {
      await deleteProjectCmd(id);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
    void get().refreshProjects();
  },

  startDraftInWorkspace: async (path, key = DRAFT_KEY) => {
    // Aim the draft slot the composer will actually send under. "+ new session
    // in project X" opens its own pane, so that is `draft:<leafId>`, not the
    // global slot — aiming the wrong one sent the session to a dated folder.
    const aim = (s: RuntimeState) => ({
      draftWorkspaces: { ...s.draftWorkspaces, [key]: path },
    });
    if (samePath(get().workspace, path)) {
      // Already inside the project — a clean draft, no reconnect.
      set((s) => ({ ...blankDraft(s, key), ...aim(s) }));
      return;
    }
    await get().switchWorkspace({ path, key });
  },

  ensureDraftWorkspace: async () => {
    const s = get();
    // A session already has its folder; a draft aimed at one reuses it on send.
    // Only a draft with no folder of its own needs its dated folder materialized
    // now, so composer files and the eventual session share one workspace.
    if (!isTauri || s.currentId || s.draftWorkspaces[DRAFT_KEY]) return;
    await get().switchWorkspace({ dated: datedWorkspaceName() });
  },

  switchWorkspace: async (target) => {
    set({ switching: true });
    try {
      // Either way the draft ends up aimed at a real folder: the one the user
      // picked, or the dated one just materialized (so a file pasted into the
      // draft and the eventual session share it, rather than the send creating
      // a second dated folder and orphaning the file).
      // Both commands answer with the canonical path the runtime resolved —
      // which is exactly what the session's own `directory` will report, so aim
      // the draft at that, not at the raw string the caller passed.
      // In the browser there is no `set_workspace` to call and there must not
      // be: the host keeps its own active folder. Opening a project here just
      // re-scopes THIS client — the session it creates carries the folder, so
      // the work still lands in the project (#81). A dated folder has no
      // gateway equivalent, so the web client stays on the host's folder and
      // the session lands there.
      const landed = isGatewayWeb
        ? "dated" in target
          ? get().workspace
          : target.path
        : "dated" in target
          ? await newDatedWorkspace(target.dated)
          : await setWorkspace(target.path);
      // Reset the local kernel so it respawns in the new folder, then reconnect
      // the event stream scoped to it (connect() re-reads the active folder —
      // the sidecar itself keeps running). The switch aims the draft at that
      // folder, so the next new session lands exactly there.
      // The local kernel is a desktop feature; there is none to re-root here.
      if (!isGatewayWeb) await kernelReset().catch(() => {});
      if (isGatewayWeb && landed) set({ webWorkspace: landed, workspace: landed });
      set((s) => {
        // Back to a draft in the new folder — the draft pane must not carry
        // files from the previous folder. Session panes keep their memory.
        const panes = { ...s.panes };
        delete panes[DRAFT_KEY];
        const sessionAgents = { ...s.sessionAgents };
        delete sessionAgents[DRAFT_KEY];
        const key = target.key ?? DRAFT_KEY;
        const draftWorkspaces = { ...s.draftWorkspaces };
        // No folder resolved (a web client asked for a dated one, which only
        // the host can make): leave the draft unaimed so the session is created
        // wherever the server is, rather than aimed at nothing.
        if (landed) draftWorkspaces[key] = landed;
        else delete draftWorkspaces[key];
        return { currentId: null, panes, draftWorkspaces, sessionAgents };
      });
      await get().connectRetry();
      await Promise.all([get().refreshSessions(), get().loadCatalog()]);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ switching: false });
    }
  },

  openSession: async (id) => {
    const seq = ++openSessionSeq;
    set({ currentId: id });
    if (!client) return;
    // Follow the session into its own workspace folder: record it as active and
    // reconnect the event stream scoped to it, so the agent, kernel and Files
    // all operate where the session's files live. Sessions with no recorded
    // folder, or that already match the active folder, skip this.
    const dir = get().sessions.find((s) => s.id === id)?.directory;
    if (dir && dir !== get().workspace) {
      set({ switching: true });
      try {
        // The browser follows the session by re-scoping ITSELF (the host's own
        // active folder is not ours to move). This is not cosmetic: OpenCode
        // serves each folder from its own instance, so a stream still scoped to
        // the previous folder delivers NOTHING for this session — the turn runs
        // and the page shows nothing happening.
        if (isGatewayWeb) set({ webWorkspace: dir, workspace: dir });
        else await setWorkspace(dir).catch(() => {});
        // A newer openSession has superseded this one — stop before starting a
        // second, dueling connectRetry. Two reconnect loops tear down each
        // other's in-flight EventSource, leaking half-open sockets until the
        // webview's per-host connection pool is exhausted and every later
        // session hangs on load. The winner (latest seq) does the reconnect.
        if (seq !== openSessionSeq) return;
        await kernelReset().catch(() => {});
        if (seq !== openSessionSeq) return;
        await get().connectRetry();
      } finally {
        // Only the still-current open clears `switching`; a superseded one must
        // not flip it off while the winner is mid-reconnect.
        if (seq === openSessionSeq) set({ switching: false });
      }
    }
    // Stamp the (now-active) workspace with this session's id so skill-recorded
    // remote runs attach to the session, not just the global Runs view.
    if (dir) void markSession(id).catch(() => {});
    if (!client) return;
    // Recover any request the agent is blocked on (asked before connect/reload).
    void (async () => {
      try {
        const [qs, ps] = await Promise.all([
          client!.listQuestions(id),
          client!.listPermissions(id),
        ]);
        // Both lists are workspace-scoped (they include subagent sessions'
        // asks) — replace by requestId so live SSE copies don't duplicate.
        set((s) => {
          const qIds = new Set(qs.map((q) => q.requestId));
          const pIds = new Set(ps.map((p) => p.requestId));
          return {
            questions: [...s.questions.filter((q) => !qIds.has(q.requestId)), ...qs],
            permissions: [...s.permissions.filter((p) => !pIds.has(p.requestId)), ...ps],
          };
        });
      } catch {
        /* pending-request recovery is best-effort */
      }
    })();
    // A session reopened while "Working…" may have finished behind our back.
    void get().reconcileRunning();
    if (get().threads[id]?.loaded) return;
    try {
      const messages = await client.getMessages(id);
      // The command templates are what turn a stored expansion back into the
      // "/name args" the user typed. connect() starts the catalog without
      // awaiting it, so on a cold open this can still be in flight — join it
      // rather than render the raw expansion. No extra request: it is the same
      // load already running.
      if (catalogInFlight && get().commands.length === 0) await catalogInFlight;
      if (seq !== openSessionSeq || get().currentId !== id) return;
      // A replayed ACP session reports its selectors during the load — show the
      // model it is actually on, not the one the last session used.
      syncAcpConfig(set, id);
      set((s) => ({
        threads: {
          ...s.threads,
          [id]: { ...historyToThread(messages, s.commands), loaded: true },
        },
        // Seed the agent pill from history: a session that was planning when
        // the app closed (or whose plan_exit flip fell into an SSE gap) must
        // reopen in the mode the server is actually in.
        sessionAgents: { ...s.sessionAgents, [id]: lastAgentMode(messages) },
        // …and seed the running lock the same way. The locks are in-memory, so
        // a session still mid-answer would otherwise reopen with no "Working…"
        // and no way to stop it — a silent long tool call streams no event to
        // re-lock it either (#59).
        ...(turnStillStreaming(messages, get().runtimeStartedAt)
          ? { runningSessions: { ...s.runningSessions, [id]: true as const } }
          : {}),
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (seq !== openSessionSeq || get().currentId !== id) return;
      set((s) => ({
        error: msg,
        threads: {
          ...s.threads,
          [id]: {
            ...emptyThread(),
            loaded: true,
            blocks: [{ kind: "status-line", text: `Failed to load messages: ${msg}`, tone: "error" }],
          },
        },
      }));
    }
  },

  loadHistory: async (id) => {
    const c = client;
    if (!c || get().threads[id]?.loaded) return;
    try {
      // getMessages is session-scoped (server routes by the session's folder),
      // so any connected client works — no folder switch, unlike openSession.
      const messages = await c.getMessages(id);
      // Same reason as openSession: without the command templates a stored
      // slash-command expansion renders raw.
      if (catalogInFlight && get().commands.length === 0) await catalogInFlight;
      if (get().threads[id]?.loaded) return; // a live fold beat us to it
      set((s) => ({
        threads: { ...s.threads, [id]: { ...historyToThread(messages, s.commands), loaded: true } },
        sessionAgents: { ...s.sessionAgents, [id]: lastAgentMode(messages) },
        // Same server-truth seeding as openSession — a background pane must not
        // adopt a still-running session as idle (#59).
        ...(turnStillStreaming(messages, get().runtimeStartedAt)
          ? { runningSessions: { ...s.runningSessions, [id]: true as const } }
          : {}),
      }));
    } catch {
      /* best-effort; the pane keeps its skeleton and loads on focus */
    }
  },

  // The send lifecycle (new → input → send → response) is shared by plain
  // prompts, "!" shell commands and "/" slash commands — see performTurn.
  sendPrompt: (text, sessionId, draftKey, attachments) => {
    // Capture the mode BEFORE performTurn: on a draft, currentId is still null
    // here (the session is created inside), so this reads the pane's draft slot
    // correctly. Pin "plan" only when the catalog actually has it — a stale mode
    // against an older/custom sidecar must not fail every send with "Agent not
    // found".
    const s = get();
    const key = sessionId ?? draftKey ?? s.currentId ?? DRAFT_KEY;
    const mode = s.sessionAgents[key];
    const agent =
      mode === "plan" && s.agents.some((a) => a.name === "plan") ? "plan" : undefined;
    // This pane's own model + effort (falling back to the global default),
    // captured now so a draft's later graft still sends the pane's choice.
    const { model, variant } = modelForSession(s, key);
    return performTurn(
      set,
      get,
      text,
      // Attachment bytes are read INSIDE the send, not before performTurn: the
      // echo and the spinner must appear on click, not after a multi-MB read.
      (sid) =>
        withRetry(async () => {
          const files = await imageAttachmentParts(attachments ?? []);
          await client!.sendPrompt(sid, text, agent, model, variant, files);
        }),
      // An ACP turn is a SYNC turn: `session/prompt` is one JSON-RPC request that
      // answers when the turn is over, where OpenCode's `prompt_async` answers as
      // soon as it is accepted. Without this the running lock would be taken
      // AFTER the turn's own `session.idle` had already cleared it, leaving a
      // spinner turning under a finished answer until the next reconcile.
      s.runtimeKind === "acp",
      false,
      sessionId,
      draftKey,
    );
  },

  // No retry for shell/command: re-POSTing would run the command twice.
  runShell: (command, sessionId, draftKey) => {
    const agent = get().agents.find((a) => a.mode === "primary")?.name ?? "build";
    return performTurn(
      set,
      get,
      `! ${command}`,
      (sid) => client!.runShell(sid, command, agent),
      true,
      true,
      sessionId,
      draftKey,
    );
  },

  runCommand: async (name, args, sessionId, draftKey) => {
    if (name === "new" || name === "clear") {
      get().startDraftInCurrentWorkspace(draftKey);
      return null;
    }
    return performTurn(
      set,
      get,
      args ? `/${name} ${args}` : `/${name}`,
      (sid) => client!.runCommand(sid, name, args),
      true,
      false,
      sessionId,
      draftKey,
    );
  },

  interrupt: async (sessionId) => {
    const sid = sessionId ?? get().currentId;
    // Deliberately NOT gated on the local running lock: that lock is this app's
    // guess, and a turn the app has lost track of — after a reload, or after an
    // earlier Stop cleared the lock without the turn actually dying — is exactly
    // the one the user is trying to stop (#59). Aborting an idle session is a
    // no-op server-side: the handler cancels whatever it finds (nothing) and
    // answers true, so there is nothing to protect against here.
    if (!sid || !client) return;
    // Arm the guard BEFORE the abort POST: the server answers an abort with its
    // own SSE burst (an "aborted" error and one or more session.idle events)
    // that streams back WHILE this POST is still awaited. If we armed it after
    // the await, those events would race in ahead and litter the thread with
    // "Aborted" / "done" lines before "Interrupted".
    remember(interruptedSessions, sid);
    // Descendant subagent sessions stream their own events; the abort takes the
    // whole subtree down server-side, so their trailing events need the same
    // guard — otherwise they re-lock the pane the user just stopped.
    const descendants = Object.keys(get().sessionParents).filter(
      (id) => rootSessionOf(get().sessionParents, id) === sid,
    );
    for (const id of descendants) remember(interruptedSessions, id);
    try {
      await client.abortSession(sid);
    } catch (err) {
      // The abort did NOT land. Saying "Interrupted" here would be a lie that
      // also hides the Stop button (the lock is what renders it), leaving a
      // live turn with no way to stop it. Keep the lock, un-arm the guard so
      // the session's events fold normally again, and surface the failure.
      interruptedSessions.delete(sid);
      for (const id of descendants) interruptedSessions.delete(id);
      set({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    set((s) => {
      const runningSessions = { ...s.runningSessions };
      const shellTurns = { ...s.shellTurns };
      for (const id of [sid, ...descendants]) {
        delete runningSessions[id];
        delete shellTurns[id];
      }
      const cur = s.threads[sid] ?? emptyThread();
      // A step that was mid-flight when the turn was stopped never finished, so
      // it must stop looking active — its spinner otherwise turns forever on a
      // turn that is over. Reloading the session already renders exactly this
      // ("pending", see historyToThread), so the live path just has to agree.
      // Subagent threads settle too: the abort took that whole subtree down.
      const settled: Record<string, Thread> = {};
      for (const id of [sid, ...descendants]) {
        const t = id === sid ? cur : s.threads[id];
        if (!t) continue;
        settled[id] = {
          ...t,
          blocks: t.blocks.map((b) =>
            b.kind === "tool-call" && (b.status === "running" || b.status === "waiting-approval")
              ? { ...b, status: "pending" as const }
              : b,
          ),
        };
      }
      return {
        runningSessions,
        shellTurns,
        // Drop the asks the stopped turn was blocked on. The server deletes its
        // pending permission/question on interrupt but publishes NO resolved
        // event for it (Permission.ask only clears its own map in `ensuring`),
        // so nothing else would ever retire the card — it would sit there
        // forever, still clickable, answering into a request that no longer
        // exists (#59). Subagent asks go too: the abort took that subtree down.
        questions: s.questions.filter((q) => !stoppedAsk(s.sessionParents, sid, q.sessionId)),
        permissions: s.permissions.filter((p) => !stoppedAsk(s.sessionParents, sid, p.sessionId)),
        threads: {
          ...s.threads,
          ...settled,
          [sid]: {
            ...(settled[sid] ?? cur),
            loaded: true,
            blocks: [
              ...(settled[sid] ?? cur).blocks,
              { kind: "status-line", text: "Interrupted", tone: "error" },
            ],
          },
        },
      };
    });
  },

  editMessage: async (messageID, newText, sessionId) => {
    if (await revertToMessage(set, get, messageID, sessionId))
      await get().sendPrompt(newText, sessionId);
  },

  revertMessage: async (messageID, sessionId) => revertToMessage(set, get, messageID, sessionId),

  reconcileRunning: async () => {
    const c = client;
    const running = Object.keys(get().runningSessions);
    if (!c || running.length === 0) return;
    for (const sid of running) {
      try {
        const messages = await c.getMessages(sid);
        // Still ours to answer for? The lock may have cleared while we fetched.
        if (!turnIsOver(messages) || !get().runningSessions[sid]) continue;
        void logDebug(`reconcile: missed idle for ${sid} — unlocking`);
        set((s) => {
          const runningSessions = { ...s.runningSessions };
          const shellTurns = { ...s.shellTurns };
          delete runningSessions[sid];
          delete shellTurns[sid];
          return {
            runningSessions,
            shellTurns,
            // The idle was missed, so the tail of the turn was too — replace
            // the thread with the full history rather than leave it stale.
            threads: {
              ...s.threads,
              [sid]: { ...historyToThread(messages, s.commands), loaded: true },
            },
            // Same for the agent pill (a plan_exit flip may have been missed).
            sessionAgents: { ...s.sessionAgents, [sid]: lastAgentMode(messages) },
          };
        });
      } catch {
        /* best-effort — the next reconnect or poll tries again */
      }
    }
  },

  deleteSession: async (id) => {
    if (client) {
      try {
        await client.deleteSession(id);
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
    }
    // A queued review for a session that no longer exists would send into a
    // deleted conversation, and one in flight holds the slot forever.
    forgetAutoReview(id);
    drainReviewQueue(set, get);
    set((s) => {
      const threads = { ...s.threads };
      delete threads[id];
      const runningSessions = { ...s.runningSessions };
      delete runningSessions[id];
      const panes = { ...s.panes };
      delete panes[id];
      const sessionAgents = { ...s.sessionAgents };
      delete sessionAgents[id];
      const backgroundReviews = { ...s.backgroundReviews };
      delete backgroundReviews[id];
      return {
        sessions: s.sessions.filter((x) => x.id !== id),
        threads,
        runningSessions,
        panes,
        sessionAgents,
        backgroundReviews,
        currentId: s.currentId === id ? null : s.currentId,
      };
    });
  },

  renameSession: async (id, title) => {
    const trimmed = title.trim();
    const current = get().sessions.find((s) => s.id === id);
    if (!client || !trimmed || !current || trimmed === current.title) return false;
    try {
      await client.renameSession(id, trimmed);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return false;
    }
    // Rename locally rather than re-listing: the sidebar row must change under
    // the pointer, and a full refresh would also reorder the list.
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, title: trimmed } : x)),
    }));
    return true;
  },

  moveSessionToWorkspace: async (id, directory) => {
    const oc = getClient();
    // Re-homing a session is OpenCode control-plane surface, not part of the
    // runtime-agnostic port — go through the concrete client.
    if (!oc) return false;
    try {
      await oc.moveSession(id, directory);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return false;
    }
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, directory } : x)),
    }));
    // The move also re-parents the session's own children; re-list so their
    // grouping follows instead of pointing at the old folder.
    void get().refreshSessions();
    return true;
  },

  setSessionArchived: async (id, archived) => {
    if (!client) return false;
    try {
      await client.setSessionArchived(id, archived);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return false;
    }
    // The sidebar's window holds only ACTIVE conversations, so an archived one
    // leaves it at once; a restored one comes back with the next refresh.
    set((s) => ({ sessions: s.sessions.filter((x) => x.id !== id) }));
    if (!archived) void get().refreshSessions();
    return true;
  },

  hideExample: (id) => {
    const next = Array.from(new Set([...get().hiddenExamples, id]));
    if (typeof window !== "undefined") window.localStorage.setItem(HIDDEN_KEY, JSON.stringify(next));
    set({ hiddenExamples: next });
  },

  // Install a skill (#1). Installed skills land in the app profile's user
  // skills dir, which OpenCode scans for every workspace — writing them into
  // the session's own .opencode/skills/ loses them with that dated folder (#61).
  installSkill: async (text) => {
    // A pasted SKILL.md needs no model: the app writes it itself. This also
    // works before any provider is configured.
    if (isTauri && looksLikeSkillFile(text)) {
      try {
        const name = await installSkillMarkdown(text);
        // The sidecar restarted to rediscover it — pick the new list up.
        await get().connectRetry();
        await get().loadCatalog();
        toast.success(i18n.t("pages:skills.install.installed", { name }));
        return { kind: "installed", name };
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
        return null;
      }
    }
    if (!client) {
      set({ error: "Connect the runtime first to install skills." });
      return null;
    }
    try {
      // Installing a skill is not part of whatever project happens to be open:
      // give it its own plain dated folder (what any new session gets) so the
      // session does not end up filed under that project. Nobody pinned this
      // folder, so the user's next new session goes back to the default.
      if (isTauri) {
        await get().switchWorkspace({ dated: datedWorkspaceName() });
        set((s) => forgetDraftFolder(s, DRAFT_KEY));
        if (get().status !== "ready" || !client) {
          throw new Error("Runtime did not reconnect after creating the install folder.");
        }
      }
      // Snapshot: whatever the agent adds on top of this is what gets adopted.
      // Only the desktop can adopt (the profile lives on the host) — over the
      // web the skill stays workspace-scoped, which is all a web client can do.
      if (isTauri) {
        pendingSkillInstall = {
          sessionId: null,
          known: await workspaceSkillNames().catch(() => []),
        };
      }
      const title = i18n.t("pages:skills.install.sectionTitle");
      const id = await client.createSession(title);
      if (pendingSkillInstall) pendingSkillInstall.sessionId = id;
      await get().refreshSessions();
      // Its OWN Screen with its own pane. Binding the install onto whatever pane
      // happened to be focused took over a conversation the user was in the
      // middle of — an install is a new piece of work, not a hijack.
      useLayoutStore.getState().openInNewGroup(id, title);
      // The turn goes through the normal send path (echo, running lock, error
      // line, stream folding) — hand-rolling the POST left the pane with no
      // message, no spinner and no way to tell a failure from a slow model.
      // Both texts are localized: the thread shows one short ask around what the
      // user typed, the model gets the full install instructions.
      const echo = i18n.t("pages:skills.install.echo", { input: text });
      const prompt = i18n.t("pages:skills.install.agentPrompt", { input: text });
      const model = modelForSession(get(), id).model;
      // Deliberately not awaited: the caller opens the new pane immediately and
      // watches the turn there (performTurn reports failures into the thread).
      void performTurn(
        set,
        get,
        echo,
        (sid) => withRetry(() => client!.sendPrompt(sid, prompt, undefined, model)),
        // Same reason as the composer's send: an ACP `session/prompt` answers
        // when the turn is OVER, so its lock has to be taken before the call.
        get().runtimeKind === "acp",
        false,
        id,
      );
      return { kind: "session", id };
    } catch (err) {
      pendingSkillInstall = null;
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  syncPaneStreams: (directories) => {
    // The foreground `client` already streams the active folder; web is
    // single-pane. Open one background stream per OTHER folder shown, and close
    // streams for folders no longer tiled.
    if (isGatewayWeb || !opencodeClient) return;
    const foreground = get().workspace;
    const wanted = new Set(directories.filter((d): d is string => !!d && d !== foreground));
    for (const dir of [...streamClients.keys()]) {
      // The FOREGROUND folder's stream still closes at once — the foreground
      // client covers it, and two live streams would fold every event twice.
      // Anything else only leaves the tiled set, which a screen switch does to
      // a whole screen's worth of folders at a time; give those a grace period.
      if (!wanted.has(dir)) {
        if (dir === foreground) removeStreamClient(dir);
        else retireStreamClient(dir);
      }
    }
    for (const dir of wanted) {
      // Back before its retirement fired: keep the stream, cancel the timer.
      cancelStreamRetirement(dir);
      if (streamClients.has(dir)) continue;
      const c = new OpenCodeClient({
        baseUrl: streamBaseUrl,
        directory: dir,
        password: streamPassword,
      });
      if (sharedEventHandler) c.onEvent(sharedEventHandler);
      streamClients.set(dir, c);
      // Best-effort: a background stream that can't open just leaves that pane
      // non-live until it's focused (foreground reconnect covers it).
      void c.connect().catch(() => {});
    }
  },
}));

/** Dated folder name like `2026-07-04-1615` for a fresh per-session workspace. */
export function datedWorkspaceName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

export interface FoldState {
  blocks: ThreadBlock[];
  index: Record<string, number>;
}

/** Pure reducer: fold one normalized OpenCode event into a thread's blocks. */
/**
 * Tidy a tool-call title for the conversation: show workspace files by their
 * relative path (`demo/analyze.py`), not the full `/Users/.../OpenScience/...`
 * absolute path, so the thread reads like a researcher's log, not a shell trace.
 * The workspace path never contains spaces (by design), so a space-free run
 * ending in `OpenScience/` matches it whether or not it has a leading slash
 * (OpenCode's write-tool titles drop it).
 */
export function tidyToolTitle(title: string): string {
  return title.replace(/[^\s]*OpenScience\//g, "").trim() || title;
}

/**
 * De-noise a bash command for the one-line title: collapse whitespace and
 * strip leading `cd <dir> &&` / `cd <dir>;` hops (repeatedly), so the step
 * reads `python train.py --mode teacher`, not `cd output/very/long/path && …`.
 * The full command stays available in the expanded detail.
 */
export function humanizeCommand(command: string): string {
  let c = command.replace(/\s+/g, " ").trim();
  for (;;) {
    const m = /^cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/.exec(c);
    if (!m) break;
    c = c.slice(m[0].length);
  }
  return c || command.trim();
}

/**
 * Progress bars (tqdm, pip, curl) redraw lines with `\r` — keep only what
 * each line last drew so live output shows one updating line, not hundreds.
 */
export function foldCarriageReturns(text: string): string {
  return text
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n");
}

/** Live-tail cap: enough for a handful of lines, tiny in the store. */
const LIVE_TAIL_MAX = 4_000;
/** Expanded-detail cap: plenty to read inline, never megabytes in the store. */
const DETAIL_MAX = 64_000;
const capTail = (t: string, max: number) => (t.length > max ? "…" + t.slice(-max) : t);
const capHead = (t: string, max: number) => (t.length > max ? t.slice(0, max) + "\n…" : t);

const str = (v: unknown) => (typeof v === "string" ? v : "");
const EDIT_TOOLS = new Set(["edit", "str_replace_editor", "apply_patch"]);

/**
 * Verb + subject for a tool step ("Ran" + `python train.py …`, "Created" +
 * `demo/analyze.py`) — recognizable at a glance, Codex-style. Tools without
 * a natural verb keep the old title fallback chain (server title → command →
 * file path → tool name).
 */
export function toolPresentation(
  tool: string,
  title: string | undefined,
  input?: Record<string, unknown>,
): { verb?: ToolVerb; title: string } {
  const command = str(input?.command);
  const filePath = str(input?.filePath) || str(input?.path);
  const fallback = tidyToolTitle(title?.trim() || command || filePath || tool || "tool");
  const file = filePath ? tidyToolTitle(filePath) : "";
  switch (tool) {
    case "bash":
      return { verb: "Ran", title: command ? humanizeCommand(tidyToolTitle(command)) : fallback };
    case "write":
    case "create":
      return { verb: "Created", title: file || fallback };
    case "edit":
    case "str_replace_editor":
    case "apply_patch":
      return { verb: "Edited", title: file || fallback };
    case "read":
      return { verb: "Read", title: file || fallback };
    case "grep":
    case "glob":
      return { verb: "Searched", title: str(input?.pattern) || fallback };
    case "list":
      return { verb: "Listed", title: file || fallback };
    case "webfetch":
      return { verb: "Fetched", title: str(input?.url) || fallback };
    default:
      return { title: fallback };
  }
}

export function foldEvent(
  state: FoldState,
  event: OpenCodeEvent,
  opts?: { shellTurn?: boolean },
): FoldState {
  const blocks = [...state.blocks];
  const index = { ...state.index };
  switch (event.type) {
    case "text.updated": {
      // A ```review fence in the agent's text becomes a structured reviewer card.
      const { clean, review } = splitReview(event.text);
      const key = `text:${event.partId}`;
      const id = event.messageID ? { messageID: event.messageID } : {};
      if (key in index) {
        // Keep whatever `message.usage` already stamped on this block — the
        // turn's tokens arrive on their own event, interleaved with the text.
        const prev = blocks[index[key]];
        const kept = prev.kind === "agent" ? prev : undefined;
        blocks[index[key]] = {
          ...kept,
          kind: "agent",
          markdown: clean,
          ...id,
        };
      } else if (clean) {
        blocks.push({ kind: "agent", markdown: clean, ...id });
        index[key] = blocks.length - 1;
      }
      if (review) {
        const rkey = `review:${event.partId}`;
        if (rkey in index) blocks[index[rkey]] = review;
        else {
          blocks.push(review);
          index[rkey] = blocks.length - 1;
        }
      }
      return { blocks, index };
    }
    case "tool.updated": {
      // The interactive `question`/`permission` tools render as their own
      // answerable card (InteractionPrompt), not as a blank thread row. `todo*`
      // tools only report an opaque "N todos" count with no useful content —
      // pure noise in the conversation, so drop them.
      if (/question|permission|^ask$|todo/i.test(event.tool)) return { blocks, index };
      const key = `tool:${event.callId}`;
      const command = str(event.input?.command);
      const filePath = str(event.input?.filePath) || str(event.input?.path);
      const content = str(event.input?.content);
      // Some updates omit fields earlier ones carried (a task tool names its
      // subagent session once; time.start only rides the first events) —
      // carry them over from the previous version of the block.
      const prev = key in index ? blocks[index[key]] : undefined;
      const prevTool = prev?.kind === "tool-call" ? prev : undefined;
      const childSessionId = event.childSessionId ?? prevTool?.childSessionId;
      const startedAt = event.startedAt ?? prevTool?.startedAt;
      const endedAt = event.endedAt ?? prevTool?.endedAt;
      // Edit tools report a proper unified diff in metadata on completion;
      // until (or without) that, synthesize a minimal old→new view.
      const diff =
        event.diff ??
        prevTool?.diff ??
        (EDIT_TOOLS.has(event.tool) && (str(event.input?.oldString) || str(event.input?.newString))
          ? [
              ...str(event.input?.oldString).split("\n").map((l) => `- ${l}`),
              ...str(event.input?.newString).split("\n").map((l) => `+ ${l}`),
            ].join("\n")
          : undefined);
      const { verb, title } = toolPresentation(event.tool, event.title, event.input);
      const block: ThreadBlock = {
        kind: "tool-call",
        title,
        status: event.status,
        tool: event.tool,
        ...(verb ? { verb } : {}),
        ...(command ? { command } : {}),
        ...(filePath ? { filePath: tidyToolTitle(filePath) } : {}),
        ...(content ? { content: capHead(content, DETAIL_MAX) } : {}),
        ...(diff ? { diff: capHead(diff, DETAIL_MAX) } : {}),
        // Live stdout tail while running — the "is it alive?" signal.
        ...(event.status === "running" && event.partialOutput
          ? { partialOutput: capTail(foldCarriageReturns(event.partialOutput), LIVE_TAIL_MAX) }
          : {}),
        ...(event.output?.trim()
          ? { output: capTail(foldCarriageReturns(event.output), DETAIL_MAX).replace(/\s+$/, "") }
          : {}),
        ...(startedAt ? { startedAt } : {}),
        ...(endedAt ? { endedAt } : {}),
        ...(childSessionId ? { childSessionId } : {}),
        // A user-typed "!" command ran for its output — its detail opens by
        // default. Agent bash steps stay quiet one-liners until expanded.
        ...(opts?.shellTurn && event.tool === "bash" && event.output?.trim()
          ? { outputSummary: event.output.replace(/\s+$/, "") }
          : {}),
      };
      if (key in index) blocks[index[key]] = block;
      else {
        blocks.push(block);
        index[key] = blocks.length - 1;
      }
      // Surface a file the agent wrote as a traceable artifact (deduped by path).
      const artifact = deriveArtifact(event);
      if (artifact) {
        const akey = `artifact:${artifact.path}`;
        if (akey in index) blocks[index[akey]] = artifact;
        else {
          blocks.push(artifact);
          index[akey] = blocks.length - 1;
        }
      }
      const presentation = deriveArtifactPresentation(event);
      if (presentation?.display === "inline") {
        const pkey = `presentation:${event.callId}`;
        if (pkey in index) blocks[index[pkey]] = presentation.artifact;
        else {
          blocks.push(presentation.artifact);
          index[pkey] = blocks.length - 1;
        }
      }
      return { blocks, index };
    }
    case "reasoning.updated": {
      const key = `reasoning:${event.partId}`;
      const block: ThreadBlock = { kind: "reasoning", text: event.text };
      if (key in index) blocks[index[key]] = block;
      else {
        blocks.push(block);
        index[key] = blocks.length - 1;
      }
      return { blocks, index };
    }
    case "session.compacted": {
      // One marker per compaction, appended where it happened so the reader
      // can see which stretch of the conversation was summarized away.
      blocks.push({
        kind: "compaction",
        auto: event.auto,
        ...(event.overflow ? { overflow: true } : {}),
        at: Date.now(),
      });
      return { blocks, index };
    }
    case "message.usage": {
      // Stamp the turn's tokens onto every text block that message produced —
      // one turn can emit several (a tool call splits the answer in two), and
      // each of them belongs to the same accounting. Republished throughout
      // the turn, so this overwrites rather than accumulates.
      let touched = false;
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i];
        if (b.kind !== "agent" || b.messageID !== event.messageID) continue;
        blocks[i] = {
          ...b,
          usage: event.usage,
          ...(event.created ? { created: event.created } : {}),
          ...(event.completed ? { completed: event.completed } : {}),
        };
        touched = true;
      }
      // Usage can land before the text it belongs to (a turn that called tools
      // first reports tokens with no answer yet). Nothing to stamp; the next
      // republish after the text arrives carries the same numbers.
      return touched ? { blocks, index } : state;
    }
    case "session.idle": {
      const last = blocks[blocks.length - 1];
      // A turn that already ended in a red line must not then be told it is
      // "done": the server emits session.idle after a failed turn too, so the
      // error and a cheerful "done" appeared one under the other and a request
      // that never ran read as a completed one (#114). Covers "Interrupted"
      // from the Stop path for the same reason.
      if (last?.kind === "status-line" && (last.tone === "done" || last.tone === "error")) {
        return { blocks, index };
      }
      blocks.push({ kind: "status-line", text: "done", tone: "done" });
      return { blocks, index };
    }
    default:
      return state;
  }
}

/**
 * One-line live activity of a subagent, derived from its folded thread:
 * the latest tool step's title, "Writing…" while it streams text, and
 * "Working…" before anything is known (e.g. right after an app reload).
 */
export function subagentActivity(blocks?: ThreadBlock[]): string {
  for (let i = (blocks?.length ?? 0) - 1; i >= 0; i--) {
    const b = blocks![i];
    if (b.kind === "tool-call") return b.title;
    if (b.kind === "agent") return "Writing…";
  }
  return "Working…";
}

function mapToolStatus(status?: string): ToolCallStatus {
  switch (status) {
    case "running":
      return "running";
    case "completed":
      return "success";
    case "error":
      return "failed";
    default:
      return "pending";
  }
}

/** Convert loaded message history into thread blocks. */
/** The agent mode a session's history says it is in: the last user message's
 *  agent (upstream stamps every user message; unknown agents read as build). */
export function lastAgentMode(messages: HistoryMessage[]): AgentMode {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    // Only the two modes the pill can show count. A turn on any other agent —
    // the auto-review's `reviewer`, a custom primary — says nothing about which
    // mode the user left the composer in, so it is skipped rather than read as
    // Build (which would silently drop a session out of Plan mode on reload).
    if (m.role === "user" && (m.agent === "plan" || m.agent === "build")) return m.agent;
  }
  return "build";
}

export function historyToThread(messages: HistoryMessage[], commands?: CommandInfo[]): FoldState {
  const blocks: ThreadBlock[] = [];
  // OpenCode stores a slash command's EXPANDED template as the user message —
  // show the "/name args" the user actually typed instead. Templates either
  // embed a $ARGUMENTS placeholder anywhere (match prefix + suffix around it,
  // e.g. the goal plugin's <goal_command_arguments> block) or carry no
  // placeholder (typed args are appended after the template, no marker).
  // Longest template first, so one template being a prefix of another's
  // expansion can't mis-attribute.
  const templates = (commands ?? [])
    .filter((c) => c.template?.trim())
    .map((c) => ({ name: c.name, template: c.template!.trim() }))
    .sort((a, b) => b.template.length - a.template.length);
  const asTypedCommand = (text: string): string | undefined => {
    for (const t of templates) {
      const at = t.template.indexOf("$ARGUMENTS");
      if (at < 0) {
        if (!text.startsWith(t.template)) continue;
        const args = text.slice(t.template.length).trim();
        return args ? `/${t.name} ${args}` : `/${t.name}`;
      }
      const prefix = t.template.slice(0, at);
      const suffix = t.template.slice(at + "$ARGUMENTS".length).trimEnd();
      if (!text.startsWith(prefix)) continue;
      const rest = text.trimEnd();
      if (suffix && !rest.endsWith(suffix)) continue;
      const args = rest.slice(prefix.length, suffix ? rest.length - suffix.length : undefined).trim();
      return args ? `/${t.name} ${args}` : `/${t.name}`;
    }
    return undefined;
  };
  // A step frozen mid-run (the runtime restarted or the turn was killed before
  // it finished) must not spin forever in history — render it quietly and say
  // once, at the end, that the turn was interrupted.
  let interrupted = false;
  // A user-typed "!" command is recorded as a synthetic user text plus a bash
  // tool part on the next assistant message. Render it like the live path:
  // the "! cmd" echo and the output inline — never the synthetic marker text.
  let shellTurn = false;
  // Once the history is malformed EVERY later turn fails the same way, so a
  // session reopens with a run of identical errors — the reporter of #114 had
  // three. One repair offer, on the last of them: the fix is the same for all,
  // and a stack of identical cards reads as a stack of separate problems.
  const lastMalformed = messages.reduce(
    (at, m, index) => (m.error && MALFORMED_HISTORY.test(m.error) ? index : at),
    -1,
  );
  for (const [messageIndex, m] of messages.entries()) {
    // Compaction is checked before the role split, because OpenCode stores the
    // marker on a message with role "user" (SessionCompaction.create opens one
    // solely to hang the part off). Reading it only on assistant messages made
    // every reopened conversation lose the seam — turns disappear from the
    // model's view with nothing on screen to say why.
    const compaction = m.parts.find((p) => p.type === "compaction");
    if (compaction) {
      const c = compaction as unknown as { auto?: boolean; overflow?: boolean };
      blocks.push({
        kind: "compaction",
        auto: c.auto !== false,
        ...(c.overflow ? { overflow: true } : {}),
        // The part carries no clock of its own, so its message dates it.
        ...(m.created ? { at: m.created } : {}),
      });
      // That message exists only to carry the marker — it has no text to show.
      continue;
    }
    if (m.role === "user") {
      shellTurn = m.parts.some((p) => p.type === "text" && p.synthetic);
      if (shellTurn) continue;
      const text = m.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("")
        .trim();
      // The app's own auto-review turn (#72): the user never wrote it, so it is
      // not shown as their message — on reload as well as live. The reviewer's
      // answer and its findings card stay. Goal mode's auto-continue turns are
      // hidden the same way: the plugin writes them straight into the session,
      // and the pill (not a wall of policy text) is where a goal reports itself.
      if (text === AUTO_REVIEW_PROMPT || isGoalInjectedPrompt(text)) continue;
      const command = asTypedCommand(text);
      // Tag with the message id so the row can be edited (revert + resend).
      // A "/command" echo keeps the id too — editing re-runs the command.
      const id = m.id ? { messageID: m.id } : {};
      if (command) blocks.push({ kind: "user", text: command, ...id });
      else if (text) blocks.push({ kind: "user", text, ...id });
    } else {
      // Same accounting the live stream stamps on, recovered from the stored
      // message so a reopened conversation shows the identical meta line.
      const meta = {
        ...(m.id ? { messageID: m.id } : {}),
        ...(m.created ? { created: m.created } : {}),
        ...(m.completed ? { completed: m.completed } : {}),
        ...(m.usage ? { usage: m.usage } : {}),
      };
      for (const p of m.parts) {
        if (p.type === "text" && p.text?.trim()) {
          const { clean, review } = splitReview(p.text);
          if (clean) blocks.push({ kind: "agent", markdown: clean, ...meta });
          if (review) blocks.push(review);
        }
        else if (p.type === "reasoning" && p.text?.trim()) {
          blocks.push({ kind: "reasoning", text: p.text });
        }
        else if (p.type === "tool") {
          // Interactive tools are surfaced by InteractionPrompt, not the thread;
          // `todo*` tools are opaque "N todos" noise — skip both.
          if (/question|permission|^ask$|todo/i.test(p.tool ?? "")) continue;
          const status = mapToolStatus(p.state?.status);
          const frozen = status === "running" || status === "pending";
          if (frozen) interrupted = true;
          const command = str(p.state?.input?.command);
          const filePath = str(p.state?.input?.filePath) || str(p.state?.input?.path);
          const content = str(p.state?.input?.content);
          const diff =
            str(p.state?.metadata?.diff) ||
            (EDIT_TOOLS.has(p.tool ?? "") &&
            (str(p.state?.input?.oldString) || str(p.state?.input?.newString))
              ? [
                  ...str(p.state?.input?.oldString).split("\n").map((l) => `- ${l}`),
                  ...str(p.state?.input?.newString).split("\n").map((l) => `+ ${l}`),
                ].join("\n")
              : "");
          const userShell = shellTurn && p.tool === "bash";
          if (userShell) blocks.push({ kind: "user", text: `! ${command}` });
          const { verb, title } = toolPresentation(p.tool ?? "", p.state?.title, p.state?.input);
          blocks.push({
            kind: "tool-call",
            title,
            status: frozen ? "pending" : status,
            tool: p.tool,
            ...(verb ? { verb } : {}),
            ...(command ? { command } : {}),
            ...(filePath ? { filePath: tidyToolTitle(filePath) } : {}),
            ...(content ? { content: capHead(content, DETAIL_MAX) } : {}),
            ...(diff ? { diff: capHead(diff, DETAIL_MAX) } : {}),
            ...(p.state?.output?.trim()
              ? { output: capTail(foldCarriageReturns(p.state.output), DETAIL_MAX).replace(/\s+$/, "") }
              : {}),
            ...(typeof p.state?.time?.start === "number" ? { startedAt: p.state.time.start } : {}),
            ...(typeof p.state?.time?.end === "number" ? { endedAt: p.state.time.end } : {}),
            // The subagent session this task spawned. The live fold keeps it
            // from the event; rebuilding history dropped it, so every subagent
            // in a reloaded conversation became unopenable.
            ...(p.state?.metadata?.sessionId
              ? { childSessionId: p.state.metadata.sessionId }
              : {}),
            ...(userShell && p.state?.output?.trim()
              ? { outputSummary: p.state.output.replace(/\s+$/, "") }
              : {}),
          });
          const artifact = deriveArtifact({
            type: "tool.updated",
            sessionId: "",
            callId: "",
            tool: p.tool ?? "",
            status,
            input: p.state?.input,
            output: p.state?.output,
          });
          if (artifact) blocks.push(artifact);
          const presentation = deriveArtifactPresentation({
            type: "tool.updated",
            sessionId: "",
            callId: "",
            tool: p.tool ?? "",
            status,
            input: p.state?.input,
            output: p.state?.output,
          });
          if (presentation?.display === "inline") blocks.push(presentation.artifact);
        }
      }
      // A turn that ended in a provider/runtime error must say so on reload —
      // its live session.error is gone (SSE reconnect, app restart) and an
      // empty reply followed by "done" explains nothing. User-interrupted
      // turns are not errors; the trailing "Interrupted" line covers those.
      if (m.error && !/abort/i.test(m.error)) {
        // Same explanation the live line got: a restart is exactly when the user
        // no longer has the context to work out what to do about it.
        blocks.push({ kind: "status-line", text: explainRuntimeError(m.error), tone: "error" });
        // …and the same repair offer. The damage is on disk, so reopening the
        // session shows the failure again; without this the way out would exist
        // only in the tab that happened to be open when it first happened. The
        // scan runs off `messages`, already in hand — no fetch, unlike the live
        // path (#114).
        if (messageIndex === lastMalformed) blocks.push(historyRepairBlock(messages));
      }
      shellTurn = false;
    }
  }
  if (interrupted) {
    blocks.push({
      kind: "status-line",
      text: "Interrupted — this turn did not finish. Send a new message to continue.",
      tone: "error",
    });
  }
  return { blocks, index: {} };
}
