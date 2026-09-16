import * as Primitive from "@radix-ui/react-context-menu";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Panel styling shared with the app's dropdown menus, so a right-click menu
 *  and a "…" menu are visibly the same object. */
const PANEL =
  "z-50 min-w-[190px] overflow-hidden rounded-card border border-border bg-surface p-1 text-[13px] text-text shadow-pop";
const ITEM =
  "flex cursor-pointer items-center gap-2 rounded-input px-2 py-1.5 outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-2";

/**
 * Right-click menu for one piece of app chrome.
 *
 * The packaged app suppresses the WebView's own page menu on chrome (see
 * `useNativeContextMenuGuard`), because "Open Link in New Window" / "Download
 * Linked File" are meaningless for a sidebar row. Anything right-clickable
 * therefore has to bring its OWN menu — this is it.
 */
export function ContextMenu({
  children,
  items,
  label,
}: {
  /** The chrome the menu belongs to. Rendered as-is. */
  children: ReactNode;
  items: ReactNode;
  /** Accessible name for the menu itself. */
  label: string;
}) {
  return (
    // `modal={false}`, as Orca sets on its own menus. A modal Radix menu mounts
    // a scroll lock over the whole document while it is open — fine for a
    // dialog, wrong for a right-click menu that sits on top of a scrollable
    // conversation, and a menu dismissed in an unexpected way can leave the
    // lock behind with nothing on screen to explain why the page stopped
    // scrolling.
    <Primitive.Root modal={false}>
      <Primitive.Trigger asChild>{children}</Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content aria-label={label} className={PANEL}>
          {items}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}

export function ContextMenuItem({
  icon,
  onSelect,
  danger = false,
  disabled = false,
  children,
}: {
  icon?: ReactNode;
  onSelect: () => void;
  /** Destructive actions read in the error colour. */
  danger?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Primitive.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(ITEM, danger && "text-error")}
    >
      {icon && <span className={cn("shrink-0", danger ? "text-error" : "text-muted")}>{icon}</span>}
      <span className="truncate">{children}</span>
    </Primitive.Item>
  );
}

/** A submenu, e.g. "Add to project ▸" over a list of projects. */
export function ContextMenuSub({
  icon,
  label,
  children,
}: {
  icon?: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <Primitive.Sub>
      <Primitive.SubTrigger className={cn(ITEM, "data-[state=open]:bg-surface-2")}>
        {icon && <span className="shrink-0 text-muted">{icon}</span>}
        <span className="truncate">{label}</span>
      </Primitive.SubTrigger>
      <Primitive.Portal>
        <Primitive.SubContent
          aria-label={label}
          className={cn(PANEL, "max-h-[320px] overflow-y-auto")}
        >
          {children}
        </Primitive.SubContent>
      </Primitive.Portal>
    </Primitive.Sub>
  );
}

export function ContextMenuSeparator() {
  return <Primitive.Separator className="my-1 h-px bg-border" />;
}

/** Shown in place of items when a submenu has nothing to offer. */
export function ContextMenuEmpty({ children }: { children: ReactNode }) {
  return <div className="px-2 py-1.5 text-muted">{children}</div>;
}
