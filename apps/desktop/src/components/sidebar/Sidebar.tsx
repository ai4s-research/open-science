import { forwardRef, useEffect, useRef, useState, type HTMLAttributes, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import {
  Archive,
  Link2,
  FolderInput,
  FolderOpen,
  Pencil,
  Pin,
  Plus,
  Terminal as TerminalIcon,
  Trash2,
} from "lucide-react";
import {
  IconArchiveOutlineRegular,
  IconChevronLeftOutlineRegular,
  IconCloseFillRegular,
  IconEllipsisOutlineRegular,
  IconFlatListOutlineRegular,
  IconFolderCloseRegular,
  IconFolderOpenOutlineRegular,
  IconFolderOpenRegular,
  IconChecklistOutlineRegular,
  IconListPenOutlineRegular,
  IconNewChatOutlineMedium,
  IconNewChatOutlineRegular,
  IconPanelLeftOutlineRegular,
  IconPlayOutlineRegular,
  IconProjectAddOutlineRegular,
  IconSearchOutlineRegular,
  IconSettingsOutlineMedium,
  IconSkillOutlineRegular,
  IconTrashOutlineRegular,
  IconTriangleRightFillRegular,
} from "@/components/icons/dsh";
import { StateDot } from "@/components/icons/dsh/StateDot";
import css from "./Sidebar.module.css";
import { NewSessionPicker } from "./NewSessionPicker";
import { useTitleMarquee } from "./useTitleMarquee";
import { timeAgo } from "@/lib/relativeTime";
import type { Project } from "@ai4s/shared";
import { cn } from "@/lib/cn";
import { DRAFT_KEY, draftKeyFor, openDraftScreen, rootSessionOf, useRuntimeStore } from "@/lib/runtime";
import {
  openProjectFolder,
  pickFolder,
  renameProject,
  workspaceBase,
  type ProjectImportMode,
  type ProjectInfo,
} from "@/lib/tauri";
import {
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  useOverlayTitlebar,
  useUiStore,
} from "@/lib/store";
import { useUpdateStore } from "@/lib/update";
import { overlayTitlebarStyle } from "@/lib/titlebar";
import { copyReference, sessionReference } from "@/lib/agentReference";
import { visibleSections, resolveSection } from "@/components/settings/sections";
import { useIsMobile } from "@/lib/useIsMobile";
import { useDragDivider } from "@/lib/useDragDivider";
import { DEFAULT_PROJECT, draftLeafOf, leaves, projectOf, selectActiveProjectId, useLayoutStore } from "@/lib/layout";
import { terminalLabel } from "@/lib/jumpEntries";
import { startPaneDrag, useDragPane } from "@/lib/dragPane";
import { isGatewayWeb } from "@/lib/webMode";
import { pathKey, samePath } from "@/lib/workspacePath";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  ContextMenu,
  ContextMenuEmpty,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
} from "@/components/ui/ContextMenu";
import logo from "@/assets/logo.webp";

interface Row {
  id: string;
  title: string;
  to: string;
  kind: "session" | "example";
  /** The project this session belongs to, if any — shown on the row and
   *  matched by the search. */
  project?: string;
  /** That project's id — the project whose Screens a click opens it among. */
  projectId?: string;
  /** Last activity (ms), shown as the row's compact time. */
  updated?: number;
}

/** A new conversation nobody has sent anything in yet, shown as a row so the
 *  user sees where it went. `groupId` is its Screen (null in the single-pane
 *  web/phone layout, where the draft is simply the bare /live view);
 *  `projectId` is where its session will land, null for no project. */
interface DraftRow {
  key: string;
  groupId: string | null;
  projectId: string | null;
}

/** An open terminal, listed in the project its Screen belongs to (null for
 *  none), so it can be found and returned to like a conversation. */
interface TerminalRow {
  leafId: string;
  groupId: string;
  projectId: string | null;
  label: string;
}

/** Dragging the divider below this pointer x collapses the sidebar; dragging
 *  back past it re-expands. Sits below SIDEBAR_MIN so there is a clear "snap". */
const COLLAPSE_BELOW = 140;

/** Whether `path` is the same folder as `base`, or sits inside it. Compared as
 *  path SEGMENTS, so "/w/OpenScience-old" is not treated as inside "/w/OpenScience".
 *  Both sides are normalized for separator and trailing slash only — this is a
 *  UI shortcut; the runtime canonicalizes and decides for real. */
export function isInside(path: string, base: string): boolean {
  const parts = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  const b = parts(base);
  const p = parts(path);
  return b.length > 0 && b.length <= p.length && b.every((seg, i) => seg === p[i]);
}

/** Session rows shown per group in the rail. The runtime now hands the app its
 *  WHOLE history (it used to stop at 100 — #65), which would otherwise turn the
 *  sidebar into an endless list; the overflow is one click away on /history. */
const ROW_LIMIT = 12;

/** Projects the user folded shut (ids). Projects default to open — a
 *  researcher has a handful, and their sessions ARE the sidebar's content. */
const COLLAPSED_KEY = "ai4s.collapsedProjects";
function initialCollapsedProjects(): string[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function Sidebar({ project }: { project: Project }) {
  const { t } = useTranslation(["nav", "settings", "session"]);
  const navigate = useNavigate();
  const location = useLocation();
  // In settings the sidebar becomes the settings navigation: "Back to app" on
  // top, one row per section, and NO collapse affordance — a collapsed sidebar
  // would strand the user with no way back.
  const inSettings = location.pathname.startsWith("/settings");
  const isMobile = useIsMobile();
  // A phone shows one pane at a time — no Screens to place new work in.
  const singlePane = isMobile;
  const activeSection = resolveSection(location.pathname.split("/")[2]);
  // Select each field individually: a bare `useRuntimeStore()` subscribes to the
  // whole store, re-rendering the sidebar on every SSE fold during a session (#34).
  const sessions = useRuntimeStore((s) => s.sessions);
  const projects = useRuntimeStore((s) => s.projects);
  const workspace = useRuntimeStore((s) => s.workspace);
  const hiddenExamples = useRuntimeStore((s) => s.hiddenExamples);
  const startDraft = useRuntimeStore((s) => s.startDraft);
  const startDraftInWorkspace = useRuntimeStore((s) => s.startDraftInWorkspace);
  const createProject = useRuntimeStore((s) => s.createProject);
  const importProject = useRuntimeStore((s) => s.importProject);
  const refreshProjects = useRuntimeStore((s) => s.refreshProjects);
  const deleteSession = useRuntimeStore((s) => s.deleteSession);
  const renameSession = useRuntimeStore((s) => s.renameSession);
  const moveSessionToProject = useRuntimeStore((s) => s.moveSessionToProject);
  const setSessionArchived = useRuntimeStore((s) => s.setSessionArchived);
  const setProjectPinned = useRuntimeStore((s) => s.setProjectPinned);
  const deleteProject = useRuntimeStore((s) => s.deleteProject);
  const hideExample = useRuntimeStore((s) => s.hideExample);
  // Which sessions are working right now — so a background session (or its
  // subagent) shows it's busy without opening it. A running subagent surfaces
  // on the top-level session at the root of its parent chain.
  const runningSessions = useRuntimeStore((s) => s.runningSessions);
  const sessionParents = useRuntimeStore((s) => s.sessionParents);
  const webReadOnly = useRuntimeStore((s) => s.webReadOnly);
  const activeRoots = new Set(
    Object.keys(runningSessions).map((sid) => rootSessionOf(sessionParents, sid)),
  );
  const showUpdateBadge = useUpdateStore((s) => s.showBadge);
  const {
    sidebarCollapsed,
    sidebarWidth,
    setSidebarCollapsed,
    setSidebarWidth,
    toggleSidebar,
  } = useUiStore();
  // The sidebar starts at the window's left edge, so clientX is the width;
  // dragging left of COLLAPSE_BELOW snaps it collapsed but keeps the drag alive
  // (unless in Settings, which never collapses) so dragging back out re-opens it.
  // The rail's own elements, so a resize writes the width straight to them.
  // BOTH are needed: the outer column is what the layout reads, and the <aside>
  // inside it carries the sidebar's own surface. Widening only the outer one
  // left a bare strip of window showing beside the sidebar for the length of
  // the drag — the ugly gap that followed the pointer.
  const railRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLElement>(null);
  const { dragging, dragValue: dragWidth, handleProps } = useDragDivider({
    value: sidebarWidth,
    compute: ({ x }) => {
      if (x < COLLAPSE_BELOW && !inSettings) return null;
      return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, x));
    },
    // Nothing inside the sidebar depends on its width, so a drag has no reason
    // to re-render the session list — it only has to move one edge. React is
    // told once, on release.
    onDrag: (next) => {
      const px = `${next}px`;
      if (railRef.current) railRef.current.style.width = px;
      if (surfaceRef.current) surfaceRef.current.style.width = px;
    },
    onCommit: setSidebarWidth,
    onCollapse: () => {
      if (!sidebarCollapsed) setSidebarCollapsed(true);
    },
    onExpand: () => {
      if (sidebarCollapsed) setSidebarCollapsed(false);
    },
  });

  const startNew = () => {
    // Desktop: "New" is new work — it gets its own Screen with its own draft
    // pane, never the focused pane (which is a conversation in progress). It
    // belongs to no project (a project's own "+" is for that), so its Screen
    // opens under Default, where its session will land — not under whichever
    // project happened to be on display.
    if (!singlePane) openDraftScreen(DEFAULT_PROJECT);
    startDraft();
    navigate("/live");
  };

  // ---- Projects: sessions group under a project by workspace folder ----
  const [collapsedProjects, setCollapsedProjects] = useState<string[]>(
    initialCollapsedProjects,
  );
  // Web client: projects start collapsed (a phone shouldn't open with every
  // session expanded). Applied once, and only when the user has no saved
  // preference yet — a manual toggle then persists and wins on later visits.
  const didWebCollapse = useRef(false);
  useEffect(() => {
    if (didWebCollapse.current || !isGatewayWeb) return;
    if (typeof window !== "undefined" && window.localStorage.getItem(COLLAPSED_KEY)) {
      didWebCollapse.current = true;
      return;
    }
    if (projects.length === 0) return; // wait for the project list to load
    didWebCollapse.current = true;
    setCollapsedProjects(projects.map((p) => p.id));
  }, [projects]);
  const [namingProject, setNamingProject] = useState(false);
  // The New button asks where the conversation goes (NewSessionPicker); a
  // project created from there opens with that conversation in it.
  const [picking, setPicking] = useState(false);
  const [sessionAfterProject, setSessionAfterProject] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [pendingImportPath, setPendingImportPath] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingSession, setRenamingSession] = useState<string | null>(null);

  // Clicking a project shows its Screens. Clicking the project already shown
  // folds it open or shut, as the row always did.
  const activeProjectId = useLayoutStore(selectActiveProjectId);
  const clickProject = (id: string) => {
    if (isMobile || activeProjectId === id) {
      toggleProject(id);
      return;
    }
    useLayoutStore.getState().setActiveProject(id);
    if (collapsedProjects.includes(id)) toggleProject(id);
    if (!location.pathname.startsWith("/live")) navigate("/live");
  };

  const toggleProject = (id: string) =>
    setCollapsedProjects((prev) => {
      const next = prev.includes(id)
        ? prev.filter((x) => x !== id)
        : [...prev, id];
      if (typeof window !== "undefined")
        window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
      return next;
    });

  const submitNewProject = async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || createBusy) {
      setNamingProject(false);
      return;
    }
    setCreateBusy(true);
    const created = await createProject(trimmed);
    setCreateBusy(false);
    setNamingProject(false);
    const thenSession = sessionAfterProject;
    setSessionAfterProject(false);
    if (created && thenSession) await openProjectScreen(created);
    else if (created) navigate("/live");
  };

  // Entering a project — "new session in project X", or just having imported
  // one — is new work, so it follows the same rule as "New": its own Screen,
  // never the pane the user is reading. Open the Screen FIRST — the new pane's
  // own draft slot is what the composer sends under, and that is the slot the
  // project folder has to be aimed at (#69).
  const openProjectScreen = async (p: ProjectInfo) => {
    const leafId = singlePane ? null : openDraftScreen(p.id, p.path);
    // The new session's row appears in this project, so the project must be
    // open for the user to see it.
    if (collapsedProjects.includes(p.id)) toggleProject(p.id);
    await startDraftInWorkspace(p.path, leafId ? draftKeyFor(leafId) : undefined);
    navigate("/live");
  };

  // Pick first, then make the copy-vs-in-place tradeoff explicit. In-place is
  // primary: users choose their project location, and the signed macOS app asks
  // for access there. Copy remains an explicit storage/isolation alternative.
  const handleImport = async () => {
    if (importBusy) return;
    const path = await pickFolder();
    if (!path) return;
    // A folder that already lives in the workspace is ADOPTED in place — the
    // copy-vs-in-place question does not apply to it, and asking would promise
    // a copy the runtime is not going to make.
    const base = await workspaceBase();
    if (base && isInside(path, base)) {
      setImportBusy(true);
      const adopted = await importProject(path, "in-place");
      setImportBusy(false);
      if (adopted) await openProjectScreen(adopted);
      return;
    }
    setPendingImportPath(path);
  };

  const submitImport = async (mode: ProjectImportMode) => {
    if (importBusy || !pendingImportPath) return;
    setImportBusy(true);
    const imported = await importProject(pendingImportPath, mode);
    setImportBusy(false);
    setPendingImportPath(null);
    if (imported) await openProjectScreen(imported);
  };


  const submitRename = async (p: ProjectInfo, name: string) => {
    setRenamingId(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed === p.name) return;
    try {
      await renameProject(p.id, trimmed);
      await refreshProjects();
    } catch {
      /* the sidebar keeps showing the old name */
    }
  };

  // Subagent child sessions are internals of their parent conversation —
  // their asks and progress surface there, so they get no row of their own.
  const topSessions = sessions.filter((s) => !s.parentId);
  // A session being moved shows in the project it is going to from the moment
  // it is dropped — the move takes seconds, and a row that stayed put read as
  // a drop that did nothing.
  const movingSessions = useRuntimeStore((s) => s.movingSessions);
  // Keyed by comparison key, not the raw string: a project's path comes from Rust
  // and a session's `directory` from the sidecar, and on Windows those spell the
  // same folder differently (#76).
  const projectByPath = new Map(projects.map((p) => [pathKey(p.path), p]));
  const sessionsByProject = new Map<string, Row[]>(
    projects.map((p) => [p.id, []]),
  );
  const looseRows: Row[] = [];
  for (const s of topSessions) {
    const row: Row = {
      id: s.id,
      title: s.title,
      to: `/live/${s.id}`,
      kind: "session",
      updated: s.updated ?? s.created,
    };
    const movingTo = movingSessions[s.id];
    const owner = movingTo
      ? projects.find((p) => p.id === movingTo)
      : s.directory
        ? projectByPath.get(pathKey(s.directory))
        : undefined;
    if (owner) {
      row.project = owner.name;
      row.projectId = owner.id;
      sessionsByProject.get(owner.id)!.push(row);
    } else looseRows.push(row);
  }
  // Recency per project = its newest session's update time (else its creation).
  const updatedByProject = new Map<string, number>();
  for (const s of topSessions) {
    if (!s.directory || s.updated == null) continue;
    const owner = projectByPath.get(pathKey(s.directory));
    if (owner)
      updatedByProject.set(owner.id, Math.max(updatedByProject.get(owner.id) ?? 0, s.updated));
  }
  const recencyOf = (p: ProjectInfo) => updatedByProject.get(p.id) ?? p.createdAt;

  // New conversations: a row the moment one is started, at the top of where
  // its session will land — the project it is aimed at, else no project.
  // Without it a new session showed up only as a Screen tab, and the sidebar
  // looked as if nothing had happened.
  const draftScreens = useLayoutStore(useShallow((s) => s.groups.filter((g) => draftLeafOf(g))));
  const activeGroupId = useLayoutStore((s) => s.activeGroupId);
  const currentId = useRuntimeStore((s) => s.currentId);
  const draftWorkspaces = useRuntimeStore((s) => s.draftWorkspaces);
  const projectOfFolder = (path: string | undefined) =>
    path ? (projectByPath.get(pathKey(path))?.id ?? null) : null;
  const draftRows: DraftRow[] = [];
  if (singlePane) {
    if (location.pathname === "/live" && !currentId)
      draftRows.push({ key: DRAFT_KEY, groupId: null, projectId: projectOfFolder(draftWorkspaces[DRAFT_KEY]) });
  } else {
    for (const g of draftScreens) {
      // The focused draft follows `currentId` once its first send has created
      // the session (see SessionView): that session's own row takes over.
      if (g.id === activeGroupId && currentId) continue;
      const key = draftKeyFor(draftLeafOf(g)!.id);
      const aim = draftWorkspaces[key];
      // Not aimed yet (the folder is set a moment after the Screen opens): the
      // Screen's project is where it is going.
      const owner = aim ? projectOfFolder(aim) : projectOf(g);
      draftRows.push({ key, groupId: g.id, projectId: owner && sessionsByProject.has(owner) ? owner : null });
    }
  }
  const draftsIn = (projectId: string | null) => draftRows.filter((d) => d.projectId === projectId);

  // Open terminals: a row each, under their Screen's project. A terminal is
  // not a runtime session, so without this the only way back to one was its
  // Screen tab.
  const groups = useLayoutStore((s) => s.groups);
  const terminalRows: TerminalRow[] = [];
  for (const g of groups) {
    if (!g.tree) continue;
    const owner = projectOf(g);
    for (const leaf of leaves(g.tree)) {
      if (leaf.content?.kind !== "terminal") continue;
      terminalRows.push({
        leafId: leaf.id,
        groupId: g.id,
        projectId: sessionsByProject.has(owner) ? owner : null,
        label: terminalLabel(leaf.content, t("session:terminal.title")),
      });
    }
  }
  const terminalsIn = (projectId: string | null) => terminalRows.filter((r) => r.projectId === projectId);
  const liveIn = (projectId: string | null) => draftsIn(projectId).length + terminalsIn(projectId).length;

  // The sidebar shows every pinned project plus the few most-recent others; the
  // full list (search, delete, …) lives on the Projects page. A project with a
  // new conversation in it is shown too, or the conversation would have no row.
  const RECENT_LIMIT = 5;
  const byRecency = [...projects].sort((a, b) => recencyOf(b) - recencyOf(a));
  const shownProjects = [
    ...byRecency.filter((p) => p.pinned),
    ...byRecency.filter((p) => !p.pinned).slice(0, RECENT_LIMIT),
  ];
  const visibleProjects = [
    ...shownProjects,
    ...byRecency.filter((p) => !shownProjects.includes(p) && liveIn(p.id) > 0),
  ];
  const hiddenProjectCount = projects.length - visibleProjects.length;
  const exampleRows: Row[] = project.sessions
    .filter((e) => !hiddenExamples.includes(e.id))
    .map((e) => ({
      id: e.id,
      title: e.title,
      to: `/example/${e.id}`,
      kind: "example" as const,
    }));

  // ---- Inline session search (DSH WorkspaceBrowser): the header's search
  // control expands over the section title; a query swaps the tree for a
  // flat list of matching sessions. Clicking away with no query folds it.
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const searchRoot = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!searchExpanded) return;
    const onClick = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || searchRoot.current?.contains(event.target)) return;
      searchInput.current?.blur();
      if (query.trim() !== "") return;
      setSearchExpanded(false);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [searchExpanded, query]);
  const needle = query.trim().toLowerCase();
  const searching = searchExpanded && needle !== "";
  const allRows = [...Array.from(sessionsByProject.values()).flat(), ...looseRows, ...exampleRows];
  const searchResults = searching
    ? allRows.filter(
        (r) => r.title.toLowerCase().includes(needle) || (r.project ?? "").toLowerCase().includes(needle),
      )
    : [];

  const [pendingDelete, setPendingDelete] = useState<Row | null>(null);
  const [pendingArchive, setPendingArchive] = useState<Row | null>(null);
  const [pendingRemoveProject, setPendingRemoveProject] = useState<ProjectInfo | null>(null);

  const confirmDelete = () => {
    const row = pendingDelete;
    setPendingDelete(null);
    if (!row) return;
    if (row.kind === "session") void deleteSession(row.id);
    else hideExample(row.id);
    if (location.pathname === row.to) navigate("/live");
  };

  // With the overlay titlebar (macOS), reserve a draggable strip at the top so
  // the traffic lights don't overlap the logo and the window stays movable.
  const isMac = navigator.userAgent.includes("Mac");
  const overlayTitlebar = useOverlayTitlebar();

  const width = dragWidth ?? sidebarWidth;
  // On mobile the sidebar is an off-canvas overlay drawer (both app AND settings,
  // opened via the hamburger in AppShell), never sharing horizontal space; on
  // desktop it stays an inline column (settings can't collapse). Capped width so
  // it never covers the whole phone screen.
  const railWidth = isMobile ? Math.min(width, 300) : width;
  const drawerOpen = isMobile ? !sidebarCollapsed : !(sidebarCollapsed && !inSettings);

  /** The folder a session row already lives in, for the "add to project" list. */
  const sessionDirOf = (id: string) => sessions.find((x) => x.id === id)?.directory;

  const now = Date.now();

  const collapseToggle = (
    <button
      onClick={toggleSidebar}
      aria-label={t("sidebar.collapse")}
      title={t("sidebar.collapseTitle", { shortcut: isMac ? "⌘B" : "Ctrl+B" })}
      className={css.iconButton}
    >
      <IconPanelLeftOutlineRegular size={16} />
    </button>
  );

  /** Open a session row. Desktop tiling: a plain click opens it full-screen in
   *  the tentative "preview" screen (#3); a modifier-click opens it in a NEW
   *  split pane — it never clobbers the focused pane. A phone has Screens but
   *  no splits, so there it is always the preview screen: replacing the pane
   *  would change it for every other view of the same Screen. A trailing
   *  click right after a drag is swallowed by the drag controller's one-shot
   *  capture listener. */
  const openRow = (row: Row, e: React.MouseEvent) => {
    if (row.kind !== "session") return;
    e.preventDefault();
    const layout = useLayoutStore.getState();
    if (!isMobile && (e.metaKey || e.ctrlKey || e.altKey)) {
      // eslint-disable-next-line i18next/no-literal-string -- SplitDir enum, not UI copy
      layout.split("row", row.id);
    } else {
      layout.openSessionEphemeral(row.id, row.projectId ?? DEFAULT_PROJECT);
    }
    // The layout change alone is invisible from Skills/Runs/Files/…: those
    // routes render instead of the panes, so navigate to show the session.
    navigate(row.to);
  };

  /** A new conversation's row: accent-tinted, so the one just made is the one
   *  the eye lands on. Clicking it goes back to its Screen. */
  const draftRow = (d: DraftRow) => {
    const selected = d.groupId === null || (d.groupId === activeGroupId && location.pathname === "/live");
    return (
      <div key={d.key} className={css.item}>
        <button
          type="button"
          onClick={() => {
            if (d.groupId) useLayoutStore.getState().setActiveGroup(d.groupId);
            navigate("/live");
          }}
          aria-current={selected ? "page" : undefined}
          className={cn(css.sessionRow, css.draftRow, selected && css.selected)}
        >
          <span className={css.slot}>
            <span className={css.draftDot} aria-hidden="true" />
          </span>
          <span className={css.title}>{t("history.draft")}</span>
        </button>
      </div>
    );
  };

  const terminalRow = (r: TerminalRow) => {
    const g = groups.find((x) => x.id === r.groupId);
    const selected = r.groupId === activeGroupId && g?.focusedLeafId === r.leafId && location.pathname === "/live";
    return (
      <div key={r.leafId} className={css.item}>
        <button
          type="button"
          onClick={() => {
            const layout = useLayoutStore.getState();
            layout.setActiveGroup(r.groupId);
            layout.focusLeaf(r.leafId);
            navigate("/live");
          }}
          aria-current={selected ? "page" : undefined}
          className={cn(css.sessionRow, selected && css.selected)}
        >
          <span className={css.slot}>
            <TerminalIcon size={13} strokeWidth={1.5} className="text-muted" aria-hidden />
          </span>
          <span className={css.title}>{r.label}</span>
        </button>
      </div>
    );
  };

  // Dragging a session over a project: that project lights up as the drop, and
  // a folded one springs open after a moment so the user sees the row land.
  const dropProjectId = useDragPane((s) =>
    s.active?.target && "projectId" in s.active.target ? s.active.target.projectId : null,
  );
  useEffect(() => {
    if (!dropProjectId || !collapsedProjects.includes(dropProjectId)) return;
    const timer = window.setTimeout(() => toggleProject(dropProjectId), 500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-arm only when the hovered project changes
  }, [dropProjectId]);

  const sessionRow = (row: Row) => {
    const running = row.kind === "session" && activeRoots.has(row.id);
    const moving = row.kind === "session" && !!movingSessions[row.id];
    // A session the runtime never auto-titled stays "New session - <stamp>"
    // (#63); double-clicking the row is the way out, matching project rename.
    if (renamingSession === row.id)
      return (
        <div key={row.to} className="py-0.5 pl-2 pr-1">
          <InlineNameInput
            defaultValue={row.title}
            onSubmit={(v) => {
              setRenamingSession(null);
              void renameSession(row.id, v);
            }}
            onCancel={() => setRenamingSession(null)}
          />
        </div>
      );
    return (
    <ContextMenu
      key={row.to}
      label={row.kind === "example" ? t("rowMenu.exampleLabel") : t("rowMenu.sessionLabel")}
      items={
        row.kind === "example" ? (
          <ContextMenuItem icon={<Trash2 size={14} />} danger onSelect={() => setPendingDelete(row)}>
            {t("confirmDelete.hideAction")}
          </ContextMenuItem>
        ) : (
          <>
            <ContextMenuItem
              icon={<Pencil size={14} />}
              disabled={webReadOnly}
              // Mount the editor after the menu hands focus back, or the
              // restore blurs the fresh input and a blur commits it.
              onSelect={() => requestAnimationFrame(() => setRenamingSession(row.id))}
            >
              {t("history.rename")}
            </ContextMenuItem>
            {/* Moving runs the runtime's CLI on this machine — desktop only. */}
            {!isGatewayWeb && (
              <ContextMenuSub icon={<FolderInput size={14} />} label={t("history.moveTo")}>
                {projects.length === 0 && (
                  <ContextMenuEmpty>{t("history.moveToNone")}</ContextMenuEmpty>
                )}
                {projects.map((p) => (
                  <ContextMenuItem
                    key={p.id}
                    disabled={samePath(p.path, sessionDirOf(row.id))}
                    onSelect={() => void moveSessionToProject(row.id, p.id)}
                  >
                    {p.name}
                  </ContextMenuItem>
                ))}
              </ContextMenuSub>
            )}
            <ContextMenuItem
              icon={<Link2 size={14} />}
              onSelect={() => {
                const s = sessions.find((x) => x.id === row.id);
                void copyReference(
                  sessionReference({ id: row.id, title: s?.title, directory: s?.directory }),
                  t("session:reference.copied"),
                );
              }}
            >
              {t("session:reference.copy")}
            </ContextMenuItem>
            <ContextMenuItem
              icon={<Archive size={14} />}
              disabled={webReadOnly}
              onSelect={() => setPendingArchive(row)}
            >
              {t("history.archive")}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              icon={<Trash2 size={14} />}
              danger
              disabled={webReadOnly}
              onSelect={() => setPendingDelete(row)}
            >
              {t("confirmDelete.deleteAction")}
            </ContextMenuItem>
          </>
        )
      }
    >
    <MarqueeRow className={css.item}>
      {(titleRef) => (
      <>
      <NavLink
        to={row.to}
        // An <a> is natively draggable; that native drag hijacks the pointer
        // stream (selecting text instead) and defeats our pointer-based dock
        // drag. Disable it so startPaneDrag's window listeners see the moves.
        draggable={false}
        onDragStart={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          // Drag a session row into the pane area to dock it (desktop only).
          if (row.kind === "session" && !moving && !isMobile) {
            // eslint-disable-next-line i18next/no-literal-string -- DragSource kind, not UI copy
            startPaneDrag(e, { kind: "session", sessionId: row.id }, row.title);
          }
        }}
        onClick={(e) => openRow(row, e)}
        className={cn(css.sessionRow, location.pathname === row.to && css.selected, moving && css.moving)}
        aria-busy={moving || undefined}
      >
        {/* DSH session cell: pad 8, a 16px status slot (empty while idle),
            the title, then the time — which hover swaps for the buttons. */}
        <span className={css.slot}>
          {/* eslint-disable-next-line i18next/no-literal-string -- StateDot state, not UI copy */}
          {(running || moving) && <StateDot state="ongoing" />}
          {running && <span className="sr-only">{t("history.running")}</span>}
          {moving && <span className="sr-only">{t("history.moving")}</span>}
        </span>
        <span
          ref={titleRef}
          className={css.title}
          title={row.kind === "session" ? t("history.renameHint") : undefined}
          onDoubleClick={(e) => {
            if (row.kind !== "session" || webReadOnly) return;
            e.preventDefault();
            e.stopPropagation();
            setRenamingSession(row.id);
          }}
        >
          {row.title}
        </span>
        <span className={css.time}>
          {row.kind === "example" ? t("history.exampleTag") : timeAgo(row.updated, now)}
        </span>
        <span
          className={css.actionsSpacer}
          style={{ width: row.kind === "example" ? 16 : 68 }}
        />
      </NavLink>
      <span className={css.rowActions}>
        {row.kind === "session" && (
          <>
            <RowButton
              label={t("history.rowActions", { title: row.title })}
              // The "…" opens the row's own right-click menu at the button,
              // so both routes show one list of actions.
              onClick={(e) => openRowMenu(e.currentTarget)}
            >
              <IconEllipsisOutlineRegular />
            </RowButton>
            {!webReadOnly && (
              <RowButton
                label={t("history.archive")}
                onClick={() => setPendingArchive(row)}
              >
                <IconArchiveOutlineRegular size={16} />
              </RowButton>
            )}
          </>
        )}
        {!(row.kind === "session" && webReadOnly) && (
          <RowButton
            label={t("history.deleteAria", { title: row.title })}
            danger
            onClick={() => setPendingDelete(row)}
          >
            <IconTrashOutlineRegular />
          </RowButton>
        )}
      </span>
      </>
      )}
    </MarqueeRow>
    </ContextMenu>
    );
  };

  return (
    <div
      ref={railRef}
      className={cn(
        "relative h-full overflow-hidden",
        isMobile ? "fixed inset-y-0 left-0 z-40 shadow-2xl" : "shrink-0",
        // The DRAWER slides (a transform, composited, free). The desktop rail's
        // WIDTH does not animate: it is a layout property, so a 200ms tween
        // reflowed the whole window twelve times over — every pane, every
        // terminal, every editor, and every Screen kept warm off-display, which
        // are laid out even while invisible. Collapsing the sidebar stuttered
        // for the entire animation; instant is both snappier and honest.
        !dragging && isMobile && "transition-transform duration-200 ease-out",
      )}
      style={
        isMobile
          ? { width: railWidth, transform: drawerOpen ? "none" : "translateX(-100%)" }
          : { width: sidebarCollapsed && !inSettings ? 0 : width }
      }
    >
      <aside
        ref={surfaceRef}
        // `select-none`: the rail is chrome, so a right-click (or a sloppy drag)
        // must not leave its labels highlighted. Inline rename inputs opt back
        // in via the global rule in index.css.
        className="sidebar-surface flex h-full select-none flex-col border-r border-border"
        style={{ width: railWidth }}
      >
        <div className={css.root}>
        {/* macOS overlay titlebar: the strip shares the row with the traffic
            lights and keeps the collapse toggle at its right edge (DSH). */}
        {overlayTitlebar && (
          <div data-tauri-drag-region className={css.topStrip} style={{ minHeight: overlayTitlebarStyle(true).minHeight }}>
            {!inSettings && collapseToggle}
          </div>
        )}
        {inSettings && (
          <>
            <nav className={css.panelList} style={{ marginTop: overlayTitlebar ? 0 : 8 }}>
              <button onClick={() => navigate("/live")} className={css.panelRow}>
                <span className={css.panelGlyph}>
                  <IconChevronLeftOutlineRegular size={16} />
                </span>
                <span className={css.panelTitle}>{t("settings:nav.back")}</span>
              </button>
            </nav>
            <nav className={css.panelList}>
              {visibleSections(isGatewayWeb).map(({ key, icon: Icon }) => (
                <NavLink
                  key={key}
                  to={`/settings/${key}`}
                  className={cn(css.panelRow, activeSection === key && css.panelActive)}
                >
                  <span className={css.panelGlyph}>
                    <Icon size={16} />
                  </span>
                  <span className={css.panelTitle}>{t(`settings:nav.${key}`)}</span>
                </NavLink>
              ))}
            </nav>
          </>
        )}
        {!inSettings && (
        <>
        <div className={css.logoRow}>
          {/* The brand only: not a control. As a "home" link it swapped the
              conversation on screen for a blank new one. */}
          <div className={css.brand}>
            <span className={css.brandIdentity}>
              <span className={css.brandMark}>
                <img src={logo} alt="" />
              </span>
              {/* eslint-disable-next-line i18next/no-literal-string -- product brand name, not translated across locales (see AGENTS.md) */}
              <span className={css.brandName}>Open Science</span>
            </span>
          </div>
          {!overlayTitlebar && collapseToggle}
        </div>

        {/* A read-only web token can't create sessions — hide the entry. */}
        {!webReadOnly && (
          <button className={css.newSession} onClick={() => setPicking(true)} aria-label={t("items.new")}>
            <span className={css.newSessionLabelMask}>
              <span className={css.newSessionContent}>
                <IconNewChatOutlineMedium size={14} />
                <span className={css.newSessionLabel}>{t("items.new")}</span>
              </span>
            </span>
          </button>
        )}

        <nav className={css.panelList}>
          <NavRow
            icon={<IconChecklistOutlineRegular size={16} />}
            label={t("items.tasks")}
            active={location.pathname.startsWith("/tasks")}
            onClick={() => navigate("/tasks")}
          />
          {/* Notebook execution needs a local kernel — hidden in the web client. */}
          {!isGatewayWeb && (
            <NavRow
              icon={<IconListPenOutlineRegular size={16} />}
              label={t("items.notebooks")}
              active={location.pathname.startsWith("/notebooks")}
              onClick={() => navigate("/notebooks")}
            />
          )}
          <NavRow
            icon={<IconFolderOpenOutlineRegular size={16} />}
            label={t("items.files")}
            active={location.pathname.startsWith("/files")}
            onClick={() => navigate("/files")}
          />
          <NavRow
            icon={<IconPlayOutlineRegular size={16} />}
            label={t("items.runs")}
            active={location.pathname.startsWith("/runs")}
            onClick={() => navigate("/runs")}
          />
          <NavRow
            icon={<IconSkillOutlineRegular size={16} />}
            label={t("items.skills")}
            active={location.pathname.startsWith("/skills")}
            onClick={() => navigate("/skills")}
          />
        </nav>

        <div className={css.regionArea}>
          {/* Section header (DSH WorkspaceBrowser): the title, an inline
              search that expands over the header, and the add action. */}
          <div className={css.sectionHeader}>
            <button
              onClick={() => navigate("/projects")}
              title={t("projects.seeAll")}
              className={cn(css.sectionLabel, searchExpanded && css.sectionLabelHidden)}
            >
              {t("projects.heading")}
            </button>
            <div className={cn(css.searchSlot, searchExpanded && css.searchSlotExpanded)}>
              <div
                ref={searchRoot}
                className={cn(css.search, searchExpanded && css.searchExpanded)}
                onClick={() => {
                  setSearchExpanded(true);
                  searchInput.current?.focus();
                }}
              >
                <button
                  type="button"
                  className={css.searchButton}
                  aria-label={t("sidebar.searchAria")}
                  title={t("sidebar.searchAria")}
                  aria-expanded={searchExpanded}
                >
                  <IconSearchOutlineRegular size={searchExpanded ? 11 : 14} />
                </button>
                <input
                  ref={searchInput}
                  className={css.searchInput}
                  type="text"
                  placeholder={t("sidebar.searchPlaceholder")}
                  value={query}
                  tabIndex={searchExpanded ? 0 : -1}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Escape") return;
                    setQuery("");
                    setSearchExpanded(false);
                  }}
                />
                {searchExpanded && (
                  <button
                    type="button"
                    className={css.clearButton}
                    aria-label={t("sidebar.searchClear")}
                    onClick={(e) => {
                      e.stopPropagation();
                      setQuery("");
                      setSearchExpanded(false);
                    }}
                  >
                    <IconCloseFillRegular />
                  </button>
                )}
              </div>
            </div>
            <div className={cn(css.headerActions, searchExpanded && css.headerActionsHidden)}>
              {/* Creating/importing a project needs local FS access — hidden in web. */}
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button
                    aria-label={t("projects.new")}
                    title={t("projects.new")}
                    className={cn(css.iconButton, isGatewayWeb && "hidden")}
                  >
                    <IconProjectAddOutlineRegular size={16} />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    align="end"
                    sideOffset={6}
                    className="z-50 min-w-[210px] rounded-card border border-border bg-surface p-1 text-[13px] text-text shadow-pop"
                  >
                    <DropdownMenu.Item
                      onSelect={() => setNamingProject(true)}
                      className="flex cursor-pointer items-center gap-2 rounded-input px-2 py-1.5 outline-none data-[highlighted]:bg-surface-2"
                    >
                      <Plus size={14} className="shrink-0 text-muted" />
                      <span className="truncate">{t("projects.menuScratch")}</span>
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      onSelect={() => void handleImport()}
                      className="flex cursor-pointer items-center gap-2 rounded-input px-2 py-1.5 outline-none data-[highlighted]:bg-surface-2"
                    >
                      <FolderInput size={14} className="shrink-0 text-muted" />
                      <span className="truncate">{t("projects.menuExisting")}</span>
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
          </div>
          {picking && (
            <NewSessionPicker
              onClose={() => setPicking(false)}
              onPick={(id) => {
                setPicking(false);
                const p = projects.find((x) => x.id === id);
                if (p) void openProjectScreen(p);
                else startNew();
              }}
              // Creating a project needs the local filesystem — not on the web.
              onNewProject={
                isGatewayWeb
                  ? undefined
                  : () => {
                      setPicking(false);
                      setSessionAfterProject(true);
                      setNamingProject(true);
                    }
              }
            />
          )}
          {namingProject && (
            <NameProjectDialog
              defaultName={t("projects.new")}
              title={t("projects.nameTitle")}
              subtitle={t("projects.nameSubtitle")}
              placeholder={t("projects.namePlaceholder")}
              busy={createBusy}
              onSave={(v) => void submitNewProject(v)}
              onCancel={() => {
                if (createBusy) return;
                setNamingProject(false);
                setSessionAfterProject(false);
              }}
            />
          )}
          {pendingImportPath && (
            <ImportProjectDialog
              path={pendingImportPath}
              busy={importBusy}
              onImport={(mode) => void submitImport(mode)}
              onCancel={() => {
                if (!importBusy) setPendingImportPath(null);
              }}
            />
          )}

          {searching ? (
            // DSH search body: a flat list of matching sessions, each with the
            // project it lives in underneath.
            <div role="list" aria-label={t("sidebar.searchResultsAria")}>
              {searchResults.length === 0 && (
                <div className={css.empty}>{t("sidebar.searchNoMatches")}</div>
              )}
              {searchResults.map((row) => (
                <NavLink
                  key={row.to}
                  to={row.to}
                  role="listitem"
                  draggable={false}
                  onClick={(e) => {
                    setQuery("");
                    setSearchExpanded(false);
                    openRow(row, e);
                  }}
                  className={cn(css.searchResultRow, location.pathname === row.to && css.selected)}
                >
                  <span className={css.searchResultTitle}>{row.title}</span>
                  <span className={css.searchResultMeta}>
                    {row.kind === "example" ? t("history.exampleTag") : (row.project ?? t("history.heading"))}
                  </span>
                </NavLink>
              ))}
            </div>
          ) : (
          <>
          {projects.length === 0 && !namingProject && (
            <div className={css.item}>
              <button onClick={() => setNamingProject(true)} className={css.projectRow}>
                <span className={css.slot}>
                  <IconFolderCloseRegular />
                </span>
                <span className={cn(css.title)} style={{ color: "var(--dsw-alias-label-tertiary)" }}>
                  {t("projects.new")}
                </span>
              </button>
            </div>
          )}
          {visibleProjects.map((p) => {
            const open = !collapsedProjects.includes(p.id);
            const active = !isMobile ? activeProjectId === p.id : samePath(p.path, workspace);
            const rows = sessionsByProject.get(p.id) ?? [];
            const drafts = draftsIn(p.id);
            return (
              // The whole block — the row and its sessions — takes a dragged
              // session, so the drop does not demand aiming at one 34px row.
              <div
                key={p.id}
                data-drop-project={p.id}
                className={cn(css.dropZone, dropProjectId === p.id && css.dropActive)}
              >
                {renamingId === p.id ? (
                  <div className="py-0.5 pl-[26px] pr-1">
                    <InlineNameInput
                      defaultValue={p.name}
                      placeholder={t("projects.namePlaceholder")}
                      onSubmit={(v) => void submitRename(p, v)}
                      onCancel={() => setRenamingId(null)}
                    />
                  </div>
                ) : (
                  <ContextMenu
                    label={t("rowMenu.projectLabel")}
                    items={
                      <>
                        <ContextMenuItem
                          icon={<Plus size={14} />}
                          disabled={webReadOnly}
                          onSelect={() => void openProjectScreen(p)}
                        >
                          {t("projects.newSession")}
                        </ContextMenuItem>
                        <ContextMenuItem
                          icon={<Pencil size={14} />}
                          onSelect={() => requestAnimationFrame(() => setRenamingId(p.id))}
                        >
                          {t("projects.rename")}
                        </ContextMenuItem>
                        {/* The folder is on the desktop's disk; a browser cannot open it. */}
                        {!isGatewayWeb && (
                          <ContextMenuItem
                            icon={<FolderOpen size={14} />}
                            onSelect={() => void openProjectFolder(p.id)}
                          >
                            {t("projects.openFolderLabel")}
                          </ContextMenuItem>
                        )}
                        <ContextMenuItem
                          icon={<Pin size={14} />}
                          onSelect={() => void setProjectPinned(p.id, !p.pinned)}
                        >
                          {p.pinned ? t("projects.unpin") : t("projects.pin")}
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          icon={<Trash2 size={14} />}
                          danger
                          onSelect={() => setPendingRemoveProject(p)}
                        >
                          {t("projects.remove")}
                        </ContextMenuItem>
                      </>
                    }
                  >
                  <div className={css.item}>
                    {/* DSH project row: folder + name at rest; hover swaps the
                        folder for the expand triangle and shows the
                        new-session button. */}
                    <button
                      onClick={() => clickProject(p.id)}
                      aria-expanded={open}
                      className={css.projectRow}
                      style={{ paddingRight: webReadOnly ? 8 : 34 }}
                    >
                      <span
                        className={cn(css.slot, css.folder, active && css.folderActive)}
                        data-active={active || undefined}
                      >
                        {open ? <IconFolderOpenRegular /> : <IconFolderCloseRegular />}
                      </span>
                      <span className={cn(css.slot, css.chevron)}>
                        <IconTriangleRightFillRegular className={cn(css.arrow, open && css.arrowOpen)} />
                      </span>
                      <span
                        className={css.title}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          setRenamingId(p.id);
                        }}
                        title={p.imported ? (p.importedFrom ?? p.path) : t("projects.renameHint")}
                      >
                        {p.name}
                      </span>
                      {p.imported && (
                        <span className={css.badge} title={p.importedFrom ?? p.path}>
                          {t("projects.importedBadge")}
                        </span>
                      )}
                    </button>
                    {!webReadOnly && (
                      <span className={css.rowActions}>
                        <RowButton
                          label={t("projects.newSessionAria", { name: p.name })}
                          onClick={() => void openProjectScreen(p)}
                        >
                          <IconNewChatOutlineRegular />
                        </RowButton>
                      </span>
                    )}
                  </div>
                  </ContextMenu>
                )}
                <div
                  className={cn(
                    "grid transition-[grid-template-rows] duration-200 ease-out",
                    open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
                  )}
                >
                  <div className="overflow-hidden">
                    {rows.length === 0 && liveIn(p.id) === 0 && (
                      <div className={css.empty}>{t("projects.noSessions")}</div>
                    )}
                    {drafts.map(draftRow)}
                    {terminalsIn(p.id).map(terminalRow)}
                    {rows.slice(0, ROW_LIMIT).map(sessionRow)}
                    {rows.length > ROW_LIMIT && (
                      <MoreRow
                        count={rows.length - ROW_LIMIT}
                        label={t("history.seeAll")}
                        onClick={() => navigate("/history")}
                      />
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          {hiddenProjectCount > 0 && (
            <MoreRow
              count={hiddenProjectCount}
              label={t("projects.seeAll")}
              onClick={() => navigate("/projects")}
            />
          )}
          <div className={css.sectionHeader}>
            {/* Every conversation ever, searchable — the rail only shows recent
                work, so this is how older sessions are found (#65). */}
            <button
              onClick={() => navigate("/history")}
              title={t("history.seeAll")}
              className={css.sectionLabel}
            >
              {t("history.heading")}
            </button>
            <div className={css.headerActions} style={{ marginLeft: "auto" }}>
              <button
                onClick={() => navigate("/history")}
                aria-label={t("history.seeAll")}
                title={t("history.seeAll")}
                className={css.iconButton}
              >
                <IconFlatListOutlineRegular size={16} />
              </button>
            </div>
          </div>
          {looseRows.length === 0 && exampleRows.length === 0 && liveIn(null) === 0 && (
            <div className={css.empty}>{t("history.empty")}</div>
          )}
          {draftsIn(null).map(draftRow)}
          {terminalsIn(null).map(terminalRow)}
          {looseRows.slice(0, ROW_LIMIT).map(sessionRow)}
          {looseRows.length > ROW_LIMIT && (
            <MoreRow
              count={looseRows.length - ROW_LIMIT}
              label={t("history.seeAll")}
              onClick={() => navigate("/history")}
            />
          )}
          {exampleRows.map(sessionRow)}
          </>
          )}
        </div>
        </>
        )}

        <div className={css.footArea}>
          {!inSettings && (
            <button
              className={css.trigger}
              onClick={() => navigate("/settings")}
              aria-label={t("sidebar.settings")}
            >
              <IconSettingsOutlineMedium size={16} />
              <span>{t("sidebar.settings")}</span>
              {showUpdateBadge && <span aria-hidden="true" className={css.updateDot} />}
            </button>
          )}
        </div>
        </div>

        {pendingRemoveProject && (
          <ConfirmDialog
            title={t("projects.removeTitle", { name: pendingRemoveProject.name })}
            body={t(
              pendingRemoveProject.importMode === "copy"
                ? "projects.removeCopyBody"
                : "projects.removeBody",
            )}
            confirmLabel={t("projects.remove")}
            onConfirm={() => {
              void deleteProject(pendingRemoveProject.id);
              setPendingRemoveProject(null);
            }}
            onCancel={() => setPendingRemoveProject(null)}
          />
        )}

        {pendingArchive && (
          <ConfirmDialog
            title={t("history.archiveTitle")}
            body={t("history.archiveBody", { title: pendingArchive.title })}
            confirmLabel={t("history.archive")}
            // eslint-disable-next-line i18next/no-literal-string -- dialog tone, not UI copy
            tone="default"
            onConfirm={() => {
              const row = pendingArchive;
              setPendingArchive(null);
              void setSessionArchived(row.id, true);
              if (location.pathname === row.to) navigate("/live");
            }}
            onCancel={() => setPendingArchive(null)}
          />
        )}

        {pendingDelete && (
          <ConfirmDialog
            title={
              pendingDelete.kind === "session"
                ? t("confirmDelete.sessionTitle")
                : t("confirmDelete.exampleTitle")
            }
            body={
              pendingDelete.kind === "session"
                ? t("confirmDelete.sessionBody", { title: pendingDelete.title })
                : t("confirmDelete.exampleBody", { title: pendingDelete.title })
            }
            confirmLabel={
              pendingDelete.kind === "session"
                ? t("confirmDelete.deleteAction")
                : t("confirmDelete.hideAction")
            }
            onConfirm={confirmDelete}
            onCancel={() => setPendingDelete(null)}
          />
        )}
      </aside>

      {/* Drag divider: resize within [SIDEBAR_MIN, SIDEBAR_MAX]; dragging far
          left snaps the sidebar closed. Kept mounted while collapsed so an
          in-flight drag (pointer capture) can re-open it. */}
      <div
        {...handleProps}
        className={cn(
          "group absolute inset-y-0 right-0 z-10 w-[5px] cursor-col-resize transition-colors duration-150",
          // The whole 5px grab strip tints while it is being dragged, so the
          // edge reads as a handle under the pointer and not as a hairline that
          // happened to change colour.
          dragging && "bg-accent/15",
          sidebarCollapsed && !dragging && "pointer-events-none",
        )}
      >
        <div
          className={cn(
            "absolute inset-y-0 right-0 w-[2px] transition-colors duration-150",
            // While dragging, the edge is what the eye should follow: a solid
            // accent line with a soft halo, so it reads as the thing being
            // moved rather than as a hairline that happens to have changed
            // colour.
            dragging ? "bg-accent" : "bg-transparent group-hover:bg-accent/40",
          )}
        />
      </div>
    </div>
  );
}

function ImportProjectDialog({
  path,
  busy,
  onImport,
  onCancel,
}: {
  path: string;
  busy: boolean;
  onImport: (mode: ProjectImportMode) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation(["nav", "common"]);
  const pathParts = path.split(/[\\/]/).filter(Boolean);
  const name = pathParts[pathParts.length - 1] ?? path;
  useEffect(() => {
    if (busy) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={() => !busy && onCancel()}
      role="presentation"
    >
      <div
        role="dialog"
        aria-label={t("nav:projects.importTitle")}
        className="w-[520px] max-w-[calc(100vw-2rem)] rounded-card border border-border bg-surface p-5 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-semibold text-text">{t("nav:projects.importTitle")}</div>
        <p className="mt-1 text-sm text-muted">
          {t("nav:projects.importSubtitle", { name })}
        </p>
        <div className="mt-4 grid gap-2">
          <button
            autoFocus
            disabled={busy}
            onClick={() => onImport("in-place")}
            className="rounded-card border border-accent bg-surface-2 p-3 text-left hover:bg-surface disabled:opacity-50"
          >
            <span className="block text-sm font-medium text-text">
              {t("nav:projects.importInPlace")}
            </span>
            <span className="mt-1 block text-xs leading-relaxed text-muted">
              {t("nav:projects.importInPlaceHint")}
            </span>
          </button>
          <button
            disabled={busy}
            onClick={() => onImport("copy")}
            className="rounded-card border border-border p-3 text-left hover:bg-surface-2 disabled:opacity-50"
          >
            <span className="block text-sm font-medium text-text">
              {t("nav:projects.importCopy")}
            </span>
            <span className="mt-1 block text-xs leading-relaxed text-muted">
              {t("nav:projects.importCopyHint")}
            </span>
          </button>
        </div>
        <div className="mt-4 flex justify-end">
          <button
            disabled={busy}
            onClick={onCancel}
            className="rounded-input border border-border px-3 py-1.5 text-sm text-text hover:bg-surface-2 disabled:opacity-50"
          >
            {t("common:actions.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** "+N · All sessions" tail of a truncated session list. */
/** A sidebar row that marquees its clipped title while hovered. It is the
 *  right-click menu's trigger, so it forwards the ref and props Radix passes;
 *  `data-sidebar-row` lets the row's "…" button open that same menu. */
const MarqueeRow = forwardRef<
  HTMLDivElement,
  Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
    children: (titleRef: RefObject<HTMLSpanElement>) => ReactNode;
  }
>(function MarqueeRow({ children, onPointerEnter, onPointerLeave, ...rest }, ref) {
  const titleRef = useRef<HTMLSpanElement>(null);
  const marquee = useTitleMarquee(titleRef);
  return (
    <div
      ref={ref}
      data-sidebar-row=""
      {...rest}
      onPointerEnter={(e) => {
        marquee.enter();
        onPointerEnter?.(e);
      }}
      onPointerLeave={(e) => {
        marquee.leave();
        onPointerLeave?.(e);
      }}
    >
      {children(titleRef)}
    </div>
  );
});

/** Open the enclosing row's right-click menu just below `button`. */
function openRowMenu(button: HTMLElement): void {
  const r = button.getBoundingClientRect();
  // eslint-disable-next-line i18next/no-literal-string -- DOM selector, not UI copy
  const row = button.closest("[data-sidebar-row]");
  row?.dispatchEvent(
    // eslint-disable-next-line i18next/no-literal-string -- DOM event type, not UI copy
    new MouseEvent("contextmenu", { bubbles: true, clientX: r.left, clientY: r.bottom + 4 }),
  );
}

/** A bare 16px glyph button in a row's hover strip (DeepSeek Harness style). */
function RowButton({
  label,
  danger = false,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick(e);
      }}
      className={cn(css.rowIconButton, danger && css.danger)}
    >
      {children}
    </button>
  );
}

function MoreRow({
  count,
  label,
  onClick,
}: {
  count: number;
  label: string;
  onClick: () => void;
}) {
  return (
    <button onClick={onClick} className={css.moreRow}>
      <span className="truncate">{label}</span>
      <span className="ml-1.5 shrink-0 tabular-nums">+{count}</span>
    </button>
  );
}

/** A DSH panel row: 16px glyph + title, 36px tall, 12px radius. */
function NavRow({
  icon,
  label,
  active = false,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(css.panelRow, active && css.panelActive)}
    >
      <span className={css.panelGlyph} aria-hidden="true">{icon}</span>
      <span className={css.panelTitle}>{label}</span>
    </button>
  );
}

/** One-line name editor used for "new project" and rename: Enter submits,
 *  Escape or clicking away cancels — no dialog, the row edits in place. */
function InlineNameInput({
  defaultValue = "",
  placeholder,
  busy = false,
  onSubmit,
  onCancel,
}: {
  defaultValue?: string;
  placeholder?: string;
  busy?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      defaultValue={defaultValue}
      placeholder={placeholder}
      disabled={busy}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSubmit(e.currentTarget.value);
        else if (e.key === "Escape") onCancel();
      }}
      onBlur={() => {
        if (!busy) onCancel();
      }}
      className={cn(
        "w-full min-w-0 rounded-input border border-accent/50 bg-surface px-2 py-[3px] text-[13px] text-text outline-none placeholder:text-muted focus:border-accent",
        busy && "animate-pulse opacity-60",
      )}
    />
  );
}

/** Modal for naming a new (from-scratch) project: a focused, pre-selected input
 *  with Save/Cancel. Used instead of an inline row so "New project" reads as a
 *  deliberate step (matching the from-scratch / existing-folder menu split). */
function NameProjectDialog({
  defaultName,
  title,
  subtitle,
  placeholder,
  busy,
  onSave,
  onCancel,
}: {
  defaultName: string;
  title: string;
  subtitle: string;
  placeholder?: string;
  busy: boolean;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("common");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const save = () => {
    const v = ref.current?.value ?? "";
    if (v.trim() && !busy) onSave(v);
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={() => !busy && onCancel()}
      role="presentation"
    >
      <div
        role="dialog"
        aria-label={title}
        className="w-[420px] max-w-[calc(100vw-2rem)] rounded-card border border-border bg-surface p-5 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-semibold text-text">{title}</div>
        <p className="mt-1 text-sm text-muted">{subtitle}</p>
        <input
          ref={ref}
          defaultValue={defaultName}
          placeholder={placeholder}
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            else if (e.key === "Escape") onCancel();
          }}
          className={cn(
            "mt-4 w-full rounded-input border border-border bg-surface px-3 py-2 text-sm text-text outline-none placeholder:text-muted focus:border-accent",
            busy && "animate-pulse opacity-60",
          )}
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            className="rounded-input border border-border px-3 py-1.5 text-sm text-text hover:bg-surface-2 disabled:opacity-50"
            onClick={onCancel}
            disabled={busy}
          >
            {t("actions.cancel")}
          </button>
          <button
            className="rounded-input bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            onClick={save}
            disabled={busy}
          >
            {t("actions.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
