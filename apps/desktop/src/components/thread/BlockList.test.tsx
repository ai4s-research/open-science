import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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
