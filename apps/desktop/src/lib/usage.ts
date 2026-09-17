// What the local agents have spent, as the Rust side reads it off disk
// (`osd_core::usage`). Nothing here talks to a vendor: Claude Code and Codex
// both log their own token counts next to their session history.
//
// The window boundaries are computed HERE rather than in Rust. "Today" means
// the user's local midnight, which only the browser knows; deriving it in Rust
// would silently use UTC and give a user in Asia the wrong day for most of
// their working hours.
import { create } from "zustand";
import { isTauri } from "./tauri";

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Cost of the turns this build can price. Turns on an unknown model are in
   *  the token counts but NOT here — see `unpricedTurns`. */
  costUsd: number;
  pricedTurns: number;
  unpricedTurns: number;
}

export interface AgentUsage {
  /** `claude` or `codex`. */
  agent: string;
  today: TokenTotals;
  week: TokenTotals;
}

/** A subscription window Codex records next to its own session events. */
export interface RateLimitWindow {
  usedPercent: number;
  windowMinutes: number;
  /** Unix SECONDS, as Codex writes it. */
  resetsAt: number | null;
  /** Epoch ms of the event that carried this, so staleness is visible. */
  asOfMs: number;
  planType: string | null;
}

/** What each provider says is left of the plan, asked of the provider itself
 *  (`src-tauri/plan_usage.rs`). Empty for an agent that is not signed in. */
export interface PlanUsage {
  claude: RateLimitWindow[];
  codex: RateLimitWindow[];
  /** Why a plan has no windows, when the reason is knowable: not signed in, a
   *  proxy that refused, an expired token. */
  claudeError?: string | null;
  codexError?: string | null;
}

/** Why this agent has no LIVE plan figure, or undefined when it has one.
 *
 *  Keyed on the provider's own answer, not on whether a window is being shown:
 *  a stale session-file percentage standing in for it used to satisfy this and
 *  hide the reason the request failed, so a proxy that refused looked the same
 *  as a plan reporting 45%. */
export function planError(agent: string, summary: UsageSummary | null): string | undefined {
  if (livePlanWindows(agent, summary).length > 0) return undefined;
  const plan = summary?.plan;
  if (agent === "claude") return plan?.claudeError ?? undefined;
  if (agent === "codex") return plan?.codexError ?? undefined;
  return undefined;
}

/** What one conversation has spent. Sessions share a single agent runtime, so
 *  memory cannot be split between them — spend can, and it is what "which
 *  session is costing me" actually asks. */
export interface SessionSpend {
  sessionId: string;
  week: TokenTotals;
}

export interface UsageSummary {
  agents: AgentUsage[];
  /** This app's spend, split by conversation. Heaviest first. */
  sessions?: SessionSpend[];
  /** What the PROVIDERS report about the plan. This is the live figure; the
   *  transcript scan below only knows what was spent, never what is left. */
  plan?: PlanUsage;
  /** Codex's own last report in a session file. Kept as a fallback for when
   *  the provider cannot be reached — a stale percentage beats none — and
   *  always second to `plan`. */
  codexRateLimits: RateLimitWindow[];
  scannedFiles: number;
  skippedFiles: number;
  scanMs: number;
}

/** Local midnight today, and midnight six days before it — a rolling 7 days
 *  that includes today, which is what "this week" means to someone watching a
 *  spend figure. */
export function usageWindowBounds(now = new Date()): {
  todayStartMs: number;
  weekStartMs: number;
} {
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(todayStart);
  // setDate rather than subtracting 6×86,400,000: across a DST change a day is
  // not 24 hours, and the boundary must stay on a local midnight.
  weekStart.setDate(weekStart.getDate() - 6);
  return { todayStartMs: todayStart.getTime(), weekStartMs: weekStart.getTime() };
}

/** `$12.40`. Anything above zero always reads as spend, never as `$0.00`. */
export function formatCostUsd(cost: number): string {
  if (cost <= 0) return "$0";
  if (cost < 0.01) return "<$0.01";
  if (cost < 100) return `$${cost.toFixed(2)}`;
  if (cost < 1000) return `$${Math.round(cost)}`;
  return `$${(cost / 1000).toFixed(1)}k`;
}

/** `1.2M`, for the case where tokens are all we can honestly show. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(tokens < 10_000_000 ? 1 : 0)}M`;
}

/** Every token the window billed for, cached reads included. */
export function totalTokens(totals: TokenTotals): number {
  return (
    totals.inputTokens +
    totals.outputTokens +
    totals.cacheReadTokens +
    totals.cacheWriteTokens
  );
}

/** What a window's figure should say.
 *
 *  Cost when this build could price the turns; tokens when it could not. A new
 *  model the price table has not caught up with must not read as `$0.00` — that
 *  is a wrong number, where a token count is a true one. Null when the window
 *  holds nothing: a row promising "$0" is noise, not information. */
export function windowFigure(totals: TokenTotals): string | null {
  if (totals.pricedTurns > 0) return formatCostUsd(totals.costUsd);
  if (totals.unpricedTurns > 0) return `${formatTokens(totalTokens(totals))} tok`;
  return null;
}

/** What one agent's row shows on the right.
 *
 *  Following Orca's status bar (`UsageRosterPanel`): one row per AGENT, not one
 *  row per number, and the row carries a single metric — the one that is
 *  actually informative.
 *
 *  - A subscription window when the agent reports one. That IS the question
 *    ("how much of my plan is left"), and it renders as a meter.
 *  - Otherwise what it spent, preferring today and falling back to the week,
 *    because a quiet morning would otherwise render as a meaningless "$0".
 *
 *  The `window` label ("today", "7d", "5h") is what keeps the figure
 *  unambiguous, so it always travels with the value. */
export type AgentMetric =
  | { kind: "quota"; window: RateLimitWindow; usedPercent: number }
  | { kind: "spend"; window: "today" | "week"; figure: string };

export function agentMetric(
  usage: AgentUsage,
  rateLimit: RateLimitWindow | null,
): AgentMetric | null {
  if (rateLimit) {
    return {
      kind: "quota",
      window: rateLimit,
      usedPercent: clampPercent(rateLimit.usedPercent),
    };
  }
  const today = windowFigure(usage.today);
  if (today) return { kind: "spend", window: "today", figure: today };
  const week = windowFigure(usage.week);
  if (week) return { kind: "spend", window: "week", figure: week };
  return null;
}

/** One clamp and round for the bar width and the label, so they never disagree
 *  at a .5 fraction (Orca's `clampUsedPercent`). */
export function clampPercent(usedPercent: number): number {
  if (!Number.isFinite(usedPercent)) return 0;
  return Math.max(0, Math.min(100, Math.round(usedPercent)));
}

/** The filled part of a meter is the app's own accent until the figure is worth
 *  a warning — Orca's 60/80 thresholds, so the bar and its number always agree.
 *
 *  Not a muted grey: against this app's surfaces a grey fill reads as an empty
 *  track, so every bar looked blank whatever it said. */
export function usageBarTone(usedPercent: number): string {
  if (usedPercent >= 80) return "bg-error";
  if (usedPercent >= 60) return "bg-warn";
  return "bg-accent";
}

export function usageTextTone(usedPercent: number): string {
  if (usedPercent >= 80) return "text-error";
  if (usedPercent >= 60) return "text-warn";
  return "text-text/70";
}

/**
 * Compact duration, flooring to whole units: `47m`, `3h 54m`, `6d 7h`.
 *
 * Borrowed from Orca's `formatResetDuration` (shared/rate-limit-reset-format).
 * The minutes matter: "4h" for anything between four and five hours is the
 * difference between finishing the task and waiting.
 */
export function formatResetDuration(ms: number): string | null {
  if (ms <= 0) return null;
  const totalMins = Math.floor(ms / 60_000);
  if (totalMins < 60) return `${totalMins}m`;
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
  }
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

/** A rate-limit window's length, short enough for a sidebar: `5h`, `wk`, `3d`. */
export function formatWindowLength(windowMinutes: number): string {
  if (windowMinutes === 10080) return "wk";
  if (windowMinutes < 60) return `${windowMinutes}m`;
  if (windowMinutes % (60 * 24 * 7) === 0) return `${windowMinutes / (60 * 24 * 7)}wk`;
  if (windowMinutes % (60 * 24) === 0) return `${windowMinutes / (60 * 24)}d`;
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
  return `${windowMinutes}m`;
}

/** The label beside a quota meter. Prefer the live countdown to the window's
 *  nominal length — "2h" (until reset) answers the question the fixed "5h"
 *  only approximates. */
export function quotaWindowLabel(window: RateLimitWindow, now = Date.now()): string {
  return formatResetIn(window.resetsAt, now) ?? formatWindowLength(window.windowMinutes);
}

/** Rough time until a rate-limit window resets: `2d`, `5h`, `20m`, or null
 *  once it has passed. */
export function formatResetIn(resetsAtSeconds: number | null, now = Date.now()): string | null {
  if (!resetsAtSeconds) return null;
  const minutes = Math.round((resetsAtSeconds * 1000 - now) / 60_000);
  if (minutes <= 0) return null;
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (60 * 24))}d`;
}

/**
 * The windows one agent reports, in the order Orca shows them: the shortest
 * first, so the one that bites soonest is read first.
 *
 * Only Codex records these. Claude Code's transcripts carry token counts and
 * nothing about the plan, which is why its row shows spend instead — inventing
 * a percentage there would be a number we do not have.
 */
/** Only what the PROVIDER answered — no session-file fallback. */
export function livePlanWindows(agent: string, summary: UsageSummary | null): RateLimitWindow[] {
  const plan = summary?.plan;
  if (agent === "claude") return plan?.claude ?? [];
  if (agent === "codex") return plan?.codex ?? [];
  return [];
}

export function agentWindows(agent: string, summary: UsageSummary | null): RateLimitWindow[] {
  const live = livePlanWindows(agent, summary);
  if (live.length > 0 || agent !== "codex") return sortByWindow(live);
  // The last figure a session file recorded, only when the provider could not
  // be reached. That number is whatever the session happened to end on — a
  // session left open yesterday reports yesterday's percentage for ever — so it
  // is shown only WITH its age beside it (`staleFor`), never as a live reading.
  return sortByWindow(summary?.codexRateLimits ?? []);
}

/** A reading this old is not a current one. Chosen against what it is standing
 *  in for: the hourly window moves continuously, so anything past a few minutes
 *  can already be wrong by a lot. */
export const STALE_WINDOW_MS = 5 * 60 * 1000;

/** How long ago this figure was recorded, when that is long enough to matter —
 *  otherwise null, which is the case for everything the provider just answered.
 *
 *  `asOfMs` was on the wire from the start and nothing rendered it, so a
 *  fallback percentage was indistinguishable from a live one. */
export function staleFor(window: RateLimitWindow, now = Date.now()): number | null {
  if (!window.asOfMs) return null;
  const age = now - window.asOfMs;
  return age >= STALE_WINDOW_MS ? age : null;
}

function sortByWindow(windows: RateLimitWindow[]): RateLimitWindow[] {
  return [...windows].sort((a, b) => a.windowMinutes - b.windowMinutes);
}

/** The window nearest its limit — what the collapsed bar and Compact mode show.
 *  Urgency is by CONSUMPTION, as in Orca: the tightest window is the one that
 *  stops the work. */
export function tightestWindow(windows: RateLimitWindow[]): RateLimitWindow | null {
  if (windows.length === 0) return null;
  return windows.reduce((current, candidate) =>
    clampPercent(candidate.usedPercent) > clampPercent(current.usedPercent) ? candidate : current,
  );
}

/** How far the agent is into its worst window, for sorting worst-first. */
export function agentPressure(windows: RateLimitWindow[]): number {
  return windows.length === 0 ? -1 : clampPercent(tightestWindow(windows)!.usedPercent);
}

/** The soonest reset across an agent's windows, as a duration. */
export function soonestReset(windows: RateLimitWindow[], now = Date.now()): string | null {
  const resets = windows
    .map((w) => w.resetsAt)
    .filter((r): r is number => typeof r === "number" && Number.isFinite(r));
  if (resets.length === 0) return null;
  return formatResetDuration(Math.min(...resets) * 1000 - now);
}

/** Ask Rust for a fresh scan. Null off the desktop app, where there is no
 *  local transcript directory to read. */
export async function fetchUsage(now = new Date()): Promise<UsageSummary | null> {
  if (!isTauri) return null;
  const { todayStartMs, weekStartMs } = usageWindowBounds(now);
  const { invoke } = await import("@tauri-apps/api/core");
  const summary = await invoke<UsageSummary>("agent_usage", { todayStartMs, weekStartMs });
  // The plan figures are a network call, so a failure there must not cost the
  // spend figures, which are read from disk and always available.
  const plan = await invoke<PlanUsage>("plan_usage").catch(() => undefined);
  return { ...summary, plan };
}

interface UsageStore {
  summary: UsageSummary | null;
  /** True only for the first load, so a refresh never blanks the row. */
  loading: boolean;
  refresh: () => Promise<void>;
}

export const useUsageStore = create<UsageStore>((set, get) => ({
  summary: null,
  loading: false,
  refresh: async () => {
    if (get().loading) return; // A scan already in flight; let it finish.
    set({ loading: get().summary === null });
    try {
      const summary = await fetchUsage();
      // A null result means this build cannot scan (the web client has no local
      // transcript directory) — never that the user has no usage. Replacing good
      // figures with it would blank a bar that was reporting correctly.
      set(summary ? { summary, loading: false } : { loading: false });
    } catch {
      // A failed scan leaves the last good figures in place rather than
      // replacing them with an error: this is an ambient readout, and a
      // momentarily unreadable transcript is not worth a visible failure.
      set({ loading: false });
    }
  },
}));
