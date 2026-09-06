// Stall guard — a safety net that NOTICES a turn that is likely stuck (#121),
// and nothing more. It never stops, throttles, or caps anything: it only tells
// the user what it saw and lets them decide (Stop is one click away in the UI).
//
// Two independent channels, both opt-in (off by default):
//
//  Channel A — silence: a session is mid-turn (no session.idle yet) and no
//    activity event has arrived for N minutes of wall clock. Catches the
//    "the script exited and the turn never returned" / hung-request shape,
//    where nothing at all is streaming.
//
//  Channel B — strict repetition: within one turn, the SAME tool-call
//    fingerprint settles K times IN A ROW with no escape signal between
//    them. An escape signal is anything that shows the work moved on:
//      • an assistant text/reasoning update (the model made a new decision),
//      • a DIFFERENT tool fingerprint settling (the work progressed), or
//      • the same fingerprint with a DIFFERENT output hash (a legitimate poll
//        whose result is changing).
//    Any escape signal clears the counter back to zero. This is the #121
//    shape: the reported session ran the same call 60+ times with identical
//    results and no reasoning in between.
//
// Deliberately structural, never semantic: the fingerprint is
// tool + normalized arguments, no LLM, no "is this command useful" judgement.
//
// Everything here is a pure function of its inputs — no timers, no store, no
// UI. The runtime feeds events in and reads verdicts out; the UI renders the
// verdict. Unit tests live next door.

/** Persisted, user-tunable configuration. All off by default: a long legitimate
 *  task (a training run quiet for an hour, a poll that repeats with changing
 *  output) must never be nagged unless the user opted in. */
export interface StallGuardConfig {
  /** Master switch — when off, nothing is computed and no verdict is ever
   *  returned. */
  enabled: boolean;
  /** Channel A: watch for silence (a running turn with no activity for
   *  `silenceMinutes`). Independent of Channel B. */
  channelAEnabled: boolean;
  /** Channel A: minutes of silence before a "still running, or stuck?" line. */
  silenceMinutes: number;
  /** Channel B: watch for strict repetition (the same tool fingerprint
   *  settling `repeatThreshold` times with identical output, no escape).
   *  Independent of Channel A. */
  channelBEnabled: boolean;
  /** Channel B: identical consecutive settlements before a "looping?" line. */
  repeatThreshold: number;
}

/** Per-session ledger fed by the event stream. Not exported as a class — the
 *  runtime keeps one map of session id → state, mirrors the existing
 *  `sseLast`/`turnPostAt` module-level Maps. */
export interface StallSessionState {
  /** Wall-clock ms of the last activity event (any SSE event for this
   *  session), for Channel A. */
  lastActivityAt: number | null;
  /** Channel B: the fingerprint currently being counted, or null when the
   *  counter is idle. */
  runFingerprint: string | null;
  /** Channel B: how many consecutive identical settlements of
   *  `runFingerprint` we have seen so far (1-based; reaches K → verdict). */
  runCount: number;
  /** Channel B: output hash of the LAST settlement of `runFingerprint`, so a
   *  repeat whose output CHANGED can be told apart from one whose output is
   *  identical (a poll that returns progress is not a loop). */
  lastOutputHash: string | null;
  /** True while the current turn is still in flight (session.idle not yet
   *  seen). Channel A only counts running turns; Channel B only counts within
   *  one turn. The runtime sets this from its OWN running-lock bookkeeping
   *  (`runningSessions` / `onTurnIdle`) — the event stream alone cannot tell
   *  "turn started" from "turn ended" (`message.agent` arrives for BOTH, see
   *  runtime.ts ACTIVITY_EVENTS comment). */
  turnRunning: boolean;
}

export type StallChannel = "A" | "B";

/** What the guard concluded, ready for the UI to render. `detail` is a
 *  human-readable, explainable summary of the evidence. */
export interface StallVerdict {
  channel: StallChannel;
  /** Fingerprint of the repeated call (Channel B) or null (Channel A). */
  fingerprint: string | null;
  /** How many identical settlements were counted (Channel B). */
  count: number;
  /** Minutes of silence measured (Channel A). */
  silenceMinutes: number;
}

/** Defaults. Channel B (repetition — the #121 shape) is ON once the master
 *  switch is flipped, because it essentially never misfires on legitimate
 *  work. Channel A (silence) is OFF by default: a legitimate long task — a
 *  training run, a heavy computation — can be quiet for far longer than the
 *  threshold, and silence is the one channel that CAN cry wolf on real work,
 *  so the user opts into it explicitly. */
export const DEFAULT_STALL_GUARD_CONFIG: StallGuardConfig = {
  enabled: false,
  channelAEnabled: false,
  silenceMinutes: 10,
  channelBEnabled: true,
  repeatThreshold: 3,
};

export function createStallSessionState(): StallSessionState {
  return {
    lastActivityAt: null,
    runFingerprint: null,
    runCount: 0,
    lastOutputHash: null,
    turnRunning: false,
  };
}

/** The runtime calls this when it arms a session's running lock (a send was
 *  accepted). Starts a fresh turn: the previous turn's repetition must not
 *  carry over. */
export function markStallTurnRunning(state: StallSessionState, now: number): StallSessionState {
  return {
    ...state,
    turnRunning: true,
    // A new turn is a new decision context — never carry Channel B across it.
    runFingerprint: null,
    runCount: 0,
    lastOutputHash: null,
    // Base the silence clock at turn start: a turn that has produced nothing
    // since it began is the case Channel A exists for.
    lastActivityAt: now,
  };
}

/** The runtime calls this when the turn settles (`onTurnIdle`, or the error
 *  handler). Stops Channel A's clock and drops Channel B. */
export function markStallTurnIdle(state: StallSessionState): StallSessionState {
  return {
    ...state,
    turnRunning: false,
    runFingerprint: null,
    runCount: 0,
    lastOutputHash: null,
  };
}

/** The user answered a stall warning with "Keep waiting" — they are watching
 *  and believe the turn is still working. Their click IS activity for the
 *  guard: Channel A's silence clock restarts from now (the next warning needs
 *  a full fresh silence period), and Channel B's repetition counter resets
 *  (the next warning needs K fresh identical calls). Without this, a silent
 *  turn would be re-reminded on every 30 s tick — "remind me later" would
 *  really mean "remind me every 30 seconds". */
export function resetStallAfterKeepWaiting(
  state: StallSessionState,
  now: number,
): StallSessionState {
  return {
    ...state,
    lastActivityAt: now,
    runFingerprint: null,
    runCount: 0,
    lastOutputHash: null,
  };
}

/** Tool events whose terminal state means "the tool call settled". A guard on
 *  repeated *settlements* — pending/running events show a tool is alive, which
 *  is exactly the signal that must NOT trip the guard.
 *
 *  Values are the UI-layer ToolCallStatus the SDK publishes on `tool.updated`
 *  (OpenCodeClient.ts `mapToolStatus`): the SDK already translated the
 *  runtime's raw `completed`/`error` into `success`/`failed`. */
const SETTLED_TOOL_STATUS = new Set(["success", "failed"]);

/** Stable, dependency-free 32-bit string hash (FNV-1a). Good enough for
 *  fingerprint equality — we never persist it, and collisions only cause a
 *  false "different" (safe direction). */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Force unsigned, then hex — keeps the hash stable across platforms.
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Stable serialization of a tool's `input` for fingerprinting. JSON with
 *  sorted keys, and a small set of well-known volatile keys excluded — a
 *  timestamp or a random nonce that changes every call must not make two
 *  otherwise-identical calls look different. Values are not truncated:
 *  a command that embeds a path change IS a different call. */
const VOLATILE_INPUT_KEYS = new Set([
  // Volatile by nature — these change on every invocation and carry no
  // semantic content about WHAT the tool does.
  "timestamp",
  "ts",
  "nonce",
  "requestId",
  "correlationId",
  "traceId",
  "sessionId",
]);

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => !VOLATILE_INPUT_KEYS.has(k))
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** The structural fingerprint of one tool call: tool name + normalized input.
 *  Two calls with the same fingerprint are "the same call" for the guard. */
export function toolFingerprint(tool: string, input: unknown): string {
  return `${tool}(${stableStringify(input)})`;
}

/** Which OpenCode event types count as "the model is doing something" for the
 *  escape signals and for Channel A's activity definition. Mirrors the
 *  runtime's own ACTIVITY_EVENTS — assistant progress, never the trailing
 *  user-message republish that arrives ~40 ms after session.idle.
 *
 *  Every field optional so any SDK event structurally satisfies it: the guard
 *  reads only what it needs and ignores the rest. No index signature — that
 *  would break assignability from the SDK's closed discriminated unions. */
export type StallGuardEvent = {
  type: string;
  sessionId?: string;
  text?: string;
  tool?: string;
  input?: unknown;
  output?: string;
  status?: string;
  callId?: string;
  /** message.agent: which agent the user message carried ("build"/"plan"). */
  agent?: string;
  /** session.retry: which attempt the runtime is on. */
  attempt?: number;
  message?: string;
};

/** Push one SSE event into a session's ledger and return the updated state.
 *  Pure: `now` is injected by the caller so tests are deterministic.
 *
 *  Turn lifecycle is NOT inferred here — the runtime drives it via
 *  `markStallTurnRunning` / `markStallTurnIdle` from its own running-lock
 *  bookkeeping. This function only maintains the activity clock (Channel A)
 *  and the repetition counter (Channel B). */
export function applyStallEvent(
  state: StallSessionState,
  event: StallGuardEvent,
  now: number,
): StallSessionState {
  const s = { ...state };

  // ---- Activity (Channel A) ----
  // Every SSE event for this session counts as activity — same definition as
  // the runtime's sseLast bookkeeping. A turn that is streaming ANYTHING is
  // not silently stuck, no matter how long it runs.
  s.lastActivityAt = now;

  // ---- New user instruction resets Channel B ----
  // A user message means a new instruction — a new decision, whatever the
  // model does next. (The same event also arrives ~40 ms AFTER session.idle
  // as OpenCode republishes the turn's user message; by then the runtime has
  // already called markStallTurnIdle, so the counter is empty and this is a
  // harmless no-op.)
  if (event.type === "message.agent") {
    return { ...s, runFingerprint: null, runCount: 0, lastOutputHash: null };
  }

  // ---- Channel B: repetition ----
  if (event.type === "tool.updated") {
    // A tool that is still pending/running is *life* — never count it.
    if (!event.status || !SETTLED_TOOL_STATUS.has(event.status)) {
      return s;
    }
    const fp = toolFingerprint(event.tool ?? "", event.input);
    const outHash = fnv1a(typeof event.output === "string" ? event.output : "");

    if (s.runFingerprint === fp) {
      if (outHash === s.lastOutputHash) {
        // Same call, same output: this is the repetition we are counting.
        s.runCount += 1;
        return s;
      }
      // Same call but the OUTPUT CHANGED — a poll returned progress, or a
      // retry finally succeeded. Not a loop: reset.
      s.runFingerprint = null;
      s.runCount = 0;
      s.lastOutputHash = null;
      return s;
    }
    // A different call settled — the work moved on. Start counting this one.
    s.runFingerprint = fp;
    s.runCount = 1;
    s.lastOutputHash = outHash;
    return s;
  }

  // ---- Escape signals that reset Channel B ----
  // The model emitted new text or reasoning: it made a decision. Whatever
  // repetition was being counted is over.
  if (event.type === "text.updated" || event.type === "reasoning.updated") {
    if (event.type === "text.updated" && event.text === "") return s; // empty stream start, not a decision
    s.runFingerprint = null;
    s.runCount = 0;
    s.lastOutputHash = null;
    return s;
  }

  // A retry notice means the runtime itself re-sent the request — not the
  // model freely choosing the same call again. Reset (see brief §3.2).
  if (event.type === "session.retry") {
    s.runFingerprint = null;
    s.runCount = 0;
    s.lastOutputHash = null;
    return s;
  }

  return s;
}

/** Whether a session's ledger currently trips a channel, given the config.
 *  Pure. The runtime calls this after feeding the event that may have tripped
 *  it (Channel B), and on a timer for Channel A, since silence is the ABSENCE
 *  of events and must be noticed by the clock. Each channel is gated by its
 *  own switch. */
export function stallVerdict(
  state: StallSessionState,
  config: StallGuardConfig,
  now: number,
): StallVerdict | null {
  if (!config.enabled) return null;

  // Channel A: the turn is running and nothing has arrived for N minutes.
  if (
    config.channelAEnabled &&
    config.silenceMinutes > 0 &&
    state.turnRunning &&
    state.lastActivityAt !== null &&
    now - state.lastActivityAt >= config.silenceMinutes * 60_000
  ) {
    return {
      channel: "A",
      fingerprint: null,
      count: 0,
      silenceMinutes: config.silenceMinutes,
    };
  }

  // Channel B: the same fingerprint has settled K times in a row.
  const k = config.repeatThreshold;
  if (
    config.channelBEnabled &&
    k >= 2 &&
    state.runFingerprint !== null &&
    state.runCount >= k
  ) {
    return {
      channel: "B",
      fingerprint: state.runFingerprint,
      count: state.runCount,
      silenceMinutes: 0,
    };
  }

  return null;
}

/** Arm one reminder per trip: once a verdict has been rendered for a given
 *  (channel, fingerprint) it must not re-fire on every event/timer tick until
 *  the ledger has moved on (new activity / new fingerprint / turn end). */
export function verdictKey(v: StallVerdict): string {
  return v.channel === "A" ? "A" : `B:${v.fingerprint ?? ""}`;
}
