import { subagentActivity, useRuntimeStore } from "@/lib/runtime";
import { cn } from "@/lib/cn";
import { LiveLine } from "./LiveLine";

/**
 * Live one-line pulse of the subagent a task tool spawned. It subscribes to
 * ONLY its child session's thread, so a subagent's high-frequency folds
 * re-render this tiny leaf alone — never the parent tool row (which stays
 * memoized on its own block) or the whole conversation. Renders nothing until
 * the child reports an activity. Mount it only while the task is running.
 *
 * With `onOpen` the line is also the way into that subagent's own transcript.
 */
export function SubagentActivity({
  childId,
  onOpen,
  openLabel,
}: {
  childId: string;
  onOpen?: () => void;
  openLabel?: string;
}) {
  const activity = useRuntimeStore((s) => subagentActivity(s.threads[childId]?.blocks));
  if (!activity) return null;
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-input px-2 pb-0.5 text-xs",
        onOpen && "cursor-pointer hover:bg-surface-2",
      )}
      data-subagent-activity
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      title={onOpen ? openLabel : undefined}
      onClick={onOpen}
      onKeyDown={
        onOpen
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen();
              }
            }
          : undefined
      }
    >
      <span
        aria-hidden
        className="mb-1.5 ml-[6px] h-2 w-2 shrink-0 rounded-bl border-b border-l border-border"
      />
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
      <LiveLine text={activity} active className="font-mono text-muted" />
    </div>
  );
}
