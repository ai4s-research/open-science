import { createContext, useContext, useEffect } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { INSPECTOR_MAX, INSPECTOR_MIN, useOverlayTitlebar, useUiStore } from "@/lib/store";
import { cn } from "@/lib/cn";
import { useIsMobile } from "@/lib/useIsMobile";
import { useDragDivider } from "@/lib/useDragDivider";
import { TITLEBAR_HEIGHT_PX, TRAFFIC_LIGHT_INSET_PX } from "@/lib/titlebar";

/** Dragging the divider below this pane width closes the pane — the same
 *  snap-shut behaviour as the sidebar. Sits below INSPECTOR_MIN for a clear snap. */
const COLLAPSE_BELOW = 280;

/** The pane may never squeeze the conversation out on small windows. */
const MAX_FRACTION = 0.7;

/** The id of the pane a panel sits in, for its MaximizePaneButton. */
const PaneIdContext = createContext<string | null>(null);

/**
 * Pane hosting an inspector or the session Files browser. Beside a solo
 * conversation it is a resizable side column: the left-edge divider drags
 * within [INSPECTOR_MIN, INSPECTOR_MAX] (persisted), and dragging it far right
 * snaps the pane closed. In a tiled pane (`fill`) it fills that pane instead.
 * Maximized, it covers the whole window — sidebar and conversations stay
 * mounted underneath.
 */
export function RightPane({
  paneId,
  fill = false,
  children,
  onClose,
}: {
  /** The layout pane this panel belongs to; names it as the maximized one. */
  paneId: string;
  fill?: boolean;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const inspectorWidth = useUiStore((s) => s.inspectorWidth);
  const setInspectorWidth = useUiStore((s) => s.setInspectorWidth);
  const maximized = useUiStore((s) => s.inspectorMaximized === paneId);
  const isMobile = useIsMobile();

  // Maximized never outlives the panel — closing it returns the next panel
  // (possibly for a different artifact or session) to the normal layout.
  useEffect(
    () => () => {
      const ui = useUiStore.getState();
      if (ui.inspectorMaximized === paneId) ui.setInspectorMaximized(null);
    },
    [paneId],
  );

  const clamp = (w: number) =>
    Math.max(
      INSPECTOR_MIN,
      Math.min(w, INSPECTOR_MAX, Math.round(window.innerWidth * MAX_FRACTION)),
    );

  // The pane ends at the window's right edge, so its width is whatever is right
  // of the pointer; dragging far right (below COLLAPSE_BELOW) snaps it closed,
  // which unmounts the pane and thereby ends the drag.
  const { dragging, dragValue, handleProps } = useDragDivider({
    value: inspectorWidth,
    compute: ({ x }) => {
      const w = window.innerWidth - x;
      return w < COLLAPSE_BELOW ? null : clamp(w);
    },
    onCommit: setInspectorWidth,
    onCollapse: onClose,
  });

  const body = <PaneIdContext.Provider value={paneId}>{children}</PaneIdContext.Provider>;

  if (maximized || isMobile) {
    // Maximized, OR mobile: the split-pane column (`lg:block`, fixed width) has
    // no room on a phone — show the pane full-screen instead (its own header
    // carries the close button). Without this the pane is display:none on
    // mobile, so the folder/runs toggles appear to "do nothing". Covering the
    // window, its header is the window's top row and clears the traffic lights.
    return (
      <div className="fixed inset-0 z-40 bg-surface">
        <PaneHeaderClearsLights.Provider value>{body}</PaneHeaderClearsLights.Provider>
      </div>
    );
  }

  if (fill) return <div className="h-full">{body}</div>;

  return (
    <div
      // The left rule is the same 1px line as the sidebar's and a split's
      // divider. The column draws it, so the panes inside it don't.
      className="relative hidden h-full shrink-0 border-l border-border lg:block"
      style={{ width: dragValue ?? inspectorWidth }}
    >
      <div className="h-full">{body}</div>
      {/* Drag divider: resize within [INSPECTOR_MIN, INSPECTOR_MAX]; dragging
          far right snaps the pane closed. */}
      <div
        {...handleProps}
        className="group absolute inset-y-0 left-0 z-10 w-[5px] cursor-col-resize"
      >
        <div
          className={cn(
            "absolute inset-y-0 left-0 w-[2px] transition-colors",
            dragging ? "bg-accent/60" : "bg-transparent group-hover:bg-accent/40",
          )}
        />
      </div>
    </div>
  );
}

/** Spacer at the start of a pane header row: when the pane is maximized on
 *  macOS its header becomes the window's top row, so this clears the native
 *  traffic lights (keeping everything on one line) and lets them drag the
 *  window. Renders nothing otherwise. */
/**
 * One height for every pane header.
 *
 * A pane beside a conversation has to line up with that conversation's own
 * header, or the two read as different planes of the app; they used to be 48px
 * against 32px, and the seam was visible across the whole window. 32px is also
 * what the Screen strip above them uses, so the three agree.
 */
export const PANE_HEADER =
  "flex h-8 shrink-0 select-none items-center gap-1 border-b border-faint px-2.5 has-[[data-titlebar-inset]]:h-auto";

/** A header that stays out of sight until it is needed: shown while hovered or
 *  focused, or while one of its menus is open (so it does not fade from under
 *  the pointer). Touch screens cannot hover — always shown there. For the
 *  header of a Screen's ONLY pane, where nothing beside it needs telling
 *  apart. */
export const HOVER_REVEAL =
  "opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100 [@media(hover:none)]:opacity-100";

/** Every icon button in a pane header — the conversation header's own look
 *  (13px glyph, muted until hovered, a soft hover fill), so a panel opened
 *  beside or over a conversation carries the same controls as it. */
export const PANE_ICON_BUTTON =
  "flex shrink-0 items-center rounded-md p-1 text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-40";
/** A pane-header toggle while it is on (history shown, and so on). */
export const PANE_ICON_BUTTON_ON = "bg-surface-2 text-text";

/** True when a pane header is the window's top row: a maximized panel, or a
 *  panel that fills a tiled pane in the window's top-left corner with the
 *  sidebar collapsed — it stands where the conversation header was, and that
 *  header was the one clearing the traffic lights. */
export const PaneHeaderClearsLights = createContext(false);

export function PaneTitlebarInset() {
  const clearsLights = useContext(PaneHeaderClearsLights);
  const overlayTitlebar = useOverlayTitlebar();
  if (!clearsLights || !overlayTitlebar) return null;
  // The same geometry as every other strip that clears the lights (see
  // lib/titlebar): the row is TITLEBAR_HEIGHT_PX tall — the lights are
  // positioned for that centre — and TRAFFIC_LIGHT_INSET_PX clear on the left,
  // less the header's own px-2.5; both counter-scaled by page zoom. The header
  // lets this set its height (`has-[[data-titlebar-inset]]:h-auto`).
  return (
    <div
      data-tauri-drag-region
      data-titlebar-inset
      className="shrink-0 self-stretch"
      style={{
        minHeight: `calc(${TITLEBAR_HEIGHT_PX}px / var(--zoom))`,
        width: `calc(${TRAFFIC_LIGHT_INSET_PX}px / var(--zoom) - 0.625rem)`,
      }}
    />
  );
}

/** Maximize / restore toggle for the pane's header row (session pages only —
 *  full-page viewers like the Files page have nothing to maximize over). */
export function MaximizePaneButton() {
  const { t } = useTranslation(["inspector", "common"]);
  const paneId = useContext(PaneIdContext);
  const maximized = useUiStore((s) => paneId !== null && s.inspectorMaximized === paneId);
  const setInspectorMaximized = useUiStore((s) => s.setInspectorMaximized);
  // Outside a RightPane there is no pane to maximize.
  if (paneId === null) return null;
  const label = maximized ? t("shell.restorePanel") : t("shell.maximizePanel");
  return (
    <button
      className={PANE_ICON_BUTTON}
      aria-label={label}
      title={label}
      onClick={() => setInspectorMaximized(maximized ? null : paneId)}
    >
      {maximized ? (
        <Minimize2 size={13} strokeWidth={1.5} />
      ) : (
        <Maximize2 size={13} strokeWidth={1.5} />
      )}
    </button>
  );
}
