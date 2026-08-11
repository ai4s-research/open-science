import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { insertLeaf, makeLeaf, useLayoutStore, type PaneNode } from "@/lib/layout";
import { PaneTree } from "./PaneTree";

// A stand-in for the real SessionView's composer: local component state, so the
// assertions below see exactly what React reconciliation preserves or discards.
vi.mock("./SessionView", () => ({
  SessionView: ({ sessionId }: { sessionId: string | null }) => {
    const [text, setText] = useState("");
    return (
      <label>
        composer {sessionId ?? "draft"}
        <input value={text} onChange={(e) => setText(e.target.value)} />
      </label>
    );
  },
}));

/** What clicking a screen tab does to the store: swap in that group's tree. */
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
    const soloA = makeLeaf("session-a");
    const soloB = makeLeaf("session-b");
    useLayoutStore.setState({
      groups: [group("screen-a", soloA), group("screen-b", soloB)],
      ephemeralGroupId: null,
    });
    activate("screen-a");
  });

  it("does not carry unsent composer text into another screen (#91)", async () => {
    const { rerender } = render(<PaneTree />);
    await userEvent.type(screen.getByRole("textbox"), "draft for screen A");
    expect(screen.getByRole("textbox")).toHaveValue("draft for screen A");

    activate("screen-b");
    rerender(<PaneTree />);

    // Screen B shows its own session, so it must show its own empty composer —
    // not screen A's unsent prompt.
    expect(screen.getByText(/composer session-b/)).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("keeps each tiled pane's composer independent within one screen", async () => {
    const first = makeLeaf("session-c");
    const tiled = insertLeaf(first, first.id, "right", makeLeaf("session-d"));
    useLayoutStore.setState({ groups: [group("screen-c", tiled)] });
    activate("screen-c");
    render(<PaneTree />);

    const [a, b] = screen.getAllByRole("textbox");
    await userEvent.type(a, "only in pane one");
    expect(a).toHaveValue("only in pane one");
    expect(b).toHaveValue("");
  });
});
