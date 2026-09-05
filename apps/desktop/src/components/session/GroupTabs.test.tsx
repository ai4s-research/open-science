import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { makeLeaf, useLayoutStore } from "@/lib/layout";
import { resetParkedDrafts } from "@/lib/composerStash";
import { GroupTabs } from "./GroupTabs";

describe("GroupTabs Screen close", () => {
  beforeEach(() => {
    resetParkedDrafts();
    const first = makeLeaf("session-a");
    const second = makeLeaf("session-b");
    useLayoutStore.setState({
      groups: [
        {
          id: "screen-a",
          name: "Analysis",
          tree: first,
          focusedLeafId: first.id,
          zoomedLeafId: null,
        },
        {
          id: "screen-b",
          name: "Results",
          tree: second,
          focusedLeafId: second.id,
          zoomedLeafId: null,
        },
      ],
      activeGroupId: "screen-a",
      tree: first,
      focusedLeafId: first.id,
      zoomedLeafId: null,
      ephemeralGroupId: null,
    });
  });

  // The preview a sidebar click just opened, untouched: nothing to lose.
  it("closes an untouched preview Screen on the click", async () => {
    useLayoutStore.setState({ ephemeralGroupId: "screen-a" });
    render(<GroupTabs />);

    await userEvent.click(screen.getAllByRole("button", { name: "Close screen" })[0]);

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(useLayoutStore.getState().groups).toHaveLength(1);
    expect(useLayoutStore.getState().groups[0].id).toBe("screen-b");
  });

  it("closes an empty Screen on the click", async () => {
    useLayoutStore.setState({
      groups: [
        { id: "screen-a", name: "", tree: null, focusedLeafId: null, zoomedLeafId: null },
        useLayoutStore.getState().groups[1],
      ],
      tree: null,
    });
    render(<GroupTabs />);

    await userEvent.click(screen.getAllByRole("button", { name: "Close screen" })[0]);

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(useLayoutStore.getState().groups).toHaveLength(1);
  });

  // Anything the user has actually worked in — including every Screen a
  // relaunch restored, which is exactly where "it looked empty" went wrong.
  it("asks before closing a Screen that was worked in", async () => {
    render(<GroupTabs />);

    await userEvent.click(screen.getAllByRole("button", { name: "Close screen" })[0]);
    expect(screen.getByRole("alertdialog", { name: "Close this Screen?" })).toBeInTheDocument();
    expect(useLayoutStore.getState().groups).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useLayoutStore.getState().groups).toHaveLength(2);

    await userEvent.click(screen.getAllByRole("button", { name: "Close screen" })[0]);
    await userEvent.click(screen.getByRole("button", { name: "Close Screen" }));
    expect(useLayoutStore.getState().groups).toHaveLength(1);
  });
});

describe("GroupTabs right-click menu", () => {
  beforeEach(() => {
    const leaf = makeLeaf("session-a");
    useLayoutStore.setState({
      groups: [
        { id: "screen-a", name: "Analysis", tree: leaf, focusedLeafId: leaf.id, zoomedLeafId: null },
      ],
      activeGroupId: "screen-a",
      tree: leaf,
      focusedLeafId: leaf.id,
      zoomedLeafId: null,
      ephemeralGroupId: null,
    });
  });

  it("offers Screen actions instead of the WebView's text menu", async () => {
    render(<GroupTabs />);
    // What the user hit: right-clicking a tab selected its name and offered
    // Look Up / Translate / Search with Google.
    await userEvent.pointer({ target: screen.getByText("Analysis"), keys: "[MouseRight]" });

    const menu = await screen.findByRole("menu", { name: "Screen actions" });
    expect(menu).toHaveTextContent("Rename screen");
    expect(menu).toHaveTextContent("Close screen");
  });

  it("renames the Screen in place from the menu", async () => {
    render(<GroupTabs />);
    await userEvent.pointer({ target: screen.getByText("Analysis"), keys: "[MouseRight]" });
    await userEvent.click(await screen.findByText("Rename screen"));

    const input = await screen.findByDisplayValue("Analysis");
    await userEvent.clear(input);
    await userEvent.type(input, "Spike sorting{Enter}");

    expect(useLayoutStore.getState().groups[0].name).toBe("Spike sorting");
  });

  it("closing from the menu still asks first", async () => {
    render(<GroupTabs />);
    await userEvent.pointer({ target: screen.getByText("Analysis"), keys: "[MouseRight]" });
    await userEvent.click(await screen.findByText("Close screen"));

    expect(await screen.findByRole("alertdialog", { name: "Close this Screen?" })).toBeInTheDocument();
  });

  it("the tab strip opts out of text selection", () => {
    const { container } = render(<GroupTabs />);
    expect(container.firstElementChild?.className).toContain("select-none");
  });
});
