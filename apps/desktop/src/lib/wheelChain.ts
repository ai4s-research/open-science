import { useEffect, type RefObject } from "react";

/** Marks a box that scrolls HORIZONTALLY inside scrollable content — a wide
 *  table, a code block, a data card. Put it on the scroll box itself. */
export const HSCROLL_ATTR = "data-hscroll";

/**
 * Let a vertical scroller keep the vertical wheel gestures WebKit hands to a
 * nested horizontal one.
 *
 * WebKit latches a whole trackpad gesture to the innermost scroll box under the
 * pointer. A wide table in the conversation is such a box, and it has no
 * vertical range to give, so a two-finger swipe over a table scrolled NOTHING —
 * the gesture never chained out to the conversation. (`overflow-y: hidden` on
 * those boxes is still right: it stops the same trap arising from a horizontal
 * scrollbar's own height. It does not lift the latch — measured on macOS.)
 *
 * So the container claims the gesture instead: a mostly-vertical wheel over a
 * marked horizontal box, which no nested VERTICAL scroller can still use, is
 * applied to the container directly. Everything else is left to the browser —
 * horizontal intent stays with the table, and a capped log or tool-output box
 * keeps scrolling itself until it hits its end.
 */
export function useWheelChain(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const scroller = ref.current;
    if (!scroller) return;
    const onWheel = (event: WheelEvent) => {
      // `ctrlKey` on a wheel is a pinch-zoom, not a scroll.
      if (event.defaultPrevented || event.ctrlKey) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const target = event.target instanceof Element ? event.target : null;
      // Cheap gate first: everything below reads layout, and this handler runs
      // for every wheel event of every gesture over the conversation.
      if (!target?.closest(`[${HSCROLL_ATTR}]`)) return;
      for (let el: Element | null = target; el && el !== scroller; el = el.parentElement) {
        if (canScrollVertically(el, event.deltaY)) return;
      }
      if (!canScrollVertically(scroller, event.deltaY)) return;
      event.preventDefault();
      scroller.scrollTop += event.deltaY;
    };
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, [ref]);
}

/** Can this element still move vertically in the wheel's direction? */
function canScrollVertically(el: Element, deltaY: number): boolean {
  const room = el.scrollHeight - el.clientHeight;
  if (room <= 1) return false;
  const overflowY = getComputedStyle(el).overflowY;
  if (overflowY !== "auto" && overflowY !== "scroll") return false;
  return deltaY > 0 ? el.scrollTop < room - 1 : el.scrollTop > 0;
}
