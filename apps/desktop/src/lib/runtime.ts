import { create } from "zustand";
import {
  OpenCodeClient,
  DEFAULT_OPENCODE_URL,
  type AgentInfo,
  type AgentRuntime,
  type CommandInfo,
  type HistoryMessage,
  type OpenCodeEvent,
  type PermissionAskedEvent,
  type PermissionReply,
  type QuestionAskedEvent,
  type SessionMeta,
  type SkillInfo,
  type ToolCallStatus,
} from "@ai4s/sdk";
import type { ArtifactBlock, RuntimeStatus, ThreadBlock, ToolVerb } from "@ai4s/shared";
import {
  detectTools as probeTools,
  commitWorkspaceSnapshot,
  createProject as createProjectFolder,
  importProject as importProjectFolder,
  setProjectPinned as setProjectPinnedCmd,
  deleteProject as deleteProjectCmd,
  getApprovalMode,
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
  workspacePath,
  type ApprovalMode,
  type ProjectInfo,
  type ProxyMode,
  type ToolStatus,
} from "./tauri";
import { kernelReset } from "./kernel";
import { moveScrollMemory } from "./scrollMemory";
import { deriveArtifact } from "./artifacts";
import { provenanceInputsFromEvent, recordProvenance } from "./provenance";
import { recordRun, runInputFromEvent } from "./runs";
import { splitReview } from "./review";
import { notifyPermissionRequest } from "./systemNotification";
import { fallbackDefaultModel } from "@/components/settings/modelCatalog";
import { toast } from "@/lib/toast";
import i18n from "@/i18n";
import {
  loadSelectionPreferences,
  resolveSelection,
  saveSelectionPreferences,
  type ModelSelection,
} from "./modelSelection";
import type { ProviderInfo } from "@ai4s/sdk";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const URL_KEY = "ai4s.opencodeUrl";
const HIDDEN_KEY = "ai4s.hiddenExamples";

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

export interface Thread {
  blocks: ThreadBlock[];
  index: Record<string, number>;
  loaded: boolean;
}

/** What a session's right pane shows: an artifact inspector, the Files
 *  browser, the Runs ledger, or nothing. Mutually exclusive — one pane. */
export interface PaneState {
  artifact: ArtifactBlock | null;
  showFiles: boolean;
  showRuns: boolean;
}

interface RuntimeState {
  status: RuntimeStatus;
  serverUrl: string;
  sessions: SessionMeta[];
  currentId: string | null;
  threads: Record<string, Thread>;
  skills: SkillInfo[];
  agents: AgentInfo[];
  /** Slash commands the runtime can run ("/" palette): config commands,
   *  skills and MCP prompts, one merged list from GET /command. */
  commands: CommandInfo[];
  /** Configured default model ("provider/model"), or null when unset. */
  defaultModel: string | null;
  /** Apply a new default model and transparently reconnect (see impl). */
  setDefaultModel: (model: string) => Promise<void>;
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
  setAgentMode: (mode: AgentMode) => void;
  openArtifact: (a: ArtifactBlock) => void;
  closeArtifact: () => void;
  setShowFiles: (show: boolean) => void;
  setShowRuns: (show: boolean) => void;
  answerQuestion: (requestId: string, answers: string[][]) => Promise<void>;
  rejectQuestion: (requestId: string) => Promise<void>;
  replyPermission: (requestId: string, reply: PermissionReply) => Promise<void>;
  setServerUrl: (url: string) => void;
  loadCatalog: () => Promise<void>;
  detectTools: () => Promise<void>;
  connect: () => Promise<void>;
  /** Resolves true once connected, false when the retry window is exhausted. */
  connectRetry: (tries?: number) => Promise<boolean>;
  bootstrap: () => Promise<void>;
  disconnect: () => void;
  refreshSessions: () => Promise<void>;
  startDraft: () => void;
  startDraftInCurrentWorkspace: () => void;
  /** Projects: named shared-workspace folders under the base dir. Sessions
   *  group under a project by `directory`; multiple sessions share the folder. */
  projects: ProjectInfo[];
  refreshProjects: () => Promise<void>;
  /** Create a project folder and move into it with a fresh pinned draft. */
  createProject: (name: string) => Promise<ProjectInfo | null>;
  importProject: (path: string) => Promise<ProjectInfo | null>;
  setProjectPinned: (id: string, pinned: boolean) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  /** Fresh draft pinned inside `path` (a project folder), so the next new
   *  session lands there. Skips the reconnect when the folder is already active. */
  startDraftInWorkspace: (path: string) => Promise<void>;
  /** Active workspace folder (absolute path); null in the browser. */
  workspace: string | null;
  /** True when the user explicitly picked the active folder for the next new
   *  session; false means a new session gets its own fresh dated folder. */
  workspacePinned: boolean;
  /** A deliberate workspace move is in flight (event-stream reconnect into the
   *  new folder). The UI must not present it as a disconnection — no status
   *  flip, no Connect button, no help card. Real failures surface after the
   *  retry window is exhausted, once this clears. */
  switching: boolean;
  /** A sendPrompt is in flight (click → POST accepted). Locks the composer. */
  sending: boolean;
  /** Sessions with an active turn (send accepted, session.idle not yet seen).
   *  Drives the composer lock and the "Working…" indicator. */
  runningSessions: Record<string, true>;
  /** Sessions whose current turn is a user-typed "!" shell command. Their bash
   *  output shows inline in the thread — the output IS the result the user
   *  asked for. Agent bash steps stay quiet single-line log entries. */
  shellTurns: Record<string, true>;
  /** Sessions whose model call failed and is being retried server-side —
   *  OpenCode backs off with no attempt cap, so this is what keeps a broken
   *  provider from looking like a silent "Working…" forever. Cleared by the
   *  session's next sign of life (stream events, idle, error). */
  retryNotices: Record<string, { attempt: number; message: string }>;
  /** Switch to an existing folder, or (with `dated`) create a new dated one. */
  switchWorkspace: (target: { path: string } | { dated: string }) => Promise<void>;
  /** Ensure a brand-new draft already has its own (pinned) dated folder before
   *  composer files are written into it — otherwise a file added to a draft
   *  lands in the pre-send folder while send would create a different dated one,
   *  orphaning it. No-op once a session exists or the folder is already pinned. */
  ensureDraftWorkspace: () => Promise<void>;
  openSession: (id: string) => Promise<void>;
  sendPrompt: (text: string) => Promise<string | null>;
  /** Run a "!" shell command directly in the session's workspace folder —
   *  no model turn; the output folds into the thread as a bash tool row. */
  runShell: (command: string) => Promise<string | null>;
  /** Run a "/" slash command (config command / skill / MCP prompt). */
  runCommand: (name: string, args?: string) => Promise<string | null>;
  /** Interrupt the current session's running turn (Stop button / Esc). */
  interrupt: () => Promise<void>;
  /** Check every session holding a running lock against the server: if its
   *  turn is actually over (idle was missed — SSE reconnect windows, the
   *  directory-scoped event stream), reload the missed history and unlock. */
  reconcileRunning: () => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  hideExample: (id: string) => void;
  installSkill: (text: string) => Promise<string | null>;
  /** Providers catalog loaded from the runtime. */
  providers: ProviderInfo[];
  /** Initial selection for new conversations. */
  defaultSelection: ModelSelection | null;
  /** Per-session selections keyed by session ID. */
  sessionSelections: Record<string, ModelSelection>;
  /** Selection for the not-yet-created draft. */
  draftSelection: ModelSelection | null;
  /** Apply a selection to the current conversation only. */
  setCurrentSelection: (selection: ModelSelection) => void;
  /** Apply a selection as the current conversation choice AND future default. */
  setDefaultSelection: (selection: ModelSelection) => Promise<void>;
}

// The internal store depends only on the runtime-agnostic AgentRuntime contract
// (see docs/rfc/agent-runtime.md). The concrete reference (opencodeClient) is
// kept separately so getClient() can hand Settings/setup the full OpenCode
// provider/MCP surface that lives outside the AgentRuntime contract.
let client: AgentRuntime | null = null;
let opencodeClient: OpenCodeClient | null = null;
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
/** Unhook the current client's status listener BEFORE closing it — teardown
 *  emits "offline", and a reconnect attempt must not flash that at the user. */
let clientStatusUnsub: (() => void) | null = null;
/** The SDK recovers a dropped stream in ~250ms (OpenCode closes /event ~1s
 *  after a config PATCH while rebuilding its instance). Surfacing that blip
 *  repaints every status consumer, so a ready→connecting flip is held this
 *  long and only shown if the stream does not come back. */
const STATUS_BLIP_GRACE_MS = 2000;
let statusBlipTimer: ReturnType<typeof setTimeout> | null = null;
function clearStatusBlip() {
  if (statusBlipTimer !== null) clearTimeout(statusBlipTimer);
  statusBlipTimer = null;
}
function teardownClient() {
  clientStatusUnsub?.();
  clientStatusUnsub = null;
  clearStatusBlip();
  client?.close();
  client = null;
  opencodeClient = null;
}
const emptyThread = (): Thread => ({ blocks: [], index: {}, loaded: false });
/** Threads key for the draft conversation — its blocks move to the real
 *  session id once the session exists, so the page never visibly resets. */
export const DRAFT_KEY = "draft";

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

/** Sessions the user just interrupted: the thread already shows "Interrupted",
 *  so the abort's own trailing events (an "aborted" error and one or more
 *  session.idle events) must not add a second line. Armed before the abort POST
 *  and held across every trailing event; the next turn clears it (`turn → sid`). */
const interruptedSessions = new Set<string>();

/** Server-side truth for "is this session's turn over": the last message is an
 *  assistant message that has finished streaming (time.completed set). A last
 *  USER message means a turn was accepted but not yet answered — still running. */
export function turnIsOver(messages: HistoryMessage[]): boolean {
  const last = messages[messages.length - 1];
  return !!last && last.role === "assistant" && !!last.completed;
}

/** Last SSE arrival per session (monotonic sequence, not wall time). Lets a
 *  failed sync POST tell "the connection died but the turn is alive" (events
 *  kept arriving after the POST began) from "the send never took" — WKWebView
 *  kills any fetch at ~60 s, long before a long agent turn finishes. */
let sseSeq = 0;
const sseLast = new Map<string, number>();

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
export function rootSessionOf(parents: Record<string, string>, sessionId: string): string {
  let cur = sessionId;
  for (let hop = 0; parents[cur] && hop < 10; hop++) cur = parents[cur];
  return cur;
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
): Promise<string | null> {
  if (!client) {
    set({ error: "Not connected to the OpenCode runtime." });
    return null;
  }
  if (get().sending) return null; // one send at a time
  const echoKey = get().currentId ?? DRAFT_KEY;
  set((s) => {
    const cur = s.threads[echoKey] ?? emptyThread();
    return {
      sending: true,
      threads: {
        ...s.threads,
        [echoKey]: { ...cur, loaded: true, blocks: [...cur.blocks, { kind: "user", text: echo }] },
      },
    };
  });
  try {
    let id = get().currentId;
    if (!id) {
      // Lazy-create the session on the first message (#3). Unless the user
      // pinned a folder via the workspace switcher, a new session gets its
      // own fresh dated folder (~/Documents/OpenScience/<date-time>) first,
      // so its files never pile up in the bare base folder.
      if (isTauri && !get().workspacePinned) {
        set({ switching: true });
        try {
          await newDatedWorkspace(datedWorkspaceName());
          await kernelReset().catch(() => {});
          await get().connectRetry();
        } finally {
          set({ switching: false });
        }
        if (get().status !== "ready" || !client) {
          throw new Error("Runtime did not reconnect after creating the session folder.");
        }
      } else if (isTauri && get().workspacePinned) {
        // /new and /clear intentionally keep the same folder, but the old
        // session route may have just torn down/reopened directory-scoped SSE.
        // Rebuild the scoped client before creating the next session so first
        // send cannot hang on a stale workspace instance.
        set({ switching: true });
        try {
          await get().connectRetry();
        } finally {
          set({ switching: false });
        }
        if (get().status !== "ready" || !client) {
          throw new Error("Runtime did not reconnect before creating the session.");
        }
      }
      id = await withRetry(() => client!.createSession());
      const sessionSelections = { ...get().sessionSelections };
      if (get().draftSelection) sessionSelections[id!] = get().draftSelection!;
      set((s) => {
        // Graft the draft conversation (and its pane) onto the real session id.
        const threads = { ...s.threads, [id!]: s.threads[DRAFT_KEY] ?? emptyThread() };
        delete threads[DRAFT_KEY];
        const panes = { ...s.panes };
        if (panes[DRAFT_KEY]) {
          panes[id!] = panes[DRAFT_KEY];
          delete panes[DRAFT_KEY];
        }
        const sessionAgents = { ...s.sessionAgents };
        if (sessionAgents[DRAFT_KEY]) {
          sessionAgents[id!] = sessionAgents[DRAFT_KEY];
          delete sessionAgents[DRAFT_KEY];
        }
        return { currentId: id, threads, panes, sessionAgents, sessionSelections, draftSelection: null };
      });
      moveScrollMemory(`chat:${DRAFT_KEY}`, `chat:${id}`);
      void get().refreshSessions();
    }
    const sid = id;
    interruptedSessions.delete(sid); // a fresh turn folds its events normally
    void logDebug(`turn → ${sid}`);
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
      await post(sid);
      set((s) => ({ runningSessions: { ...s.runningSessions, [sid]: true } }));
    }
    void logDebug("turn OK");
    return sid;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void logDebug(`turn FAILED: ${msg}`);
    // The failure belongs next to the message that caused it.
    const key = get().currentId ?? DRAFT_KEY;
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
    return get().currentId;
  } finally {
    set({ sending: false });
  }
}

/** The live OpenCode client (Settings talks to the runtime's config API directly). */
export function getClient(): OpenCodeClient | null {
  return opencodeClient;
}

export const useRuntimeStore = create<RuntimeState>((set, get) => {
  const initialSelectionPreferences = loadSelectionPreferences();
  return ({
  status: "offline",
  serverUrl: initialUrl(),
  sessions: [],
  currentId: null,
  threads: {},
  skills: [],
  agents: [],
  commands: [],
  defaultModel: null,
  modelSwitchError: null,
  approvalMode: "approve",
  tools: [],
  hiddenExamples: initialHidden(),
  error: null,
  questions: [],
  permissions: [],
  sessionParents: {},
  panes: {},
  sessionAgents: {},
  setAgentMode: (mode) =>
    set((s) => ({ sessionAgents: { ...s.sessionAgents, [s.currentId ?? DRAFT_KEY]: mode } })),
  projects: [],
  workspace: null,
  workspacePinned: false,
  switching: false,
  sending: false,
  runningSessions: {},
  shellTurns: {},
  retryNotices: {},
  providers: [],
  defaultSelection: initialSelectionPreferences.defaultSelection,
  sessionSelections: initialSelectionPreferences.sessionSelections,
  draftSelection: initialSelectionPreferences.draftSelection,

  // These write the CURRENT session's pane (DRAFT_KEY on a draft), keeping the
  // artifact inspector, the Files browser, and the Runs pane mutually exclusive
  // — one pane at a time.
  openArtifact: (artifact) =>
    set((s) => ({
      panes: { ...s.panes, [s.currentId ?? DRAFT_KEY]: { artifact, showFiles: false, showRuns: false } },
    })),
  closeArtifact: () =>
    set((s) => {
      const key = s.currentId ?? DRAFT_KEY;
      const p = s.panes[key];
      return { panes: { ...s.panes, [key]: { artifact: null, showFiles: p?.showFiles ?? false, showRuns: p?.showRuns ?? false } } };
    }),
  setShowFiles: (show) =>
    set((s) => {
      const key = s.currentId ?? DRAFT_KEY;
      const p = s.panes[key];
      return {
        panes: {
          ...s.panes,
          [key]: { artifact: show ? null : (p?.artifact ?? null), showFiles: show, showRuns: show ? false : (p?.showRuns ?? false) },
        },
      };
    }),
  setShowRuns: (show) =>
    set((s) => {
      const key = s.currentId ?? DRAFT_KEY;
      const p = s.panes[key];
      return {
        panes: {
          ...s.panes,
          [key]: { artifact: show ? null : (p?.artifact ?? null), showFiles: show ? false : (p?.showFiles ?? false), showRuns: show },
        },
      };
    }),

  answerQuestion: async (requestId, answers) => {
    const q = get().questions.find((x) => x.requestId === requestId);
    if (!q || !client) return;
    set((s) => ({ questions: s.questions.filter((x) => x.requestId !== requestId) }));
    try {
      await client.answerQuestion(requestId, answers);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
  rejectQuestion: async (requestId) => {
    const q = get().questions.find((x) => x.requestId === requestId);
    if (!q || !client) return;
    set((s) => ({ questions: s.questions.filter((x) => x.requestId !== requestId) }));
    try {
      await client.rejectQuestion(requestId);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
  replyPermission: async (requestId, reply) => {
    const p = get().permissions.find((x) => x.requestId === requestId);
    if (!p || !client) return;
    // Identical pending asks (same session, action and resources — e.g. three
    // parallel reads into one folder) are ONE question to the user: answer
    // them all with one click instead of re-asking for each tool call.
    const sig = (x: PermissionAskedEvent) =>
      `${x.sessionId}|${x.action}|${x.resources.join("|")}`;
    const batch = get().permissions.filter((x) => sig(x) === sig(p));
    set((s) => ({ permissions: s.permissions.filter((x) => sig(x) !== sig(p)) }));
    try {
      await Promise.all(batch.map((x) => client!.replyPermission(x.requestId, reply)));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  setServerUrl: (serverUrl) => {
    if (typeof window !== "undefined") window.localStorage.setItem(URL_KEY, serverUrl);
    set({ serverUrl, modelSwitchError: null });
  },

  loadCatalog: async () => {
    if (!client) return;
    try {
      const [firstSkills, agents, defaultModel, commands, providers] = await Promise.all([
        client.listSkills(),
        client.listAgents(),
        client.getDefaultModel().catch(() => null),
        client.listCommands().catch(() => []),
        // listProviders is OpenCodeClient-only (not on the AgentRuntime port);
        // opencodeClient is the same instance as `client`, set together.
        opencodeClient ? opencodeClient.listProviders().catch(() => []) : Promise.resolve([]),
      ]);
      // A model switch in flight owns `defaultModel`: this read may predate
      // the switch's config write, and applying it would visibly revert the
      // just-selected model.
      set(get().switching ? { agents, commands } : { agents, defaultModel, commands });
      // Reconcile the runtime's authoritative default model with any saved variant.
      {
        const saved = get().defaultSelection;
        const defaultSelection = defaultModel
          ? { model: defaultModel, variant: saved?.model === defaultModel ? saved.variant : null }
          : null;
        if (!get().switching) {
          set({ defaultSelection, providers });
        } else {
          set({ providers });
        }
      }
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

  setDefaultModel: (model) => get().setDefaultSelection({ model, variant: null }),

  setCurrentSelection: (selection) => {
    set((s) => s.currentId
      ? { sessionSelections: { ...s.sessionSelections, [s.currentId]: selection } }
      : { draftSelection: selection });
    saveSelectionPreferences(get());
  },

  setDefaultSelection: async (selection) => {
    if (!client) throw new Error("Not connected to the OpenCode runtime.");
    void logDebug(`[provider] setDefaultSelection → ${selection.model}`);
    lastSwitchModel = selection.model;
    lastSwitchAt = Date.now();
    const previous = get().defaultSelection;
    const preserved = { ...get().sessionSelections };
    if (previous) {
      for (const session of get().sessions) {
        if (session.id !== get().currentId && !preserved[session.id]) {
          preserved[session.id] = previous;
        }
      }
    }

    let reconnectError: unknown;
    set({ switching: true });
    try {
      await client.setDefaultModel(selection.model);
      set({ defaultModel: selection.model });
      if (!(await get().connectRetry())) {
        throw new Error(
          get().error ?? "Runtime did not reconnect after setting the default model.",
        );
      }
      set({ modelSwitchError: null });
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
      if (get().defaultModel !== selection.model) {
        // PATCH itself failed — record the error so Settings keeps the browser up.
        set({ modelSwitchError: err instanceof Error ? err.message : String(err) });
        throw err;
      }
      reconnectError = err;
      // PATCH landed but reconnect failed — record the error too.
      set({ modelSwitchError: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ switching: false });
    }

    set((s) => ({
      defaultSelection: selection,
      sessionSelections: s.currentId
        ? { ...preserved, [s.currentId]: selection }
        : preserved,
      draftSelection: s.currentId ? s.draftSelection : selection,
    }));
    saveSelectionPreferences(get());
    if (reconnectError) throw reconnectError;
  },

  connect: async () => {
    // Quiet teardown of any previous connection: within a (re)connect the
    // status must never pass through "offline" — on first boot the retry loop
    // runs for minutes (macOS TCC) and each flip repaints the whole page.
    teardownClient();
    // Scope skill discovery to the sidecar's workspace (null in browser dev).
    const directory = await workspacePath();
    set({ workspace: directory, approvalMode: await getApprovalMode() });
    // The bundled sidecar requires per-run Basic auth; browser dev (no Tauri)
    // gets null and connects to a user-run passwordless server.
    const password = await runtimePassword();
    const c = new OpenCodeClient({
      baseUrl: get().serverUrl,
      directory: directory ?? undefined,
      password: password ?? undefined,
    });
    opencodeClient = c;
    client = c;
    clientStatusUnsub = c.onStatus((status) => {
      void logDebug(`status → ${status}`);
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
      set({ status });
    });
    c.onEvent((event) => {
      // text.updated fires per streamed token, and a running bash tool fires
      // per stdout write (tqdm redraws dozens of times a second) — logging
      // each one would flood debug.log with an IPC call per event.
      if (
        event.type !== "text.updated" &&
        !(event.type === "tool.updated" && event.status === "running")
      )
        void logDebug(`event ← ${event.type}${"sessionId" in event ? " " + event.sessionId : ""}`);
      if ("sessionId" in event && event.sessionId) {
        sseLast.set(event.sessionId, ++sseSeq);
        while (sseLast.size > 500) {
          const oldest = sseLast.keys().next().value;
          if (oldest === undefined) break;
          sseLast.delete(oldest);
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
        if (sid && interruptedSessions.has(sid)) return;
        // A dangling default model (its provider removed or renamed) fails
        // every send the same way — point at where the fix lives.
        const message = /model not found/i.test(event.message)
          ? `${event.message} Pick an available model in Settings → Models.`
          : event.message;
        if (sid) {
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
          set((s) => ({
            permissions: [
              ...s.permissions.filter((p) => p.requestId !== event.requestId),
              event,
            ],
          }));
          return;
        case "permission.resolved":
          set((s) => ({ permissions: s.permissions.filter((p) => p.requestId !== event.requestId) }));
          return;
        case "session.retry":
          set((s) => ({
            retryNotices: {
              ...s.retryNotices,
              [event.sessionId]: { attempt: event.attempt, message: event.message },
            },
          }));
          return;
        case "message.agent": {
          // A user message names its agent. This is how the pill follows
          // OpenCode's own plan_exit "Yes" (it injects a build user message)
          // — and it self-confirms our own sends.
          const mode: AgentMode = event.agent === "plan" ? "plan" : "build";
          if (get().sessionAgents[event.sessionId] !== mode)
            set((s) => ({
              sessionAgents: { ...s.sessionAgents, [event.sessionId]: mode },
            }));
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
        void get().refreshSessions();
        return;
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
          // The turn is over — unlock the composer and drop the "Working…" row.
          // The shell flag clears HERE (not when the POST settles): within the
          // SSE stream the bash-output event always precedes session.idle.
          const runningSessions = { ...s.runningSessions };
          const shellTurns = { ...s.shellTurns };
          if (ev.type === "session.idle") {
            delete runningSessions[sid];
            delete shellTurns[sid];
          }
          return {
            runningSessions,
            shellTurns,
            threads: { ...s.threads, [sid]: { ...cur, ...folded, loaded: true } },
          };
        });
      // A running bash tool streams its stdout tail on every write — dozens
      // of events per second under a progress bar. Fold at most one partial
      // update per LIVE_FOLD_MS per call (latest wins); everything else
      // (status changes, completion) folds immediately and supersedes.
      if (event.type === "tool.updated") {
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
      // A completed live write becomes a provenance version. One apply_patch call
      // can touch many files, so dedupe per (call, path) rather than per call.
      if (event.type === "tool.updated") {
        for (const input of provenanceInputsFromEvent(event)) {
          const key = `${event.callId}:${input.path}`;
          if (recordedProvenance.has(key)) continue;
          remember(recordedProvenance, key);
          void recordProvenance(input, sid, selectionForSession(get(), sid)?.model ?? null, selectionForSession(get(), sid)?.variant ?? null);
        }
      }
      // A completed experiment execution (bash running code) becomes a run —
      // its reproducibility recipe (once per call).
      if (event.type === "tool.updated" && !recordedRuns.has(event.callId)) {
        const run = runInputFromEvent(event);
        if (run) {
          remember(recordedRuns, event.callId);
          void recordRun(run, sid, selectionForSession(get(), sid)?.model ?? null, selectionForSession(get(), sid)?.variant ?? null);
        }
      }
      if (event.type === "session.idle") {
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
    });
    try {
      void logDebug(`connect → ${get().serverUrl}`);
      await c.connect();
      void logDebug("connect OK");
      set({ error: null });
      await get().refreshSessions();
      void get().refreshProjects();
      // Catalog (skills/agents/commands) fills in behind the page — a session
      // switch must not wait on it to show the conversation.
      void get().loadCatalog();
      // Every reconnect is a window where session.idle can have been missed
      // (the event stream is directory-scoped and torn down on purpose) —
      // check any session still holding a running lock against the server.
      void get().reconcileRunning();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void logDebug(`connect FAILED: ${msg}`);
      set({ error: msg, status: "error" });
    }
  },

  // First boot can be slow far beyond the process spawn: on a fresh install
  // macOS TCC ("access Documents") blocks the sidecar until the user answers,
  // so the window must cover minutes, not seconds — giving up early strands
  // the user on an error screen that a single manual Connect would fix.
  // Failed attempts are masked (status AND error): workspace switches
  // reconnect the event stream on purpose, and flashing "could not open the
  // event stream" at the user mid-switch reads as breakage. The last error is
  // surfaced only if the whole retry window is exhausted.
  connectRetry: async (tries = 120) => {
    set({ status: "connecting" });
    let lastError: string | null = null;
    for (let i = 0; i < tries; i++) {
      await get().connect();
      if (get().status === "ready") {
        set({ modelSwitchError: null });
        return true;
      }
      lastError = get().error ?? lastError;
      set({ status: "connecting", error: null });
      // Quick retries first — the server is usually up within a second (a
      // reconnect finds it already listening); back off to 1 s for the long
      // tail (first boot blocked on macOS TCC can take minutes).
      await sleep(i < 8 ? 250 : 1000);
    }
    set({ status: "error", error: lastError });
    return false;
  },

  bootstrap: () => {
    if (bootstrapInFlight) return bootstrapInFlight;
    const run = (async () => {
      void get().detectTools();
      if (!isTauri) return;
      void logDebug("bootstrap: starting bundled runtime");
      try {
        const url = await startRuntime();
        void logDebug(`bootstrap: runtime at ${url}`);
        if (url) set({ serverUrl: url });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void logDebug(`bootstrap FAILED: ${msg}`);
        set({ error: msg });
        return;
      }
      await get().connectRetry();
    })();
    bootstrapInFlight = run;
    const clear = () => {
      if (bootstrapInFlight === run) bootstrapInFlight = null;
    };
    void run.then(clear, clear);
    return run;
  },

  disconnect: () => {
    teardownClient();
    set({ status: "offline", modelSwitchError: null });
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
  startDraft: () =>
    set((s) => {
      const threads = { ...s.threads };
      delete threads[DRAFT_KEY]; // leftovers from an aborted first message
      const panes = { ...s.panes };
      delete panes[DRAFT_KEY]; // a fresh draft starts with a closed pane
      const sessionAgents = { ...s.sessionAgents };
      delete sessionAgents[DRAFT_KEY]; // and in Build mode
      return {
        currentId: null,
        workspacePinned: false,
        threads,
        panes,
        sessionAgents,
        draftSelection: s.defaultSelection,
      };
    }),

  // Local /new and /clear: clear the visible chat context, but keep the active
  // folder. The first next message creates a new OpenCode session in that same
  // folder; no session, database row, or file is deleted here.
  startDraftInCurrentWorkspace: () =>
    set((s) => {
      const threads = { ...s.threads };
      threads[DRAFT_KEY] = {
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
      delete panes[DRAFT_KEY];
      const sessionAgents = { ...s.sessionAgents };
      delete sessionAgents[DRAFT_KEY];
      return {
        currentId: null,
        workspacePinned: true,
        threads,
        panes,
        sessionAgents,
        draftSelection: s.defaultSelection,
      };
    }),

  refreshProjects: async () => {
    if (!isTauri) return;
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

  importProject: async (path) => {
    try {
      const project = await importProjectFolder(path);
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

  startDraftInWorkspace: async (path) => {
    if (get().workspace === path) {
      // Already inside the project — a clean pinned draft, no reconnect.
      set((s) => {
        const threads = { ...s.threads };
        delete threads[DRAFT_KEY];
        const panes = { ...s.panes };
        delete panes[DRAFT_KEY];
        const sessionAgents = { ...s.sessionAgents };
        delete sessionAgents[DRAFT_KEY];
        return { currentId: null, workspacePinned: true, threads, panes, sessionAgents };
      });
      return;
    }
    await get().switchWorkspace({ path });
  },

  ensureDraftWorkspace: async () => {
    const s = get();
    // A session already has its folder; a pinned draft's folder is reused on
    // send. Only a fresh, unpinned draft needs its dated folder materialized now
    // so composer files and the eventual session share one workspace.
    if (!isTauri || s.currentId || s.workspacePinned) return;
    await get().switchWorkspace({ dated: datedWorkspaceName() });
  },

  switchWorkspace: async (target) => {
    set({ switching: true });
    try {
      if ("dated" in target) await newDatedWorkspace(target.dated);
      else await setWorkspace(target.path);
      // Reset the local kernel so it respawns in the new folder, then reconnect
      // the event stream scoped to it (connect() re-reads the active folder —
      // the sidecar itself keeps running). An explicit switch pins the folder,
      // so the next new session lands exactly there.
      await kernelReset().catch(() => {});
      set((s) => {
        // Back to a draft in the new folder — the draft pane must not carry
        // files from the previous folder. Session panes keep their memory.
        const panes = { ...s.panes };
        delete panes[DRAFT_KEY];
        const sessionAgents = { ...s.sessionAgents };
        delete sessionAgents[DRAFT_KEY];
        return {
          currentId: null,
          panes,
          workspacePinned: true,
          sessionAgents,
          draftSelection: s.defaultSelection,
        };
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
        await setWorkspace(dir).catch(() => {});
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
      if (seq !== openSessionSeq || get().currentId !== id) return;
      set((s) => ({
        threads: {
          ...s.threads,
          [id]: { ...historyToThread(messages, s.commands), loaded: true },
        },
        // Seed the agent pill from history: a session that was planning when
        // the app closed (or whose plan_exit flip fell into an SSE gap) must
        // reopen in the mode the server is actually in.
        sessionAgents: { ...s.sessionAgents, [id]: lastAgentMode(messages) },
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

  // The send lifecycle (new → input → send → response) is shared by plain
  // prompts, "!" shell commands and "/" slash commands — see performTurn.
  sendPrompt: (text) => {
    const s = get();
    const mode = s.sessionAgents[s.currentId ?? DRAFT_KEY];
    const agent =
      mode === "plan" && s.agents.some((a) => a.name === "plan") ? "plan" : undefined;
    const selection = currentModelSelection(s);
    return performTurn(
      set,
      get,
      text,
      (sid) => withRetry(() => client!.sendPrompt(
        sid, text, agent, selection?.model ?? s.defaultModel, selection?.variant ?? null,
      )),
      false,
    );
  },

  // No retry for shell/command: re-POSTing would run the command twice.
  runShell: (command) => {
    const agent = get().agents.find((a) => a.mode === "primary")?.name ?? "build";
    return performTurn(
      set,
      get,
      `! ${command}`,
      (sid) => client!.runShell(sid, command, agent),
      true,
      true,
    );
  },

  runCommand: async (name, args) => {
    if (name === "new" || name === "clear") {
      get().startDraftInCurrentWorkspace();
      return null;
    }
    return performTurn(
      set,
      get,
      args ? `/${name} ${args}` : `/${name}`,
      (sid) => client!.runCommand(sid, name, args),
      true,
    );
  },

  interrupt: async () => {
    const sid = get().currentId;
    if (!sid || !client || !get().runningSessions[sid]) return;
    // Arm the guard BEFORE the abort POST: the server answers an abort with its
    // own SSE burst (an "aborted" error and one or more session.idle events)
    // that streams back WHILE this POST is still awaited. If we armed it after
    // the await, those events would race in ahead and litter the thread with
    // "Aborted" / "done" lines before "Interrupted".
    interruptedSessions.add(sid);
    try {
      await client.abortSession(sid);
    } catch {
      // The abort POST failing usually means the turn is already dead —
      // fall through: unlock locally either way so the user is never stuck.
    }
    set((s) => {
      const runningSessions = { ...s.runningSessions };
      const shellTurns = { ...s.shellTurns };
      delete runningSessions[sid];
      delete shellTurns[sid];
      const cur = s.threads[sid] ?? emptyThread();
      return {
        runningSessions,
        shellTurns,
        threads: {
          ...s.threads,
          [sid]: {
            ...cur,
            loaded: true,
            blocks: [...cur.blocks, { kind: "status-line", text: "Interrupted", tone: "error" }],
          },
        },
      };
    });
  },

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
    set((s) => {
      const threads = { ...s.threads };
      delete threads[id];
      const runningSessions = { ...s.runningSessions };
      delete runningSessions[id];
      const panes = { ...s.panes };
      delete panes[id];
      const sessionAgents = { ...s.sessionAgents };
      delete sessionAgents[id];
      const sessionSelections = { ...s.sessionSelections };
      delete sessionSelections[id];
      return {
        sessions: s.sessions.filter((x) => x.id !== id),
        threads,
        runningSessions,
        panes,
        sessionAgents,
        sessionSelections,
        currentId: s.currentId === id ? null : s.currentId,
      };
    });
    saveSelectionPreferences(get());
  },

  hideExample: (id) => {
    const next = Array.from(new Set([...get().hiddenExamples, id]));
    if (typeof window !== "undefined") window.localStorage.setItem(HIDDEN_KEY, JSON.stringify(next));
    set({ hiddenExamples: next });
  },

  // Install a skill by asking the agent (uses OpenCode's customize-opencode skill) (#1).
  installSkill: async (text) => {
    if (!client) {
      set({ error: "Connect the runtime first to install skills." });
      return null;
    }
    try {
      const id = await client.createSession();
      set((s) => ({ currentId: id, threads: { ...s.threads, [id]: { ...emptyThread(), loaded: true } } }));
      await get().refreshSessions();
      const prompt =
        "Install the following as an OpenCode skill for this project. Use the " +
        "customize-opencode skill. If it is a URL, fetch it; if it is Markdown, save it as " +
        "a skill file under .opencode/skills/<name>/SKILL.md. Then reply with the installed skill's name.\n\n---\n" +
        text;
      set((s) => {
        const cur = s.threads[id];
        return {
          threads: {
            ...s.threads,
            [id]: { ...cur, blocks: [...cur.blocks, { kind: "user", text: `Install skill:\n${text}` }] },
          },
        };
      });
      const selection = currentModelSelection(get());
      await client.sendPrompt(
        id, prompt, undefined,
        selection?.model ?? get().defaultModel,
        selection?.variant ?? null,
      );
      return id;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },
  });
});

/** Dated folder name like `2026-07-04-1615` for a fresh per-session workspace. */
export function datedWorkspaceName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

/** Resolve the effective selection for the current active conversation/draft. */
export function currentModelSelection(state: Pick<RuntimeState, "currentId" | "defaultSelection" | "sessionSelections" | "draftSelection">): ModelSelection | null {
  return resolveSelection({
    currentId: state.currentId,
    defaultSelection: state.defaultSelection,
    sessionSelections: state.sessionSelections,
    draftSelection: state.draftSelection,
  });
}

/** Resolve the selection for a specific session ID (used by provenance/run events). */
export function selectionForSession(
  state: Pick<RuntimeState, "defaultSelection" | "sessionSelections">,
  sessionId: string,
): ModelSelection | null {
  return state.sessionSelections[sessionId] ?? state.defaultSelection;
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
      if (key in index) blocks[index[key]] = { kind: "agent", markdown: clean };
      else {
        blocks.push({ kind: "agent", markdown: clean });
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
      return { blocks, index };
    }
    case "session.idle": {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "status-line" && last.tone === "done") {
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
    if (m.role === "user" && m.agent) return m.agent === "plan" ? "plan" : "build";
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
  for (const m of messages) {
    if (m.role === "user") {
      shellTurn = m.parts.some((p) => p.type === "text" && p.synthetic);
      if (shellTurn) continue;
      const text = m.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("")
        .trim();
      const command = asTypedCommand(text);
      if (command) blocks.push({ kind: "user", text: command });
      else if (text) blocks.push({ kind: "user", text });
    } else {
      for (const p of m.parts) {
        if (p.type === "text" && p.text?.trim()) {
          const { clean, review } = splitReview(p.text);
          if (clean) blocks.push({ kind: "agent", markdown: clean });
          if (review) blocks.push(review);
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
        }
      }
      // A turn that ended in a provider/runtime error must say so on reload —
      // its live session.error is gone (SSE reconnect, app restart) and an
      // empty reply followed by "done" explains nothing. User-interrupted
      // turns are not errors; the trailing "Interrupted" line covers those.
      if (m.error && !/abort/i.test(m.error)) {
        blocks.push({ kind: "status-line", text: m.error, tone: "error" });
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
