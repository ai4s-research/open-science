/**
 * Comparing workspace paths across the app's two sources of truth.
 *
 * A project's `path` comes from Rust (`canonicalize()`), a session's `directory`
 * comes from the OpenCode sidecar, and on Windows the two never agree as strings
 * even when they name the same folder: Rust yields `D:\Docs\projects\p` while the
 * sidecar reports `D:/Docs/projects/p`. Every exact-match lookup between them
 * therefore missed, so projects showed no sessions at all, project-scoped memory
 * silently fell back to global, and the active-project highlight never lit (#76).
 *
 * `pathKey` reduces either form to one comparable key. It is for COMPARISON only
 * — never display a key or hand one to a command; keep the original string for
 * that.
 */

/**
 * The canonical comparison key for a workspace path.
 *
 * - unwraps the Windows verbatim prefix (`\\?\C:\x`, `\\?\UNC\srv\share`), which
 *   older installs persisted and which no other layer produces;
 * - normalizes `\` to `/`, since Rust and the sidecar disagree on the separator;
 * - lower-cases drive-letter and UNC paths only. Those filesystems are
 *   case-insensitive, so `D:\x` and `d:/x` are one folder; POSIX paths are
 *   case-sensitive and must keep their case;
 * - drops a trailing separator, which carries no meaning outside a root.
 */
export function pathKey(raw: string): string {
  // Strip line breaks only, never spaces: a stray newline means a producer wrote
  // a path badly (the class of mismatch this exists to absorb), while a POSIX
  // folder name CAN legitimately end in a space, and trimming that would make
  // "…/notes " and "…/notes" compare equal when they are two real directories.
  let p = raw.replace(/^[\r\n]+|[\r\n]+$/g, "");
  if (p.startsWith("\\\\?\\UNC\\")) p = `\\\\${p.slice(8)}`;
  else if (p.startsWith("\\\\?\\")) p = p.slice(4);
  p = p.replace(/\\/g, "/");
  if (/^[a-z]:/i.test(p) || p.startsWith("//")) p = p.toLowerCase();
  // "/" and "c:/" are roots — their trailing slash is part of the path.
  while (p.length > 1 && p.endsWith("/") && !p.endsWith(":/")) p = p.slice(0, -1);
  return p;
}

/** Whether two paths name the same folder. Nullish never matches, not even itself:
 *  a session with no directory belongs to no project. */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return pathKey(a) === pathKey(b);
}
