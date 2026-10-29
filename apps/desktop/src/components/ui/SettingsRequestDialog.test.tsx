import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingDef } from "@/lib/settingsRegistry";

const answer = vi.hoisted(() => vi.fn(async () => {}));
const writes = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/runtime", () => ({
  useRuntimeStore: (sel: (s: unknown) => unknown) => sel({ sessions: [{ id: "ses_a", title: "Fold proteins" }] }),
}));
vi.mock("@/lib/settingsBridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/settingsBridge")>();
  return { ...real, answer };
});
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

import { useSettingsRequests } from "@/lib/settingsBridge";
import { SettingsRequestDialog } from "./SettingsRequestDialog";

const def = (key: string, extra: Partial<SettingDef> = {}): SettingDef => ({
  key,
  section: "remote",
  label: "remote.terminal",
  kind: "bool",
  read: async () => false,
  write: async () => void writes.push(key),
  ...extra,
});

beforeEach(() => {
  writes.length = 0;
  answer.mockClear();
  useSettingsRequests.setState({
    queue: [
      {
        id: "set_1",
        from: "ses_a",
        reason: "To open Claude Code in a terminal on your right.",
        changes: [
          { def: def("remote.terminal", { sensitive: true, hint: "remote.terminalHint" }), from: false, to: true },
          { def: def("approval.mode", { label: "request.approvalMode", kind: "enum", restarts: true, optionLabel: (v) => (v === "full" ? "request.approvalFull" : "request.approvalApprove") }), from: "approve", to: "full" },
        ],
      },
    ],
  });
});

describe("SettingsRequestDialog", () => {
  it("shows who asked, why, and each change from now to asked", () => {
    render(<SettingsRequestDialog />);
    expect(screen.getByText("From Fold proteins")).toBeInTheDocument();
    expect(screen.getByText("To open Claude Code in a terminal on your right.")).toBeInTheDocument();
    expect(screen.getByText("Allow terminals")).toBeInTheDocument();
    expect(screen.getByText("Run without asking")).toBeInTheDocument();
    expect(screen.getByText(/Restarts the agent runtime/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decline" })).toHaveFocus();
  });

  it("applies only the changes left ticked", async () => {
    render(<SettingsRequestDialog />);
    await userEvent.click(screen.getByRole("checkbox", { name: /Approval mode/ }));
    await userEvent.click(screen.getByRole("button", { name: "Apply selected" }));
    await waitFor(() =>
      expect(answer).toHaveBeenCalledWith("set_1", {
        status: "approved",
        applied: ["remote.terminal"],
        declined: ["approval.mode"],
        failed: {},
      }),
    );
    expect(writes).toEqual(["remote.terminal"]);
    expect(useSettingsRequests.getState().queue).toEqual([]);
  });

  it("Escape declines, so the asker is not left waiting", async () => {
    render(<SettingsRequestDialog />);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(answer).toHaveBeenCalledWith("set_1", { status: "denied" }));
    expect(writes).toEqual([]);
  });

  it("nothing ticked, nothing to apply", async () => {
    render(<SettingsRequestDialog />);
    for (const box of screen.getAllByRole("checkbox")) await userEvent.click(box);
    expect(screen.getByRole("button", { name: "Apply selected" })).toBeDisabled();
  });
});
