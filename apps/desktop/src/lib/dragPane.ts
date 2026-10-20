import { create } from "zustand";
import { leaves, useLayoutStore, type DockEdge } from "@/lib/layout";
import { useRuntimeStore } from "@/lib/runtime";
import { samePath } from "@/lib/workspacePath";

/**
 * Pointer-based drag-to-dock for split panes. Kept OUT of the layout store so
 * the per-move churn (pointer position, hovered edge) never re-renders the pane
 * tree — only the ghost and the hovered leaf's drop overlay subscribe here.
 *
 * Two sources: a session row in the sidebar, or an existing pane (its header).
 * On drop, the pointer's quadrant over the target leaf picks an edge; the layout
 * store docks/moves there and re-equalizes siblings. A sidebar session dropped
 * on a project in the sidebar is filed into that project instead.
 *
 * Pointer events (window-level listeners), NOT HTML5 DnD — the app's native OS
 * drag-drop handler swallows DOM drops and the codebase standardizes on pointer
 * dragging (see useDragDivider, Composer file-drop).
 */
export type DragSource =
  | { kind: "session"; sessionId: string }
  | { kind: "pane"; leafId: string; sessionId: string | null };

/** Where the pointer is hovering: a leaf's edge, an empty group's fill zone,
 *  a screen tab (a switch hint — dwelling there flips to that screen, #4), or a
 *  sidebar project the dragged session would move into. */
export type DragTarget =
  | { leafId: string; edge: DockEdge }
  | { empty: true }
  | { groupTab: string }
  | { projectId: string; name: string };

interface DragPaneState {
  active: null | {
    source: DragSource;
    title: string;
    x: number;
    y: number;
    target: DragTarget | null;
  };
  begin: (source: DragSource, title: string, x: number, y: number) => void;
  update: (x: number, y: number, target: DragTarget | null) => void;
  clear: () => void;
}

export const useDragPane = create<DragPaneState>((set) => ({
  active: null,
  begin: (source, title, x, y) => set({ active: { source, title, x, y, target: null } }),
  update: (x, y, target) => set((s) => (s.active ? { active: { ...s.active, x, y, target } } : {})),
  clear: () => set({ active: null }),
}));

/** Which edge of `rect` the point is nearest (4 triangular quadrants meeting at
 *  the center) → left/right = side-by-side, top/bottom = stacked. */
export function edgeOf(rect: DOMRect, x: number, y: number): DockEdge {
  const dx = (x - (rect.left + rect.width / 2)) / (rect.width / 2);
  const dy = (y - (rect.top + rect.height / 2)) / (rect.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

/** Resolve the drop target under the pointer: a leaf's edge, or the empty-group
 *  fill zone, or a project for a sidebar session, or nothing. A project the
 *  session already lives in is no target — dropping there would do nothing. */
function hitTest(x: number, y: number, source: DragSource): DragTarget | null {
  const under = document.elementFromPoint(x, y);
  const projectEl = under?.closest<HTMLElement>("[data-drop-project]");
  if (projectEl) {
    if (source.kind !== "session") return null;
    const { projects, sessions } = useRuntimeStore.getState();
    const project = projects.find((p) => p.id === projectEl.dataset.dropProject);
    const dir = sessions.find((s) => s.id === source.sessionId)?.directory;
    if (!project || samePath(project.path, dir)) return null;
    return { projectId: project.id, name: project.name };
  }
  const leafEl = under?.closest<HTMLElement>("[data-leaf-id]");
  if (leafEl?.dataset.leafId) {
    return { leafId: leafEl.dataset.leafId, edge: edgeOf(leafEl.getBoundingClientRect(), x, y) };
  }
  const tabEl = under?.closest<HTMLElement>("[data-group-tab]");
  if (tabEl?.dataset.groupTab) return { groupTab: tabEl.dataset.groupTab };
  if (under?.closest("[data-empty-group]")) return { empty: true };
  return null;
}

const DRAG_THRESHOLD_PX = 5;
/** Dwell over a screen tab before switching to it — long enough that a drag
 *  merely passing over a tab doesn't thrash screens. */
const GROUP_SWITCH_DWELL_MS = 400;

/** Swallow the ONE click that a drag-source which is also a click target (a
 *  sidebar NavLink) fires right after the drag, so it doesn't also navigate.
 *  Capture-phase + one-shot, tied to the gesture — not a global time window. */
function suppressNextClick(): void {
  const onClick = (ev: MouseEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
    window.removeEventListener("click", onClick, true);
  };
  window.addEventListener("click", onClick, true);
  // Safety net: if no click follows (dropped on a non-clickable), don't leave
  // the listener armed for a later unrelated click.
  window.setTimeout(() => window.removeEventListener("click", onClick, true), 400);
}

/**
 * Arm a pane drag from a pointer-down on a source element. A real drag only
 * begins once the pointer moves past a small threshold, so a plain click on the
 * source still behaves normally. Window-level listeners let the drag cross from
 * the sidebar into the pane area; pointercancel/blur tear it down so a
 * cancelled gesture can't leave the ghost, drop overlays, or body cursor stuck.
 */
export function startPaneDrag(
  e: { button: number; clientX: number; clientY: number },
  source: DragSource,
  title: string,
): void {
  if (e.button !== 0) return;
  const startX = e.clientX;
  const startY = e.clientY;
  let started = false;
  // Screen-switch dwell: which tab the pointer is resting on and its pending
  // timer, so hovering a screen tab ~400ms flips to that screen (#4).
  let dwellTab: string | null = null;
  let dwellTimer: number | undefined;
  const clearDwell = () => {
    if (dwellTimer !== undefined) window.clearTimeout(dwellTimer);
    dwellTimer = undefined;
    dwellTab = null;
  };
  // Suppress text selection from the very first move — otherwise dragging a
  // pane header sweeps a selection across the conversation below it. Restored
  // unconditionally in teardown (a plain click restores it immediately).
  document.body.style.userSelect = "none";

  const teardown = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("blur", onCancel);
    clearDwell();
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    document.documentElement.classList.remove("pane-dragging");
  };
  const onMove = (ev: PointerEvent) => {
    if (!started) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD_PX) return;
      started = true;
      document.body.style.cursor = "grabbing";
      // Force-suppress selection everywhere (message text overrides body-level
      // user-select) and clear anything already selected under the pointer.
      document.documentElement.classList.add("pane-dragging");
      useDragPane.getState().begin(source, title, ev.clientX, ev.clientY);
    }
    window.getSelection()?.removeAllRanges();
    const target = hitTest(ev.clientX, ev.clientY, source);
    // Over a screen tab: after a short dwell, switch to that screen so its panes
    // become drop targets below. Leaving the tab (or moving to another) resets.
    if (target && "groupTab" in target) {
      if (target.groupTab !== dwellTab) {
        clearDwell();
        dwellTab = target.groupTab;
        if (target.groupTab !== useLayoutStore.getState().activeGroupId) {
          const gid = target.groupTab;
          dwellTimer = window.setTimeout(() => {
            useLayoutStore.getState().setActiveGroup(gid);
            clearDwell();
          }, GROUP_SWITCH_DWELL_MS);
        }
      }
    } else {
      clearDwell();
    }
    useDragPane.getState().update(ev.clientX, ev.clientY, target);
  };
  const onUp = () => {
    teardown();
    if (!started) return;
    suppressNextClick();
    commitPaneDrag();
  };
  // Pointer cancelled / window blurred mid-drag: abandon without committing.
  const onCancel = () => {
    teardown();
    if (started) useDragPane.getState().clear();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("blur", onCancel);
}

/** Apply the pending drop: dock a sidebar session (or move an existing pane) to
 *  the hovered edge. A session already shown in a pane is MOVED, not duplicated. */
function commitPaneDrag(): void {
  const drag = useDragPane.getState();
  const active = drag.active;
  drag.clear();
  if (!active?.target) return;
  const layout = useLayoutStore.getState();
  const src = active.source;
  const target = active.target;

  // Released over a screen tab (not a pane): the dwell already switched screens,
  // and there's no pane to dock against — the user should drop onto a pane.
  if ("groupTab" in target) return;

  // Released over a sidebar project: file the session there, the same move as
  // its "Add to project" menu.
  if ("projectId" in target) {
    if (src.kind !== "session") return;
    const runtime = useRuntimeStore.getState();
    const project = runtime.projects.find((p) => p.id === target.projectId);
    if (project) void runtime.moveSessionToProject(src.sessionId, project.id);
    return;
  }

  // Drop onto an empty group's onboarding zone → fill that (active) group.
  if ("empty" in target) {
    if (src.kind === "session") layout.dockSession("", "right", src.sessionId);
    // A pane dragged into another (now-active) empty screen moves there.
    else layout.moveLeafToActiveGroup(src.leafId, "", "right");
    return;
  }
  const { leafId: targetLeafId, edge } = target;

  if (src.kind === "pane") {
    if (src.leafId === targetLeafId) return;
    // Same-screen re-dock vs. a cross-screen move: if the source leaf still
    // lives in the ACTIVE group it's a plain move; otherwise a screen switch
    // happened mid-drag and it must be relocated out of its origin group (#4).
    const inActive = layout.tree ? leaves(layout.tree).some((l) => l.id === src.leafId) : false;
    if (inActive) layout.moveLeaf(src.leafId, targetLeafId, edge);
    else layout.moveLeafToActiveGroup(src.leafId, targetLeafId, edge);
    return;
  }
  // Sidebar session: reuse its existing pane if already tiled in THIS screen
  // (no duplicate within a group); otherwise dock a new pane for it.
  const tree = layout.tree;
  const existing = tree ? leaves(tree).find((l) => l.sessionId === src.sessionId) : undefined;
  if (existing) {
    if (existing.id === targetLeafId) return;
    layout.moveLeaf(existing.id, targetLeafId, edge);
  } else {
    layout.dockSession(targetLeafId, edge, src.sessionId);
  }
}
