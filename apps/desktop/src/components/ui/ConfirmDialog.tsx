import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { usePaneScope } from "@/components/session/PaneScope";
import { cn } from "@/lib/cn";

/**
 * Minimal in-app confirmation dialog. `window.confirm` is unreliable inside
 * the desktop webview, so destructive actions confirm through this instead.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  tone = "danger",
  scope = "window",
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  /** `danger` for an action that destroys something, `default` for one that is
   *  merely worth pausing over. A red button on a reversible action teaches the
   *  reader to ignore red. */
  tone?: "danger" | "default";
  /** How far the question reaches.
   *
   *  `window` for something that affects the whole app — closing a Screen,
   *  deleting a project. `pane` for a question about ONE pane's own work: it
   *  then covers that pane and nothing else, so a split shows the question over
   *  the conversation it is about rather than dimming the whole window and
   *  leaving the reader to work out which pane asked.
   *
   *  `pane` positions against the nearest positioned ancestor, which every
   *  tiled pane is (`PaneTree` gives each one `relative`). */
  scope?: "window" | "pane";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("common");
  const pane = usePaneScope();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // Inside the pane's own element, so `absolute` resolves against the pane and
  // not against whichever box on the way down happened to be positioned.
  const inPane = scope === "pane" && pane !== null;
  const dialog = (
    <div
      className={cn(
        "inset-0 z-50 flex items-center justify-center bg-black/30",
        inPane ? "absolute" : "fixed",
      )}
      onClick={onCancel}
      role="presentation"
    >
      <div
        role="alertdialog"
        aria-label={title}
        className="w-[360px] max-w-[calc(100%-2rem)] rounded-card border border-border bg-surface p-4 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-medium text-text">{title}</div>
        <p className="mt-1.5 text-sm text-muted">{body}</p>
        {/* Destructive action on the left, Cancel on the right and focused by
            default — so the safe choice is where the primary button usually
            sits and Enter/Space never triggers the destructive one. */}
        <div className="mt-4 flex justify-end gap-2">
          <button
            className={cn(
              "rounded-input px-3 py-1.5 text-sm font-medium text-white hover:opacity-90",
              tone === "danger" ? "bg-error" : "bg-accent",
            )}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
          <button
            autoFocus
            className="rounded-input border border-border px-3 py-1.5 text-sm text-text hover:bg-surface-2"
            onClick={onCancel}
          >
            {t("actions.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
  return inPane ? createPortal(dialog, pane) : dialog;
}
