import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { makeLeaf, useLayoutStore } from "@/lib/layout";
import { GroupTabs } from "./GroupTabs";

describe("GroupTabs Screen close", () => {
  beforeEach(() => {
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

  it("keeps the Screen until the user confirms", async () => {
    render(<GroupTabs />);

    await userEvent.click(screen.getAllByRole("button", { name: "Close screen" })[0]);
    expect(screen.getByRole("alertdialog", { name: "Close this Screen?" })).toBeInTheDocument();
    expect(useLayoutStore.getState().groups).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useLayoutStore.getState().groups).toHaveLength(2);

    await userEvent.click(screen.getAllByRole("button", { name: "Close screen" })[0]);
    await userEvent.click(screen.getByRole("button", { name: "Close Screen" }));
    expect(useLayoutStore.getState().groups).toHaveLength(1);
    expect(useLayoutStore.getState().groups[0].id).toBe("screen-b");
  });
});
