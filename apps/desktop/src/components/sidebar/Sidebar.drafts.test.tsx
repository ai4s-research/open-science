import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { draftLeafOf, selectActiveProjectId, useLayoutStore } from "@/lib/layout";
import { draftKeyFor, openDraftScreen, useRuntimeStore } from "@/lib/runtime";
import { renderAt } from "@/test/render";

const PROJECT = {
  id: "p1",
  name: "BCI Trends",
  createdAt: 1,
  path: "/base/BCI-Trends",
  imported: false,
  pinned: false,
};

const startDraftInWorkspace = vi.fn(async () => {});
const moveSessionToProject = vi.fn(async () => true);

/** One empty Default Screen — the layout a fresh launch has. */
function resetLayout() {
  useLayoutStore.setState({
    groups: [{ id: "g0", name: "", projectId: "", tree: null, focusedLeafId: null, zoomedLeafId: null }],
    activeGroupId: "g0",
    tree: null,
    focusedLeafId: null,
    zoomedLeafId: null,
    ephemeralGroupId: null,
  });
}

const draftScreens = () => useLayoutStore.getState().groups.filter((g) => draftLeafOf(g));

/** Project groups render above the "Sessions" heading, loose rows below it. */
function isUnderProject(row: HTMLElement): boolean {
  const heading = screen.getByText("Sessions");
  return Boolean(row.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING);
}

beforeEach(() => {
  resetLayout();
  startDraftInWorkspace.mockClear();
  moveSessionToProject.mockClear();
  useRuntimeStore.setState({
    projects: [PROJECT] as never,
    sessions: [],
    currentId: null,
    threads: {},
    draftWorkspaces: {},
    startDraftInWorkspace,
    moveSessionToProject,
  });
});

afterEach(() => useRuntimeStore.setState({ projects: [], sessions: [], currentId: null }));

describe("new sessions show in the sidebar at once", () => {
  it("a project's new session gets a highlighted row in that project, and its Screen is named for it", async () => {
    const user = userEvent.setup();
    renderAt("/live");
    const rail = within(await screen.findByRole("complementary"));

    await user.click(await rail.findByRole("button", { name: "New session in BCI Trends" }));

    // The one on display is the project's (the empty launch Screen became a
    // new conversation of its own, in no project).
    const row = (await rail.findAllByRole("button", { name: "New session" })).find(
      (b) => b.getAttribute("aria-current") === "page",
    )!;
    expect(isUnderProject(row)).toBe(true);
    expect(rail.queryByText("No sessions yet.")).not.toBeInTheDocument();
    // The Screen tab says what it holds, not "Screen 2".
    const tab = document.querySelector(`[data-group-tab="${useLayoutStore.getState().activeGroupId}"]`);
    expect(tab).toHaveTextContent("New session");
  });

  it("New asks where, with the project on display already chosen — Enter starts it there", async () => {
    const user = userEvent.setup();
    useLayoutStore.getState().setActiveProject("p1");
    renderAt("/live");
    const rail = within(await screen.findByRole("complementary"));

    await user.click(rail.getByRole("button", { name: "New" }));
    const picker = within(await screen.findByRole("dialog", { name: "New session" }));
    const current = picker.getByRole("option", { name: /BCI Trends/ });
    expect(current).toHaveAttribute("aria-selected", "true");
    expect(current).toHaveTextContent("Current");

    await user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog", { name: "New session" })).not.toBeInTheDocument();
    const leaf = draftLeafOf(useLayoutStore.getState().groups.find((g) => g.projectId === "p1" && draftLeafOf(g))!)!;
    expect(startDraftInWorkspace).toHaveBeenCalledWith(PROJECT.path, draftKeyFor(leaf.id));
  });

  it("New can start a session in no project, and doing it twice does not stack drafts", async () => {
    const user = userEvent.setup();
    useLayoutStore.getState().setActiveProject("p1");
    renderAt("/live");
    const rail = within(await screen.findByRole("complementary"));

    for (let i = 0; i < 2; i++) {
      await user.click(rail.getByRole("button", { name: "New" }));
      await user.click(await screen.findByRole("option", { name: /In no project/ }));
    }
    expect(selectActiveProjectId(useLayoutStore.getState())).toBe("");
    expect(draftScreens().filter((g) => g.projectId === "")).toHaveLength(1);
    expect(
      rail.getAllByRole("button", { name: "New session" }).filter((b) => !isUnderProject(b)),
    ).toHaveLength(1);
  });

  it("Esc closes the question without starting anything", async () => {
    const user = userEvent.setup();
    renderAt("/live");
    const rail = within(await screen.findByRole("complementary"));
    const before = draftScreens().length;
    await user.click(rail.getByRole("button", { name: "New" }));
    await screen.findByRole("dialog", { name: "New session" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "New session" })).not.toBeInTheDocument();
    expect(draftScreens()).toHaveLength(before);
  });

  it("the draft row hands over to the session its first send creates", async () => {
    renderAt("/live");
    const rail = within(await screen.findByRole("complementary"));
    act(() => {
      openDraftScreen("");
    });
    expect(await rail.findByRole("button", { name: "New session" })).toBeInTheDocument();

    // The graft: the session exists and is current, the pane not yet re-bound.
    act(() => {
      useRuntimeStore.setState({
        currentId: "s9",
        sessions: [{ id: "s9", title: "fresh question", directory: "/base/2026-10-17-0900" }],
      });
    });
    expect(rail.getByText("fresh question")).toBeInTheDocument();
    expect(rail.queryByRole("button", { name: "New session" })).not.toBeInTheDocument();
  });
});

describe("openDraftScreen", () => {
  it("reuses only a blank draft of the same project", () => {
    const first = openDraftScreen("");
    expect(openDraftScreen("")).toBe(first);

    // Something was sent in it: a new one.
    useRuntimeStore.setState({
      threads: { [draftKeyFor(first)]: { blocks: [{ kind: "user" }] as never, index: {}, loaded: true } },
    });
    const second = openDraftScreen("");
    expect(second).not.toBe(first);

    // Aimed at a project folder: not reused for a session in no project.
    useRuntimeStore.setState({ draftWorkspaces: { [draftKeyFor(second)]: PROJECT.path } });
    expect(openDraftScreen("")).not.toBe(second);

    // Another project's Screens are never reused.
    expect(draftLeafOf(useLayoutStore.getState().groups.find((g) => g.projectId === "p1") ?? ({} as never))).toBeFalsy();
    const inProject = openDraftScreen("p1", PROJECT.path);
    expect([first, second]).not.toContain(inProject);
  });
});

describe("dragging a session onto a project", () => {
  /** jsdom's PointerEvent carries no coordinates; a MouseEvent of the same type does. */
  const pointer = (type: string, target: Element | Window, x: number) =>
    fireEvent(target, new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 0 }));

  it("files the session there, and says so while hovering", async () => {
    useRuntimeStore.setState({
      sessions: [{ id: "s1", title: "loose question", directory: "/base/2026-10-17-0900" }],
    });
    renderAt("/files");
    const rail = within(await screen.findByRole("complementary"));
    const block = (await rail.findByText("BCI Trends")).closest<HTMLElement>("[data-drop-project]")!;
    const spy = vi.spyOn(document, "elementFromPoint").mockReturnValue(block);

    pointer("pointerdown", rail.getByText("loose question"), 0);
    pointer("pointermove", window, 40);
    expect(await screen.findByText("Move to “BCI Trends”")).toBeInTheDocument();
    pointer("pointerup", window, 40);

    expect(moveSessionToProject).toHaveBeenCalledWith("s1", PROJECT.id);
    spy.mockRestore();
  });

  it("the dropped session shows in the project at once, marked, while the move runs", async () => {
    useRuntimeStore.setState({
      sessions: [{ id: "s1", title: "loose question", directory: "/base/2026-10-17-0900" }],
      movingSessions: { s1: "p1" },
    });
    renderAt("/files");
    const rail = within(await screen.findByRole("complementary"));
    const row = (await rail.findByText("loose question")).closest("a")!;
    expect(isUnderProject(row)).toBe(true);
    expect(row).toHaveAttribute("aria-busy", "true");
    useRuntimeStore.setState({ movingSessions: {} });
  });

  it("a project the session already lives in is no drop target", async () => {
    useRuntimeStore.setState({
      sessions: [{ id: "s1", title: "inside question", directory: PROJECT.path }],
    });
    renderAt("/files");
    const rail = within(await screen.findByRole("complementary"));
    const block = (await rail.findByText("BCI Trends")).closest<HTMLElement>("[data-drop-project]")!;
    const spy = vi.spyOn(document, "elementFromPoint").mockReturnValue(block);

    pointer("pointerdown", rail.getByText("inside question"), 0);
    pointer("pointermove", window, 40);
    expect(screen.queryByText("Move to “BCI Trends”")).not.toBeInTheDocument();
    pointer("pointerup", window, 40);

    expect(moveSessionToProject).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
