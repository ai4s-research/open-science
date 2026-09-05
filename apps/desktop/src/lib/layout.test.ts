import { describe, it, expect, beforeEach } from "vitest";
import {
  makeLeaf,
  leaves,
  findLeaf,
  insertLeaf,
  removeLeaf,
  setSplitSizes,
  setLeafSession,
  adjacentLeafId,
  normalize,
  recentScreens,
  useLayoutStore,
  MIN_SIZE,
  type PaneNode,
  type PaneSplit,
} from "./layout";

const asSplit = (n: PaneNode): PaneSplit => {
  if (n.kind !== "split") throw new Error("expected split");
  return n;
};
const sessions = (n: PaneNode) => leaves(n).map((l) => l.sessionId);

describe("N-ary pane-tree ops", () => {
  it("insertLeaf wraps a lone leaf into a 2-child split, evenly", () => {
    const root = makeLeaf("A");
    const tree = insertLeaf(root, root.id, "right", makeLeaf("B"));
    const s = asSplit(tree);
    expect(s.dir).toBe("row");
    expect(sessions(tree)).toEqual(["A", "B"]);
    expect(s.sizes).toEqual([0.5, 0.5]);
  });

  it("insertLeaf honors edge order (left/top put the new pane first)", () => {
    const root = makeLeaf("A");
    expect(sessions(insertLeaf(root, root.id, "left", makeLeaf("B")))).toEqual(["B", "A"]);
    const top = asSplit(insertLeaf(root, root.id, "top", makeLeaf("B")));
    expect(top.dir).toBe("col");
    expect(sessions(top)).toEqual(["B", "A"]);
  });

  it("docking on the SAME axis adds an equal sibling (2→½, 3→⅓)", () => {
    let tree: PaneNode = makeLeaf("A");
    tree = insertLeaf(tree, findLeaf(tree, tree.id)!.id, "right", makeLeaf("B"));
    expect(asSplit(tree).sizes).toEqual([0.5, 0.5]);
    // Dock C to the right of B → three equal columns.
    const bId = leaves(tree)[1].id;
    tree = insertLeaf(tree, bId, "right", makeLeaf("C"));
    const s = asSplit(tree);
    expect(sessions(tree)).toEqual(["A", "B", "C"]);
    expect(s.children).toHaveLength(3);
    s.sizes.forEach((x) => expect(x).toBeCloseTo(1 / 3));
  });

  it("docking on the PERPENDICULAR axis nests a new split at that child", () => {
    let tree: PaneNode = makeLeaf("A");
    tree = insertLeaf(tree, tree.id, "right", makeLeaf("B")); // row [A, B]
    const bId = leaves(tree)[1].id;
    tree = insertLeaf(tree, bId, "bottom", makeLeaf("C")); // B becomes col [B, C]
    expect(sessions(tree)).toEqual(["A", "B", "C"]);
    const rootSplit = asSplit(tree);
    expect(rootSplit.dir).toBe("row");
    expect(rootSplit.children[0].kind).toBe("leaf"); // A
    expect(asSplit(rootSplit.children[1]).dir).toBe("col"); // [B, C]
  });

  it("insertLeaf on a missing target is a no-op", () => {
    const root = makeLeaf("A");
    expect(insertLeaf(root, "nope", "right", makeLeaf("B"))).toBe(root);
  });

  it("removeLeaf re-equalizes survivors and reports the next focus", () => {
    let tree: PaneNode = makeLeaf("A");
    tree = insertLeaf(tree, tree.id, "right", makeLeaf("B"));
    const bId = leaves(tree)[1].id;
    tree = insertLeaf(tree, bId, "right", makeLeaf("C")); // A|B|C equal thirds
    const res = removeLeaf(tree, bId); // close the middle
    expect(res).not.toBeNull();
    expect(sessions(res!.tree)).toEqual(["A", "C"]);
    asSplit(res!.tree).sizes.forEach((x) => expect(x).toBeCloseTo(0.5));
    expect(findLeaf(res!.tree, res!.nextFocusId)?.sessionId).toBe("C"); // next in order
  });

  it("removeLeaf collapses a split that falls to one child", () => {
    const root = makeLeaf("A");
    const tree = insertLeaf(root, root.id, "right", makeLeaf("B"));
    const bId = leaves(tree)[1].id;
    const res = removeLeaf(tree, bId);
    expect(res!.tree.kind).toBe("leaf");
    expect((res!.tree as { sessionId: string }).sessionId).toBe("A");
  });

  it("removeLeaf on the only leaf returns null", () => {
    const root = makeLeaf("A");
    expect(removeLeaf(root, root.id)).toBeNull();
  });

  it("normalize merges a same-direction nested split into its parent", () => {
    // Hand-build row[ row[A,B], C ] and expect it to flatten to row[A,B,C].
    let inner: PaneNode = makeLeaf("A");
    inner = insertLeaf(inner, inner.id, "right", makeLeaf("B")); // row[A,B]
    const crafted: PaneNode = {
      kind: "split",
      id: "x",
      dir: "row",
      children: [inner, makeLeaf("C")],
      sizes: [0.5, 0.5],
    };
    const flat = asSplit(normalize(crafted));
    expect(flat.dir).toBe("row");
    expect(sessions(flat)).toEqual(["A", "B", "C"]);
    expect(flat.children.every((c) => c.kind === "leaf")).toBe(true);
    expect(flat.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    // A,B each had 0.5 of the 0.5 left half → 0.25, 0.25; C → 0.5.
    expect(flat.sizes).toEqual([0.25, 0.25, 0.5]);
  });

  it("setSplitSizes clamps to MIN_SIZE and renormalizes to sum 1", () => {
    let tree: PaneNode = makeLeaf("A");
    tree = insertLeaf(tree, tree.id, "right", makeLeaf("B"));
    const id = asSplit(tree).id;
    const out = asSplit(setSplitSizes(tree, id, [0.99, 0.01]));
    expect(out.sizes[1]).toBeCloseTo(MIN_SIZE / (0.99 + MIN_SIZE));
    expect(out.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it("setLeafSession rebinds one leaf only", () => {
    let tree: PaneNode = makeLeaf("A");
    tree = insertLeaf(tree, tree.id, "right", makeLeaf("B"));
    const [a, b] = leaves(tree);
    const next = setLeafSession(tree, a.id, "A2");
    expect(sessions(next)).toEqual(["A2", "B"]);
    expect(findLeaf(next, b.id)?.sessionId).toBe("B");
  });

  it("adjacentLeafId cycles focus in visual order and wraps", () => {
    let tree: PaneNode = makeLeaf("A");
    tree = insertLeaf(tree, tree.id, "right", makeLeaf("B"));
    tree = insertLeaf(tree, leaves(tree)[1].id, "right", makeLeaf("C"));
    const [a, b, c] = leaves(tree).map((l) => l.id);
    expect(adjacentLeafId(tree, a, "next")).toBe(b);
    expect(adjacentLeafId(tree, c, "next")).toBe(a); // wrap
    expect(adjacentLeafId(tree, a, "prev")).toBe(c); // wrap
  });
});

describe("recentScreens", () => {
  it("puts the screen on display first and keeps the rest in visit order", () => {
    expect(recentScreens(["b", "c"], "a", 4)).toEqual(["a", "b", "c"]);
    expect(recentScreens(["a", "b", "c"], "c", 4)).toEqual(["c", "a", "b"]);
  });

  it("drops the oldest past the limit — but never the active screen", () => {
    // Five screens visited in turn, keeping four: the first one falls off.
    let kept: string[] = [];
    for (const id of ["s1", "s2", "s3", "s4", "s5"]) kept = recentScreens(kept, id, 4);
    expect(kept).toEqual(["s5", "s4", "s3", "s2"]);

    // Returning to the dropped one puts it back at the front (it is rebuilt).
    expect(recentScreens(kept, "s1", 4)).toEqual(["s1", "s5", "s4", "s3"]);
    // Even a nonsensical limit keeps the screen the user is looking at.
    expect(recentScreens(kept, "s1", 0)).toEqual(["s1"]);
  });
});

describe("layout store — groups", () => {
  const S = () => useLayoutStore.getState();
  beforeEach(() => {
    // Reset to a single group with one bound leaf.
    const leaf = makeLeaf("A");
    useLayoutStore.setState({
      groups: [{ id: "g0", name: "", tree: leaf, focusedLeafId: leaf.id, zoomedLeafId: null }],
      activeGroupId: "g0",
      tree: leaf,
      focusedLeafId: leaf.id,
      zoomedLeafId: null,
    });
  });

  it("addGroup creates an empty active group; the old one is untouched", () => {
    const id = S().addGroup();
    expect(S().activeGroupId).toBe(id);
    expect(S().tree).toBeNull(); // new group is empty (onboarding)
    expect(S().groups).toHaveLength(2);
    // The first group kept its pane.
    expect(S().groups[0].tree).not.toBeNull();
  });

  it("openInNewGroup gives new work its own Screen, leaving the busy pane alone", () => {
    const leafId = S().openInNewGroup(null, "Install a skill");
    expect(S().groups).toHaveLength(2);
    expect(S().activeGroupId).not.toBe("g0");
    expect(S().groups[1].name).toBe("Install a skill");
    // One draft pane, focused; the pane the user was in still shows A.
    expect(leaves(S().tree!).map((l) => l.sessionId)).toEqual([null]);
    expect(S().focusedLeafId).toBe(leafId);
    expect(leaves(S().groups[0].tree!).map((l) => l.sessionId)).toEqual(["A"]);
  });

  it("openInNewGroup fills an EMPTY active Screen instead of stacking another", () => {
    S().addGroup(); // empty, active
    S().openInNewGroup("B");
    expect(S().groups).toHaveLength(2); // no third Screen
    expect(leaves(S().tree!).map((l) => l.sessionId)).toEqual(["B"]);
  });

  it("openInNewGroup pins the tentative Screen (it is real work now)", () => {
    S().openSessionEphemeral("P");
    expect(S().ephemeralGroupId).not.toBeNull();
    S().openInNewGroup(null);
    expect(S().ephemeralGroupId).toBeNull();
  });

  it("merely looking at another Screen does not pin the tentative one (#78)", () => {
    S().openSessionEphemeral("P");
    const tentative = S().ephemeralGroupId;
    expect(tentative).not.toBeNull();

    // Glancing at another Screen and back is not work done in the preview.
    S().setActiveGroup("g0");
    expect(S().ephemeralGroupId).toBe(tentative);
    S().setActiveGroup(tentative!);
    expect(S().ephemeralGroupId).toBe(tentative);
  });

  it("repeated sidebar clicks reuse the tentative Screen instead of stacking (#78)", () => {
    S().openSessionEphemeral("P");
    const count = S().groups.length;
    S().setActiveGroup("g0");
    S().openSessionEphemeral("Q");
    S().setActiveGroup("g0");
    S().openSessionEphemeral("R");

    expect(S().groups).toHaveLength(count);
    expect(sessions(S().tree!)).toEqual(["R"]);
  });

  it("setActiveGroup swaps the mirrored tree/focus", () => {
    const id = S().addGroup(); // empty, active
    S().setActiveGroup("g0");
    expect(S().tree).not.toBeNull(); // g0's pane is back
    S().setActiveGroup(id);
    expect(S().tree).toBeNull();
  });

  it("mutations only affect the ACTIVE group", () => {
    S().addGroup(); // active empty group
    S().reset("Z"); // fill the active (empty) group
    expect(leaves(S().tree!).map((l) => l.sessionId)).toEqual(["Z"]);
    // g0 still shows A.
    expect(leaves(S().groups[0].tree!).map((l) => l.sessionId)).toEqual(["A"]);
  });

  it("dockSession fills an empty group (first drop)", () => {
    const id = S().addGroup();
    S().dockSession("", "right", "B");
    const g = S().groups.find((x) => x.id === id)!;
    expect(g.tree?.kind).toBe("leaf");
    expect(leaves(g.tree!).map((l) => l.sessionId)).toEqual(["B"]);
  });

  it("presents an artifact beside its conversation without replacing it", () => {
    const artifact = {
      kind: "artifact" as const,
      path: "figures/result.png",
      filename: "result.png",
      artifact: "figure" as const,
      tool: "present_artifact",
      presentation: { mode: "panel" as const, title: "Result" },
    };
    const leafId = S().presentArtifact("A", artifact, "right");
    expect(leafId).toBeTruthy();
    const visible = leaves(S().tree!);
    expect(visible).toHaveLength(2);
    expect(visible[0].sessionId).toBe("A");
    expect(visible[0].artifact).toBeUndefined();
    expect(visible[1].artifact).toEqual(artifact);
    expect(asSplit(S().tree!).dir).toBe("row");
  });

  it("bottom stacks the artifact below its conversation", () => {
    const artifact = {
      kind: "artifact" as const,
      path: "results/table.csv",
      filename: "table.csv",
      artifact: "table" as const,
      tool: "present_artifact",
      presentation: { mode: "panel" as const },
    };
    S().presentArtifact("A", artifact, "bottom");
    const root = asSplit(S().tree!);
    expect(root.dir).toBe("col");
    expect(leaves(root).map((leaf) => leaf.artifact?.path ?? leaf.sessionId)).toEqual([
      "A",
      "results/table.csv",
    ]);
  });

  it("refreshes an existing panel in place when the placement still holds", () => {
    const first = {
      kind: "artifact" as const,
      path: "figures/result.png",
      filename: "result.png",
      artifact: "figure" as const,
      tool: "present_artifact",
      presentation: { mode: "panel" as const, requestId: "call-1" },
    };
    const firstId = S().presentArtifact("A", first, "right");
    const second = { ...first, presentation: { mode: "panel" as const, requestId: "call-2" } };
    // Same side, then no side at all: both keep the pane (and its divider) put.
    expect(S().presentArtifact("A", second, "right")).toBe(firstId);
    expect(S().presentArtifact("A", second)).toBe(firstId);
    expect(leaves(S().tree!)).toHaveLength(2);
    expect(findLeaf(S().tree!, firstId!)?.artifact?.presentation?.requestId).toBe("call-2");
    expect(asSplit(S().tree!).dir).toBe("row");
  });

  it("moves an open panel when a later call asks for the other side", () => {
    const artifact = {
      kind: "artifact" as const,
      path: "figures/result.png",
      filename: "result.png",
      artifact: "figure" as const,
      tool: "present_artifact",
      presentation: { mode: "panel" as const },
    };
    const rightId = S().presentArtifact("A", artifact, "right");
    const bottomId = S().presentArtifact("A", artifact, "bottom");
    expect(bottomId).not.toBe(rightId);
    expect(findLeaf(S().tree!, rightId!)).toBeNull();
    const root = asSplit(S().tree!);
    expect(root.dir).toBe("col");
    expect(leaves(root).map((leaf) => leaf.artifact?.path ?? leaf.sessionId)).toEqual([
      "A",
      "figures/result.png",
    ]);
    expect(S().focusedLeafId).toBe(bottomId);
    // And back again, without leaving a stale pane behind.
    S().presentArtifact("A", artifact, "right");
    expect(leaves(S().tree!)).toHaveLength(2);
    expect(asSplit(S().tree!).dir).toBe("row");
  });

  it("creates a named Screen with the source conversation beside the artifact", () => {
    const artifact = {
      kind: "artifact" as const,
      path: "figures/result.png",
      filename: "result.png",
      artifact: "figure" as const,
      tool: "present_artifact",
      presentation: { mode: "panel" as const, title: "Result review" },
    };
    const leafId = S().presentArtifact("A", artifact, "right", "new-screen");
    expect(S().groups).toHaveLength(2);
    expect(S().activeGroupId).not.toBe("g0");
    expect(S().groups[1].name).toBe("Result review");
    expect(leaves(S().tree!).map((leaf) => leaf.artifact?.path ?? leaf.sessionId)).toEqual([
      "A",
      "figures/result.png",
    ]);
    expect(S().focusedLeafId).toBe(leafId);
    // The source Screen remains unchanged.
    expect(leaves(S().groups[0].tree!).map((leaf) => leaf.sessionId)).toEqual(["A"]);
  });

  it("closeGroup activates a neighbor and never drops below one group", () => {
    const id = S().addGroup(); // g0 + new
    S().closeGroup(id);
    expect(S().groups).toHaveLength(1);
    expect(S().activeGroupId).toBe("g0");
    // Closing the sole remaining group empties it instead of removing it.
    S().closeGroup("g0");
    expect(S().groups).toHaveLength(1);
    expect(S().tree).toBeNull();
  });

  it("closing the last pane empties the group (onboarding), not disallowed", () => {
    // g0 has a single leaf "A".
    S().closePane(S().focusedLeafId!);
    expect(S().tree).toBeNull();
    expect(S().groups[0].tree).toBeNull();
  });

  // The caller needs the id to aim the new pane's own `draft:<leafId>` folder
  // slot; there is no other handle on a pane that was just created.
  it("split returns the new leaf id, and null when there is nothing to split", () => {
    const id = S().split("row", null);
    expect(id).toBe(S().focusedLeafId);
    expect(leaves(S().tree!).map((l) => l.id)).toContain(id);

    S().closePane(S().focusedLeafId!);
    S().closePane(S().focusedLeafId!); // empty group — no focused leaf left
    expect(S().split("row", null)).toBeNull();
  });

  it("split then close re-equalizes and stays within the active group", () => {
    S().split("row", "B"); // A | B
    expect(leaves(S().tree!).map((l) => l.sessionId)).toEqual(["A", "B"]);
    asSplit(S().tree!).sizes.forEach((x) => expect(x).toBeCloseTo(0.5));
    S().closePane(S().focusedLeafId!); // close B (focused)
    expect(S().tree?.kind).toBe("leaf"); // collapsed back to A
    expect(leaves(S().tree!).map((l) => l.sessionId)).toEqual(["A"]);
  });

  it("moveLeaf re-docks within the group without duplicating", () => {
    S().split("row", "B"); // A | B, focus B
    S().split("row", "C"); // A | B | C, focus C
    const [a, , c] = leaves(S().tree!).map((l) => l.id);
    // Move C to the bottom of A → A becomes col[A, C], B stays.
    S().moveLeaf(c, a, "bottom");
    expect(leaves(S().tree!).map((l) => l.sessionId).sort()).toEqual(["A", "B", "C"]);
    expect(leaves(S().tree!)).toHaveLength(3); // no duplicate
  });

  it("setLeafZoom sets a per-leaf zoom only on that leaf", () => {
    S().split("row", "B");
    const [a, b] = leaves(S().tree!);
    S().setLeafZoom(a.id, 0.75);
    const after = leaves(S().tree!);
    expect(after.find((l) => l.id === a.id)?.zoom).toBe(0.75);
    expect(after.find((l) => l.id === b.id)?.zoom).toBeUndefined();
  });

  it("openSessionEphemeral reveals a session already on screen instead of opening another", () => {
    // Two Screens, the second tiled with the session the user clicks.
    const solo = makeLeaf("A");
    const first = makeLeaf("B");
    const tiled = insertLeaf(first, first.id, "right", makeLeaf("C"));
    useLayoutStore.setState({
      groups: [
        { id: "g0", name: "", tree: solo, focusedLeafId: solo.id, zoomedLeafId: null },
        { id: "g1", name: "", tree: tiled, focusedLeafId: first.id, zoomedLeafId: null },
      ],
      activeGroupId: "g0",
      tree: solo,
      focusedLeafId: solo.id,
      ephemeralGroupId: null,
    });

    S().openSessionEphemeral("C");

    expect(S().groups).toHaveLength(2); // no new Screen
    expect(S().activeGroupId).toBe("g1");
    const focused = findLeaf(S().tree!, S().focusedLeafId!);
    expect(focused?.sessionId).toBe("C"); // and its own pane has the focus
  });

  it("revealing a session undoes a zoom that would hide its pane", () => {
    const first = makeLeaf("B");
    const tiled = insertLeaf(first, first.id, "right", makeLeaf("C"));
    const other = leaves(tiled).find((l) => l.sessionId === "C")!;
    useLayoutStore.setState({
      groups: [{ id: "g0", name: "", tree: tiled, focusedLeafId: first.id, zoomedLeafId: first.id }],
      activeGroupId: "g0",
      tree: tiled,
      focusedLeafId: first.id,
      zoomedLeafId: first.id,
      ephemeralGroupId: null,
    });

    S().openSessionEphemeral("C");

    expect(S().focusedLeafId).toBe(other.id);
    expect(S().zoomedLeafId).toBeNull();
  });

  it("openSessionEphemeral still opens a Screen for a session nowhere in the layout", () => {
    S().openSessionEphemeral("Z");
    expect(S().groups).toHaveLength(2);
    expect(leaves(S().tree!).map((l) => l.sessionId)).toEqual(["Z"]);
    expect(S().ephemeralGroupId).toBe(S().activeGroupId);
  });

  // "Screen 3" says nothing about what is in it; a session opened from a project
  // names its Screen after that project — including when the tentative Screen is
  // reused for a session from somewhere else.
  it("names the Screen after the session's project, and relabels a reused one", () => {
    S().openSessionEphemeral("Z", "Thesis");
    expect(S().groups.find((g) => g.id === S().activeGroupId)?.name).toBe("Thesis");

    S().openSessionEphemeral("Y", "BCI trends");
    expect(S().groups).toHaveLength(2); // the tentative Screen was reused
    expect(S().groups.find((g) => g.id === S().activeGroupId)?.name).toBe("BCI trends");

    // A session that belongs to no project falls back to the numbered default.
    S().openSessionEphemeral("X");
    expect(S().groups.find((g) => g.id === S().activeGroupId)?.name).toBe("");
  });

  it("bindSession binds the pane's OWN Screen, even after switching away", () => {
    // A draft pane in g0 sends; the user moves to another Screen before the
    // session id comes back. Screens stay mounted, so that pane is still there
    // waiting for its id — binding must not miss it because another Screen is
    // active (which would leave a live conversation showing an empty draft).
    const draft = makeLeaf(null);
    useLayoutStore.setState({
      groups: [
        { id: "g0", name: "", tree: draft, focusedLeafId: draft.id, zoomedLeafId: null },
        { id: "g1", name: "", tree: makeLeaf("B"), focusedLeafId: null, zoomedLeafId: null },
      ],
    });
    S().setActiveGroup("g1");

    S().bindSession(draft.id, "created-session");

    expect(leaves(S().groups[0].tree!).map((l) => l.sessionId)).toEqual(["created-session"]);
    expect(S().activeGroupId).toBe("g1"); // the switch is not undone
    expect(leaves(S().tree!).map((l) => l.sessionId)).toEqual(["B"]);
  });

  it("persists layout to localStorage on mutation", () => {
    S().split("row", "B");
    const raw = window.localStorage.getItem("ai4s.layout.v2");
    expect(raw).toBeTruthy();
    const saved = JSON.parse(raw!);
    expect(saved.activeGroupId).toBe(S().activeGroupId);
    // The persisted active group's tree carries both sessions.
    const g = saved.groups.find((x: { id: string }) => x.id === saved.activeGroupId);
    expect(JSON.stringify(g.tree)).toContain("\"A\"");
    expect(JSON.stringify(g.tree)).toContain("\"B\"");
  });
});
