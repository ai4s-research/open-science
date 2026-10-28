import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeLeaf, useLayoutStore, type LayoutGroup } from "@/lib/layout";
import { GroupTabs } from "./GroupTabs";

const screen = (id: string, projectId = ""): LayoutGroup => {
  const leaf = makeLeaf(null);
  return { id, name: id.toUpperCase(), projectId, tree: leaf, focusedLeafId: leaf.id, zoomedLeafId: null };
};
/** jsdom's PointerEvent carries no coordinates; a MouseEvent of the same type
 *  reaches the same handlers and does. */
function pointer(type: string, target: Element | Window, x: number) {
  fireEvent(target, new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 0 }));
}
const order = () => useLayoutStore.getState().groups.map((g) => g.id);

describe("Screen tab reordering", () => {
  afterEach(() => void vi.useRealTimers());
  beforeEach(() => {
    vi.useFakeTimers();
    // `x` belongs to another project and sits between this project's Screens.
    const groups = [screen("a"), screen("x", "other"), screen("b"), screen("c")];
    useLayoutStore.setState({
      groups,
      activeGroupId: "a",
      tree: groups[0].tree,
      focusedLeafId: groups[0].focusedLeafId,
      zoomedLeafId: null,
      ephemeralGroupId: null,
    });
  });

  it("moves a Screen within its project and leaves other projects' slots alone", () => {
    useLayoutStore.getState().moveGroup("a", 2);
    expect(order()).toEqual(["b", "x", "c", "a"]);
    useLayoutStore.getState().moveGroup("a", 0);
    expect(order()).toEqual(["a", "x", "b", "c"]);
  });

  it("dragging a tab past its neighbours' middles drops it there", () => {
    const { container } = render(<GroupTabs />);
    const tabs = [...container.querySelectorAll<HTMLElement>("[data-group-tab]")];
    expect(tabs.map((t) => t.dataset.groupTab)).toEqual(["a", "b", "c"]);
    // jsdom has no layout: give each tab a 100px slot.
    tabs.forEach((t, i) => {
      t.getBoundingClientRect = () => ({ left: i * 100 + 4 * i, right: i * 100 + 4 * i + 100, width: 100 }) as DOMRect;
    });

    pointer("pointerdown", tabs[0], 50);
    // Held: the grabbing hand shows at once, before any movement.
    expect(tabs[0].className).toContain("cursor-grabbing");
    pointer("pointermove", window, 260);
    // The held tab follows the pointer; the two it passed slide left.
    expect(tabs[0].style.transform).toBe("translateX(208px)");
    expect(tabs[1].style.transform).toBe("translateX(-104px)");
    expect(tabs[2].style.transform).toBe("translateX(-104px)");
    pointer("pointerup", window, 260);
    // It glides into its slot, then the order changes.
    expect(order()).toEqual(["a", "x", "b", "c"]);
    act(() => void vi.advanceTimersByTime(200));
    expect(order()).toEqual(["b", "x", "c", "a"]);
    expect(tabs.every((t) => !t.style.transform)).toBe(true);
  });

  it("a click without movement does not reorder", () => {
    const { container } = render(<GroupTabs />);
    const tab = container.querySelector<HTMLElement>('[data-group-tab="b"]')!;
    pointer("pointerdown", tab, 150);
    pointer("pointermove", window, 152);
    pointer("pointerup", window, 152);
    expect(order()).toEqual(["a", "x", "b", "c"]);
  });
});
