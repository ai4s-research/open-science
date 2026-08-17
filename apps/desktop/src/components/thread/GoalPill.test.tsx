import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import * as tauri from "@/lib/tauri";
import { GoalPill } from "./GoalPill";

vi.mock("@/lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof tauri>();
  return { ...mod, goalState: vi.fn(), goalUpdate: vi.fn() };
});
const goalState = vi.mocked(tauri.goalState);
const goalUpdate = vi.mocked(tauri.goalUpdate);

const activeGoal = {
  objective: "Reproduce figure 3 from the paper",
  status: "active" as const,
  autoTurns: 2,
};

describe("GoalPill", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    goalState.mockResolvedValue(activeGoal);
  });
  afterEach(() => vi.restoreAllMocks());

  it("renders nothing when the session has no goal", async () => {
    goalState.mockResolvedValue(null);
    const { container } = render(<GoalPill sessionId="s1" />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the objective, auto-turn count and a pause control while active", async () => {
    render(<GoalPill sessionId="s1" />);
    expect(await screen.findByText("Reproduce figure 3 from the paper")).toBeInTheDocument();
    expect(screen.getByText("auto-turn 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause the goal (stops auto-continuation)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear the goal" })).toBeInTheDocument();
  });

  it("pauses via goalUpdate and flips to the resume control", async () => {
    goalUpdate.mockResolvedValue({ ...activeGoal, status: "paused" });
    render(<GoalPill sessionId="s1" />);
    await screen.findByText("Reproduce figure 3 from the paper");

    await userEvent.click(
      screen.getByRole("button", { name: "Pause the goal (stops auto-continuation)" }),
    );

    expect(goalUpdate).toHaveBeenCalledWith("s1", "pause");
    expect(await screen.findByText("paused")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume the goal" })).toBeInTheDocument();
  });

  it("resume kicks one turn via onResumed (a paused session has no idle left)", async () => {
    goalState.mockResolvedValue({ ...activeGoal, status: "paused" });
    goalUpdate.mockResolvedValue({ ...activeGoal, status: "active" });
    const onResumed = vi.fn();
    render(<GoalPill sessionId="s1" onResumed={onResumed} />);

    await userEvent.click(await screen.findByRole("button", { name: "Resume the goal" }));

    expect(goalUpdate).toHaveBeenCalledWith("s1", "resume");
    expect(onResumed).toHaveBeenCalledTimes(1);
  });

  it("clears the goal and disappears", async () => {
    goalUpdate.mockResolvedValue(null);
    const { container } = render(<GoalPill sessionId="s1" />);
    await screen.findByText("Reproduce figure 3 from the paper");

    await userEvent.click(screen.getByRole("button", { name: "Clear the goal" }));

    expect(goalUpdate).toHaveBeenCalledWith("s1", "clear");
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });

  it("compact mode opens its popover in a body portal, not inside the pane", async () => {
    const { container } = render(<GoalPill sessionId="s-compact" compact />);

    await userEvent.click(await screen.findByRole("button", { name: /Goal:/ }));

    const dialog = screen.getByRole("dialog");
    // Anchored but escaping the pane: a pane clips its overflow, so a popover
    // rendered inside the pill's own subtree was cut off in a tiled layout.
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
    expect(dialog.className).toContain("fixed");
    expect(dialog).toHaveTextContent("Reproduce figure 3 from the paper");
  });

  it("shows the blocker tone when the goal is unmet", async () => {
    goalState.mockResolvedValue({
      objective: "x",
      status: "unmet",
      blocker: "missing dataset",
    });
    render(<GoalPill sessionId="s1" />);
    expect(await screen.findByText("blocked")).toBeInTheDocument();
    // Unmet goals keep only the clear control — nothing to pause.
    expect(screen.queryByRole("button", { name: /Pause/ })).not.toBeInTheDocument();
  });

  it("shows the limit tone for a budget-limited goal", async () => {
    goalState.mockResolvedValue({
      objective: "x",
      status: "budgetLimited",
      lastStatus: "Token budget exhausted",
    });
    render(<GoalPill sessionId="s1" />);
    expect(await screen.findByText("limit reached")).toBeInTheDocument();
  });
});
