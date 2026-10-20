// What ⌘J can jump to — Orca's worktree jump palette (MIT), in this app's
// shape: Project → Screens → panes.
//
// Two views of one list. Before anything is typed: the active project's quick
// actions and the most recent conversations — where the user most likely goes
// next, one screen of rows. Once something is typed, everything: every
// project, every Screen, every open pane (conversations and terminals), the
// sessions not open anywhere, and "new session in <project>" for each project.
// Built here, pure, so what the palette offers is testable without rendering.
import {
  DEFAULT_PROJECT,
  leaves,
  projectGroups,
  projectOf,
  selectActiveProjectId,
  type LayoutGroup,
  type PaneLeaf,
} from "./layout";
import { projectIdForSession } from "./projectScope";

export type JumpSection = "actions" | "recent" | "projects" | "screens" | "panes" | "sessions" | "newIn";

export type JumpTarget =
  /** `projectId` absent: the active project. */
  | { kind: "action"; action: "newSession" | "newTerminal"; projectId?: string }
  | { kind: "project"; projectId: string }
  | { kind: "screen"; groupId: string }
  | { kind: "pane"; groupId: string; leafId: string; sessionId: string | null }
  | { kind: "session"; sessionId: string; projectId: string };

export interface JumpEntry {
  /** Unique across the list; also what the palette matches against. */
  id: string;
  section: JumpSection;
  label: string;
  /** Where it lives, e.g. "Project · Screen 2". */
  detail?: string;
  target: JumpTarget;
}

export interface JumpInput {
  groups: LayoutGroup[];
  activeGroupId: string;
  sessions: { id: string; title: string; directory?: string | null; parentId?: string | null; updated?: number }[];
  projects: { id: string; name: string; path: string }[];
  labels: {
    defaultProject: string;
    terminal: string;
    files: string;
    session: string;
    screen: (n: number) => string;
    newSession: (project: string) => string;
    newTerminal: (project: string) => string;
    /** A project's row detail: how many sessions, and when it was last used. */
    projectDetail: (sessions: number, lastUsed: number | undefined) => string;
  };
}

/** Rows in "recent" — one screen's worth, the rest is a keystroke away. */
const RECENT_LIMIT = 8;

/** Sessions not open anywhere, most recent first — enough to reach recent
 *  work by name; the rest is on the History page. */
const SESSION_LIMIT = 100;

const basename = (path: string): string => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

export function jumpEntries(input: JumpInput): JumpEntry[] {
  const { groups, sessions, projects, labels } = input;
  const projectName = (id: string) =>
    id === DEFAULT_PROJECT ? labels.defaultProject : (projects.find((p) => p.id === id)?.name ?? labels.defaultProject);
  const activeProject = selectActiveProjectId(input);
  const activeName = projectName(activeProject);
  const titleOf = (sessionId: string) => sessions.find((s) => s.id === sessionId)?.title || labels.session;

  const paneLabel = (leaf: PaneLeaf): string => {
    const c = leaf.content;
    if (!c) return leaf.artifact?.filename ?? (leaf.sessionId ? titleOf(leaf.sessionId) : labels.session);
    switch (c.kind) {
      case "terminal": {
        const where = c.cwd ? ` · ${basename(c.cwd)}` : "";
        const agent = c.agent?.running ? ` · ${c.agent.kind === "claude" ? "Claude Code" : "Codex"}` : "";
        return `${c.name || labels.terminal}${where}${agent}`;
      }
      case "files":
        return labels.files;
      case "notebook":
      case "editor":
        return basename(c.path);
    }
  };

  const screenLabel = (g: LayoutGroup): string => {
    const named = g.name.trim();
    if (named) return named;
    const first = g.tree ? leaves(g.tree)[0] : undefined;
    if (first) return paneLabel(first);
    const n = projectGroups(groups, projectOf(g)).findIndex((x) => x.id === g.id) + 1;
    return labels.screen(n);
  };

  const entries: JumpEntry[] = [
    { id: "action:newSession", section: "actions", label: labels.newSession(activeName), target: { kind: "action", action: "newSession" } },
    { id: "action:newTerminal", section: "actions", label: labels.newTerminal(activeName), target: { kind: "action", action: "newTerminal" } },
  ];

  // Projects by when they were last used — the ones in use float up — each
  // saying how much is in it rather than repeating its path.
  const topLevel = sessions.filter((s) => !s.parentId);
  const usage = new Map<string, { count: number; last?: number }>();
  for (const s of topLevel) {
    const id = projectIdForSession(s.id, sessions, projects);
    const u = usage.get(id) ?? { count: 0 };
    u.count += 1;
    if (s.updated && (u.last ?? 0) < s.updated) u.last = s.updated;
    usage.set(id, u);
  }
  const byUse = [
    { id: DEFAULT_PROJECT, name: labels.defaultProject },
    ...projects.map((p) => ({ id: p.id, name: p.name })),
  ].sort((a, b) => (usage.get(b.id)?.last ?? 0) - (usage.get(a.id)?.last ?? 0));
  for (const p of byUse) {
    const u = usage.get(p.id);
    entries.push({
      id: `project:${p.id || "default"}`,
      section: "projects",
      label: p.name,
      detail: labels.projectDetail(u?.count ?? 0, u?.last),
      target: { kind: "project", projectId: p.id },
    });
  }

  // The active project's Screens first: they are the likeliest destination.
  const ordered = [
    ...groups.filter((g) => projectOf(g) === activeProject),
    ...groups.filter((g) => projectOf(g) !== activeProject),
  ];
  const open = new Set<string>();
  for (const g of ordered) {
    const where = projectName(projectOf(g));
    const screen = screenLabel(g);
    entries.push({ id: `screen:${g.id}`, section: "screens", label: screen, detail: where, target: { kind: "screen", groupId: g.id } });
    if (!g.tree) continue;
    const all = leaves(g.tree);
    for (const leaf of all) {
      if (leaf.sessionId && !leaf.content) open.add(leaf.sessionId);
      // A Screen of one pane, called what that pane is called, is already
      // listed above: the same row twice says nothing new.
      if (all.length === 1 && paneLabel(leaf) === screen) continue;
      entries.push({
        id: `pane:${leaf.id}`,
        section: "panes",
        label: paneLabel(leaf),
        detail: `${where} · ${screen}`,
        target: { kind: "pane", groupId: g.id, leafId: leaf.id, sessionId: leaf.content ? null : leaf.sessionId },
      });
    }
  }

  // Recent: the newest conversations, wherever they are — open ones go to
  // their pane, the rest open as usual. What the empty palette shows.
  const paneOf = new Map<string, { groupId: string; leafId: string }>();
  for (const g of groups)
    for (const leaf of g.tree ? leaves(g.tree) : [])
      if (leaf.sessionId && !leaf.content && !paneOf.has(leaf.sessionId)) paneOf.set(leaf.sessionId, { groupId: g.id, leafId: leaf.id });
  for (const s of [...topLevel].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0)).slice(0, RECENT_LIMIT)) {
    const projectId = projectIdForSession(s.id, sessions, projects);
    const pane = paneOf.get(s.id);
    entries.push({
      id: `recent:${s.id}`,
      section: "recent",
      label: s.title || labels.session,
      detail: projectName(projectId),
      target: pane
        ? { kind: "pane", groupId: pane.groupId, leafId: pane.leafId, sessionId: s.id }
        : { kind: "session", sessionId: s.id, projectId },
    });
  }

  // A new session in any project, found by typing its name.
  for (const p of byUse) {
    entries.push({
      id: `new:${p.id || "default"}`,
      section: "newIn",
      label: labels.newSession(p.name),
      target: { kind: "action", action: "newSession", projectId: p.id },
    });
  }

  const closed = sessions
    .filter((s) => !s.parentId && !open.has(s.id))
    .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
    .slice(0, SESSION_LIMIT);
  for (const s of closed) {
    const projectId = projectIdForSession(s.id, sessions, projects);
    const name = projectName(projectId);
    entries.push({
      id: `session:${s.id}`,
      section: "sessions",
      label: s.title || labels.session,
      detail: name,
      target: { kind: "session", sessionId: s.id, projectId },
    });
  }
  return entries;
}
