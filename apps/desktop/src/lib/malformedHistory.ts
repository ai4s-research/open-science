import type { HistoryMessage, HistoryPart } from "@ai4s/sdk";

/**
 * Finding the one stored part that makes a session unsendable (#114).
 *
 * When a turn dies with `Invalid prompt: The messages do not match the
 * ModelMessage[] schema`, the AI SDK has rejected the whole conversation before
 * any request went out. Nothing in that message says WHICH message or field is
 * wrong, so the session just stops working: the damage is on disk, every turn
 * resends it, and retrying reproduces it exactly. This module reads the stored
 * history and names the offending part.
 *
 * The checks below are a deliberate mirror of OpenCode's own
 * `session/message-v2.ts` converter, which is what builds the array the SDK then
 * validates. Only shapes that converter turns into a part with a REQUIRED field
 * missing are reported — being wrong here costs the user real history, so the
 * cases the converter already repairs are explicitly not flagged:
 *
 *  - a `pending`/`running` tool call gets a synthetic "[Tool execution was
 *    interrupted]" result, so an interrupted tool is harmless. (This was the
 *    first thing we blamed publicly, and it was wrong.)
 *  - a tool result cleared by compaction (`state.time.compacted`) is replaced by
 *    a placeholder, so its empty `output` is harmless.
 *  - an interrupted tool reports `state.metadata.output` instead of
 *    `state.error`.
 *  - a message the converter drops outright — one with no parts, or a failed
 *    assistant turn with nothing but `step-start`/`reasoning` — cannot malform
 *    anything.
 *
 * `runtime/history-plugin/history-guard.ts` repairs this same set inside the
 * runtime, before the model ever sees it, so in a normal install nothing here
 * should ever fire. What remains for this scan is the case the guard cannot
 * cover: damage in a shape neither of us recognizes, where naming nothing and
 * saying so is the whole job. The guard additionally drops provider metadata
 * too shallow for the schema; that is deliberately not reported here, because a
 * defect the guard silently fixes is not one to show the user.
 */

/** Which required field is missing. Each maps to one AI SDK schema violation. */
export type DefectReason =
  | "text-missing"
  | "tool-result-missing"
  | "tool-error-missing"
  | "tool-call-id-missing";

export interface HistoryDefect {
  /** Position in the history array the scan was handed. */
  index: number;
  /** OpenCode's message id, when the message carries one. */
  messageID?: string;
  role: "user" | "assistant";
  /** Part type as stored: "text", "reasoning" or "tool". */
  partType: string;
  /** Tool name, on a tool part. */
  tool?: string;
  reason: DefectReason;
}

/** Parts that survive the converter's "did this message say anything?" test.
 *  A failed assistant turn holding only these is dropped whole. */
function speaks(part: HistoryPart): boolean {
  return part.type !== "step-start" && part.type !== "reasoning";
}

function defectIn(part: HistoryPart): DefectReason | undefined {
  if (part.type === "text" || part.type === "reasoning") {
    // The converter forwards `part.text` untouched. A part persisted without
    // one — a stream that died between its start and its first delta — becomes
    // `{ type: "text", text: undefined }`, and `text` is a required string.
    // An empty string is fine: it is either kept as-is or replaced with a
    // separator, and on a user part it is skipped.
    if (part.ignored) return undefined;
    return typeof part.text === "string" ? undefined : "text-missing";
  }
  if (part.type !== "tool") return undefined;
  if (typeof part.callID !== "string" || !part.callID) return "tool-call-id-missing";
  const state = part.state;
  // Only a settled tool call carries a result. Unsettled ones are backfilled.
  if (state?.status === "completed") {
    if (state.time?.compacted) return undefined;
    return typeof state.output === "string" ? undefined : "tool-result-missing";
  }
  if (state?.status === "error") {
    if (state.metadata?.interrupted === true && typeof state.metadata.output === "string") {
      return undefined;
    }
    return typeof state.error === "string" ? undefined : "tool-error-missing";
  }
  return undefined;
}

/**
 * Every stored part that would fail `ModelMessage[]` validation, oldest first.
 *
 * An empty result does not prove the history is clean — it means the damage is
 * a shape we do not yet recognize, and callers must say so rather than imply
 * the session is fine.
 */
export function findHistoryDefects(messages: HistoryMessage[]): HistoryDefect[] {
  const defects: HistoryDefect[] = [];
  messages.forEach((message, index) => {
    if (message.parts.length === 0) return;
    // A failed turn is replayed only when it still said something of substance;
    // otherwise the converter skips the message and its parts are unreachable.
    if (message.error && !message.parts.some(speaks)) return;
    for (const part of message.parts) {
      const reason = defectIn(part);
      if (!reason) continue;
      defects.push({
        index,
        ...(message.id ? { messageID: message.id } : {}),
        role: message.role,
        partType: part.type,
        ...(part.tool ? { tool: part.tool } : {}),
        reason,
      });
    }
  });
  return defects;
}

/** The user message to roll back to so `defect` is dropped: the last one at or
 *  before it. Its text goes back to the composer, so the turn the user was
 *  trying to send is not lost with it. Absent when the damage sits before any
 *  user message the app can address — nothing to revert to, so the session has
 *  to be abandoned. */
export function repairTarget(
  messages: HistoryMessage[],
  defect: HistoryDefect,
): { messageID: string; text: string; drops: number } | undefined {
  for (let i = defect.index; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user" || !message.id) continue;
    const text = message.parts
      .filter((p) => p.type === "text" && !p.synthetic)
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    return { messageID: message.id, text, drops: messages.length - i };
  }
  return undefined;
}
