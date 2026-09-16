import type { SearchAddon } from "@xterm/addon-search";

type SearchOptions = Parameters<SearchAddon["findNext"]>[1];

/**
 * How a match is painted.
 *
 * Borrowed from Orca (`TerminalSearch.tsx`), including the reason it spells the
 * colours out: xterm's default highlight blends into most terminal
 * backgrounds. All matches get a dim amber, the current one a brighter orange —
 * the contrast VS Code and iTerm2 use. xterm requires `#RRGGBB`, so these
 * cannot be the app's CSS variables.
 */
export const SEARCH_DECORATIONS = {
  matchBackground: "#5c4a00",
  matchBorder: "#5c4a00",
  matchOverviewRuler: "#ffcc00",
  activeMatchBackground: "#c4580e",
  activeMatchBorder: "#ffcf6b",
  activeMatchColorOverviewRuler: "#ff9900",
} as const;

/** A query longer than this is not a search, it is a paste accident. */
export const QUERY_MAX_BYTES = 2 * 1024;

export function queryIsUsable(query: string): boolean {
  return new TextEncoder().encode(query).length <= QUERY_MAX_BYTES;
}

export function searchOptions(options: {
  caseSensitive: boolean;
  regex: boolean;
  incremental?: boolean;
}): SearchOptions {
  return {
    caseSensitive: options.caseSensitive,
    regex: options.regex,
    incremental: options.incremental ?? false,
    decorations: { ...SEARCH_DECORATIONS },
  };
}

/**
 * Run a find, surviving the one failure xterm has that a search must not turn
 * into a dead terminal.
 *
 * Borrowed from Orca's `terminal-search-safe-find`, whose note explains it:
 * the addon builds a decoration whose width is `cols - matchCol`, and when the
 * viewport is narrower than the column a match starts at — content laid out
 * wide before the pane reflowed, or a pane collapsed to zero — that width goes
 * negative and xterm throws "This API only accepts positive integers"
 * synchronously inside `findNext`. Thrown from a React handler it takes the
 * whole terminal surface down with it.
 *
 * Navigation happens BEFORE the decoration is built, so swallowing exactly that
 * error keeps the search working and merely drops the highlight for one frame.
 */
export function safeFind(
  find: (term: string, options?: SearchOptions) => boolean,
  term: string,
  options?: SearchOptions,
): boolean {
  try {
    return find(term, options);
  } catch (error) {
    if (error instanceof Error && /only accepts positive integers/i.test(error.message)) {
      return false;
    }
    throw error;
  }
}

/** Put the terminal back the way it was: no highlights, nothing selected. */
export function clearSearch(addon: SearchAddon | null): void {
  if (!addon) return;
  addon.clearDecorations();
  // xterm keeps the active match SELECTED after its decorations are cleared,
  // which reads as a stray highlight nobody can dismiss.
  safeFind((term, options) => addon.findNext(term, options), "");
}
