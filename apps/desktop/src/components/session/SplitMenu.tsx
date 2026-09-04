import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FolderOpen, FolderPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { isTauri, pickFolder } from "@/lib/tauri";
import { baseName } from "@/components/thread/WorkspaceChip";
import { datedWorkspaceName } from "@/lib/runtime";

/** Menu width, needed in JS to clamp it to the window. */
const MENU_W = 260;
/** Breathing room kept between the menu and the window edges. */
const MARGIN = 8;

/**
 * A split button that asks where the new pane's work should live, and splits
 * with that answer — the choice is made before the pane exists, not offered
 * inside it afterwards.
 *
 * A split usually continues the work in front of you, so continuing in the
 * source pane's folder is the first item; a fresh dated folder (which used to
 * be the only outcome, #69) is the second; the native picker stays available
 * for anywhere else. Nothing touches the filesystem here — the answer is
 * recorded as the new pane's aim and acted on by its first message, so a pane
 * that is closed unused creates nothing.
 *
 * With no folder to continue (a source pane that has none, or the web client
 * where folders are not the user's to pick) there is nothing to ask: the button
 * splits on the first click, as it always did.
 *
 * Hand-rolled rather than a Radix menu: this sits in a pane header, so it has
 * to escape the pane's overflow (a body portal, fixed coordinates, clamped to
 * the window — the same shape as the goal popover) and it has to appear on the
 * frame it is asked for. A popper library measures and re-measures to place
 * itself, which on a workbench holding several laid-out screens is exactly the
 * hitch this menu was reported for. One rect read is enough.
 */
export function SplitMenu({
  sourceFolder,
  onSplit,
  icon,
  label,
}: {
  /** Folder the new pane would continue in; null when there is none. */
  sourceFolder: string | null;
  /** `null` means the pane makes its own dated folder on first send. */
  onSplit: (folder: string | null) => void;
  icon: ReactNode;
  label: string;
}) {
  const { t } = useTranslation("session");
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
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

  // Placed once, in the layout effect of the render that opens it: right-aligned
  // under the button, clamped to the window, flipped above when the bottom edge
  // is closer than the menu is tall.
  useLayoutEffect(() => {
    if (!open) return setAt(null);
    const anchor = rootRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const width = Math.min(MENU_W, window.innerWidth - 2 * MARGIN);
    const height = menuRef.current?.offsetHeight ?? 0;
    const below = anchor.bottom + 4;
    setAt({
      left: Math.max(MARGIN, Math.min(anchor.right - width, window.innerWidth - MARGIN - width)),
      top:
        below + height > window.innerHeight - MARGIN && anchor.top - height - 4 > MARGIN
          ? anchor.top - height - 4
          : below,
    });
  }, [open]);

  const pick = (folder: string | null) => {
    setOpen(false);
    onSplit(folder);
  };

  const trigger = (
    <button
      onClick={() => {
        if (!isTauri || !sourceFolder) return onSplit(null);
        setOpen((o) => !o);
      }}
      className="rounded-md p-1 text-muted transition-colors hover:bg-surface-2 hover:text-text"
      title={label}
      aria-label={label}
      aria-expanded={open}
    >
      {icon}
    </button>
  );

  const item =
    "flex w-full items-center gap-2 rounded-input px-2 py-1.5 text-left text-xs text-text hover:bg-surface-2";
  return (
    <div ref={rootRef} className="shrink-0">
      {trigger}
      {open &&
        sourceFolder &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ top: at?.top ?? 0, left: at?.left ?? 0 }}
            className={cn(
              "fixed z-[60] w-[min(16.25rem,calc(100vw-16px))] rounded-card border border-border",
              "bg-surface p-1 shadow-pop",
              // Hidden until placed, so it never paints at the top-left corner.
              !at && "invisible",
            )}
          >
            <div className="px-2 py-1.5 text-[11px] text-muted">{t("splitDestination.title")}</div>
            <button className={item} onClick={() => pick(sourceFolder)}>
              <FolderOpen size={13} className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate">
                {t("splitDestination.continueIn", { name: baseName(sourceFolder) })}
              </span>
            </button>
            <button className={item} onClick={() => pick(null)}>
              <FolderPlus size={13} className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate">{t("splitDestination.newFolder")}</span>
              <span className="shrink-0 font-mono text-[11px] text-muted">
                {datedWorkspaceName()}
              </span>
            </button>
            <button
              className={cn(item, "text-muted")}
              // Pick first, split only if the user actually chose a folder.
              onClick={() => {
                void pickFolder().then((dir) => {
                  setOpen(false);
                  if (dir) onSplit(dir);
                });
              }}
            >
              <span className="min-w-0 flex-1 truncate">{t("splitDestination.chooseOther")}</span>
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
