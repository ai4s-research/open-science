import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { makeContentLeaf, selectActiveProjectId, useLayoutStore } from "@/lib/layout";
import { useRuntimeStore } from "@/lib/runtime";
import { MemoryRouter } from "react-router-dom";
import { GroupTabs } from "@/components/session/GroupTabs";
import { isJumpChord, JumpPalette } from "./JumpPalette";

const project = (id: string, name: string) => ({
  id,
  name,
  path: `/w/${id}`,
  createdAt: 0,
  imported: false,
  pinned: false,
});

/** The palette alone, in a plain router: it needs navigation and the stores,
 *  not the whole app — whose data router cannot navigate under jsdom. */
const renderPalette = () =>
  render(
    <MemoryRouter initialEntries={["/live"]}>
      <JumpPalette />
    </MemoryRouter>,
  );

function seed() {
  // Terminal panes, not conversations: a bound session would make the page
  // fetch its history, which jsdom cannot do — noise unrelated to what is
  // tested here. Outside Tauri a terminal pane renders a placeholder.
  const a = makeContentLeaf({ kind: "terminal", name: "shell-a" });
  const b = makeContentLeaf({ kind: "terminal", name: "shell-b" });
  useLayoutStore.setState({
    groups: [
      { id: "d1", name: "Scratch", projectId: "", tree: a, focusedLeafId: a.id, zoomedLeafId: null },
      { id: "p1", name: "Folding", projectId: "P", tree: b, focusedLeafId: b.id, zoomedLeafId: null },
    ],
    activeGroupId: "d1",
    tree: a,
    focusedLeafId: a.id,
    zoomedLeafId: null,
    ephemeralGroupId: null,
  });
  useRuntimeStore.setState({ projects: [project("P", "Protein"), project("Q", "Quantum")] });
}

describe("⌘J jump palette", () => {
  beforeEach(seed);

  it("uses ⌘J on macOS and Ctrl+Shift+J elsewhere, never a bare Ctrl+J (a line feed)", () => {
    const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", { key: "j", ...init });
    // jsdom is not a Mac.
    expect(isJumpChord(key({ ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isJumpChord(key({ ctrlKey: true }))).toBe(false);
    expect(isJumpChord(key({}))).toBe(false);
  });

  it("opens on the chord, finds a project by name, and switches to it", async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard("{Control>}{Shift>}j{/Shift}{/Control}");
    const input = await screen.findByPlaceholderText("Search projects, screens, sessions…");

    await user.type(input, "quant");
    const list = screen.getByRole("listbox");
    expect(within(list).getByText("Quantum")).toBeInTheDocument();
    expect(within(list).queryByText("Folding")).not.toBeInTheDocument();

    await user.keyboard("{Enter}");
    expect(selectActiveProjectId(useLayoutStore.getState())).toBe("Q");
    expect(screen.queryByPlaceholderText(/Search projects, screens/)).not.toBeInTheDocument();
  });

  it("empty, it shows only the quick actions and recent conversations; typing reaches everything", async () => {
    const user = userEvent.setup();
    useRuntimeStore.setState({
      sessions: [{ id: "s1", title: "Fold the thing", directory: "/w/P", updated: 5 }],
    });
    renderPalette();
    await user.keyboard("{Control>}{Shift>}j{/Shift}{/Control}");
    const input = await screen.findByPlaceholderText(/Search projects, screens/);
    const list = screen.getByRole("listbox");
    expect(within(list).getByText("Recent")).toBeInTheDocument();
    expect(within(list).getByText("Fold the thing")).toBeInTheDocument();
    expect(within(list).queryByText("Projects")).not.toBeInTheDocument();
    expect(within(list).queryByText("Quantum")).not.toBeInTheDocument();

    await user.type(input, "quant");
    expect(within(list).getByText("Quantum")).toBeInTheDocument();
    // …and a new session there, found by the project's name.
    expect(within(list).getByText("New session in Quantum")).toBeInTheDocument();
  });

  it("⌘↵ opens a conversation that is not open anywhere beside the current pane", async () => {
    const user = userEvent.setup();
    useRuntimeStore.setState({
      sessions: [{ id: "s9", title: "Closed analysis", directory: "/w/P", updated: 5 }],
    });
    renderPalette();
    await user.keyboard("{Control>}{Shift>}j{/Shift}{/Control}");
    const input = await screen.findByPlaceholderText(/Search projects, screens/);
    await user.type(input, "closed analysis");
    await user.keyboard("{Control>}{Enter}{/Control}");
    const { tree } = useLayoutStore.getState();
    // The terminal stays; the conversation docks beside it.
    expect(tree?.kind).toBe("split");
  });

  it("jumps to a Screen in another project, switching the project with it", async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard("{Control>}{Shift>}j{/Shift}{/Control}");
    const input = await screen.findByPlaceholderText(/Search projects, screens/);
    await user.type(input, "folding");
    await user.keyboard("{Enter}");
    expect(useLayoutStore.getState().activeGroupId).toBe("p1");
    expect(selectActiveProjectId(useLayoutStore.getState())).toBe("P");
  });

  it("Esc closes it, and is consumed so it cannot also interrupt a running turn", async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard("{Control>}{Shift>}j{/Shift}{/Control}");
    await screen.findByPlaceholderText(/Search projects, screens/);
    // What the session page checks before interrupting on Esc.
    let seenByPage: boolean | null = null;
    const page = (e: KeyboardEvent) => {
      if (e.key === "Escape") seenByPage = e.defaultPrevented;
    };
    window.addEventListener("keydown", page);
    await user.keyboard("{Escape}");
    window.removeEventListener("keydown", page);
    expect(seenByPage).toBe(true);
    expect(screen.queryByPlaceholderText(/Search projects, screens/)).not.toBeInTheDocument();
  });
});

describe("the Screen bar is the active project's", () => {
  beforeEach(seed);

  it("shows only the active project's Screens, and the project it is showing", () => {
    render(<GroupTabs />);
    expect(screen.getByText("Scratch")).toBeInTheDocument();
    expect(screen.queryByText("Folding")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch project" })).toHaveTextContent("Default");

    act(() => useLayoutStore.getState().setActiveProject("P"));
    expect(screen.getByText("Folding")).toBeInTheDocument();
    expect(screen.queryByText("Scratch")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch project" })).toHaveTextContent("Protein");
  });

  it("switches project from its menu", async () => {
    const user = userEvent.setup();
    render(<GroupTabs />);
    await user.click(screen.getByRole("button", { name: "Switch project" }));
    await user.click(await screen.findByRole("menuitem", { name: "Protein" }));
    expect(selectActiveProjectId(useLayoutStore.getState())).toBe("P");
  });
});
