import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DirEntry } from "@/lib/artifactFile";
import { FilesPage, SessionFilesPane } from "./FilesPage";

const listDir = vi.fn();
vi.mock("@/lib/artifactFile", () => ({
  listDir: (rel: string, root?: string) => listDir(rel, root),
}));
vi.mock("@/components/inspector/FilePreviewInspector", () => ({
  FilePreviewInspector: ({ data }: { data: { filename: string } }) => (
    <div data-testid="preview">preview:{data.filename}</div>
  ),
}));
vi.mock("@/components/notebook/NotebookEditor", () => ({
  NotebookEditor: ({ path }: { path: string }) => <div data-testid="nb">nb:{path}</div>,
}));

const root: DirEntry[] = [
  { path: "data", name: "data", isDir: true, size: 0, modified: 2 },
  { path: "figure.png", name: "figure.png", isDir: false, size: 2048, modified: 3 },
  { path: "run.ipynb", name: "run.ipynb", isDir: false, size: 500, modified: 1 },
];
const sub: DirEntry[] = [{ path: "data/genes.bed", name: "genes.bed", isDir: false, size: 120, modified: 4 }];

describe("FilesPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    listDir.mockReset();
    listDir.mockImplementation((rel: string) => Promise.resolve(rel === "data" ? sub : root));
  });

  it("lists workspace entries with sizes and opens a file in the previewer", async () => {
    render(<FilesPage />);
    expect(await screen.findByText("figure.png")).toBeInTheDocument();
    expect(screen.getByText("2 KB")).toBeInTheDocument();

    await userEvent.click(screen.getByText("figure.png"));
    expect(screen.getByTestId("preview")).toHaveTextContent("preview:figure.png");
  });

  it("is a plain tree in a pane: no dead preview half beside it", async () => {
    const opened = vi.fn();
    render(<FilesPage onOpenFile={opened} />);
    await userEvent.click(await screen.findByText("figure.png"));

    // The file opens BESIDE this pane, so there is nothing to preview here.
    // The column used to stay, permanently reading "Select a file to preview
    // it here" — half a pane that could never fill.
    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ name: "figure.png" }));
    expect(screen.queryByText(/Select a file/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("preview")).not.toBeInTheDocument();
  });

  it("opens notebooks in the runnable editor", async () => {
    render(<FilesPage />);
    await userEvent.click(await screen.findByText("run.ipynb"));
    expect(screen.getByTestId("nb")).toHaveTextContent("nb:run.ipynb");
  });

  it("navigates into a folder and back via the breadcrumb", async () => {
    render(<FilesPage />);
    await userEvent.click(await screen.findByText("data"));
    expect(await screen.findByText("genes.bed")).toBeInTheDocument();
    // The page is GLOBAL: every listing resolves in the base folder tree.
    expect(listDir).toHaveBeenCalledWith("data", "base");

    await userEvent.click(screen.getByRole("button", { name: "Workspace" }));
    await waitFor(() => expect(screen.getByText("figure.png")).toBeInTheDocument());
  });

  it("restores the last open directory when the global Files page is reopened", async () => {
    const first = render(<FilesPage />);
    await userEvent.click(await screen.findByText("data"));
    expect(await screen.findByText("genes.bed")).toBeInTheDocument();
    first.unmount();

    render(<FilesPage />);
    expect(await screen.findByText("genes.bed")).toBeInTheDocument();
    expect(listDir).toHaveBeenLastCalledWith("data", "base");
  });

  it("restores each session file pane to its own last open directory", async () => {
    const first = render(
      <SessionFilesPane
        sessionId="ses_1"
        sessionDir="/workspace/session-1"
        onClose={() => {}}
      />,
    );
    await userEvent.click(await screen.findByText("data"));
    expect(await screen.findByText("genes.bed")).toBeInTheDocument();
    first.unmount();

    render(
      <SessionFilesPane
        sessionId="ses_1"
        sessionDir="/workspace/session-1"
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText("genes.bed")).toBeInTheDocument();
    expect(listDir).toHaveBeenLastCalledWith("data", "workspace");
  });
});
