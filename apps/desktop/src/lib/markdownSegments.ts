/**
 * Split streaming markdown into SEALED segments plus a live TAIL (#157).
 *
 * While an answer streams, its markdown grows token by token. Re-parsing the
 * whole document on every update is O(total length) per update — react-markdown
 * plus rehype-highlight re-tokenize every code block and table that was already
 * final long ago. Sealed segments fix that: a segment is closed at a blank
 * line that sits outside any code fence / block math, and from then on its
 * text never changes, so a memoized renderer never touches it again. Only the
 * live tail (everything after the last seal point) re-parses per update.
 *
 * A blank line only seals once the line after it is known to start a new
 * top-level block: an indented line or a list item still belongs to the block
 * before it (a loose list, a code block inside a list item), and rendering the
 * two halves apart would break the list and show the fence as literal text.
 *
 * Invariants the renderer relies on:
 *  - `sealed.join("") + tail === text` — splitting never loses or reorders a
 *    single character; worst case a split point is cosmetically imperfect.
 *  - Prefix stability — appending more text to `text` never changes or unseals
 *    an already-sealed segment: a boundary is decided from the text before
 *    it plus the leading characters of the next line, and only once those can
 *    no longer change meaning as the line grows.
 */
export interface StreamingSegments {
  sealed: string[];
  tail: string;
}

const FENCE = /^(\s*)(`{3,}|~{3,})/;
const MATH = /^\s*\$\$/;
const LIST_ITEM = /^([-*+]|\d{1,9}[.)])(\s|$)/;
const LIST_ITEM_PREFIX = /^([-*+]|\d{1,9}[.)]?)$/;

/** Does `line`, the first non-blank line after a blank one, start a new
 *  top-level block? `null` while the still-growing last line could yet turn
 *  into a list item ("1" → "1. step"). */
function startsNewBlock(line: string, complete: boolean): boolean | null {
  if (/^\s/.test(line) || LIST_ITEM.test(line)) return false;
  if (!complete && LIST_ITEM_PREFIX.test(line)) return null;
  return true;
}

export function splitStreamingMarkdown(text: string): StreamingSegments {
  const sealed: string[] = [];
  let fence: string | null = null; // "```" style marker that opened the fence
  let inMath = false;
  let hasContent = false; // current segment holds a non-blank line
  let segStart = 0;
  let boundary: number | null = null; // seal point awaiting the next line's verdict

  const n = text.length;
  let i = 0;
  while (i < n) {
    let eol = text.indexOf("\n", i);
    const complete = eol !== -1;
    if (!complete) eol = n;
    const line = text.slice(i, eol);
    const trimmed = line.trim();
    const blank = trimmed === "";

    if (!blank && boundary !== null) {
      const verdict = startsNewBlock(line, complete);
      if (verdict === null) break; // undecided: only ever the last line
      if (verdict) {
        sealed.push(text.slice(segStart, boundary));
        segStart = boundary;
      }
      boundary = null;
    }

    const fenceHit = line.match(FENCE);
    if (fence !== null) {
      // A fence closes on a marker of the same character, at least as long as
      // the opener and with nothing after it — a shorter or labelled fence
      // inside is content (a ```js example inside a ```` block).
      if (
        fenceHit &&
        fenceHit[2][0] === fence[0] &&
        fenceHit[2].length >= fence.length &&
        line.slice(fenceHit[0].length).trim() === ""
      )
        fence = null;
    } else if (fenceHit) {
      fence = fenceHit[2];
    } else if (MATH.test(line)) {
      // "$$...$$" self-contained on one line opens and closes at once.
      const selfContained = trimmed.length > 3 && trimmed.endsWith("$$");
      if (!selfContained) inMath = !inMath;
    }

    if (blank && fence === null && !inMath && hasContent && boundary === null) {
      // The blank line belongs to the segment it ends, so a sealed segment
      // renders with its trailing gap.
      boundary = complete ? eol + 1 : n;
      hasContent = false;
    } else if (!blank) {
      hasContent = true;
    }
    i = eol + 1;
  }

  return { sealed, tail: text.slice(segStart) };
}
