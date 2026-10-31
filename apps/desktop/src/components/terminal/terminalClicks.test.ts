import type { ILink, Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { keepClicksAcrossRedraws } from "./terminalClicks";

/** xterm's side, reduced to what a click needs: the element, the selection,
 *  and showing a link (hover) and dropping it on a redraw (leave). */
function setup() {
  const element = document.createElement("div");
  const term = { element, hasSelection: () => false } as unknown as Terminal;
  const clicks = keepClicksAcrossRedraws(term);
  const activate = vi.fn();
  const link = (): ILink => clicks.wrap({ range: { start: { x: 6, y: 2 }, end: { x: 27, y: 2 } }, text: "/tmp/a.png", activate });
  const show = (l: ILink) => l.hover?.(new MouseEvent("mousemove"), l.text);
  const drop = (l: ILink) => l.leave?.(new MouseEvent("mousemove"), l.text);
  const press = (type: string) => element.dispatchEvent(new MouseEvent(type, { button: 0, bubbles: true }));
  const settle = () => new Promise((r) => setTimeout(r));
  return { link, show, drop, press, settle, activate };
}

describe("keepClicksAcrossRedraws", () => {
  it("opens a link redrawn between mousedown and mouseup, which xterm lets go", async () => {
    const t = setup();
    const before = t.link();
    t.show(before);
    t.press("mousedown");
    t.drop(before);
    t.show(t.link()); // the redraw: same link, new object
    t.press("mouseup"); // xterm sees two objects and does nothing
    await t.settle();
    expect(t.activate).toHaveBeenCalledTimes(1);
  });

  it("does not open twice when xterm opened it", async () => {
    const t = setup();
    const l = t.link();
    t.show(l);
    t.press("mousedown");
    t.press("mouseup");
    l.activate(new MouseEvent("mouseup"), l.text); // xterm's own click
    await t.settle();
    expect(t.activate).toHaveBeenCalledTimes(1);
  });

  it("does not open when the pointer left the link before mouseup", async () => {
    const t = setup();
    const l = t.link();
    t.show(l);
    t.press("mousedown");
    t.drop(l);
    t.press("mouseup");
    await t.settle();
    expect(t.activate).not.toHaveBeenCalled();
  });
});
