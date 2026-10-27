/**
 * A pane's screen is saved with the offset into the shell's output it covers,
 * and a reopen draws it, then the output after that offset (see terminal.rs).
 * Only screen contents survive that: a saved screen cannot carry the state of
 * an escape sequence cut off by the offset, so a save waits until the output
 * so far ends between sequences.
 */

/** The unfinished escape sequence `text` ends in, or "" when it ends between
 *  sequences. Only the last ESC matters: a new one ends any sequence before it. */
export function openEscape(text: string): string {
  const at = text.lastIndexOf("\x1b");
  if (at < 0) return "";
  const seq = text.slice(at);
  const kind = seq[1];
  if (kind === undefined) return seq;
  // eslint-disable-next-line no-control-regex -- escape sequences are the subject
  if (kind === "[") return /^\x1b\[[\x20-\x3f]*[\x40-\x7e]/.test(seq) ? "" : seq;
  // An OSC ends with BEL or ST; ST is itself an ESC, so it would be the last.
  if (kind === "]") return seq.includes("\x07") ? "" : seq;
  if ("P_^X".includes(kind)) return seq;
  // eslint-disable-next-line no-control-regex -- as above
  if (kind >= " " && kind <= "/") return /^\x1b[\x20-\x2f]+[\x30-\x7e]/.test(seq) ? "" : seq;
  return "";
}
