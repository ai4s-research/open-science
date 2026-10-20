import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { draftLeafOf, useLayoutStore } from "@/lib/layout";
import { useRuntimeStore } from "@/lib/runtime";
import { renderAt } from "@/test/render";

const PROJECT = { id: "p1", name: "BCI Trends", createdAt: 1, path: "/base/projects/bci", imported: false, pinned: false };
const startDraftInWorkspace = vi.fn(async () => {});

/** One Screen of `projectId`, holding nothing. */
function emptyScreen(projectId: string) {
  useLayoutStore.setState({
    groups: [{ id: "g0", name: "", projectId, tree: null, focusedLeafId: null, zoomedLeafId: null }],
    activeGroupId: "g0",
    tree: null,
    focusedLeafId: null,
    zoomedLeafId: null,
    ephemeralGroupId: null,
  });
}

/** The home, not the sidebar or the Screen bar. */
const home = async () => within((await screen.findByRole("heading", { level: 1 })).closest("[data-empty-group]") as HTMLElement);

beforeEach(() => {
  startDraftInWorkspace.mockClear();
  useRuntimeStore.setState({
    projects: [PROJECT] as never,
    startDraftInWorkspace,
    sessions: [
      ...Array.from({ length: 7 }, (_, i) => ({
        id: `s${i}`,
        title: `analysis ${i}`,
        directory: PROJECT.path,
        updated: 1000 + i,
      })),
      { id: "loose", title: "quick question", directory: "/base/sessions/2026-10-18-0900", updated: 5000 },
    ],
  });
});

afterEach(() => useRuntimeStore.setState({ projects: [], sessions: [] }));

describe("a project's home", () => {
  it("says which project and folder you are in, and lists its latest sessions", async () => {
    emptyScreen("p1");
    renderAt("/live");
    const view = await home();

    expect(view.getByRole("heading", { name: "BCI Trends" })).toBeInTheDocument();
    expect(view.getByText("/base/projects/bci")).toBeInTheDocument();
    expect(view.getByText("7 sessions")).toBeInTheDocument();
    // Its own six newest, newest first; nothing from outside the project.
    const titles = view.getAllByText(/^analysis \d$/).map((n) => n.textContent);
    expect(titles).toEqual(["analysis 6", "analysis 5", "analysis 4", "analysis 3", "analysis 2", "analysis 1"]);
    expect(view.queryByText("quick question")).not.toBeInTheDocument();
    expect(view.getByRole("button", { name: "All 7" })).toBeInTheDocument();
    // The Screen tab says Home, not "Screen 1".
    expect(document.querySelector('[data-group-tab="g0"]')).toHaveTextContent("Home");
  });

  it("is called Home in the Screen bar, even on a Screen that was once named", async () => {
    emptyScreen("p1");
    useLayoutStore.setState((s) => ({ groups: s.groups.map((g) => ({ ...g, name: "BCI Trends" })) }));
    renderAt("/live");
    await home();
    expect(document.querySelector('[data-group-tab="g0"]')).toHaveTextContent("Home");
  });

  it("stays a home — it does not turn into a new conversation by itself", async () => {
    emptyScreen("p1");
    renderAt("/live");
    await home();
    expect(useLayoutStore.getState().groups[0].tree).toBeNull();
    expect(startDraftInWorkspace).not.toHaveBeenCalled();
  });

  it("starts a new conversation in the project on request", async () => {
    emptyScreen("p1");
    renderAt("/live");
    await userEvent.click((await home()).getByRole("button", { name: "New session" }));

    const leaf = draftLeafOf(useLayoutStore.getState().groups.find((g) => g.projectId === "p1")!)!;
    expect(leaf).not.toBeNull();
    expect(startDraftInWorkspace).toHaveBeenCalledWith(PROJECT.path, `draft:${leaf.id}`);
  });

  it("opens a recent session from the list", async () => {
    emptyScreen("p1");
    renderAt("/live");
    await userEvent.click((await home()).getByText("analysis 6"));
    const { groups, activeGroupId } = useLayoutStore.getState();
    const tree = groups.find((g) => g.id === activeGroupId)?.tree;
    expect(tree?.kind === "leaf" && tree.sessionId).toBe("s6");
  });

  it("Default's home holds the sessions filed in no project", async () => {
    emptyScreen("");
    renderAt("/live");
    const view = await home();
    expect(view.getByRole("heading", { name: "Default" })).toBeInTheDocument();
    expect(view.getByText("1 session in no project")).toBeInTheDocument();
    expect(view.getByText("quick question")).toBeInTheDocument();
    expect(view.queryByText("analysis 6")).not.toBeInTheDocument();
  });
});
