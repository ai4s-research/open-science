import type { MouseEvent as ReactMouseEvent } from "react";

/**
 * A press on the padding of a card that wraps a text input is a press on the
 * input. The padding is page chrome, so a drag that began there started a PAGE
 * selection: it swept up the conversation around the card and drew the input
 * as one highlighted block. Controls inside the card (the input itself,
 * buttons, links, menus) keep their own behavior.
 */
export function pressOnPadding(e: ReactMouseEvent, input: HTMLTextAreaElement | HTMLInputElement | null): void {
  const target = e.target as HTMLElement;
  if (e.button !== 0 || target.closest("textarea, input, button, a, [role='option'], [role='listbox']")) return;
  e.preventDefault();
  if (input && document.activeElement !== input) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}
