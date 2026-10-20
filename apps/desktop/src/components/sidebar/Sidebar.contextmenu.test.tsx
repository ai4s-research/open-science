import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRuntimeStore } from "@/lib/runtime";
import { renderAt } from "@/test/render";

const setSessionArchived = vi.fn(async () => true);
const moveSessionToProject = vi.fn(async () => true);
const renameSession = vi.fn(async () => true);
const setProjectPinned = vi.fn(async () => {});

/** Right-click a row and wait for its own menu. */
async function menuOn(text: string) {
  await userEvent.pointer({ target: screen.getByText(text), keys: "[MouseRight]" });
  return within(await screen.findByRole("menu"));
}

beforeEach(() => {
  [setSessionArchived, moveSessionToProject, renameSession, setProjectPinned].forEach((m) =>
    m.mockClear(),
  );
  useRuntimeStore.setState({
    setSessionArchived,
    moveSessionToProject,
    renameSession,
    setProjectPinned,
    projects: [
      { id: "p1", name: "BCI trends", path: "/work/bci", createdAt: 1, pinned: false },
    ] as never,
    sessions: [{ id: "s1", title: "spike sorting", updated: 2 }],
  });
});

afterEach(() => useRuntimeStore.setState({ sessions: [], projects: [] }));

describe("sidebar right-click menus", () => {
  it("a session offers session actions, not a link menu", async () => {
    renderAt("/skills");
    const menu = await menuOn("spike sorting");

    // The WebView used to answer with Open Link / Download Linked File here.
    expect(menu.getByText("Rename")).toBeInTheDocument();
    expect(menu.getByText("Add to project")).toBeInTheDocument();
    expect(menu.getByText("Archive")).toBeInTheDocument();
    expect(menu.getByText("Delete")).toBeInTheDocument();
  });

  it("archiving from the session menu asks first and says where it goes", async () => {
    renderAt("/skills");
    const menu = await menuOn("spike sorting");
    await userEvent.click(menu.getByText("Archive"));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Archive this session?");
    expect(dialog).toHaveTextContent("Show archived");
    expect(setSessionArchived).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
    expect(setSessionArchived).toHaveBeenCalledWith("s1", true);
  });

  it("deleting from the session menu asks first", async () => {
    renderAt("/skills");
    const menu = await menuOn("spike sorting");
    await userEvent.click(menu.getByText("Delete"));

    expect(await screen.findByRole("alertdialog")).toHaveTextContent("Delete session?");
  });

  it("a project offers project actions instead", async () => {
    renderAt("/skills");
    const menu = await menuOn("BCI trends");

    expect(menu.getByText("New session")).toBeInTheDocument();
    expect(menu.getByText("Open folder")).toBeInTheDocument();
    expect(menu.getByText("Pin")).toBeInTheDocument();
    expect(menu.getByText("Remove")).toBeInTheDocument();
    // A session's actions have no business on a project.
    expect(menu.queryByText("Archive")).not.toBeInTheDocument();
  });

  it("removing a project asks first — it is destructive", async () => {
    renderAt("/skills");
    const menu = await menuOn("BCI trends");
    await userEvent.click(menu.getByText("Remove"));

    expect(await screen.findByRole("alertdialog")).toHaveTextContent("Remove BCI trends?");
  });

  it("the rail opts out of text selection so a right-click leaves no highlight", () => {
    renderAt("/skills");
    expect(screen.getByRole("complementary").className).toContain("select-none");
  });
});
