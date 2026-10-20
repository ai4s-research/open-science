import { beforeEach, describe, expect, it } from "vitest";
import { useLayoutStore, type LayoutGroup } from "./layout";
import { pruneUntouchedDrafts, useRuntimeStore } from "./runtime";
import { parkDraft, resetParkedDrafts } from "./composerStash";

const draft = (id: string, projectId = ""): LayoutGroup => ({
  id,
  name: "",
  projectId,
  tree: { kind: "leaf", id: `leaf-${id}`, sessionId: null },
  focusedLeafId: `leaf-${id}`,
  zoomedLeafId: null,
});
const conversation = (id: string, projectId = ""): LayoutGroup => ({
  id,
  name: "",
  projectId,
  tree: { kind: "leaf", id: `leaf-${id}`, sessionId: `ses_${id}` },
  focusedLeafId: `leaf-${id}`,
  zoomedLeafId: null,
});

function layout(groups: LayoutGroup[], activeGroupId: string) {
  const active = groups.find((g) => g.id === activeGroupId)!;
  useLayoutStore.setState({
    groups,
    activeGroupId,
    tree: active.tree,
    focusedLeafId: active.focusedLeafId,
    zoomedLeafId: null,
    ephemeralGroupId: null,
  });
}
const ids = () => useLayoutStore.getState().groups.map((g) => g.id);

beforeEach(() => {
  resetParkedDrafts();
  useRuntimeStore.setState({ threads: {}, sendingSessions: {}, currentId: null });
});

describe("a new conversation nobody touched", () => {
  it("goes away when the user leaves it", () => {
    layout([draft("d"), conversation("c")], "d");
    useLayoutStore.getState().setActiveGroup("c");
    expect(ids()).toEqual(["c"]);
  });

  it("as its project's only Screen, leaves the project's home behind", () => {
    layout([draft("d", "p1"), conversation("c", "p2")], "d");
    useLayoutStore.getState().setActiveGroup("c");
    const left = useLayoutStore.getState().groups.find((g) => g.id === "d")!;
    expect(left.tree).toBeNull();
  });

  it("stays when something is typed or attached", () => {
    layout([draft("d"), conversation("c")], "d");
    parkDraft("draft:leaf-d", { text: "half a question", files: [] });
    useLayoutStore.getState().setActiveGroup("c");
    expect(ids()).toEqual(["d", "c"]);
  });

  it("stays once something was sent", () => {
    layout([draft("d"), conversation("c")], "d");
    useRuntimeStore.setState({
      threads: { "draft:leaf-d": { blocks: [{ kind: "user" }] as never, index: {}, loaded: true } },
    });
    useLayoutStore.getState().setActiveGroup("c");
    expect(ids()).toEqual(["d", "c"]);
  });

  it("stays while its first send has just created the session it now shows", () => {
    layout([draft("d"), conversation("c")], "d");
    useRuntimeStore.setState({ currentId: "ses_new" });
    useLayoutStore.getState().setActiveGroup("c");
    expect(ids()).toEqual(["d", "c"]);
  });

  it("left over from the last run is dropped at launch — except the one on display", () => {
    layout([draft("a"), conversation("c"), draft("b")], "b");
    pruneUntouchedDrafts();
    expect(ids()).toEqual(["c", "b"]);
  });
});
