import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useUiStore } from "@/lib/store";
import { resetParkedDrafts } from "@/lib/composerStash";
import { Composer } from "./Composer";

describe("Composer", () => {
  it("appends a prepared draft below text the user was already typing", () => {
    useUiStore.setState({ composerDraft: null });
    render(<Composer onSend={vi.fn()} />);
    const input = screen.getByLabelText<HTMLTextAreaElement>("Ask anything");
    fireEvent.change(input, { target: { value: "half-written thought" } });

    act(() => useUiStore.getState().setComposerDraft("Reproduce `fig/plot.py`…"));
    expect(input.value).toBe("half-written thought\n\nReproduce `fig/plot.py`…");
    expect(useUiStore.getState().composerDraft).toBeNull(); // consumed once

    // An empty composer takes the draft as-is.
    fireEvent.change(input, { target: { value: "" } });
    act(() => useUiStore.getState().setComposerDraft("just the draft"));
    expect(input.value).toBe("just the draft");
  });

  it("sends on Enter but never during IME composition", () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const input = screen.getByLabelText("Ask anything");
    fireEvent.change(input, { target: { value: "ni hao" } });

    // Enter while composing (picking a pinyin candidate) must not send.
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    // WebKit reports the committing keydown as legacy keyCode 229.
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    // Shift+Enter inserts a newline, never sends.
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("ni hao");
  });

  it("does not send when empty or disabled", () => {
    const onSend = vi.fn();
    const { rerender } = render(<Composer onSend={onSend} />);
    const input = screen.getByLabelText("Ask anything");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();

    rerender(<Composer onSend={onSend} disabled />);
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("turns the send button into Stop while working, back to Send when done", () => {
    const onStop = vi.fn();
    const { rerender } = render(<Composer onSend={vi.fn()} disabled working onStop={onStop} />);
    // The send arrow is gone; in its place a live Stop button (the composer
    // itself stays disabled while the agent works).
    expect(screen.queryByLabelText("Send")).toBeNull();
    fireEvent.click(screen.getByLabelText("Stop"));
    expect(onStop).toHaveBeenCalledTimes(1);

    rerender(<Composer onSend={vi.fn()} onStop={onStop} />);
    expect(screen.queryByLabelText("Stop")).toBeNull();
    expect(screen.getByLabelText("Send")).toBeInTheDocument();
  });
});

const COMMANDS = [
  { name: "init", description: "guided AGENTS.md setup", source: "command" },
  { name: "analyze-data", description: "Analyze a dataset end to end.", source: "skill" },
];

describe("Composer '!' shell mode", () => {
  it("switches on the leading '!' and Enter runs the command, not a prompt", () => {
    const onSend = vi.fn();
    const onRunShell = vi.fn();
    render(<Composer onSend={onSend} onRunShell={onRunShell} />);
    const input = screen.getByLabelText<HTMLTextAreaElement>("Ask anything");
    fireEvent.change(input, { target: { value: "!pwd && ls" } });
    expect(screen.getByText("shell")).toBeInTheDocument(); // mode is visible
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRunShell).toHaveBeenCalledWith("pwd && ls");
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe(""); // cleared for the next command
  });

  it("a bare '!' runs nothing", () => {
    const onRunShell = vi.fn();
    render(<Composer onSend={vi.fn()} onRunShell={onRunShell} />);
    const input = screen.getByLabelText("Ask anything");
    fireEvent.change(input, { target: { value: "!  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRunShell).not.toHaveBeenCalled();
  });

  it("stays a plain prompt when no shell handler is provided (mock sessions)", () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const input = screen.getByLabelText("Ask anything");
    fireEvent.change(input, { target: { value: "!pwd" } });
    expect(screen.queryByText("shell")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("!pwd");
  });
});

describe("Composer '/' command palette", () => {
  it("opens on '/', filters while typing, and Enter commits the pick into a chip", () => {
    render(<Composer onSend={vi.fn()} onRunCommand={vi.fn()} commands={COMMANDS} />);
    const input = screen.getByLabelText<HTMLTextAreaElement>("Ask anything");
    fireEvent.change(input, { target: { value: "/ana" } });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(input, { key: "Enter" }); // autocomplete, not send
    // The command becomes a distinct chip; the input holds only the arguments.
    expect(screen.getByText("/analyze-data")).toBeInTheDocument();
    expect(input.value).toBe("");
    expect(screen.queryByRole("listbox")).toBeNull(); // arguments next
  });

  it("Enter sends a completed command with its arguments", () => {
    const onSend = vi.fn();
    const onRunCommand = vi.fn();
    render(<Composer onSend={onSend} onRunCommand={onRunCommand} commands={COMMANDS} />);
    const input = screen.getByLabelText("Ask anything");
    fireEvent.change(input, { target: { value: "/init focus on tests" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRunCommand).toHaveBeenCalledWith("init", "focus on tests");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("arrow keys move the selection; Escape closes the palette", () => {
    render(<Composer onSend={vi.fn()} onRunCommand={vi.fn()} commands={COMMANDS} />);
    const input = screen.getByLabelText("Ask anything");
    fireEvent.change(input, { target: { value: "/" } });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("an unknown '/name' falls back to a plain prompt", () => {
    const onSend = vi.fn();
    const onRunCommand = vi.fn();
    render(<Composer onSend={onSend} onRunCommand={onRunCommand} commands={COMMANDS} />);
    const input = screen.getByLabelText("Ask anything");
    fireEvent.change(input, { target: { value: "/etc/hosts looks wrong" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("/etc/hosts looks wrong");
    expect(onRunCommand).not.toHaveBeenCalled();
  });
});

describe("Composer command chip", () => {
  it("typing a known '/name' plus space commits it into a chip; Enter runs it with args", () => {
    const onRunCommand = vi.fn();
    render(<Composer onSend={vi.fn()} onRunCommand={onRunCommand} commands={COMMANDS} />);
    const input = screen.getByLabelText<HTMLTextAreaElement>("Ask anything");
    fireEvent.change(input, { target: { value: "/init " } });
    expect(screen.getByText("/init")).toBeInTheDocument(); // the chip
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "focus on tests" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRunCommand).toHaveBeenCalledWith("init", "focus on tests");
    expect(screen.queryByText("/init")).toBeNull(); // chip cleared after send
  });

  it("a chipped command runs with no arguments", () => {
    const onRunCommand = vi.fn();
    render(<Composer onSend={vi.fn()} onRunCommand={onRunCommand} commands={COMMANDS} />);
    const input = screen.getByLabelText("Ask anything");
    fireEvent.change(input, { target: { value: "/init " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRunCommand).toHaveBeenCalledWith("init", "");
  });

  it("an unknown '/name' plus space never chips", () => {
    render(<Composer onSend={vi.fn()} onRunCommand={vi.fn()} commands={COMMANDS} />);
    const input = screen.getByLabelText<HTMLTextAreaElement>("Ask anything");
    fireEvent.change(input, { target: { value: "/etc/hosts " } });
    expect(input.value).toBe("/etc/hosts ");
  });

  it("pasting '/name args' chips the command and keeps the args (multi-line too)", () => {
    const onRunCommand = vi.fn();
    render(<Composer onSend={vi.fn()} onRunCommand={onRunCommand} commands={COMMANDS} />);
    const input = screen.getByLabelText<HTMLTextAreaElement>("Ask anything");
    // A paste arrives as one change event with the full text already in place.
    fireEvent.change(input, { target: { value: "/init focus on tests\nand the docs" } });
    expect(screen.getByLabelText("Remove command")).toBeInTheDocument(); // the chip
    expect(input.value).toBe("focus on tests\nand the docs");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRunCommand).toHaveBeenCalledWith("init", "focus on tests\nand the docs");
  });

  it("pasting an unknown '/path args' stays a plain prompt", () => {
    render(<Composer onSend={vi.fn()} onRunCommand={vi.fn()} commands={COMMANDS} />);
    const input = screen.getByLabelText<HTMLTextAreaElement>("Ask anything");
    fireEvent.change(input, { target: { value: "/etc/hosts looks wrong" } });
    expect(screen.queryByLabelText("Remove command")).toBeNull();
    expect(input.value).toBe("/etc/hosts looks wrong");
  });

  it("Backspace on an empty input un-chips back to editable text", () => {
    render(<Composer onSend={vi.fn()} onRunCommand={vi.fn()} commands={COMMANDS} />);
    const input = screen.getByLabelText<HTMLTextAreaElement>("Ask anything");
    fireEvent.change(input, { target: { value: "/init " } });
    expect(screen.getByLabelText("Remove command")).toBeInTheDocument(); // the chip
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(screen.queryByLabelText("Remove command")).toBeNull();
    expect(input.value).toBe("/init"); // name editable again, palette reopens
  });
});

describe("Composer input history (↑/↓)", () => {
  const send = (input: HTMLElement, text: string) => {
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: "Enter" });
  };

  it("ArrowUp recalls sent inputs newest-first; ArrowDown returns to the draft", () => {
    window.localStorage.clear();
    render(<Composer onSend={vi.fn()} />);
    const input = screen.getByLabelText<HTMLTextAreaElement>("Ask anything");
    send(input, "first message");
    send(input, "second message");

    fireEvent.change(input, { target: { value: "a draft" } });
    input.setSelectionRange(0, 0);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("second message");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("first message");
    fireEvent.keyDown(input, { key: "ArrowUp" }); // past the oldest: stays
    expect(input.value).toBe("first message");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.value).toBe("second message");
    fireEvent.keyDown(input, { key: "ArrowDown" }); // past the newest: draft back
    expect(input.value).toBe("a draft");
  });

  it("recalls '!' shell and '/' command sends in their typed form", () => {
    window.localStorage.clear();
    const onRunShell = vi.fn();
    const onRunCommand = vi.fn();
    render(
      <Composer onSend={vi.fn()} onRunShell={onRunShell} onRunCommand={onRunCommand} commands={COMMANDS} />,
    );
    const input = screen.getByLabelText<HTMLTextAreaElement>("Ask anything");
    send(input, "!pwd");
    fireEvent.change(input, { target: { value: "/init " } }); // chips
    fireEvent.change(input, { target: { value: "focus" } });
    fireEvent.keyDown(input, { key: "Enter" });

    input.setSelectionRange(0, 0);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("/init focus");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("!pwd");
  });

  it("does not navigate history while the caret is mid-text or the palette is open", () => {
    window.localStorage.clear();
    render(<Composer onSend={vi.fn()} onRunCommand={vi.fn()} commands={COMMANDS} />);
    const input = screen.getByLabelText<HTMLTextAreaElement>("Ask anything");
    send(input, "older entry");

    fireEvent.change(input, { target: { value: "typing" } });
    input.setSelectionRange(3, 3); // caret mid-text: ArrowUp is caret movement
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("typing");

    fireEvent.change(input, { target: { value: "/" } }); // palette open: ↑ drives it
    input.setSelectionRange(0, 0);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("/");
  });
});

describe("approval mode switch", () => {
  it("is absent unless the surface provides the mode (mock sessions don't)", () => {
    render(<Composer onSend={vi.fn()} />);
    expect(screen.queryByLabelText("Approval mode")).toBeNull();
  });

  it("shows the current mode and switches on pick", () => {
    const onChange = vi.fn();
    render(<Composer onSend={vi.fn()} approvalMode="approve" onApprovalModeChange={onChange} />);
    const button = screen.getByLabelText("Approval mode");
    expect(button.textContent).toContain("Approve for me");

    fireEvent.click(button); // open the menu
    // mousedown, not click — in a real browser mousedown fires before the
    // trigger button's blur closes the menu (same pattern as the palette).
    fireEvent.mouseDown(screen.getByRole("menuitemradio", { name: /Full access/ }));
    expect(onChange).toHaveBeenCalledWith("full");
    // Menu closes after picking.
    expect(screen.queryByRole("menuitemradio", { name: /Full access/ })).toBeNull();
  });

  it("marks the active mode in the menu", () => {
    render(<Composer onSend={vi.fn()} approvalMode="full" onApprovalModeChange={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Approval mode"));
    expect(
      screen.getByRole("menuitemradio", { name: /Full access/ }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByRole("menuitemradio", { name: /Approve for me/ }).getAttribute("aria-checked"),
    ).toBe("false");
  });
});

describe("approval menu dismissal", () => {
  it("closes when clicking anywhere outside (WKWebView gives buttons no focus — blur can't do this)", () => {
    render(<Composer onSend={vi.fn()} approvalMode="approve" onApprovalModeChange={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Approval mode"));
    expect(screen.queryByRole("menu")).not.toBeNull();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("agent mode switch (Build / Plan)", () => {
  it("is absent unless the surface provides it (runtime without a plan agent)", () => {
    render(<Composer onSend={vi.fn()} />);
    expect(screen.queryByLabelText("Agent mode")).toBeNull();
  });

  it("shows the current mode and switches on pick", () => {
    const onChange = vi.fn();
    render(<Composer onSend={vi.fn()} agentMode="build" onAgentModeChange={onChange} />);
    const button = screen.getByLabelText("Agent mode");
    expect(button.textContent).toContain("Build");

    fireEvent.click(button);
    fireEvent.mouseDown(screen.getByRole("menuitemradio", { name: /Plan/ }));
    expect(onChange).toHaveBeenCalledWith("plan");
    expect(screen.queryByRole("menuitemradio", { name: /Plan/ })).toBeNull();
  });

  it("plan mode tints the composer border and pill blue (read-only must be unmistakable)", () => {
    const { container } = render(
      <Composer onSend={vi.fn()} agentMode="plan" onAgentModeChange={vi.fn()} />,
    );
    expect(container.firstElementChild?.className).toContain("border-link/60");
    expect(screen.getByLabelText("Agent mode").className).toContain("text-link");
  });
});

describe("Composer per-pane draft (#91)", () => {
  beforeEach(() => resetParkedDrafts());

  const input = () => screen.getByLabelText<HTMLTextAreaElement>("Ask anything");
  const pane = (draftKey: string) => render(<Composer onSend={vi.fn()} draftKey={draftKey} />);

  it("hands an unsent draft back to the same pane after a screen switch unmounts it", () => {
    const { unmount } = pane("draft:pane-1");
    fireEvent.change(input(), { target: { value: "half-written thought" } });
    unmount();

    pane("draft:pane-1");
    expect(input().value).toBe("half-written thought");
  });

  it("never hands one pane's draft to another", () => {
    const { unmount } = pane("draft:pane-1");
    fireEvent.change(input(), { target: { value: "meant for pane one" } });
    unmount();

    pane("draft:pane-2");
    expect(input().value).toBe("");
  });

  it("does not resurrect a message that was already sent", () => {
    const { unmount } = pane("draft:pane-1");
    fireEvent.change(input(), { target: { value: "off it goes" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    unmount();

    pane("draft:pane-1");
    expect(input().value).toBe("");
  });
});
