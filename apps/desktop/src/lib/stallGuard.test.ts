import { describe, expect, it } from "vitest";
import {
  DEFAULT_STALL_GUARD_CONFIG,
  applyStallEvent,
  createStallSessionState,
  fnv1a,
  markStallTurnIdle,
  markStallTurnRunning,
  resetStallAfterKeepWaiting,
  stableStringify,
  stallVerdict,
  toolFingerprint,
  verdictKey,
  type StallGuardConfig,
  type StallGuardEvent,
} from "./stallGuard";

const S = "ses_1";
const MIN = 60_000;

/** A settled tool event — the shape the SDK publishes on `tool.updated` once a
 *  call has finished (status already mapped to success/failed). */
const settled = (
  tool: string,
  input: unknown,
  output: string,
  callId = "c1",
): StallGuardEvent => ({
  type: "tool.updated",
  sessionId: S,
  callId,
  tool,
  input,
  output,
  status: "success",
});

/** The #121 shape: the same bash call settling again and again, no reasoning. */
const GREP = { command: "grep -c session.id=abc log.txt" };
const run = (steps: StallGuardEvent[], cfg: Partial<StallGuardConfig> = {}) => {
  let st = markStallTurnRunning(createStallSessionState(), 0);
  const config: StallGuardConfig = { ...DEFAULT_STALL_GUARD_CONFIG, ...cfg };
  const verdicts: ReturnType<typeof stallVerdict>[] = [];
  steps.forEach((ev, i) => {
    st = applyStallEvent(st, ev, i * 1000);
    verdicts.push(stallVerdict(st, config, i * 1000));
  });
  return { verdicts, last: verdicts[verdicts.length - 1] };
};

describe("fingerprinting", () => {
  it("is stable under key order and ignores volatile keys", () => {
    const a = stableStringify({ command: "grep x", cwd: "/w", ts: 1 });
    const b = stableStringify({ cwd: "/w", command: "grep x", timestamp: 9 });
    expect(a).toBe(b);
  });

  it("differs when the meaningful payload differs", () => {
    expect(stableStringify({ command: "grep a" })).not.toBe(
      stableStringify({ command: "grep b" }),
    );
  });

  it("keeps array order significant (args order is semantics)", () => {
    expect(stableStringify(["a", "b"])).not.toBe(stableStringify(["b", "a"]));
  });

  it("hashes to a stable short hex string", () => {
    expect(fnv1a("grep x")).toBe(fnv1a("grep x"));
    expect(fnv1a("grep x")).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a("grep x")).not.toBe(fnv1a("grep y"));
  });

  it("builds a tool+args fingerprint", () => {
    expect(toolFingerprint("bash", { command: "ls" })).toBe(
      toolFingerprint("bash", { command: "ls" }),
    );
    expect(toolFingerprint("bash", { command: "ls" })).not.toBe(
      toolFingerprint("bash", { command: "ls -la" }),
    );
    expect(toolFingerprint("bash", { command: "ls" })).not.toBe(
      toolFingerprint("read", { filePath: "ls" }),
    );
  });
});

describe("Channel B — the #121 repetition shape", () => {
  const B_ON: Partial<StallGuardConfig> = { enabled: true, repeatThreshold: 3 };

  it("trips after K identical settled calls with no escape signal", () => {
    const { last } = run([settled("bash", GREP, "3"), settled("bash", GREP, "3"), settled("bash", GREP, "3")], B_ON);
    expect(last).toMatchObject({ channel: "B", count: 3 });
  });

  it("does NOT trip before K (boundary)", () => {
    const { verdicts } = run(
      [settled("bash", GREP, "3"), settled("bash", GREP, "3")],
      B_ON,
    );
    expect(verdicts[0]).toBeNull();
    expect(verdicts[1]).toBeNull();
  });

  it("is silent with the guard off", () => {
    const { last } = run(
      [settled("bash", GREP, "3"), settled("bash", GREP, "3"), settled("bash", GREP, "3")],
      { enabled: false },
    );
    expect(last).toBeNull();
  });

  it("resets when the model emits text between identical calls", () => {
    const { last } = run(
      [
        settled("bash", GREP, "3"),
        { type: "text.updated", sessionId: S, text: "Let me try again." },
        settled("bash", GREP, "3"),
        settled("bash", GREP, "3"),
      ],
      B_ON,
    );
    // After the text the counter restarted: two more identical calls → 2, not 3.
    expect(last).toBeNull();
  });

  it("resets when reasoning appears between identical calls", () => {
    const { last } = run(
      [
        settled("bash", GREP, "3"),
        { type: "reasoning.updated", sessionId: S, text: "grep again" },
        settled("bash", GREP, "3"),
        settled("bash", GREP, "3"),
      ],
      B_ON,
    );
    expect(last).toBeNull();
  });

  it("resets when a DIFFERENT call settles between repeats", () => {
    const { last } = run(
      [
        settled("bash", GREP, "3"),
        settled("read", { filePath: "log.txt" }, "contents"),
        settled("bash", GREP, "3"),
        settled("bash", GREP, "3"),
      ],
      B_ON,
    );
    // Different call broke the run; only two identical after it.
    expect(last).toBeNull();
  });

  it("resets when the same call returns a DIFFERENT output (a poll that progressed)", () => {
    const { last } = run(
      [
        settled("bash", GREP, "3"),
        settled("bash", GREP, "4"), // output changed — not a loop
        settled("bash", GREP, "4"),
        settled("bash", GREP, "4"),
      ],
      B_ON,
    );
    // The changed output reset; then only two identical. Not a trip.
    expect(last).toBeNull();
  });

  it("does not count a call that is still running (life, not a loop)", () => {
    const { last } = run(
      [
        { type: "tool.updated", sessionId: S, callId: "c1", tool: "bash", input: GREP, status: "running" },
        { type: "tool.updated", sessionId: S, callId: "c1", tool: "bash", input: GREP, status: "running" },
        { type: "tool.updated", sessionId: S, callId: "c1", tool: "bash", input: GREP, status: "running" },
      ],
      B_ON,
    );
    expect(last).toBeNull();
  });

  it("trips on the raw #121 magnitude (60+ identical)", () => {
    const steps = Array.from({ length: 60 }, () => settled("bash", GREP, "3"));
    const { last } = run(steps, B_ON);
    expect(last).toMatchObject({ channel: "B", count: 60 });
  });

  it("starts a fresh count for a new user instruction", () => {
    const { last } = run(
      [
        settled("bash", GREP, "3"),
        { type: "message.agent", sessionId: S, agent: "build" },
        settled("bash", GREP, "3"),
        settled("bash", GREP, "3"),
      ],
      B_ON,
    );
    expect(last).toBeNull();
  });

  it("clears on session.retry (a runtime retry, not a free model decision)", () => {
    const { last } = run(
      [
        settled("bash", GREP, "3"),
        { type: "session.retry", sessionId: S, attempt: 1, message: "provider hiccup" },
        settled("bash", GREP, "3"),
        settled("bash", GREP, "3"),
      ],
      B_ON,
    );
    expect(last).toBeNull();
  });

  it("carries nothing across a turn boundary", () => {
    const steps = [
      settled("bash", GREP, "3"),
      settled("bash", GREP, "3"),
    ];
    let st = markStallTurnRunning(createStallSessionState(), 0);
    steps.forEach((ev) => {
      st = applyStallEvent(st, ev, 1000);
    });
    // Turn settles — Channel B is dropped.
    st = markStallTurnIdle(st);
    // Next turn repeats twice — only 2, no carryover.
    st = markStallTurnRunning(st, 5000);
    st = applyStallEvent(st, settled("bash", GREP, "3"), 6000);
    st = applyStallEvent(st, settled("bash", GREP, "3"), 7000);
    expect(stallVerdict(st, { ...DEFAULT_STALL_GUARD_CONFIG, enabled: true, repeatThreshold: 3 }, 7000)).toBeNull();
  });

  it("trips again after the ledger moves on (re-arm)", () => {
    const steps = [
      settled("bash", GREP, "3"),
      settled("bash", GREP, "3"),
      settled("bash", GREP, "3"), // trip
      { type: "text.updated", sessionId: S, text: "New plan." },
      settled("bash", GREP, "3"),
      settled("bash", GREP, "3"),
      settled("bash", GREP, "3"), // trips again
    ];
    const { verdicts } = run(steps, B_ON);
    const tripped = verdicts.filter((v) => v?.channel === "B");
    expect(tripped).toHaveLength(2);
  });

  it("empty output counts like any other identical output (v1 decision, no fast path)", () => {
    const { last } = run(
      [settled("bash", GREP, ""), settled("bash", GREP, ""), settled("bash", GREP, "")],
      B_ON,
    );
    expect(last).toMatchObject({ channel: "B", count: 3 });
  });

  it("failed calls count as settlements too (a retry storm is a loop)", () => {
    const failed = (i: number): StallGuardEvent => ({
      type: "tool.updated",
      sessionId: S,
      callId: `c${i}`,
      tool: "bash",
      input: GREP,
      status: "failed",
    });
    const { last } = run([failed(1), failed(2), failed(3)], B_ON);
    expect(last).toMatchObject({ channel: "B", count: 3 });
  });
});

describe("Channel A — silence", () => {
  // Channel A is OFF by default (a silent long task is legitimate, so the
  // user opts in); these tests turn it on explicitly.
  const A_ON: Partial<StallGuardConfig> = {
    enabled: true,
    channelAEnabled: true,
    silenceMinutes: 10,
  };

  it("trips when a running turn has had no activity for N minutes", () => {
    let st = markStallTurnRunning(createStallSessionState(), 0);
    st = applyStallEvent(st, settled("bash", { command: "train.py" }, ""), 1_000);
    const verdict = stallVerdict(st, { ...DEFAULT_STALL_GUARD_CONFIG, ...A_ON }, 11 * MIN);
    expect(verdict).toMatchObject({ channel: "A", silenceMinutes: 10 });
  });

  it("does NOT trip while events keep arriving", () => {
    let st = markStallTurnRunning(createStallSessionState(), 0);
    for (let i = 1; i <= 30; i++) {
      st = applyStallEvent(st, settled("bash", { command: "train.py" }, `epoch ${i}`), i * MIN);
    }
    const verdict = stallVerdict(st, { ...DEFAULT_STALL_GUARD_CONFIG, ...A_ON }, 30 * MIN + 1000);
    expect(verdict).toBeNull();
  });

  it("does NOT trip when the turn is not running", () => {
    const st = createStallSessionState(); // never marked running
    const verdict = stallVerdict(st, { ...DEFAULT_STALL_GUARD_CONFIG, ...A_ON }, 99 * MIN);
    expect(verdict).toBeNull();
  });

  it("does NOT trip at exactly the boundary minus epsilon", () => {
    const st = markStallTurnRunning(createStallSessionState(), 0);
    const verdict = stallVerdict(
      st,
      { ...DEFAULT_STALL_GUARD_CONFIG, ...A_ON },
      10 * MIN - 1,
    );
    expect(verdict).toBeNull();
  });

  it("is silent when Channel A is off even if B is on", () => {
    const st = markStallTurnRunning(createStallSessionState(), 0);
    const verdict = stallVerdict(
      st,
      { ...DEFAULT_STALL_GUARD_CONFIG, enabled: true, silenceMinutes: 0, repeatThreshold: 3 },
      99 * MIN,
    );
    expect(verdict).toBeNull();
  });
});

describe("verdict keys (one reminder per trip)", () => {
  it("distinguishes channels and fingerprints", () => {
    expect(verdictKey({ channel: "A", fingerprint: null, count: 0, silenceMinutes: 10 })).toBe("A");
    expect(
      verdictKey({ channel: "B", fingerprint: "bash(...)", count: 3, silenceMinutes: 0 }),
    ).toBe("B:bash(...)");
    expect(
      verdictKey({ channel: "B", fingerprint: "read(...)", count: 3, silenceMinutes: 0 }),
    ).not.toBe(verdictKey({ channel: "B", fingerprint: "bash(...)", count: 3, silenceMinutes: 0 }));
  });
});

describe("K tuning against legitimate long-task shapes (brief §3.2 / §5.3)", () => {
  // These fixtures are what MUST NOT trip the guard: legitimate repetition
  // with real progress. The experiment: run each at K=3, K=4, K=5 and record
  // false trips, to pick the default that stays out of the way.
  const B = (k: number): Partial<StallGuardConfig> => ({ enabled: true, repeatThreshold: k });
  const tripAt = (steps: StallGuardEvent[], k: number): boolean => {
    const { verdicts } = run(steps, B(k));
    return verdicts.some((v) => v?.channel === "B");
  };

  it("one-off retry (2 attempts then success) never trips at K=3/4/5", () => {
    const steps = [
      settled("bash", { command: "npm install" }, "network error", "c1"),
      settled("bash", { command: "npm install" }, "network error", "c2"),
      settled("bash", { command: "npm install" }, "added 12 packages", "c3"),
    ];
    expect(tripAt(steps, 3)).toBe(false);
    expect(tripAt(steps, 4)).toBe(false);
    expect(tripAt(steps, 5)).toBe(false);
  });

  it("a poll whose output changes never trips at K=3/4/5", () => {
    const steps = [1, 2, 3, 4, 5, 6].map((i) =>
      settled("bash", { command: "check_job.sh" }, `still running ${i}/10`, `c${i}`),
    );
    expect(tripAt(steps, 3)).toBe(false);
    expect(tripAt(steps, 4)).toBe(false);
    expect(tripAt(steps, 5)).toBe(false);
  });

  it("an iteration loop that prints per-epoch progress never trips at K=3/4/5", () => {
    const steps = [1, 2, 3, 4, 5, 6].map((i) =>
      settled("bash", { command: "python train.py" }, `epoch ${i} loss ${1 / i}`, `c${i}`),
    );
    expect(tripAt(steps, 3)).toBe(false);
    expect(tripAt(steps, 4)).toBe(false);
    expect(tripAt(steps, 5)).toBe(false);
  });

  it("identical command with identical output 3× is the only false-trip candidate; K=3 flags it, K=4/5 do not", () => {
    // A fixed probe run twice by mistake reads identical twice → fine at K=3.
    // Three times with NOTHING between and no change is exactly what #121 was;
    // flagging it at K=3 is the designed behaviour, not a false positive.
    const steps = [
      settled("bash", { command: "probe.sh" }, "same", "c1"),
      settled("bash", { command: "probe.sh" }, "same", "c2"),
      settled("bash", { command: "probe.sh" }, "same", "c3"),
    ];
    expect(tripAt(steps, 3)).toBe(true); // designed trip
    expect(tripAt(steps, 4)).toBe(false);
    expect(tripAt(steps, 5)).toBe(false);
  });
});

describe("per-channel switches", () => {
  const settledCall = (i: number) => settled("bash", GREP, "3", `c${i}`);

  it("Channel B does not trip when channelBEnabled is false", () => {
    const cfg: StallGuardConfig = {
      ...DEFAULT_STALL_GUARD_CONFIG,
      enabled: true,
      channelAEnabled: false, // isolation: A off so only B could answer
      channelBEnabled: false,
      repeatThreshold: 3,
    };
    let st = markStallTurnRunning(createStallSessionState(), 0);
    [1, 2, 3].forEach((i) => {
      st = applyStallEvent(st, settledCall(i), i * 1000);
    });
    expect(stallVerdict(st, cfg, 3 * 1000)).toBeNull();
  });

  it("Channel B trips when only channelBEnabled is true", () => {
    const cfg: StallGuardConfig = {
      ...DEFAULT_STALL_GUARD_CONFIG,
      enabled: true,
      channelAEnabled: false,
      channelBEnabled: true,
      repeatThreshold: 3,
    };
    let st = markStallTurnRunning(createStallSessionState(), 0);
    [1, 2, 3].forEach((i) => {
      st = applyStallEvent(st, settledCall(i), i * 1000);
    });
    expect(stallVerdict(st, cfg, 3 * 1000)).toMatchObject({ channel: "B", count: 3 });
  });

  it("Channel A does not trip when channelAEnabled is false (even with B off)", () => {
    const cfg: StallGuardConfig = {
      ...DEFAULT_STALL_GUARD_CONFIG,
      enabled: true,
      channelAEnabled: false,
      channelBEnabled: false,
      silenceMinutes: 1,
    };
    const st = markStallTurnRunning(createStallSessionState(), 0);
    expect(stallVerdict(st, cfg, 2 * MIN)).toBeNull();
  });

  it("Channel A trips when only channelAEnabled is true", () => {
    const cfg: StallGuardConfig = {
      ...DEFAULT_STALL_GUARD_CONFIG,
      enabled: true,
      channelAEnabled: true,
      channelBEnabled: false,
      silenceMinutes: 1,
    };
    const st = markStallTurnRunning(createStallSessionState(), 0);
    expect(stallVerdict(st, cfg, 2 * MIN)).toMatchObject({ channel: "A", silenceMinutes: 1 });
  });

  it("defaults: Channel A OFF, Channel B ON once the master switch flips", () => {
    const cfg = { ...DEFAULT_STALL_GUARD_CONFIG, enabled: true, silenceMinutes: 1 };
    // A (silence) is opt-in — a quiet long task is legitimate, so it must not
    // nag until the user explicitly enables it.
    expect(cfg.channelAEnabled).toBe(false);
    expect(cfg.channelBEnabled).toBe(true);
    // With only the master switch on: silence does NOT trip, repetition does.
    let st = markStallTurnRunning(createStallSessionState(), 0);
    expect(stallVerdict(st, cfg, 2 * MIN)).toBeNull();
    st = markStallTurnRunning(createStallSessionState(), 0);
    [1, 2, 3].forEach((i) => {
      st = applyStallEvent(st, settledCall(i), i * 1000);
    });
    expect(stallVerdict(st, cfg, 3 * 1000)).toMatchObject({ channel: "B" });
  });

  it("resetStallAfterKeepWaiting restarts both clocks (a click is activity)", () => {
    // Channel A: silence tripped; keep-waiting restarts the clock, so the
    // SAME moment no longer trips and a fresh full period is required.
    const cfg: StallGuardConfig = {
      ...DEFAULT_STALL_GUARD_CONFIG,
      enabled: true,
      channelAEnabled: true,
      channelBEnabled: false,
      silenceMinutes: 10,
    };
    let st = markStallTurnRunning(createStallSessionState(), 0); // lastActivity = 0
    expect(stallVerdict(st, cfg, 11 * MIN)).toMatchObject({ channel: "A" });
    st = resetStallAfterKeepWaiting(st, 6 * MIN); // user clicked at t=6min
    // Same wall clock: no longer silent (clock restarted at 6min).
    expect(stallVerdict(st, cfg, 11 * MIN)).toBeNull();
    // A full fresh period after the click trips again.
    expect(stallVerdict(st, cfg, 6 * MIN + 10 * MIN)).toMatchObject({ channel: "A" });

    // Channel B: a counted run is cleared, so the next identical call starts
    // over instead of tripping on the accumulated count.
    const cfgB: StallGuardConfig = {
      ...DEFAULT_STALL_GUARD_CONFIG,
      enabled: true,
      channelAEnabled: false,
      channelBEnabled: true,
      repeatThreshold: 3,
    };
    let stB = markStallTurnRunning(createStallSessionState(), 0);
    [1, 2, 3].forEach((i) => {
      stB = applyStallEvent(stB, settledCall(i), i * 1000);
    });
    expect(stallVerdict(stB, cfgB, 3 * 1000)).toMatchObject({ channel: "B", count: 3 });
    stB = resetStallAfterKeepWaiting(stB, 4 * 1000);
    // A 4th identical call no longer trips: the counter restarted at 0.
    stB = applyStallEvent(stB, settledCall(4), 5 * 1000);
    expect(stallVerdict(stB, cfgB, 5 * 1000)).toBeNull();
    // Two more identical calls reach K again.
    stB = applyStallEvent(stB, settledCall(5), 6 * 1000);
    stB = applyStallEvent(stB, settledCall(6), 7 * 1000);
    expect(stallVerdict(stB, cfgB, 7 * 1000)).toMatchObject({ channel: "B", count: 3 });
  });
});
