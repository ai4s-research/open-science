import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { useRuntimeStore } from "@/lib/runtime";
import { TodoDock } from "./TodoDock";

const S = "ses_todo";

function setTodos(todos: { content: string; status: "pending" | "in_progress" | "completed" | "cancelled" }[]) {
  act(() =>
    useRuntimeStore.setState((s) => ({
      threads: { ...s.threads, [S]: { blocks: [], index: {}, loaded: true, todos } },
    })),
  );
}

describe("TodoDock", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("renders nothing before the agent makes a list", () => {
    setTodos([]);
    const { container } = render(<TodoDock sessionId={S} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the counts collapsed and the items once opened", async () => {
    setTodos([
      { content: "Read the survey data", status: "completed" },
      { content: "Fit the regression", status: "in_progress" },
      { content: "Plot residuals", status: "pending" },
      { content: "Email the lab", status: "pending" },
    ]);
    render(<TodoDock sessionId={S} />);
    const header = screen.getByRole("button", { name: /Tasks/ });
    expect(header).toHaveTextContent("1 done · 1 in progress · 2 to do");
    expect(screen.queryByText("Fit the regression")).toBeNull();

    await userEvent.click(header);
    expect(screen.getByText("Fit the regression")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Done" })).toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: "To do" })).toHaveLength(2);
  });

  it("follows the list as the agent updates it", () => {
    setTodos([{ content: "Fit the regression", status: "in_progress" }]);
    render(<TodoDock sessionId={S} />);
    setTodos([{ content: "Fit the regression", status: "completed" }]);
    expect(screen.getByRole("button", { name: /Tasks/ })).toHaveTextContent("1 done");
  });
});
