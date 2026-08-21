import { cn } from "@/lib/cn";

/**
 * The calm "this step is active" mark.
 *
 * A turn lights up many rows at once — every quiet tool step, the reasoning
 * row, each subagent — and a spinner on each of them turned the thread into a
 * field of competing wheels. One spinner is enough, and it belongs to the turn
 * itself (the status line); everything below it breathes instead.
 */
export function RunningDot({ className, size = 7 }: { className?: string; size?: number }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      // `inline-block`, not the span default: a width and a height mean nothing
      // on an inline box. As a flex child (the group header, the subagent pulse)
      // the dot was blockified and showed; wrapped in the tool row's status
      // span it collapsed to 0×0, so the one row that was actually running was
      // the one row with no mark at all.
      className={cn("inline-block shrink-0 animate-pulse rounded-full bg-current", className)}
    />
  );
}
