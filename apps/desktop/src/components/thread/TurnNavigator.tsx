import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { ThreadBlock } from "@ai4s/shared";
import { shapeThread } from "./BlockList";
import { splitTurns } from "./turns";
import css from "./TurnNavigator.module.css";

/* Turn rail, ported from DeepSeek Harness ui-chat TurnNavigator.tsx (MIT,
   (c) 2026 DeepSeek): one tick per turn at a fixed pitch down the right edge
   of the conversation; hovering one previews that turn's ask and answer,
   clicking scrolls to it, and the turn being read stays marked. DSH
   virtualizes the ticks and pages unloaded history in; a thread here is
   fully loaded and short enough to render every tick. */

/** Fixed pitch between neighbouring marks (DSH TURN_SPACING_PX). */
const TURN_SPACING_PX = 10;
/** Fade band the mask reserves at a scrollable end (DSH FADE_PX). */
const FADE_PX = 24;
/** Preview text is bounded like DSH's outline previews. */
const PREVIEW_CHARS = 240;
/** From this close to the bottom, the reader is on the latest turn. */
const NEAR_BOTTOM_PX = 48;

interface TurnItem {
  turn: number;
  prompt: string;
  response: string;
}

function preferredScrollBehavior(): ScrollBehavior {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

/** Plain one-line preview of a message: markdown marks dropped, whitespace folded. */
function previewText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(#+|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[`*]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PREVIEW_CHARS);
}

/** Preview cache keyed by block IDENTITY (#157): a fold rebuilds only the one
 *  block object it changed, so on every streamed token the historical turns
 *  hit this cache and only the live block re-computes its preview. WeakMap:
 *  entries die with their block, no eviction bookkeeping needed. */
const previewCache = new WeakMap<ThreadBlock, string>();

/** Exported for tests — the contract under test is the cache key: block
 *  identity, not text content. `compute` is injectable so a test can count
 *  how often the (expensive) strip really runs. */
export function cachedPreview(
  block: ThreadBlock,
  text: string,
  compute: (text: string) => string = previewText,
): string {
  const hit = previewCache.get(block);
  if (hit !== undefined) return hit;
  const value = compute(text);
  previewCache.set(block, value);
  return value;
}

function turnItems(blocks: ThreadBlock[]): TurnItem[] {
  return splitTurns(shapeThread(blocks)).map((turn, index) => {
    const ask = turn.lead.find((b) => b.kind === "user");
    const answer = [...turn.answer].reverse().find((b) => b.kind === "agent");
    return {
      turn: index,
      prompt: ask && ask.kind === "user" ? cachedPreview(ask, ask.text) : "",
      response: answer && answer.kind === "agent" ? cachedPreview(answer, answer.markdown) : "",
    };
  });
}

/** The turn being read: the last whose top has passed the upper third of the
 *  viewport, or the latest one once the reader is at the bottom. */
function readVisibleTurn(scroller: HTMLElement): number | null {
  const turns = scroller.querySelectorAll<HTMLElement>("[data-turn]");
  if (turns.length === 0) return null;
  if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < NEAR_BOTTOM_PX) {
    return Number(turns[turns.length - 1].dataset.turn);
  }
  const line = scroller.getBoundingClientRect().top + scroller.clientHeight / 3;
  let current = Number(turns[0].dataset.turn);
  for (const el of turns) {
    if (el.getBoundingClientRect().top > line) break;
    current = Number(el.dataset.turn);
  }
  return current;
}

/** One tick on the rail (#157): the `blocks` array gets a new identity on
 *  every streamed token, so TurnNavigator re-renders per flush — but a mark's
 *  props are all primitives and stay equal, so the memo skips the row and its
 *  i18next aria-label lookup stays off the per-token hot path. (i18next key
 *  resolution measured as the top self-cost in the #157 CPU profile.) */
const TurnMark = memo(function TurnMark({
  turn,
  active,
  preview,
  describedBy,
  onHover,
  onLeave,
  onNavigate,
}: {
  turn: number;
  active: boolean;
  preview: boolean;
  describedBy?: string;
  onHover: (turn: number) => void;
  onLeave: () => void;
  onNavigate: (turn: number) => void;
}) {
  const { t } = useTranslation("session");
  const classes = [css.mark];
  if (active) classes.push(css.markActive);
  else if (preview) classes.push(css.markPreview);
  return (
    <button
      type="button"
      className={classes.join(" ")}
      aria-label={t("turnNav.jump", { turn: turn + 1 })}
      aria-current={active ? "true" : undefined}
      aria-describedby={preview ? describedBy : undefined}
      onPointerMove={() => onHover(turn)}
      onFocus={() => onHover(turn)}
      onBlur={onLeave}
      onClick={() => onNavigate(turn)}
    />
  );
});

export const TurnNavigator = memo(function TurnNavigator({
  blocks,
  scrollRef,
  bottomInset,
}: {
  blocks: ThreadBlock[];
  /** The conversation's scroll box; turns are its `[data-turn]` elements. */
  scrollRef: RefObject<HTMLElement>;
  /** Height the floating composer covers at the bottom of the scroll box. */
  bottomInset: number;
}) {
  const { t } = useTranslation("session");
  const items = useMemo(() => turnItems(blocks), [blocks]);
  const [activeTurn, setActiveTurn] = useState<number | null>(null);
  const [previewTurn, setPreviewTurn] = useState<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const railRef = useRef<HTMLDivElement>(null);
  const pointerInside = useRef(false);
  const previewId = useId();

  // Track the turn being read as the conversation scrolls or grows.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setActiveTurn(readVisibleTurn(scroller)));
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    const resize = new ResizeObserver(update);
    resize.observe(scroller);
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", update);
      resize.disconnect();
    };
  }, [scrollRef, items.length]);

  // Keep the active mark inside the rail's fade-free band, unless the pointer
  // is working the rail (following must not move it under the hand).
  useEffect(() => {
    const rail = railRef.current;
    if (!rail || activeTurn === null || pointerInside.current) return;
    const center = 1 + activeTurn * TURN_SPACING_PX + TURN_SPACING_PX / 2;
    const { scrollTop: top, clientHeight: height } = rail;
    if (center >= top + FADE_PX && center <= top + height - FADE_PX) return;
    rail.scrollTo({ top: center - height / 2, behavior: preferredScrollBehavior() });
  }, [activeTurn]);

  const navigate = useCallback(
    (turn: number) => {
      const scroller = scrollRef.current;
      const el = scroller?.querySelector<HTMLElement>(`[data-turn="${turn}"]`);
      if (!scroller || !el) return;
      const top = scroller.scrollTop + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16;
      scroller.scrollTo({ top, behavior: preferredScrollBehavior() });
    },
    [scrollRef],
  );
  const clearPreview = useCallback(() => setPreviewTurn(null), []);

  if (items.length < 2) return null;
  const rail = railRef.current;
  const scrollable = rail ? rail.scrollHeight - rail.clientHeight : 0;
  const fade = [css.scroller];
  if (scrollTop > 1) fade.push(css.fadeTop);
  if (scrollTop < scrollable - 1) fade.push(css.fadeBottom);
  const preview = previewTurn === null ? undefined : items[previewTurn];
  const previewCenter =
    previewTurn === null ? 0 : 1 + previewTurn * TURN_SPACING_PX + TURN_SPACING_PX / 2 - scrollTop;

  return (
    <div className={css.slot} style={{ bottom: bottomInset }}>
      <nav
        className={css.frame}
        aria-label={t("turnNav.label")}
        onPointerEnter={() => {
          pointerInside.current = true;
        }}
        onPointerLeave={() => {
          pointerInside.current = false;
          setPreviewTurn(null);
        }}
      >
        <div ref={railRef} className={fade.join(" ")} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
          <div className={css.marks}>
            {items.map((item) => (
              <TurnMark
                key={item.turn}
                turn={item.turn}
                active={item.turn === activeTurn}
                preview={item.turn === previewTurn}
                describedBy={previewId}
                onHover={setPreviewTurn}
                onLeave={clearPreview}
                onNavigate={navigate}
              />
            ))}
          </div>
        </div>
        {preview && (
          <div
            id={previewId}
            role="tooltip"
            className={css.preview}
            style={{ "--turn-preview-center": `${previewCenter}px` } as CSSProperties}
          >
            <div className={css.previewPrompt}>
              {preview.prompt || t("turnNav.turn", { turn: preview.turn + 1 })}
            </div>
            {preview.response !== "" && <div className={css.previewResponse}>{preview.response}</div>}
          </div>
        )}
      </nav>
    </div>
  );
});
