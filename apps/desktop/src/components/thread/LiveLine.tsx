import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { cn } from "@/lib/cn";

/**
 * Keep a container pinned to the end of streaming content.
 *
 * A streamed part re-renders on every token — dozens of times a second — and
 * reading `scrollWidth`/`scrollHeight` forces a layout each time. The alignment
 * is therefore coalesced onto every third animation frame: fast enough that the
 * text reads as typed, cheap enough that a long turn stays smooth.
 *
 * `axis: "y"` only follows while the reader is already at the bottom (within a
 * line or two) — scrolling up through a long thought must not be yanked back
 * down by the next token.
 */
export function useStickToEnd(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  content: unknown,
  axis: "x" | "y",
) {
  const pending = useRef<number | null>(null);
  // Read at apply time, not at schedule time: the alignment lands three frames
  // later and must use the state of that frame.
  const latest = useRef({ active, axis });
  latest.current = { active, axis };

  useLayoutEffect(
    () => () => {
      if (pending.current !== null) cancelAnimationFrame(pending.current);
      pending.current = null;
    },
    [],
  );

  useEffect(() => {
    if (pending.current !== null) return; // a frame is already in flight
    let frames = 3;
    const step = () => {
      if (--frames > 0) {
        pending.current = requestAnimationFrame(step);
        return;
      }
      pending.current = null;
      const el = ref.current;
      if (!el) return;
      if (latest.current.axis === "x") {
        el.scrollLeft = latest.current.active ? el.scrollWidth - el.clientWidth : 0;
        return;
      }
      if (!latest.current.active) return;
      if (el.scrollHeight - el.scrollTop - el.clientHeight > 48) return; // reader scrolled up
      el.scrollTop = el.scrollHeight;
    };
    pending.current = requestAnimationFrame(step);
  }, [ref, active, content]);
}

/** The blinking bar that marks where the next token will land. */
export function Caret() {
  return (
    <span
      aria-hidden
      className="ml-[2px] inline-block h-[0.9em] w-[2px] translate-y-[1px] animate-pulse bg-current opacity-60"
    />
  );
}

/**
 * One line of text that reads as a typewriter while it streams.
 *
 * The line never wraps: as the text outgrows the row it slides left, keeping the
 * newest characters (and the caret) in view, so the row itself shows the model
 * emitting tokens. A settled line goes back to head-anchored with an ellipsis —
 * a finished thought is read from its beginning.
 */
export function LiveLine({
  text,
  active = false,
  className,
}: {
  text: string;
  /** The text is still streaming: follow its tail and show the caret. */
  active?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useStickToEnd(ref, active, text, "x");
  return (
    <span
      ref={ref}
      className={cn(
        "no-scrollbar min-w-0 flex-1 overflow-hidden whitespace-nowrap",
        // Clipping while streaming: an ellipsis on a line that is scrolled to
        // its tail would sit over the newest characters.
        active ? "text-clip" : "text-ellipsis",
        className,
      )}
    >
      {text}
      {active && <Caret />}
    </span>
  );
}
