/**
 * The one icon column shared by every row of an activity run — the run's own
 * summary line, each tool step, and each interleaved thought.
 *
 * Its own module rather than a constant exported from `ToolGroup`: the rows that
 * need it are the ones `ToolGroup` imports, so taking it from there put a cycle
 * between the two files. It would have worked (the value is read at render time,
 * not at module init) and that is exactly why it was worth not relying on.
 *
 * Why a fixed slot at all: the leading glyphs differ in size — `Check` at 13,
 * `AlertTriangle` and `X` at 14, a brain, a running dot — so letting each size
 * itself left the column ragged down the whole group.
 */
export const ICON_SLOT = "flex w-4 shrink-0 items-center justify-center";
