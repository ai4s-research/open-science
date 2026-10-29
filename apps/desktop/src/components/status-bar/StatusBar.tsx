import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as Popover from "@radix-ui/react-popover";
import { RefreshCw } from "lucide-react";
import {
  agentWindows,
  planError,
  clampPercent,
  formatResetDuration,
  formatTokens,
  formatWindowLength,
  soonestReset,
  staleFor,
  tightestWindow,
  totalTokens,
  usageBarTone,
  usageTextTone,
  useUsageStore,
  windowFigure,
  type AgentUsage,
  type RateLimitWindow,
  type SessionSpend,
  type UsageSummary,
} from "@/lib/usage";
import { cn } from "@/lib/cn";
import { isTauri } from "@/lib/tauri";
import { useRuntimeStore } from "@/lib/runtime";
import { useInstalledAgents } from "@/lib/cliAgents";
import {
  AwakeSegment,
  HostsSegment,
  PortsSegment,
  ResourceSegment,
} from "./SystemSegments";

/** Who each row is: OpenCode is this app's own spend, the rest the agents'
 *  plans, in the order Settings → Agents lists them. Product names stay
 *  untranslated. */
const AGENT_LABELS: Record<string, string> = {
  workbench: "OpenCode",
  claude: "Claude Code",
  codex: "Codex",
};

/** Which catalog agent a usage source belongs to, so a row shows only while
 *  the agent is installed. */
const CATALOG_ID: Record<string, string> = {
  claude: "cli-claude-code",
  codex: "cli-codex",
};

/** How often a fresh scan runs while the app is open. Spend moves in minutes,
 *  not seconds, and each scan walks the transcript directory — a tighter loop
 *  would burn disk for a number nobody is watching that closely. */
const REFRESH_INTERVAL_MS = 5 * 60_000;

/** How often the open popover re-renders its countdowns. Orca schedules a timer
 *  to the next label boundary; a minute tick is the same thing at a fraction of
 *  the complexity, and the labels only ever floor to minutes. */
const COUNTDOWN_TICK_MS = 60_000;

interface UsageRow {
  key: string;
  /** `workbench`, `claude` or `codex`. */
  agent: string;
  label: string;
  /** Spend, for the agent's own row: an added account shares its history with
   *  the default, so its tokens cannot be told apart. */
  usage?: AgentUsage;
  windows: RateLimitWindow[];
  /** Why there are no plan windows, when the provider said. */
  planError?: string;
  /** Free rate-limit resets the account holds (Codex). */
  resetCredits?: number;
  /** Only OpenCode's row has these. */
  sessions: SessionSpend[];
}

/**
 * One row per account, in Settings → Agents order: OpenCode, then each
 * installed agent's own login and the accounts added for it. A row with
 * nothing to report is dropped rather than shown as a zero; an added account
 * that cannot be read stays, so a signed-out account is visible.
 */
function usageRows(summary: UsageSummary | null, installed: string[] | null): UsageRow[] {
  const rows: UsageRow[] = [];
  const isInstalled = (agent: string) =>
    agent === "workbench" || installed === null || installed.includes(CATALOG_ID[agent] ?? agent);
  for (const usage of summary?.agents ?? []) {
    if (!isInstalled(usage.agent)) continue;
    const added = (summary?.plan?.accounts ?? []).filter((a) => a.kind === usage.agent);
    const label = AGENT_LABELS[usage.agent] ?? usage.agent;
    const own: UsageRow = {
      key: usage.agent,
      agent: usage.agent,
      label,
      usage,
      windows: agentWindows(usage.agent, summary),
      planError: planError(usage.agent, summary),
      resetCredits: usage.agent === "codex" ? (summary?.plan?.codexResetCredits ?? undefined) : undefined,
      sessions: usage.agent === "workbench" ? (summary?.sessions ?? []) : [],
    };
    if (
      own.windows.length > 0 ||
      windowFigure(usage.today) !== null ||
      windowFigure(usage.week) !== null
    ) {
      rows.push(own);
    }
    for (const account of added) {
      rows.push({
        key: `${usage.agent}~${account.id}`,
        agent: usage.agent,
        label: `${label} · ${(account.email ?? account.id).split("@")[0]}`,
        windows: [...account.windows].sort((a, b) => a.windowMinutes - b.windowMinutes),
        planError: account.windows.length === 0 ? (account.error ?? undefined) : undefined,
        resetCredits: account.resetCredits ?? undefined,
        sessions: [],
      });
    }
  }
  return rows;
}

/** The collapsed segment: every row that has a figure, on one line. */
function UsageSegment({ rows }: { rows: UsageRow[] }) {
  const { t } = useTranslation("nav");
  const refresh = useUsageStore((s) => s.refresh);
  const loading = useUsageStore((s) => s.loading);
  const now = useCountdownClock();
  const onBar = rows.filter((row) => tightestWindow(row.windows) || (row.usage && rowFigure(row.usage)));

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={t("status.usage.title")}
          className="inline-flex items-center gap-2.5 rounded px-1 py-0.5 text-muted hover:bg-surface-2 hover:text-text"
        >
          {onBar.map((row, index) => (
            <span key={row.key} className="inline-flex items-center gap-1.5">
              {index > 0 && <span className="text-muted/40">·</span>}
              <span className="text-[11px]">{row.label}</span>
              <CollapsedMetric row={row} />
            </span>
          ))}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          // eslint-disable-next-line i18next/no-literal-string -- Radix placement, not UI copy
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          className="z-50 w-[360px] overflow-hidden rounded-card border border-border bg-surface text-text shadow-pop"
        >
          <div className="flex items-center justify-between px-3.5 pb-2 pt-3">
            <span className="text-[13px] font-semibold">{t("status.usage.title")}</span>
            <button
              type="button"
              onClick={() => void refresh()}
              aria-label={t("status.usage.refresh")}
              title={t("status.usage.refresh")}
              className="rounded p-0.5 text-muted hover:bg-surface-2 hover:text-text"
            >
              <RefreshCw size={12} strokeWidth={1.5} className={cn(loading && "animate-spin")} />
            </button>
          </div>
          <div className="border-t border-faint" />
          {rows.map((row) => (
            <UsageRosterRow key={row.key} row={row} now={now} />
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Today's spend, else the week's: a quiet morning must not read as "$0". */
function rowFigure(usage: AgentUsage): string | null {
  return windowFigure(usage.today) ?? windowFigure(usage.week);
}

/** What a row shows on the bar itself: a meter for its tightest window,
 *  otherwise the figure it spent. */
function CollapsedMetric({ row }: { row: UsageRow }) {
  const tightest = tightestWindow(row.windows);
  if (!tightest) {
    return <span className="text-[11px] tabular-nums text-text/70">{row.usage ? rowFigure(row.usage) : null}</span>;
  }
  const used = clampPercent(tightest.usedPercent);
  return (
    <>
      <span className="h-[5px] w-8 overflow-hidden rounded-full bg-border">
        <span
          className={cn("block h-full rounded-full", usageBarTone(used))}
          style={{ width: `${used}%` }}
        />
      </span>
      <span className={cn("text-[11px] tabular-nums", usageTextTone(used))}>{`${used}%`}</span>
    </>
  );
}

/** How many conversations are worth naming before the popover becomes a list.
 *  The rest are folded into the row above them, which already totals them. */
const SESSION_ROWS = 5;

/** Past this, the row suggests another account: a conversation keeps its
 *  account, so the way round a full plan is a new conversation on another one. */
const NEARLY_FULL = 80;

/**
 * One row inside the popover, as Orca lays it out: name (· plan) on the left,
 * the soonest reset on the right, and every window underneath.
 */
function UsageRosterRow({ row, now }: { row: UsageRow; now: number }) {
  const { t } = useTranslation("nav");
  const { usage, windows, sessions } = row;
  const plan = windows.find((w) => w.planType)?.planType ?? null;
  const reset = soonestReset(windows, now);
  const tightest = tightestWindow(windows);
  const nearlyFull = tightest !== null && clampPercent(tightest.usedPercent) >= NEARLY_FULL;

  return (
    <div className="flex flex-col gap-1 border-b border-faint px-3.5 py-2.5 last:border-b-0">
      <div className="flex items-center gap-2.5">
        <span className="min-w-0 shrink truncate text-[13px] font-medium">
          {row.label}
          {plan && <span className="font-normal text-muted"> · {plan}</span>}
        </span>
        {reset && (
          <span className="ml-auto shrink-0 text-[11px] text-muted">
            {t("status.usage.resetsIn", { duration: reset })}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
        {windows.map((window) => (
          <WindowMetric key={`${window.windowMinutes}-${window.model ?? ""}`} window={window} />
        ))}
        {row.resetCredits ? (
          <span className="text-[11px] text-muted">
            {t("status.usage.resetCredits", { count: row.resetCredits })}
          </span>
        ) : null}
        {/* Why there is no live figure, when the reason is knowable: a silent
            absence reads as "this app cannot do that". */}
        {row.planError && <span className="text-[11px] text-warn">{row.planError}</span>}
        {/* Spend only where there is no plan: a subscriber did not pay the
            list price, so a dollar figure there would mislead. */}
        {windows.length === 0 && usage && <SpendMetrics usage={usage} />}
      </div>
      {nearlyFull && row.agent !== "workbench" && (
        <span className="text-[11px] text-muted">{t("status.usage.otherAccount")}</span>
      )}
      {/* OpenCode's spend, per conversation: one shared runtime answers every
          session, so there is no per-session memory to show, but there is a
          per-session bill. */}
      {sessions.length > 0 && (
        <div className="mt-0.5 flex flex-col gap-0.5">
          {sessions.slice(0, SESSION_ROWS).map((spend) => (
            <SessionRow key={spend.sessionId} spend={spend} />
          ))}
        </div>
      )}
    </div>
  );
}


/**
 * The window's bottom strip: a 24px bar of quiet segments, each highlighting on
 * hover and opening a small popover on click.
 *
 * This is Orca's status bar (`StatusBarSurface` / `UsageRosterPanel`), not a
 * panel of our own. The rule it encodes is that ambient numbers belong on ONE
 * line at the edge of the window and their detail belongs behind a click — a
 * sidebar block listing every figure at once costs permanent space for
 * something read occasionally.
 */
export function StatusBar() {
  const summary = useUsageStore((s) => s.summary);
  const refresh = useUsageStore((s) => s.refresh);

  // Scan on mount, on a slow timer, and whenever the window is focused again —
  // the agent that spent the tokens usually ran while this window was in the
  // background, so a return to it is exactly when the figure is stale.
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const installed = useInstalledAgents();
  const rows = usageRows(summary, installed ? installed.map((a) => a.id) : null);
  // Nothing to say and no machine to report on (the web gateway): the bar takes
  // no space at all rather than drawing an empty 24px strip.
  if (rows.length === 0 && !isTauri) return null;

  return (
    <div className="flex h-6 min-h-[24px] shrink-0 select-none items-center gap-4 border-t border-border bg-surface px-3 text-xs">
      {rows.length > 0 && <UsageSegment rows={rows} />}
      {/* What the machine is doing, on the right — Orca's arrangement: spend on
          the left, the machine on the right, and nothing in between. */}
      <div className="ml-auto flex items-center gap-3">
        <AwakeSegment />
        <ResourceSegment />
        <PortsSegment />
        <HostsSegment />
      </div>
    </div>
  );
}

/** Orca's metric shape: a short window label, a 5px bar, the number. Colour
 *  appears only once the window is worth noticing. */
function WindowMetric({ window, showBar = true }: { window: RateLimitWindow; showBar?: boolean }) {
  const { t } = useTranslation("nav");
  const used = clampPercent(window.usedPercent);
  // A figure the provider could not be asked for, standing in from a session
  // file. Its age is the whole difference between it and a live reading, and
  // `asOfMs` carried that age from the start with nothing rendering it.
  const stale = staleFor(window);
  const age = stale === null ? null : formatResetDuration(stale);
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span className="text-[10px] text-muted">
        {window.model ? `${window.model} ` : ""}
        {formatWindowLength(window.windowMinutes)}
      </span>
      {showBar && (
        <span className="h-[5px] w-8 overflow-hidden rounded-full bg-border">
          <span
            className={cn("block h-full rounded-full", usageBarTone(used))}
            style={{ width: `${used}%` }}
          />
        </span>
      )}
      <span className={cn("tabular-nums", usageTextTone(used))}>{`${used}%`}</span>
      {age && (
        <span className="text-[10px] text-muted">{t("status.usage.asOf", { age })}</span>
      )}
    </span>
  );
}

function SpendMetrics({ usage }: { usage: AgentUsage }) {
  const { t } = useTranslation("nav");
  const today = windowFigure(usage.today);
  const week = windowFigure(usage.week);
  return (
    <>
      {today && <Metric label={t("status.usage.today")} value={today} />}
      {week && <Metric label={t("status.usage.days7")} value={week} />}
      <Metric label={t("status.usage.tokens")} value={formatTokens(totalTokens(usage.week))} />
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span className="text-[10px] text-muted">{label}</span>
      <span className="tabular-nums text-text/70">{value}</span>
    </span>
  );
}

/** One conversation's line: what it is called, and what it cost. */
function SessionRow({ spend }: { spend: SessionSpend }) {
  const title = useRuntimeStore(
    (s) => s.sessions.find((session) => session.id === spend.sessionId)?.title,
  );
  const figure = windowFigure(spend.week);
  if (!figure) return null;
  return (
    <div className="flex items-baseline gap-2 pl-0.5 text-[11px]">
      <span className="min-w-0 flex-1 truncate text-muted">{title ?? spend.sessionId}</span>
      <span className="shrink-0 tabular-nums text-text/70">{figure}</span>
    </div>
  );
}

/** Keeps every open countdown current off ONE timer, rather than a timer per
 *  window (Orca's `useResetCountdownClock`). */
function useCountdownClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}
