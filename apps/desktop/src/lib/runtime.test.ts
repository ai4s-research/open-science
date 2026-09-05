import { describe, expect, it } from "vitest";
import type { OpenCodeEvent, HistoryMessage } from "@ai4s/sdk";
import { AUTO_REVIEW_PROMPT } from "./autoReview";
import { GOAL_RESUME_NUDGE } from "./goalPrompts";
import {
  datedWorkspaceName,
  explainRuntimeError,
  turnStillStreaming,
  foldCarriageReturns,
  foldEvent,
  historyToThread,
  humanizeCommand,
  lastAgentMode,
  redactForLog,
  subagentActivity,
  tidyToolTitle,
  toolPresentation,
  type FoldState,
} from "./runtime";

const empty: FoldState = { blocks: [], index: {} };
const S = "ses_1";
const foldAll = (events: OpenCodeEvent[], from: FoldState = empty): FoldState =>
  events.reduce((s, e) => foldEvent(s, e), from);

describe("tidyToolTitle", () => {
  it("shows workspace files by their relative path", () => {
    expect(tidyToolTitle("/Users/asq/Documents/OpenScience/demo/analyze.py")).toBe("demo/analyze.py");
    expect(tidyToolTitle("mkdir -p /Users/asq/Documents/OpenScience/demo_analysis")).toBe(
      "mkdir -p demo_analysis",
    );
    // OpenCode's write-tool titles drop the leading slash — must still relativize.
    expect(tidyToolTitle("Users/asq/Documents/OpenScience/demo_analysis/analyze.py")).toBe(
      "demo_analysis/analyze.py",
    );
  });
  it("leaves non-workspace titles unchanged", () => {
    expect(tidyToolTitle("search (done)")).toBe("search (done)");
    expect(tidyToolTitle("python3 -c \"import numpy\"")).toBe('python3 -c "import numpy"');
  });
});

describe("humanizeCommand", () => {
  it("strips leading cd hops so the real command leads", () => {
    expect(
      humanizeCommand("cd output/experiment-suite/very/long/path && python train.py --mode teacher"),
    ).toBe("python train.py --mode teacher");
    expect(humanizeCommand("cd /a/b; cd c && ls -la")).toBe("ls -la");
    expect(humanizeCommand('cd "dir with spaces" && make test')).toBe("make test");
  });
  it("collapses whitespace but leaves cd-less commands intact", () => {
    expect(humanizeCommand("git  status\n  --short")).toBe("git status --short");
  });
  it("a bare cd keeps the command (nothing better to show)", () => {
    expect(humanizeCommand("cd demo")).toBe("cd demo");
  });
});

describe("foldCarriageReturns", () => {
  it("keeps only what each line last drew (tqdm-style redraws)", () => {
    expect(foldCarriageReturns("epoch 1:  10%\repoch 1:  50%\repoch 1: 100%\ndone")).toBe(
      "epoch 1: 100%\ndone",
    );
    expect(foldCarriageReturns("plain\ntext")).toBe("plain\ntext");
  });
});

describe("toolPresentation", () => {
  it("bash: verb Ran + de-noised command, over the model's description", () => {
    expect(toolPresentation("bash", "install deps", { command: "cd x && pip install numpy" })).toEqual({
      verb: "Ran",
      title: "pip install numpy",
    });
  });
  it("file tools: verb + relative path", () => {
    expect(
      toolPresentation("write", "", { filePath: "/Users/asq/Documents/OpenScience/demo/train.py" }),
    ).toEqual({ verb: "Created", title: "demo/train.py" });
    expect(toolPresentation("edit", "", { filePath: "config.yaml" })).toEqual({
      verb: "Edited",
      title: "config.yaml",
    });
  });
  it("unknown tools keep the old fallback chain, no verb", () => {
    expect(toolPresentation("mcp_thing", "did something", {})).toEqual({ title: "did something" });
    expect(toolPresentation("mcp_thing", "", {})).toEqual({ title: "mcp_thing" });
  });
});

describe("datedWorkspaceName", () => {
  it("formats a zero-padded YYYY-MM-DD-HHMM folder name", () => {
    expect(datedWorkspaceName(new Date(2026, 6, 4, 16, 5))).toBe("2026-07-04-1605");
    expect(datedWorkspaceName(new Date(2026, 0, 9, 3, 40))).toBe("2026-01-09-0340");
  });
});

describe("foldEvent", () => {
  it("upserts a text part by id (idempotent full-text updates, not appends)", () => {
    const s = foldAll([
      { type: "text.updated", sessionId: S, partId: "p1", text: "Planning" },
      { type: "text.updated", sessionId: S, partId: "p1", text: "Planning the review" },
    ]);
    expect(s.blocks).toHaveLength(1);
    expect(s.blocks[0]).toEqual({ kind: "agent", markdown: "Planning the review" });
  });

  it("upserts a reasoning part by id into a reasoning block (thinking, streamed)", () => {
    const s = foldAll([
      { type: "reasoning.updated", sessionId: S, partId: "r1", text: "Let me" },
      { type: "reasoning.updated", sessionId: S, partId: "r1", text: "Let me check the data" },
    ]);
    expect(s.blocks).toHaveLength(1);
    expect(s.blocks[0]).toEqual({ kind: "reasoning", text: "Let me check the data" });
  });

  it("keeps reasoning separate from the final answer text", () => {
    const s = foldAll([
      { type: "reasoning.updated", sessionId: S, partId: "r1", text: "Thinking…" },
      { type: "text.updated", sessionId: S, partId: "p1", text: "Here is the answer" },
    ]);
    expect(s.blocks).toHaveLength(2);
    expect(s.blocks[0]).toEqual({ kind: "reasoning", text: "Thinking…" });
    expect(s.blocks[1]).toEqual({ kind: "agent", markdown: "Here is the answer" });
  });

  it("upserts a tool call by callId and reflects status transitions", () => {
    const s = foldAll([
      { type: "tool.updated", sessionId: S, callId: "c1", tool: "search", status: "running", title: "search" },
      { type: "tool.updated", sessionId: S, callId: "c1", tool: "search", status: "success", title: "search (done)" },
    ]);
    expect(s.blocks).toHaveLength(1);
    expect(s.blocks[0]).toMatchObject({ kind: "tool-call", status: "success", title: "search (done)" });
  });

  it("places an inline presentation immediately after its completed tool call", () => {
    const event: OpenCodeEvent = {
      type: "tool.updated",
      sessionId: S,
      callId: "present-1",
      tool: "present_artifact",
      status: "success",
      input: {
        path: "figures/result.png",
        display: "inline",
        title: "Result",
      },
    };
    const once = foldEvent(empty, event);
    const twice = foldEvent(once, event);
    expect(twice.blocks).toHaveLength(2);
    expect(twice.blocks[1]).toMatchObject({
      kind: "artifact",
      path: "figures/result.png",
      presentation: { mode: "inline", title: "Result" },
    });
  });

  it("does not render interactive question/permission tools as thread rows", () => {
    // These are surfaced by InteractionPrompt (answerable), not as blank rows.
    const s = foldAll([
      { type: "tool.updated", sessionId: S, callId: "q1", tool: "question", status: "running", title: "" },
      { type: "tool.updated", sessionId: S, callId: "p1", tool: "permission", status: "running", title: "" },
    ]);
    expect(s.blocks).toHaveLength(0);
  });

  it("drops opaque todo tool rows from the conversation", () => {
    const s = foldAll([
      { type: "tool.updated", sessionId: S, callId: "t1", tool: "todowrite", status: "success", title: "4 todos" },
    ]);
    expect(s.blocks).toHaveLength(0);
  });

  it("never blanks a tool row when the completed event reports an empty title", () => {
    // Completed MCP tool parts carry title: "" — the tool name must survive.
    const s = foldAll([
      { type: "tool.updated", sessionId: S, callId: "c1", tool: "jupyter_insert_cell", status: "running" },
      { type: "tool.updated", sessionId: S, callId: "c1", tool: "jupyter_insert_cell", status: "success", title: "" },
    ]);
    expect(s.blocks[0]).toMatchObject({
      kind: "tool-call",
      status: "success",
      title: "jupyter_insert_cell",
    });
  });

  it("shows the file path for a file tool that has no title yet", () => {
    // OpenCode only sets a write/edit tool's title on completion — while the
    // tool runs, the file path in its input is the only thing worth showing.
    const s = foldAll([
      { type: "tool.updated", sessionId: S, callId: "c1", tool: "write", status: "running", input: { filePath: "/Users/asq/Documents/OpenScience/2026-07-04/index.html", content: "<!doctype html>" } },
    ]);
    expect(s.blocks[0]).toMatchObject({
      kind: "tool-call",
      status: "running",
      title: "2026-07-04/index.html",
    });
  });

  it("surfaces a written file as an artifact block, deduped by path", () => {
    const s = foldAll([
      { type: "tool.updated", sessionId: S, callId: "c1", tool: "write", status: "running", input: { filePath: "fig.py" } },
      { type: "tool.updated", sessionId: S, callId: "c1", tool: "write", status: "success", input: { filePath: "fig.py", content: "print(1)" } },
    ]);
    const artifacts = s.blocks.filter((b) => b.kind === "artifact");
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ kind: "artifact", filename: "fig.py", artifact: "script", content: "print(1)" });
    // The tool-call row is still present alongside the artifact.
    expect(s.blocks.some((b) => b.kind === "tool-call")).toBe(true);
  });

  it("carries a running bash step's live output tail, \\r-folded; completion clears it", () => {
    const s1 = foldAll([
      { type: "tool.updated", sessionId: S, callId: "c1", tool: "bash", status: "running", input: { command: "python train.py" }, startedAt: 1000, partialOutput: "epoch 1:  10%\repoch 1:  50%\n" },
    ]);
    expect(s1.blocks[0]).toMatchObject({
      kind: "tool-call",
      title: "python train.py",
      verb: "Ran",
      status: "running",
      partialOutput: "epoch 1:  50%\n",
      startedAt: 1000,
    });
    const s2 = foldAll(
      [{ type: "tool.updated", sessionId: S, callId: "c1", tool: "bash", status: "success", input: { command: "python train.py" }, output: "epoch 1: 100%\ndone\n", endedAt: 5000 }],
      s1,
    );
    expect(s2.blocks[0]).toMatchObject({
      kind: "tool-call",
      status: "success",
      output: "epoch 1: 100%\ndone",
      // startedAt survives from the running event; the tail is gone.
      startedAt: 1000,
      endedAt: 5000,
    });
    expect(s2.blocks[0]).not.toHaveProperty("partialOutput");
  });

  it("keeps distinct parts as separate blocks in arrival order", () => {
    const s = foldAll([
      { type: "text.updated", sessionId: S, partId: "p1", text: "planning" },
      { type: "tool.updated", sessionId: S, callId: "c1", tool: "search", status: "success" },
      { type: "text.updated", sessionId: S, partId: "p2", text: "done" },
      { type: "session.idle", sessionId: S },
    ]);
    expect(s.blocks.map((b) => b.kind)).toEqual(["agent", "tool-call", "agent", "status-line"]);
  });

  it("deduplicates repeated session idle events", () => {
    const s = foldAll([
      { type: "text.updated", sessionId: S, partId: "p1", text: "done" },
      { type: "session.idle", sessionId: S },
      { type: "session.idle", sessionId: S },
    ]);
    expect(s.blocks.filter((b) => b.kind === "status-line" && b.tone === "done")).toHaveLength(1);
  });

  it("does not call a failed turn done", () => {
    // The store appends the red line outside this reducer (the error handler),
    // then the server's trailing session.idle arrives — which used to add a
    // cheerful "done" underneath, so a request that never ran read as having
    // succeeded (#114). Seed the failed state the same way the store leaves it.
    const failed: FoldState = {
      blocks: [{ kind: "status-line", text: "Invalid prompt", tone: "error" }],
      index: {},
    };
    const s = foldAll([{ type: "session.idle", sessionId: S }], failed);
    expect(s.blocks.some((b) => b.kind === "status-line" && b.tone === "done")).toBe(false);
    expect(s.blocks).toHaveLength(1);
  });
});

describe("message usage", () => {
  const usage = { input: 3_000, output: 900, reasoning: 0, cacheRead: 118_000, cacheWrite: 2_100, cost: 0.42 };

  it("stamps a turn's tokens onto the text it produced", () => {
    const s = foldAll([
      { type: "text.updated", sessionId: S, partId: "p1", text: "Done", messageID: "m1" },
      { type: "message.usage", sessionId: S, messageID: "m1", usage, created: 100, completed: 7_400 },
    ]);
    expect(s.blocks[0]).toMatchObject({ kind: "agent", usage, created: 100, completed: 7_400 });
  });

  it("stamps every block the same message produced — a tool call splits the answer", () => {
    const s = foldAll([
      { type: "text.updated", sessionId: S, partId: "p1", text: "Let me look", messageID: "m1" },
      { type: "tool.updated", sessionId: S, callId: "c1", tool: "read", status: "success" },
      { type: "text.updated", sessionId: S, partId: "p2", text: "Found it", messageID: "m1" },
      { type: "message.usage", sessionId: S, messageID: "m1", usage },
    ]);
    const agents = s.blocks.filter((b) => b.kind === "agent");
    expect(agents).toHaveLength(2);
    expect(agents.every((b) => b.kind === "agent" && b.usage === usage)).toBe(true);
  });

  it("leaves another message's blocks alone", () => {
    const s = foldAll([
      { type: "text.updated", sessionId: S, partId: "p1", text: "First", messageID: "m1" },
      { type: "text.updated", sessionId: S, partId: "p2", text: "Second", messageID: "m2" },
      { type: "message.usage", sessionId: S, messageID: "m2", usage },
    ]);
    expect(s.blocks[0]).not.toHaveProperty("usage");
    expect(s.blocks[1]).toMatchObject({ usage });
  });

  it("survives the text that keeps streaming after it", () => {
    // Usage and text arrive interleaved on separate events, and the text upsert
    // rebuilds the block — so a later token must not blank the numbers out.
    const s = foldAll([
      { type: "text.updated", sessionId: S, partId: "p1", text: "Wor", messageID: "m1" },
      { type: "message.usage", sessionId: S, messageID: "m1", usage },
      { type: "text.updated", sessionId: S, partId: "p1", text: "Working on it", messageID: "m1" },
    ]);
    expect(s.blocks[0]).toMatchObject({ kind: "agent", markdown: "Working on it", usage });
  });

  it("is a no-op when the message has produced no text yet", () => {
    // A turn that calls tools first reports tokens before any answer exists.
    const s = foldAll([{ type: "message.usage", sessionId: S, messageID: "m1", usage }]);
    expect(s.blocks).toHaveLength(0);
  });
});

describe("subagent activity", () => {
  it("records the child session id on a task tool block", () => {
    const s = foldAll([
      {
        type: "tool.updated",
        sessionId: S,
        callId: "c1",
        tool: "task",
        status: "running",
        title: "Visual QA for slides",
        childSessionId: "ses_child",
      },
    ]);
    expect(s.blocks[0]).toMatchObject({ kind: "tool-call", childSessionId: "ses_child" });
  });

  it("subagentActivity: shows the child's latest tool step", () => {
    const child = foldAll([
      { type: "tool.updated", sessionId: "ses_child", callId: "k1", tool: "bash", status: "success", title: "pdftoppm -jpeg slides.pdf" },
      { type: "tool.updated", sessionId: "ses_child", callId: "k2", tool: "bash", status: "running", title: "python3 analyze slide-03.jpg" },
    ]);
    expect(subagentActivity(child.blocks)).toBe("python3 analyze slide-03.jpg");
  });

  it("subagentActivity: 'Writing…' while the child is streaming text", () => {
    const child = foldAll([
      { type: "tool.updated", sessionId: "ses_child", callId: "k1", tool: "bash", status: "success", title: "ls" },
      { type: "text.updated", sessionId: "ses_child", partId: "p1", text: "Compiling the final report" },
    ]);
    expect(subagentActivity(child.blocks)).toBe("Writing…");
  });

  it("subagentActivity: 'Working…' when nothing is known yet", () => {
    expect(subagentActivity(undefined)).toBe("Working…");
    expect(subagentActivity([])).toBe("Working…");
  });

  it("keeps the child link when a later update omits it", () => {
    const s = foldAll([
      {
        type: "tool.updated",
        sessionId: S,
        callId: "c1",
        tool: "task",
        status: "running",
        title: "Visual QA for slides",
        childSessionId: "ses_child",
      },
      { type: "tool.updated", sessionId: S, callId: "c1", tool: "task", status: "running", title: "Visual QA for slides" },
    ]);
    expect(s.blocks[0]).toMatchObject({ kind: "tool-call", childSessionId: "ses_child" });
  });
});

describe("historyToThread", () => {
  it("converts user/assistant messages (text + tool parts) into blocks", () => {
    const msgs: HistoryMessage[] = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        parts: [
          { type: "text", text: "planning" },
          { type: "tool", tool: "search", state: { status: "completed", title: "search" } },
        ],
      },
    ];
    const t = historyToThread(msgs);
    expect(t.blocks.map((b) => b.kind)).toEqual(["user", "agent", "tool-call"]);
    expect(t.blocks[2]).toMatchObject({ kind: "tool-call", status: "success" });
  });

  it("reoffers the repair on reload, naming the part that makes the session unsendable", () => {
    // The damage is on disk, so reopening the session hits the same wall. Without
    // this the way out would exist only in the tab that was open when it first
    // failed — and the reporter of #114 had already closed that tab.
    const t = historyToThread([
      { role: "user", id: "m1", parts: [{ type: "text", text: "plot it" }] },
      {
        role: "assistant",
        id: "m2",
        error: "Invalid prompt: The messages do not match the ModelMessage[] schema.",
        parts: [{ type: "tool", tool: "bash", callID: "c1", state: { status: "completed" } }],
      },
    ]);
    expect(t.blocks.map((b) => b.kind)).toContain("history-repair");
    expect(t.blocks[t.blocks.length - 1]).toMatchObject({
      kind: "history-repair",
      reason: "tool-result-missing",
      tool: "bash",
      target: { messageID: "m1", text: "plot it" },
      drops: 2,
    });
  });

  it("offers the repair once, however many times the session retried into the wall", () => {
    // Once the history is malformed every later turn fails identically, so a
    // reopened session shows a run of the same error — the reporter of #114 had
    // three. The fix is the same for all of them; three identical cards would
    // read as three separate problems.
    const failed = "Invalid prompt: The messages do not match the ModelMessage[] schema.";
    const t = historyToThread([
      { role: "user", id: "u1", parts: [{ type: "text", text: "go" }] },
      { role: "assistant", id: "a1", parts: [{ type: "text" }] },
      { role: "user", id: "u2", parts: [{ type: "text", text: "again" }] },
      { role: "assistant", id: "a2", error: failed, parts: [{ type: "text", text: "" }] },
      { role: "user", id: "u3", parts: [{ type: "text", text: "hello?" }] },
      { role: "assistant", id: "a3", error: failed, parts: [{ type: "text", text: "" }] },
    ]);
    const kinds = t.blocks.map((b) => b.kind);
    expect(kinds.filter((k) => k === "history-repair")).toHaveLength(1);
    // …and it sits under the LAST failure, where the user is looking.
    expect(kinds[kinds.length - 1]).toBe("history-repair");
  });

  it("offers no repair for an ordinary failed turn — only this one is unretryable", () => {
    const t = historyToThread([
      { role: "user", id: "m1", parts: [{ type: "text", text: "plot it" }] },
      { role: "assistant", id: "m2", error: "Overloaded", parts: [{ type: "text", text: "" }] },
    ]);
    expect(t.blocks.map((b) => b.kind)).not.toContain("history-repair");
  });

  it("recovers a reloaded turn's tokens and timings, so reopening keeps the meta line", () => {
    const usage = { input: 3_000, output: 900, reasoning: 0, cacheRead: 118_000, cacheWrite: 2_100, cost: 0.42 };
    const t = historyToThread([
      {
        role: "assistant",
        id: "m1",
        created: 1_000,
        completed: 8_400,
        usage,
        parts: [{ type: "text", text: "done" }],
      },
    ]);
    expect(t.blocks[0]).toMatchObject({
      kind: "agent",
      messageID: "m1",
      created: 1_000,
      completed: 8_400,
      usage,
    });
  });

  it("dates a reloaded compaction by its message — the part carries no clock", () => {
    const t = historyToThread([
      { role: "assistant", created: 4_242, parts: [{ type: "compaction" }] },
    ]);
    expect(t.blocks[0]).toMatchObject({ kind: "compaction", auto: true, at: 4_242 });
  });

  // The shape OpenCode actually persists: SessionCompaction.create writes a
  // message with role "user" and hangs the compaction part off THAT. Reading
  // compaction parts only on assistant messages meant a reopened conversation
  // silently lost every marker — the turns vanish with nothing to say why.
  it("shows a compaction stored on its user-role marker message", () => {
    const t = historyToThread([
      { role: "user", parts: [{ type: "text", text: "analyze this" }] },
      { role: "user", created: 9_100, parts: [{ type: "compaction" }] },
      { role: "assistant", parts: [{ type: "text", text: "carrying on" }] },
    ]);
    expect(t.blocks.map((b) => b.kind)).toEqual(["user", "compaction", "agent"]);
    expect(t.blocks[1]).toMatchObject({ kind: "compaction", auto: true, at: 9_100 });
  });

  it("does not render the marker message as an empty user turn", () => {
    const t = historyToThread([{ role: "user", parts: [{ type: "compaction" }] }]);
    expect(t.blocks.filter((b) => b.kind === "user")).toHaveLength(0);
  });

  // Reported after a restart: `/goal read the docs…` showed correctly while
  // live, then reopened as the goal plugin's entire instruction block. The
  // collapse itself works — it just needs the command templates, and a cold
  // open could render history before the catalog arrived. This pins both the
  // collapse and what its absence looks like, so the ordering guarantee in
  // openSession/loadHistory has something to fail against.
  it("collapses a stored slash-command expansion back to what was typed", () => {
    const template =
      'OpenCode goal mode command "/goal" was invoked.\n\nArguments:\n' +
      "<goal_command_arguments>\n$ARGUMENTS\n</goal_command_arguments>\n\n" +
      "Use the goal tools to handle this command:\n- If the arguments are empty, call get_goal.";
    const expanded = template.replace("$ARGUMENTS", "read the docs, then build the repo");
    const msgs: HistoryMessage[] = [{ role: "user", parts: [{ type: "text", text: expanded }] }];

    const withCommands = historyToThread(msgs, [
      { name: "goal", description: "goal mode", template },
    ]);
    expect(withCommands.blocks[0]).toMatchObject({
      kind: "user",
      text: "/goal read the docs, then build the repo",
    });

    // Without the templates there is nothing to collapse against, and the raw
    // expansion is what the user sees — the bug as reported.
    const withoutCommands = historyToThread(msgs);
    expect(withoutCommands.blocks[0]).toMatchObject({ kind: "user", text: expanded });
  });

  // Every subagent in a reloaded conversation was unopenable: the live fold
  // keeps the spawned session id from the event, but rebuilding history dropped
  // it, so the panel had nothing to open.
  it("restores the subagent session a task spawned", () => {
    const msgs: HistoryMessage[] = [
      { role: "user", parts: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        parts: [
          {
            type: "tool",
            tool: "task",
            state: {
              status: "completed",
              title: "Explore data adapters",
              metadata: { sessionId: "ses_child_1" },
            },
          },
        ],
      },
    ];
    const t = historyToThread(msgs);
    expect(t.blocks[t.blocks.length - 1]).toMatchObject({
      kind: "tool-call",
      tool: "task",
      childSessionId: "ses_child_1",
    });
  });

  it("restores reasoning parts on reload as reasoning blocks, before the answer", () => {
    const msgs: HistoryMessage[] = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        parts: [
          { type: "reasoning", text: "Let me think about this" },
          { type: "text", text: "Here it is" },
        ],
      },
    ];
    const t = historyToThread(msgs);
    expect(t.blocks.map((b) => b.kind)).toEqual(["user", "reasoning", "agent"]);
    expect(t.blocks[1]).toEqual({ kind: "reasoning", text: "Let me think about this" });
  });

  it("renders a user-run '!' shell turn like the live path: '! cmd' + inline output", () => {
    // OpenCode records a "!" run as a synthetic user text + a bash tool part.
    const msgs: HistoryMessage[] = [
      {
        role: "user",
        parts: [{ type: "text", text: "The following tool was executed by the user", synthetic: true }],
      },
      {
        role: "assistant",
        parts: [
          {
            type: "tool",
            tool: "bash",
            state: { status: "completed", title: "", input: { command: "pwd" }, output: "/ws/here\n" },
          },
        ],
      },
    ];
    const t = historyToThread(msgs);
    expect(t.blocks).toEqual([
      { kind: "user", text: "! pwd" },
      {
        kind: "tool-call",
        title: "pwd",
        verb: "Ran",
        tool: "bash",
        command: "pwd",
        status: "success",
        output: "/ws/here",
        outputSummary: "/ws/here",
      },
    ]);
  });

  it("shows a failed turn's error on reload instead of an unexplained empty reply", () => {
    const msgs: HistoryMessage[] = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      { role: "assistant", completed: 2, error: "no channel available for this model", parts: [] },
    ];
    const t = historyToThread(msgs);
    expect(t.blocks).toEqual([
      { kind: "user", text: "hi" },
      { kind: "status-line", text: "no channel available for this model", tone: "error" },
    ]);
  });

  it("explains a reloaded failure too — a restart is when the user knows least", () => {
    const msgs: HistoryMessage[] = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        completed: 2,
        error: "Free usage exceeded, subscribe to Go",
        parts: [],
      },
    ];
    const line = historyToThread(msgs).blocks.slice(-1)[0];
    expect(line.kind === "status-line" && line.text).toMatch(/OpenCode Zen/);
  });

  it("keeps user-interrupted turns quiet: an aborted error adds no red line", () => {
    const msgs: HistoryMessage[] = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      { role: "assistant", completed: 2, error: "The operation was aborted.", parts: [] },
    ];
    expect(historyToThread(msgs).blocks).toEqual([{ kind: "user", text: "hi" }]);
  });

  it("falls back to the bash command as the row title (agent steps too)", () => {
    const msgs: HistoryMessage[] = [
      {
        role: "assistant",
        parts: [
          { type: "tool", tool: "bash", state: { status: "completed", title: "", input: { command: "ls -la" } } },
        ],
      },
    ];
    const t = historyToThread(msgs);
    expect(t.blocks[0]).toMatchObject({ kind: "tool-call", title: "ls -la" });
    // An agent bash step (no synthetic marker) never shows inline output.
    expect(t.blocks[0]).not.toHaveProperty("outputSummary");
  });

  it("never spins in history: frozen running/pending steps become quiet + one interrupted line", () => {
    const msgs: HistoryMessage[] = [
      { role: "user", parts: [{ type: "text", text: "explore" }] },
      {
        role: "assistant",
        parts: [
          { type: "tool", tool: "read", state: { status: "running", title: "README.md" } },
          { type: "tool", tool: "glob", state: { status: "pending", title: "*.md" } },
        ],
      },
    ];
    const t = historyToThread(msgs);
    expect(t.blocks[1]).toMatchObject({ kind: "tool-call", status: "pending" });
    expect(t.blocks[2]).toMatchObject({ kind: "tool-call", status: "pending" });
    const last = t.blocks[t.blocks.length - 1];
    expect(last).toMatchObject({ kind: "status-line", tone: "error" });
  });

  it("shows a slash command as what the user typed, not its expanded template", () => {
    // OpenCode stores the EXPANDED command/skill template as the user message,
    // with typed arguments appended — reverse-map via the known templates.
    const template = "\nThis skill guides growth for indie AI products…\n\n## Core Philosophy\n…";
    const msgs: HistoryMessage[] = [
      { role: "user", parts: [{ type: "text", text: template.trim() }] },
      { role: "assistant", parts: [{ type: "text", text: "on it" }] },
      { role: "user", parts: [{ type: "text", text: `${template.trim()}\n\n帮我设计增长方式` }] },
    ];
    const t = historyToThread(msgs, [
      { name: "growth-marketing", source: "skill", template },
    ]);
    expect(t.blocks[0]).toEqual({ kind: "user", text: "/growth-marketing" });
    expect(t.blocks[2]).toEqual({ kind: "user", text: "/growth-marketing 帮我设计增长方式" });
  });

  it("collapses a template whose $ARGUMENTS placeholder sits mid-template (goal plugin)", () => {
    // The goal plugin's command embeds the args INSIDE the template, with a
    // long instruction block after them — prefix/suffix matching around
    // $ARGUMENTS must recover the typed "/goal <args>".
    const template =
      'OpenCode goal mode command "/goal" was invoked.\n\nArguments:\n<goal_command_arguments>\n$ARGUMENTS\n</goal_command_arguments>\n\nUse the goal tools to handle this command:\n- If the arguments are empty, call get_goal…';
    const expanded = template.replace("$ARGUMENTS", "梳理项目，做一个详细剧情docx。");
    const msgs: HistoryMessage[] = [
      { role: "user", parts: [{ type: "text", text: expanded }] },
    ];
    const t = historyToThread(msgs, [{ name: "goal", source: "command", template }]);
    expect(t.blocks[0]).toEqual({ kind: "user", text: "/goal 梳理项目，做一个详细剧情docx。" });
  });

  it("leaves a long pasted user text alone when it matches no template", () => {
    const msgs: HistoryMessage[] = [
      { role: "user", parts: [{ type: "text", text: "a genuinely long pasted question…" }] },
    ];
    const t = historyToThread(msgs, [{ name: "init", template: "something else" }]);
    expect(t.blocks[0]).toEqual({ kind: "user", text: "a genuinely long pasted question…" });
  });

  it("adds no interrupted line when every step finished", () => {
    const msgs: HistoryMessage[] = [
      {
        role: "assistant",
        parts: [{ type: "tool", tool: "read", state: { status: "completed", title: "README.md" } }],
      },
    ];
    const t = historyToThread(msgs);
    expect(t.blocks.every((b) => b.kind !== "status-line")).toBe(true);
  });

  // #72: the auto-review turn is the app's, not the user's. On reload it must
  // not appear as something the user typed — only the findings it produced.
  it("hides the auto-review prompt but keeps the reviewer's findings", () => {
    const msgs: HistoryMessage[] = [
      { role: "user", parts: [{ type: "text", text: "run the analysis" }] },
      { role: "assistant", parts: [{ type: "text", text: "done" }] },
      { role: "user", agent: "reviewer", parts: [{ type: "text", text: AUTO_REVIEW_PROMPT }] },
      {
        role: "assistant",
        parts: [
          {
            type: "text",
            text:
              'Reviewed the changed files.\n\n```review\n{"findings":[{"level":"warn","title":"seed not pinned"}]}\n```',
          },
        ],
      },
    ];
    const t = historyToThread(msgs);
    expect(t.blocks.map((b) => b.kind)).toEqual(["user", "agent", "agent", "reviewer"]);
    expect(t.blocks[0]).toMatchObject({ text: "run the analysis" });
    expect(t.blocks[3]).toMatchObject({
      kind: "reviewer",
      findings: [{ level: "warn", title: "seed not pinned" }],
    });
  });

  // Goal mode drives itself by writing user turns into the session. Those are
  // machine prompts (continuation policy wrapped around the objective) and were
  // shown verbatim as if the user had typed them.
  it("hides the goal plugin's auto-continue and the app's resume nudge", () => {
    const msgs: HistoryMessage[] = [
      { role: "user", parts: [{ type: "text", text: "train the model" }] },
      { role: "assistant", parts: [{ type: "text", text: "started" }] },
      {
        role: "user",
        parts: [
          {
            type: "text",
            text:
              "Continue working toward the active session goal.\n\n" +
              "<untrusted_objective>\ntrain the model\n</untrusted_objective>\n\n" +
              "Continuation behavior:\n- This goal persists across turns.",
          },
        ],
      },
      { role: "assistant", parts: [{ type: "text", text: "continued" }] },
      { role: "user", parts: [{ type: "text", text: GOAL_RESUME_NUDGE }] },
      { role: "assistant", parts: [{ type: "text", text: "resumed" }] },
    ];
    const t = historyToThread(msgs);
    expect(t.blocks.map((b) => b.kind)).toEqual(["user", "agent", "agent", "agent"]);
    expect(t.blocks[0]).toMatchObject({ text: "train the model" });
  });
});

describe("lastAgentMode", () => {
  it("reads the last user message's mode", () => {
    expect(lastAgentMode([{ role: "user", agent: "plan", parts: [] }])).toBe("plan");
    expect(lastAgentMode([{ role: "user", agent: "build", parts: [] }])).toBe("build");
    expect(lastAgentMode([])).toBe("build");
  });

  // An auto-review turn runs on `reviewer`; reading that as Build would drop a
  // session out of Plan mode on reload.
  it("ignores turns that ran on another agent", () => {
    expect(
      lastAgentMode([
        { role: "user", agent: "plan", parts: [] },
        { role: "user", agent: "reviewer", parts: [] },
      ]),
    ).toBe("plan");
  });
});

describe("runtime error explanations", () => {
  it("tells the user why retrying a blocked prompt cannot work", () => {
    // Reproduced from a real report: ChatGPT-Pro (Codex OAuth) answered
    // POST /v1/responses with 400 {"code":"invalid_prompt","message":"Request
    // blocked."}, isRetryable false. "Continue" failed identically three times
    // because the Responses API resends the whole conversation, and only
    // switching provider recovered — none of which the bare message conveys.
    const out = explainRuntimeError("Request blocked.");
    expect(out).toContain("Request blocked."); // the provider's own words survive
    expect(out).toMatch(/content filter/i);
    expect(out).toMatch(/every retry resends the same history/i);
    expect(out).toMatch(/new session|another model/i);
  });

  it("explains why a malformed session history cannot be retried", () => {
    const out = explainRuntimeError(
      "Invalid prompt: The messages do not match the ModelMessage[] schema.",
    );
    expect(out).toContain("ModelMessage[] schema"); // the SDK's own words survive
    expect(out).toMatch(/every retry resends/i);
    expect(out).toMatch(/retrying cannot work/i);
  });

  it("does not blame a cause it cannot know for a malformed history", () => {
    // This line used to assert the damage was "a tool call left without its
    // result". That was wrong — the runtime backfills an interrupted tool call
    // with a synthetic result, and sessions carrying one keep working for
    // hundreds of messages — and we published it on #114. The thread names the
    // real part from the stored history instead; the error text guesses at
    // nothing, or it sends people to delete history that was fine.
    const out = explainRuntimeError(
      "Invalid prompt: The messages do not match the ModelMessage[] schema.",
    );
    expect(out).not.toMatch(/tool call left without/i);
  });

  it("names the provider behind a spent free allowance, from the runtime's own action", () => {
    // #117: the final error text names no provider, so the cause has to come
    // from the action the retry status carried. The reporter filed this as the
    // app's own quota being used up.
    const out = explainRuntimeError("Free usage exceeded", {
      reason: "free_tier_limit",
      provider: "opencode",
    });
    expect(out).toContain("Free usage exceeded"); // upstream's words survive
    expect(out).toMatch(/OpenCode Zen/);
    expect(out).toMatch(/not a quota in this app/i);
    expect(out).toContain("Settings → Models");
  });

  it("does not claim Zen for another provider's spent allowance", () => {
    const out = explainRuntimeError("Free usage exceeded", {
      reason: "free_tier_limit",
      provider: "some-gateway",
    });
    expect(out).toContain("some-gateway");
    expect(out).not.toMatch(/Zen/);
  });

  it("reads Zen's own free-tier constant with no action to go by", () => {
    // A reloaded history has no action — but this whole sentence is a constant
    // of the runtime's (GO_UPSELL_MESSAGE), so it is proof of the provider.
    expect(explainRuntimeError("Free usage exceeded, subscribe to Go")).toMatch(/OpenCode Zen/);
    // The prefix alone is not proof, and inventing a provider would be a lie.
    expect(explainRuntimeError("Free usage exceeded on this endpoint")).toBe(
      "Free usage exceeded on this endpoint",
    );
  });

  it("offers a way out of a plan limit instead of only its reset time", () => {
    const out = explainRuntimeError(
      "Weekly usage limit reached. It will reset in 3 days 2 hours - https://opencode.ai/workspace/w/go",
    );
    expect(out).toContain("Settings → Models");
    expect(
      explainRuntimeError("Overloaded", { reason: "account_rate_limit" }),
    ).toContain("Settings → Models");
  });

  it("separates a request that never reached the provider from a provider error", () => {
    const out = explainRuntimeError(
      "Cannot connect to API: The socket connection was closed unexpectedly",
    );
    expect(out).toMatch(/did not reach the provider/i);
    expect(out).toMatch(/VPN or proxy/i);
    // Not a blanket match on the word "connect".
    const other = "The provider could not connect to its own upstream";
    expect(explainRuntimeError(other)).toBe(other);
  });

  it("keeps the dangling-model hint and passes anything else through", () => {
    expect(explainRuntimeError("model not found: openai/gone")).toContain(
      "Settings → Models",
    );
    // Not a blanket match: an error that merely mentions blocking is untouched.
    const other = "Upstream blocked the connection at the proxy";
    expect(explainRuntimeError(other)).toBe(other);
  });
});

/** Mirrors LOG_ERROR_MAX in runtime.ts — the cap is internal, the shape is not. */
const LOG_ERROR_CAP = 300;

describe("redactForLog", () => {
  it("strips credentials a provider echoed back", () => {
    expect(redactForLog("bad key sk-abcdef123456 rejected")).not.toContain("abcdef123456");
    expect(redactForLog("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6")).not.toContain("eyJhbGci");
    // Any long opaque run is treated as a secret, whatever its prefix.
    expect(redactForLog(`token ${"a1B2".repeat(12)} invalid`)).toContain("***");
  });

  it("leaves an ordinary message intact but caps a huge one", () => {
    expect(redactForLog("Request blocked.")).toBe("Request blocked.");
    // Prose, not one opaque run — a long run is redacted to "***" long before
    // the cap could apply, so the cap is only reachable with real sentences.
    const long = redactForLog("the upstream provider refused this call. ".repeat(40));
    expect(long.length).toBeLessThanOrEqual(LOG_ERROR_CAP + 1);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("turnStillStreaming", () => {
  // Reproduced from a real install: the app was quit mid-turn, so the runtime
  // died with the request in flight. What it left behind — assistant role, no
  // `completed`, no `error` — is byte-for-byte what a turn streaming RIGHT NOW
  // looks like, so every later load read it as live. That session sat on
  // "Working…" for ten hours: no error to retry, no process to finish it, and
  // no way for the user to tell. Liveness has to come from something that dies
  // with the process.
  const RUNTIME_START = 2_000;
  const unfinished = (created: number) => [
    { role: "user" as const, parts: [], completed: created - 1 },
    { role: "assistant" as const, parts: [], created },
  ];

  it("treats an unfinished turn from a dead runtime as over", () => {
    expect(turnStillStreaming(unfinished(1_000), RUNTIME_START)).toBe(false);
  });

  it("still reads a turn this runtime is producing as live", () => {
    expect(turnStillStreaming(unfinished(3_000), RUNTIME_START)).toBe(true);
  });

  it("keeps the old behaviour when the runtime start is unknown", () => {
    // Web/gateway clients have no local sidecar to compare against; there the
    // stored shape is all we have, and calling a live turn dead would be worse.
    expect(turnStillStreaming(unfinished(1_000))).toBe(true);
  });

  it("is unmoved by a finished or failed turn", () => {
    const done = [{ role: "assistant" as const, parts: [], created: 3_000, completed: 3_100 }];
    const failed = [{ role: "assistant" as const, parts: [], created: 3_000, error: "boom" }];
    expect(turnStillStreaming(done, RUNTIME_START)).toBe(false);
    expect(turnStillStreaming(failed, RUNTIME_START)).toBe(false);
  });
});
