import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ThreadBlock, ToolCallBlock } from "@ai4s/shared";
import { ToolGroup, groupToolBlocks, summarizeGroup } from "./ToolGroup";

const tool = (over: Partial<ToolCallBlock>): ToolCallBlock => ({
  kind: "tool-call",
  title: "pwd",
  status: "success",
  tool: "bash",
  verb: "Ran",
  ...over,
});

describe("groupToolBlocks", () => {
  it("folds consecutive quiet tool calls into one group; text breaks the run", () => {
    const blocks: ThreadBlock[] = [
      tool({ title: "a" }),
      tool({ title: "b" }),
      { kind: "agent", markdown: "thinking" },
      tool({ title: "c" }),
    ];
    const items = groupToolBlocks(blocks);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ kind: "group", start: 0 });
    expect((items[0] as { blocks: ToolCallBlock[] }).blocks.map((b) => b.title)).toEqual(["a", "b"]);
    expect(items[1]).toMatchObject({ kind: "block", index: 2 });
    expect(items[2]).toMatchObject({ kind: "group", start: 3 });
  });

  it("folds reasoning into the adjacent tool run so consecutive tools still merge", () => {
    const items = groupToolBlocks([
      { kind: "reasoning", text: "let me look at the data" },
      tool({ title: "a" }),
      { kind: "reasoning", text: "now transform it" },
      tool({ title: "b" }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "group", start: 0 });
    expect((items[0] as { blocks: ThreadBlock[] }).blocks).toHaveLength(4);
  });

  it("renders reasoning that precedes the final answer on its own (nothing to group)", () => {
    const items = groupToolBlocks([
      { kind: "reasoning", text: "concluding" },
      { kind: "agent", markdown: "the answer" },
    ]);
    expect(items.map((i) => i.kind)).toEqual(["block", "block"]);
    expect(items[0]).toMatchObject({ kind: "block", index: 0 });
  });

  it("failures stay in the group (routine agent trial-and-error, counted in the summary)", () => {
    const items = groupToolBlocks([
      tool({ title: "a" }),
      tool({ title: "boom", status: "failed" }),
      tool({ title: "b" }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "group", start: 0 });
  });

  it("only a step waiting for the user breaks out of the group", () => {
    const items = groupToolBlocks([
      tool({ title: "a" }),
      tool({ title: "rm -rf build", status: "waiting-approval" }),
      tool({ title: "b" }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["group", "block", "group"]);
  });

  it("shows a failure count on the collapsed summary", () => {
    render(
      <ToolGroup
        blocks={[tool({}), tool({ status: "failed", output: "404 not found" })]}
      />,
    );
    expect(screen.getByText(/2 commands/)).toBeInTheDocument();
    expect(screen.getByText(/1 failed/)).toBeInTheDocument();
  });
});

describe("summarizeGroup", () => {
  it("counts per verb in first-seen order, capitalized", () => {
    expect(
      summarizeGroup([
        tool({}),
        tool({}),
        tool({ verb: "Created", tool: "write" }),
        tool({}),
      ]),
    ).toBe("Ran 3 commands, created a file");
  });
});

describe("ToolGroup", () => {
  it("collapses a settled group to its summary; expands on click", () => {
    render(<ToolGroup blocks={[tool({ title: "pwd" }), tool({ title: "ls" })]} />);
    const summary = screen.getByRole("button", { name: /Ran 2 commands/ });
    expect(summary).toBeInTheDocument();
    fireEvent.click(summary);
    expect(screen.getByText("pwd")).toBeInTheDocument();
    expect(screen.getByText("ls")).toBeInTheDocument();
  });

  it("stays open while a step runs and shows its live output tail", () => {
    render(
      <ToolGroup
        blocks={[
          tool({ title: "ls" }),
          tool({
            title: "python train.py",
            status: "running",
            partialOutput: "epoch 1/2\nloss=0.51",
            startedAt: Date.now() - 5000,
          }),
        ]}
      />,
    );
    // No click: the running group is auto-expanded with the tail visible.
    expect(screen.getByText("python train.py")).toBeInTheDocument();
    expect(screen.getByText(/loss=0\.51/)).toBeInTheDocument();
  });

  it("a single quiet step renders as a plain row, no group chrome", () => {
    render(<ToolGroup blocks={[tool({ title: "pwd" })]} />);
    expect(screen.getByText("pwd")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /command/ })).not.toBeInTheDocument();
  });

  it("expanding a bash row reveals the full command and output", () => {
    render(
      <ToolGroup
        blocks={[
          tool({
            title: "python train.py",
            command: "cd deep/path && python train.py",
            output: "done ok",
          }),
        ]}
      />,
    );
    const row = screen.getByRole("button");
    fireEvent.click(row);
    expect(screen.getByText(/cd deep\/path && python train\.py/)).toBeInTheDocument();
    expect(screen.getByText("done ok")).toBeInTheDocument();
  });

  it("renders an edit step's diff with add/del lines", () => {
    render(
      <ToolGroup
        blocks={[
          tool({
            tool: "edit",
            verb: "Edited",
            title: "config.yaml",
            diff: "- device: cpu\n+ device: mps",
          }),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("- device: cpu")).toBeInTheDocument();
    expect(screen.getByText("+ device: mps")).toBeInTheDocument();
  });

  it("says on the row itself why a step failed", () => {
    render(
      <ToolGroup
        blocks={[
          tool({
            tool: "write",
            verb: "Created",
            title: "index.html",
            status: "failed",
            output: 'Error: cannot overwrite "index.html" without reading it first\n  at write',
          }),
        ]}
      />,
    );
    expect(
      screen.getByText('Error: cannot overwrite "index.html" without reading it first'),
    ).toBeInTheDocument();
  });

  // The dot is sized in px, which an inline box ignores: the running row —
  // the only one whose mark is not an svg — measured 0×0 and showed nothing.
  // jsdom has no layout, so the class that fixes it is what can be asserted.
  it("gives the running row a status mark with a box of its own", () => {
    render(<ToolGroup blocks={[tool({ title: "python train.py", status: "running" })]} />);
    const mark = screen.getByRole("img", { name: /running/i }).firstElementChild;
    expect(mark?.className).toContain("inline-block");
  });

  it("a running subagent's row opens the panel instead of doing nothing", () => {
    const onOpenSubagent = vi.fn();
    render(
      <ToolGroup
        blocks={[
          tool({
            tool: "task",
            verb: undefined,
            title: "Review the statistics",
            status: "running",
            childSessionId: "child-1",
            startedAt: Date.now() - 5000,
          }),
        ]}
        onOpenSubagent={onOpenSubagent}
      />,
    );
    fireEvent.click(screen.getByText("Review the statistics"));
    expect(onOpenSubagent).toHaveBeenCalledWith("child-1");
  });

  it("leaves a finished subagent's row expanding in place", () => {
    const onOpenSubagent = vi.fn();
    render(
      <ToolGroup
        blocks={[
          tool({
            tool: "task",
            verb: undefined,
            title: "Review the statistics",
            status: "success",
            childSessionId: "child-1",
            output: "found three outliers",
          }),
        ]}
        onOpenSubagent={onOpenSubagent}
      />,
    );
    fireEvent.click(screen.getByText("Review the statistics"));
    expect(onOpenSubagent).not.toHaveBeenCalled();
    expect(screen.getByText("found three outliers")).toBeInTheDocument();
  });
});
