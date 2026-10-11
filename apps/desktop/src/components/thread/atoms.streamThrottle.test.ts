// #157: the streaming markdown throttle interval scales with message length —
// the re-parse cost is linear in it, so the window must grow to keep the
// per-render work cheaper than the interval on a slow CPU.
import { describe, expect, it } from "vitest";
import { streamThrottleMs } from "./atoms";

describe("streamThrottleMs", () => {
  it("keeps 90 ms for short messages", () => {
    expect(streamThrottleMs(0)).toBe(90);
    // Below 5400 chars the raw quotient is under 90 — the floor clamps it.
    expect(streamThrottleMs(5399)).toBe(90);
    expect(streamThrottleMs(5400)).toBe(90);
  });

  it("grows linearly through the mid range", () => {
    expect(streamThrottleMs(30000)).toBe(500);
    expect(streamThrottleMs(60000)).toBe(1000);
  });

  it("caps at 1200 ms so a long answer still visibly types out", () => {
    expect(streamThrottleMs(71999)).toBe(1199);
    expect(streamThrottleMs(72000)).toBe(1200);
    expect(streamThrottleMs(120000)).toBe(1200);
    expect(streamThrottleMs(10_000_000)).toBe(1200);
  });
});
