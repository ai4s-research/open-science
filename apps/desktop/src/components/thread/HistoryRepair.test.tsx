import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoryRepairBlock } from "@ai4s/shared";
import { HistoryRepair } from "./atoms";

afterEach(cleanup);

const damaged: HistoryRepairBlock = {
  kind: "history-repair",
  reason: "tool-result-missing",
  tool: "bash",
  target: { messageID: "msg_2", text: "plot the spectra" },
  drops: 4,
};

describe("HistoryRepair", () => {
  it("names the damaged part and what the rollback costs", () => {
    render(<HistoryRepair block={damaged} onRevert={vi.fn()} />);
    expect(screen.getByText(/saved bash step is missing the result/i)).toBeTruthy();
    expect(screen.getByText(/discards 4 messages/i)).toBeTruthy();
  });

  it("says so plainly when the scan recognized nothing, rather than blaming a message", () => {
    render(<HistoryRepair block={{ kind: "history-repair" }} />);
    expect(screen.getByText(/could not identify which saved message/i)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("confirms before rolling back — the repair discards messages and file changes", async () => {
    const onRevert = vi.fn();
    render(<HistoryRepair block={damaged} onRevert={onRevert} />);
    await userEvent.click(screen.getByRole("button", { name: /repair conversation/i }));
    expect(onRevert).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText(/rolls back the file changes/i)).toBeTruthy();
  });

  it("reverts to the message the scan picked, handing its text back to the composer", async () => {
    const onRevert = vi.fn();
    render(<HistoryRepair block={damaged} onRevert={onRevert} />);
    await userEvent.click(screen.getByRole("button", { name: /repair conversation/i }));
    await userEvent.click(screen.getByRole("button", { name: /roll back/i }));
    expect(onRevert).toHaveBeenCalledWith("msg_2", "plot the spectra");
  });

  it("leaves the damage in place when the confirmation is declined", async () => {
    const onRevert = vi.fn();
    render(<HistoryRepair block={damaged} onRevert={onRevert} />);
    await userEvent.click(screen.getByRole("button", { name: /repair conversation/i }));
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onRevert).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("offers no action outside the live session, but still explains the failure", () => {
    render(<HistoryRepair block={damaged} />);
    expect(screen.getByText(/saved bash step is missing the result/i)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("tells the user to start over when there is nothing to roll back to", () => {
    render(
      <HistoryRepair block={{ kind: "history-repair", reason: "text-missing" }} onRevert={vi.fn()} />,
    );
    expect(screen.getByText(/no earlier point to roll back to/i)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
