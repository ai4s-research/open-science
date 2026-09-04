import { memo, useRef, useState } from "react";
import { Brain, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ReasoningBlock } from "@ai4s/shared";
import { cn } from "@/lib/cn";
import { Caret, LiveLine, useStickToEnd } from "./LiveLine";
import { RunningDot } from "./RunningDot";

/** The line the model is writing right now — everything after the last break. */
function latestLine(text: string): string {
  const end = text.trimEnd();
  return end.slice(end.lastIndexOf("\n") + 1);
}

/** What a finished thought was about — its opening line. */
function firstLine(text: string): string {
  const brk = text.indexOf("\n");
  return brk === -1 ? text : text.slice(0, brk);
}

/**
 * The model's reasoning ("thinking"), as one line that types itself.
 *
 * While the thought streams, the row shows the line being written and follows
 * its tail, so a long silence between tool calls is visibly the model working
 * rather than a stalled spinner. Expanding it (a click, at any time) shows the
 * whole thought, and that panel follows the stream too. Once the thought
 * settles the row keeps its opening line as a summary. `streaming` is derived
 * by the caller (this reasoning is the last block of a still-running session);
 * `inline` renders it bare for use inside a tool activity group, standalone
 * gets its own bordered card.
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
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const text = block.text.trim();
  useStickToEnd(bodyRef, streaming && open, text, "y");
  if (!text) return null;
  const summary = streaming ? latestLine(text) : firstLine(text);
  return (
    <div className={cn(!inline && "rounded-input border border-border/70 bg-surface-2/40")}>
      <button
        className={cn(
          "flex w-full items-center gap-2 text-left text-xs text-muted",
          inline ? "px-2 py-1" : "px-3 py-2",
          // The sweep belongs to the one-line row; over an expanded panel it
          // would be a curtain crossing a paragraph.
          streaming && "live-sweep",
        )}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {streaming ? (
          <RunningDot className="text-muted/70" />
        ) : (
          <Brain size={13} className="shrink-0 text-muted/60" />
        )}
        <span className="shrink-0">
          {streaming ? t("reasoning.thinking") : t("reasoning.thought")}
        </span>
        {/* Collapsed, the row IS the stream. Open, the body below shows it and a
            second copy of the same words would only compete with it. */}
        {!open && (
          <>
            <span aria-hidden className="h-[3px] w-[3px] shrink-0 rounded-full bg-current opacity-40" />
            <LiveLine text={summary} active={streaming} className="text-muted/70" />
          </>
        )}
        <ChevronRight
          size={13}
          className={cn("ml-auto shrink-0 transition-transform", open && "rotate-90")}
        />
      </button>
      {open && (
        <div
          ref={bodyRef}
          className={cn("max-h-56 overflow-y-auto", inline ? "pb-2 pl-7 pr-2" : "px-3 pb-3")}
        >
          <p className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-muted/90">
            {text}
            {streaming && <Caret />}
          </p>
        </div>
      )}
    </div>
  );
});
