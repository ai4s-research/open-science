import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Layers } from "lucide-react";
import type { CompactionBlock } from "@ai4s/shared";
import { cn } from "@/lib/cn";

/**
 * "Context compacted" — one quiet rule across the thread where the runtime
 * summarized the older turns to stay inside the model's context window (#62).
 *
 * The point is continuity: the conversation carries on in the same session, so
 * this must read as a seam in the transcript, not as a message from the agent.
 * Expanding it says when it happened and whether the runtime did it on its own,
 * so the context management stays auditable rather than invisible.
 */
export function CompactionRow({ block }: { block: CompactionBlock }) {
  const { t, i18n } = useTranslation("session");
  const [open, setOpen] = useState(false);
  return (
    <div className="my-3">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group flex w-full items-center gap-2 text-[11px] text-muted outline-none"
      >
        <span className="h-px flex-1 bg-border" />
        <span className="flex items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-0.5 group-hover:text-text">
          <Layers size={11} className="shrink-0" />
          {t("compaction.label")}
          <ChevronRight
            size={11}
            className={cn("shrink-0 transition-transform", open && "rotate-90")}
          />
        </span>
        <span className="h-px flex-1 bg-border" />
      </button>
      {open && (
        <div className="mx-auto mt-2 max-w-prose rounded-card border border-border bg-surface-2 px-3 py-2 text-xs leading-relaxed text-muted">
          <p>{t(block.auto ? "compaction.autoBody" : "compaction.manualBody")}</p>
          {block.overflow && <p className="mt-1">{t("compaction.overflowBody")}</p>}
          {block.at != null && (
            <p className="mt-1 tabular-nums">
              {t("compaction.at", { time: new Date(block.at).toLocaleString(i18n.language) })}
            </p>
          )}
          <p className="mt-1">{t("compaction.originalKept")}</p>
        </div>
      )}
    </div>
  );
}
