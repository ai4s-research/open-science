// Tauri's drag region applies to DIRECT clicks only: it walks the composed path
// and requires the element carrying the attribute to BE the event target. The
// tab row is `flex-1`, so it covers the whole header beside the tabs — without
// its own attribute the only draggable part of the header was the hairline
// above and below that row, which is what dragging the window felt like.
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeLeaf, useLayoutStore } from "@/lib/layout";
import { GroupTabs } from "./GroupTabs";

vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>();
  return { ...actual, useOverlayTitlebar: () => true };
});

describe("GroupTabs window-drag surface", () => {
  beforeEach(() => {
    const leaf = makeLeaf("session-a");
    useLayoutStore.setState({
      groups: [{ id: "screen-a", name: "Analysis", tree: leaf, focusedLeafId: leaf.id, zoomedLeafId: null }],
      activeGroupId: "screen-a",
      tree: leaf,
      focusedLeafId: leaf.id,
      zoomedLeafId: null,
      ephemeralGroupId: null,
    });
  });

  it("makes the empty space beside the tabs draggable, not just the strip's edges", () => {
    const { container } = render(<GroupTabs />);
    const strip = container.firstElementChild!;
    expect(strip.hasAttribute("data-tauri-drag-region")).toBe(true);

    // The row that spans the remaining width must carry it too, or clicking
    // anywhere in that space hits an element Tauri will not drag from.
    const row = strip.querySelector<HTMLElement>(".flex-1");
    expect(row).not.toBeNull();
    expect(row!.hasAttribute("data-tauri-drag-region")).toBe(true);
  });

  it("leaves the tabs and the + button undraggable", () => {
    const { container } = render(<GroupTabs />);
    // A <button> blocks dragging in Tauri's own path walk, and a tab is never
    // the drag element itself — neither may carry the attribute.
    for (const el of container.querySelectorAll("button, [data-group-tab]")) {
      expect(el.hasAttribute("data-tauri-drag-region")).toBe(false);
    }
  });
});
