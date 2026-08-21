import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

afterEach(() => {
  // Unmount BEFORE clearing the store: a still-mounted row subscribes to its
  // child thread, and wiping it underneath produced an act() warning.
  cleanup();
  act(() => useRuntimeStore.setState({ threads: {} }));
});

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

  // The panel used to stop at "which subagent, on what, for how long" — the one
  // thing you could not see was what the subagent actually DID.
  it("opens a subagent into its own transcript, and only on request", async () => {
    seed({
      parent: [
        {
          kind: "tool-call",
          tool: "task",
          title: "Review the statistics",
          status: "success",
          childSessionId: "child-1",
          startedAt: 1000,
          endedAt: 5000,
        },
      ],
      "child-1": [
        // The opening block is the brief the parent handed the subagent, not
        // the user speaking — it must not render as a chat bubble.
        { kind: "user", text: "Check the residuals and report blocking issues." },
        { kind: "tool-call", tool: "bash", title: "python3 check.py", status: "success" },
        { kind: "agent", markdown: "The residuals look fine." },
      ],
    });
    render(<SubagentPane sessionId="parent" onClose={vi.fn()} />);

    // Collapsed by default: a tool-heavy child thread is exactly the cost that
    // must not be paid for every subagent at once (#92).
    // The whole row is the target — aiming at the words alone was a miss most
    // people made, and it read as the row simply not responding.
    const row = screen.getByRole("button", { name: /Review the statistics/ });
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("The residuals look fine.")).not.toBeInTheDocument();

    await userEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("The residuals look fine.")).toBeInTheDocument();
    expect(screen.getByText("python3 check.py")).toBeInTheDocument();
    // The brief is shown, flat — not as the right-aligned user bubble the main
    // conversation uses, which in a narrow panel read as a ragged indent.
    const brief = screen.getByText(/Check the residuals/);
    expect(brief.tagName).toBe("P");
    expect(brief.className).not.toContain("rounded-card");

    await userEvent.click(row);
    expect(screen.queryByText("The residuals look fine.")).not.toBeInTheDocument();
  });

  it("says so instead of spinning forever when a subagent recorded nothing", async () => {
    seed({
      parent: [
        {
          kind: "tool-call",
          tool: "task",
          title: "Recorded nothing",
          status: "success",
          childSessionId: "child-empty",
        },
      ],
      "child-empty": [],
    });
    render(<SubagentPane sessionId="parent" onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Recorded nothing/ }));
    expect(screen.getByText("No steps were recorded for this subagent.")).toBeInTheDocument();
  });

  it("keeps a subagent that never started as a plain, unopenable row", () => {
    seed({
      parent: [{ kind: "tool-call", tool: "task", title: "Never ran", status: "pending" }],
    });
    render(<SubagentPane sessionId="parent" onClose={vi.fn()} />);

    expect(screen.getByText("Never ran")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Never ran/ })).not.toBeInTheDocument();
  });

  // Clicking a running task row in the transcript opens this panel; landing on
  // a list of collapsed rows would make the reader hunt for the one they asked
  // for, so the asked-for subagent arrives already open.
  it("opens the subagent the transcript asked for, and re-opens it after a collapse", async () => {
    seed({
      parent: [
        {
          kind: "tool-call",
          tool: "task",
          title: "Review the statistics",
          status: "running",
          childSessionId: "child-1",
          startedAt: 1000,
        },
        {
          kind: "tool-call",
          tool: "task",
          title: "Search the literature",
          status: "running",
          childSessionId: "child-2",
          startedAt: 1000,
        },
      ],
      "child-1": [{ kind: "agent", markdown: "Three outliers in run 4." }],
      "child-2": [{ kind: "agent", markdown: "Nine papers since 2024." }],
    });
    const focus = { childSessionId: "child-2", nonce: 1 };
    const { rerender } = render(
      <SubagentPane sessionId="parent" onClose={vi.fn()} focus={focus} />,
    );

    // Only the asked-for one; the other subagent stays collapsed and unfetched.
    expect(screen.getByText("Nine papers since 2024.")).toBeInTheDocument();
    expect(screen.queryByText("Three outliers in run 4.")).not.toBeInTheDocument();

    // Collapsed by hand, then asked for again: the second ask must land, which
    // is what the counter on the focus is for.
    await userEvent.click(screen.getByRole("button", { name: /Search the literature/ }));
    expect(screen.queryByText("Nine papers since 2024.")).not.toBeInTheDocument();
    rerender(
      <SubagentPane
        sessionId="parent"
        onClose={vi.fn()}
        focus={{ childSessionId: "child-2", nonce: 2 }}
      />,
    );
    expect(screen.getByText("Nine papers since 2024.")).toBeInTheDocument();
  });

  it("says so plainly when the conversation has spawned none", () => {
    seed({ parent: [{ kind: "agent", markdown: "hello" }] });
    render(<SubagentPane sessionId="parent" onClose={vi.fn()} />);

    expect(screen.getByText("No subagents in this conversation yet.")).toBeInTheDocument();
  });
});
