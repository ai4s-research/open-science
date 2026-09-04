import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { insertLeaf, leaves, makeLeaf, useLayoutStore } from "@/lib/layout";
import { PaneTree } from "./PaneTree";

vi.mock("./SessionView", () => ({
  SessionView: ({ onClose }: { onClose?: () => void }) => (
    <button onClick={onClose} disabled={!onClose}>
      Request close
    </button>
  ),
}));

/** A pane bound to a session; the fixture below tiles two of them. */
const boundPanes = () => {
  const first = makeLeaf("session-a");
  return insertLeaf(first, first.id, "right", makeLeaf("session-b"));
};

/** What LiveSessionPage renders: every screen mounted, the active one shown. */
function Screens() {
  const groups = useLayoutStore((s) => s.groups);
  const activeGroupId = useLayoutStore((s) => s.activeGroupId);
  return (
    <>
      {groups.map((g) => (
        <div key={g.id} hidden={g.id !== activeGroupId}>
          <PaneTree group={g} active={g.id === activeGroupId} laidOut />
        </div>
      ))}
    </>
  );
}

describe("PaneTree panel close", () => {
  beforeEach(() => {
    const tree = boundPanes();
    const first = leaves(tree)[0];
    useLayoutStore.setState({
      groups: [{ id: "screen-a", name: "", tree, focusedLeafId: first.id, zoomedLeafId: null }],
      activeGroupId: "screen-a",
      tree,
      focusedLeafId: first.id,
      zoomedLeafId: null,
      ephemeralGroupId: null,
    });
  });

  it("keeps a Session panel until the user confirms", async () => {
    render(<Screens />);
    await userEvent.click(screen.getAllByRole("button", { name: "Request close" })[0]);
    expect(screen.getByRole("alertdialog", { name: "Close this panel?" })).toBeInTheDocument();
    expect(leaves(useLayoutStore.getState().tree!)).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(leaves(useLayoutStore.getState().tree!)).toHaveLength(1);
  });

  // A split nobody used holds nothing: no session, no unsent line. Asking about
  // it is the same friction the Screen close just lost.
  it("closes an empty split pane on the click", async () => {
    const first = makeLeaf("session-a");
    const withDraft = insertLeaf(first, first.id, "right", makeLeaf(null));
    useLayoutStore.setState({
      groups: [{ id: "screen-a", name: "", tree: withDraft, focusedLeafId: first.id, zoomedLeafId: null }],
      tree: withDraft,
      focusedLeafId: first.id,
    });
    render(<Screens />);

    // The second pane is the unbound one.
    await userEvent.click(screen.getAllByRole("button", { name: "Request close" })[1]);

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(leaves(useLayoutStore.getState().tree!)).toHaveLength(1);
  });
});
