import { create } from "zustand";
import type { ArtifactBlock } from "@ai4s/shared";
import type { ArtifactPanelPlacement, ArtifactPanelTarget } from "./artifacts";

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

export interface PaneLeaf {
  kind: "leaf";
  id: string;
  /** The bound session, or null for the (at most one) draft pane. */
  sessionId: string | null;
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

function makeArtifactLeaf(sessionId: string, artifact: ArtifactBlock): PaneLeaf {
  return { kind: "leaf", id: genId(), sessionId, artifact };
}

function cloneLeaf(leaf: PaneLeaf): PaneLeaf {
  return {
    ...makeLeaf(leaf.sessionId),
    ...(leaf.zoom !== undefined ? { zoom: leaf.zoom } : {}),
    ...(leaf.artifact ? { artifact: leaf.artifact } : {}),
  };
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
 */
export interface LayoutGroup {
  id: string;
  /** User label; "" means show the index-based default ("Screen N"). */
  name: string;
  tree: PaneNode | null;
  focusedLeafId: string | null;
  zoomedLeafId: string | null;
}

let groupSeq = 0;
const genGroupId = (): string => `g${++groupSeq}`;

// ---- Persistence ----
// The full layout (groups, trees, per-leaf session/sizes/zoom, active group) is
// saved to localStorage so a relaunch restores the workspace. Sessions deleted
// between runs are reconciled by `pruneSessions` once the session list loads.
const LAYOUT_KEY = "ai4s.layout.v2";

function isNode(v: unknown): v is PaneNode {
  if (!v || typeof v !== "object") return false;
  const n = v as Record<string, unknown>;
  if (n.kind === "leaf") {
    if (typeof n.id !== "string") return false;
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

interface Persisted {
  groups: LayoutGroup[];
  activeGroupId: string;
}

function loadPersisted(): Persisted | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAYOUT_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Persisted;
    if (!Array.isArray(p.groups) || p.groups.length === 0) return null;
    if (typeof p.activeGroupId !== "string") return null;
    for (const g of p.groups) {
      if (typeof g.id !== "string" || typeof g.name !== "string") return null;
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

function persist(groups: LayoutGroup[], activeGroupId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAYOUT_KEY, JSON.stringify({ groups, activeGroupId }));
  } catch {
    /* storage full/unavailable never blocks layout changes */
  }
}

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
   *  entry (#3). */
  openSessionEphemeral: (sessionId: string) => void;
  /** Pin the tentative screen (clear `ephemeralGroupId`) — called by any real
   *  interaction with it. No-op when there is none. */
  pinEphemeral: () => void;
  /** Add a new empty group and activate it; returns its id. */
  addGroup: () => string;
  /** Open ONE new pane in its own Screen — bound to `sessionId`, or a draft when
   *  null — activate and focus it, optionally naming the Screen. Every "new
   *  session" entry point goes through this: binding the new work onto the
   *  focused pane took over whatever conversation the user had there. An empty
   *  active Screen is filled instead of stacking a second empty one beside it.
   *  Returns the new leaf's id. */
  openInNewGroup: (sessionId: string | null, name?: string) => string;
  /** Close a group; never drops below one (the last group is emptied instead). */
  closeGroup: (groupId: string) => void;
  renameGroup: (groupId: string, name: string) => void;
  setActiveGroup: (groupId: string) => void;
  /** Split the focused leaf toward `dir` (row → new pane on the right, col →
   *  below), binding `sessionId` to it (or a draft when null) and focusing it. */
  split: (dir: SplitDir, sessionId: string | null) => void;
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
  /** Drop leaves whose session vanished (deleted / not in `valid`), collapsing
   *  toward a single pane. A null-session (draft) leaf is always kept. */
  pruneSessions: (valid: Set<string>) => void;
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

  return {
    groups: initGroups,
    activeGroupId: initActiveId,
    tree: initActive.tree,
    focusedLeafId: initActive.focusedLeafId,
    zoomedLeafId: null,
    ephemeralGroupId: null,

    openSessionEphemeral: (sessionId) =>
      set((s) => {
        const reusable =
          s.ephemeralGroupId && s.groups.some((g) => g.id === s.ephemeralGroupId)
            ? s.ephemeralGroupId
            : null;
        const leaf = makeLeaf(sessionId);
        if (reusable) {
          // Reuse the tentative screen: swap its single pane's session, stay
          // tentative. This is the ONE path that keeps ephemeralGroupId.
          const groups = s.groups.map((g) =>
            g.id === reusable ? { ...g, tree: leaf, focusedLeafId: leaf.id, zoomedLeafId: null } : g,
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
        const g: LayoutGroup = { id: genGroupId(), name: "", tree: leaf, focusedLeafId: leaf.id, zoomedLeafId: null };
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

    addGroup: () => {
      const g: LayoutGroup = { id: genGroupId(), name: "", tree: null, focusedLeafId: null, zoomedLeafId: null };
      set((s) => ({
        groups: [...s.groups, g],
        activeGroupId: g.id,
        tree: null,
        focusedLeafId: null,
        zoomedLeafId: null,
        // Leaving the tentative screen for an explicit new one pins it.
        ephemeralGroupId: null,
      }));
      persist(get().groups, get().activeGroupId);
      return g.id;
    },

    openInNewGroup: (sessionId, name) => {
      const leaf = makeLeaf(sessionId);
      set((s) => {
        const active = { tree: leaf, focusedLeafId: leaf.id, zoomedLeafId: null };
        // An empty active Screen (onboarding, or every pane closed) is where the
        // new pane belongs — a second empty Screen beside it would be noise.
        const groups = s.tree
          ? [...s.groups, { id: genGroupId(), name: name ?? "", ...active }]
          : s.groups.map((g) => (g.id === s.activeGroupId ? { ...g, ...(name ? { name } : {}), ...active } : g));
        const activeGroupId = s.tree ? groups[groups.length - 1].id : s.activeGroupId;
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
        if (s.groups.length <= 1) {
          // Never zero groups — empty the sole group instead of removing it.
          const only: LayoutGroup = { ...s.groups[0], tree: null, focusedLeafId: null, zoomedLeafId: null };
          return { groups: [only], activeGroupId: only.id, tree: null, focusedLeafId: null, zoomedLeafId: null, ephemeralGroupId };
        }
        const idx = s.groups.findIndex((g) => g.id === groupId);
        if (idx < 0) return {};
        const groups = s.groups.filter((g) => g.id !== groupId);
        // If the active group closed, activate its neighbor.
        const active =
          s.activeGroupId === groupId ? groups[Math.min(idx, groups.length - 1)] : groups.find((g) => g.id === s.activeGroupId)!;
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
      set((s) => ({ groups: s.groups.map((g) => (g.id === groupId ? { ...g, name } : g)) }));
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

    split: (dir, sessionId) => {
      const { tree, focusedLeafId } = get();
      if (!tree || !focusedLeafId) return;
      get().pinEphemeral();
      const leaf = makeLeaf(sessionId);
      const edge: DockEdge = dir === "row" ? "right" : "bottom";
      commitActive({ tree: insertLeaf(tree, focusedLeafId, edge, leaf), focusedLeafId: leaf.id, zoomedLeafId: null });
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
        const group: LayoutGroup = {
          id: genGroupId(),
          name: artifact.presentation?.title ?? artifact.filename,
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
      // Insert a copy at the destination, then remove the original. A fresh id
      // keeps the two operations from colliding on one id mid-tree.
      const clone = cloneLeaf(moved);
      const inserted = insertLeaf(tree, targetLeafId, edge, clone);
      const removed = removeLeaf(inserted, leafId);
      const nextTree = removed ? removed.tree : inserted;
      const nextFocus = focusedLeafId === leafId ? clone.id : focusedLeafId;
      commitActive({
        tree: nextTree,
        focusedLeafId: nextFocus && findLeaf(nextTree, nextFocus) ? nextFocus : clone.id,
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
        const clone = cloneLeaf(moved);
        // Dock the clone into the active group: fill an empty group, else insert
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
    bindSession: (leafId, sessionId) => {
      const { tree } = get();
      if (!tree) return;
      commitActive({ tree: setLeafSession(tree, leafId, sessionId) });
    },
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
    pruneSessions: (valid) =>
      // Prune EVERY group, not just the active one — a deleted session must not
      // linger in a background group's pane. A still-valid zoomed/focused leaf
      // is preserved; only removed leaves reset those.
      set((s) => {
        const live = (l: { sessionId: string | null }) => l.sessionId === null || valid.has(l.sessionId);
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
export function groupLabel(group: LayoutGroup, index: number, fallback: (n: number) => string): string {
  return group.name.trim() || fallback(index + 1);
}
