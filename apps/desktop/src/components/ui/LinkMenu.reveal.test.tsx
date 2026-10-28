import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileContextMenu } from "@/components/files/FileContextMenu";
import { useLinkMenu } from "@/lib/links";
import { LinkMenu } from "./LinkMenu";

const revealArtifact = vi.fn(async (_path: string, _root?: string) => {});
vi.mock("@/lib/artifactFile", () => ({
  absoluteArtifactPath: async (path: string) => `/abs/${path}`,
  openArtifactExternally: async () => {},
  revealArtifact: (path: string, root?: string) => revealArtifact(path, root),
}));
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  isTauri: true,
}));

afterEach(() => {
  revealArtifact.mockClear();
  act(() => useLinkMenu.getState().hide());
});

/** Both menus a path opens — a link's and a file's — show it in its folder. */
describe("show in folder", () => {
  it("is offered for a clicked path, and reveals that path", async () => {
    render(<LinkMenu />);
    act(() =>
      useLinkMenu
        .getState()
        .show({ kind: "path", path: "Downloads/a.xlsx", root: "home", isDir: false, display: "a.xlsx" }, 10, 10),
    );
    await userEvent.click(await screen.findByRole("menuitem", { name: "Show in folder" }));
    expect(revealArtifact).toHaveBeenCalledWith("Downloads/a.xlsx", "home");
  });

  it("is offered on right-click of a file, and reveals that file", async () => {
    render(
      <FileContextMenu entry={{ path: "Downloads/a.xlsx", isDir: false }} root="home">
        <span>Downloads/a.xlsx</span>
      </FileContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText("Downloads/a.xlsx"));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Show in folder" }));
    expect(revealArtifact).toHaveBeenCalledWith("Downloads/a.xlsx", "home");
  });
});
