import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRuntimeStore } from "@/lib/runtime";
import { Composer } from "./Composer";

vi.mock("@/components/thread/references", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./references")>();
  // The workspace walk needs Tauri IPC; the picker's behavior is what matters.
  return { ...actual, walkWorkspace: async () => ["data/trials.csv", "notes/plan.md"] };
});

beforeEach(() => {
  useRuntimeStore.setState({
    sessions: [
      { id: "here", title: "current work" },
      { id: "x", title: "Manuscript draft", updated: 2 },
      { id: "y", title: "Bandpower rerun", updated: 1 },
    ],
  });
});
afterEach(() => useRuntimeStore.setState({ sessions: [] }));

describe("composer references", () => {
  it("offers past conversations for #, and attaches the chosen one as a chip", async () => {
    render(<Composer onSend={vi.fn()} currentSessionId="here" />);
    const input = screen.getByRole("textbox");

    await userEvent.type(input, "compare with #manu");

    const list = await screen.findByRole("listbox", { name: "Past conversations" });
    await userEvent.click(screen.getByRole("option", { name: "Manuscript draft" }));

    // The typed "#manu" is consumed; the reference now lives in a chip, so it
    // cannot be half-deleted into meaningless text.
    expect(input).toHaveValue("compare with  ");
    expect(screen.getByTitle(/quoted for the agent/)).toHaveTextContent("Manuscript draft");
    expect(list).not.toBeInTheDocument();
  });

  it("never offers the conversation being typed in", async () => {
    render(<Composer onSend={vi.fn()} currentSessionId="here" />);
    await userEvent.type(screen.getByRole("textbox"), "#current");

    // "current work" is this very session — the only title that matches.
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("offers workspace files for @ and inserts the path inline", async () => {
    render(<Composer onSend={vi.fn()} currentSessionId="here" sessionDir="/ws" />);
    const input = screen.getByRole("textbox");

    await userEvent.type(input, "plot @trials");

    await screen.findByRole("listbox", { name: "Workspace files" });
    await userEvent.click(screen.getByRole("option", { name: /data\/trials.csv/ }));

    expect(input).toHaveValue("plot @data/trials.csv ");
  });

  it("leaves an email address alone — a sigil mid-word is not a reference", async () => {
    render(<Composer onSend={vi.fn()} currentSessionId="here" sessionDir="/ws" />);
    await userEvent.type(screen.getByRole("textbox"), "write to me@example");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("a removed chip is not sent", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} currentSessionId="here" />);
    const input = screen.getByRole("textbox");

    await userEvent.type(input, "#manu");
    await userEvent.click(await screen.findByRole("option", { name: "Manuscript draft" }));
    await userEvent.click(screen.getByRole("button", { name: /Remove the reference/ }));

    await userEvent.type(input, "hello{Enter}");
    // No runtime client in tests, so a resolved reference would send nothing —
    // with the chip gone the plain prompt goes straight out.
    expect(onSend).toHaveBeenCalledWith("hello");
  });
});
