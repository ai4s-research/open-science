import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as Popover from "@radix-ui/react-popover";
import { RefreshCw } from "lucide-react";
import {
  agentPressure,
  agentWindows,
  planError,
  clampPercent,
  formatTokens,
  formatWindowLength,
  soonestReset,
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
import {
  AwakeSegment,
  HostsSegment,
  PortsSegment,
  ResourceSegment,
} from "./SystemSegments";

/** Where each row's numbers come from.
 *
 *  The distinction is the whole point of the row: `workbench` is what THIS app
 *  ran, the other two are the Claude Code and Codex CLIs' own work on the same
 *  machine. Showing "Claude" for the second kind read as if the app had spent
 *  it, which it had not — the names now say which tool did.
 *
 *  A CLI's name is a product name and stays untranslated; the workbench calls
 *  itself by the name the user calls it. */
const CLI_LABELS: Record<string, string> = {
  claude: "Claude Code CLI",
  codex: "Codex CLI",
};

function agentLabel(t: (key: "status.usage.workbench") => string, agent: string): string {
  return agent === "workbench" ? t("status.usage.workbench") : (CLI_LABELS[agent] ?? agent);
}

/** How often a fresh scan runs while the app is open. Spend moves in minutes,
 *  not seconds, and each scan walks the transcript directory — a tighter loop
 *  would burn disk for a number nobody is watching that closely. */
const REFRESH_INTERVAL_MS = 5 * 60_000;

/** How often the open popover re-renders its countdowns. Orca schedules a timer
 *  to the next label boundary; a minute tick is the same thing at a fraction of
 *  the complexity, and the labels only ever floor to minutes. */
const COUNTDOWN_TICK_MS = 60_000;

/** Detailed shows every window with its bar; Compact shows only the tightest.
 *  Orca's `StatusBarUsageMode`, and the choice is remembered because it is a
 *  preference about the reader, not about the data. */
type UsageMode = "detailed" | "compact";
const MODE_KEY = "ai4s.usage.mode.v1";

function storedMode(): UsageMode {
  try {
    return window.localStorage.getItem(MODE_KEY) === "compact" ? "compact" : "detailed";
  } catch {
    return "detailed";
  }
}

interface UsageRow {
  usage: AgentUsage;
  windows: RateLimitWindow[];
  /** Why this agent has no plan windows, when the provider said. */
  planError?: string;
  /** Only this app's own row has these: the CLIs' sessions are their own. */
  sessions: SessionSpend[];
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

  const rows = usageRows(summary);
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

/** One row per agent. This app's own spend leads — it is the one the reader is
 *  responsible for — and the CLIs follow it worst-first, so whichever is
 *  nearest a limit is the next thing read. An agent with nothing to report is
 *  dropped rather than shown as a zero. */
function usageRows(summary: UsageSummary | null): UsageRow[] {
  return (summary?.agents ?? [])
    .map((usage) => ({
      usage,
      windows: agentWindows(usage.agent, summary),
      planError: planError(usage.agent, summary),
      sessions: usage.agent === "workbench" ? (summary?.sessions ?? []) : [],
    }))
    .filter(
      (row) =>
        row.windows.length > 0 ||
        // Either window will do: a quiet morning has nothing for "today" and
        // still has a week worth reporting, and a first session has the
        // reverse.
        windowFigure(row.usage.today) !== null ||
        windowFigure(row.usage.week) !== null,
    )
    .sort((a, b) => {
      const mine = (row: UsageRow) => (row.usage.agent === "workbench" ? 1 : 0);
      return mine(b) - mine(a) || agentPressure(b.windows) - agentPressure(a.windows);
    });
}

/** The collapsed segment: every agent on one line, nothing else. */
function UsageSegment({ rows }: { rows: UsageRow[] }) {
  const { t } = useTranslation("nav");
  const refresh = useUsageStore((s) => s.refresh);
  const loading = useUsageStore((s) => s.loading);
  const [mode, setMode] = useState<UsageMode>(storedMode);
  const now = useCountdownClock();

  const chooseMode = (next: UsageMode) => {
    setMode(next);
    try {
      window.localStorage.setItem(MODE_KEY, next);
    } catch {
      /* the popover still works; only the preference is lost */
    }
  };

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={t("status.usage.title")}
          className="inline-flex items-center gap-2.5 rounded px-1 py-0.5 text-muted hover:bg-surface-2 hover:text-text"
        >
          {rows.map((row, index) => (
            <span key={row.usage.agent} className="inline-flex items-center gap-1.5">
              {index > 0 && <span className="text-muted/40">·</span>}
              <span className="text-[11px]">{agentLabel(t, row.usage.agent)}</span>
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
            <div className="flex items-center gap-2 text-muted">
              <span className="text-[11px]">{t("status.usage.allAgents")}</span>
              <button
                type="button"
                onClick={() => void refresh()}
                aria-label={t("status.usage.refresh")}
                title={t("status.usage.refresh")}
                className="rounded p-0.5 hover:bg-surface-2 hover:text-text"
              >
                <RefreshCw size={12} strokeWidth={1.5} className={cn(loading && "animate-spin")} />
              </button>
            </div>
          </div>
          {/* The density picker sits at the top of the popover it controls, so
              both modes are named and discoverable on first open. */}
          <div className="px-3.5 pb-2.5">
            <div
              role="radiogroup"
              aria-label={t("status.usage.detailAria")}
              className="flex gap-0.5 rounded-input bg-surface-2 p-0.5"
            >
              {/* eslint-disable i18next/no-literal-string -- mode ids, not UI copy (the visible labels come from `t` beside them) */}
              <ModeOption
                active={mode === "detailed"}
                label={t("status.usage.detailed")}
                title={t("status.usage.detailedHint")}
                onSelect={() => chooseMode("detailed")}
              />
              <ModeOption
                active={mode === "compact"}
                label={t("status.usage.compact")}
                title={t("status.usage.compactHint")}
                onSelect={() => chooseMode("compact")}
              />
              {/* eslint-enable i18next/no-literal-string */}
            </div>
          </div>
          <div className="border-t border-faint" />
          {rows.map((row) => (
            <UsageRosterRow key={row.usage.agent} row={row} mode={mode} now={now} />
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ModeOption({
  active,
  label,
  title,
  onSelect,
}: {
  active: boolean;
  label: string;
  title: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      title={title}
      onClick={onSelect}
      className={cn(
        "flex-1 rounded-[5px] px-2 py-1 text-[12px] transition-colors",
        active ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text",
      )}
    >
      {label}
    </button>
  );
}

/** What the agent shows on the bar itself: a meter for its tightest window,
 *  otherwise the figure it spent. */
function CollapsedMetric({ row }: { row: UsageRow }) {
  const tightest = tightestWindow(row.windows);
  if (!tightest) {
    const figure = windowFigure(row.usage.today) ?? windowFigure(row.usage.week);
    return <span className="text-[11px] tabular-nums text-text/70">{figure}</span>;
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

/**
 * One agent inside the popover, as Orca lays it out: name (· plan) on the left,
 * the soonest reset on the right, and the windows indented underneath — every
 * window in Detailed, only the tightest in Compact.
 */
/** How many conversations are worth naming before the popover becomes a list.
 *  The rest are folded into the row above them, which already totals them. */
const SESSION_ROWS = 5;

function UsageRosterRow({ row, mode, now }: { row: UsageRow; mode: UsageMode; now: number }) {
  const { t } = useTranslation("nav");
  const { usage, windows, sessions } = row;
  const plan = windows.find((w) => w.planType)?.planType ?? null;
  const reset = soonestReset(windows, now);
  const tightest = mode === "compact" ? tightestWindow(windows) : null;
  const shown = mode === "compact" ? [] : windows;

  return (
    <div className="flex flex-col gap-1 border-b border-faint px-3.5 py-2.5 last:border-b-0">
      <div className="flex items-center gap-2.5">
        <span className="min-w-0 shrink truncate text-[13px] font-medium">
          {agentLabel(t, usage.agent)}
          {plan && <span className="font-normal text-muted"> · {plan}</span>}
        </span>
        {tightest ? (
          <span className="ml-auto">
            <WindowMetric window={tightest} showBar={false} />
          </span>
        ) : reset ? (
          <span className="ml-auto shrink-0 text-[11px] text-muted">
            {t("status.usage.resetsIn", { duration: reset })}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
        {shown.map((window) => (
          <WindowMetric key={window.windowMinutes} window={window} />
        ))}
        {/* Why there are no bars, when the reason is knowable. A silent absence
            reads as "this app cannot do that" — which is exactly how the first
            attempt looked when the requests were going out unproxied. */}
        {windows.length === 0 && row.planError && (
          <span className="text-[11px] text-warn">{row.planError}</span>
        )}
        {/* Spend, for the agents that report no plan window at all. Claude Code
            writes token counts and nothing about the subscription, so a
            percentage there would be invented. */}
        {windows.length === 0 && <SpendMetrics usage={usage} />}
      </div>
      {usage.agent !== "workbench" && (
        <span className="text-[11px] text-muted">{t("status.usage.cliNote")}</span>
      )}
      {/* This app's own spend, per conversation. One shared runtime answers
          every session, so there is no per-session memory to show — but there
          is a per-session bill, and that is what "which session is costing me"
          is asking. */}
      {usage.agent === "workbench" && sessions.length > 0 && (
        <div className="mt-0.5 flex flex-col gap-0.5">
          {sessions.slice(0, SESSION_ROWS).map((spend) => (
            <SessionRow key={spend.sessionId} spend={spend} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Orca's metric shape: a short window label, a 5px bar, the number. Colour
 *  appears only once the window is worth noticing. */
function WindowMetric({ window, showBar = true }: { window: RateLimitWindow; showBar?: boolean }) {
  const used = clampPercent(window.usedPercent);
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span className="text-[10px] text-muted">{formatWindowLength(window.windowMinutes)}</span>
      {showBar && (
        <span className="h-[5px] w-8 overflow-hidden rounded-full bg-border">
          <span
            className={cn("block h-full rounded-full", usageBarTone(used))}
            style={{ width: `${used}%` }}
          />
        </span>
      )}
      <span className={cn("tabular-nums", usageTextTone(used))}>{`${used}%`}</span>
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
