import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Bot,
  Check,
  ChevronDown,
  FileText,
  Folder,
  FolderTree,
  Link2,
  Monitor,
  UserRound,
  NotebookPen,
  Pencil,
  Plus,
  Terminal as TerminalIcon,
  X,
  PanelLeft,
} from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  DEFAULT_PROJECT,
  groupLabel,
  projectGroups,
  selectActiveProjectId,
  useLayoutStore,
  type LayoutGroup,
  type PaneContent,
} from "@/lib/layout";
import { createMarkdown, createNotebook } from "@/lib/newFile";
import { toast } from "@/lib/toast";
import { isTauri } from "@/lib/tauri";
import { isGatewayWeb, layoutSource, type LayoutSource } from "@/lib/webMode";
import { switchLayoutSource } from "@/lib/layoutSync";
import { startSessionScreen, useRuntimeStore } from "@/lib/runtime";
import { ensureCliAgent, useInstalledAgents, type CliAgent } from "@/lib/cliAgents";
import { useOverlayTitlebar, useUiStore } from "@/lib/store";
import { overlayTitlebarStyle } from "@/lib/titlebar";
import { cn } from "@/lib/cn";
import { useIsMobile } from "@/lib/useIsMobile";
import { useTransientScrollbar } from "@/lib/transientScrollbar";
import { copyReference, screenReference } from "@/lib/agentReference";
import { ContextMenu, ContextMenuItem } from "@/components/ui/ContextMenu";
import { InlineName } from "@/components/ui/InlineName";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

/**
 * Horizontal group/"screen" tab strip at the very top of the live surface —
 * each tab is one independent pane layout (browser/iTerm style). As the
 * top-most element it owns the macOS overlay-titlebar clearance (traffic-light
 * inset + window-drag region), so no pane below needs to.
 */
/**
 * New Screen — and, when the machine has coding agents installed, which one it
 * should run.
 *
 * A plain "+" could only ever mean "empty Screen", so switching to Claude Code
 * or Codex meant a trip through Settings. The agents offered here are detected
 * on PATH (`lib/cliAgents.ts`), so the menu describes THIS machine rather than a
 * fixed list of things that might not be installed.
 */
function NewScreenButton({ onNewScreen }: { onNewScreen: (agentId?: string) => void }) {
  const { t } = useTranslation(["session", "nav"]);
  const agents = useInstalledAgents() ?? [];
  const [busy, setBusy] = useState(false);
  const addGroup = useLayoutStore((s) => s.addGroup);
  // A terminal opens where the work is: the active project's folder, or for
  // Default the runtime's workspace. Without it every shell starts in the app's
  // own working directory, which is never where the user's files are.
  const cwd = useActiveProjectPath();

  /** Every item here opens a NEW Screen holding the thing. The Screen bar owns
   *  Screens; splitting the current layout belongs to the pane's own controls. */
  const openScreen = (content: PaneContent) => addGroup(content);

  const newFilePane = async (make: () => Promise<string>, kind: "notebook" | "editor") => {
    setBusy(true);
    try {
      const path = await make();
      addGroup({ kind, path, root: "workspace" });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** A new conversation on this agent. Only that conversation runs on it;
   *  every other one keeps its own agent. */
  const run = (agent: CliAgent) => {
    ensureCliAgent(agent);
    onNewScreen(agent.id);
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          aria-label={t("group.newTab")}
          title={t("group.newTab")}
          disabled={busy}
          className="shrink-0 rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text disabled:opacity-50"
        >
          <Plus size={14} strokeWidth={1.5} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          className="z-50 min-w-[220px] rounded-card border border-border bg-surface p-1 text-[13px] text-text shadow-pop"
        >
          <DropdownMenu.Item
            onSelect={() => onNewScreen()}
            className="flex cursor-pointer items-center gap-2 rounded-input px-2 py-1.5 outline-none data-[highlighted]:bg-surface-2"
          >
            <Plus size={13} className="shrink-0 text-muted" />
            {t("nav:projects.newSession")}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            // eslint-disable-next-line i18next/no-literal-string -- PaneContent kind, not UI copy
            onSelect={() => openScreen({ kind: "terminal", cwd })}
            className="flex cursor-pointer items-center gap-2 rounded-input px-2 py-1.5 outline-none data-[highlighted]:bg-surface-2"
          >
            <TerminalIcon size={13} className="shrink-0 text-muted" />
            {t("terminal.new")}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            // eslint-disable-next-line i18next/no-literal-string -- PaneContent kind, not UI copy
            onSelect={() => openScreen({ kind: "files" })}
            className="flex cursor-pointer items-center gap-2 rounded-input px-2 py-1.5 outline-none data-[highlighted]:bg-surface-2"
          >
            <FolderTree size={13} className="shrink-0 text-muted" />
            {t("nav:items.files")}
          </DropdownMenu.Item>
          {/* A new file is written to the desktop's disk, and a notebook runs on
              its kernel — neither is reachable from a browser. */}
          {isTauri && (
            <>
              <DropdownMenu.Item
                // eslint-disable-next-line i18next/no-literal-string -- PaneContent kind, not UI copy
                onSelect={() => void newFilePane(createNotebook, "notebook")}
                className="flex cursor-pointer items-center gap-2 rounded-input px-2 py-1.5 outline-none data-[highlighted]:bg-surface-2"
              >
                <NotebookPen size={13} className="shrink-0 text-muted" />
                {t("group.newNotebook")}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                // eslint-disable-next-line i18next/no-literal-string -- PaneContent kind, not UI copy
                onSelect={() => void newFilePane(createMarkdown, "editor")}
                className="flex cursor-pointer items-center gap-2 rounded-input px-2 py-1.5 outline-none data-[highlighted]:bg-surface-2"
              >
                <FileText size={13} className="shrink-0 text-muted" />
                {t("group.newMarkdown")}
              </DropdownMenu.Item>
            </>
          )}
          {agents.length > 0 && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-faint" />
              <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
                {t("group.runAgent")}
              </div>
            </>
          )}
          {agents.map((agent) => (
            <DropdownMenu.Item
              key={agent.id}
              onSelect={() => void run(agent)}
              className="flex cursor-pointer items-center gap-2 rounded-input px-2 py-1.5 outline-none data-[highlighted]:bg-surface-2"
            >
              <Bot size={13} className="shrink-0 text-muted" />
              {agent.name}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** The folder the active project works in: its own, or the runtime's
 *  workspace for Default. */
export function useActiveProjectPath(): string | undefined {
  const projectId = useLayoutStore(selectActiveProjectId);
  const projects = useRuntimeStore((s) => s.projects);
  const workspace = useRuntimeStore((s) => s.workspace);
  if (projectId !== DEFAULT_PROJECT) {
    const path = projects.find((p) => p.id === projectId)?.path;
    if (path) return path;
  }
  return workspace ?? undefined;
}

/**
 * The project whose Screens the bar is showing, and the way to another one.
 *
 * The bar is Project → Screens: its tabs are the active project's Screens
 * only, so it has to say which project that is — and switching here is the
 * same as picking the project in the sidebar or with ⌘J.
 */
function ProjectSwitcher() {
  const { t } = useTranslation("session");
  const compact = useIsMobile();
  const projectId = useLayoutStore(selectActiveProjectId);
  const setActiveProject = useLayoutStore((s) => s.setActiveProject);
  const projects = useRuntimeStore((s) => s.projects);
  const current =
    projectId === DEFAULT_PROJECT
      ? t("group.defaultProject")
      : (projects.find((p) => p.id === projectId)?.name ?? t("group.defaultProject"));
  const choices = [
    { id: DEFAULT_PROJECT, name: t("group.defaultProject") },
    ...[...projects].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ id: p.id, name: p.name })),
  ];
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          aria-label={t("group.projectMenu")}
          title={t("group.projectMenu")}
          // A phone gives the width to the Screens: icon and caret, no gaps.
          className={cn(
            "flex h-7 max-w-[180px] shrink-0 items-center rounded-md text-[12px] font-medium text-text hover:bg-surface-2",
            compact ? "gap-0.5 px-1" : "mr-1 gap-1 px-2",
          )}
        >
          <Folder size={13} className="shrink-0 text-accent" />
          {/* A phone keeps the width for the Screens; the menu names the project. */}
          {!compact && <span className="truncate">{current}</span>}
          <ChevronDown size={12} className="shrink-0 text-muted" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          className="z-50 max-h-[60vh] min-w-[200px] overflow-y-auto rounded-card border border-border bg-surface p-1 text-[13px] text-text shadow-pop"
        >
          {choices.map((c) => (
            <DropdownMenu.Item
              key={c.id || "default"}
              onSelect={() => setActiveProject(c.id)}
              className="flex cursor-pointer items-center gap-2 rounded-input px-2 py-1.5 outline-none data-[highlighted]:bg-surface-2"
            >
              <Check size={13} className={cn("shrink-0", c.id === projectId ? "text-accent" : "invisible")} />
              <span className="truncate">{c.name}</span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * Which Screens a browser signed in with the TOKEN is showing: the desktop
 * window's own, followed live, or a set of its own kept in this browser.
 * Absent everywhere else — the window has only its own, and an account only
 * ever has its own.
 */
function LayoutSourceSwitcher() {
  const { t } = useTranslation("session");
  const compact = useIsMobile();
  const webUser = useRuntimeStore((s) => s.webUser);
  const [source, setSource] = useState<LayoutSource>(layoutSource);
  const [busy, setBusy] = useState(false);
  if (!isGatewayWeb || webUser) return null;
  const choose = async (next: LayoutSource) => {
    if (next === source || busy) return;
    setBusy(true);
    try {
      await switchLayoutSource(next);
      setSource(next);
    } finally {
      setBusy(false);
    }
  };
  const choices: { id: LayoutSource; label: string; hint: string }[] = [
    { id: "desktop", label: t("group.sourceDesktop"), hint: t("group.sourceDesktopHint") },
    { id: "own", label: t("group.sourceOwn"), hint: t("group.sourceOwnHint") },
  ];
  const Icon = source === "desktop" ? Monitor : UserRound;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          aria-label={t("group.sourceMenu")}
          title={t("group.sourceMenu")}
          className={cn(
            "flex h-7 shrink-0 items-center rounded-md text-[12px] text-muted hover:bg-surface-2 hover:text-text",
            compact ? "gap-0.5 px-1" : "mr-1 gap-1 px-2",
          )}
        >
          <Icon size={13} className="shrink-0" />
          {!compact && (
            <span className="truncate">{source === "desktop" ? t("group.sourceDesktop") : t("group.sourceOwn")}</span>
          )}
          <ChevronDown size={12} className="shrink-0" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          className="z-50 w-[280px] rounded-card border border-border bg-surface p-1 text-[13px] text-text shadow-pop"
        >
          {choices.map((c) => (
            <DropdownMenu.Item
              key={c.id}
              onSelect={() => void choose(c.id)}
              className="flex cursor-pointer items-start gap-2 rounded-input px-2 py-1.5 outline-none data-[highlighted]:bg-surface-2"
            >
              <Check size={13} className={cn("mt-0.5 shrink-0", c.id === source ? "text-accent" : "invisible")} />
              <span className="min-w-0">
                <span className="block">{c.label}</span>
                <span className="block text-[12px] leading-snug text-muted">{c.hint}</span>
              </span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * Does closing this Screen need a confirmation?
 *
 * Two Screens are worth nothing and close on the click: an empty one, and the
 * tentative preview a sidebar click just opened and nobody has touched since
 * (`ephemeralGroupId` — any real interaction pins it, #3). EVERYTHING else asks
 * first, including a Screen restored by a relaunch: what a Screen holds is not
 * knowable from the layout alone, and closing one the user had arranged and
 * worked in is not a thing to do on a stray click.
 *
 * An earlier version of this asked only when it could SEE something to lose (an
 * unsent line, more than one pane). That was wrong the moment the app was
 * reopened: restored Screens carry real work and it looked like nothing.
 */
function closeNeedsConfirm(group: LayoutGroup, ephemeralGroupId: string | null): boolean {
  if (!group.tree) return false;
  return group.id !== ephemeralGroupId;
}

/**
 * What a pane is called wherever it is named on its own: in the Screen bar
 * (a Screen is named after its first pane) and in the phone's pane switcher.
 */
export function usePaneNames() {
  const { t } = useTranslation(["session", "nav"]);
  const sessions = useRuntimeStore((s) => s.sessions);
  /** A conversation's Screen is named after the conversation — the first few
   *  words of its title, once the runtime has generated one. */
  const sessionTitle = (sessionId: string): string | null => {
    const title = sessions.find((x) => x.id === sessionId)?.title;
    return title && !isPlaceholderTitle(title) ? shortTitle(title) : null;
  };
  /** What to call a Screen that holds a surface rather than a conversation.
   *  A file keeps its own name — that is the most useful thing a tab can say —
   *  and the fixed surfaces use the name they are known by elsewhere. */
  const describe = (content: PaneContent): string | null => {
    switch (content.kind) {
      case "terminal":
        // The name the user gave it, when they gave it one: a Screen holding
        // the "build" terminal should say so in the strip.
        return content.name || t("session:terminal.title");
      case "files":
        return t("nav:items.files");
      case "notebook":
      case "editor":
        return content.path.split("/").pop() || null;
    }
  };
  return { describe, sessionTitle };
}

export function GroupTabs() {
  const { t } = useTranslation(["session", "nav"]);
  const allGroups = useLayoutStore((s) => s.groups);
  const projectId = useLayoutStore(selectActiveProjectId);
  // Only the active project's Screens: the bar is that project's.
  const groups = projectGroups(allGroups, projectId);
  const activeGroupId = useLayoutStore((s) => s.activeGroupId);
  const ephemeralGroupId = useLayoutStore((s) => s.ephemeralGroupId);
  const setActiveGroup = useLayoutStore((s) => s.setActiveGroup);
  const closeGroup = useLayoutStore((s) => s.closeGroup);
  const renameGroup = useLayoutStore((s) => s.renameGroup);

  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  const overlayTitlebar = useOverlayTitlebar();
  const isMac = navigator.userAgent.includes("Mac");

  const compact = useIsMobile();
  const stripRef = useTransientScrollbar();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmCloseId, setConfirmCloseId] = useState<string | null>(null);
  // The Screen on display is always in view: on a narrow bar the strip
  // scrolls, and a switch from elsewhere (a sidebar click, a link) can land on
  // a tab scrolled out of sight.
  useEffect(() => {
    document
      .querySelector(`[data-group-tab="${CSS.escape(activeGroupId)}"]`)
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeGroupId]);
  const { describe, sessionTitle } = usePaneNames();
  const fallback = (n: number) => t("group.defaultName", { n });
  const sessions = useRuntimeStore((s) => s.sessions);
  /** The Screen's panes, as a reference an agent can act on (null if none can be talked to). */
  const screenRef = (g: LayoutGroup, i: number) =>
    screenReference(
      g,
      groupLabel(g, i, fallback, describe, sessionTitle, t("nav:history.draft"), t("home.tab")),
      (id) => sessions.find((x) => x.id === id),
    );

  return (
    <>
      <div
        data-tauri-drag-region={overlayTitlebar || undefined}
        style={overlayTitlebar ? overlayTitlebarStyle(sidebarCollapsed) : undefined}
        className={cn(
          // `select-none`: right-clicking a tab used to select its name.
          "flex shrink-0 select-none items-center gap-1 border-b border-faint px-2",
          !overlayTitlebar && "h-9",
        )}
      >
        {/* Sidebar expand button: only when collapsed, and it lives here since this
            strip has taken over the top row (traffic-light clearance included). */}
        {sidebarCollapsed && (
          <button
            onClick={() => setSidebarCollapsed(false)}
            aria-label={t("nav:sidebar.expand")}
            title={t("nav:sidebar.expandTitle", { shortcut: isMac ? "⌘B" : "Ctrl+B" })}
            className="fade-in mr-0.5 rounded p-1 text-text hover:bg-surface-2"
          >
            <PanelLeft size={14} strokeWidth={1.5} />
          </button>
        )}
        {/* This row is `flex-1`, so it covers the whole width left of the edge —
            the empty space beside the tabs included. A bare drag region applies
            to DIRECT clicks only (Tauri walks the composed path and requires
            `el === target`), so without the attribute here the only draggable
            part of the header was the hairline above and below this row. Tabs
            and the + button stay undraggable: a tab is never the drag element
            itself, and Tauri treats <button> as clickable, which blocks drag. */}
        <ProjectSwitcher />
        <LayoutSourceSwitcher />
        <div
          data-tauri-drag-region={overlayTitlebar || undefined}
          ref={stripRef}
          className={cn("flex min-w-0 flex-1 items-center gap-1 overflow-x-auto", compact && "scrollbar-transient")}
        >
          {groups.map((g, i) => {
            const active = g.id === activeGroupId;
            const ephemeral = g.id === ephemeralGroupId;
            return (
              <ContextMenu
                key={g.id}
                label={t("group.tabMenu")}
                items={
                  <>
                    {/* A home is named for what it is; a name given there would never show. */}
                    {g.tree && (
                      <ContextMenuItem
                        icon={<Pencil size={14} />}
                        onSelect={() => requestAnimationFrame(() => setEditingId(g.id))}
                      >
                        {t("group.rename")}
                      </ContextMenuItem>
                    )}
                    {screenRef(g, i) && (
                      <ContextMenuItem
                        icon={<Link2 size={14} />}
                        onSelect={() => {
                          const ref = screenRef(g, i);
                          if (ref) void copyReference(ref, t("reference.copied"));
                        }}
                      >
                        {t("reference.copy")}
                      </ContextMenuItem>
                    )}
                    <ContextMenuItem
                      icon={<X size={14} />}
                      danger
                      onSelect={() => setConfirmCloseId(g.id)}
                    >
                      {t("group.close")}
                    </ContextMenuItem>
                  </>
                }
              >
              <div
                // Dock-drag target: hovering this tab mid-drag switches screens (#4).
                data-group-tab={g.id}
                onClick={() => setActiveGroup(g.id)}
                onDoubleClick={() => g.tree && setEditingId(g.id)}
                className={cn(
                  "group/tab flex h-7 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[12px] transition-colors",
                  active ? "bg-surface-2 text-text" : "text-muted hover:bg-surface-2/60",
                  // A tentative (preview) screen reads italic, like a browser preview tab.
                  ephemeral && "italic",
                )}
                title={t("group.renameHint")}
              >
                {editingId === g.id ? (
                  <InlineName
                    initial={g.name}
                    placeholder={groupLabel(g, i, fallback, describe, sessionTitle, t("nav:history.draft"), t("home.tab"))}
                    onCommit={(name) => {
                      renameGroup(g.id, name);
                      setEditingId(null);
                    }}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <span className="max-w-[160px] truncate">{groupLabel(g, i, fallback, describe, sessionTitle, t("nav:history.draft"), t("home.tab"))}</span>
                )}
                {/* Close empties a project's last Screen, so on one already
                    empty — its home — it would do nothing: no button. */}
                {!(groups.length === 1 && !g.tree) && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (closeNeedsConfirm(g, ephemeralGroupId)) setConfirmCloseId(g.id);
                    else closeGroup(g.id);
                  }}
                  aria-label={t("group.close")}
                  className={cn(
                    "-mr-1 rounded p-0.5 text-muted hover:bg-border hover:text-text",
                    active ? "opacity-70" : "opacity-0 group-hover/tab:opacity-70",
                  )}
                >
                  <X size={12} />
                </button>
                )}
              </div>
              </ContextMenu>
            );
          })}
          {/* A new Screen is a new conversation in this project — never an
              empty Screen the user then has to fill. */}
          <NewScreenButton onNewScreen={(agentId) => void startSessionScreen(projectId, agentId)} />
        </div>
      </div>
      {confirmCloseId && (
        <ConfirmDialog
          title={t("group.confirmCloseScreen.title")}
          body={t("group.confirmCloseScreen.body")}
          confirmLabel={t("group.confirmCloseScreen.action")}
          onConfirm={() => {
            closeGroup(confirmCloseId);
            setConfirmCloseId(null);
          }}
          onCancel={() => setConfirmCloseId(null)}
        />
      )}
    </>
  );
}

/** OpenCode's title for a session it has not summarized yet ("New session -
 *  <timestamp>", "Child session - …"): not a name worth showing on a tab. */
export function isPlaceholderTitle(title: string): boolean {
  return /^(New|Child) session - \d{4}-\d{2}-\d{2}T/.test(title);
}

/** The first few words of a title, sized for a tab: 16 columns, a CJK
 *  character counting as two. */
export function shortTitle(title: string, columns = 16): string {
  let width = 0;
  let out = "";
  for (const ch of title.trim()) {
    width += /[\u2e80-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(ch) ? 2 : 1;
    if (width > columns) return `${out.trimEnd()}…`;
    out += ch;
  }
  return out;
}

/** Inline rename field for a group tab; commits on Enter/blur, cancels on Esc. */
