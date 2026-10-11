import type { OpenCodeEvent } from "@ai4s/sdk";

/** Streaming coalescing window (#157). A streamed token folds the whole
 *  thread on every event; on a slow machine the per-token fold cost (which
 *  grows with history and message length) outruns the token interval, the
 *  backlog wedges the main thread for seconds, and the page stops scrolling.
 *  Buffering deltas and folding one batch per window decouples the render
 *  rate from the token rate. */
export const STREAM_COALESCE_MS = 120;

export type CoalescibleEvent = Extract<OpenCodeEvent, { type: "text.updated" | "reasoning.updated" }>;

/** One buffered event: `key` identifies the stream slot it updates. */
export type CoalescedEntry = { key: string; event: CoalescibleEvent };

/** Buffer key for events whose per-event fold is safe to defer: text and
 *  reasoning updates carry the FULL snapshot (the fold replaces the block's
 *  text wholesale), so keeping only the latest event per key loses nothing.
 *  Everything else returns null and must fold immediately — tool.updated
 *  merges missing fields from the previous block (not a snapshot), and its
 *  high-frequency partial-output case is already throttled by the live-fold
 *  mechanism in runtime.ts. */
export function coalesceKey(event: OpenCodeEvent): string | null {
  if (event.type === "text.updated") return `text:${event.partId}`;
  if (event.type === "reasoning.updated") return `reasoning:${event.partId}`;
  return null;
}

/** Add an event to a session's queue. A repeat key replaces the previous
 *  entry IN PLACE, so the queue stays in first-arrival order — folding the
 *  queue in order creates new blocks in exactly the order the raw stream
 *  would have. */
export function upsertCoalesced(queue: CoalescedEntry[], key: string, event: CoalescibleEvent): void {
  for (const entry of queue) {
    if (entry.key === key) {
      entry.event = event;
      return;
    }
  }
  queue.push({ key, event });
}
