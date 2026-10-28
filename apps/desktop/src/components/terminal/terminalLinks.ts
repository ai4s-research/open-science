import type { IBufferCell, IBufferLine, ILink, Terminal } from "@xterm/xterm";
import { activateLink, anchorPaths, cleanPath, linkCandidates, mergeAnchors, resolveLink, type LinkSpan, type LinkTarget } from "@/lib/links";

/** A cell's colors and attributes as one key; "" for the default style. */
export function cellStyle(cell: IBufferCell): string {
  const flags = [cell.isBold(), cell.isItalic(), cell.isDim(), cell.isUnderline(), cell.isInverse(), cell.isStrikethrough()]
    .map((f) => (f ? 1 : 0))
    .join("");
  if (cell.isFgDefault() && cell.isBgDefault() && !flags.includes("1")) return "";
  return `${cell.getFgColorMode()}:${cell.getFgColor()} ${cell.getBgColorMode()}:${cell.getBgColor()} ${flags}`;
}

/** The style of a cell nothing was printed into. A TUI moves the cursor over
 *  the spaces between words instead of printing them (Claude Code does when it
 *  redraws a resumed conversation), so a gap inside a path is such a cell. */
export const BLANK = "blank";

/** One printed cell: its column, width and style (see `cellStyle`, `BLANK`). */
export interface Cell {
  x: number;
  width: number;
  style: string;
}

/** One row's text, with the cell each UTF-16 unit of it sits in. A wide (CJK)
 *  character takes two cells, so a string index is not a column. */
export function rowText(line: Pick<IBufferLine, "length" | "getCell">): { text: string; cells: Cell[] } {
  let text = "";
  const cells: Cell[] = [];
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell) break;
    const width = cell.getWidth();
    if (width === 0) continue; // the second half of a wide character
    const printed = cell.getChars();
    const chars = printed || " ";
    const style = printed ? cellStyle(cell) : BLANK;
    for (let i = 0; i < chars.length; i++) cells.push({ x, width, style });
    text += chars;
  }
  return { text, cells };
}

/** One buffer row as the link finder reads it. `wrapped`: the terminal itself
 *  continued the previous row here (the line was longer than the width). */
export interface Row {
  text: string;
  cells: Cell[];
  wrapped: boolean;
}

/** A printed line put back together from the rows it was broken over. */
export interface LogicalLine {
  text: string;
  /** The cell (and 1-based row) of each UTF-16 unit of `text`. */
  cells: (Cell & { y: number })[];
  /** Where a TUI broke the line itself: the next row's text starts at `at`.
   *  `nearEdge` — the row before ran up to the right edge, so a break there is
   *  almost certainly a wrap and not the end of a sentence. */
  breaks: { at: number; nearEdge: boolean }[];
}

/** How far a line is followed up and down. A path or URL longer than this
 *  many rows is not worth the lookups. */
const MAX_ROWS = 8;
/** A row whose text ends within this many columns of the right edge "ran into
 *  it". TUIs wrap a little short of the terminal width (margins, a scrollbar). */
const EDGE_COLUMNS = 8;
/** Characters a path or URL can end or start a row with. */
const LINK_CHAR = /[\w.@+\-/\\~%#=&?:\u00c0-\u2fff\u3040-\ufeff]/;

/**
 * The line row `y` is part of. Rows join when the terminal wrapped them, or
 * when a TUI did — Claude Code, Codex and the like break long lines with a
 * newline and indent the rest, so a long path arrives as several unrelated
 * rows. A TUI break is assumed wherever one row ends and the next begins with
 * a character a link can contain; a span that crosses one is only kept if it
 * resolves (see `registerTerminalLinks`), so a wrong guess costs a lookup.
 */
export function logicalLine(row: (y: number) => Row | null, y: number, cols: number): LogicalLine {
  const trimEnd = (r: Row) => r.text.replace(/\s+$/, "");
  /** How row `b` continues row `a`: soft, hard (a TUI break), or not at all. */
  const join = (a: Row, b: Row): "soft" | "hard" | null => {
    if (b.wrapped) return "soft";
    const end = trimEnd(a);
    const start = b.text.trimStart();
    if (!end || !start) return null;
    return LINK_CHAR.test(end[end.length - 1]) && LINK_CHAR.test(start[0]) ? "hard" : null;
  };

  let first = y;
  for (let n = 0; n < MAX_ROWS; n++) {
    const above = row(first - 1);
    const here = row(first);
    if (!above || !here || !join(above, here)) break;
    first--;
  }
  const out: LogicalLine = { text: "", cells: [], breaks: [] };
  let prev: Row | null = null;
  for (let r = first; r <= y + MAX_ROWS; r++) {
    const cur = row(r);
    if (!cur) break;
    let from = 0;
    if (prev) {
      const how = join(prev, cur);
      if (!how) break;
      if (how === "hard") {
        // Drop the previous row's trailing blanks and this row's indent.
        const dropped = prev.text.length - trimEnd(prev).length;
        out.text = out.text.slice(0, out.text.length - dropped);
        out.cells.length -= dropped;
        const last = out.cells[out.cells.length - 1];
        out.breaks.push({ at: out.text.length, nearEdge: last.x + last.width >= cols - EDGE_COLUMNS });
        from = cur.text.length - cur.text.trimStart().length;
      }
    }
    out.text += cur.text.slice(from);
    for (let i = from; i < cur.text.length; i++) out.cells.push({ ...cur.cells[i], y: r });
    prev = cur;
  }
  return out;
}

/** A path with spaces is not found by shape. Programs print it in a style of
 *  its own (Claude Code's inline code), as an answer prints it in a code span,
 *  so each styled run is also tried whole, as VS Code does. Unstyled text is
 *  prose, not tried. A run goes on over blank cells up to the next cell of its
 *  style. Where it crosses a TUI break, the break may have taken a space (a
 *  word wrap) or not (a wrap mid-name): both are tried, and what exists wins. */
const MAX_RUN = 1024;
const MAX_RUN_BREAKS = 3;

function styleRuns(line: LogicalLine): LinkSpan[] {
  const spans: LinkSpan[] = [];
  const { text, cells } = line;
  for (let start = 0; start < text.length; ) {
    const style = cells[start].style;
    let end = start + 1;
    if (style === "" || style === BLANK) {
      start = end;
      continue;
    }
    for (let i = end; i < text.length && (cells[i].style === style || cells[i].style === BLANK); i++) {
      if (cells[i].style === style) end = i + 1;
    }
    const raw = text.slice(start, end);
    const from = start + raw.length - raw.trimStart().length;
    const to = from + cleanPath(raw.trim()).length;
    const inner = line.breaks.filter((b) => b.at > from && b.at < to).map((b) => b.at);
    if (to - from <= MAX_RUN && inner.length <= MAX_RUN_BREAKS && !/^https?:\/\//.test(raw.trim())) {
      for (let mask = 0; mask < 1 << inner.length; mask++) {
        let joined = "";
        let at = from;
        inner.forEach((b, i) => {
          joined += text.slice(at, b) + (mask & (1 << i) ? " " : "");
          at = b;
        });
        joined += text.slice(at, to);
        // Without a space anywhere, the plain reading has found it already.
        if (/\s/.test(joined) && /[\\/]/.test(joined)) spans.push({ start: from, end: to, text: joined, kind: "path" });
      }
    }
    start = end;
  }
  return spans;
}

/** The candidates in a logical line, as the plain row-by-row reading would see
 *  them plus the longer ones that cross a TUI break or a space (`styleRuns`).
 *  A URL crosses a break only where the row ran up to the edge: a URL cannot be
 *  checked, and a URL ending one line of prose would otherwise swallow the
 *  first word of the next. */
export function lineCandidates(line: LogicalLine): LinkSpan[] {
  const bounds = [0, ...line.breaks.map((b) => b.at), line.text.length];
  const spans: LinkSpan[] = [];
  const add = (span: LinkSpan) => {
    if (!spans.some((s) => s.start === span.start && s.end === span.end && s.text === span.text)) spans.push(span);
  };
  for (const span of linkCandidates(line.text)) {
    const crossed = line.breaks.filter((b) => b.at > span.start && b.at < span.end);
    if (span.kind === "url" && crossed.some((b) => !b.nearEdge)) continue;
    add(span);
  }
  for (let i = 0; i + 1 < bounds.length; i++) {
    const piece = line.text.slice(bounds[i], bounds[i + 1]);
    for (const span of linkCandidates(piece)) {
      add({ ...span, start: span.start + bounds[i], end: span.end + bounds[i] });
    }
  }
  for (const span of styleRuns(line)) add(span);
  return spans;
}

/** Of the spans that resolved, the longest win; the rest must not overlap them. */
export function pickLongest<T extends { start: number; end: number }>(found: T[]): T[] {
  const picked: T[] = [];
  for (const span of [...found].sort((a, b) => b.end - b.start - (a.end - a.start))) {
    if (!picked.some((p) => span.start < p.end && p.start < span.end)) picked.push(span);
  }
  return picked;
}

/** How far back the output is read for anchors. */
const ANCHOR_ROWS = 2_000;

/** The anchors of a terminal's output, most recent (lowest) first: absolute
 *  paths it printed — an agent's tool calls, a `cd`, a listing. Rows the
 *  terminal wrapped are read as one line. */
export function bufferAnchors(row: (y: number) => Row | null, rows: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (let y = Math.max(1, rows - ANCHOR_ROWS + 1); y <= rows; y++) {
    const r = row(y);
    if (!r) continue;
    if (r.wrapped) line += r.text;
    else {
      if (line) lines.push(line);
      line = r.text;
    }
  }
  if (line) lines.push(line);
  return mergeAnchors(lines.reverse().map(anchorPaths));
}

/**
 * URLs and existing local paths in a terminal become links (see lib/links):
 * xterm underlines one under the pointer, and a click opens the link menu.
 * A link may run over several rows (see `logicalLine`). `cwd` is read at hover
 * time — the shell moves — so relative paths resolve where the user is now,
 * and then against the absolute paths the output has shown (see
 * `resolveLink`, the same rule as in answers).
 */
export function registerTerminalLinks(term: Terminal, cwd: () => string | null) {
  const row = (y: number): Row | null => {
    const line = term.buffer.active.getLine(y - 1);
    return line ? { ...rowText(line), wrapped: line.isWrapped } : null;
  };
  // Read again only after new output: hovering asks once per row.
  let anchors: string[] | null = null;
  const written = term.onWriteParsed(() => (anchors = null));
  const currentAnchors = () => (anchors ??= bufferAnchors(row, term.buffer.active.length));
  const provider = term.registerLinkProvider({
    provideLinks(y, callback) {
      const line = logicalLine(row, y, term.cols);
      const spans = lineCandidates(line);
      if (spans.length === 0) return callback(undefined);
      const from = { cwd: cwd(), anchors: currentAnchors() };
      void Promise.all(
        spans.map(async (span) => {
          const target = await resolveLink(span.text, from);
          return target ? { span, target } : null;
        }),
      ).then((resolved) => {
        const found = resolved.filter((r): r is { span: LinkSpan; target: LinkTarget } => r !== null);
        const links: ILink[] = pickLongest(found.map((r) => ({ ...r, start: r.span.start, end: r.span.end })))
          .map(({ span, target }) => {
            const first = line.cells[span.start];
            const last = line.cells[span.end - 1];
            return {
              // 1-based, end inclusive — the last cell of the last character.
              range: { start: { x: first.x + 1, y: first.y }, end: { x: last.x + last.width, y: last.y } },
              text: span.text,
              decorations: { underline: true, pointerCursor: true },
              activate: (event: MouseEvent) => activateLink(target, event),
            };
          })
          // xterm asks row by row; answer with the links on this one.
          .filter((l) => l.range.start.y <= y && y <= l.range.end.y);
        callback(links.length ? links : undefined);
      });
    },
  });
  return {
    dispose() {
      written.dispose();
      provider.dispose();
    },
  };
}
