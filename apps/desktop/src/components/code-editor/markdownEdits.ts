/**
 * What a markdown formatting button does to the text.
 *
 * Kept apart from CodeMirror so the rules are testable on plain strings: the
 * editor supplies the selection and applies the result, and everything that is
 * actually a decision — what counts as "already bold", what a heading replaces
 * — lives here.
 */

/** Line prefixes the toolbar owns. Applying one replaces another (a heading
 *  becomes a quote, not a quoted heading), and applying the one a line already
 *  has removes it — Orca's toolbar toggles the same way. */
const OWNED_PREFIX = /^(\s*)(#{1,6} |> |- \[[ xX]\] |- |\d+\. )?/;

/**
 * Put `prefix` on a line, replacing whatever list/heading/quote marker it
 * already carries — or take it off again when it is already exactly that one.
 *
 * Indentation is preserved: a nested list item stays nested.
 */
export function applyLinePrefix(line: string, prefix: string): string {
  return hasPrefix(line, prefix) ? setLinePrefix(line, "") : setLinePrefix(line, prefix);
}

/** Replace whatever marker the line carries with `prefix`, without toggling. */
function setLinePrefix(line: string, prefix: string): string {
  const match = OWNED_PREFIX.exec(line);
  const indent = match?.[1] ?? "";
  const rest = line.slice((match?.[0] ?? "").length);
  return indent + prefix + rest;
}

function isOrdered(prefix: string): boolean {
  return /^\d+\. $/.test(prefix);
}

/** Apply `prefix` to every line of a block, numbering an ordered list as it
 *  goes. Returns the replacement text for the whole block. */
export function applyLinePrefixToBlock(block: string, prefix: string): string {
  const lines = block.split("\n");
  // Toggle off only when EVERY line already has it: a partly-formatted
  // selection should finish the job rather than undo the half that was done.
  const allHave = lines.every((line) => hasPrefix(line, prefix));
  return lines
    .map((line, i) =>
      allHave
        ? setLinePrefix(line, "")
        : // Force it on, never toggle: a line that is already a bullet must
          // stay one while the rest of the selection catches up.
          setLinePrefix(line, isOrdered(prefix) ? `${i + 1}. ` : prefix),
    )
    .join("\n");
}

function prefixOf(line: string): string {
  return OWNED_PREFIX.exec(line)?.[2] ?? "";
}

function hasPrefix(line: string, prefix: string): boolean {
  const existing = prefixOf(line);
  return existing === prefix || (isOrdered(existing) && isOrdered(prefix));
}

export interface Wrapped {
  text: string;
  /** Where the selection should land afterwards, relative to `text`. */
  from: number;
  to: number;
}

/**
 * Wrap (or unwrap) a selection in `before`/`after` — bold, italic, code, a link.
 *
 * With nothing selected this inserts the markers and reports a caret between
 * them, so pressing B and typing produces bold text rather than two asterisks
 * to walk back through.
 */
export function wrapSelection(selected: string, before: string, after: string): Wrapped {
  if (selected.startsWith(before) && selected.endsWith(after) && selected.length >= before.length + after.length) {
    const text = selected.slice(before.length, selected.length - after.length);
    return { text, from: 0, to: text.length };
  }
  return {
    text: before + selected + after,
    from: before.length,
    to: before.length + selected.length,
  };
}
