import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { fmtDuration } from "./ToolGroup";

/**
 * A finished turn's work, folded behind one line.
 *
 * `Worked for 59m 3s ›` — the ask and the answer stay, an hour of narration and
 * commands goes behind it, and a click brings it back. It is the fold Codex puts
 * between a question and its result, and the reason a long session reads as a
 * conversation instead of a log.
 *
 * Only finished work folds. While a turn runs, its narration and its activity
 * lines are the only sign of progress there is, so `TurnWork` renders them
 * plainly and adds no chrome at all — see `isTurnDone`.
 *
 * Manual expansion is per component instance, which outlives every re-render and
 * every Screen switch (inactive screens stay mounted). So a turn the reader
 * opened stays open for as long as they are looking at that conversation, and a
 * reload starts it folded again — which is the right default for work that is
 * already done.
 */
export function TurnWork({
  done,
  durationMs,
  children,
}: {
  done: boolean;
  durationMs: number | null;
  children: React.ReactNode;
}) {
  const { t } = useTranslation(["session", "common"]);
  const [open, setOpen] = useState(false);

  if (!done) return <>{children}</>;

  return (
    <div className="flex flex-col gap-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group flex w-full items-center gap-1.5 text-left text-[13.5px] text-muted hover:text-text"
      >
        <span>
          {durationMs === null
            ? t("turn.worked")
            : t("turn.workedFor", { duration: fmtDuration(durationMs) })}
        </span>
        <ChevronRight
          size={14}
          strokeWidth={1.5}
          className={cn("shrink-0 transition-transform duration-200", open && "rotate-90")}
        />
      </button>
      {open && <div className="flex flex-col gap-4">{children}</div>}
      {/* The rule sits under the fold whether it is open or shut, so the answer
          below always has the same separation from the work above it. */}
      <hr className="border-faint" />
    </div>
  );
}
