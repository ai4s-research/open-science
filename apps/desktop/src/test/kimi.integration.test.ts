// @vitest-environment node
//
// Gated on KIMI_INTEGRATION=1 so CI on machines without `kimi` stays green.
// Run locally with: KIMI_INTEGRATION=1 pnpm --filter @ai4s/desktop test -- src/test/kimi.integration.test.ts

import { describe, expect, it } from "vitest";
import { KimiRuntime } from "@ai4s/sdk";

const RUN = process.env.KIMI_INTEGRATION === "1";

describe.skipIf(!RUN)("KimiRuntime ↔ real kimi acp", () => {
  it("connects, creates a session, says hello, and goes idle", async () => {
    const runtime = new KimiRuntime();
    await runtime.connect();
    try {
      const sid = await runtime.createSession();
      expect(typeof sid).toBe("string");
      expect(sid.length).toBeGreaterThan(0);

      const events: any[] = [];
      const unsub = runtime.onEvent((e) => events.push(e));
      await runtime.sendPrompt(sid, "Reply with exactly: hello from kimi");
      // Wait up to 30s for idle (turn end).
      const start = Date.now();
      while (!events.some((e) => e.type === "session.idle") && Date.now() - start < 30_000) {
        await new Promise((r) => setTimeout(r, 100));
      }
      unsub();

      expect(events.some((e) => e.type === "session.idle")).toBe(true);
      expect(events.some((e) => e.type === "text.updated")).toBe(true);
    } finally {
      runtime.close();
    }
  }, 60_000);
});
