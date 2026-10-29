import { describe, expect, it } from "vitest";
import type { ThreadBlock } from "@ai4s/shared";
import type { LayoutGroup } from "./layout";
import { buildBoard, TRAIL_LENGTH, type BoardInput } from "./taskBoard";

const NOW = new Date(2026, 9, 28, 16, 30).getTime();
const HOUR = 3600_000;

const base = (over: Partial<BoardInput> = {}): BoardInput => ({
  sessions: [],
  projects: [],
  runningSessions: {},
  permissions: [],
  questions: [],
  sessionParents: {},
  threads: {},
  agentOf: () => ({ kind: "opencode" }),
  groups: [],
  now: NOW,
  ...over,
});

const tool = (over: Partial<Extract<ThreadBlock, { kind: "tool-call" }>>): ThreadBlock => ({
  kind: "tool-call",
  title: "x",
  status: "success",
  ...over,
});

describe("buildBoard", () => {
  it("reads the current turn: tools, files written, start, live step", () => {
    const blocks: ThreadBlock[] = [
      { kind: "user", text: "old" },
      tool({ startedAt: NOW - 5 * HOUR }),
      { kind: "user", text: "now" },
      tool({ verb: "Read", filePath: "a.md", startedAt: NOW - 600_000, endedAt: NOW - 590_000 }),
      tool({ verb: "Edited", filePath: "b.py", startedAt: NOW - 500_000 }),
      tool({ verb: "Edited", filePath: "b.py", startedAt: NOW - 400_000 }),
      tool({ verb: "Ran", title: "pytest", status: "running", startedAt: NOW - 10_000 }),
    ];
    const board = buildBoard(
      base({
        sessions: [{ id: "s1", title: "Fit", updated: NOW }],
        runningSessions: { s1: true },
        threads: { s1: { blocks } },
      }),
    );
    expect(board.working).toHaveLength(1);
    const row = board.working[0];
    expect(row).toMatchObject({ tools: 4, files: 1, startedAt: NOW - 600_000, lastAt: NOW - 10_000 });
    expect(row.step).toEqual({ type: "tool", verb: "Ran", title: "pytest" });
    expect(row.trail).toEqual(["success", "success", "success", "running"]);
  });

  it("keeps only the latest tool calls in the trail", () => {
    const blocks = Array.from({ length: TRAIL_LENGTH + 5 }, () => tool({}));
    const board = buildBoard(
      base({ sessions: [{ id: "s1", title: "t" }], runningSessions: { s1: true }, threads: { s1: { blocks } } }),
    );
    expect(board.working[0].trail).toHaveLength(TRAIL_LENGTH);
    expect(board.working[0].tools).toBe(TRAIL_LENGTH + 5);
  });

  it("puts a subagent's ask on its conversation, out of working", () => {
    const board = buildBoard(
      base({
        sessions: [
          { id: "root", title: "Review", updated: NOW },
          { id: "child", title: "sub", parentId: "root", updated: NOW },
        ],
        sessionParents: { child: "root" },
        runningSessions: { child: true },
        permissions: [{ type: "permission.asked", sessionId: "child", requestId: "r", action: "bash", resources: ["pip install mne"] }],
      }),
    );
    expect(board.working).toHaveLength(0);
    expect(board.needsYou).toHaveLength(1);
    expect(board.needsYou[0]).toMatchObject({
      target: { kind: "session", sessionId: "root" },
      ask: { type: "permission", action: "bash", resource: "pip install mne" },
    });
    expect(board.today).toHaveLength(0);
  });

  it("lists terminals running a coding agent as working, aimed at their pane", () => {
    const groups = [
      {
        id: "g1",
        name: "",
        tree: {
          kind: "leaf",
          id: "l1",
          sessionId: null,
          content: { kind: "terminal", cwd: "/p", agent: { kind: "claude", sessionId: "c", running: true, title: "Refactor" } },
        },
      },
    ] as unknown as LayoutGroup[];
    const board = buildBoard(base({ groups }));
    expect(board.working).toEqual([
      expect.objectContaining({
        title: "Refactor",
        agent: { kind: "claude" },
        terminal: true,
        target: { kind: "pane", groupId: "g1", leafId: "l1" },
      }),
    ]);
  });

  it("shows today's idle conversations newest first, and skips older days and subagents", () => {
    const board = buildBoard(
      base({
        sessions: [
          { id: "a", title: "A", updated: NOW - HOUR },
          { id: "b", title: "B", updated: NOW - 60_000 },
          { id: "old", title: "Old", updated: NOW - 24 * HOUR },
          { id: "sub", title: "Sub", parentId: "a", updated: NOW },
        ],
      }),
    );
    expect(board.today.map((r) => r.title)).toEqual(["B", "A"]);
  });
});
