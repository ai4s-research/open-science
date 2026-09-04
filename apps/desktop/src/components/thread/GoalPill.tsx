import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Pause, Play, Target, X } from "lucide-react";
import { goalState, goalUpdate, type GoalState } from "@/lib/tauri";
import { cn } from "@/lib/cn";

/** How often the pill re-reads the plugin's state file while a session is
 *  open. Goal turns take seconds-to-minutes; 4s keeps the pill honest without
 *  chatter (one small JSON read per tick, no model turns). */
const POLL_MS = 4000;

/** Last known goal per session, so a re-mount (Screen switch, pane re-tile)
 *  paints the pill in its first frame instead of appearing one async read
 *  later — that late appearance shoved the session title in the same header
 *  and made it re-truncate visibly. The next poll corrects any staleness. */
const LAST_GOAL = new Map<string, GoalState | null>();

/** Popover width (Tailwind `w-64`), needed in JS to clamp it to the viewport. */
const POP_W = 256;
/** Breathing room kept between the popover and the window edges. */
const POP_MARGIN = 8;

/**
 * Session-header pill for goal mode (/goal): shows the persistent objective,
 * its live status (running / paused / blocked / done + auto-turn count), and
 * instant pause / resume / clear controls that bypass the model entirely.
 * Renders nothing when the session has no goal.
 */
export function GoalPill({
  sessionId,
  onResumed,
  compact = false,
}: {
  sessionId: string;
  /** Called after a successful resume — the page sends GOAL_RESUME_NUDGE. */
  onResumed?: () => void;
  /** Collapse to a single status-coloured icon that opens the rest in a
   *  popover. A tiled pane's header has room for one control, not four: the
   *  inline pill (objective + status + pause + clear) overlapped its
   *  neighbours, and merely dropping the objective was still too wide. */
  compact?: boolean;
}) {
  const { t } = useTranslation("session");
  const [goal, setGoal] = useState<GoalState | null>(() => LAST_GOAL.get(sessionId) ?? null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pop, setPop] = useState<{ top: number; left: number } | null>(null);

  // Dismiss the popover on any outside press. Button blur cannot do this: the
  // webview does not focus a clicked button on macOS. The popover itself lives
  // in a body portal, so "inside" means either subtree.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Place the popover in viewport coordinates: right-aligned under the icon,
  // then clamped to the window. Anchored (not window-centred) because tiled
  // panes each carry their own goal — a floating dialog would not say which
  // session it belongs to; clamped because a tiled pane is often narrower than
  // the popover, and an in-pane absolute box got clipped by the pane's
  // overflow instead of spilling over the neighbour.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = rootRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const width = Math.min(POP_W, window.innerWidth - 2 * POP_MARGIN);
      const height = popRef.current?.offsetHeight ?? 0;
      const below = anchor.bottom + 4;
      setPop({
        left: Math.max(POP_MARGIN, Math.min(anchor.right - width, window.innerWidth - POP_MARGIN - width)),
        // Flip above the icon when the window's bottom edge is closer than the
        // popover is tall (a short pane docked low, or a small window).
        top: below + height > window.innerHeight - POP_MARGIN && anchor.top - height - 4 > POP_MARGIN
          ? anchor.top - height - 4
          : below,
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, goal?.objective]);

  const refresh = useCallback(async () => {
    const next = await goalState(sessionId);
    LAST_GOAL.set(sessionId, next);
    setGoal(next);
  }, [sessionId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // A pane can be pointed at another session without unmounting; show that
  // session's cached goal from the first render rather than the old one.
  const shownFor = useRef(sessionId);
  if (shownFor.current !== sessionId) {
    shownFor.current = sessionId;
    setGoal(LAST_GOAL.get(sessionId) ?? null);
    setOpen(false);
  }

  const act = async (action: "pause" | "resume" | "clear") => {
    setBusy(true);
    try {
      const next = await goalUpdate(sessionId, action);
      LAST_GOAL.set(sessionId, next);
      setGoal(next);
      if (action === "resume") onResumed?.();
    } catch {
      await refresh(); // the plugin may have raced us — show whatever won
    } finally {
      setBusy(false);
    }
  };

  if (!goal) return null;

  const status = goal.status;
  const autoTurns = goal.autoTurns ?? 0;
  // The plugin's status enum: active / paused / complete are the main line;
  // "unmet" is a goal the model declared blocked, budget/usageLimited hit a
  // guardrail. Anything unknown renders muted like paused (fail quiet).
  const limited = status === "budgetLimited" || status === "usageLimited";
  const statusLabel =
    status === "active"
      ? autoTurns > 0
        ? t("goal.runningTurns", { count: autoTurns })
        : t("goal.running")
      : status === "complete"
        ? t("goal.done")
        : status === "unmet"
          ? t("goal.unmet")
          : limited
            ? t("goal.limited")
            : t("goal.paused");
  const tooltip = [
    `${t("goal.label")}: ${goal.objective}`,
    status === "unmet" && goal.blocker ? `⚠ ${goal.blocker}` : null,
    limited && goal.lastStatus ? `⚠ ${goal.lastStatus}` : null,
    status === "complete" && goal.completionEvidence ? `✓ ${goal.completionEvidence}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const dotClass = cn(
    status === "active" && "text-accent",
    status === "unmet" && "text-error",
    limited && "text-warn",
    status === "complete" && "text-ok",
    !["active", "unmet", "complete"].includes(status) && !limited && "text-muted",
  );
  const shellClass = cn(
    "flex min-w-0 shrink items-center rounded-full border text-xs",
    status === "active" && "border-accent/30 bg-accent/10 text-text",
    status === "unmet" && "border-error/30 bg-error/10 text-text",
    limited && "border-warn/30 bg-warn/10 text-text",
    status === "complete" && "border-ok/30 bg-ok/10 text-text",
    !["active", "unmet", "complete"].includes(status) &&
      !limited &&
      "border-border bg-surface-2 text-muted",
  );

  const controls = (
    <>
      {(status === "active" || status === "paused") && (
        <button
          onClick={() => void act(status === "active" ? "pause" : "resume")}
          disabled={busy}
          aria-label={status === "active" ? t("goal.pauseAria") : t("goal.resumeAria")}
          title={status === "active" ? t("goal.pauseAria") : t("goal.resumeAria")}
          className="shrink-0 rounded-full p-1 text-muted transition-colors hover:bg-surface hover:text-text"
        >
          {status === "active" ? <Pause size={11} /> : <Play size={11} />}
        </button>
      )}
      <button
        onClick={() => void act("clear")}
        disabled={busy}
        aria-label={t("goal.clearAria")}
        title={t("goal.clearAria")}
        className="shrink-0 rounded-full p-1 text-muted transition-colors hover:bg-surface hover:text-error"
      >
        <X size={11} />
      </button>
    </>
  );

  if (compact) {
    return (
      <div ref={rootRef} className="relative shrink-0">
        <button
          title={tooltip}
          aria-label={`${t("goal.label")}: ${statusLabel}`}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={cn(shellClass, "h-6 w-6 items-center justify-center p-0")}
        >
          <Target size={12} className={cn("shrink-0", dotClass)} />
          {status === "active" && (
            <span
              className="absolute right-0 top-0 h-1.5 w-1.5 animate-pulse rounded-full bg-accent"
              aria-hidden
            />
          )}
        </button>
        {open &&
          typeof document !== "undefined" &&
          createPortal(
            <div
              ref={popRef}
              role="dialog"
              style={{ top: pop?.top ?? 0, left: pop?.left ?? 0 }}
              className={cn(
                "fixed z-[60] max-h-[50vh] w-[min(16rem,calc(100vw-16px))] overflow-y-auto rounded-card",
                "border border-border bg-surface p-2 text-xs shadow-pop",
                // Hidden until placed, so it never paints at the top-left corner.
                !pop && "invisible",
              )}
            >
              <div className="mb-1 flex items-center gap-1.5">
                <Target size={12} className={cn("shrink-0", dotClass)} />
                <span className={cn("shrink-0", status === "active" ? "text-accent" : "text-muted")}>
                  {statusLabel}
                </span>
                <span className="ml-auto flex items-center">{controls}</span>
              </div>
              <p className="whitespace-pre-wrap break-words text-text">{goal.objective}</p>
            </div>,
            document.body,
          )}
      </div>
    );
  }

  return (
    <div title={tooltip} className={cn(shellClass, "gap-1.5 py-0.5 pl-2 pr-1")}>
      <Target size={12} className={cn("shrink-0", dotClass)} />
      <span className="max-w-[180px] truncate">{goal.objective}</span>
      <span
        className={cn(
          "shrink-0 whitespace-nowrap",
          status === "active" ? "text-accent" : "text-muted",
        )}
      >
        {statusLabel}
      </span>
      {status === "active" && (
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" aria-hidden />
      )}
      {controls}
    </div>
  );
}
