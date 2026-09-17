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

describe("BlockList · shaping the list does not lose the streaming thought", () => {
  it("resolves the streaming thought by identity, not by a stale index", async () => {
    // The trap: dropping a turn's scratch files shifts every index after them,
    // so the caller's index would land on a different block — silently, since a
    // wrong index is still a valid one. `blocks[2]` is the reasoning; once the
    // file is dropped it sits at 1.
    const blocks = [
      { kind: "artifact", path: "run.py", filename: "run.py", artifact: "script", tool: "write" },
      { kind: "tool-call", title: "python3 run.py", status: "success", verb: "Ran" },
      { kind: "reasoning", text: "Now I check the output" },
    ] as never;
    const { container } = render(<BlockList blocks={blocks} liveReasoningIndex={2} />);
    const paragraph = await screen.findByText(/Now I check the output/);
    // The caret marks the thought being written, and it must be on THAT one.
    expect(paragraph.querySelector("span[aria-hidden]")).toBeTruthy();
    // The turn never answered, so nothing folded and the work is on screen.
    expect(container.textContent).toContain("Now I check the output");
  });
});

describe("BlockList · a finished turn folds its work", () => {
  const done: ThreadBlock[] = [
    { kind: "user", text: "run the analysis" },
    { kind: "reasoning", text: "I will simulate the dataset first" },
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
    // No answer yet — the narration and the live activity line are the only
    // sign of progress there is.
    render(<BlockList blocks={done.slice(0, 3)} />);
    expect(screen.getByText(/simulate the dataset/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Worked/ })).not.toBeInTheDocument();
  });
});
