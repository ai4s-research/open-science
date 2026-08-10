// Unsent composer contents, parked by pane while that pane is not mounted.
//
// Only the active screen's panes are rendered (keeping every screen mounted is
// what makes switching slow), so a pane's Composer is torn down and rebuilt as
// the user moves between screens. Its input state is deliberately component-
// local — a store written on every keystroke would repaint unrelated panes — so
// it is parked here on unmount and reclaimed on mount. That keeps each pane's
// draft its own (#91) without throwing away what the user typed.

export interface ComposerDraft {
  text: string;
  files: string[];
}

const EMPTY: ComposerDraft = { text: "", files: [] };

const parked = new Map<string, ComposerDraft>();

/** Park a pane's unsent draft. An empty draft is dropped rather than stored. */
export function parkDraft(key: string, draft: ComposerDraft): void {
  if (!draft.text && draft.files.length === 0) parked.delete(key);
  else parked.set(key, draft);
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
