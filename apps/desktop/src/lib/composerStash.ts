// Unsent composer contents, by pane.
//
// A Composer's input state is deliberately component-local — a store written on
// every keystroke would repaint unrelated panes — but two things outside it need
// to know: a pane that unmounts (its Screen closed, or evicted) must not throw
// away what the user typed, and closing a Screen must know whether there is
// anything to lose before asking. So the Composer mirrors its draft here on
// every edit, and a fresh mount reclaims it. Cheap: a Map write, no render.

export interface ComposerDraft {
  text: string;
  files: string[];
}

const EMPTY: ComposerDraft = { text: "", files: [] };

const parked = new Map<string, ComposerDraft>();

/** Record a pane's unsent draft. An empty draft is dropped rather than stored. */
export function parkDraft(key: string, draft: ComposerDraft): void {
  if (!draft.text.trim() && draft.files.length === 0) parked.delete(key);
  else parked.set(key, draft);
}

/** Is there unsent input in this pane? Read-only — the draft stays put. */
export function hasParkedDraft(key: string): boolean {
  return parked.has(key);
}

/** Take a pane's parked draft, removing it — a draft belongs to one mount. */
export function unparkDraft(key: string): ComposerDraft {
  const draft = parked.get(key);
  parked.delete(key);
  return draft ?? EMPTY;
}

/** Test seam: forget every parked draft. */
export function resetParkedDrafts(): void {
  parked.clear();
}
