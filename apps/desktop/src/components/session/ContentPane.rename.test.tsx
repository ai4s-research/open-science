// Naming a terminal, and choosing what a split holds.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useLayoutStore, type PaneContent, type PaneNode } from "@/lib/layout";
import { useDragPane } from "@/lib/dragPane";
import {
  destroyTerminal,
  isTerminalUsed,
  liveTerminalIds,
  markTerminalUsed,
} from "@/lib/terminalSessions";
import { ContentPane } from "./ContentPane";

// The terminal itself needs a PTY; the header is what these tests are about.
vi.mock("@/components/terminal/TerminalPane", () => ({
  TerminalPane: () => <div data-testid="terminal" />,
}));

/** Renders the pane from the STORE, as `PaneTree` does — the header has to show
 *  the name the rename actually wrote, not a fixture handed to it. */
function Pane({ leafId }: { leafId: string }) {
  const content = useLayoutStore((s) => (s.tree ? contentIn(s.tree, leafId) : undefined));
  return content ? <ContentPane content={content} leafId={leafId} onClose={() => {}} /> : null;
}

function contentIn(node: PaneNode, leafId: string): PaneContent | undefined {
  if (node.kind === "leaf") return node.id === leafId ? node.content : undefined;
  for (const child of node.children) {
    const found = contentIn(child, leafId);
    if (found) return found;
  }
  return undefined;
}

function openTerminalPane() {
  useLayoutStore.setState({ groups: [], activeGroupId: "", tree: null, focusedLeafId: null });
  useLayoutStore.getState().addGroup();
  const leafId = useLayoutStore.getState().openContentPane({ kind: "terminal", cwd: "/ws" });
  render(<Pane leafId={leafId} />);
  return leafId;
}

function contentOf(leafId: string) {
  const tree = useLayoutStore.getState().tree;
  return tree ? contentIn(tree, leafId) : undefined;
}


/** jsdom's `PointerEvent` carries no button or coordinates (it does not extend
 *  MouseEvent there), and the drag controller reads all three. A MouseEvent of
 *  type "pointerdown" reaches the same React handler and does carry them. */
function pointer(type: string, target: Window | Element, x: number, y: number) {
  fireEvent(target, new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }));
}

describe("naming a terminal", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
  });

  it("renames on a double-click, like a Screen tab", async () => {
    const leafId = openTerminalPane();

    await userEvent.dblClick(screen.getByText("Terminal"));
    await userEvent.keyboard("build{Enter}");

    // Three panes all called "Terminal" say nothing about which is the build
    // and which is the server.
    await waitFor(() => expect(contentOf(leafId)).toEqual({ kind: "terminal", cwd: "/ws", name: "build" }));
    expect(screen.getByText("build")).toBeInTheDocument();
  });

  it("puts the name back when the edit is abandoned", async () => {
    const leafId = openTerminalPane();

    await userEvent.dblClick(screen.getByText("Terminal"));
    await userEvent.keyboard("scratch{Escape}");

    expect(contentOf(leafId)).toEqual({ kind: "terminal", cwd: "/ws" });
    expect(screen.getByText("Terminal")).toBeInTheDocument();
  });

  it("an emptied name goes back to calling it what it is", async () => {
    const leafId = openTerminalPane();
    useLayoutStore.getState().renamePane(leafId, "build");

    useLayoutStore.getState().renamePane(leafId, "   ");

    expect(contentOf(leafId)).toEqual({ kind: "terminal", cwd: "/ws", name: undefined });
  });
});

describe("a terminal pane can be moved and must be closed deliberately", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
  });

  it("drags by its header, like a session does", async () => {
    const leafId = openTerminalPane();
    const handle = screen.getByText("Terminal");

    // A drag begins only past a few pixels, so the double-click that renames
    // still works — the same handle does both on a session title.
    pointer("pointerdown", handle, 100, 10);
    pointer("pointermove", window, 300, 200);

    const drag = useDragPane.getState().active;
    expect(drag?.source).toEqual({ kind: "pane", leafId, sessionId: null });
    pointer("pointerup", window, 0, 0);
  });

  it("carries the name it was given onto the drag ghost", async () => {
    const leafId = openTerminalPane();
    useLayoutStore.getState().renamePane(leafId, "build");

    pointer("pointerdown", await screen.findByText("build"), 0, 0);
    pointer("pointermove", window, 200, 200);

    expect(useDragPane.getState().active?.title).toBe("build");
    pointer("pointerup", window, 0, 0);
  });
});

describe("closing a terminal", () => {
  beforeEach(() => {
    for (const id of liveTerminalIds()) destroyTerminal(id);
  });

  it("asks once the terminal has been typed into", () => {
    markTerminalUsed("p1");
    expect(isTerminalUsed("p1")).toBe(true);
  });

  it("does not ask about one nobody has touched", () => {
    // Asking about an empty slot trains the reader to dismiss the question
    // without reading it — which is what makes it useless when it matters.
    expect(isTerminalUsed("fresh")).toBe(false);
  });

  it("forgets a terminal that is gone, so the id can be reused", () => {
    markTerminalUsed("p2");
    destroyTerminal("p2");
    expect(isTerminalUsed("p2")).toBe(false);
  });
});
