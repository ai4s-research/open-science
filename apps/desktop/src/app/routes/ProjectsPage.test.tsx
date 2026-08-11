import { screen, fireEvent, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useRuntimeStore } from "@/lib/runtime";
import { renderAt } from "@/test/render";

const base = {
  createdAt: 1_000,
  imported: false,
  pinned: false,
};

afterEach(() => useRuntimeStore.setState({ projects: [], sessions: [] }));

describe("ProjectsPage", () => {
  it("lists projects, filters by search, and expands sessions", async () => {
    useRuntimeStore.setState({
      projects: [
        { ...base, id: "p1", name: "Alpha", path: "/base/alpha-dir" },
        { ...base, id: "p2", name: "Beta", path: "/home/me/beta-repo", imported: true },
      ],
      sessions: [
        { id: "s1", title: "first pass", directory: "/base/alpha-dir", updated: 2_000 },
        { id: "s2", title: "second pass", directory: "/base/alpha-dir", updated: 3_000 },
      ],
    });
    renderAt("/projects");
    // Scope to the page's main region — the sidebar also lists project names.
    await screen.findByPlaceholderText("Search projects");
    const page = within(screen.getByRole("main"));

    // Both projects render; the imported one carries the source folder name.
    expect(page.getByText("Alpha")).toBeInTheDocument();
    expect(page.getByText("Beta")).toBeInTheDocument();
    expect(page.getByText("beta-repo")).toBeInTheDocument(); // Sources chip = folder basename

    // Sessions are hidden until the project row is expanded.
    expect(page.queryByText("first pass")).not.toBeInTheDocument();
    fireEvent.click(page.getByRole("button", { name: "Alpha" }));
    expect(page.getByText("second pass")).toBeInTheDocument();
    expect(page.getByText("first pass")).toBeInTheDocument();

    // Search filters the list by name.
    fireEvent.change(screen.getByPlaceholderText("Search projects"), {
      target: { value: "bet" },
    });
    expect(page.queryByText("Alpha")).not.toBeInTheDocument();
    expect(page.getByText("Beta")).toBeInTheDocument();
  });

  it("expands a Windows project's sessions across the two path spellings (#76)", async () => {
    // The project path comes from Rust (backslashes), the session directory from
    // the sidecar (forward slashes, and the drive letter's case is its own).
    // Expanding must still find the sessions — the page has its own grouping map.
    useRuntimeStore.setState({
      projects: [{ ...base, id: "w", name: "视频总结", path: "D:\\Docs\\projects\\视频总结" }],
      sessions: [
        { id: "s1", title: "clip summary", directory: "d:/Docs/projects/视频总结", updated: 2_000 },
        { id: "s2", title: "other project", directory: "D:/Docs/projects/数学建模", updated: 3_000 },
      ],
    });
    renderAt("/projects");
    await screen.findByPlaceholderText("Search projects");
    const page = within(screen.getByRole("main"));

    // The row button and its context-menu trigger share the name; the row is first.
    fireEvent.click(page.getAllByRole("button", { name: "视频总结" })[0]);
    expect(page.getByText("clip summary")).toBeInTheDocument();
    // A sibling folder is not swept in by the normalization.
    expect(page.queryByText("other project")).not.toBeInTheDocument();
  });

  it("shows an empty state when the search matches nothing", async () => {
    useRuntimeStore.setState({
      projects: [{ ...base, id: "p1", name: "Alpha", path: "/base/Alpha" }],
    });
    renderAt("/projects");
    fireEvent.change(await screen.findByPlaceholderText("Search projects"), {
      target: { value: "zzz" },
    });
    expect(screen.getByText("No projects match.")).toBeInTheDocument();
  });
});
