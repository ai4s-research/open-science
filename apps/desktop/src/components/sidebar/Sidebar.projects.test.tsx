import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useRuntimeStore } from "@/lib/runtime";
import { renderAt } from "@/test/render";

const PROJECT = {
  id: "p1",
  name: "BCI Trends",
  createdAt: 1,
  path: "/base/BCI-Trends",
  imported: false,
  pinned: false,
};

afterEach(() =>
  useRuntimeStore.setState({ projects: [], sessions: [], workspace: null }),
);

/** Whether a session row sits in a project group rather than in the flat list.
 *  Project groups render above the "Sessions" heading, loose rows below it — so
 *  document order is what distinguishes "grouped" from merely "on screen". */
function isUnderProject(title: string): boolean {
  const heading = screen.getByText("Sessions");
  const row = screen.getByText(title);
  return Boolean(
    row.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
}

describe("Sidebar projects", () => {
  it("groups sessions into their project and keeps the rest loose", async () => {
    useRuntimeStore.setState({
      projects: [PROJECT],
      sessions: [
        { id: "in", title: "paper search", directory: PROJECT.path },
        { id: "out", title: "quick question", directory: "/base/2026-07-01-0900" },
        // Subagent sessions never get a row, project or not.
        { id: "child", title: "subtask", directory: PROJECT.path, parentId: "in" },
      ],
    });
    renderAt("/files");

    expect(await screen.findByText("BCI Trends")).toBeInTheDocument();
    // Both groups render their sessions; the child session does not appear.
    expect(screen.getByText("paper search")).toBeInTheDocument();
    expect(screen.getByText("quick question")).toBeInTheDocument();
    expect(screen.queryByText("subtask")).not.toBeInTheDocument();
    // The project offers its own "new session" entry point.
    expect(
      screen.getByRole("button", { name: "New session in BCI Trends" }),
    ).toBeInTheDocument();
  });

  it("groups a Windows project's sessions despite the two path spellings (#76)", async () => {
    // The reported shape: Rust `canonicalize()` gives the project a backslash
    // path, the sidecar reports the session directory with forward slashes, and
    // the drive letter's case need not agree either. One folder, three spellings
    // — an exact string match found none of them and every project read "no
    // sessions". A CJK project name, as in the report.
    useRuntimeStore.setState({
      projects: [
        {
          ...PROJECT,
          id: "win",
          name: "视频总结",
          path: "D:\\Openscience-documents\\projects\\视频总结",
        },
      ],
      sessions: [
        { id: "s1", title: "summarize clip", directory: "D:/Openscience-documents/projects/视频总结" },
        { id: "s2", title: "trailing slash", directory: "d:/Openscience-documents/projects/视频总结/" },
        // A sibling folder must NOT be pulled in by the normalization.
        { id: "other", title: "different project", directory: "D:/Openscience-documents/projects/数学建模" },
      ],
    });
    renderAt("/files");

    expect(await screen.findByText("视频总结")).toBeInTheDocument();
    // Grouped rows render inside the project, above the flat "Sessions" heading;
    // ungrouped ones fall below it. Presence alone proves nothing — an unmatched
    // session is still on screen, just in the wrong place, which is exactly how
    // the bug looked.
    expect(isUnderProject("summarize clip")).toBe(true);
    expect(isUnderProject("trailing slash")).toBe(true);
    // A sibling folder must NOT be pulled in by the normalization.
    expect(isUnderProject("different project")).toBe(false);
    expect(screen.queryByText("No sessions yet.")).not.toBeInTheDocument();
  });

  it("marks the active project when the runtime spells the path differently (#76)", async () => {
    useRuntimeStore.setState({
      projects: [{ ...PROJECT, path: "D:\\base\\BCI-Trends" }],
      // What `set_workspace` returned before #76: the verbatim form.
      workspace: "\\\\?\\D:\\base\\BCI-Trends",
    });
    renderAt("/files");
    await screen.findByText("BCI Trends");
    // Being the active project tints the row's folder icon with the accent.
    const row = screen.getByText("BCI Trends").closest("div");
    expect(row?.querySelector(".text-accent")).not.toBeNull();
  });

  it("offers a new-project entry when no projects exist yet", async () => {
    renderAt("/files");
    // Header [+] (the add-project menu trigger) plus the ghost row.
    expect((await screen.findAllByRole("button", { name: "New project" })).length).toBeGreaterThan(0);
  });

  it("badges an imported project (referenced in place, not auto-committed)", async () => {
    useRuntimeStore.setState({
      projects: [{ ...PROJECT, id: "p2", name: "My Repo", path: "/home/me/my-repo", imported: true }],
    });
    renderAt("/files");
    expect(await screen.findByText("My Repo")).toBeInTheDocument();
    expect(screen.getByText("imported")).toBeInTheDocument();
  });
});
