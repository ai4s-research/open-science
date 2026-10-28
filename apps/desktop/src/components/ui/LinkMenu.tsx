import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { absoluteArtifactPath, revealArtifact } from "@/lib/artifactFile";
import { copyText } from "@/lib/clipboard";
import { openInApp, openWithDefaultApp, showInFiles, useLinkMenu, type LinkTarget } from "@/lib/links";
import { isGatewayWeb } from "@/lib/webMode";
import { toast } from "@/lib/toast";

const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");
const MOD = isMac ? "⌘" : "Ctrl";
const SHIFT = isMac ? "⇧" : "Shift";

/**
 * The menu a clicked link opens (see lib/links): the full target on top, then
 * what can be done with it, each with the click that does it directly. One
 * instance for the whole app, at the pointer, kept inside the window.
 */
export function LinkMenu() {
  const open = useLinkMenu((s) => s.open);
  const hide = useLinkMenu((s) => s.hide);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !ref.current) return setPos(null);
    const { width, height } = ref.current.getBoundingClientRect();
    const margin = 8;
    setPos({
      left: Math.max(margin, Math.min(open.x, window.innerWidth - width - margin)),
      top: open.y + height + margin > window.innerHeight ? open.y - height - 4 : open.y + 4,
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) hide();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    // Capture: a terminal or a scroller under the pointer must not swallow the
    // click that dismisses the menu.
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", hide);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", hide);
      window.removeEventListener("resize", hide);
    };
  }, [open, hide]);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={pos ?? { left: open.x, top: open.y, visibility: "hidden" }}
      className="fixed z-[60] w-[min(360px,calc(100vw-16px))] rounded-card border border-border bg-surface p-1 text-[13px] text-text shadow-pop"
    >
      <MenuBody target={open.target} done={hide} />
    </div>,
    document.body,
  );
}

function MenuBody({ target, done }: { target: LinkTarget; done: () => void }) {
  const { t } = useTranslation("common");
  const [full, setFull] = useState<string | null>(null);
  useEffect(() => {
    if (target.kind !== "path") return;
    let live = true;
    void absoluteArtifactPath(target.path, target.root).then((p) => live && setFull(p));
    return () => {
      live = false;
    };
  }, [target]);

  const shown = target.kind === "url" ? target.url : (full ?? target.display);
  const direct = [MOD, t("linkMenu.click")];
  const shifted = [SHIFT, MOD, t("linkMenu.click")];
  const run = (action: () => void) => () => {
    done();
    action();
  };
  const copy = async () => {
    try {
      await copyText(shown);
      toast.success(t("linkMenu.copied"));
    } catch {
      /* the clipboard refused; nothing else to do */
    }
  };

  return (
    <>
      <div className="break-all border-b border-border px-2.5 pb-2 pt-1.5 font-mono text-[12px] leading-relaxed text-muted">
        {shown}
      </div>
      <div className="pt-1">
        {target.kind === "url" ? (
          <>
            <Item label={t("linkMenu.openLink")} keys={direct} onSelect={run(() => openWithDefaultApp(target))} />
            <Item label={t("linkMenu.copyLink")} onSelect={run(() => void copy())} />
          </>
        ) : (
          <>
            {!target.isDir && (
              <Item label={t("linkMenu.openFile")} keys={direct} onSelect={run(() => openInApp(target))} />
            )}
            {/* Only a base-relative target knows where in the tree it is. */}
            {target.root === "base" && (
              <Item
                label={t("linkMenu.showInFiles")}
                keys={target.isDir && isGatewayWeb ? direct : undefined}
                onSelect={run(() => showInFiles(target))}
              />
            )}
            {/* A browser has no default apps to hand a file to, and no file
                manager to show it in. */}
            {!isGatewayWeb && (
              <>
                <Item
                  label={t("linkMenu.openDefault")}
                  keys={target.isDir ? direct : shifted}
                  onSelect={run(() => openWithDefaultApp(target))}
                />
                <Item
                  label={t("linkMenu.reveal")}
                  onSelect={run(() =>
                    void revealArtifact(target.path, target.root).catch((e: unknown) =>
                      toast.error(e instanceof Error ? e.message : String(e)),
                    ),
                  )}
                />
              </>
            )}
            <Item label={t("linkMenu.copyPath")} onSelect={run(() => void copy())} />
          </>
        )}
      </div>
    </>
  );
}

function Item({ label, keys, onSelect }: { label: string; keys?: string[]; onSelect: () => void }) {
  return (
    <button
      role="menuitem"
      onClick={onSelect}
      className="flex w-full items-center gap-3 rounded-input px-2.5 py-1.5 text-left hover:bg-surface-2 focus:bg-surface-2 focus:outline-none"
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {keys && (
        <span className="flex shrink-0 gap-1">
          {keys.map((k) => (
            <kbd
              key={k}
              className="rounded border border-border px-1.5 font-sans text-[11px] leading-5 text-muted"
            >
              {k}
            </kbd>
          ))}
        </span>
      )}
    </button>
  );
}
