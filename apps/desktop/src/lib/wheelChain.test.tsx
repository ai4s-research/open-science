import { useRef } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HSCROLL_ATTR, useWheelChain } from "./wheelChain";

/** jsdom has no layout: every element measures 0. Give one the metrics of a box
 *  with vertical room to scroll. */
function withVerticalRoom(el: HTMLElement, scrollTop = 0) {
  Object.defineProperty(el, "scrollHeight", { value: 1000, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
  el.style.overflowY = "auto";
  el.scrollTop = scrollTop;
}

function Fixture() {
  const ref = useRef<HTMLDivElement>(null);
  useWheelChain(ref);
  return (
    <div ref={ref} data-testid="scroller">
      <div {...{ [HSCROLL_ATTR]: "" }} data-testid="table">
        <span data-testid="cell">wide</span>
      </div>
      <p data-testid="prose">text</p>
    </div>
  );
}

function wheel(target: Element, deltaX: number, deltaY: number): WheelEvent {
  const event = new WheelEvent("wheel", { deltaX, deltaY, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe("useWheelChain", () => {
  it("scrolls the conversation when a vertical gesture lands on a wide table", () => {
    const { getByTestId } = render(<Fixture />);
    const scroller = getByTestId("scroller");
    withVerticalRoom(scroller);

    const event = wheel(getByTestId("cell"), 0, 120);

    expect(event.defaultPrevented).toBe(true);
    expect(scroller.scrollTop).toBe(120);
  });

  it("leaves a sideways gesture to the table itself", () => {
    const { getByTestId } = render(<Fixture />);
    const scroller = getByTestId("scroller");
    withVerticalRoom(scroller);

    const event = wheel(getByTestId("cell"), 90, 20);

    expect(event.defaultPrevented).toBe(false);
    expect(scroller.scrollTop).toBe(0);
  });

  it("does not touch gestures outside a horizontal box — the browser chains those already", () => {
    const { getByTestId } = render(<Fixture />);
    const scroller = getByTestId("scroller");
    withVerticalRoom(scroller);

    const event = wheel(getByTestId("prose"), 0, 120);

    expect(event.defaultPrevented).toBe(false);
    expect(scroller.scrollTop).toBe(0);
  });

  it("yields to a nested box that can still scroll in that direction", () => {
    const { getByTestId } = render(<Fixture />);
    const scroller = getByTestId("scroller");
    withVerticalRoom(scroller);
    withVerticalRoom(getByTestId("table"), 100);

    const event = wheel(getByTestId("cell"), 0, 120);

    expect(event.defaultPrevented).toBe(false);
    expect(scroller.scrollTop).toBe(0);
  });

  it("claims the gesture once that nested box has hit its end", () => {
    const { getByTestId } = render(<Fixture />);
    const scroller = getByTestId("scroller");
    withVerticalRoom(scroller);
    withVerticalRoom(getByTestId("table"), 600); // scrollHeight - clientHeight

    const event = wheel(getByTestId("cell"), 0, 120);

    expect(event.defaultPrevented).toBe(true);
    expect(scroller.scrollTop).toBe(120);
  });
});
