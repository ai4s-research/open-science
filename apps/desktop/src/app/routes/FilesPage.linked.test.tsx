import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { DirEntry } from "@/lib/artifactFile";
import { useLayoutStore } from "@/lib/layout";
import { useRuntimeStore } from "@/lib/runtime";
import { FilesPage, SessionFilesPane } from "./FilesPage";

const LINK: DirEntry = {
  path: "projects/bci/Spike sorting",
  name: "Spike sorting",
  isDir: true,
  size: 0,
  modified: 0,
  link: "/base/sessions/2026-10-14-2253",
};
const listDir = vi.fn(async (rel: string, _root?: string): Promise<DirEntry[]> =>
  rel === "projects/bci" || rel === "" ? [LINK] : [],
);
vi.mock("@/lib/artifactFile", () => ({
  listDir: (rel: string, root?: string) => listDir(rel, root),
}));
const unlinkProjectFolder = vi.fn(async (_id: string, _path: string) => {});
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  isTauri: true,
  workspaceBase: async () => "/base",
  unlinkProjectFolder: (id: string, path: string) => unlinkProjectFolder(id, path),
}));

beforeEach(() => {
  window.localStorage.clear();
  listDir.mockClear();
  unlinkProjectFolder.mockClear();
  useRuntimeStore.setState({
    refreshProjects: vi.fn(async () => {}),
    projects: [
      {
        id: "p1",
        name: "BCI",
        path: "/base/projects/bci",
        createdAt: 1,
        pinned: false,
        imported: false,
        linked: [
          {
            path: "/base/sessions/2026-10-14-2253",
            link: "/base/projects/bci/Spike sorting",
            sessionId: "ses_m",
            title: "Spike sorting",
            linkedAt: 1,
          },
        ],
      },
    ],
  });
});

afterEach(() => useRuntimeStore.setState({ projects: [] }));

describe("a session's folder linked into a project", () => {
  it("is one entry in the project folder, marked as linked, and opens as that folder", async () => {
    window.localStorage.setItem("openscience.files.locations.v1", JSON.stringify({ base: "projects/bci" }));
    render(<FilesPage />);

    const row = await screen.findByRole("button", { name: /Spike sorting/ });
    expect(within(row).getByText("Linked")).toHaveAttribute("title", "/base/sessions/2026-10-14-2253");
    await userEvent.click(row);
    expect(listDir).toHaveBeenLastCalledWith("projects/bci/Spike sorting", "base");
  });

  it("unlinks from its own right-click menu, after asking", async () => {
    window.localStorage.setItem("openscience.files.locations.v1", JSON.stringify({ base: "projects/bci" }));
    render(<FilesPage />);
    const row = await screen.findByRole("button", { name: /Spike sorting/ });

    await userEvent.pointer({ target: row, keys: "[MouseRight]" });
    await userEvent.click(await screen.findByRole("menuitem", { name: "Unlink" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("stay exactly where they are");
    expect(unlinkProjectFolder).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Unlink" }));

    expect(unlinkProjectFolder).toHaveBeenCalledWith("p1", "/base/sessions/2026-10-14-2253");
  });

  it("beside the conversation, opens where it really is", async () => {
    const openContentPane = vi.spyOn(useLayoutStore.getState(), "openContentPane");
    render(<SessionFilesPane sessionId="ses_m" sessionDir="/base/projects/bci" onClose={() => {}} />, {
      wrapper: MemoryRouter,
    });
    await userEvent.click(await screen.findByRole("button", { name: /Spike sorting/ }));

    // The session pane cannot leave its own folder; the explorer opens at the real one.
    expect(JSON.parse(window.localStorage.getItem("openscience.files.locations.v1")!).base).toBe(
      "sessions/2026-10-14-2253",
    );
    expect(openContentPane).toHaveBeenCalledWith({ kind: "files" });
  });
});
