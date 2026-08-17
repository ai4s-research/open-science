import { memo, useState } from "react";
import { Brain, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ReasoningBlock } from "@ai4s/shared";
import { cn } from "@/lib/cn";
import { RunningDot } from "./RunningDot";

/**
 * The model's reasoning ("thinking"). It auto-expands and streams live while the
 * thought is being produced, then auto-collapses to a one-line "Thought" the
 * moment the agent moves on (a later block appears, or the turn ends) — the user
 * can click it back open. `streaming` is derived by the caller (this reasoning
 * is the last block of a still-running session). `inline` renders it bare for
 * use inside a tool activity group; standalone gets its own bordered card.
 */
export const ReasoningRow = memo(function ReasoningRow({
  block,
  streaming = false,
  inline = false,
}: {
  block: ReasoningBlock;
  streaming?: boolean;
  inline?: boolean;
}) {
  const { t } = useTranslation(["session", "common"]);
  // A manual toggle sticks; otherwise the open state follows `streaming`, so a
  // thought unfolds as it streams and folds itself away once it's done.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const text = block.text.trim();
  if (!text) return null;
  const open = userOpen ?? streaming;
  return (
    <div className={cn(!inline && "rounded-input border border-border/70 bg-surface-2/40")}>
      <button
        className={cn(
          "flex w-full items-center gap-2 text-left text-xs text-muted",
          inline ? "px-2 py-1" : "px-3 py-2",
        )}
        onClick={() => setUserOpen(!open)}
        aria-expanded={open}
      >
        {streaming ? (
          <RunningDot className="text-muted/70" />
        ) : (
          <Brain size={13} className="shrink-0 text-muted/60" />
        )}
        <span className={cn(streaming && "animate-pulse")}>
          {streaming ? t("reasoning.thinking") : t("reasoning.thought")}
        </span>
        <ChevronRight
          size={13}
          className={cn("ml-auto shrink-0 transition-transform", open && "rotate-90")}
        />
      </button>
      {open && (
        <div
          className={cn(
            "max-h-56 overflow-y-auto",
            inline ? "pb-2 pl-7 pr-2" : "px-3 pb-3",
          )}
        >
          <p className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-muted/90">
            {text}
          </p>
        </div>
      )}
    </div>
  );
});
