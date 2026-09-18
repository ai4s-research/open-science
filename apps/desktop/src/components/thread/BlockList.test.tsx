import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadBlock } from "@ai4s/shared";
import { BlockList } from "./BlockList";
import { useRuntimeStore } from "@/lib/runtime";

// A running task row surfaces its subagent's latest step. The activity is no
// longer threaded through props — the row self-subscribes to the child thread in
// the store (SubagentActivity), so these tests seed that thread directly (#34).
describe("BlockList", () => {
  afterEach(() => {
    useRuntimeStore.setState({ threads: {} });
  });

  it("shows a running task row the live activity of its subagent", () => {
    useRuntimeStore.setState({
      threads: {
        ses_child: {
          blocks: [{ kind: "tool-call", title: "python3 analyze slide-03.jpg", status: "running" }],
          index: {},
          loaded: true,
        },
      },
    });
    render(
      <BlockList
        blocks={[
          { kind: "tool-call", title: "Visual QA for slides", status: "running", childSessionId: "ses_child" },
        ]}
      />,
    );
    expect(screen.getByText("python3 analyze slide-03.jpg")).toBeInTheDocument();
  });

  it("renders a row that spawned no subagent without any activity line", () => {
    render(<BlockList blocks={[{ kind: "tool-call", title: "ls -la", status: "running" }]} />);
    expect(screen.getByText("ls -la")).toBeInTheDocument();
    expect(document.querySelector("[data-subagent-activity]")).toBeNull();
  });

  it("offers a Retry action on a failed history-load line in the live session", async () => {
    const onRetryHistory = vi.fn();
    render(
      <BlockList
        blocks={[
          {
            kind: "status-line",
            text: "Failed to load messages: Load failed",
            tone: "error",
            retry: true,
          },
        ]}
        handlers={{ onRetryHistory }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetryHistory).toHaveBeenCalledTimes(1);
  });

  it("renders the failed history-load line without a Retry action outside the live session", () => {
    render(
      <BlockList
        blocks={[
          {
            kind: "status-line",
            text: "Failed to load messages: Load failed",
            tone: "error",
            retry: true,
          },
        ]}
      />,
    );
    expect(screen.getByText(/Failed to load messages/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("BlockList · thinking never enters the conversation", () => {
  it("renders no reasoning at all — it belongs on the status row, live", async () => {
    // It was indistinguishable from what the model actually SAID (both plain
    // black paragraphs) and, on a model that thinks a lot, was the bulk of
    // every fold — so the answer sat buried in the deliberation behind it.
    const blocks = [
      { kind: "user", text: "go" },
      { kind: "reasoning", text: "Let me look at the workspace" },
      { kind: "tool-call", title: "ls -la", status: "success", verb: "Ran" },
      { kind: "agent", markdown: "Done." },
    ] as ThreadBlock[];
    const { container } = render(<BlockList blocks={blocks} />);
    expect(container.textContent).not.toContain("Let me look at the workspace");
    // And it leaves no empty fold or blank segment behind it.
    expect(await screen.findByText("Done.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Worked/ })).toBeInTheDocument();
  });

  it("does not make a fold out of a turn whose only work was thinking", () => {
    // Nothing visible happened, so there is nothing to hide.
    const blocks = [
      { kind: "user", text: "go" },
      { kind: "reasoning", text: "thinking about it" },
      { kind: "agent", markdown: "Done." },
    ] as ThreadBlock[];
    render(<BlockList blocks={blocks} />);
    expect(screen.queryByRole("button", { name: /Worked/ })).not.toBeInTheDocument();
  });
});

describe("BlockList · a finished turn folds its work", () => {
  const done: ThreadBlock[] = [
    { kind: "user", text: "run the analysis" },
    // Mid-turn narration: the model saying what it is about to do. It folds,
    // because only the LAST agent message of a turn is the answer.
    { kind: "agent", markdown: "I will simulate the dataset first" },
    { kind: "tool-call", title: "python3 run.py", status: "success", verb: "Ran", startedAt: 1000, endedAt: 3000 },
    { kind: "agent", markdown: "Done. IC50 = 31.8 nM.", created: 3000, completed: 4000 },
  ];

  it("shows the ask and the answer, and hides the work behind one line", async () => {
    render(<BlockList blocks={done} />);
    expect(screen.getByText(/run the analysis/)).toBeInTheDocument();
    expect(screen.getByText(/IC50 = 31.8 nM/)).toBeInTheDocument();
    // The narration and the commands are behind the fold.
    expect(screen.queryByText(/simulate the dataset/)).not.toBeInTheDocument();
    expect(screen.queryByText("python3 run.py")).not.toBeInTheDocument();
    // The line reports the span of the work it hides — not the whole turn,
    // since the answer's own generation is not part of what folded.
    expect(await screen.findByRole("button", { name: /Worked for 2s/ })).toBeInTheDocument();
  });

  it("brings the work back on a click", async () => {
    render(<BlockList blocks={done} />);
    await userEvent.click(screen.getByRole("button", { name: /Worked for 2s/ }));
    expect(screen.getByText(/simulate the dataset/)).toBeInTheDocument();
  });

  it("folds nothing while the turn is still running", () => {
    // No answer yet, so there is no finished work to hide — the activity line
    // is the only sign of progress there is.
    const running: ThreadBlock[] = [
      { kind: "user", text: "run the analysis" },
      { kind: "tool-call", title: "python3 run.py", status: "running", verb: "Ran" },
    ];
    render(<BlockList blocks={running} />);
    expect(screen.getByText("python3 run.py")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Worked/ })).not.toBeInTheDocument();
  });
});
