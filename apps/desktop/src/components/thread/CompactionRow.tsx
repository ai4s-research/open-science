import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Layers } from "lucide-react";
import type { CompactionBlock } from "@ai4s/shared";
import { cn } from "@/lib/cn";

/**
 * "Context compacted" — the seam in the thread where the runtime summarized the
 * older turns to stay inside the model's context window (#62).
 *
 * This is a real event in the conversation's history: turns the reader can
 * still scroll to are no longer turns the model can see. It used to render as
 * a hairline and muted 11px text, which in a long thread meant the most
 * consequential thing that happened to the context was the least visible thing
 * on screen. So it now carries the warn accent and a filled chip — loud enough
 * to find while scrolling back, still a divider rather than a message from the
 * agent, because the conversation genuinely continues across it.
 *
 * Expanding says when it happened and whether the runtime decided on its own,
 * so context management stays auditable instead of invisible.
 */
export function CompactionRow({ block }: { block: CompactionBlock }) {
  const { t, i18n } = useTranslation("session");
  const [open, setOpen] = useState(false);
  return (
    <div className="my-5">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group flex w-full items-center gap-2 text-xs text-warn outline-none"
      >
        {/* Plain `opacity` rather than a `bg-warn/40` color modifier: the theme
            colors are opaque `var()`s, so Tailwind's slash-opacity utilities do
            not compile against them and silently render as nothing. */}
        <span className="h-px flex-1 bg-warn opacity-40" />
        <span
          className={cn(
            "flex items-center gap-1.5 rounded-full border border-warn bg-surface px-2.5 py-1 font-medium",
            "group-hover:bg-surface-2",
          )}
        >
          <Layers size={12} className="shrink-0" />
          {t("compaction.label")}
          <ChevronRight
            size={12}
            className={cn("shrink-0 transition-transform", open && "rotate-90")}
          />
        </span>
        <span className="h-px flex-1 bg-warn opacity-40" />
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
