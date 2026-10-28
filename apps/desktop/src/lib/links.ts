import { create } from "zustand";
import type { FileRoot, ThreadBlock } from "@ai4s/shared";
import { isTauri, openExternal, workspaceBase } from "@/lib/tauri";
import { listDir, openArtifactExternally, resolveArtifactPath, type DirEntry } from "@/lib/artifactFile";
import { GLOBAL_FILES_LOCATION, rememberDirectory } from "@/lib/filesLocation";
import { useLayoutStore } from "@/lib/layout";
import { isGatewayWeb } from "@/lib/webMode";

/**
 * Clickable URLs and local paths in conversations and terminals, as in Orca:
 * a link is underlined on hover, a click opens a small menu (the full target
 * and what can be done with it), ⌘-click takes the first action at once and
 * ⇧⌘-click opens a file in its default app.
 *
 * Only what can actually be opened is a link: a path is drawn as one after it
 * has been found on disk.
 */
export type LinkTarget =
  | { kind: "url"; url: string }
  /** `path` is relative to `root`; `display` is what the user clicked. */
  | { kind: "path"; path: string; root: FileRoot; isDir: boolean; display: string };

// CJK punctuation (\u3000-\u303f, \uff00-\uffef) ends a URL or a path: prose
// runs straight into them with no space.
const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]}\u3000-\u303f\uff00-\uffef]+/g;
/** On Windows `\` separates a path as `/` does, and a full path starts with a
 *  drive (`C:\…`, `C:/…`). Elsewhere `\` is a character a name can hold. */
export const IS_WINDOWS = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
const SEP_CHARS = IS_WINDOWS ? String.raw`\\/` : "/";
const SEP = `[${SEP_CHARS}]`;
/** Does `text` hold a path separator (see `IS_WINDOWS`)? */
export function hasSeparator(text: string): boolean {
  return IS_WINDOWS ? /[\\/]/.test(text) : text.includes("/");
}
/** A path-like token: absolute, `~/`, `./`, `../`, a relative path with a
 *  separator, or a bare name with an extension. Trailing `:line:col` and
 *  sentence punctuation are trimmed by `cleanPath`. */
const NAME = String.raw`[\w.@+\-\u00c0-\u2fff\u3040-\ufeff]`;
const DRIVE = IS_WINDOWS ? String.raw`(?<!\w)[A-Za-z]:(?=${SEP})|` : "";
const PATH_RE = new RegExp(String.raw`(?:${DRIVE}~|\.{1,2})?${SEP}?${NAME}+(?:${SEP}${NAME}*)*`, "g");

/** A URL, trimmed of the punctuation that closes the sentence around it. */
export function cleanUrl(raw: string): string {
  return raw.replace(/[.,;:!?]+$/, "");
}

/** A printed path without its position (`:12`, `:12:3`, `:12-30`, `#L12-L30`)
 *  or trailing punctuation. */
export function cleanPath(raw: string): string {
  const bare = raw.replace(/[.,;:!?]+$/, "");
  return bare
    .replace(/(?::\d+(?:[-–]\d+)?){1,2}$/, "")
    .replace(/#L\d+(?:-L?\d+)?$/, "")
    .replace(/[.,;:!?]+$/, "");
}

/** Could `text` name a file? A slash, or a name with an extension — not every
 *  word of a line is worth a disk lookup. */
export function looksLikePath(text: string): boolean {
  if (text.length < 2 || /^\d+(\.\d+)*$/.test(text)) return false;
  return hasSeparator(text) || new RegExp(String.raw`^${NAME}+\.[A-Za-z]\w{0,7}$`).test(text);
}

export interface LinkSpan {
  start: number;
  end: number;
  text: string;
  kind: "url" | "path";
}

/** URL and path candidates in one line of text, left to right, not
 *  overlapping (a URL wins over the path-looking pieces inside it). */
export function linkCandidates(line: string): LinkSpan[] {
  const spans: LinkSpan[] = [];
  for (const m of line.matchAll(URL_RE)) {
    const text = cleanUrl(m[0]);
    spans.push({ start: m.index, end: m.index + text.length, text, kind: "url" });
  }
  const taken = (i: number) => spans.some((s) => i >= s.start && i < s.end);
  for (const m of line.matchAll(PATH_RE)) {
    if (taken(m.index)) continue;
    const text = cleanPath(m[0]);
    if (!looksLikePath(text)) continue;
    spans.push({ start: m.index, end: m.index + text.length, text, kind: "path" });
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** Absolute paths (`/…`, `~/…`, on Windows `C:\…`) a text names, most recent (last) first —
 *  the anchors a relative path near them is resolved against (see
 *  `resolveLink`). Read from a conversation's messages and tool calls, or a
 *  terminal's output. */
const ANCHOR_RE = new RegExp(
  "(?<![\\w.:/~" + (IS_WINDOWS ? "\\\\])(?:[A-Za-z]:|" : "])(?:") + "~)?" + SEP +
    "[^\\s\"'`()<>[\\]{},;|&*?\\u3000-\\u303f\\uff00-\\uffef]+",
  "g",
);
export function anchorPaths(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(ANCHOR_RE)) {
    const path = cleanPath(m[0]);
    // At least two segments: a lone "/x" is as likely an option or a route.
    if (new RegExp(String.raw`^(?:[A-Za-z]:|~)?${SEP}[^${SEP_CHARS}]+${SEP}.`).test(path)) found.push(path);
  }
  return found.reverse();
}

/** Anchors are capped: the most recent ones are the ones a path is about. */
export const MAX_ANCHORS = 200;

/** Most recent first, each once, at most MAX_ANCHORS. */
export function mergeAnchors(lists: Iterable<readonly string[]>): string[] {
  const out = new Set<string>();
  for (const list of lists) {
    for (const a of list) {
      out.add(a);
      if (out.size >= MAX_ANCHORS) return [...out];
    }
  }
  return [...out];
}

/** What each block names, once per block: a thread is re-read on every
 *  streamed token, and only the block being written changes. */
const blockAnchors = new WeakMap<ThreadBlock, string[]>();

/** The anchors of a conversation, most recent first: absolute paths in its
 *  messages and in the commands, files and output of its tool calls. */
export function threadAnchors(blocks: readonly ThreadBlock[]): string[] {
  const of = (b: ThreadBlock): string[] => {
    let hit = blockAnchors.get(b);
    if (!hit) {
      const text =
        b.kind === "user" ? b.text
        : b.kind === "agent" ? b.markdown
        : b.kind === "tool-call" ? [b.filePath, b.command, b.output].filter(Boolean).join("\n")
        : "";
      hit = text ? anchorPaths(text) : [];
      blockAnchors.set(b, hit);
    }
    return hit;
  };
  return mergeAnchors((function* () {
    for (let i = blocks.length - 1; i >= 0; i--) yield of(blocks[i]);
  })());
}

interface LocalPath {
  root: "home" | "disk";
  rel: string;
  is_dir: boolean;
}

/** Lookups are cached: a terminal asks again every time the pointer crosses a
 *  line. A miss is remembered briefly only — the file may be written a moment
 *  later, and the next hover should find it. */
const cache = new Map<string, { at: number; value: Promise<LocalPath | null> }>();
const MISS_TTL_MS = 5_000;

function locateLocal(path: string, cwd: string | undefined, anchors: readonly string[]): Promise<LocalPath | null> {
  const key = `${cwd ?? ""}\n${path}\n${anchors.join("\n")}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < MISS_TTL_MS) return hit.value;
  const value = (async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<LocalPath | null>("locate_local_path", { path, cwd, anchors });
  })().catch(() => null);
  cache.set(key, { at: Date.now(), value });
  void value.then((found) => {
    // Found things stay found.
    if (found) cache.set(key, { at: Number.POSITIVE_INFINITY, value });
  });
  return value;
}

/** Where a link was printed: a terminal (its directory, null while unknown),
 *  or an answer (the folders of its conversation and of those it names). Both
 *  carry the anchors seen around it — see `anchorPaths`. */
export type LinkContext =
  | { cwd: string | null; anchors?: readonly string[] }
  | { folders?: string | readonly string[]; anchors?: readonly string[] };

/**
 * The link a clicked-at string stands for, or null when there is nothing to
 * open. One rule for answers and terminals; only what exists is a link:
 *
 * 1. Absolute and `~/` paths, literally (desktop: under home; web: under the
 *    base folder).
 * 2. A relative path: under the answer's folders, in order, or the terminal's
 *    directory; then against the anchors, most recent first (an answer about
 *    another repo writes that repo's paths, and its conversation has opened
 *    files there); last, in an answer, by name in the workspace.
 *
 * A path a writer broke over lines arrives with the break as a space; it is
 * tried again without it.
 */
export async function resolveLink(text: string, from: LinkContext = {}): Promise<LinkTarget | null> {
  const found = await resolveOnce(text, from);
  if (found) return found;
  // Every piece made of path characters, and a slash somewhere: prose is not
  // glued together, and what is glued counts only if it exists.
  const pieces = text.trim().split(/\s+/);
  const pathy = new RegExp(String.raw`^(?:~|${SEP})?${NAME}*(?:(?:${SEP}|:)${NAME}*)*$`);
  return pieces.length > 1 && hasSeparator(pieces.join("")) && pieces.every((p) => pathy.test(p))
    ? resolveOnce(pieces.join(""), from)
    : null;
}

async function resolveOnce(text: string, from: LinkContext): Promise<LinkTarget | null> {
  const url = cleanUrl(text);
  if (/^https?:\/\//.test(url)) return { kind: "url", url };
  const path = cleanPath(text);
  if (!looksLikePath(path)) return null;
  const absolute = new RegExp(String.raw`^(?:[A-Za-z]:${SEP}|~?${SEP})`).test(path);
  const terminal = "cwd" in from;
  const anchors = from.anchors ?? [];
  if (!absolute && !terminal && from.folders) {
    for (const folder of typeof from.folders === "string" ? [from.folders] : from.folders) {
      const found = await inFolder(folder, path);
      if (found) return found;
    }
  }
  // A browser reaches a full path only inside the base folder, as Files does.
  if (isGatewayWeb && path.startsWith("/")) return inFolder("/", path);
  // Anywhere else on disk is only reachable from the machine itself.
  if (!isTauri || isGatewayWeb) return null;
  if (absolute || terminal || anchors.length > 0) {
    const found = await locateLocal(path, terminal ? (from.cwd ?? undefined) : undefined, anchors);
    if (found) return { kind: "path", path: found.rel, root: found.root, isDir: found.is_dir, display: path };
    if (absolute || terminal) return null;
  }
  const inWorkspace = await resolveArtifactPath(path).catch(() => null);
  return inWorkspace
    ? { kind: "path", path: inWorkspace, root: "workspace", isDir: false, display: path }
    : null;
}

/** Listings of folders being looked into, briefly kept: one answer can name a
 *  dozen files of the same folder. */
const listings = new Map<string, { at: number; entries: Promise<DirEntry[]> }>();

function listBase(dir: string): Promise<DirEntry[]> {
  const hit = listings.get(dir);
  if (hit && Date.now() - hit.at < 5_000) return hit.entries;
  // eslint-disable-next-line i18next/no-literal-string -- FileRoot, not UI copy
  const entries = listDir(dir, "base").catch(() => []);
  listings.set(dir, { at: Date.now(), entries });
  return entries;
}

/**
 * `rel` inside a conversation's `folder`, as a base-relative target — the way
 * the Files tree names things, which reads the same from the desktop and from
 * a browser. Found by listing the folder it is in, so a folder is a link too.
 * In a browser, a bare name ("report.html" for "out/report.html") is looked
 * for the way the file chips under an answer are.
 */
async function inFolder(folder: string, rel: string): Promise<LinkTarget | null> {
  const baseDir = await workspaceBase();
  if (!baseDir) return null;
  // One spelling for both sides: forward slashes, no empty or `.` segments
  // (Windows paths arrive with backslashes and a drive letter).
  const norm = (...paths: string[]) => {
    const parts = paths.flatMap((p) => p.split(/[\\/]/)).filter((p) => p && p !== ".");
    return parts.includes("..") ? null : (paths[0].startsWith("/") ? "/" : "") + parts.join("/");
  };
  const base = norm(baseDir);
  const abs = norm(folder, rel);
  if (!base || !abs || !abs.startsWith(`${base}/`)) return null;
  const inBase = abs.slice(base.length + 1);
  const cut = inBase.lastIndexOf("/");
  const name = inBase.slice(cut + 1);
  const entry = (await listBase(cut < 0 ? "" : inBase.slice(0, cut))).find((e) => e.name === name);
  if (entry) {
    // eslint-disable-next-line i18next/no-literal-string -- FileRoot, not UI copy
    return { kind: "path", path: inBase, root: "base", isDir: entry.isDir, display: rel };
  }
  if (isGatewayWeb) {
    const located = await resolveArtifactPath(rel, folder).catch(() => null);
    if (located) return inFolder(folder, located);
  }
  return null;
}

/** Open the Files tree on a folder (or on the folder a file is in), in a new
 *  Screen. Only a base-relative target can say where that is. */
export function showInFiles(target: Extract<LinkTarget, { kind: "path" }>): void {
  if (target.root !== "base") return;
  const dir = target.isDir ? target.path : target.path.slice(0, Math.max(0, target.path.lastIndexOf("/")));
  rememberDirectory(GLOBAL_FILES_LOCATION, dir);
  // eslint-disable-next-line i18next/no-literal-string -- PaneContent kind, not UI copy
  useLayoutStore.getState().addGroup({ kind: "files" });
}

/** Open a file in its own Screen — a new tab showing its contents. */
export function openInApp(target: Extract<LinkTarget, { kind: "path" }>): void {
  const kind = target.path.toLowerCase().endsWith(".ipynb") ? "notebook" : "editor";
  useLayoutStore.getState().addGroup({ kind, path: target.path, root: target.root });
}

export function openWithDefaultApp(target: LinkTarget): void {
  if (target.kind === "url") void openExternal(target.url);
  else void openArtifactExternally(target.path, target.root);
}

/** What a click does, by modifier: ⌘ → the first action, ⇧⌘ → the default
 *  app, a plain click → the menu at the pointer. */
export function activateLink(
  target: LinkTarget,
  event: Pick<MouseEvent, "clientX" | "clientY" | "metaKey" | "ctrlKey" | "shiftKey">,
): void {
  const mod = event.metaKey || event.ctrlKey;
  // A browser has no default apps: a folder opens in the Files tree instead.
  if (mod && isGatewayWeb && target.kind === "path" && target.isDir) {
    showInFiles(target);
  } else if (mod && (event.shiftKey || target.kind === "url" || target.isDir)) {
    openWithDefaultApp(target);
  } else if (mod && target.kind === "path") {
    openInApp(target);
  } else {
    useLinkMenu.getState().show(target, event.clientX, event.clientY);
  }
}

interface LinkMenuState {
  open: { target: LinkTarget; x: number; y: number } | null;
  show: (target: LinkTarget, x: number, y: number) => void;
  hide: () => void;
}

export const useLinkMenu = create<LinkMenuState>((set) => ({
  open: null,
  show: (target, x, y) => set({ open: { target, x, y } }),
  hide: () => set({ open: null }),
}));
