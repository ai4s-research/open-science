import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRuntimeStore } from "@/lib/runtime";
import { leaves, makeLeaf, useLayoutStore } from "@/lib/layout";
import type { ProjectInfo } from "@/lib/tauri";
import { renderAt } from "@/test/render";

// The folder the picker returns, per test: inside the workspace base is adopted
// straight away, outside it goes through the copy-vs-in-place dialog.
const picked = vi.hoisted(() => ({ path: "/base/My Repo" }));
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    pickFolder: () => Promise.resolve(picked.path),
    workspaceBase: () => Promise.resolve("/base"),
  };
});

const navigateSpy = vi.hoisted(() => vi.fn());
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navigateSpy };
});

const EXISTING: ProjectInfo = {
  id: "p0",
  name: "BCI Trends",
  createdAt: 1,
  path: "/base/BCI-Trends",
  imported: false,
  pinned: false,
};

const importProject = vi.fn();
const startDraftInWorkspace = vi.fn(async () => {});

/** The user is reading session "A" in the only Screen. */
function busyScreen() {
  const leaf = makeLeaf("A");
  useLayoutStore.setState({
    groups: [{ id: "g0", name: "", tree: leaf, focusedLeafId: leaf.id, zoomedLeafId: null }],
    activeGroupId: "g0",
    tree: leaf,
    focusedLeafId: leaf.id,
    zoomedLeafId: null,
    ephemeralGroupId: null,
  });
}

/** Open the sidebar's add-project menu and pick "use an existing folder". */
async function chooseImport() {
  await userEvent.click(await screen.findByRole("button", { name: "New project" }));
  await userEvent.click(await screen.findByText("Use an existing folder"));
}

beforeEach(() => {
  navigateSpy.mockClear();
  startDraftInWorkspace.mockClear();
  importProject.mockReset();
  busyScreen();
  useRuntimeStore.setState({
    projects: [EXISTING],
    sessions: [{ id: "A", title: "current work", directory: "/base/2026-07-01-0900" }],
    importProject,
    startDraftInWorkspace,
  });
});
afterEach(() => useRuntimeStore.setState({ projects: [], sessions: [], workspace: null }));

/** The imported project's own Screen: a fresh group, active, named after it,
 *  with its single draft pane aimed at the project folder. */
async function expectOwnScreen(project: ProjectInfo) {
  await waitFor(() => expect(useLayoutStore.getState().groups.length).toBe(2));
  const layout = useLayoutStore.getState();
  const group = layout.groups.find((g) => g.id === layout.activeGroupId)!;
  expect(group.id).not.toBe("g0");
  expect(group.name).toBe(project.name);
  const panes = leaves(group.tree!);
  expect(panes.map((l) => l.sessionId)).toEqual([null]);
  // The pane the user was reading stays put in its own Screen.
  expect(leaves(layout.groups[0].tree!).map((l) => l.sessionId)).toEqual(["A"]);
  // The draft slot aimed at the folder is the NEW pane's own, not the global
  // one — that is the slot the composer sends under.
  expect(startDraftInWorkspace).toHaveBeenCalledWith(project.path, `draft:${panes[0].id}`);
  expect(navigateSpy).toHaveBeenCalledWith("/live");
}

describe("Sidebar project import", () => {
  it("opens a folder adopted from inside the workspace in its own Screen", async () => {
    picked.path = "/base/My Repo";
    const adopted: ProjectInfo = {
      id: "p1",
      name: "My Repo",
      createdAt: 2,
      path: "/base/My Repo",
      imported: true,
      pinned: false,
    };
    importProject.mockResolvedValue(adopted);
    renderAt("/files");

    await chooseImport();

    // A folder already inside the workspace skips the copy-vs-in-place question.
    await waitFor(() => expect(importProject).toHaveBeenCalledWith("/base/My Repo", "in-place"));
    await expectOwnScreen(adopted);
  });

  it("opens a folder imported through the copy/in-place dialog in its own Screen", async () => {
    picked.path = "/home/me/outside";
    const imported: ProjectInfo = {
      id: "p2",
      name: "outside",
      createdAt: 3,
      path: "/home/me/outside",
      imported: true,
      pinned: false,
    };
    importProject.mockResolvedValue(imported);
    renderAt("/files");

    await chooseImport();
    await userEvent.click(await screen.findByText("Use in place"));

    await waitFor(() => expect(importProject).toHaveBeenCalledWith("/home/me/outside", "in-place"));
    await expectOwnScreen(imported);
  });

  it("leaves the layout alone when the import fails", async () => {
    picked.path = "/base/My Repo";
    importProject.mockResolvedValue(null);
    renderAt("/files");

    await chooseImport();

    await waitFor(() => expect(importProject).toHaveBeenCalled());
    expect(useLayoutStore.getState().groups.length).toBe(1);
    expect(startDraftInWorkspace).not.toHaveBeenCalled();
  });
});
