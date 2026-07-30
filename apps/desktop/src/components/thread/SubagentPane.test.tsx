import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadBlock } from "@ai4s/shared";
import { useRuntimeStore } from "@/lib/runtime";
import { SubagentPane } from "./SubagentPane";

function seed(blocks: Record<string, ThreadBlock[]>) {
  useRuntimeStore.setState({
    threads: Object.fromEntries(
      Object.entries(blocks).map(([id, b]) => [id, { blocks: b, index: {}, loaded: true }]),
    ),
  });
}

afterEach(() => useRuntimeStore.setState({ threads: {} }));

describe("SubagentPane", () => {
  it("lists every subagent with its task and status, running and finished alike", () => {
    seed({
      parent: [
        {
          kind: "tool-call",
          tool: "task",
          title: "Review the statistics",
          status: "running",
          childSessionId: "child-1",
          startedAt: Date.now() - 90_000,
        },
        {
          kind: "tool-call",
          tool: "task",
          title: "Search the literature",
          status: "success",
          childSessionId: "child-2",
          startedAt: 1000,
          endedAt: 13_000,
        },
        // Ordinary tool steps are not subagents and stay out of the panel.
        { kind: "tool-call", tool: "bash", title: "ls", status: "success" },
      ],
      "child-1": [{ kind: "tool-call", tool: "read", title: "reading results.csv", status: "running" }],
    });

    render(<SubagentPane sessionId="parent" onClose={vi.fn()} />);

    expect(screen.getByText("Review the statistics")).toBeInTheDocument();
    expect(screen.getByText("Search the literature")).toBeInTheDocument();
    expect(screen.queryByText("ls")).not.toBeInTheDocument();
    expect(screen.getByText("2 tasks")).toBeInTheDocument();

    // A finished subagent keeps its elapsed time; the running one shows its step.
    expect(screen.getByText("12s")).toBeInTheDocument();
    expect(screen.getByText("reading results.csv")).toBeInTheDocument();
  });

  it("says so plainly when the conversation has spawned none", () => {
    seed({ parent: [{ kind: "agent", markdown: "hello" }] });
    render(<SubagentPane sessionId="parent" onClose={vi.fn()} />);

    expect(screen.getByText("No subagents in this conversation yet.")).toBeInTheDocument();
  });
});
