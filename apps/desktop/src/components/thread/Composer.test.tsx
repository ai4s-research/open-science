import { useToastStore } from "@/lib/toast";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useUiStore } from "@/lib/store";
import { resetParkedDrafts } from "@/lib/composerStash";
import { Composer } from "./Composer";

describe("Composer", () => {
  it("a press on the capsule's padding goes to the input, never starts a page selection", () => {
    render(<Composer onSend={vi.fn()} />);
    const input = screen.getByLabelText<HTMLTextAreaElement>("Ask anything");
    fireEvent.change(input, { target: { value: "draft" } });
    input.blur();
    const capsule = input.closest(".rounded-\\[24px\\]") as HTMLElement;
    const pressed = fireEvent.mouseDown(capsule, { button: 0 });
    expect(pressed).toBe(false); // default prevented: no selection starts
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe("draft".length);

    // A press on the input itself keeps its native behavior.
    expect(fireEvent.mouseDown(input, { button: 0 })).toBe(true);
  });

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

describe("plan mode (/plan, Shift+Tab, the chip)", () => {
  const input = () => screen.getByLabelText("Ask anything");
  const run = (line: string) => {
    // A known name followed by a space chips; Enter then runs it.
    fireEvent.change(input(), { target: { value: line.includes(" ") ? line : `${line} ` } });
    fireEvent.keyDown(input(), { key: "Enter" });
  };

  it("is absent unless the surface provides it (runtime without a plan agent)", () => {
    render(<Composer onSend={vi.fn()} onRunCommand={vi.fn()} />);
    fireEvent.change(input(), { target: { value: "/pl" } });
    expect(screen.queryByRole("option", { name: /\/plan/ })).toBeNull();
    expect(screen.queryByLabelText("Leave plan mode")).toBeNull();
  });

  it("/plan enters, /plan off leaves — neither reaches the runtime", () => {
    const onChange = vi.fn();
    const onRunCommand = vi.fn();
    render(
      <Composer onSend={vi.fn()} onRunCommand={onRunCommand} agentMode="build" onAgentModeChange={onChange} />,
    );
    run("/plan");
    expect(onChange).toHaveBeenLastCalledWith("plan");
    run("/plan off");
    expect(onChange).toHaveBeenLastCalledWith("build");
    expect(onRunCommand).not.toHaveBeenCalled();
  });

  it("/plan <task> enters plan mode first, then sends the task", () => {
    const calls: string[] = [];
    render(
      <Composer
        onSend={(t) => calls.push(`send:${t}`)}
        onRunCommand={vi.fn()}
        agentMode="build"
        onAgentModeChange={(m) => calls.push(`mode:${m}`)}
      />,
    );
    run("/plan migrate the parser");
    expect(calls).toEqual(["mode:plan", "send:migrate the parser"]);
  });

  it("Shift+Tab flips the mode", () => {
    const onChange = vi.fn();
    const { rerender } = render(<Composer onSend={vi.fn()} agentMode="build" onAgentModeChange={onChange} />);
    fireEvent.keyDown(input(), { key: "Tab", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith("plan");
    rerender(<Composer onSend={vi.fn()} agentMode="plan" onAgentModeChange={onChange} />);
    fireEvent.keyDown(input(), { key: "Tab", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith("build");
  });

  it("shows a blue chip only while on, and its × leaves (read-only must be unmistakable)", () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <Composer onSend={vi.fn()} agentMode="build" onAgentModeChange={onChange} />,
    );
    expect(screen.queryByLabelText("Leave plan mode")).toBeNull();
    rerender(<Composer onSend={vi.fn()} agentMode="plan" onAgentModeChange={onChange} />);
    expect(container.firstElementChild?.className).toContain("ring-link/60");
    fireEvent.click(screen.getByLabelText("Leave plan mode"));
    expect(onChange).toHaveBeenCalledWith("build");
  });
});

describe("commands that take no arguments", () => {
  const input = () => screen.getByLabelText("Ask anything");
  const clear = { name: "clear", source: "local", immediate: true };

  it("run on Enter from the palette — no chip, no second Enter", () => {
    const onRunCommand = vi.fn();
    render(<Composer onSend={vi.fn()} onRunCommand={onRunCommand} commands={[clear]} />);
    fireEvent.change(input(), { target: { value: "/cle" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onRunCommand).toHaveBeenCalledWith("clear", "");
    expect((input() as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByLabelText("Remove command")).toBeNull();
  });

  it("only complete on Tab, so a stray Tab never wipes a conversation", () => {
    const onRunCommand = vi.fn();
    render(<Composer onSend={vi.fn()} onRunCommand={onRunCommand} commands={[clear]} />);
    fireEvent.change(input(), { target: { value: "/cle" } });
    fireEvent.keyDown(input(), { key: "Tab" });
    expect(onRunCommand).not.toHaveBeenCalled();
  });

  it("/compact asks straight away", () => {
    render(<Composer onSend={vi.fn()} onRunCommand={vi.fn()} onCompactContext={vi.fn()} />);
    fireEvent.change(input(), { target: { value: "/comp" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(screen.getByRole("alertdialog", { name: "Compact the context?" })).toBeInTheDocument();
  });
});

describe("typing while the agent works", () => {
  const input = () => screen.getByLabelText("Ask anything");

  it("Enter queues, Cmd/Ctrl+Enter sends now (steer)", () => {
    const onSend = vi.fn();
    const onQueue = vi.fn();
    render(<Composer onSend={onSend} onQueue={onQueue} working onStop={vi.fn()} />);
    fireEvent.change(input(), { target: { value: "after this" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onQueue).toHaveBeenCalledWith("after this");
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.change(input(), { target: { value: "right now" } });
    fireEvent.keyDown(input(), { key: "Enter", metaKey: true });
    expect(onSend).toHaveBeenCalledWith("right now");
  });

  it("keeps Stop and adds a queue button once there is text", () => {
    const onQueue = vi.fn();
    render(<Composer onSend={vi.fn()} onQueue={onQueue} working onStop={vi.fn()} />);
    expect(screen.queryByLabelText("Queue message")).toBeNull();
    fireEvent.change(input(), { target: { value: "next" } });
    fireEvent.click(screen.getByLabelText("Queue message"));
    expect(onQueue).toHaveBeenCalledWith("next");
    expect(screen.getByLabelText("Stop")).toBeInTheDocument();
  });

  it("Cmd/Ctrl+Enter on an empty input steers the whole queue", () => {
    const onSteerQueued = vi.fn();
    render(<Composer onSend={vi.fn()} onQueue={vi.fn()} onSteerQueued={onSteerQueued} working />);
    fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true });
    expect(onSteerQueued).toHaveBeenCalledTimes(1);
  });

  it("refuses a runtime command mid-turn and keeps what was typed", () => {
    const onRunCommand = vi.fn();
    render(
      <Composer
        onSend={vi.fn()}
        onQueue={vi.fn()}
        working
        onRunCommand={onRunCommand}
        commands={[{ name: "review" }]}
      />,
    );
    fireEvent.change(input(), { target: { value: "/review " } });
    fireEvent.change(input(), { target: { value: "src" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onRunCommand).not.toHaveBeenCalled();
    expect((input() as HTMLTextAreaElement).value).toBe("src");
  });
});

// A narrow pane could not fit "Approve for me · Plan mode · GPT-5.6 sol · High" as
// words, so the toolbar wrapped and ate the composer's height.
describe("Composer toolbar in a narrow pane", () => {
  /** jsdom has no layout: give the action row `width` of room, and every item
   *  a width that grows with its text (so a label costs what it says). */
  const patched = [
    [HTMLElement.prototype, "offsetWidth"],
    [Element.prototype, "clientWidth"],
    [Element.prototype, "getClientRects"],
  ] as const;
  const saved = patched.map(([proto, key]) => Object.getOwnPropertyDescriptor(proto, key));
  function withWidth(width: number) {
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return 28 + (this.textContent?.length ?? 0) * 7;
      },
    });
    Object.defineProperty(Element.prototype, "clientWidth", { configurable: true, get: () => width });
    Object.defineProperty(Element.prototype, "getClientRects", { configurable: true, value: () => [{}] });
  }

  afterEach(() => {
    patched.forEach(([proto, key], i) => {
      const d = saved[i];
      if (d) Object.defineProperty(proto, key, d);
      else delete (proto as unknown as Record<string, unknown>)[key];
    });
  });

  it("keeps the labels when there is room", () => {
    withWidth(900);
    render(<Composer onSend={vi.fn()} approvalMode="approve" onApprovalModeChange={vi.fn()} />);
    expect(screen.getByLabelText("Approval mode").textContent).toContain("Approve for me");
  });

  it("drops the labels but keeps the control reachable when narrow", () => {
    withWidth(200);
    render(
      <Composer
        onSend={vi.fn()}
        agentMode="plan"
        onAgentModeChange={vi.fn()}
        approvalMode="approve"
        onApprovalModeChange={vi.fn()}
      />,
    );
    const approval = screen.getByLabelText("Approval mode");
    // The words are gone …
    expect(approval.textContent).not.toContain("Approve for me");
    expect(screen.getByLabelText("Leave plan mode").parentElement?.textContent).not.toContain("Plan mode");
    // … but the controls are still there, still named, and still work.
    fireEvent.click(approval);
    expect(screen.getByRole("menuitemradio", { name: /Full access/ })).toBeInTheDocument();
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

  describe("compacting the context (/compact)", () => {
    const compact = () => {
      fireEvent.change(input(), { target: { value: "/compact " } });
      fireEvent.keyDown(input(), { key: "Enter" });
    };

    it("asks before compacting — the click alone does nothing", async () => {
      const onCompactContext = vi.fn();
      render(<Composer onSend={vi.fn()} onRunCommand={vi.fn()} onCompactContext={onCompactContext} />);

      compact();

      // It rewrites what the agent can see for the rest of the conversation.
      expect(onCompactContext).not.toHaveBeenCalled();
      expect(screen.getByRole("alertdialog", { name: "Compact the context?" })).toBeInTheDocument();
    });

    it("says what compaction does, including what it does NOT lose", async () => {
      render(<Composer onSend={vi.fn()} onRunCommand={vi.fn()} onCompactContext={vi.fn()} />);
      compact();

      expect(
        screen.getByText(/The full original conversation is still stored locally/),
      ).toBeInTheDocument();
    });

    it("compacts once the reader confirms, and closes", async () => {
      const onCompactContext = vi.fn();
      render(<Composer onSend={vi.fn()} onRunCommand={vi.fn()} onCompactContext={onCompactContext} />);
      compact();

      await userEvent.click(screen.getByRole("button", { name: "Compact" }));

      expect(onCompactContext).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    it("cancels without compacting", async () => {
      const onCompactContext = vi.fn();
      render(<Composer onSend={vi.fn()} onRunCommand={vi.fn()} onCompactContext={onCompactContext} />);
      compact();

      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(onCompactContext).not.toHaveBeenCalled();
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    it("refuses with the reason instead of asking, and is not sent as a prompt", () => {
      const onCompactContext = vi.fn();
      const onSend = vi.fn();
      const reason = "Only 42k of context in use; compacting starts at 100k";
      render(
        <Composer
          onSend={onSend}
          onRunCommand={vi.fn()}
          onCompactContext={onCompactContext}
          compactRefusal={() => reason}
        />,
      );
      // The palette says why before it is even picked.
      fireEvent.change(input(), { target: { value: "/comp" } });
      expect(screen.getByRole("option", { name: new RegExp(reason) })).toBeInTheDocument();

      compact();
      expect(useToastStore.getState().toasts.slice(-1)[0]).toMatchObject({ tone: "info", message: reason });
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(onCompactContext).not.toHaveBeenCalled();
      expect(onSend).not.toHaveBeenCalled();
      expect(input().value).toBe("");
    });
  });
});

describe("Composer · the action row stays one line", () => {
  /** The row holding the send button — the composer's bottom controls. */
  function actionRow(): HTMLElement {
    const send = screen.getByRole("button", { name: /send/i });
    // The row is the send button's grandparent: button → right group → row.
    return send.parentElement!.parentElement!;
  }

  it("never wraps the controls onto a second line", () => {
    render(<Composer onSend={vi.fn()} />);

    // The reported bug: the send button sat on its own line under the other
    // controls, with a gap between them. Flexbox wraps on an item's natural
    // width rather than shrinking it, so ONE long model name was enough — the
    // row must not be allowed to wrap at all.
    expect(actionRow().className).not.toContain("flex-wrap");
    // …which only works if the row can be narrower than its contents.
    expect(actionRow().className).toContain("min-w-0");
  });
});
