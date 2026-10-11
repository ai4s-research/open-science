// #157: the pure half of the stream coalescer — which events may be buffered
// (full-snapshot text/reasoning only), and the keep-latest queue that
// preserves first-arrival order across different parts.
import { describe, expect, it } from "vitest";
import { coalesceKey, upsertCoalesced, type CoalescedEntry, type CoalescibleEvent } from "./streamCoalesce";
import type { OpenCodeEvent } from "@ai4s/sdk";

const text = (partId: string, t: string) =>
  ({ type: "text.updated", sessionId: "s", partId, text: t }) as unknown as CoalescibleEvent;
const reasoning = (partId: string, t: string) =>
  ({ type: "reasoning.updated", sessionId: "s", partId, text: t }) as unknown as CoalescibleEvent;

describe("coalesceKey", () => {
  it("keys text and reasoning deltas per part", () => {
    expect(coalesceKey(text("p1", "a"))).toBe("text:p1");
    expect(coalesceKey(reasoning("p1", "a"))).toBe("reasoning:p1");
    // Same partId under different event kinds must not collide.
    expect(coalesceKey(text("p1", "a"))).not.toBe(coalesceKey(reasoning("p1", "a")));
  });

  it("refuses everything that is not a full-snapshot stream delta", () => {
    // Tools carry side effects on their RUNNING events (ssh relay, child
    // session linking) and are already throttled by the live-fold — buffering
    // them here would stack the two delays.
    expect(
      coalesceKey({ type: "tool.updated", sessionId: "s", callId: "c", tool: "bash", status: "running" } as unknown as OpenCodeEvent),
    ).toBeNull();
    // Terminal events must never wait behind a window.
    expect(coalesceKey({ type: "session.idle", sessionId: "s" } as unknown as OpenCodeEvent)).toBeNull();
    expect(coalesceKey({ type: "error", sessionId: "s", message: "x" } as unknown as OpenCodeEvent)).toBeNull();
    expect(
      coalesceKey({ type: "message.usage", sessionId: "s", messageID: "m", usage: {} } as unknown as OpenCodeEvent),
    ).toBeNull();
  });
});

describe("upsertCoalesced", () => {
  it("replaces the same part in place, keeping first-arrival order", () => {
    const queue: CoalescedEntry[] = [];
    upsertCoalesced(queue, "text:p1", text("p1", "a"));
    upsertCoalesced(queue, "reasoning:r1", reasoning("r1", "t"));
    upsertCoalesced(queue, "text:p1", text("p1", "ab"));
    // Latest snapshot won for p1 — but it stayed where it FIRST arrived.
    expect(queue.map((e) => e.key)).toEqual(["text:p1", "reasoning:r1"]);
    expect((queue[0].event as { text: string }).text).toBe("ab");
    expect((queue[1].event as { text: string }).text).toBe("t");
  });

  it("appends a part that is not buffered yet", () => {
    const queue: CoalescedEntry[] = [];
    upsertCoalesced(queue, "text:p1", text("p1", "a"));
    upsertCoalesced(queue, "text:p2", text("p2", "x"));
    expect(queue.map((e) => e.key)).toEqual(["text:p1", "text:p2"]);
  });
});
