import { describe, expect, it } from "vitest";
import type { HistoryMessage, HistoryPart } from "@ai4s/sdk";
import { findHistoryDefects, repairTarget } from "./malformedHistory";

function user(text: string, id = "msg_user"): HistoryMessage {
  return { role: "user", id, parts: [{ type: "text", text }] };
}
function assistant(parts: HistoryPart[], extra: Partial<HistoryMessage> = {}): HistoryMessage {
  return { role: "assistant", id: "msg_asst", parts, ...extra };
}
function tool(state: HistoryPart["state"], extra: Partial<HistoryPart> = {}): HistoryPart {
  return { type: "tool", tool: "bash", callID: "call_1", state, ...extra };
}

describe("findHistoryDefects", () => {
  it("finds nothing in a well-formed conversation", () => {
    const history = [
      user("hi"),
      assistant([
        { type: "step-start" },
        { type: "reasoning", text: "" },
        tool({ status: "completed", output: "ok" }),
        { type: "text", text: "done" },
      ]),
    ];
    expect(findHistoryDefects(history)).toEqual([]);
  });

  it("names a text part persisted without its text", () => {
    const history = [user("hi"), assistant([{ type: "text" }])];
    expect(findHistoryDefects(history)).toEqual([
      { index: 1, messageID: "msg_asst", role: "assistant", partType: "text", reason: "text-missing" },
    ]);
  });

  it("names a reasoning part persisted without its text", () => {
    const defects = findHistoryDefects([user("hi"), assistant([{ type: "reasoning" }])]);
    expect(defects).toHaveLength(1);
    expect(defects[0]).toMatchObject({ partType: "reasoning", reason: "text-missing" });
  });

  it("accepts an empty string — the converter keeps or skips it, never breaks on it", () => {
    const history = [user("hi"), assistant([{ type: "text", text: "" }])];
    expect(findHistoryDefects(history)).toEqual([]);
  });

  it("names a completed tool call with no result", () => {
    const defects = findHistoryDefects([user("hi"), assistant([tool({ status: "completed" })])]);
    expect(defects).toHaveLength(1);
    expect(defects[0]).toMatchObject({ tool: "bash", reason: "tool-result-missing" });
  });

  it("names a failed tool call with no error text", () => {
    const defects = findHistoryDefects([user("hi"), assistant([tool({ status: "error" })])]);
    expect(defects[0]).toMatchObject({ reason: "tool-error-missing" });
  });

  it("names a tool part with no call id", () => {
    const defects = findHistoryDefects([
      user("hi"),
      assistant([tool({ status: "completed", output: "ok" }, { callID: "" })]),
    ]);
    expect(defects[0]).toMatchObject({ reason: "tool-call-id-missing" });
  });

  it("reports every defect, oldest first", () => {
    const history = [
      user("hi"),
      assistant([{ type: "text" }]),
      user("again", "msg_user_2"),
      assistant([tool({ status: "completed" })]),
    ];
    expect(findHistoryDefects(history).map((d) => d.reason)).toEqual([
      "text-missing",
      "tool-result-missing",
    ]);
  });

  describe("shapes the runtime already repairs — flagging these would cost real history", () => {
    it("ignores an interrupted tool call, which is backfilled with a synthetic result", () => {
      for (const status of ["pending", "running"]) {
        expect(findHistoryDefects([user("hi"), assistant([tool({ status })])])).toEqual([]);
      }
    });

    it("ignores a tool result compaction has cleared", () => {
      const history = [
        user("hi"),
        assistant([tool({ status: "completed", time: { compacted: 172 } })]),
      ];
      expect(findHistoryDefects(history)).toEqual([]);
    });

    it("ignores an interrupted tool that reports through metadata.output", () => {
      const history = [
        user("hi"),
        assistant([tool({ status: "error", metadata: { interrupted: true, output: "stopped" } })]),
      ];
      expect(findHistoryDefects(history)).toEqual([]);
    });

    it("ignores a part the runtime marked ignored", () => {
      const history = [user("hi"), assistant([{ type: "text", ignored: true }])];
      expect(findHistoryDefects(history)).toEqual([]);
    });

    it("ignores a failed turn the converter drops whole", () => {
      const history = [
        user("hi"),
        assistant([{ type: "step-start" }, { type: "reasoning" }], { error: "Overloaded" }),
      ];
      expect(findHistoryDefects(history)).toEqual([]);
    });

    it("still scans a failed turn that produced real content", () => {
      const history = [
        user("hi"),
        assistant([{ type: "text" }, tool({ status: "completed", output: "ok" })], {
          error: "aborted",
        }),
      ];
      expect(findHistoryDefects(history)).toHaveLength(1);
    });

    it("ignores part types that never carry text", () => {
      const history = [user("hi"), assistant([{ type: "step-finish" }, { type: "patch" }])];
      expect(findHistoryDefects(history)).toEqual([]);
    });
  });
});

describe("repairTarget", () => {
  const history = [
    user("first", "msg_1"),
    assistant([{ type: "text", text: "ok" }]),
    user("second", "msg_2"),
    assistant([{ type: "text" }]),
    user("third", "msg_3"),
  ];

  it("rolls back to the user message that opened the damaged turn", () => {
    const [defect] = findHistoryDefects(history);
    expect(repairTarget(history, defect!)).toEqual({
      messageID: "msg_2",
      text: "second",
      drops: 3,
    });
  });

  it("returns the damaged message itself when the user message IS the damage", () => {
    const own = [user("first", "msg_1"), { role: "user" as const, id: "msg_2", parts: [{ type: "text" }] }];
    const [defect] = findHistoryDefects(own);
    expect(repairTarget(own, defect!)).toMatchObject({ messageID: "msg_2", drops: 1 });
  });

  it("has nothing to offer when no user message precedes the damage", () => {
    const orphaned = [assistant([{ type: "text" }])];
    const [defect] = findHistoryDefects(orphaned);
    expect(repairTarget(orphaned, defect!)).toBeUndefined();
  });

  it("skips a synthetic user part when recovering the text for the composer", () => {
    const withShell: HistoryMessage[] = [
      { role: "user", id: "msg_1", parts: [{ type: "text", text: "!ls", synthetic: true }, { type: "text", text: "real" }] },
      assistant([{ type: "text" }]),
    ];
    const [defect] = findHistoryDefects(withShell);
    expect(repairTarget(withShell, defect!)?.text).toBe("real");
  });
});
