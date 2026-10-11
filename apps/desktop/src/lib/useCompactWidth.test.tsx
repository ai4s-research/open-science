import { act, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useCompactWidth, useLabelsOverflow } from "./useCompactWidth";

/**
 * The hook used to start at "wide" and correct itself from the ResizeObserver's
 * first callback, which arrives after paint — so every mount of a narrow pane
 * drew the labels and dropped them a frame later. Switching to a Screen with
 * tiled panes remounts these, so it flashed on every switch. jsdom has no
 * layout and no ResizeObserver, which is exactly the case that isolates the
 * FIRST measurement: whatever the initial render shows is what the user sees
 * before any observer could fire.
 */
function Probe({ minPx, laidOut = true }: { minPx: number; laidOut?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const compact = useCompactWidth(ref, minPx, laidOut);
  return (
    <div ref={ref} data-testid="box">
      {compact ? "icon" : "icon+label"}
    </div>
  );
}

const withWidth = (px: number) => {
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ width: px, height: 0, top: 0, left: 0, right: px, bottom: 0, x: 0, y: 0 }),
  });
};

describe("useCompactWidth", () => {
  it("is already compact on the first paint of a narrow element", () => {
    withWidth(200);
    render(<Probe minPx={420} />);
    // Exact, not toHaveTextContent: that matches substrings, and "icon+label"
    // contains "icon" — the assertion would hold either way.
    expect(screen.getByTestId("box").textContent).toBe("icon");
  });

  it("keeps the labels when the element is wide enough", () => {
    withWidth(900);
    render(<Probe minPx={420} />);
    expect(screen.getByTestId("box").textContent).toBe("icon+label");
  });

  // An inactive Screen is mounted but display:none, so its panes measure zero
  // until it is shown. The measurement must happen in the layout effect of the
  // render that reveals it — an observer callback lands a frame later, which is
  // the flash this hook exists to prevent.
  it("measures a pane that mounts with no layout as soon as it is shown", () => {
    withWidth(0); // hidden Screen: no box
    const { rerender } = render(<Probe minPx={420} laidOut={false} />);
    // Zero is not a measurement — it must not read as "narrow" either.
    expect(screen.getByTestId("box").textContent).toBe("icon+label");

    withWidth(200);
    rerender(<Probe minPx={420} laidOut />);
    expect(screen.getByTestId("box").textContent).toBe("icon");
  });
});

/**
 * The composer's action row. A fixed breakpoint let a draft with a folder chip
 * and a long model name overflow at 440px — the squeezed model chip spilled
 * over the send button — so the row is measured instead. jsdom has no layout;
 * each item's width is its `data-w` and the row's room is `room`.
 */
describe("useLabelsOverflow", () => {
  let room = 0;
  /** jsdom has no layout, hence no real ResizeObserver: this stub lets a test
   *  fire the callback the way a real row resize would (#157 — a resize, not
   *  a re-render, is now what re-triggers the measure). */
  let fireResize: () => void = () => {};
  const patched = [
    [HTMLElement.prototype, "offsetWidth"],
    [Element.prototype, "clientWidth"],
    [Element.prototype, "getClientRects"],
  ] as const;
  const saved = patched.map(([proto, key]) => Object.getOwnPropertyDescriptor(proto, key));
  const hadResizeObserver = "ResizeObserver" in globalThis;
  const savedResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return Number(this.dataset.w ?? 0);
      },
    });
    Object.defineProperty(Element.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset.testid === "row" ? room : 0;
      },
    });
    Object.defineProperty(Element.prototype, "getClientRects", { configurable: true, value: () => [{}] });
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) {
        fireResize = () => cb([], this as unknown as ResizeObserver);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });
  afterAll(() => {
    patched.forEach(([proto, key], i) => {
      const d = saved[i];
      if (d) Object.defineProperty(proto, key, d);
      else delete (proto as unknown as Record<string, unknown>)[key];
    });
    if (hadResizeObserver)
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = savedResizeObserver;
    else delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  });

  /** Two buttons: 200px each with their labels, 40px as icons; no gap. */
  function Row() {
    const ref = useRef<HTMLDivElement>(null);
    const compact = useLabelsOverflow(ref);
    return (
      <div ref={ref} data-testid="row">
        <span data-w={compact ? 40 : 200} />
        <span data-w={compact ? 40 : 200} />
        <output>{compact ? "icons" : "labels"}</output>
      </div>
    );
  }
  const shown = () => screen.getByRole("status").textContent;

  it("keeps the labels while the items fit", () => {
    room = 500;
    render(<Row />);
    expect(shown()).toBe("labels");
  });

  it("drops them, before the first paint, when the items do not fit", () => {
    room = 300;
    render(<Row />);
    expect(shown()).toBe("icons");
  });

  it("brings them back once there is room for them again, and not before", () => {
    room = 300;
    render(<Row />);
    expect(shown()).toBe("icons");
    // 80px of icons fit easily, but the labels still would not: no flip-flop.
    room = 390;
    act(() => fireResize());
    expect(shown()).toBe("icons");
    room = 400;
    act(() => fireResize());
    expect(shown()).toBe("labels");
  });

  it("does not read a hidden row (no width) as narrow", () => {
    room = 0;
    render(<Row />);
    expect(shown()).toBe("labels");
  });

  // #157: the old hook measured on EVERY render — every streamed token of any
  // session on the page. Now a re-render alone changes nothing; only a resize
  // or a real content mutation re-measures.
  it("a bare re-render is not a trigger anymore", () => {
    room = 300;
    const { rerender } = render(<Row />);
    expect(shown()).toBe("icons");
    room = 400;
    rerender(<Row />);
    expect(shown()).toBe("icons"); // no observer fired: no re-measure
    act(() => fireResize());
    expect(shown()).toBe("labels");
  });

  it("a label change re-measures without a resize (MutationObserver)", async () => {
    room = 300;
    render(<Row />);
    expect(shown()).toBe("icons");
    room = 400; // the labels WOULD fit again — but nothing reported it yet
    // A model pick rewrites a label's text node: characterData, observed.
    screen.getByTestId("row").firstElementChild!.textContent = "a much longer model label";
    await waitFor(() => expect(shown()).toBe("labels"));
  });
});
