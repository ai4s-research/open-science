import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useDragDivider } from "./useDragDivider";

/** jsdom's PointerEvent carries no coordinates; a MouseEvent of the same type
 *  reaches the same React handler and does. */
function pointer(type: string, target: Element | Window, x: number) {
  fireEvent(target, new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 0 }));
}

function Divider({
  onDrag,
  onCommit,
}: {
  onDrag?: (v: number) => void;
  onCommit: (v: number) => void;
}) {
  const { dragging, dragValue, handleProps } = useDragDivider({
    value: 100,
    compute: ({ x }) => x,
    onDrag,
    onCommit,
  });
  return (
    <div>
      <div data-testid="handle" {...handleProps} />
      <span data-testid="state">{`${dragging}:${dragValue ?? "-"}`}</span>
    </div>
  );
}

// jsdom has no pointer capture.
beforeAll(() => {
  Element.prototype.setPointerCapture = () => {};
});

describe("resizing a panel", () => {
  it("hands live values to the caller without re-rendering", () => {
    const onDrag = vi.fn();
    const onCommit = vi.fn();
    render(<Divider onDrag={onDrag} onCommit={onCommit} />);
    const handle = screen.getByTestId("handle");

    pointer("pointerdown", handle, 100);
    pointer("pointermove", handle, 220);
    pointer("pointermove", handle, 240);

    // Every move reaches the caller, which writes it straight to the DOM…
    expect(onDrag.mock.calls.map(([v]) => v)).toEqual([220, 240]);
    // …and no live value is published, so nothing behind the divider re-renders
    // per frame. Only "a drag is in progress" is state.
    expect(screen.getByTestId("state")).toHaveTextContent("true:-");
  });

  it("commits the last position, not the one a frame ago", () => {
    const onCommit = vi.fn();
    render(<Divider onDrag={vi.fn()} onCommit={onCommit} />);
    const handle = screen.getByTestId("handle");

    pointer("pointerdown", handle, 100);
    pointer("pointermove", handle, 300);
    pointer("pointerup", handle, 300);

    expect(onCommit).toHaveBeenCalledWith(300);
  });

  it("still publishes a live value for callers that need to re-render", () => {
    const onCommit = vi.fn();
    render(<Divider onCommit={onCommit} />);
    const handle = screen.getByTestId("handle");

    pointer("pointerdown", handle, 100);

    // An interior split divider resizes its siblings, so it does need the
    // render — the value is only withheld from callers that opted out.
    expect(screen.getByTestId("state")).toHaveTextContent("true:100");
  });
});
