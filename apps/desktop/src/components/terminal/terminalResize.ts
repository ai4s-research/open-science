/**
 * Claude Code's answer to a resize, and how to splice it into the terminal
 * without losing or repeating a line.
 *
 * Its classic renderer answers a resize by erasing exactly the screen
 * (`CSI H`, then `CSI 2K CSI 1B` once per row), homing again, and printing its
 * latest turn laid out for the new width, ending with `CSI ?25h`. Taken as it
 * is, that turn lands on top of the copy the terminal already holds: after a
 * narrowing the part that scrolls off stacks a second copy in scrollback
 * (anthropics/claude-code#51828), and the rows it erases may hold lines it
 * does not redraw.
 *
 * So the repaint is spliced in instead. The old screen and the repaint are
 * lined up at a row that begins with the same text in both; the old rows above
 * it stay where they are, to be re-wrapped by the terminal like any output,
 * and the repaint is written from the matching line down.
 */

export interface Repaint {
  /** Output before the repaint: the end of a frame drawn for the old size. */
  before: string;
  /** The turn, one entry per line. */
  lines: string[];
  /** From `CSI ?25h` on. */
  tail: string;
}

// eslint-disable-next-line no-control-regex -- escape sequences are the subject
const ESCAPE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex -- as above
const COLOUR = /\x1b\[[0-9;]*m/g;
const SHOW_CURSOR = "\x1b[?25h";

/** Where every such repaint starts, whatever the number of rows. */
export const REPAINT_START = "\x1b[H\x1b[2K\x1b[1B";

/** The repaint in `data`, or null while it has not fully arrived. */
export function readRepaint(data: string, rows: number): Repaint | null {
  const erase = `\x1b[H${"\x1b[2K\x1b[1B".repeat(rows)}\x1b[H`;
  const at = data.indexOf(erase);
  if (at < 0) return null;
  const start = at + erase.length;
  const end = data.indexOf(SHOW_CURSOR, start);
  if (end < 0) return null;
  return {
    before: data.slice(0, at),
    lines: data.slice(start, end).split("\n"),
    tail: data.slice(end),
  };
}

/** Text only: no escapes, no whitespace, so it compares across widths. */
const bare = (s: string) => s.replace(ESCAPE, "").replace(/\s+/g, "");

/** How much of a row's start must match to line the two up. */
const MATCH_CHARS = 24;
const MIN_MATCH_CHARS = 12;

/**
 * What to write for `repaint` given the rows on screen before the resize:
 * `clear` before xterm resizes (erases the old rows from the matching one down
 * and leaves the cursor there), `repaint` after (written at the cursor).
 *
 * The match is the topmost old row whose start, and a repaint line's start,
 * are the same text, found once and only once on each side. With none
 * (`matched` false), the repaint goes below everything on screen: a copy too
 * many, no line lost.
 */
export function spliceRepaint(
  { lines, tail }: Repaint,
  oldScreen: string[],
): { clear: string; repaint: string; matched: boolean } {
  const newText = lines.map(bare);
  const oldText = oldScreen.map(bare);
  const newJoined = newText.join("");
  const oldJoined = oldText.join("");
  const once = (whole: string, part: string) => {
    const at = whole.indexOf(part);
    return at >= 0 && whole.indexOf(part, at + 1) < 0;
  };

  let row = -1;
  let from = 0;
  for (let r = 0; r < oldText.length && row < 0; r++) {
    for (let l = 0; l < newText.length; l++) {
      const n = Math.min(MATCH_CHARS, oldText[r].length, newText[l].length);
      if (n < MIN_MATCH_CHARS) continue;
      const key = oldText[r].slice(0, n);
      if (newText[l].slice(0, n) !== key) continue;
      if (once(oldJoined, key) && once(newJoined, key)) {
        row = r;
        from = l;
      }
      break;
    }
  }

  let clear: string;
  if (row >= 0) {
    clear = `\x1b[${row + 1};1H\x1b[J`;
  } else {
    // Below the last row with anything on it.
    const used = oldText.reduce((last, text, r) => (text ? r + 1 : last), 0);
    clear =
      used < oldScreen.length
        ? `\x1b[${used + 1};1H\x1b[J`
        : `\x1b[${oldScreen.length};1H\r\n`;
  }
  // Colours set on skipped lines may still apply to the lines written.
  const colours = lines.slice(0, from).join("").match(COLOUR) ?? [];
  return {
    clear,
    repaint: "\r" + colours.join("") + lines.slice(from).join("\n") + tail,
    matched: row >= 0,
  };
}
