import { create } from "zustand";
import type { ArtifactBlock, FileRoot } from "@ai4s/shared";
import type { ArtifactPanelPlacement, ArtifactPanelTarget } from "./artifacts";
import { asAccountCommand, type AccountKind } from "./agentAccounts";

/**
 * Ghostty/tmux-style recursive tiling layout. Each leaf holds one session; a
 * split node lays its N children out along an axis, each taking a fraction of
 * the axis (`sizes`, summing to 1). Docking a pane re-equalizes siblings so 2
 * stacked panes are ½ each, 3 are ⅓ each — a binary+ratio tree can't express
 * that, which is why splits are N-ary.
 *
 * Draft rule: the runtime has a single global draft slot (DRAFT_KEY), so at
 * most ONE leaf may be an unbound draft (`sessionId: null`).
 */
export type SplitDir = "row" | "col";

/** Which side of a target pane a dock lands on. left/right → row (side-by-side);
 *  top/bottom → col (stacked). */
export type DockEdge = "left" | "right" | "top" | "bottom";

/**
 * A surface a pane can hold that belongs to no conversation.
 *
 * Distinct from `artifact`, which is a surface a SESSION owns (its own file
 * preview, opened from its own thread). A terminal or a file tree is not
 * anyone's output — it is a tool sitting in the workspace, so it survives with
 * the layout rather than with a session.
 *
 * Borrowed in shape from Orca's `TabContentType` (MIT): a pane is a place, and
 * what it holds is one tagged value — which is what lets a terminal, an editor
 * and a conversation share the same splitting, docking and persistence.
 */
export type PaneContent =
  /** `name`: what the user called this terminal. A workbench ends up with
   *  several, and "Terminal" three times over says nothing about which is the
   *  build and which is the server. */
  /** `command`: typed into the shell once, when the pane opens. It is SENT to
   *  the shell rather than exec'd in its place, so the user can see what ran,
   *  edit it, and still have a shell when it exits — which is what you want
   *  when the command is `ssh some-host`. */
  /** `cwd` follows the shell as it moves (see `recordTerminal`), so a
   *  relaunch reopens the terminal where it was, not where it started. */
  | { kind: "terminal"; cwd?: string; name?: string; command?: string; agent?: TerminalAgent }
  | { kind: "files"; path?: string }
  | { kind: "notebook"; path: string; root?: FileRoot }
  | { kind: "editor"; path: string; root?: FileRoot };

/** The coding agent last seen running in a terminal — Claude Code or Codex —
 *  and the session it was in. `running`: it was still the terminal's
 *  foreground program when last looked at, i.e. the user left it open; a
 *  relaunch then resumes it instead of leaving a bare shell. */
export interface TerminalAgent {
  kind: TerminalAgentKind;
  sessionId: string;
  running: boolean;
  /** What the agent calls the session (Claude Code's title or `/rename`,
   *  Codex's thread name, pi's `/name`), once it has one. */
  title?: string;
  /** The account's home folder, when the session runs on an added account
   *  rather than the agent's own login. The resume command sets the account's
   *  env var so the agent finds the session in the right folder. */
  accountHome?: string;
}

/** The terminal agents whose sessions the app can resume and move. */
export type TerminalAgentKind = "claude" | "codex" | "pi";
const TERMINAL_AGENT_KINDS: readonly string[] = ["claude", "codex", "pi"];

/** The product name of a terminal agent, shown as-is in every language. */
export function terminalAgentName(kind: TerminalAgentKind): string {
  return { claude: "Claude Code", codex: "Codex", pi: "pi" }[kind];
}

/** What a terminal is called: the name the user gave it, else the name of
 *  the agent session running in it — the way a Screen takes a conversation's
 *  title — else `fallback`. Derived, never stored, so the user's name always
 *  wins and a session's later rename shows through. */
export function terminalName(content: { name?: string; agent?: TerminalAgent }, fallback: string): string {
  return content.name || (content.agent?.running && content.agent.title) || fallback;
}

/** `TerminalAgentKind` → `AccountKind` for the agents that have accounts. */
const AGENT_ACCOUNT_KIND: Partial<Record<TerminalAgentKind, AccountKind>> = { claude: "claude", codex: "codex" };

/** The command that resumes `agent`'s session in a shell, or null when the
 *  session id is not a plain id. When the session ran on an added account, the
 *  command sets that account's env so the agent finds the session. */
export function resumeCommand(agent: TerminalAgent): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(agent.sessionId)) return null;
  let cmd: string;
  switch (agent.kind) {
    case "claude":
      cmd = `claude --resume ${agent.sessionId}`;
      break;
    case "codex":
      cmd = `codex resume ${agent.sessionId}`;
      break;
    case "pi":
      cmd = `pi --session ${agent.sessionId}`;
      break;
  }
  const kind = agent.accountHome && AGENT_ACCOUNT_KIND[agent.kind];
  if (kind) {
    return asAccountCommand(kind, agent.accountHome!, cmd, /Windows/i.test(navigator.userAgent)) ?? cmd;
  }
  return cmd;
}

/** What `terminal_probe` reports for one terminal (see terminal_probe.rs). */
export interface TerminalProbe {
  cwd: string | null;
  agent: { kind: TerminalAgent["kind"]; sessionId: string; title?: string } | null;
}

/** What a terminal types into its shell when it first opens: a still-running
 *  agent's resume command, else the pane's own `command`. After a relaunch
 *  that brings the conversation back instead of starting over. */
export function terminalStartup(content: { command?: string; agent?: TerminalAgent }): string | undefined {
  return (content.agent?.running && resumeCommand(content.agent)) || content.command;
}

function isTerminalAgent(v: unknown): v is TerminalAgent {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.kind === "string" &&
    TERMINAL_AGENT_KINDS.includes(a.kind) &&
    typeof a.sessionId === "string" &&
    typeof a.running === "boolean" &&
    (a.title === undefined || typeof a.title === "string") &&
    (a.accountHome === undefined || typeof a.accountHome === "string")
  );
}

export interface PaneLeaf {
  kind: "leaf";
  id: string;
  /** The bound session, or null for the (at most one) draft pane. */
  sessionId: string | null;
  /** A standalone surface — a terminal, a file tree, an editor. When present
   *  this leaf is NOT a conversation and `sessionId` is meaningless. */
  content?: PaneContent;
  /** Per-pane content zoom (CSS zoom on the conversation), 1 = 100%. Undefined
   *  = 100%. Narrow tiled panes often want smaller text. */
  zoom?: number;
  /** A dedicated artifact surface owned by `sessionId`. When absent, this leaf
   *  is the normal conversation pane for that session. */
  artifact?: ArtifactBlock;
}

export interface PaneSplit {
  kind: "split";
  id: string;
  /** "row" = children sit side-by-side (a | b | c); "col" = stacked (a / b / c). */
  dir: SplitDir;
  /** ≥2 children in visual order (left→right / top→bottom). */
  children: PaneNode[];
  /** Fraction of the axis per child; sums to 1, same length as `children`. */
  sizes: number[];
}

export type PaneNode = PaneLeaf | PaneSplit;

/** A child may never be squeezed below this fraction of its split's axis. */
export const MIN_SIZE = 0.1;

let nodeSeq = 0;
const genId = (): string => `p${++nodeSeq}`;

export function makeLeaf(sessionId: string | null): PaneLeaf {
  return { kind: "leaf", id: genId(), sessionId };
}

export function makeContentLeaf(content: PaneContent): PaneLeaf {
  return { kind: "leaf", id: genId(), sessionId: null, content };
}

function makeArtifactLeaf(sessionId: string, artifact: ArtifactBlock): PaneLeaf {
  return { kind: "leaf", id: genId(), sessionId, artifact };
}


const equalSizes = (n: number): number[] => Array.from({ length: n }, () => 1 / n);

/** Scale an arbitrary positive vector to sum 1. */
function normalizeSizes(sizes: number[]): number[] {
  const sum = sizes.reduce((a, b) => a + b, 0);
  return sum > 0 ? sizes.map((s) => s / sum) : equalSizes(sizes.length);
}

function makeSplit(dir: SplitDir, children: PaneNode[], sizes?: number[]): PaneSplit {
  return {
    kind: "split",
    id: genId(),
    dir,
    children,
    sizes: sizes ? normalizeSizes(sizes) : equalSizes(children.length),
  };
}

const edgeAxis = (edge: DockEdge): SplitDir => (edge === "left" || edge === "right" ? "row" : "col");
const edgeIsBefore = (edge: DockEdge): boolean => edge === "left" || edge === "top";

/** All leaves in visual order (left→right / top→bottom) — the focus-cycle order. */
export function leaves(node: PaneNode): PaneLeaf[] {
  return node.kind === "leaf" ? [node] : node.children.flatMap(leaves);
}

/**
 * The screens worth keeping alive: the one on display first, then the most
 * recently visited before it, capped at `limit`. Whatever falls off the end is
 * unmounted and rebuilt on the click that returns to it — so the active screen
 * must never be the one dropped, however long the history gets.
 */
export function recentScreens(previous: string[], activeId: string, limit: number): string[] {
  return [activeId, ...previous.filter((id) => id !== activeId)].slice(0, Math.max(1, limit));
}

export function findLeaf(node: PaneNode, id: string): PaneLeaf | null {
  return leaves(node).find((l) => l.id === id) ?? null;
}

/**
 * Canonicalize a tree: collapse a split that has fallen to one child into that
 * child, and merge a child split whose direction matches its parent up into the
 * parent (splicing children, scaling sizes) so the tree never carries redundant
 * nesting like row[ row[a,b], c ]. Sizes stay proportional.
 */
export function normalize(node: PaneNode): PaneNode {
  if (node.kind === "leaf") return node;
  const children = node.children.map(normalize);
  if (children.length === 1) return children[0];
  const outChildren: PaneNode[] = [];
  const outSizes: number[] = [];
  children.forEach((c, i) => {
    if (c.kind === "split" && c.dir === node.dir) {
      c.children.forEach((cc, j) => {
        outChildren.push(cc);
        outSizes.push(node.sizes[i] * c.sizes[j]);
      });
    } else {
      outChildren.push(c);
      outSizes.push(node.sizes[i]);
    }
  });
  return { ...node, children: outChildren, sizes: normalizeSizes(outSizes) };
}

/**
 * Dock `leaf` against the leaf `targetId` on `edge`. If the target already sits
 * in a split on the edge's axis, the new leaf becomes an equal sibling (all
 * re-equalized to 1/N); otherwise the target is wrapped in a fresh split of that
 * axis, split evenly. Returns the new tree (unchanged if the target is missing).
 */
export function insertLeaf(
  tree: PaneNode,
  targetId: string,
  edge: DockEdge,
  leaf: PaneLeaf,
): PaneNode {
  if (!findLeaf(tree, targetId)) return tree;
  const axis = edgeAxis(edge);
  const before = edgeIsBefore(edge);
  const pair = (t: PaneNode): PaneNode[] => (before ? [leaf, t] : [t, leaf]);

  // Whole tree is the target leaf → wrap it.
  if (tree.kind === "leaf") return makeSplit(axis, pair(tree));

  function rec(node: PaneNode): PaneNode {
    if (node.kind === "leaf") return node;
    const idx = node.children.findIndex((c) => c.kind === "leaf" && c.id === targetId);
    if (idx >= 0) {
      if (node.dir === axis) {
        // Splice the new leaf beside the target as an equal sibling.
        const children = [...node.children];
        children.splice(before ? idx : idx + 1, 0, leaf);
        return { ...node, children, sizes: equalSizes(children.length) };
      }
      // Perpendicular dock: wrap just the target child in a new split.
      const children = [...node.children];
      children[idx] = makeSplit(axis, pair(node.children[idx]));
      return { ...node, children };
    }
    return { ...node, children: node.children.map(rec) };
  }
  return normalize(rec(tree));
}

/**
 * Remove the leaf `targetId`, re-equalizing its former siblings and collapsing
 * any split left with a single child. Returns the new tree + the leaf to focus
 * next (the visually-nearest survivor), or null if it was the only leaf.
 */
export function removeLeaf(
  tree: PaneNode,
  targetId: string,
): { tree: PaneNode; nextFocusId: string } | null {
  const all = leaves(tree);
  if (all.length <= 1) return null;
  // Pick the focus successor before mutating: next sibling in visual order, else previous.
  const i = all.findIndex((l) => l.id === targetId);
  if (i < 0) return null;
  const nextFocusId = (all[i + 1] ?? all[i - 1]).id;

  function rec(node: PaneNode): PaneNode {
    if (node.kind === "leaf") return node;
    const idx = node.children.findIndex((c) => c.kind === "leaf" && c.id === targetId);
    if (idx >= 0) {
      const children = node.children.filter((_, k) => k !== idx);
      return { ...node, children, sizes: equalSizes(children.length) };
    }
    return { ...node, children: node.children.map(rec) };
  }
  return { tree: normalize(rec(tree)), nextFocusId };
}

/** Replace a split's size vector (divider drag). Clamps each to ≥ MIN_SIZE and
 *  renormalizes to sum 1. */
export function setSplitSizes(tree: PaneNode, splitId: string, sizes: number[]): PaneNode {
  function rec(node: PaneNode): PaneNode {
    if (node.kind === "leaf") return node;
    if (node.id === splitId && node.children.length === sizes.length) {
      const clamped = sizes.map((s) => Math.max(MIN_SIZE, s));
      return { ...node, sizes: normalizeSizes(clamped) };
    }
    return { ...node, children: node.children.map(rec) };
  }
  return rec(tree);
}

export function setLeafSession(tree: PaneNode, leafId: string, sessionId: string | null): PaneNode {
  function rec(node: PaneNode): PaneNode {
    if (node.kind === "leaf") {
      if (node.id !== leafId) return node;
      const conversationLeaf = { ...node };
      delete conversationLeaf.artifact;
      return { ...conversationLeaf, sessionId };
    }
    return { ...node, children: node.children.map(rec) };
  }
  return rec(tree);
}

/** The child indices leading from `node` down to the leaf `id` ([] when `node`
 *  IS that leaf), or null when the leaf is absent. */
function indexPath(node: PaneNode, id: string): number[] | null {
  if (node.kind === "leaf") return node.id === id ? [] : null;
  for (let i = 0; i < node.children.length; i++) {
    const rest = indexPath(node.children[i], id);
    if (rest) return [i, ...rest];
  }
  return null;
}

/**
 * True when `leafId` already sits on `edge` of `anchorId`: the split where their
 * paths diverge runs along the edge's axis, and the leaf's branch comes after
 * the anchor's (before it, for left/top). Used to leave an already correctly
 * placed pane — and the divider the user dragged — untouched.
 */
export function isDockedOn(
  tree: PaneNode,
  anchorId: string,
  leafId: string,
  edge: DockEdge,
): boolean {
  const anchor = indexPath(tree, anchorId);
  const leaf = indexPath(tree, leafId);
  if (!anchor || !leaf) return false;
  let i = 0;
  while (i < anchor.length && i < leaf.length && anchor[i] === leaf[i]) i++;
  if (i >= anchor.length || i >= leaf.length) return false;
  let split: PaneNode = tree;
  for (const k of anchor.slice(0, i)) {
    if (split.kind !== "split") return false;
    split = split.children[k];
  }
  if (split.kind !== "split" || split.dir !== edgeAxis(edge)) return false;
  return edgeIsBefore(edge) ? leaf[i] < anchor[i] : leaf[i] > anchor[i];
}

/** The leaf adjacent to `id` in focus-cycle order (wraps around). */
export function adjacentLeafId(tree: PaneNode, id: string, dir: "next" | "prev"): string {
  const order = leaves(tree);
  const i = order.findIndex((l) => l.id === id);
  if (i < 0) return order[0]?.id ?? id;
  const j = dir === "next" ? (i + 1) % order.length : (i - 1 + order.length) % order.length;
  return order[j].id;
}

// ---- Store ----

/** The session id in a deep-linked/reloaded `/live/:id` URL, so the initial
 *  pane is already bound to it — no null-focus transient for the URL↔focus sync
 *  to clobber (which, under StrictMode's double-invoked effects, would loop). */
function initialSessionId(): string | null {
  if (typeof window === "undefined") return null;
  const m = window.location.pathname.match(/\/live\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * A "group" (screen) is one independent free-form pane arrangement. Multiple
 * groups switch via the tab strip, like browser tab groups / iTerm windows. An
 * empty group (`tree === null`) shows the drag-a-session onboarding.
 *
 * Every Screen belongs to one project — Project → Screens → panes, the same
 * shape as Orca's worktree → tab groups → tabs — and the Screen bar shows the
 * active project's Screens only. Work filed under no project belongs to the
 * Default project.
 */
export interface LayoutGroup {
  id: string;
  /** A name the USER gave this Screen; "" means derive one (see groupLabel).
   *  Nothing but a rename writes it, so a derived label never freezes. */
  name: string;
  tree: PaneNode | null;
  focusedLeafId: string | null;
  zoomedLeafId: string | null;
  /** The owning project's id, or DEFAULT_PROJECT. Undefined only on a Screen
   *  saved before Screens had projects: it shows under Default until
   *  `reconcileProjects` files it by what it holds. */
  projectId?: string;
}

/** The project of Screens whose work is filed under no project folder. */
export const DEFAULT_PROJECT = "";

export function projectOf(group: LayoutGroup): string {
  return group.projectId ?? DEFAULT_PROJECT;
}

/** The active project: the project of the Screen on display. Derived, never
 *  stored, so it cannot disagree with the Screen that is actually showing. */
export function selectActiveProjectId(s: { groups: LayoutGroup[]; activeGroupId: string }): string {
  const active = s.groups.find((g) => g.id === s.activeGroupId);
  return active ? projectOf(active) : DEFAULT_PROJECT;
}

/** The draft pane of a Screen that holds nothing else — a new conversation
 *  nobody has sent anything in yet. Every "new session" entry opens one, and
 *  the sidebar and the Screen bar both show it as that new session. */
export function draftLeafOf(group: LayoutGroup): PaneLeaf | null {
  const t = group.tree;
  return t && t.kind === "leaf" && !t.sessionId && !t.content && !t.artifact ? t : null;
}

/** One project's Screens, in tab order. */
export function projectGroups(groups: LayoutGroup[], projectId: string): LayoutGroup[] {
  return groups.filter((g) => projectOf(g) === projectId);
}

let groupSeq = 0;
const genGroupId = (): string => `g${++groupSeq}`;

// ---- Persistence ----
// The full layout (groups, trees, per-leaf session/sizes/zoom, active group) is
// saved to localStorage so a relaunch restores the workspace. Sessions deleted
// between runs are reconciled by `pruneSessions` once the session list loads.
const LAYOUT_KEY = "ai4s.layout.v2";

/** Exported for the tests: a hand-edited or downgraded store must not make the
 *  app mount a surface it does not know, and that rule deserves pinning. */
/** Panes that hold a FILE, and so can stand in for one another. A terminal, a
 *  file tree and a terminal each have their own state, and are never
 *  replaced. */
function isDocument(content: PaneContent): boolean {
  return content.kind === "editor" || content.kind === "notebook";
}

export function isPaneContent(v: unknown): v is PaneContent {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  if (c.kind === "terminal") {
    return (
      (c.cwd === undefined || typeof c.cwd === "string") &&
      (c.name === undefined || typeof c.name === "string") &&
      (c.command === undefined || typeof c.command === "string") &&
      (c.agent === undefined || isTerminalAgent(c.agent))
    );
  }
  if (c.kind === "files") return c.path === undefined || typeof c.path === "string";
  if (c.kind === "notebook" || c.kind === "editor") return typeof c.path === "string";
  return false;
}

function isNode(v: unknown): v is PaneNode {
  if (!v || typeof v !== "object") return false;
  const n = v as Record<string, unknown>;
  if (n.kind === "leaf") {
    if (typeof n.id !== "string") return false;
    if (n.content !== undefined && !isPaneContent(n.content)) return false;
    if (n.artifact === undefined) return true;
    if (!n.artifact || typeof n.artifact !== "object") return false;
    const artifact = n.artifact as Record<string, unknown>;
    return (
      artifact.kind === "artifact" &&
      typeof artifact.path === "string" &&
      typeof artifact.filename === "string" &&
      typeof artifact.artifact === "string"
    );
  }
  if (n.kind === "split")
    return (
      typeof n.id === "string" &&
      n.dir === (n.dir === "row" ? "row" : "col") &&
      Array.isArray(n.children) &&
      n.children.length >= 2 &&
      n.children.every(isNode) &&
      Array.isArray(n.sizes) &&
      (n.sizes as unknown[]).length === n.children.length
    );
  return false;
}

/** Advance the id counters past any restored ids so fresh nodes never collide. */
function bumpSeqs(groups: LayoutGroup[]): void {
  const bumpNode = (n: PaneNode) => {
    const num = Number(n.id.replace(/^p/, ""));
    if (Number.isFinite(num) && num > nodeSeq) nodeSeq = num;
    if (n.kind === "split") n.children.forEach(bumpNode);
  };
  for (const g of groups) {
    const num = Number(g.id.replace(/^g/, ""));
    if (Number.isFinite(num) && num > groupSeq) groupSeq = num;
    if (g.tree) bumpNode(g.tree);
  }
}

export interface Persisted {
  groups: LayoutGroup[];
  activeGroupId: string;
}

/** Forget content this build can no longer show, leaving an ordinary pane. */
function dropRetiredContent(node: unknown): PaneNode {
  const n = node as Record<string, unknown>;
  if (n?.kind === "split" && Array.isArray(n.children)) {
    return { ...n, children: n.children.map(dropRetiredContent) } as unknown as PaneNode;
  }
  if (n?.kind === "leaf" && n.content !== undefined && !isPaneContent(n.content)) {
    const rest = { ...n };
    delete rest.content;
    return rest as unknown as PaneNode;
  }
  return node as PaneNode;
}

function loadPersisted(): Persisted | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAYOUT_KEY);
    return raw ? parseLayout(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** A saved layout, checked: from this browser's storage, a web account's copy
 *  on the desktop, or the desktop window's own. Null when it is not one. */
export function parseLayout(value: unknown): Persisted | null {
  try {
    const p = value as Persisted;
    if (!p || !Array.isArray(p.groups) || p.groups.length === 0) return null;
    if (typeof p.activeGroupId !== "string") return null;
    for (const g of p.groups) {
      if (typeof g.id !== "string" || typeof g.name !== "string") return null;
      if (g.projectId !== undefined && typeof g.projectId !== "string") delete g.projectId;
      // A pane kind that no longer exists (the browser pane was removed) must
      // cost the user that ONE pane, not every Screen they had open: strip the
      // content and keep the leaf, rather than failing the whole layout.
      if (g.tree !== null) g.tree = dropRetiredContent(g.tree);
      if (g.tree !== null && !isNode(g.tree)) return null;
      g.zoomedLeafId = null; // zoom is transient — never restore a maximized pane
    }
    if (!p.groups.some((g) => g.id === p.activeGroupId)) p.activeGroupId = p.groups[0].id;
    bumpSeqs(p.groups);
    return p;
  } catch {
    return null;
  }
}

/** A shell belongs to a leaf; a leaf that has left every Screen is closed, and
 *  its shell with it. Doing this on every commit rather than in the pane's own
 *  cleanup is the point: React unmounts a pane that only MOVED (splitting makes
 *  its leaf a child of a new node) or that is simply on another Screen, and
 *  killing the shell there cost the user their session every time they
 *  split. */
function reapClosedPanes(groups: LayoutGroup[]): void {
  const open = new Set<string>();
  for (const group of groups) {
    if (group.tree) for (const leaf of leaves(group.tree)) open.add(leaf.id);
  }
  void import("./terminalSessions").then(({ pruneTerminals }) => pruneTerminals(open));
}

function persist(groups: LayoutGroup[], activeGroupId: string): void {
  if (typeof window === "undefined") return;
  const json = JSON.stringify({ groups, activeGroupId });
  try {
    window.localStorage.setItem(LAYOUT_KEY, json);
    reapClosedPanes(groups);
  } catch {
    /* storage full/unavailable never blocks layout changes */
  }
  // The desktop publishes its Screens; a signed-in web account keeps its own
  // on the desktop (see layoutSync.ts).
  void import("./layoutSync").then(({ layoutChanged }) => layoutChanged(json));
}

/** A shared layout as one view should show it. The Screens are shared — the
 *  window and every tab show the same ones, holding the same panes — but where
 *  each is looking is its own: which Screen is on display, and which pane is
 *  focused or zoomed in each. Without this, switching Screens in one browser
 *  tab switched every other tab and the desktop window with it. Ours is kept
 *  wherever it still exists in what arrived. */
export function keepOwnView(incoming: Persisted, own: Persisted): Persisted {
  const mine = new Map(own.groups.map((g) => [g.id, g]));
  const groups = incoming.groups.map((g) => {
    const m = mine.get(g.id);
    if (!m || !g.tree) return g;
    const ids = new Set(leaves(g.tree).map((l) => l.id));
    return {
      ...g,
      focusedLeafId: m.focusedLeafId && ids.has(m.focusedLeafId) ? m.focusedLeafId : g.focusedLeafId,
      zoomedLeafId: m.zoomedLeafId && ids.has(m.zoomedLeafId) ? m.zoomedLeafId : null,
    };
  });
  const activeGroupId = groups.some((g) => g.id === own.activeGroupId) ? own.activeGroupId : incoming.activeGroupId;
  return { groups, activeGroupId };
}

/** A copy of a whole layout under fresh ids: where a token client's own
 *  Screens start, the first time it leaves the desktop window's. */
export function cloneLayout(layout: Persisted): Persisted {
  const groups = layout.groups.map((g) => {
    const tree = g.tree && cloneForImport(g.tree);
    return { ...g, id: genGroupId(), tree, focusedLeafId: tree ? leaves(tree)[0].id : null, zoomedLeafId: null };
  });
  const active = layout.groups.findIndex((g) => g.id === layout.activeGroupId);
  return { groups, activeGroupId: groups[Math.max(0, active)].id };
}

/** A copy of `node` under fresh ids. A terminal is copied as a NEW shell in the
 *  same folder: the original's shell is not this client's to type into, and
 *  re-running its startup command or agent resume would start a second copy of
 *  whatever the original is running. */
function cloneForImport(node: PaneNode): PaneNode {
  if (node.kind === "split") {
    return { ...node, id: genId(), children: node.children.map(cloneForImport), sizes: [...node.sizes] };
  }
  const leaf: PaneLeaf = { ...node, id: genId() };
  if (leaf.content?.kind === "terminal") {
    leaf.content = { kind: "terminal", cwd: leaf.content.cwd, name: leaf.content.name };
  }
  return leaf;
}

function sameAgent(a: TerminalAgent | undefined, b: TerminalAgent | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.kind === b.kind &&
    a.sessionId === b.sessionId &&
    a.running === b.running &&
    a.title === b.title &&
    a.accountHome === b.accountHome
  );
}

// ---- The Screen each project was last on ----
// Switching projects returns to where the user was in that project, across a
// relaunch too. Kept beside the layout rather than in it: it is a pointer into
// the layout, maintained by one subscription below instead of by every action
// that happens to change the active Screen.
const LAST_SCREEN_KEY = "ai4s.layout.lastScreenByProject";

function loadLastScreens(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LAST_SCREEN_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
  } catch {
    return {};
  }
}

const lastScreenByProject: Record<string, string> = loadLastScreens();

interface LayoutState {
  /** All groups, in tab order. Always ≥1. */
  groups: LayoutGroup[];
  activeGroupId: string;
  // Mirrors of the ACTIVE group, kept in sync on every mutation so existing
  // selectors (`s.tree`, `s.focusedLeafId`) keep working unchanged. `tree` is
  // null when the active group is empty (onboarding).
  tree: PaneNode | null;
  focusedLeafId: string | null;
  /** A transiently maximized leaf (Cmd+Shift+Enter); not persisted. */
  zoomedLeafId: string | null;
  /** The "tentative" (preview) screen opened by clicking a sidebar session, à la
   *  a browser preview tab. While tentative, clicking another session REUSES it
   *  (swaps its one pane); any real interaction — typing, sending, splitting,
   *  docking, or switching to another screen — PINS it (clears this) so the next
   *  session-click opens a fresh tentative screen. Not persisted (a relaunch
   *  restores every screen as pinned). Invariant: non-null ⟹ === activeGroupId. */
  ephemeralGroupId: string | null;
  /** Open `sessionId` full-screen in the tentative screen — reusing the current
   *  tentative screen if one exists, else opening a new one. The sidebar-click
   *  entry (#3). `projectId` is the session's project (default: the active
   *  one); the Screen lands there, so opening a session also shows its
   *  project. */
  openSessionEphemeral: (sessionId: string, projectId?: string) => void;
  /** Pin the tentative screen (clear `ephemeralGroupId`) — called by any real
   *  interaction with it. No-op when there is none. */
  pinEphemeral: () => void;
  /** A new Screen in the active project. With `content`, it opens holding that
   *  surface — the Screen bar's own "+" makes Screens, so a terminal asked for
   *  there arrives as one rather than splitting the layout the user was
   *  looking at. */
  addGroup: (content?: PaneContent) => string;
  /** Show a project: the Screen it was last on, else its first, else a new
   *  empty one — a project is never shown with no Screen at all. */
  setActiveProject: (projectId: string) => void;
  /** File Screens under projects by what they hold (`resolve`): Screens saved
   *  before Screens had projects — and, with `orphans`, Screens whose project
   *  is not in `valid`. Orphans are judged only when the caller knows the list
   *  is complete (the first load after launch): a project created a moment ago
   *  can be missing from a list that is still being refreshed, and its new
   *  Screen must not be swept into Default for that. */
  reconcileProjects: (valid: Set<string>, resolve: (group: LayoutGroup) => string, orphans: boolean) => void;
  /** A project was removed: its Screens — and the work in them — move to
   *  Default rather than vanishing with it. */
  releaseProject: (projectId: string) => void;
  /** Record what a terminal pane is doing now — its shell's directory and the
   *  coding agent in its foreground (null: none) — so a relaunch reopens it
   *  there and resumes that agent. An agent that has exited is kept, marked not
   *  running: it is still the terminal's LAST session, offered from its menu. */
  recordTerminal: (leafId: string, probe: TerminalProbe) => void;
  /** Open ONE new pane in its own Screen — bound to `sessionId`, or a draft when
   *  null — activate and focus it. Every "new
   *  session" entry point goes through this: binding the new work onto the
   *  focused pane took over whatever conversation the user had there. An empty
   *  active Screen is filled instead of stacking a second empty one beside it.
   *  Returns the new leaf's id. */
  openInNewGroup: (sessionId: string | null, projectId?: string) => string;
  /** Close a group; a project never drops below one Screen (its last Screen is
   *  emptied instead). */
  closeGroup: (groupId: string) => void;
  renameGroup: (groupId: string, name: string) => void;
  /** Move a Screen to `index` among its project's Screens (the Screen bar's
   *  order), as counted with the moved Screen taken out. */
  moveGroup: (groupId: string, index: number) => void;
  setActiveGroup: (groupId: string) => void;
  /** Split the focused leaf toward `dir` (row → new pane on the right, col →
   *  below), binding `sessionId` to it (or a draft when null) and focusing it.
   *  Returns the new leaf's id — a draft pane's caller needs it to aim the
   *  pane's own `draft:<leafId>` slot at a folder — or null when there was no
   *  focused leaf to split. */
  split: (dir: SplitDir, sessionId: string | null) => string | null;
  /** Open a standalone surface — a terminal, a file tree, an editor — beside the
   *  focused pane, or filling the group when it is empty. Returns the new leaf. */
  openContentPane: (content: PaneContent, dir?: SplitDir) => string;
  /** Open a file in THE document pane: the one already showing a file is
   *  reused, and only when there is none is a pane created. */
  showDocumentPane: (content: PaneContent) => string;
  /** Name a content pane (a terminal). An empty name clears it, so the pane
   *  goes back to being called what it is. */
  renamePane: (leafId: string, name: string) => void;
  /** Dock a NEW pane (bound to `sessionId`, or a draft when null) against
   *  `targetLeafId` on `edge`; focuses it. The drag-to-dock entry for a session
   *  coming from the sidebar. */
  dockSession: (targetLeafId: string, edge: DockEdge, sessionId: string | null) => string;
  /** Present an artifact beside (`right`) or below (`bottom`) its owning
   *  conversation in the current Screen or a newly created Screen. An omitted
   *  placement means "wherever it already is", defaulting to `right` for a panel
   *  that is not open yet. Returns the artifact leaf id. */
  presentArtifact: (
    sessionId: string,
    artifact: ArtifactBlock,
    placement?: ArtifactPanelPlacement,
    target?: ArtifactPanelTarget,
  ) => string | null;
  /** Move an existing leaf to dock against `targetLeafId` on `edge` (re-dock via
   *  dragging a pane header). No-op if target === moved or target is missing. */
  moveLeaf: (leafId: string, targetLeafId: string, edge: DockEdge) => void;
  /** Move a leaf from ANOTHER group into the ACTIVE group, docked against
   *  `targetLeafId` on `edge` (or filling the active group when target is ""):
   *  the cross-screen drag (#4). Removes it from its source group (which may
   *  become empty). No-op if the leaf isn't found in another group. */
  moveLeafToActiveGroup: (leafId: string, targetLeafId: string, edge: DockEdge) => void;
  /** Close the focused leaf (no-op on the last pane). */
  closeFocused: () => void;
  closePane: (leafId: string) => void;
  /** Put something else where a pane is: a conversation where a terminal was,
   *  or a terminal where a conversation was. The pane gets a new id, so what
   *  it held (a terminal's shell) closes the way a closed pane's does. */
  replacePane: (leafId: string, next: { sessionId: string } | { content: PaneContent }) => void;
  focusLeaf: (leafId: string) => void;
  focusAdjacent: (dir: "next" | "prev") => void;
  setSplitSizes: (splitId: string, sizes: number[]) => void;
  /** Bind (or clear, with null) the session shown in a leaf. */
  bindSession: (leafId: string, sessionId: string | null) => void;
  /** Set a leaf's per-pane content zoom (1 = 100%). */
  setLeafZoom: (leafId: string, zoom: number) => void;
  toggleZoom: (leafId?: string) => void;
  /** Collapse to a single pane bound to `sessionId`. */
  reset: (sessionId: string | null) => void;
  /** Replace every Screen with `layout` — a signed-in web account's own,
   *  kept on the desktop. */
  adoptLayout: (layout: Persisted) => void;
  /** Drop leaves whose session was deleted (`gone`), collapsing toward a single
   *  pane. Only confirmed deletions: a session missing from the sidebar's list
   *  is not one (see `findDeletedSessions`). */
  pruneSessions: (gone: Set<string>) => void;
}

export const useLayoutStore = create<LayoutState>((set, get) => {
  // Restore the saved workspace, else start as a single pane seeded from the URL.
  const restored = loadPersisted();
  const root = restored ? null : makeLeaf(initialSessionId());
  const initGroups: LayoutGroup[] = restored
    ? restored.groups
    : [{ id: genGroupId(), name: "", tree: root, focusedLeafId: root!.id, zoomedLeafId: null }];
  const initActiveId = restored ? restored.activeGroupId : initGroups[0].id;
  const initActive = initGroups.find((g) => g.id === initActiveId)!;
  const restoredLeafIds = initGroups.flatMap((g) => (g.tree ? leaves(g.tree).map((l) => l.id) : []));
  void import("./layoutSync").then(({ layoutChanged }) =>
    layoutChanged(JSON.stringify({ groups: initGroups, activeGroupId: initActiveId })),
  );
  void import("./terminalSessions").then(({ pruneTerminalEnv }) => pruneTerminalEnv(restoredLeafIds));

  /** Write a patch into the ACTIVE group and re-mirror the top-level fields. */
  const commitActive = (patch: Partial<Omit<LayoutGroup, "id" | "name">>) =>
    set((s) => {
      const groups = s.groups.map((g) => (g.id === s.activeGroupId ? { ...g, ...patch } : g));
      const active = groups.find((g) => g.id === s.activeGroupId)!;
      persist(groups, s.activeGroupId);
      return {
        groups,
        tree: active.tree,
        focusedLeafId: active.focusedLeafId,
        zoomedLeafId: active.zoomedLeafId,
      };
    });

  /** Write a patch into whichever group OWNS `leafId`, active or not, and
   *  re-mirror the active group's fields. Every Screen stays mounted, so a pane
   *  can outlive the switch away from it: an async send that lands after the
   *  user moved to another Screen must still bind its own pane, not miss the
   *  active tree and leave that pane an empty draft. No-op if no group has it. */
  const commitLeafGroup = (leafId: string, patch: (group: LayoutGroup) => Partial<LayoutGroup>) =>
    set((s) => {
      const owner = s.groups.find((g) => g.tree && findLeaf(g.tree, leafId));
      if (!owner) return {};
      const groups = s.groups.map((g) => (g.id === owner.id ? { ...g, ...patch(g) } : g));
      const active = groups.find((g) => g.id === s.activeGroupId)!;
      persist(groups, s.activeGroupId);
      return {
        groups,
        tree: active.tree,
        focusedLeafId: active.focusedLeafId,
        zoomedLeafId: active.zoomedLeafId,
      };
    });

  return {
    groups: initGroups,
    activeGroupId: initActiveId,
    tree: initActive.tree,
    focusedLeafId: initActive.focusedLeafId,
    zoomedLeafId: null,
    ephemeralGroupId: null,

    adoptLayout: (layout) =>
      set(() => {
        bumpSeqs(layout.groups);
        const active = layout.groups.find((g) => g.id === layout.activeGroupId) ?? layout.groups[0];
        persist(layout.groups, active.id);
        return {
          groups: layout.groups,
          activeGroupId: active.id,
          tree: active.tree,
          focusedLeafId: active.focusedLeafId,
          zoomedLeafId: null,
          ephemeralGroupId: null,
        };
      }),

    openSessionEphemeral: (sessionId, projectId) =>
      set((s) => {
        const project = projectId ?? selectActiveProjectId(s);
        // Already on screen somewhere? Go there — clicking a session in the
        // sidebar means "show me this conversation", and building a second
        // screen for one already open split the user's attention across two
        // copies of it. First match in tab order wins, and its pane takes the
        // focus. Only a session nowhere in the layout opens a new screen.
        for (const g of s.groups) {
          const hit = g.tree && sessionId ? leaves(g.tree).find((l) => l.sessionId === sessionId) : null;
          if (!hit) continue;
          // A zoomed pane hides its neighbours: revealing one of them has to
          // undo the zoom, or the focus lands somewhere invisible.
          const zoomedLeafId = g.zoomedLeafId === hit.id ? g.zoomedLeafId : null;
          const groups = s.groups.map((x) =>
            x.id === g.id ? { ...x, focusedLeafId: hit.id, zoomedLeafId } : x,
          );
          persist(groups, g.id);
          // `ephemeralGroupId` is left alone: looking at a screen is not work
          // done in the tentative one, so the next preview still reuses it (#78).
          return {
            groups,
            activeGroupId: g.id,
            tree: g.tree,
            focusedLeafId: hit.id,
            zoomedLeafId,
          };
        }
        const reusable =
          s.ephemeralGroupId && s.groups.some((g) => g.id === s.ephemeralGroupId)
            ? s.ephemeralGroupId
            : null;
        const leaf = makeLeaf(sessionId);
        if (reusable) {
          // Reuse the tentative screen: swap its single pane's session, stay
          // tentative. This is the ONE path that keeps ephemeralGroupId. A
          // preview of a session in another project moves with it — a preview
          // left behind in the old project is exactly the pile-up #78 was.
          const groups = s.groups.map((g) =>
            g.id === reusable
              ? { ...g, name: "", projectId: project, tree: leaf, focusedLeafId: leaf.id, zoomedLeafId: null }
              : g,
          );
          persist(groups, reusable);
          return {
            groups,
            activeGroupId: reusable,
            tree: leaf,
            focusedLeafId: leaf.id,
            zoomedLeafId: null,
            ephemeralGroupId: reusable,
          };
        }
        // Open a fresh tentative screen.
        const g: LayoutGroup = {
          id: genGroupId(),
          name: "",
          projectId: project,
          tree: leaf,
          focusedLeafId: leaf.id,
          zoomedLeafId: null,
        };
        const groups = [...s.groups, g];
        persist(groups, g.id);
        return {
          groups,
          activeGroupId: g.id,
          tree: g.tree,
          focusedLeafId: g.focusedLeafId,
          zoomedLeafId: null,
          ephemeralGroupId: g.id,
        };
      }),
    pinEphemeral: () => set((s) => (s.ephemeralGroupId ? { ephemeralGroupId: null } : {})),

    addGroup: (content) => {
      const leaf = content ? makeContentLeaf(content) : null;
      const g: LayoutGroup = {
        id: genGroupId(),
        name: "",
        projectId: selectActiveProjectId(get()),
        tree: leaf,
        focusedLeafId: leaf?.id ?? null,
        zoomedLeafId: null,
      };
      set((s) => ({
        groups: [...s.groups, g],
        activeGroupId: g.id,
        tree: g.tree,
        focusedLeafId: g.focusedLeafId,
        zoomedLeafId: null,
        // Leaving the tentative screen for an explicit new one pins it.
        ephemeralGroupId: null,
      }));
      persist(get().groups, get().activeGroupId);
      return g.id;
    },

    openInNewGroup: (sessionId, projectId) => {
      const leaf = makeLeaf(sessionId);
      set((s) => {
        const project = projectId ?? selectActiveProjectId(s);
        const active = { tree: leaf, focusedLeafId: leaf.id, zoomedLeafId: null };
        // An empty Screen of that project (onboarding, or every pane closed) is
        // where the new pane belongs — a second empty Screen beside it would be
        // noise. The active one first, else any.
        const empty =
          (!s.tree && selectActiveProjectId(s) === project
            ? s.groups.find((g) => g.id === s.activeGroupId)
            : undefined) ?? projectGroups(s.groups, project).find((g) => !g.tree);
        const groups = empty
          ? s.groups.map((g) =>
              g.id === empty.id ? { ...g, projectId: project, ...active } : g,
            )
          : [...s.groups, { id: genGroupId(), name: "", projectId: project, ...active }];
        const activeGroupId = empty ? empty.id : groups[groups.length - 1].id;
        persist(groups, activeGroupId);
        // New work pins the tentative screen: the next sidebar click opens its
        // own preview screen instead of swapping this pane out.
        return { groups, activeGroupId, ...active, ephemeralGroupId: null };
      });
      return leaf.id;
    },

    closeGroup: (groupId) => {
      set((s) => {
        const ephemeralGroupId = s.ephemeralGroupId === groupId ? null : s.ephemeralGroupId;
        const closing = s.groups.find((g) => g.id === groupId);
        if (!closing) return {};
        const siblings = projectGroups(s.groups, projectOf(closing));
        if (siblings.length <= 1) {
          // A project never has zero Screens — empty its last one instead. Its
          // name went with what it held: an empty Screen is the project's home.
          const groups = s.groups.map((g) =>
            g.id === groupId ? { ...g, name: "", tree: null, focusedLeafId: null, zoomedLeafId: null } : g,
          );
          const active = groups.find((g) => g.id === s.activeGroupId)!;
          return {
            groups,
            tree: active.tree,
            focusedLeafId: active.focusedLeafId,
            zoomedLeafId: active.zoomedLeafId,
            ephemeralGroupId,
          };
        }
        const idx = siblings.findIndex((g) => g.id === groupId);
        const groups = s.groups.filter((g) => g.id !== groupId);
        // If the active group closed, activate its neighbor IN THE SAME
        // project — closing a Screen must not hop to another project.
        const remaining = siblings.filter((g) => g.id !== groupId);
        const active =
          s.activeGroupId === groupId
            ? remaining[Math.min(idx, remaining.length - 1)]
            : groups.find((g) => g.id === s.activeGroupId)!;
        return {
          groups,
          activeGroupId: active.id,
          tree: active.tree,
          focusedLeafId: active.focusedLeafId,
          zoomedLeafId: active.zoomedLeafId,
          ephemeralGroupId,
        };
      });
      persist(get().groups, get().activeGroupId);
    },
    renameGroup: (groupId, name) => {
      // Naming the tentative Screen keeps it: reusing it for the next preview
      // would throw away the name the user just gave it.
      set((s) => ({
        groups: s.groups.map((g) => (g.id === groupId ? { ...g, name } : g)),
        ...(s.ephemeralGroupId === groupId ? { ephemeralGroupId: null } : {}),
      }));
      persist(get().groups, get().activeGroupId);
    },
    moveGroup: (groupId, index) => {
      set((s) => {
        const moving = s.groups.find((g) => g.id === groupId);
        if (!moving) return {};
        const siblings = projectGroups(s.groups, projectOf(moving));
        const reordered = siblings.filter((g) => g.id !== groupId);
        reordered.splice(Math.max(0, Math.min(index, reordered.length)), 0, moving);
        if (reordered.every((g, i) => g === siblings[i])) return {};
        // Other projects' Screens keep their slots; this project's slots take
        // the new order.
        let next = 0;
        const groups = s.groups.map((g) => (projectOf(g) === projectOf(moving) ? reordered[next++] : g));
        return { groups };
      });
      persist(get().groups, get().activeGroupId);
    },
    setActiveGroup: (groupId) =>
      set((s) => {
        const g = s.groups.find((x) => x.id === groupId);
        if (!g) return {};
        // Looking at another Screen is NOT work done in the tentative one, so it
        // stays tentative and the next sidebar click reuses it. Pinning here
        // instead meant every glance away stranded a preview Screen and the next
        // click built another, so they piled up without limit (#78) — which also
        // multiplies the panes a Screen switch has to render (#92). Only real
        // work in the pane pins it, via pinEphemeral.
        persist(s.groups, groupId);
        return { activeGroupId: groupId, tree: g.tree, focusedLeafId: g.focusedLeafId, zoomedLeafId: g.zoomedLeafId };
      }),

    setActiveProject: (projectId) =>
      set((s) => {
        if (selectActiveProjectId(s) === projectId) return {};
        const mine = projectGroups(s.groups, projectId);
        let target = mine.find((g) => g.id === lastScreenByProject[projectId]) ?? mine[0];
        let groups = s.groups;
        if (!target) {
          target = { id: genGroupId(), name: "", projectId, tree: null, focusedLeafId: null, zoomedLeafId: null };
          groups = [...groups, target];
        }
        persist(groups, target.id);
        return {
          groups,
          activeGroupId: target.id,
          tree: target.tree,
          focusedLeafId: target.focusedLeafId,
          zoomedLeafId: target.zoomedLeafId,
        };
      }),

    reconcileProjects: (valid, resolve, orphans) =>
      set((s) => {
        let changed = false;
        const groups = s.groups.map((g) => {
          const stale =
            g.projectId === undefined ||
            (orphans && g.projectId !== DEFAULT_PROJECT && !valid.has(g.projectId));
          if (!stale) return g;
          const projectId = resolve(g);
          const next = valid.has(projectId) ? projectId : DEFAULT_PROJECT;
          if (next === g.projectId) return g;
          changed = true;
          return { ...g, projectId: next };
        });
        if (!changed) return {};
        persist(groups, s.activeGroupId);
        return { groups };
      }),

    releaseProject: (projectId) =>
      set((s) => {
        if (projectId === DEFAULT_PROJECT || !s.groups.some((g) => g.projectId === projectId)) return {};
        const groups = s.groups.map((g) => (g.projectId === projectId ? { ...g, projectId: DEFAULT_PROJECT } : g));
        persist(groups, s.activeGroupId);
        return { groups };
      }),

    recordTerminal: (leafId, probe) =>
      set((s) => {
        const owner = s.groups.find((g) => g.tree && findLeaf(g.tree, leafId));
        const leaf = owner?.tree ? findLeaf(owner.tree, leafId) : null;
        if (!owner || leaf?.content?.kind !== "terminal") return {};
        const content = leaf.content;
        const cwd = probe.cwd ?? content.cwd;
        const agent: TerminalAgent | undefined = probe.agent
          ? { ...probe.agent, running: true }
          : content.agent && { ...content.agent, running: false };
        // Polled every few seconds: commit — and re-render, and persist — only
        // when something actually moved.
        if (cwd === content.cwd && sameAgent(agent, content.agent)) return {};
        const next: PaneContent = { ...content, cwd, agent };
        const swap = (node: PaneNode): PaneNode =>
          node.kind === "leaf"
            ? node.id === leafId
              ? { ...node, content: next }
              : node
            : { ...node, children: node.children.map(swap) };
        const groups = s.groups.map((g) => (g.id === owner.id ? { ...g, tree: swap(g.tree!) } : g));
        const active = groups.find((g) => g.id === s.activeGroupId)!;
        persist(groups, s.activeGroupId);
        return { groups, tree: active.tree };
      }),

    split: (dir, sessionId) => {
      const { tree, focusedLeafId } = get();
      if (!tree || !focusedLeafId) return null;
      get().pinEphemeral();
      const leaf = makeLeaf(sessionId);
      const edge: DockEdge = dir === "row" ? "right" : "bottom";
      commitActive({ tree: insertLeaf(tree, focusedLeafId, edge, leaf), focusedLeafId: leaf.id, zoomedLeafId: null });
      return leaf.id;
    },
    showDocumentPane: (content) => {
      // One document pane, reused. Clicking down a file tree used to leave a
      // pane per file, each narrower than the last, until nothing could be
      // read — the same reason VS Code and Orca replace the preview tab
      // instead of stacking one per click.
      const { tree } = get();
      const existing = tree
        ? leaves(tree).find((leaf) => leaf.content && isDocument(leaf.content))
        : undefined;
      if (!existing) return get().openContentPane(content);
      const swap = (node: PaneNode): PaneNode =>
        node.kind === "leaf"
          ? node.id === existing.id
            ? { ...node, content }
            : node
          : { ...node, children: node.children.map(swap) };
      commitActive({ tree: swap(tree!), focusedLeafId: existing.id, zoomedLeafId: null });
      return existing.id;
    },

    renamePane: (leafId, name) => {
      const { tree } = get();
      if (!tree) return;
      const trimmed = name.trim();
      const rename = (node: PaneNode): PaneNode => {
        if (node.kind !== "leaf") return { ...node, children: node.children.map(rename) };
        if (node.id !== leafId || !node.content) return node;
        const content =
          node.content.kind === "terminal"
            ? { ...node.content, name: trimmed || undefined }
            : node.content;
        return { ...node, content };
      };
      commitActive({ tree: rename(tree) });
    },

    openContentPane: (content, dir = "row") => {
      get().pinEphemeral();
      const leaf = makeContentLeaf(content);
      const { tree, focusedLeafId } = get();
      // An empty Screen is filled rather than split: there is nothing to sit
      // beside, and a 50/50 split against nothing is not a layout.
      if (!tree || !focusedLeafId) {
        commitActive({ tree: leaf, focusedLeafId: leaf.id, zoomedLeafId: null });
        return leaf.id;
      }
      const edge: DockEdge = dir === "row" ? "right" : "bottom";
      commitActive({
        tree: insertLeaf(tree, focusedLeafId, edge, leaf),
        focusedLeafId: leaf.id,
        zoomedLeafId: null,
      });
      return leaf.id;
    },
    dockSession: (targetLeafId, edge, sessionId) => {
      get().pinEphemeral();
      const { tree } = get();
      const leaf = makeLeaf(sessionId);
      // No target (empty group) → the dragged session fills the group.
      if (!tree) {
        commitActive({ tree: leaf, focusedLeafId: leaf.id, zoomedLeafId: null });
        return leaf.id;
      }
      // Target vanished between the last hover and the drop (e.g. a prune fired
      // mid-drag): insertLeaf would no-op but we'd still focus a phantom leaf.
      if (!findLeaf(tree, targetLeafId)) return get().focusedLeafId ?? leaf.id;
      commitActive({ tree: insertLeaf(tree, targetLeafId, edge, leaf), focusedLeafId: leaf.id, zoomedLeafId: null });
      return leaf.id;
    },
    presentArtifact: (sessionId, artifact, placement, destination = "current-screen") => {
      get().pinEphemeral();
      if (destination !== "current-screen") {
        // A new Screen keeps a conversation beside the artifact, so the user
        // can discuss what they are looking at without switching away. For a
        // dedicated-session request, `sessionId` is the fresh host-created
        // session supplied by the runtime event handler.
        const conversation = makeLeaf(sessionId);
        const presented = makeArtifactLeaf(sessionId, artifact);
        const edge: DockEdge = placement === "bottom" ? "bottom" : "right";
        const tree = insertLeaf(conversation, conversation.id, edge, presented);
        // The Screen joins the project the conversation is shown in.
        const home = get().groups.find(
          (g) => g.tree && leaves(g.tree).some((l) => l.sessionId === sessionId && !l.artifact),
        );
        const group: LayoutGroup = {
          id: genGroupId(),
          name: artifact.presentation?.title ?? artifact.filename,
          projectId: home ? projectOf(home) : selectActiveProjectId(get()),
          tree,
          focusedLeafId: presented.id,
          zoomedLeafId: null,
        };
        set((s) => {
          const groups = [...s.groups, group];
          persist(groups, group.id);
          return {
            groups,
            activeGroupId: group.id,
            tree,
            focusedLeafId: presented.id,
            zoomedLeafId: null,
            ephemeralGroupId: null,
          };
        });
        return presented.id;
      }
      const { tree, focusedLeafId } = get();
      if (!tree) return null;
      // Anchor to the conversation that invoked the tool. A background event
      // that is not represented in this screen falls back to the focused pane,
      // keeping the request visible without inventing a new Screen.
      const owner =
        leaves(tree).find((leaf) => leaf.sessionId === sessionId && !leaf.artifact) ??
        (focusedLeafId ? findLeaf(tree, focusedLeafId) : null) ??
        leaves(tree)[0];
      if (!owner) return null;
      const edge: DockEdge = placement === "bottom" ? "bottom" : "right";
      const existing = leaves(tree).find(
        (leaf) => leaf.sessionId === sessionId && leaf.artifact?.path === artifact.path,
      );
      if (existing) {
        // A repeat call for the same file refreshes the open panel in place —
        // unless it explicitly asks for a side the panel is not on, which is a
        // request to move it there.
        const stays =
          !placement || existing.id === owner.id || isDockedOn(tree, owner.id, existing.id, edge);
        if (stays) {
          const replace = (node: PaneNode): PaneNode =>
            node.kind === "leaf"
              ? node.id === existing.id
                ? { ...node, artifact }
                : node
              : { ...node, children: node.children.map(replace) };
          commitActive({
            tree: replace(tree),
            focusedLeafId: existing.id,
            zoomedLeafId: null,
          });
          return existing.id;
        }
        const removed = removeLeaf(tree, existing.id);
        const withoutPanel = removed ? removed.tree : tree;
        const moved = makeArtifactLeaf(sessionId, artifact);
        commitActive({
          tree: insertLeaf(withoutPanel, owner.id, edge, moved),
          focusedLeafId: moved.id,
          zoomedLeafId: null,
        });
        return moved.id;
      }
      const leaf = makeArtifactLeaf(sessionId, artifact);
      commitActive({
        tree: insertLeaf(tree, owner.id, edge, leaf),
        focusedLeafId: leaf.id,
        zoomedLeafId: null,
      });
      return leaf.id;
    },
    moveLeaf: (leafId, targetLeafId, edge) => {
      if (leafId === targetLeafId) return;
      const { tree, focusedLeafId } = get();
      if (!tree) return;
      const moved = findLeaf(tree, leafId);
      if (!moved || !findLeaf(tree, targetLeafId)) return;
      get().pinEphemeral();
      // Remove the original FIRST, then re-insert that same leaf at the
      // destination — the id has to survive the move.
      //
      // It used to insert a copy with a fresh id and then remove the original,
      // which sidestepped having one id twice in one tree mid-operation. But a
      // leaf id is an identity, not a coordinate: the shell, the parked xterm
      // and the pane's unsent draft are all keyed by it, so re-docking a
      // terminal killed its shell and rebuilt an empty one.
      const without = removeLeaf(tree, leafId);
      if (!without || !findLeaf(without.tree, targetLeafId)) return;
      const nextTree = insertLeaf(without.tree, targetLeafId, edge, moved);
      const nextFocus = focusedLeafId === leafId ? leafId : focusedLeafId;
      commitActive({
        tree: nextTree,
        focusedLeafId: nextFocus && findLeaf(nextTree, nextFocus) ? nextFocus : leafId,
        zoomedLeafId: null,
      });
    },
    moveLeafToActiveGroup: (leafId, targetLeafId, edge) => {
      get().pinEphemeral();
      set((s) => {
        // Find the leaf's SOURCE group (may be any group but the active one).
        const source = s.groups.find((g) => g.tree && findLeaf(g.tree, leafId));
        if (!source) return {};
        const moved = source.tree ? findLeaf(source.tree, leafId) : null;
        if (!moved) return {};
        const active = s.groups.find((g) => g.id === s.activeGroupId)!;
        // Same-group drops go through moveLeaf, not here.
        if (source.id === active.id) return {};
        // The same leaf, keeping its id: it is about to leave the source tree,
        // so there is no collision to avoid, and the id is what the shell, the
        // parked xterm and the pane's draft are keyed by. Cloning it here is
        // what destroyed a terminal dragged to another Screen.
        const clone = moved;
        // Dock it into the active group: fill an empty group, else insert
        // beside the target leaf (bail if the target vanished mid-drag).
        let activeTree: PaneNode;
        if (!active.tree) activeTree = clone;
        else if (findLeaf(active.tree, targetLeafId)) activeTree = insertLeaf(active.tree, targetLeafId, edge, clone);
        else return {};
        // Remove the leaf from its source group (which may go empty → onboarding).
        const removed = source.tree ? removeLeaf(source.tree, leafId) : null;
        const sourceTree = removed ? removed.tree : null;
        const sourceFocus = removed ? removed.nextFocusId : null;
        const groups = s.groups.map((g) => {
          if (g.id === active.id)
            return { ...g, tree: activeTree, focusedLeafId: clone.id, zoomedLeafId: null };
          if (g.id === source.id)
            return {
              ...g,
              tree: sourceTree,
              focusedLeafId: sourceFocus,
              zoomedLeafId: g.zoomedLeafId && sourceTree && findLeaf(sourceTree, g.zoomedLeafId) ? g.zoomedLeafId : null,
            };
          return g;
        });
        persist(groups, s.activeGroupId);
        return { groups, tree: activeTree, focusedLeafId: clone.id, zoomedLeafId: null };
      });
    },
    closeFocused: () => {
      const f = get().focusedLeafId;
      if (f) get().closePane(f);
    },
    closePane: (leafId) => {
      const { tree, focusedLeafId } = get();
      if (!tree) return;
      // Closing the last pane empties the group (shows onboarding) rather than
      // being disallowed — a group is allowed to be empty.
      if (leaves(tree).length <= 1) {
        commitActive({ tree: null, focusedLeafId: null, zoomedLeafId: null });
        return;
      }
      const res = removeLeaf(tree, leafId);
      if (!res) return;
      const nextFocus = leafId === focusedLeafId ? res.nextFocusId : focusedLeafId;
      commitActive({ tree: res.tree, focusedLeafId: nextFocus, zoomedLeafId: null });
    },
    replacePane: (leafId, next) => {
      const leaf = "content" in next ? makeContentLeaf(next.content) : makeLeaf(next.sessionId);
      const swap = (node: PaneNode): PaneNode =>
        node.kind === "leaf"
          ? node.id === leafId
            ? leaf
            : node
          : { ...node, children: node.children.map(swap) };
      commitLeafGroup(leafId, (g) => ({
        tree: swap(g.tree!),
        focusedLeafId: leaf.id,
        zoomedLeafId: g.zoomedLeafId === leafId ? null : g.zoomedLeafId,
      }));
    },
    focusLeaf: (leafId) => {
      const { tree } = get();
      if (!tree || !findLeaf(tree, leafId)) return;
      commitActive({ focusedLeafId: leafId });
    },
    focusAdjacent: (dir) => {
      const { tree, focusedLeafId } = get();
      if (!tree || !focusedLeafId) return;
      get().focusLeaf(adjacentLeafId(tree, focusedLeafId, dir));
    },
    setSplitSizes: (splitId, sizes) => {
      const { tree } = get();
      if (!tree) return;
      commitActive({ tree: setSplitSizes(tree, splitId, sizes) });
    },
    bindSession: (leafId, sessionId) =>
      commitLeafGroup(leafId, (g) => ({ tree: setLeafSession(g.tree!, leafId, sessionId) })),
    setLeafZoom: (leafId, zoom) => {
      const { tree } = get();
      if (!tree) return;
      const rec = (n: PaneNode): PaneNode =>
        n.kind === "leaf"
          ? n.id === leafId
            ? { ...n, zoom }
            : n
          : { ...n, children: n.children.map(rec) };
      commitActive({ tree: rec(tree) });
    },
    toggleZoom: (leafId) => {
      const target = leafId ?? get().focusedLeafId;
      if (!target) return;
      commitActive({ zoomedLeafId: get().zoomedLeafId === target ? null : target });
    },
    reset: (sessionId) => {
      const r = makeLeaf(sessionId);
      commitActive({ tree: r, focusedLeafId: r.id, zoomedLeafId: null });
    },
    pruneSessions: (gone) =>
      // Prune EVERY group, not just the active one — a deleted session must not
      // linger in a background group's pane. A still-valid zoomed/focused leaf
      // is preserved; only removed leaves reset those.
      set((s) => {
        const live = (l: { sessionId: string | null }) => l.sessionId === null || !gone.has(l.sessionId);
        let changed = false;
        const groups = s.groups.map((g) => {
          if (!g.tree) return g;
          const ls = leaves(g.tree);
          if (ls.every(live)) return g;
          changed = true;
          if (!ls.some(live)) return { ...g, tree: null, focusedLeafId: null, zoomedLeafId: null };
          let next: PaneNode | null = g.tree;
          for (const l of ls) {
            if (!live(l) && next) {
              const res = removeLeaf(next, l.id);
              if (res) next = res.tree;
            }
          }
          if (!next) return { ...g, tree: null, focusedLeafId: null, zoomedLeafId: null };
          const focusedLeafId =
            g.focusedLeafId && findLeaf(next, g.focusedLeafId) ? g.focusedLeafId : leaves(next)[0].id;
          const zoomedLeafId = g.zoomedLeafId && findLeaf(next, g.zoomedLeafId) ? g.zoomedLeafId : null;
          return { ...g, tree: next, focusedLeafId, zoomedLeafId };
        });
        if (!changed) return {};
        const active = groups.find((g) => g.id === s.activeGroupId)!;
        persist(groups, s.activeGroupId);
        return { groups, tree: active.tree, focusedLeafId: active.focusedLeafId, zoomedLeafId: active.zoomedLeafId };
      }),
  };
});

/** Display label for a group tab: its name, or an index-based default. */
export function groupLabel(
  group: LayoutGroup,
  index: number,
  fallback: (n: number) => string,
  describe?: (content: PaneContent) => string | null,
  sessionTitle?: (sessionId: string) => string | null,
  draftName?: string,
  homeName?: string,
): string {
  // An empty Screen shows its project's home (EmptyGroup), and says so —
  // whatever it was once named: that name was for what it held. (A Screen
  // saved before closing cleared names could still carry one.)
  if (homeName && !group.tree) return homeName;
  const named = group.name.trim();
  if (named) return named;
  // A Screen holding only a new conversation is that new conversation — the
  // same name its row has in the sidebar, not "Screen 4".
  if (draftName && draftLeafOf(group)) return draftName;
  // Otherwise the Screen says what its first pane holds: "Terminal", a file's
  // name, or the conversation's title once it has one — not "Screen 4". The
  // label is derived rather than stored, so it follows the pane: a document
  // pane swapping files, or a session getting its title, renames the Screen.
  const first = group.tree ? leaves(group.tree).find((l) => l.content || l.sessionId) : undefined;
  const derived = first?.content
    ? describe?.(first.content)
    : first?.sessionId
      ? sessionTitle?.(first.sessionId)
      : null;
  return derived || fallback(index + 1);
}

// Remember, per project, the Screen on display — see LAST_SCREEN_KEY.
useLayoutStore.subscribe((s) => {
  const project = selectActiveProjectId(s);
  if (lastScreenByProject[project] === s.activeGroupId) return;
  lastScreenByProject[project] = s.activeGroupId;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_SCREEN_KEY, JSON.stringify(lastScreenByProject));
  } catch {
    /* storage full/unavailable: switching projects falls back to the first Screen */
  }
});
