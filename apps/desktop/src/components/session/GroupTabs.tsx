import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X, PanelLeft } from "lucide-react";
import { groupLabel, useLayoutStore } from "@/lib/layout";
import { useOverlayTitlebar, useUiStore } from "@/lib/store";
import { overlayTitlebarStyle } from "@/lib/titlebar";
import { cn } from "@/lib/cn";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

/**
 * Horizontal group/"screen" tab strip at the very top of the live surface —
 * each tab is one independent pane layout (browser/iTerm style). As the
 * top-most element it owns the macOS overlay-titlebar clearance (traffic-light
 * inset + window-drag region), so no pane below needs to.
 */
export function GroupTabs() {
  const { t } = useTranslation(["session", "nav"]);
  const groups = useLayoutStore((s) => s.groups);
  const activeGroupId = useLayoutStore((s) => s.activeGroupId);
  const ephemeralGroupId = useLayoutStore((s) => s.ephemeralGroupId);
  const setActiveGroup = useLayoutStore((s) => s.setActiveGroup);
  const addGroup = useLayoutStore((s) => s.addGroup);
  const closeGroup = useLayoutStore((s) => s.closeGroup);
  const renameGroup = useLayoutStore((s) => s.renameGroup);

  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  const overlayTitlebar = useOverlayTitlebar();
  const isMac = navigator.userAgent.includes("Mac");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmCloseId, setConfirmCloseId] = useState<string | null>(null);
  const fallback = (n: number) => t("group.defaultName", { n });

  return (
    <>
      <div
        data-tauri-drag-region={overlayTitlebar || undefined}
        style={overlayTitlebar ? overlayTitlebarStyle(sidebarCollapsed) : undefined}
        className={cn(
          "flex shrink-0 items-center gap-1 border-b border-faint px-2",
          !overlayTitlebar && "h-9",
        )}
      >
        {/* Sidebar expand button: only when collapsed, and it lives here since this
            strip has taken over the top row (traffic-light clearance included). */}
        {sidebarCollapsed && (
          <button
            onClick={() => setSidebarCollapsed(false)}
            aria-label={t("nav:sidebar.expand")}
            title={t("nav:sidebar.expandTitle", { shortcut: isMac ? "⌘B" : "Ctrl+B" })}
            className="fade-in mr-0.5 rounded p-1 text-text hover:bg-surface-2"
          >
            <PanelLeft size={14} strokeWidth={1.5} />
          </button>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {groups.map((g, i) => {
            const active = g.id === activeGroupId;
            const ephemeral = g.id === ephemeralGroupId;
            return (
              <div
                key={g.id}
                // Dock-drag target: hovering this tab mid-drag switches screens (#4).
                data-group-tab={g.id}
                onClick={() => setActiveGroup(g.id)}
                onDoubleClick={() => setEditingId(g.id)}
                className={cn(
                  "group/tab flex h-7 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[12px] transition-colors",
                  active ? "bg-surface-2 text-text" : "text-muted hover:bg-surface-2/60",
                  // A tentative (preview) screen reads italic, like a browser preview tab.
                  ephemeral && "italic",
                )}
                title={t("group.renameHint")}
              >
                {editingId === g.id ? (
                  <TabNameInput
                    initial={g.name}
                    placeholder={fallback(i + 1)}
                    onCommit={(name) => {
                      renameGroup(g.id, name);
                      setEditingId(null);
                    }}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <span className="max-w-[160px] truncate">{groupLabel(g, i, fallback)}</span>
                )}
                {/* Close is always available — closing the last group empties it. */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmCloseId(g.id);
                  }}
                  aria-label={t("group.close")}
                  className={cn(
                    "-mr-1 rounded p-0.5 text-muted hover:bg-border hover:text-text",
                    active ? "opacity-70" : "opacity-0 group-hover/tab:opacity-70",
                  )}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
          <button
            onClick={() => addGroup()}
            aria-label={t("group.newTab")}
            title={t("group.newTab")}
            className="shrink-0 rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text"
          >
            <Plus size={14} strokeWidth={1.5} />
          </button>
        </div>
      </div>
      {confirmCloseId && (
        <ConfirmDialog
          title={t("group.confirmCloseScreen.title")}
          body={t("group.confirmCloseScreen.body")}
          confirmLabel={t("group.confirmCloseScreen.action")}
          onConfirm={() => {
            closeGroup(confirmCloseId);
            setConfirmCloseId(null);
          }}
          onCancel={() => setConfirmCloseId(null)}
        />
      )}
    </>
  );
}

/** Inline rename field for a group tab; commits on Enter/blur, cancels on Esc. */
function TabNameInput({
  initial,
  placeholder,
  onCommit,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      value={value}
      placeholder={placeholder}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(value);
        else if (e.key === "Escape") onCancel();
      }}
      className="h-5 w-28 rounded border border-border bg-surface px-1 text-[12px] text-text outline-none"
    />
  );
}
