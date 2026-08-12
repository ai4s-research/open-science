import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bot, CheckCircle2, ChevronRight, CircleDashed, Loader2, X, XCircle } from "lucide-react";
import type { ToolCallStatus } from "@ai4s/shared";
import { cn } from "@/lib/cn";
import { subagentActivity, useRuntimeStore } from "@/lib/runtime";
import { PaneTitlebarInset } from "@/components/inspector/RightPane";
import { BlockList } from "./BlockList";

/** One subagent this conversation spawned. */
interface Row {
  /** The task tool's own title — what the subagent was asked to do. */
  task: string;
  status: ToolCallStatus;
  childSessionId?: string;
  startedAt?: number;
  endedAt?: number;
}

/** Human-readable elapsed time for a subagent: "12s", "3m 04s". */
function elapsed(row: Row, now: number): string {
  if (row.startedAt == null) return "";
  const end = row.endedAt ?? now;
  const s = Math.max(0, Math.round((end - row.startedAt) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/**
 * What the subagents are doing (#63). A multi-agent turn otherwise only shows
 * as a collapsed tool row in the transcript: you cannot see which subagent is
 * running, on what, or how long it has been going. This panel lists them all —
 * finished ones included, so a finished run can still be reviewed.
 *
 * Each row opens into the subagent's OWN transcript. Collapsed by default and
 * fetched on first open: a subagent's thread is usually tool-heavy, and
 * mounting several of them at once is exactly the cost that made switching
 * panes slow (#92).
 */
export function SubagentPane({
  sessionId,
  onClose,
  controls,
}: {
  sessionId: string;
  onClose: () => void;
  controls?: React.ReactNode;
}) {
  const { t } = useTranslation(["session", "common"]);
  const blocks = useRuntimeStore((s) => s.threads[sessionId]?.blocks);
  const now = Date.now();

  // Subagents are the task-tool rows of this conversation, newest last. A tool
  // row updates in place, so the list stays one entry per subagent.
  const rows: Row[] = (blocks ?? [])
    .filter((b) => b.kind === "tool-call" && (b.tool === "task" || !!b.childSessionId))
    .map((b) => {
      const tool = b as Extract<typeof b, { kind: "tool-call" }>;
      return {
        task: tool.title,
        status: tool.status,
        childSessionId: tool.childSessionId,
        startedAt: tool.startedAt,
        endedAt: tool.endedAt,
      };
    });

  return (
    <div className="flex h-full flex-col border-l border-border bg-surface">
      <div className="flex h-12 shrink-0 select-none items-center gap-2 border-b border-border px-4">
        <PaneTitlebarInset />
        <Bot size={14} strokeWidth={1.5} className="shrink-0 text-text" />
        <span className="text-sm font-medium text-text">{t("subagents.title")}</span>
        <span className="text-xs text-muted">
          {t("subagents.count", { count: rows.length })}
        </span>
        <div className="flex-1" />
        {controls}
        <button
          className="text-text hover:opacity-60"
          aria-label={t("subagents.closeAria")}
          onClick={onClose}
        >
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {rows.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-muted">{t("subagents.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {rows.map((row, i) => (
              <SubagentRow key={`${row.childSessionId ?? "row"}:${i}`} row={row} now={now} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * One subagent: the summary line, and its full transcript once opened. A row
 * without a child session (the task never started) stays a plain summary —
 * there is nothing to open.
 */
function SubagentRow({ row, now }: { row: Row; now: number }) {
  const [open, setOpen] = useState(false);
  const childId = row.childSessionId;
  return (
    <li className="rounded-card border border-border bg-surface-2 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <StatusIcon status={row.status} />
        {childId ? (
          <button
            className="flex min-w-0 flex-1 items-center gap-1 text-left"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <ChevronRight
              size={12}
              className={cn("shrink-0 text-muted transition-transform", open && "rotate-90")}
            />
            <span className="min-w-0 flex-1 truncate text-[13px] text-text">{row.task}</span>
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[13px] text-text">{row.task}</span>
        )}
        <span className="shrink-0 text-[11px] tabular-nums text-muted">{elapsed(row, now)}</span>
      </div>
      {/* The one-line "current step" is what the collapsed row can say; once the
          transcript is open it would just repeat the last line of it. */}
      {childId && row.status === "running" && !open && <Activity childId={childId} />}
      {childId && open && <Transcript childId={childId} />}
    </li>
  );
}

/** The subagent's own thread, fetched on first open. `loadHistory` is session-
 *  scoped, so it needs no workspace switch and is a no-op once loaded. */
function Transcript({ childId }: { childId: string }) {
  const thread = useRuntimeStore((s) => s.threads[childId]);
  const loadHistory = useRuntimeStore((s) => s.loadHistory);
  // Idempotent: it returns immediately once the thread is loaded, and a live
  // subagent's blocks are already being folded in by the event stream.
  useEffect(() => {
    void loadHistory(childId);
  }, [childId, loadHistory]);
  const blocks = thread?.blocks;
  if (!blocks?.length) {
    return (
      <div className="flex justify-center py-3">
        <Loader2 size={13} className="animate-spin text-muted" />
      </div>
    );
  }
  return (
    <div className="mt-1.5 border-t border-border pt-1.5 text-[12px]">
      <BlockList blocks={blocks} />
    </div>
  );
}

/** The running subagent's current step. Subscribes to its OWN child thread so
 *  a fast-folding subagent repaints this line alone, not the whole panel. */
function Activity({ childId }: { childId: string }) {
  const activity = useRuntimeStore((s) => subagentActivity(s.threads[childId]?.blocks));
  if (!activity) return null;
  return <p className="mt-1 truncate pl-6 font-mono text-[11px] text-muted">{activity}</p>;
}

function StatusIcon({ status }: { status: ToolCallStatus }) {
  const common = "shrink-0";
  if (status === "running")
    return <Loader2 size={13} className={cn(common, "animate-spin text-accent")} />;
  if (status === "success") return <CheckCircle2 size={13} className={cn(common, "text-ok")} />;
  if (status === "failed") return <XCircle size={13} className={cn(common, "text-error")} />;
  return <CircleDashed size={13} className={cn(common, "text-muted")} />;
}
