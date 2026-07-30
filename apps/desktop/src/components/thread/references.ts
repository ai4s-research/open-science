import type { SessionMeta } from "@ai4s/sdk";
import { listDir } from "@/lib/artifactFile";

/** How deep the `@` picker walks the session folder, and how many files it
 *  keeps. A workspace can hold a checked-out repo; a picker is for choosing,
 *  not for browsing everything (the Files pane does that). */
const WALK_DEPTH = 3;
const WALK_MAX = 500;

/** Folders that are never worth offering as context. */
const SKIP_DIRS = new Set([
  ".git",
  ".opencode",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  ".ipynb_checkpoints",
  "target",
  "dist",
]);

/** A trigger the composer is currently typing: the caret sits right after
 *  `@query` or `#query` at a word boundary. */
export interface RefTrigger {
  kind: "file" | "session";
  /** Text typed after the sigil, lowercased for matching. */
  query: string;
  /** Index of the sigil in the value — where a replacement starts. */
  start: number;
}

/** Detect an `@`/`#` reference being typed immediately before `caret`.
 *  A sigil only counts at the start or after whitespace, so an email address
 *  or a `#` inside a URL fragment never opens the picker. */
export function refTriggerAt(value: string, caret: number): RefTrigger | null {
  const before = value.slice(0, caret);
  const m = /(^|\s)([@#])([^\s@#]*)$/.exec(before);
  if (!m) return null;
  return {
    kind: m[2] === "@" ? "file" : "session",
    query: m[3].toLowerCase(),
    start: caret - m[3].length - 1,
  };
}

/** Replace the trigger's `@query` / `#query` with `insert`, returning the new
 *  value and where the caret should land. */
export function applyRef(
  value: string,
  trigger: RefTrigger,
  caret: number,
  insert: string,
): { value: string; caret: number } {
  const head = value.slice(0, trigger.start);
  const tail = value.slice(caret);
  const text = `${insert} `;
  return { value: head + text + tail, caret: head.length + text.length };
}

/** Workspace files a session can be pointed at, as root-relative paths,
 *  breadth-first so the shallow (and usually interesting) ones come first. */
export async function walkWorkspace(sessionDir: string | undefined): Promise<string[]> {
  const out: string[] = [];
  let level = [""];
  for (let depth = 0; depth <= WALK_DEPTH && level.length && out.length < WALK_MAX; depth++) {
    const next: string[] = [];
    for (const rel of level) {
      if (out.length >= WALK_MAX) break;
      let entries;
      try {
        entries = await listDir(rel, "workspace", sessionDir);
      } catch {
        continue; // an unreadable folder is skipped, not fatal
      }
      for (const e of entries) {
        if (e.isDir) {
          if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) next.push(e.path);
        } else if (out.length < WALK_MAX) {
          out.push(e.path);
        }
      }
    }
    level = next;
  }
  return out;
}

/** Rank candidates for a typed query: a hit on the file NAME beats a hit
 *  anywhere in the path, so typing "trials" finds `data/raw/trials.csv`
 *  before `trials/notes.md`. */
export function matchPaths(paths: string[], query: string, limit = 8): string[] {
  if (!query) return paths.slice(0, limit);
  const scored: Array<[number, string]> = [];
  for (const p of paths) {
    const name = p.split(/[\\/]/).pop()?.toLowerCase() ?? "";
    const lower = p.toLowerCase();
    if (name.startsWith(query)) scored.push([0, p]);
    else if (name.includes(query)) scored.push([1, p]);
    else if (lower.includes(query)) scored.push([2, p]);
  }
  return scored
    .sort((a, b) => a[0] - b[0] || a[1].length - b[1].length)
    .slice(0, limit)
    .map(([, p]) => p);
}

/** Past conversations a `#` can point at: top-level, newest first, never the
 *  one being typed in (referencing yourself adds nothing). */
export function matchSessions(
  sessions: SessionMeta[],
  currentId: string | null,
  query: string,
  limit = 8,
): SessionMeta[] {
  return sessions
    .filter((s) => !s.parentId && s.id !== currentId)
    .filter((s) => !query || s.title.toLowerCase().includes(query))
    .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
    .slice(0, limit);
}

/** Characters of a referenced conversation carried into the prompt. Enough for
 *  the ask and the conclusion; not so much that it refills the context the
 *  reference exists to avoid. */
const EXCERPT_MAX = 2000;

/** A referenced conversation, rendered for the model: what was asked and where
 *  it landed. Plain text, clearly delimited, so it reads as quoted context
 *  rather than as something the user just said. */
export function referenceBlock(title: string, excerpt: string): string {
  return `<referenced-conversation title="${title.replace(/"/g, "'")}">\n${excerpt}\n</referenced-conversation>`;
}

/** Condense a conversation to its first ask and its last answer — the two
 *  parts that carry what it was about and what came of it. */
export function condenseTranscript(
  messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }>,
): string {
  const textOf = (m: { parts: Array<{ type: string; text?: string }> }) =>
    m.parts
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text!)
      .join("")
      .trim();
  const firstAsk = messages.find((m) => m.role === "user" && textOf(m));
  const lastAnswer = [...messages].reverse().find((m) => m.role === "assistant" && textOf(m));
  const parts: string[] = [];
  if (firstAsk) parts.push(`Asked: ${cap(textOf(firstAsk), EXCERPT_MAX / 2)}`);
  if (lastAnswer) parts.push(`Concluded: ${cap(textOf(lastAnswer), EXCERPT_MAX / 2)}`);
  return parts.join("\n\n");
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
