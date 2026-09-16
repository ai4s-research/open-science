import { useCallback, useEffect, useRef, useState } from "react";

/** A pointer position during a divider drag, plus the divider container's
 *  bounding box captured at pointer-down. Interior split dividers compute a
 *  fraction from `x - rect.left`; window-anchored dividers ignore `rect` and
 *  read `x`/`y` against the viewport. */
export interface DragPoint {
  x: number;
  y: number;
  rect: DOMRect;
}

export interface UseDragDividerOptions {
  /** The committed value the drag seeds from (a px width, or a 0..1 fraction). */
  value: number;
  /** Map a pointer position to the next value. Return `null` to request a
   *  collapse — the drag KEEPS running (so the user can drag back out, as the
   *  sidebar does); callers that unmount on collapse simply end the drag that
   *  way. */
  compute: (p: DragPoint) => number | null;
  /** Persist the live value on pointer-up. */
  onCommit: (value: number) => void;
  /** Take the live value WITHOUT a re-render.
   *
   *  A panel whose contents do not change while it is resized (the sidebar: a
   *  list of sessions, unaffected by its own width) can write the new width
   *  straight to its element here. Re-rendering that list on every frame of a
   *  drag is most of what made dragging it feel heavy. When this is given the
   *  hook stops publishing `dragValue`, so nothing re-renders mid-drag. */
  onDrag?: (value: number) => void;
  /** `compute` returned `null` — enter the collapsed state. Fires once per
   *  transition into the collapse zone. */
  onCollapse?: () => void;
  /** `compute` returned a number after a collapse — leave the collapsed state.
   *  Fires once per transition back out. */
  onExpand?: () => void;
}

export interface DragDivider {
  /** True while a drag is in progress. */
  dragging: boolean;
  /** The live value during a drag; `null` when idle (fall back to the committed
   *  value). */
  dragValue: number | null;
  /** Spread onto the draggable divider element. */
  handleProps: Pick<
    React.DOMAttributes<HTMLElement>,
    "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel"
  >;
}

/**
 * Shared divider-drag mechanics: pointer capture, container-rect capture at
 * pointer-down, a live drag value, and commit-on-pointer-up. The geometry
 * (window-edge vs. interior/relative) lives in the caller's `compute`, so one
 * hook backs the sidebar, the right inspector, and interior split dividers.
 */
export function useDragDivider(options: UseDragDividerOptions): DragDivider {
  const [dragValue, setDragValue] = useState<number | null>(null);
  /** Kept separately from the value: a caller taking live values through
   *  `onDrag` still needs to know a drag is in progress (to drop transitions
   *  and pointer-events), and that is one render, not one per frame. */
  const [live, setLive] = useState(false);
  // Latest options without re-binding the (stable) pointer handlers each render.
  const optsRef = useRef(options);
  optsRef.current = options;
  const rectRef = useRef<DOMRect | null>(null);
  const collapsedRef = useRef(false);
  const dragging = live || dragValue !== null;
  // Pointer moves arrive faster than the screen redraws — 120Hz+ on a trackpad
  // — and each one used to re-render the panel being resized and reflow every
  // pane behind it. The pointer's latest position is all that matters, so the
  // value is applied once per frame instead of once per event.
  const frame = useRef(0);
  const pending = useRef<number | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    rectRef.current = e.currentTarget.getBoundingClientRect();
    collapsedRef.current = false;
    pending.current = optsRef.current.value;
    setLive(true);
    if (!optsRef.current.onDrag) setDragValue(optsRef.current.value);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (rectRef.current === null) return;
    const next = optsRef.current.compute({ x: e.clientX, y: e.clientY, rect: rectRef.current });
    if (next === null) {
      if (!collapsedRef.current) {
        collapsedRef.current = true;
        optsRef.current.onCollapse?.();
      }
      return; // keep the last value so pointer-up commits a sane width
    }
    if (collapsedRef.current) {
      collapsedRef.current = false;
      optsRef.current.onExpand?.();
    }
    pending.current = next;
    if (optsRef.current.onDrag) {
      // Straight to the DOM, at the pointer's own rate: no render, no reflow of
      // anything but the element the caller writes.
      optsRef.current.onDrag(next);
      return;
    }
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (pending.current !== null) setDragValue(pending.current);
    });
  }, []);

  const endDrag = useCallback(() => {
    // The last position may still be queued; take it rather than committing the
    // width from a frame ago.
    if (frame.current) {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    }
    const last = pending.current;
    pending.current = null;
    setLive(false);
    setDragValue((v) => {
      const final = last ?? v;
      if (final !== null) optsRef.current.onCommit(final);
      return null;
    });
    rectRef.current = null;
    collapsedRef.current = false;
  }, []);

  useEffect(
    () => () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    },
    [],
  );

  return {
    dragging,
    dragValue,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    },
  };
}
