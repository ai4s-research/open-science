import { useEffect } from "react";
import { isTauri } from "@/lib/tauri";

/** Editable fields always keep the WebView's menu: Paste, spelling and Look Up
 *  all matter there, selection or not. */
const EDITABLE = 'input, textarea, [contenteditable="true"]';

/** Read-only DOCUMENT content — a conversation, a file preview, a code
 *  listing — keeps it only while something is SELECTED. See below. */
const DOCUMENT_CONTENT = "[data-native-menu]";

/**
 * True when the page menu should be allowed for this event target.
 *
 * On document content the answer depends on the selection, and that is the
 * whole point: with a selection the WebView offers Copy, Look Up and Translate,
 * which is exactly what a right-click on a sentence is for. With NOTHING
 * selected it offers "Back" and "Reload" — the menu of a web page, in an app
 * that is not one — so the right-click may as well belong to the pane it
 * happened in. Right-clicking a conversation used to give one or the other
 * depending on whether the pointer landed on text, which read as the menu
 * being broken.
 *
 * Everywhere else is chrome, and a chrome row is not a web page: offering
 * "Open Link in New Window" on a sidebar session is just wrong (it is an `<a>`
 * only incidentally). Those get their own menus.
 */
export function allowsNativeMenu(target: EventTarget | null, selection?: Selection | null): boolean {
  const el =
    target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (!el) return false;
  if (el.closest(EDITABLE)) return true;
  const content = el.closest(DOCUMENT_CONTENT);
  if (!content) return false;
  const active = selection === undefined ? currentSelection() : selection;
  return hasSelectionInside(content, active);
}

function currentSelection(): Selection | null {
  return typeof window === "undefined" ? null : window.getSelection();
}

/** A non-empty selection that actually lies inside `root`. */
export function hasSelectionInside(root: Element, selection: Selection | null): boolean {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  return root.contains(range.commonAncestorContainer);
}

/**
 * Whether to suppress the page menu for this contextmenu event.
 *
 * `defaultPrevented` means a component already handled the right-click and is
 * opening its OWN menu — Radix's context menus do exactly that. Suppressing
 * again would be redundant, and doing it FIRST is actively harmful: Radix's
 * `composeEventHandlers` skips its own handler once `defaultPrevented` is set,
 * so pre-empting it left the user with no menu at all, native or app.
 */
export function shouldSuppressNativeMenu(event: {
  target: EventTarget | null;
  defaultPrevented: boolean;
}): boolean {
  if (event.defaultPrevented) return false;
  return !allowsNativeMenu(event.target);
}

/**
 * Suppress the WebView page menu on app chrome, in the packaged app only.
 *
 * Left alone in the browser (gateway) client: there the app really IS a web
 * page, and the browser's own menu — open in new tab, back, reload — is the
 * user's, not ours to take away.
 */
export function useNativeContextMenuGuard(): void {
  useEffect(() => {
    if (!isTauri) return;
    const onContextMenu = (event: MouseEvent) => {
      if (shouldSuppressNativeMenu(event)) event.preventDefault();
    };
    // BUBBLE phase, deliberately: every component's own handler runs first, so
    // a component that opens its own menu is seen as such (see above). Bubbling
    // still reaches us before the browser's default action.
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);
}
