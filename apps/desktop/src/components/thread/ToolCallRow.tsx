import { memo } from "react";
import { AlertTriangle, Check, Clock, ShieldQuestion, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ToolCallBlock, ToolCallStatus } from "@ai4s/shared";
import { cn } from "@/lib/cn";
import { SubagentActivity } from "./SubagentActivity";
import { RunningDot } from "./RunningDot";

// Icon + tone per status. The aria-label text is looked up from
// `session:tool.status.*` at render time (`t(\`tool.status.${status}\`)`) so it
// reacts to locale changes — never cache the translated label in this
// module-scope map.
export const STATUS: Record<ToolCallStatus, { icon: React.ReactNode; className: string }> = {
  pending: { icon: <Clock size={13} />, className: "text-muted" },
  running: { icon: <RunningDot />, className: "text-accent" },
  "waiting-approval": { icon: <ShieldQuestion size={14} />, className: "text-warn" },
  success: { icon: <Check size={13} />, className: "text-ok" },
  warning: { icon: <AlertTriangle size={14} />, className: "text-warn" },
  failed: { icon: <X size={14} />, className: "text-error" },
};

// Mechanical steps that succeeded (or are pending/running) are recorded quietly,
// like a calm activity log — a scientist scans the conversation for results and
// artifacts, not every shell command. Only things that need attention
// (waiting for approval, warnings, failures) get a prominent card. Quiet steps
// render grouped via ToolGroup; this component keeps the prominent card (and
// stays the fallback for any quiet row rendered outside a group).
export const PROMINENT = new Set<ToolCallStatus>(["waiting-approval", "warning", "failed"]);

// Memoized on `block`: a fold rebuilds only the changed block's object (the
// blocks array copy preserves every other block's reference), so an SSE event
// re-renders just the one row it touched — not the whole conversation (#34).
export const ToolCallRow = memo(function ToolCallRow({ block }: { block: ToolCallBlock }) {
  const { t } = useTranslation(["session", "common"]);
  const s = STATUS[block.status];
  const prominent = PROMINENT.has(block.status);
  return (
    <div data-status={block.status}>
      <div
        className={cn(
          "flex items-center gap-2",
          prominent
            ? "rounded-input border border-border bg-surface px-3 py-2 text-sm"
            : "px-2 py-1 text-[12.5px]",
        )}
      >
        <span className={cn("shrink-0", s.className)} aria-label={t(`tool.status.${block.status}`)} role="img">
          {s.icon}
        </span>
        {block.verb && <span className="shrink-0 text-muted">{t(`tool.verb.${block.verb}`)}</span>}
        <span
          className={cn(
            "flex-1 truncate",
            prominent ? "text-text" : cn("font-mono", block.status === "running" ? "text-text" : "text-muted"),
          )}
          title={block.command ?? block.title}
        >
          {block.title}
        </span>
        {block.meta && <span className="shrink-0 text-xs text-muted">{block.meta}</span>}
      </div>
      {/* Live pulse of the subagent this task spawned — what it is doing right
          now, one quiet line. Vanishes when the task settles. It self-subscribes
          to the child thread so its updates never re-render this memoized row. */}
      {block.status === "running" && block.childSessionId && (
        <SubagentActivity childId={block.childSessionId} />
      )}
      {/* Output of a user-typed "!" shell command — the result they asked
          for — and of a FAILED step, where the error text is the point. */}
      {(block.outputSummary ?? (block.status === "failed" ? block.output : undefined)) && (
        <pre className="ml-2 mt-0.5 max-h-64 overflow-y-auto whitespace-pre-wrap break-all rounded-input bg-surface-2 px-3 py-2 font-mono text-xs leading-5 text-text">
          {block.outputSummary ?? block.output}
        </pre>
      )}
    </div>
  );
});
