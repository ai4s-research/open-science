import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { FolderInput } from "lucide-react";
import { useDragPane } from "@/lib/dragPane";

/**
 * A shrunk session-card preview that follows the cursor during a pane drag.
 * Fixed + pointer-events:none so it never blocks the drop hit-test underneath.
 * Mounted once at the app root; renders nothing when no drag is in flight.
 */
export function PaneDragGhost() {
  const { t } = useTranslation("session");
  const active = useDragPane((s) => s.active);
  if (typeof document === "undefined" || !active) return null;
  const into = active.target && "projectId" in active.target ? active.target.name : null;
  return createPortal(
    <div
      className="pointer-events-none fixed left-0 top-0 z-[100]"
      style={{ transform: `translate(${active.x + 14}px, ${active.y + 12}px)` }}
    >
      <div className="w-56 overflow-hidden rounded-card border border-border bg-surface shadow-card opacity-90">
        {/* A miniature of a session pane: a title bar + a couple of faint lines. */}
        <div className="flex h-7 items-center border-b border-faint px-2.5">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok" />
          <span className="ml-2 truncate text-[12px] font-medium text-text">
            {active.title || t("starters.newSession")}
          </span>
        </div>
        {/* Over a sidebar project the drop files the session there, so the
            card says where it is going instead of miming a pane. */}
        {into ? (
          <div className="flex items-center gap-1.5 px-2.5 py-2 text-[12px] text-accent">
            <FolderInput size={13} className="shrink-0" />
            <span className="truncate">{t("drag.moveInto", { name: into })}</span>
          </div>
        ) : (
          <div className="space-y-1.5 p-2.5">
            <div className="h-2 w-11/12 rounded bg-surface-2" />
            <div className="h-2 w-3/5 rounded bg-surface-2" />
            <div className="ml-auto h-6 w-4/5 rounded-card bg-surface-2/70" />
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
