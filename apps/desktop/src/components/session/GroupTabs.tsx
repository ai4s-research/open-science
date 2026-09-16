import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Bot,
  FileText,
  FolderTree,
  NotebookPen,
  Pencil,
  Plus,
  Terminal as TerminalIcon,
  X,
  PanelLeft,
} from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { groupLabel, useLayoutStore, type LayoutGroup, type PaneContent } from "@/lib/layout";
import { createMarkdown, createNotebook } from "@/lib/newFile";
import { toast } from "@/lib/toast";
import { useRuntimeStore } from "@/lib/runtime";
import { detectCliAgents, selectCliAgent, type CliAgent } from "@/lib/cliAgents";
import { useOverlayTitlebar, useUiStore } from "@/lib/store";
import { overlayTitlebarStyle } from "@/lib/titlebar";
import { cn } from "@/lib/cn";
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
function NewScreenButton({ onNewScreen }: { onNewScreen: () => void }) {
  const { t } = useTranslation(["session", "nav"]);
  const [agents, setAgents] = useState<CliAgent[]>([]);
  const [busy, setBusy] = useState(false);
  const addGroup = useLayoutStore((s) => s.addGroup);
  // A terminal opens where the work is. Without it every shell starts in the
  // app's own working directory, which is never where the user's files are.
  const workspace = useRuntimeStore((s) => s.workspace);

  // Once per mount: an install does not appear mid-session, and probing PATH on
  // every open would put a filesystem walk behind a menu.
  useEffect(() => {
    let cancelled = false;
    void detectCliAgents().then((found) => {
      if (!cancelled) setAgents(found);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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

  const run = async (agent: CliAgent) => {
    setBusy(true);
    selectCliAgent(agent);
    onNewScreen();
    // The runtime is chosen when the connection is made, so switching agents
    // means reconnecting — the same path Settings uses.
    await useRuntimeStore.getState().connectRetry(8);
    setBusy(false);
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
            onSelect={onNewScreen}
            className="flex cursor-pointer items-center gap-2 rounded-input px-2 py-1.5 outline-none data-[highlighted]:bg-surface-2"
          >
            <Plus size={13} className="shrink-0 text-muted" />
            {t("group.newTab")}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            // eslint-disable-next-line i18next/no-literal-string -- PaneContent kind, not UI copy
            onSelect={() => openScreen({ kind: "terminal", cwd: workspace ?? undefined })}
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

export function GroupTabs() {
  const { t } = useTranslation(["session", "nav"]);
  const groups = useLayoutStore((s) => s.groups);
  const activeGroupId = useLayoutStore((s) => s.activeGroupId);
  const ephemeralGroupId = useLayoutStore((s) => s.ephemeralGroupId);
  const setActiveGroup = useLayoutStore((s) => s.setActiveGroup);
  const addGroup = useLayoutStore((s) => s.addGroup);
  const closeGroup = useLayoutStore((s) => s.closeGroup);
  const renameGroup = useLayoutStore((s) => s.renameGroup);

  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  const overlayTitlebar = useOverlayTitlebar();
  const isMac = navigator.userAgent.includes("Mac");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmCloseId, setConfirmCloseId] = useState<string | null>(null);
  const fallback = (n: number) => t("group.defaultName", { n });
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
        <div
          data-tauri-drag-region={overlayTitlebar || undefined}
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
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
                    <ContextMenuItem
                      icon={<Pencil size={14} />}
                      onSelect={() => requestAnimationFrame(() => setEditingId(g.id))}
                    >
                      {t("group.rename")}
                    </ContextMenuItem>
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
                onDoubleClick={() => setEditingId(g.id)}
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
                    placeholder={groupLabel(g, i, fallback, describe)}
                    onCommit={(name) => {
                      renameGroup(g.id, name);
                      setEditingId(null);
                    }}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <span className="max-w-[160px] truncate">{groupLabel(g, i, fallback, describe)}</span>
                )}
                {/* Close is always available — closing the last group empties it. */}
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
              </div>
              </ContextMenu>
            );
          })}
          <NewScreenButton onNewScreen={() => addGroup()} />
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

/** Inline rename field for a group tab; commits on Enter/blur, cancels on Esc. */
