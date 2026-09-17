import { memo } from "react";
import type { ReasoningBlock } from "@ai4s/shared";
import { Caret } from "./LiveLine";

/**
 * What the model says while it works, as prose.
 *
 * Plain text in the conversation's own colour and measure — not a card, not a
 * labelled row, not muted, and NOT clickable. It is the narration a reader
 * follows, so it reads like the rest of the conversation and behaves like it:
 * selecting a sentence must not fold the paragraph out from under the cursor,
 * which is exactly what a click-to-collapse did.
 *
 * Nothing is clamped or hidden here either. What keeps a long run from burying
 * the answer is the TURN fold above it (`TurnWork`), which takes the whole
 * finished stretch — narration and commands together — behind one line. Folding
 * each paragraph individually as well would be a second answer to a question
 * already answered, and a worse one: it hid the only part worth reading.
 *
 * `streaming` marks the thought being written right now; it gets a caret, and
 * nothing else changes, because text that reflows differently while it arrives
 * is harder to follow than text that does not.
 */
export const ReasoningRow = memo(function ReasoningRow({
  block,
  streaming = false,
}: {
  block: ReasoningBlock;
  streaming?: boolean;
  /** Retained for callers that still pass it; the inline form is gone with the
   *  grouping that needed it. */
  inline?: boolean;
}) {
  const text = block.text.trim();
  if (!text) return null;
  return (
    <p className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-text">
      {text}
      {streaming && <Caret />}
    </p>
  );
});
