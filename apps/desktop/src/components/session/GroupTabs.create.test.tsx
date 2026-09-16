import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useLayoutStore } from "@/lib/layout";
import { GroupTabs } from "./GroupTabs";

// No Tauri: agent detection answers "none installed", which is the shape most
// machines have and keeps these tests about the create items themselves.
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  isTauri: false,
}));

const createNotebook = vi.fn(async () => "notebook.ipynb");
const createMarkdown = vi.fn(async () => "note.md");
vi.mock("@/lib/newFile", () => ({
  createNotebook: () => createNotebook(),
  createMarkdown: () => createMarkdown(),
}));

/** The Screen the layout is showing, and what its single pane holds. */
function activeContent() {
  const { groups, activeGroupId } = useLayoutStore.getState();
  const group = groups.find((g) => g.id === activeGroupId);
  return group?.tree?.kind === "leaf" ? group.tree.content : undefined;
}

async function openCreateMenu() {
  await userEvent.click(screen.getByRole("button", { name: "New screen" }));
}

describe("the Screen bar's create menu", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
    useLayoutStore.setState({ groups: [], activeGroupId: "", tree: null, focusedLeafId: null });
    useLayoutStore.getState().addGroup();
    createNotebook.mockClear();
    createMarkdown.mockClear();
  });

  it("offers the surfaces a pane can hold", async () => {
    render(<GroupTabs />);
    await openCreateMenu();

    for (const label of ["New screen", "Terminal", "Files", "New Notebook", "New Markdown"]) {
      expect(await screen.findByRole("menuitem", { name: label })).toBeInTheDocument();
    }
    // The browser pane was removed: a native webview floated above every menu
    // and dialog in the app, which no amount of positioning fixes.
    expect(screen.queryByRole("menuitem", { name: /Browser/ })).not.toBeInTheDocument();
  });

  it("opens a terminal in a NEW Screen, leaving the current layout alone", async () => {
    const before = useLayoutStore.getState().activeGroupId;
    render(<GroupTabs />);
    await openCreateMenu();

    await userEvent.click(await screen.findByRole("menuitem", { name: "Terminal" }));

    // The Screen bar makes Screens; splitting is the pane's own gesture.
    expect(useLayoutStore.getState().activeGroupId).not.toBe(before);
    expect(activeContent()).toEqual({ kind: "terminal", cwd: undefined });
    expect(useLayoutStore.getState().groups.find((g) => g.id === before)?.tree).toBeNull();
  });

  it("writes a notebook first, then opens the file it wrote", async () => {
    render(<GroupTabs />);
    await openCreateMenu();

    await userEvent.click(await screen.findByRole("menuitem", { name: "New Notebook" }));

    await waitFor(() => expect(createNotebook).toHaveBeenCalledTimes(1));
    // The pane opens what exists on disk — not an unsaved buffer the agent
    // could never see.
    await waitFor(() =>
      expect(activeContent()).toEqual({
        kind: "notebook",
        path: "notebook.ipynb",
        root: "workspace",
      }),
    );
  });

  it("writes a markdown file, then opens it in an editor pane", async () => {
    render(<GroupTabs />);
    await openCreateMenu();

    await userEvent.click(await screen.findByRole("menuitem", { name: "New Markdown" }));

    await waitFor(() => expect(createMarkdown).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(activeContent()).toEqual({ kind: "editor", path: "note.md", root: "workspace" }),
    );
  });

  it("still makes a plain empty Screen", async () => {
    render(<GroupTabs />);
    await openCreateMenu();

    await userEvent.click(await screen.findByRole("menuitem", { name: "New screen" }));

    expect(activeContent()).toBeUndefined();
  });
});

describe("a Screen is named after what it holds", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
    useLayoutStore.setState({ groups: [], activeGroupId: "", tree: null, focusedLeafId: null });
    useLayoutStore.getState().addGroup();
  });

  it("calls a terminal Screen Terminal, not Screen 2", async () => {
    render(<GroupTabs />);
    await openCreateMenu();

    await userEvent.click(await screen.findByRole("menuitem", { name: "Terminal" }));

    // "Screen 2" says nothing; the tab strip is where you look to find the
    // terminal again.
    expect(await screen.findByText("Terminal")).toBeInTheDocument();
  });

  it("names a file Screen after the file", async () => {
    useLayoutStore.getState().addGroup({ kind: "editor", path: "notes/report.md" });
    render(<GroupTabs />);

    expect(await screen.findByText("report.md")).toBeInTheDocument();
  });

  it("follows the pane when it changes file", async () => {
    useLayoutStore.getState().addGroup({ kind: "editor", path: "a.md" });
    render(<GroupTabs />);
    await screen.findByText("a.md");

    // The name is derived, not stored, so reusing the document pane renames
    // its Screen with it.
    useLayoutStore.getState().showDocumentPane({ kind: "notebook", path: "b.ipynb" });

    expect(await screen.findByText("b.ipynb")).toBeInTheDocument();
  });

  it("leaves a name the user typed alone", async () => {
    const id = useLayoutStore.getState().addGroup({ kind: "terminal" });
    useLayoutStore.getState().renameGroup(id, "Build");
    render(<GroupTabs />);

    expect(await screen.findByText("Build")).toBeInTheDocument();
    expect(screen.queryByText("Terminal")).not.toBeInTheDocument();
  });
});
