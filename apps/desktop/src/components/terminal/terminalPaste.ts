/**
 * Pasting copied files into a terminal pastes their paths, as Orca, iTerm2 and
 * Terminal.app do. Finder and Explorer put files on the clipboard as file
 * references, which the webview hides from the page: ⌘V gave nothing. The
 * desktop shell reads them natively (`clipboard_file_paths`).
 */

/** A path quoted for the shell it is pasted into: as is when it has nothing a
 *  shell would split or expand, else in single quotes (POSIX) or double quotes
 *  (Windows), which Claude Code and Codex also unwrap. */
export function quotePath(path: string, windows: boolean): string {
  if (windows) return /^[\w./@:\\-]+$/.test(path) ? path : `"${path}"`;
  return /^[\w./@:-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`;
}

/** The copied files as text to paste, each path followed by a space, or "" when
 *  the clipboard holds no files. */
export function pathsToPaste(paths: string[], windows: boolean): string {
  return paths.map((p) => `${quotePath(p, windows)} `).join("");
}

/** The paths of the files on the clipboard, ready to paste; "" when none. */
export async function readCopiedFiles(): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  const paths = await invoke<string[]>("clipboard_file_paths").catch(() => []);
  return pathsToPaste(paths, navigator.userAgent.includes("Windows"));
}
