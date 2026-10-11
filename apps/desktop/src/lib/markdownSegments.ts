/**
 * Split streaming markdown into SEALED segments plus a live TAIL (#157).
 *
 * While an answer streams, its markdown grows token by token. Re-parsing the
 * whole document on every update is O(total length) per update — react-markdown
 * plus rehype-highlight re-tokenize every code block and table that was already
 * final long ago. Sealed segments fix that: a segment is closed at the first
 * blank line that sits outside any code fence / block math, and from then on
 * its text never changes, so a memoized renderer never touches it again. Only
 * the live tail (everything after the last seal point) re-parses per update.
 *
 * Invariants the renderer relies on:
 *  - `sealed.join("") + tail === text` — splitting never loses or reorders a
 *    single character; worst case a split point is cosmetically imperfect.
 *  - Prefix stability — appending more text to `text` never changes or unseals
 *    an already-sealed segment: boundary positions depend only on text that
 *    precedes them, and fences/math open earlier can only postpone sealing,
 *    never move an existing boundary.
 */
export interface StreamingSegments {
  sealed: string[];
  tail: string;
}

const FENCE = /^(\s*)(`{3,}|~{3,})/;
const MATH = /^\s*\$\$/;

export function splitStreamingMarkdown(text: string): StreamingSegments {
  const sealed: string[] = [];
  let fence: string | null = null; // "```" style marker that opened the fence
  let inMath = false;
  let hasContent = false; // current segment holds a non-blank line
  let segStart = 0;

  const n = text.length;
  let i = 0;
  while (i < n) {
    let eol = text.indexOf("\n", i);
    if (eol === -1) eol = n;
    const line = text.slice(i, eol);
    const trimmed = line.trim();

    const fenceHit = line.match(FENCE);
    if (fenceHit) {
      // A fence closes only on the same marker family; anything longer or
      // different-looking while open is just content to us — concatenation is
      // lossless either way, this only decides where sealing may happen.
      if (fence === null) fence = fenceHit[2];
      else if (fenceHit[2].startsWith(fence[0]!)) fence = null;
    } else if (fence === null && MATH.test(line)) {
      // "$$...$$" self-contained on one line opens and closes at once.
      const selfContained = trimmed.length > 3 && trimmed.endsWith("$$");
      if (!selfContained) inMath = !inMath;
    }

    const blank = trimmed === "";
    if (blank && fence === null && !inMath && hasContent) {
      // Seal through this blank line's newline: the blank line belongs to the
      // segment it ends, so a sealed segment renders with its trailing gap.
      const end = eol < n ? eol + 1 : n;
      sealed.push(text.slice(segStart, end));
      segStart = end;
      hasContent = false;
    } else if (!blank) {
      hasContent = true;
    }
    i = eol + 1;
  }

  return { sealed, tail: text.slice(segStart) };
}
