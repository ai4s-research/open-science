import { useEffect } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { INSPECTOR_MAX, INSPECTOR_MIN, useOverlayTitlebar, useUiStore } from "@/lib/store";
import { cn } from "@/lib/cn";
import { useIsMobile } from "@/lib/useIsMobile";
import { useDragDivider } from "@/lib/useDragDivider";

/** Dragging the divider below this pane width closes the pane — the same
 *  snap-shut behaviour as the sidebar. Sits below INSPECTOR_MIN for a clear snap. */
const COLLAPSE_BELOW = 280;

/** The pane may never squeeze the conversation out on small windows. */
const MAX_FRACTION = 0.7;

/**
 * Resizable right pane hosting an inspector or the session Files browser.
 * The left-edge divider drags within [INSPECTOR_MIN, INSPECTOR_MAX] (persisted);
 * dragging it far right snaps the pane closed. Maximized, the pane covers the
 * whole window — sidebar and conversation stay mounted underneath.
 */
export function RightPane({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  const { inspectorWidth, inspectorMaximized, setInspectorWidth, setInspectorMaximized } =
    useUiStore();
  const isMobile = useIsMobile();

  // Maximized never outlives the pane — closing it returns the next pane
  // (possibly for a different artifact or session) to the normal split.
  useEffect(() => () => setInspectorMaximized(false), [setInspectorMaximized]);

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

  if (inspectorMaximized || isMobile) {
    // Maximized, OR mobile: the split-pane column (`lg:block`, fixed width) has
    // no room on a phone — show the pane full-screen instead (its own header
    // carries the close button). Without this the pane is display:none on
    // mobile, so the folder/runs toggles appear to "do nothing".
    return <div className="fixed inset-0 z-40 bg-surface">{children}</div>;
  }

  return (
    <div
      className="relative hidden h-full shrink-0 lg:block"
      style={{ width: dragValue ?? inspectorWidth }}
    >
      <div className="h-full">{children}</div>
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
  "flex h-8 shrink-0 select-none items-center gap-1.5 border-b border-border px-2.5";

export function PaneTitlebarInset() {
  const inspectorMaximized = useUiStore((s) => s.inspectorMaximized);
  const overlayTitlebar = useOverlayTitlebar();
  if (!inspectorMaximized || !overlayTitlebar) return null;
  // Headers pad 16px (px-4); the lights need ~78px clear in total.
  return <div data-tauri-drag-region className="w-[62px] shrink-0 self-stretch" />;
}

/** Maximize / restore toggle for the pane's header row (session pages only —
 *  full-page viewers like the Files page have nothing to maximize over). */
export function MaximizePaneButton() {
  const { t } = useTranslation(["inspector", "common"]);
  const inspectorMaximized = useUiStore((s) => s.inspectorMaximized);
  const setInspectorMaximized = useUiStore((s) => s.setInspectorMaximized);
  const label = inspectorMaximized ? t("shell.restorePanel") : t("shell.maximizePanel");
  return (
    <button
      className="text-text hover:opacity-60"
      aria-label={label}
      title={label}
      onClick={() => setInspectorMaximized(!inspectorMaximized)}
    >
      {inspectorMaximized ? (
        <Minimize2 size={14} strokeWidth={1.5} />
      ) : (
        <Maximize2 size={14} strokeWidth={1.5} />
      )}
    </button>
  );
}
