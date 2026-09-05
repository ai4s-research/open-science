import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { insertLeaf, makeLeaf, useLayoutStore, type PaneNode } from "@/lib/layout";
import { PaneTree } from "./PaneTree";

/** A stand-in for the real SessionView's composer: local component state, so
 *  the assertions below see exactly what React preserves or discards. It also
 *  counts its own mounts, which is the whole point of keeping screens alive. */
const mounts = new Map<string, number>();
vi.mock("./SessionView", () => ({
  SessionView: ({ sessionId, visible }: { sessionId: string | null; visible?: boolean }) => {
    const [text, setText] = useState("");
    const id = sessionId ?? "draft";
    const counted = useRef(false);
    useEffect(() => {
      if (counted.current) return;
      counted.current = true;
      mounts.set(id, (mounts.get(id) ?? 0) + 1);
    }, [id]);
    return (
      <label>
        composer {id}
        {visible === false ? " (hidden)" : ""}
        <input value={text} onChange={(e) => setText(e.target.value)} />
      </label>
    );
  },
}));

/** What LiveSessionPage renders: every screen mounted, the active one shown. */
function Screens() {
  const groups = useLayoutStore((s) => s.groups);
  const activeGroupId = useLayoutStore((s) => s.activeGroupId);
  return (
    <>
      {groups.map((g) => (
        <div key={g.id} hidden={g.id !== activeGroupId} data-testid={`screen-${g.id}`}>
          <PaneTree group={g} active={g.id === activeGroupId} laidOut />
        </div>
      ))}
    </>
  );
}

/** What clicking a screen tab does to the store: make that group the active one. */
function activate(groupId: string) {
  const g = useLayoutStore.getState().groups.find((x) => x.id === groupId)!;
  act(() =>
    useLayoutStore.setState({
      activeGroupId: g.id,
      tree: g.tree,
      focusedLeafId: g.focusedLeafId,
      zoomedLeafId: g.zoomedLeafId,
    }),
  );
}

function group(id: string, tree: PaneNode) {
  return { id, name: "", tree, focusedLeafId: tree.id, zoomedLeafId: null };
}

describe("PaneTree screen switching", () => {
  beforeEach(() => {
    mounts.clear();
    const soloA = makeLeaf("session-a");
    const soloB = makeLeaf("session-b");
    useLayoutStore.setState({
      groups: [group("screen-a", soloA), group("screen-b", soloB)],
      ephemeralGroupId: null,
    });
    activate("screen-a");
  });

  it("does not carry unsent composer text into another screen (#91)", async () => {
    render(<Screens />);
    const a = screen.getByLabelText(/composer session-a/);
    await userEvent.type(a, "draft for screen A");

    activate("screen-b");

    // Each screen has its own pane, so screen B shows its own empty composer.
    expect(screen.getByLabelText(/composer session-b/)).toHaveValue("");
    expect(screen.getByTestId("screen-screen-b")).not.toHaveAttribute("hidden");
  });

  it("keeps a background screen mounted, with its state, instead of rebuilding it", async () => {
    render(<Screens />);
    await userEvent.type(screen.getByLabelText(/composer session-a/), "half-written prompt");

    activate("screen-b");
    activate("screen-a");

    // One mount per pane for the whole trip: switching away and back is a
    // visibility change, not a teardown — so the unsent text is still there.
    expect(mounts.get("session-a")).toBe(1);
    expect(mounts.get("session-b")).toBe(1);
    expect(screen.getByLabelText(/composer session-a/)).toHaveValue("half-written prompt");
  });

  it("hides the inactive screen and tells its panes they are not on display", () => {
    render(<Screens />);

    expect(screen.getByTestId("screen-screen-b")).toHaveAttribute("hidden");
    expect(screen.getByText(/composer session-b \(hidden\)/)).toBeInTheDocument();
    expect(screen.getByTestId("screen-screen-a")).not.toHaveAttribute("hidden");
  });

  it("keeps each tiled pane's composer independent within one screen", async () => {
    const first = makeLeaf("session-c");
    const tiled = insertLeaf(first, first.id, "right", makeLeaf("session-d"));
    useLayoutStore.setState({ groups: [group("screen-c", tiled)] });
    activate("screen-c");
    render(<Screens />);

    const c = screen.getByLabelText(/composer session-c/);
    const d = screen.getByLabelText(/composer session-d/);
    await userEvent.type(c, "only in pane one");

    expect(c).toHaveValue("only in pane one");
    expect(d).toHaveValue("");
  });
});
