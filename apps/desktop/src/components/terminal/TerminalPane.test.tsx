import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { TerminalPane } from "./TerminalPane";

vi.mock("@/lib/tauri", () => ({ isTauri: true, isMacUA: () => true }));
vi.mock("./terminalLinks", () => ({ registerTerminalLinks: () => ({ dispose() {} }) }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
// What `terminal_open` answers; a test sets a running shell's instead.
const opened = vi.hoisted(() => ({ value: { created: true } as Record<string, unknown> }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "terminal_open" ? opened.value : null)),
  Channel: class {
    onmessage: (message: unknown) => void = () => {};
  },
}));

// The one xterm instance, and the key handler it was given when created.
// `cols` is what the fit addon measures; a test changes it to resize.
const xterm = vi.hoisted(() => ({
  keyHandler: null as ((e: KeyboardEvent) => boolean) | null,
  cols: 80,
  last: null as { options: Record<string, unknown>; cols: number; rows: number } | null,
  writes: [] as string[],
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
    }
    options: Record<string, unknown> = {};
    constructor(options: Record<string, unknown>) {
      xterm.last = this;
      this.options = { ...options };
    }
    unicode = { activeVersion: "" };
    loadAddon() {}
    attachCustomKeyEventHandler(fn: (e: KeyboardEvent) => boolean) {
      xterm.keyHandler = fn;
    }
    open() {}
    focus() {}
    buffer = { active: { viewportY: 0, baseY: 0, getLine: () => ({ translateToString: () => "" }) } };
    scrollToTop() {}
    scrollToLine() {}
    write(data: string, done?: () => void) {
      xterm.writes.push(data);
      done?.();
    }
    onData() {
      return { dispose() {} };
    }
    onResize() {
      return { dispose() {} };
    }
    dispose() {}
  },
}));
const addon = class {
  fit() {}
  proposeDimensions() {
    return { cols: xterm.cols, rows: 24 };
  }
  dispose() {}
  onContextLoss() {}
  onDidChangeResults() {
    return { dispose() {} };
  }
  findNext() {
    return false;
  }
  clearDecorations() {}
  serialize() {
    return "<screen>";
  }
};
vi.mock("@xterm/addon-fit", () => ({ FitAddon: addon }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: addon }));
vi.mock("@xterm/addon-serialize", () => ({ SerializeAddon: addon }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: addon }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: addon }));

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", { cancelable: true, ...init });

describe("TerminalPane find", () => {
  it("opens on ⌘F and closes on Escape after the pane was remounted (as maximizing does)", async () => {
    const first = render(<TerminalPane leafId="t1" />);
    await waitFor(() => expect(xterm.keyHandler).not.toBeNull());
    first.unmount();
    // The terminal is parked and adopted by the next component; its key
    // handler is still the one bound at creation.
    render(<TerminalPane leafId="t1" />);

    const find = key({ key: "f", metaKey: true });
    act(() => void xterm.keyHandler!(find));
    expect(await screen.findByRole("textbox", { name: "Find" })).toBeInTheDocument();
    expect(find.defaultPrevented).toBe(true);

    // Escape from the terminal itself closes the bar, and is claimed so macOS
    // does not read it as "leave full screen".
    const esc = key({ key: "Escape" });
    let passedToShell = true;
    act(() => void (passedToShell = xterm.keyHandler!(esc)));
    expect(passedToShell).toBe(false);
    expect(esc.defaultPrevented).toBe(true);
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Find" })).not.toBeInTheDocument());

    // With the bar shut, Escape belongs to the shell again.
    expect(xterm.keyHandler!(key({ key: "Escape" }))).toBe(true);
  });

  it("leaves Ctrl+F to the shell on a Mac — it is the line editor's forward-char", async () => {
    render(<TerminalPane leafId="t2" />);
    await waitFor(() => expect(xterm.keyHandler).not.toBeNull());
    expect(xterm.keyHandler!(key({ key: "f", ctrlKey: true }))).toBe(true);
    expect(screen.queryByRole("textbox", { name: "Find" })).not.toBeInTheDocument();
  });
});

describe("TerminalPane resize", () => {
  it("tells the shell only the size the pane settles on, not every frame of an animation", async () => {
    let onResize: (() => void) | null = null;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          onResize = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    const box = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
    const boxH = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
    const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

    render(<TerminalPane leafId="t-resize" />);
    await waitFor(() => expect(onResize).not.toBeNull());
    vi.mocked(invoke).mockClear();

    // A sidebar animation: the grid loses a column per frame.
    for (let cols = 79; cols >= 70; cols--) {
      xterm.cols = cols;
      onResize!();
      await frame();
      await frame();
    }
    expect(invoke).not.toHaveBeenCalledWith("terminal_resize", expect.anything());

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("terminal_resize", { id: "t-resize", cols: 70, rows: 24 }),
    );
    expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "terminal_resize")).toHaveLength(1);

    box.mockRestore();
    boxH.mockRestore();
    vi.unstubAllGlobals();
    xterm.cols = 80;
  });
});

describe("TerminalPane font", () => {
  it("opens the terminal only once its web font has loaded, so the cell is measured in it", async () => {
    const pending: (() => void)[] = [];
    const load = vi.fn(() => new Promise<FontFace[]>((r) => pending.push(() => r([]))));
    Object.defineProperty(document, "fonts", { value: { load }, configurable: true });
    xterm.keyHandler = null;
    try {
      render(<TerminalPane leafId="font-1" />);
      await waitFor(() => expect(load).toHaveBeenCalled());
      expect(String(load.mock.calls[0])).toContain("JetBrains Mono");
      await new Promise((r) => setTimeout(r, 20));
      expect(xterm.keyHandler).toBeNull();
      pending.forEach((done) => done());
      await waitFor(() => expect(xterm.keyHandler).not.toBeNull());
    } finally {
      delete (document as { fonts?: unknown }).fonts;
    }
  });
});

describe("TerminalPane theme", () => {
  it("repaints in the new theme when the app switches theme", async () => {
    const root = document.documentElement;
    root.style.setProperty("--surface", "#ffffff");
    xterm.keyHandler = null;
    render(<TerminalPane leafId="theme-1" />);
    await waitFor(() => expect(xterm.keyHandler).not.toBeNull());
    expect((xterm.last!.options.theme as { background: string }).background).toBe("#ffffff");

    root.style.setProperty("--surface", "#1e1d24");
    root.dataset.theme = "dark";
    await waitFor(() =>
      expect((xterm.last!.options.theme as { background: string }).background).toBe("#1e1d24"),
    );
    delete root.dataset.theme;
    root.style.removeProperty("--surface");
  });
});

describe("TerminalPane reopen", () => {
  /** The output channel the pane subscribed with, and what it asked for. */
  const subscribed = () => {
    const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "terminal_subscribe")!;
    const args = call[1] as { since: number | null; onEvent: { onmessage: (m: unknown) => void } };
    return { since: args.since, send: (m: unknown) => args.onEvent.onmessage(m) };
  };
  const reopen = async (leafId: string, screen: { end: number; data: string }) => {
    opened.value = { created: false, cols: 61, rows: 22, screen };
    vi.mocked(invoke).mockClear();
    xterm.writes = [];
    render(<TerminalPane leafId={leafId} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("terminal_subscribe", expect.anything()));
    opened.value = { created: true };
  };

  it("starts at the running shell's size, draws its saved screen, then the output after it", async () => {
    await reopen("reopen-1", { end: 500, data: "<saved>" });
    expect([xterm.last!.cols, xterm.last!.rows]).toEqual([61, 22]);
    const { since, send } = subscribed();
    expect(since).toBe(500);
    send({ kind: "data", data: "after", from: 500, end: 505 });
    send({ kind: "data", data: "live", end: 509 });
    expect(xterm.writes).toEqual(["<saved>", "after", "live"]);
  });

  it("drops a saved screen the output no longer follows on from", async () => {
    await reopen("reopen-2", { end: 500, data: "<saved>" });
    subscribed().send({ kind: "data", data: "everything", from: 120, end: 900 });
    expect(xterm.writes).toEqual(["everything"]);
  });
});

describe("TerminalPane control", () => {
  it("follows the view in control, masked, and takes the shell back at its own size", async () => {
    vi.mocked(invoke).mockClear();
    render(<TerminalPane leafId="ctl-1" />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("terminal_subscribe", expect.anything()));
    const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "terminal_subscribe")!;
    const send = (m: unknown) => (call[1] as { onEvent: { onmessage: (m: unknown) => void } }).onEvent.onmessage(m);

    // A browser tab controls it: the pane takes its size and types nothing.
    act(() => send({ kind: "control", by: { id: "tab1", kind: "web" }, cols: 50, rows: 21 }));
    expect(await screen.findByText("The browser is in control")).toBeInTheDocument();
    await waitFor(() => expect([xterm.last!.cols, xterm.last!.rows]).toEqual([50, 21]));
    expect(xterm.last!.options.disableStdin).toBe(true);
    expect(invoke).not.toHaveBeenCalledWith("terminal_resize", expect.anything());

    act(() => screen.getByRole("button", { name: "Take over this one" }).click());
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("terminal_claim", { id: "ctl-1", cols: 80, rows: 24 }));
    await waitFor(() => expect(screen.queryByText("The browser is in control")).not.toBeInTheDocument());
    expect(xterm.last!.options.disableStdin).toBe(false);
  });

  it("takes a size it did not ask for as a resize, then asks for its own back", async () => {
    vi.mocked(invoke).mockClear();
    render(<TerminalPane leafId="ctl-2" />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("terminal_subscribe", expect.anything()));
    const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "terminal_subscribe")!;
    const send = (m: unknown) => (call[1] as { onEvent: { onmessage: (m: unknown) => void } }).onEvent.onmessage(m);

    // Still this window's, but sized from elsewhere: its repaint is spliced at
    // that size, not drawn over the old screen as a copy.
    act(() => send({ kind: "control", by: { id: "desktop", kind: "desktop" }, cols: 50, rows: 21 }));
    await waitFor(() => expect([xterm.last!.cols, xterm.last!.rows]).toEqual([50, 21]));
    expect(screen.queryByText(/is in control/)).not.toBeInTheDocument();
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("terminal_resize", { id: "ctl-2", cols: 80, rows: 24 }),
    );
  });
});

describe("TerminalPane repaint", () => {
  it("splices a repaint Claude Code makes on its own, as one that answers a resize", async () => {
    vi.mocked(invoke).mockClear();
    render(<TerminalPane leafId="own-1" />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("terminal_subscribe", expect.anything()));
    const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "terminal_subscribe")!;
    const send = (m: unknown) => (call[1] as { onEvent: { onmessage: (m: unknown) => void } }).onEvent.onmessage(m);
    act(() => send({ kind: "control", by: { id: "desktop", kind: "desktop" }, cols: 80, rows: 24 }));
    xterm.writes = [];

    const erase = `\x1b[H${"\x1b[2K\x1b[1B".repeat(24)}\x1b[H`;
    act(() => send({ kind: "data", data: `before${erase}turn line 1\nturn line 2\x1b[?25h after` }));
    // Not the erase as sent: the old rows are cleared from where the repaint
    // lines up (here, below everything), and the turn written from there.
    await waitFor(() => expect(xterm.writes.join("")).toContain("turn line 2\x1b[?25h after"));
    expect(xterm.writes.join("")).not.toContain(erase);
    expect(xterm.writes).toContain("before");
  });
});
