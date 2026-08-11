// AcpRuntime against a REAL ACP agent, through the real spawning transport.
//
// Skipped unless `ACP_TEST_COMMAND` names an agent binary, exactly like the
// remote-ssh test that needs a host you can already log in to: it spawns a
// process and spends the agent's own model quota, so it must never run in the
// default suite. The fake-agent tests next door prove the mapping against wire
// shapes I wrote; this proves it against an agent nobody here controls.
//
//   ACP_TEST_COMMAND=/path/to/codex-acp pnpm --filter @ai4s/desktop test -- src/test/acp-real-agent.node.test.ts
//
// Verified 2026-08-05 against `@agentclientprotocol/codex-acp` 1.1.9.
// `gemini --acp` 0.33.1 reaches `initialize` but its `session/new` is refused
// for personal Google accounts ("migrate to the Antigravity suite"), and
// `@zed-industries/claude-code-acp` 0.16.2 refuses to start inside another
// Claude Code session — both are environment limits, not protocol ones.
import { describe, expect, it } from "vitest";


import { AcpRuntime } from "@ai4s/sdk/acp";
import type { OpenCodeEvent } from "@ai4s/sdk/acp";
import { stdioTransport } from "@ai4s/sdk/acp/stdio";

/** Last element. `Array.prototype.at` is outside this tsconfig's lib target. */
function last<T>(items: T[]): T | undefined {
  return items[items.length - 1];
}

const COMMAND = process.env.ACP_TEST_COMMAND;
/** Arguments for it, space-separated — `npx -y @agentclientprotocol/codex-acp`
 *  is how the agent most people have is actually launched. */
const ARGS = (process.env.ACP_TEST_ARGS ?? "").split(" ").filter(Boolean);

describe.skipIf(!COMMAND)("AcpRuntime against a real ACP agent", () => {
  it(
    "completes one turn: initialize → session/new → streamed answer → idle",
    async () => {
      const events: OpenCodeEvent[] = [];
      const runtime = new AcpRuntime({
        transport: stdioTransport({ command: COMMAND!, args: ARGS, cwd: process.cwd() }),
        cwd: process.cwd(),
      });
      runtime.onEvent((e) => events.push(e));

      await runtime.connect();
      expect(runtime.getStatus()).toBe("ready");
      // Whatever it calls itself — proves `initialize` really answered.
      expect(runtime.displayName.length).toBeGreaterThan(0);

      const sessionId = await runtime.createSession("real-agent check");
      expect(sessionId).toMatch(/\S/);

      await runtime.sendPrompt(sessionId, "Reply with exactly: ok");

      // The turn ended, and it ended by completing rather than erroring.
      expect(last(events)).toEqual({ type: "session.idle", sessionId });
      expect(events.filter((e) => e.type === "error")).toEqual([]);

      // The answer arrived as deltas and was accumulated: the last text.updated
      // holds the whole reply, not the final fragment.
      const texts = events.filter((e) => e.type === "text.updated") as Array<{ text: string; partId: string }>;
      if (process.env.ACP_TEST_DEBUG)
        console.log(texts.map((t) => `${t.partId}: ${JSON.stringify(t.text)}`).join("\n"));
      expect(texts.length).toBeGreaterThan(0);
      expect(last(texts)!.text.toLowerCase()).toContain("ok");
      // Monotonic growth WITHIN a part is the property that distinguishes
      // accumulation from passing the raw delta through. Per part, not across:
      // one real turn carries several — codex-acp precedes the answer with an
      // id-less notice, which is its own block.
      const byPart = new Map<string, string[]>();
      for (const t of texts) byPart.set(t.partId, [...(byPart.get(t.partId) ?? []), t.text]);
      for (const [partId, seq] of byPart) {
        for (let i = 1; i < seq.length; i++) {
          expect(seq[i]!.startsWith(seq[i - 1]!), `part ${partId} grew non-monotonically`).toBe(true);
        }
      }

      runtime.close();
      expect(runtime.getStatus()).toBe("offline");
    },
    180_000,
  );

  it(
    "lists and replays its own history, and exposes its own selectors",
    async () => {
      // Everything here is capability-gated, so the test asserts the CONTRACT
      // ("if it says it can list, listing works and finds this session"), not
      // that some particular agent supports it. A real agent is the only way to
      // find out that the shapes we read off the spec survive contact.
      const runtime = new AcpRuntime({
        transport: stdioTransport({ command: COMMAND!, args: ARGS, cwd: process.cwd() }),
        cwd: process.cwd(),
      });
      const events: OpenCodeEvent[] = [];
      runtime.onEvent((e) => events.push(e));
      await runtime.connect();

      const sessionId = await runtime.createSession("real-agent history check");
      await runtime.sendPrompt(sessionId, "Reply with exactly: hello");
      if (process.env.ACP_TEST_DEBUG)
        console.log({
          list: runtime.supportsSessionList,
          replay: runtime.supportsSessionReplay,
          delete: runtime.supportsSessionDelete,
          configOptions: runtime.configOptionsFor(sessionId).map((o) => `${o.id}=${String(o.currentValue)}`),
        });

      if (runtime.supportsSessionList) {
        const sessions = await runtime.listSessions();
        const mine = sessions.find((s) => s.id === sessionId);
        expect(mine, "the session just created is missing from session/list").toBeTruthy();
        // Every listed session carries the folder it belongs to — the sidebar
        // groups by it.
        expect(sessions.every((s) => !!s.directory)).toBe(true);
      }

      if (runtime.supportsSessionReplay) {
        const before = events.length;
        const history = await runtime.getMessages(sessionId);
        // The replay is history, not live activity.
        expect(events.length).toBe(before);
        expect(history.length).toBeGreaterThan(0);
        expect(history[0].role).toBe("user");
        expect(JSON.stringify(history).toLowerCase()).toContain("hello");
        // Nothing replayed may look like a turn still in flight.
        expect(history.every((m) => typeof m.completed === "number")).toBe(true);
      }

      // Whatever selectors it exposes must be settable through the spec method:
      // set the current value back to itself, which changes nothing and proves
      // the round-trip.
      const selectable = runtime
        .configOptionsFor(sessionId)
        .filter((o) => o.type !== "boolean" && (o.options?.length ?? 0) > 0);
      if (selectable.length > 0) {
        const option = selectable[0]!;
        const next = await runtime.setConfigOption(sessionId, option.id, String(option.currentValue));
        expect(next.some((o) => o.id === option.id)).toBe(true);
      }

      if (runtime.supportsSessionDelete) {
        await runtime.deleteSession(sessionId);
        expect((await runtime.listSessions()).some((s) => s.id === sessionId)).toBe(false);
      }

      runtime.close();
    },
    240_000,
  );

  it(
    "picks a session back up in a NEW agent process",
    async () => {
      // The repair `session/resume` exists for: the agent child restarts while
      // the conversation is still on screen. Two processes here, deliberately —
      // the second one never created the session and must still be able to
      // answer in it.
      const first = new AcpRuntime({
        transport: stdioTransport({ command: COMMAND!, args: ARGS, cwd: process.cwd() }),
        cwd: process.cwd(),
      });
      await first.connect();
      const sessionId = await first.createSession("resume check");
      await first.sendPrompt(sessionId, "Remember the word: pangolin. Reply with exactly: noted");
      first.close();

      const second = new AcpRuntime({
        transport: stdioTransport({ command: COMMAND!, args: ARGS, cwd: process.cwd() }),
        cwd: process.cwd(),
      });
      const events: OpenCodeEvent[] = [];
      second.onEvent((e) => events.push(e));
      await second.connect();
      if (!second.supportsSessionResume && !second.supportsSessionReplay) {
        second.close();
        return; // nothing to prove against an agent that keeps no sessions
      }

      // No createSession, no getMessages: straight into a turn on a session
      // this process has never heard of.
      await second.sendPrompt(sessionId, "What word did I ask you to remember? One word.");
      expect(events.filter((e) => e.type === "error")).toEqual([]);
      const texts = events.filter((e) => e.type === "text.updated") as Array<{ text: string }>;
      // The context really was restored — the agent still has the word.
      expect(texts.map((t) => t.text).join(" ").toLowerCase()).toContain("pangolin");
      second.close();
    },
    240_000,
  );
});
