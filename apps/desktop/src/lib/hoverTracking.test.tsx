import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HOVER_HOST, useHoverTracking } from "./hoverTracking";

function Fixture() {
  useHoverTracking();
  return (
    <div data-testid="conversation">
      <div {...{ [HOVER_HOST]: "" }} data-testid="first">
        <span data-testid="first-text">one</span>
      </div>
      <div {...{ [HOVER_HOST]: "" }} data-testid="second">
        <span data-testid="second-text">two</span>
      </div>
    </div>
  );
}

// jsdom has no PointerEvent constructor; the tracker only reads `target`.
const pointer = (type: string, bubbles: boolean) => new MouseEvent(type, { bubbles });
const move = (target: Element) => target.dispatchEvent(pointer("pointermove", true));

describe("useHoverTracking", () => {
  it("marks the message under the pointer, and only that one", () => {
    const { getByTestId } = render(<Fixture />);

    move(getByTestId("first-text"));
    expect(getByTestId("first")).toHaveAttribute("data-hovered");
    expect(getByTestId("second")).not.toHaveAttribute("data-hovered");

    move(getByTestId("second-text"));
    expect(getByTestId("first")).not.toHaveAttribute("data-hovered");
    expect(getByTestId("second")).toHaveAttribute("data-hovered");
  });

  it("clears the mark when the pointer leaves the window", () => {
    const { getByTestId } = render(<Fixture />);
    move(getByTestId("first-text"));

    document.dispatchEvent(pointer("pointerleave", false));

    expect(getByTestId("first")).not.toHaveAttribute("data-hovered");
  });

  // The report that started this: a Screen hidden out from under the cursor
  // delivers no leave event of its own, so the mark has to be re-derived from
  // whatever the pointer touches NEXT — anywhere in the app.
  it("a move anywhere else clears a mark no element was told about", () => {
    const { getByTestId } = render(
      <>
        <Fixture />
        <button data-testid="elsewhere">elsewhere</button>
      </>,
    );
    move(getByTestId("first-text"));
    expect(getByTestId("first")).toHaveAttribute("data-hovered");

    move(getByTestId("elsewhere"));

    expect(getByTestId("first")).not.toHaveAttribute("data-hovered");
  });

  // The case that survived three fixes: a trackpad scroll moves the content,
  // not the cursor, so nothing is dispatched to say the message left.
  it("drops the mark when the message scrolls out from under a still pointer", () => {
    const { getByTestId } = render(<Fixture />);
    const first = getByTestId("first");
    move(getByTestId("first-text"));
    expect(first).toHaveAttribute("data-hovered");

    // jsdom has no hit-testing at all: stand in for it, and say the pointer is
    // now over the message that scrolled into its place.
    const original = document.elementFromPoint;
    document.elementFromPoint = () => getByTestId("second-text");
    try {
      document.dispatchEvent(pointer("scroll", true));
      expect(first).not.toHaveAttribute("data-hovered");
    } finally {
      document.elementFromPoint = original;
    }
  });

  it("marks nothing over the gaps between messages", () => {
    const { getByTestId } = render(<Fixture />);
    move(getByTestId("first-text"));

    move(getByTestId("conversation"));

    expect(getByTestId("first")).not.toHaveAttribute("data-hovered");
  });
});
