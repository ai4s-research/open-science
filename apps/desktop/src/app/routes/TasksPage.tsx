import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { ArrowUpRight, Plus, SquareTerminal } from "lucide-react";
import type { ToolCallStatus } from "@ai4s/shared";
import { cn } from "@/lib/cn";
import { startSessionScreen, useRuntimeStore } from "@/lib/runtime";
import { DEFAULT_PROJECT, selectActiveProjectId, terminalAgentName, useLayoutStore } from "@/lib/layout";
import { splitAgentId } from "@/lib/agentAccounts";
import { terminalKindOf } from "@/lib/cliAgents";
import { timeAgo } from "@/lib/relativeTime";
import { useOpenSession } from "@/lib/useOpenSession";
import { StateDot, type StateDotState } from "@/components/icons/dsh/StateDot";
import { buildBoard, type BoardAgent, type BoardRow } from "@/lib/taskBoard";
import css from "./TasksPage.module.css";

/** "1h 24m", "12m", "40s": how long a turn has run, read at a glance. */
function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

type Group = "needsYou" | "working" | "today";
const GROUPS: readonly Group[] = ["needsYou", "working", "today"];
const DOT: Record<Group, StateDotState> = { needsYou: "warning", working: "ongoing", today: "done" };

const TICK: Record<ToolCallStatus, string> = {
  success: "bg-ok/70",
  warning: "bg-warn/80",
  failed: "bg-error",
  pending: "bg-accent",
  running: "bg-accent",
  "waiting-approval": "bg-warn",
};

/**
 * Every agent at work, live: the conversations waiting for the user, the ones
 * working (and coding agents left running in a terminal), and what was done
 * earlier today. Each row opens where the work is — its conversation, or its
 * terminal pane. Every number is read off the app's own state, so it is exact.
 */
export function TasksPage() {
  const { t } = useTranslation(["nav", "session"]);
  const navigate = useNavigate();
  const openSession = useOpenSession();

  const sessions = useRuntimeStore((s) => s.sessions);
  const projects = useRuntimeStore((s) => s.projects);
  const runningSessions = useRuntimeStore((s) => s.runningSessions);
  const permissions = useRuntimeStore((s) => s.permissions);
  const questions = useRuntimeStore((s) => s.questions);
  const sessionParents = useRuntimeStore((s) => s.sessionParents);
  const threads = useRuntimeStore((s) => s.threads);
  const acpSessions = useRuntimeStore((s) => s.acpSessions);
  const groups = useLayoutStore((s) => s.groups);

  // Ticks the elapsed clocks; the board itself follows the stores.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  // The day boundary moves only once a day: the board rebuilds on store
  // changes, not every second.
  const day = new Date(now).toDateString();

  const board = useMemo(
    () =>
      buildBoard({
        sessions,
        projects,
        runningSessions,
        permissions,
        questions,
        sessionParents,
        threads,
        groups,
        now: Date.now(),
        agentOf: (id): BoardAgent => {
          const agentId = acpSessions[id]?.agentId;
          if (!agentId) return { kind: "opencode" };
          const { base, account } = splitAgentId(agentId);
          const kind = terminalKindOf(base);
          return kind ? { kind, ...(account ? { account } : {}) } : { kind: "opencode" };
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `day` re-buckets "today" at midnight
    [sessions, projects, runningSessions, permissions, questions, sessionParents, threads, groups, acpSessions, day],
  );

  const projectName = (id: string) =>
    id === DEFAULT_PROJECT
      ? t("session:group.defaultProject")
      : (projects.find((p) => p.id === id)?.name ?? t("session:group.defaultProject"));
  const agentName = (a: BoardAgent) => (a.kind === "opencode" ? "OpenCode" : terminalAgentName(a.kind));

  const open = (row: BoardRow) => {
    if (row.target.kind === "session") {
      openSession(row.target.sessionId);
      return;
    }
    const layout = useLayoutStore.getState();
    layout.setActiveGroup(row.target.groupId);
    layout.focusLeaf(row.target.leafId);
    navigate("/live");
  };

  const newTask = async () => {
    await startSessionScreen(selectActiveProjectId(useLayoutStore.getState()));
    navigate("/live");
  };

  const stats = [
    { key: "needsYou", n: board.needsYou.length, tone: "text-warn" },
    { key: "working", n: board.working.length, tone: "text-accent" },
    { key: "today", n: board.today.length, tone: "text-text" },
  ] as const;
  const empty = stats.every((s) => s.n === 0);

  const line = (row: BoardRow, group: Group) => {
    if (row.ask)
      return (
        <span className="text-warn">
          {row.ask.type === "permission"
            ? t("tasks.askPermission", { action: row.ask.action })
            : t("tasks.askQuestion", { text: row.ask.text })}
          {row.ask.type === "permission" && row.ask.resource && (
            <span className="ml-2 font-mono text-[12px] text-muted">{row.ask.resource}</span>
          )}
        </span>
      );
    if (group !== "working") return null;
    if (row.terminal) return <span className="text-muted">{t("tasks.inTerminal")}</span>;
    const step = row.step;
    if (!step) return null;
    const text =
      step.type === "tool"
        ? `${step.verb ? `${t(`session:tool.verb.${step.verb}`)} ` : ""}${step.title}`
        : t(step.type === "thinking" ? "tasks.thinking" : "tasks.replying");
    return <span className={css.live}>{text}</span>;
  };

  const section = (group: Group, rows: BoardRow[]) =>
    rows.length > 0 && (
      <section key={group} className="mt-10">
        <h2 className="flex items-baseline justify-between px-2 pb-2 text-xs font-medium uppercase tracking-wider text-muted">
          <span>{t(`tasks.${group}`)}</span>
          <span className="tabular-nums">{rows.length}</span>
        </h2>
        <div className="divide-y divide-faint border-t border-border">
          {rows.map((row) => {
            const detail = line(row, group);
            const facts = [
              agentName(row.agent),
              projectName(row.projectId),
              row.tools > 0 ? `${t("tasks.tools")} ${row.tools}` : null,
              row.files > 0 ? `${t("tasks.files")} ${row.files}` : null,
            ].filter(Boolean);
            return (
              <button
                key={row.id}
                onClick={() => open(row)}
                title={t("tasks.openHint")}
                className="group grid w-full grid-cols-[16px_minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-2 py-4 text-left outline-none transition-colors hover:bg-surface-2/50 focus-visible:bg-surface-2/50"
              >
                <span className="flex h-5 items-center">
                  {row.terminal ? (
                    <SquareTerminal size={14} className="text-accent" />
                  ) : (
                    <StateDot state={DOT[group]} />
                  )}
                </span>
                <span className="min-w-0 truncate text-[15px] font-medium text-text transition-colors group-hover:text-accent">
                  {row.title || agentName(row.agent)}
                </span>
                <span className="flex items-center gap-2 font-mono text-xs tabular-nums text-muted">
                  {group === "working" && row.startedAt ? (
                    <span className="text-accent">{elapsed(now - row.startedAt)}</span>
                  ) : row.lastAt ? (
                    timeAgo(row.lastAt, now)
                  ) : null}
                  <ArrowUpRight size={14} className="opacity-0 transition-opacity group-hover:opacity-100" />
                </span>

                <span className="col-start-2 col-end-4 truncate text-xs text-muted">{facts.join(" · ")}</span>
                {detail && <span className="col-start-2 col-end-4 truncate text-[13.5px]">{detail}</span>}
                {group === "working" && row.trail.length > 0 && (
                  <span className="col-start-2 col-end-4 mt-1.5 flex items-center gap-[3px]" aria-hidden>
                    {row.trail.map((status, i) => (
                      <i
                        key={i}
                        className={cn(
                          css.tick,
                          TICK[status],
                          (status === "running" || status === "pending" || status === "waiting-approval") &&
                            css.tickLive,
                        )}
                      />
                    ))}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </section>
    );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-8">
        <div className="flex items-center gap-3">
          <h1 className="min-w-0 flex-1 font-serif text-2xl leading-tight text-text">{t("tasks.title")}</h1>
          <button
            onClick={() => void newTask()}
            className="flex shrink-0 items-center gap-1.5 rounded-input bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition-opacity hover:opacity-90"
          >
            <Plus size={14} />
            {t("tasks.newTask")}
          </button>
        </div>

        <div className="mt-8 grid grid-cols-3 border-y border-border">
          {stats.map((s, i) => (
            <div key={s.key} className={cn("py-5", i > 0 && "border-l border-faint pl-5 sm:pl-8")}>
              <div
                className={cn(
                  "font-serif text-4xl leading-none tabular-nums sm:text-5xl",
                  s.n > 0 ? s.tone : "text-muted/50",
                )}
              >
                {s.n}
              </div>
              <div className="mt-2.5 flex items-center gap-2 text-xs text-muted">
                {s.key === "working" && s.n > 0 && <span className={css.beacon} />}
                {t(`tasks.${s.key}`)}
              </div>
            </div>
          ))}
        </div>

        {empty ? (
          <div className="px-2 py-16 text-center">
            <p className="text-sm text-text">{t("tasks.empty")}</p>
            <p className="mt-1.5 text-xs text-muted">{t("tasks.emptyHint")}</p>
          </div>
        ) : (
          GROUPS.map((g) => section(g, board[g]))
        )}
      </div>
    </div>
  );
}
