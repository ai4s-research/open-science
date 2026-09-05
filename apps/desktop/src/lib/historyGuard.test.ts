import { describe, expect, it } from "vitest";
import * as guard from "../../../../runtime/history-plugin/history-guard";
import { findHistoryDefects } from "./malformedHistory";
import type { HistoryMessage } from "@ai4s/sdk";

/** Drive the guard the way OpenCode does — through the registered hook, on the
 *  array the converter then reads. The helpers behind it are deliberately not
 *  exported; see the export test. */
async function transform(messages: unknown[]): Promise<void> {
  const hook = (await guard.HistoryGuardPlugin())["experimental.chat.messages.transform"];
  await hook({}, { messages } as never);
}

const message = (parts: unknown[]) => ({ info: { role: "assistant" }, parts });

describe("history guard", () => {
  it("gives a text part that lost its text an empty one", async () => {
    const msgs = [message([{ type: "text" }])];
    await transform(msgs);
    expect(msgs[0].parts[0]).toEqual({ type: "text", text: "" });
  });

  it("repairs a reasoning part the same way", async () => {
    const msgs = [message([{ type: "reasoning", text: null }])];
    await transform(msgs);
    expect((msgs[0].parts[0] as { text: unknown }).text).toBe("");
  });

  it("records that a completed tool reported nothing, rather than sending nothing", async () => {
    const msgs = [message([{ type: "tool", callID: "c1", state: { status: "completed" } }])];
    await transform(msgs);
    expect((msgs[0].parts[0] as { state: { output: string } }).state.output).toMatch(/No tool output/);
  });

  it("gives a failed tool call an error text when it has none", async () => {
    const msgs = [message([{ type: "tool", callID: "c1", state: { status: "error" } }])];
    await transform(msgs);
    expect((msgs[0].parts[0] as { state: { error: string } }).state.error).toMatch(/No error detail/);
  });

  it("synthesizes a call id, keeping it unique across parts", async () => {
    const msgs = [
      message([
        { type: "tool", state: { status: "completed", output: "a" } },
        { type: "tool", callID: "", state: { status: "completed", output: "b" } },
      ]),
    ];
    await transform(msgs);
    const ids = msgs[0].parts.map((p) => (p as { callID: string }).callID);
    expect(ids[0]).toMatch(/^osd-repaired-/);
    expect(new Set(ids).size).toBe(2);
  });

  it("drops provider metadata too shallow for the schema, and keeps a well-formed one", async () => {
    const signed = { anthropic: { signature: "sig" } };
    const msgs = [
      message([
        { type: "text", text: "a", metadata: { source: "ai4s.background-review" } },
        { type: "reasoning", text: "b", metadata: signed },
      ]),
    ];
    await transform(msgs);
    expect(msgs[0].parts[0]).not.toHaveProperty("metadata");
    expect((msgs[0].parts[1] as { metadata: unknown }).metadata).toEqual(signed);
  });

  it("leaves a tool part's metadata alone — the runtime already strips its one bad key", async () => {
    // Not an oversight: `providerMeta` removes `providerExecuted` before a tool
    // part's metadata reaches the model, and nothing in this app writes tool
    // metadata. Covering it here would guard an empty set.
    const part = {
      type: "tool",
      callID: "c1",
      state: { status: "completed", output: "ok" },
      metadata: { openai: { id: "1" }, providerExecuted: true },
    };
    await transform([message([part])]);
    expect(part.metadata).toEqual({ openai: { id: "1" }, providerExecuted: true });
  });

  it("drops metadata that is not an object at all", async () => {
    const part = { type: "text", text: "x", metadata: "nonsense" };
    await transform([message([part])]);
    expect(part).not.toHaveProperty("metadata");
  });

  describe("leaves alone what the runtime already repairs", () => {
    it("does not touch an interrupted tool call", async () => {
      for (const status of ["pending", "running"]) {
        const part = { type: "tool", callID: "c1", state: { status } };
        const msgs = [message([part])];
        await transform(msgs);
        expect(part.state).toEqual({ status });
      }
    });

    it("does not touch a result compaction has cleared", async () => {
      const part = { type: "tool", callID: "c1", state: { status: "completed", time: { compacted: 9 } } };
      const msgs = [message([part])];
      await transform(msgs);
      expect(part.state).not.toHaveProperty("output");
    });

    it("does not touch an interrupted tool reporting through metadata", async () => {
      const state = { status: "error", metadata: { interrupted: true, output: "stopped" } };
      const msgs = [message([{ type: "tool", callID: "c1", state }])];
      await transform(msgs);
      expect(state).not.toHaveProperty("error");
    });

    it("leaves a healthy conversation byte for byte identical", async () => {
      const healthy = [
        message([
          { type: "step-start" },
          { type: "text", text: "done", metadata: { openai: { id: "1" } } },
          { type: "tool", callID: "c1", state: { status: "completed", output: "ok" } },
        ]),
      ];
      const before = JSON.stringify(healthy);
      await transform(healthy);
      expect(JSON.stringify(healthy)).toBe(before);
    });
  });

  describe("it can never be the thing that breaks a turn", () => {
    it("mutates in place — replacing the array would repair a copy nobody reads", async () => {
      const parts = [{ type: "text" }];
      const msgs = [message(parts)];
      await transform(msgs);
      expect(msgs[0].parts).toBe(parts); // same reference the converter holds
      expect(parts[0]).toHaveProperty("text", "");
    });

    it("swallows every shape of nonsense instead of blocking the send", async () => {
      await expect(transform([])).resolves.toBeUndefined();
      for (const junk of [null, undefined, 42, "x", { parts: null }, { parts: [null, 7] }]) {
        await expect(transform([junk as never])).resolves.toBeUndefined();
      }
      const hook = (await guard.HistoryGuardPlugin())["experimental.chat.messages.transform"];
      await expect(hook({}, { messages: undefined })).resolves.toBeUndefined();
      await expect(hook({}, undefined as never)).resolves.toBeUndefined();
    });

    it("exports the plugin factory and nothing else", () => {
      expect(Object.keys(guard)).toEqual(["HistoryGuardPlugin"]);
    });

    it("survives the loader calling every export with no arguments", async () => {
      for (const value of Object.values(guard)) {
        await expect((value as () => unknown)()).resolves.toBeDefined();
      }
    });
  });

  it("clears every defect the app would have reported to the user", async () => {
    // The guard and the diagnosis are two statements of one rule set, on
    // opposite sides of a process boundary. This is what keeps them in step:
    // whatever the app would name as damage, the guard must have repaired.
    const damaged: HistoryMessage[] = [
      { role: "user", id: "m1", parts: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        id: "m2",
        parts: [
          { type: "text" },
          { type: "reasoning" },
          { type: "tool", tool: "bash", callID: "c1", state: { status: "completed" } },
          { type: "tool", tool: "edit", callID: "c2", state: { status: "error" } },
          { type: "tool", tool: "read", state: { status: "completed", output: "ok" } },
        ],
      },
    ];
    expect(findHistoryDefects(damaged)).toHaveLength(5);
    await transform(damaged.map((m) => ({ info: m, parts: m.parts })));
    expect(findHistoryDefects(damaged)).toEqual([]);
  });
});
