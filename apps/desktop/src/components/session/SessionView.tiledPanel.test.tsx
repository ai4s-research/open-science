import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderAt } from "@/test/render";
import { insertLeaf, leaves, makeLeaf, useLayoutStore } from "@/lib/layout";
import { useRuntimeStore } from "@/lib/runtime";
import { useUiStore } from "@/lib/store";

// COPYCAT RULE: both stores are module-global — put back what this file found.
const LAYOUT = useLayoutStore.getState();
const PANES = useRuntimeStore.getState().panes;
afterEach(() => {
  useLayoutStore.setState(LAYOUT, true);
  useRuntimeStore.setState({ panes: PANES });
  useUiStore.setState({ inspectorMaximized: null });
});

/** Two tiled panes, one with its panel opened from its header. In a tiled
 *  pane the panel fills the pane, and it must replace the conversation's
 *  header, not stack under it — one bar, whose × brings the conversation back. */
describe("a panel opened in a tiled pane", () => {
  beforeEach(() => {
    const first = makeLeaf("ses_a");
    const tree = insertLeaf(first, first.id, "right", makeLeaf("ses_b"));
    useLayoutStore.setState({
      groups: [{ id: "screen-a", name: "", tree, focusedLeafId: first.id, zoomedLeafId: null }],
      activeGroupId: "screen-a",
      tree,
      focusedLeafId: leaves(tree)[0].id,
      zoomedLeafId: null,
      ephemeralGroupId: null,
    });
  });

  it("covers the conversation header instead of stacking under it", async () => {
    renderAt("/live");
    const [first] = await screen.findAllByRole("button", { name: "Trajectory" });
    await userEvent.click(first);
    const close = await screen.findByRole("button", { name: "Close trajectory" });
    // The conversation header under the panel stays mounted (its width
    // observer stays on it) but is hidden; the other pane's header is not.
    expect(first.closest("[class*='group/header']")).toHaveClass("hidden");
    const splits = screen.getAllByRole("button", { name: /^Split right/ });
    expect(splits.filter((b) => b.closest(".hidden"))).toHaveLength(1);
    expect(splits.filter((b) => !b.closest(".hidden"))).toHaveLength(1);
    // The panel's own header is the one bar left, and it closes back to the chat.
    expect(within(close.parentElement!).getByText("Trajectory")).toBeInTheDocument();
    await userEvent.click(close);
    expect(first.closest("[class*='group/header']")).not.toHaveClass("hidden");
  });

  it("maximizes to cover the window, and only the panel that was clicked", async () => {
    renderAt("/live");
    const triggers = await screen.findAllByRole("button", { name: "Trajectory" });
    await userEvent.click(triggers[0]);
    await userEvent.click(triggers[1]);
    const [maximize] = await screen.findAllByRole("button", { name: "Maximize panel" });
    await userEvent.click(maximize);
    // One overlay, holding the clicked panel; the other stays in its pane.
    const restore = screen.getByRole("button", { name: "Restore panel" });
    expect(restore.closest(".fixed.inset-0")).not.toBeNull();
    expect(screen.getAllByRole("button", { name: "Maximize panel" })).toHaveLength(1);
    await userEvent.click(restore);
    expect(screen.queryByRole("button", { name: "Restore panel" })).toBeNull();
    expect(document.querySelector(".fixed.inset-0.z-40")).toBeNull();
  });
});
