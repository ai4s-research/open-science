import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ContextMenu, ContextMenuItem } from "@/components/ui/ContextMenu";
import { useNativeContextMenuGuard } from "./nativeMenu";

// The guard only runs in the packaged app, so the earlier unit tests never
// exercised it together with a real context menu — which is exactly where it
// broke: right-clicking a session, project or Screen tab produced NO menu at
// all, because the guard pre-empted Radix.
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  isTauri: true,
}));

function Harness() {
  useNativeContextMenuGuard();
  return (
    <>
      <ContextMenu
        label="Row actions"
        items={<ContextMenuItem onSelect={() => {}}>Rename</ContextMenuItem>}
      >
        <div>
          <a href="/live/s1">a session row</a>
        </div>
      </ContextMenu>
      <div data-native-menu>
        <p>conversation text</p>
      </div>
      <p>bare chrome</p>
    </>
  );
}

describe("the native-menu guard alongside the app's own menus", () => {
  it("still lets a chrome row open ITS menu", async () => {
    render(<Harness />);

    await userEvent.pointer({
      target: screen.getByText("a session row"),
      keys: "[MouseRight]",
    });

    expect(await screen.findByRole("menu", { name: "Row actions" })).toHaveTextContent("Rename");
  });

  it("suppresses the page menu on chrome that has no menu of its own", async () => {
    render(<Harness />);
    const target = screen.getByText("bare chrome");

    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves the page menu alone over SELECTED document content", async () => {
    render(<Harness />);
    const target = screen.getByText("conversation text");
    const range = document.createRange();
    range.selectNodeContents(target);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);

    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    target.dispatchEvent(event);

    // Copy / Look Up / Translate must still be available on a selected sentence.
    expect(event.defaultPrevented).toBe(false);
  });

  it("suppresses it over document content with nothing selected", async () => {
    render(<Harness />);
    window.getSelection()?.removeAllRanges();
    const target = screen.getByText("conversation text");

    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    target.dispatchEvent(event);

    // With no selection the WebView's menu is "Back" and "Reload", so the
    // right-click belongs to the pane it happened in.
    expect(event.defaultPrevented).toBe(true);
  });
});
