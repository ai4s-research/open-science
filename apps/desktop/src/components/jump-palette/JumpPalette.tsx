import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Command, defaultFilter } from "cmdk";
import { useNavigate } from "react-router-dom";
import { Folder, LayoutGrid, MessageSquare, Plus, Terminal as TerminalIcon } from "lucide-react";
import { selectActiveProjectId, useLayoutStore } from "@/lib/layout";
import { startSessionScreen, useRuntimeStore } from "@/lib/runtime";
import { timeAgo } from "@/lib/relativeTime";
import { jumpEntries, type JumpEntry, type JumpSection } from "@/lib/jumpEntries";
import { useIsMobile } from "@/lib/useIsMobile";
import { isGatewayWeb } from "@/lib/webMode";

const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

/** ⌘J on macOS; Ctrl+Shift+J elsewhere, as in Orca — a bare Ctrl+J is a line
 *  feed, which a terminal must keep receiving. Exported so the terminal can
 *  leave the chord to the app. */
export function isJumpChord(e: KeyboardEvent): boolean {
  if (e.key.toLowerCase() !== "j" || e.altKey) return false;
  return isMac ? e.metaKey && !e.ctrlKey && !e.shiftKey : e.ctrlKey && e.shiftKey && !e.metaKey;
}

/** Before anything is typed: where the user most likely goes — one screen of
 *  rows. Once typing: everything that can match. */
const IDLE_SECTIONS: JumpSection[] = ["actions", "recent"];
const SEARCH_SECTIONS: JumpSection[] = ["actions", "projects", "screens", "panes", "sessions", "newIn"];

/** Match on what the row SAYS — its label and where it lives — not on its
 *  value, which is an internal id ("pane:p12") that would match anything. */
const matchShown = (_value: string, search: string, keywords?: string[]) =>
  defaultFilter((keywords ?? []).join(" "), search);

/**
 * ⌘J: jump to any project, Screen, open pane or session by typing its name —
 * Orca's worktree jump palette (MIT), in this app's Project → Screens → panes
 * shape. ⌘K stays the command palette; this one is about WHERE to go.
 */
export function JumpPalette() {
  const { t } = useTranslation(["nav", "session"]);
  const navigate = useNavigate();
  const [open, setOpenState] = useState(false);
  // Read synchronously by the key handler: whether Esc is ours has to be known
  // while the event is still being dispatched, or it also reaches the session
  // page and interrupts a running turn.
  const openRef = useRef(false);
  const [search, setSearch] = useState("");
  // The highlighted row, so ⌘↵ knows what to open beside.
  const [selected, setSelected] = useState("");
  const setOpen = (next: boolean) => {
    openRef.current = next;
    setOpenState(next);
    if (!next) setSearch("");
  };
  // Screens are a desktop surface; web and phone show a single pane.
  const enabled = !useIsMobile() && !isGatewayWeb;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (isJumpChord(e)) {
        e.preventDefault();
        setOpen(!openRef.current);
      } else if (e.key === "Escape" && openRef.current) {
        // Consume Esc only while open, so it does not also interrupt a turn.
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);

  const groups = useLayoutStore((s) => s.groups);
  const activeGroupId = useLayoutStore((s) => s.activeGroupId);
  const sessions = useRuntimeStore((s) => s.sessions);
  const projects = useRuntimeStore((s) => s.projects);

  const entries = useMemo(
    () =>
      open
        ? jumpEntries({
            groups,
            activeGroupId,
            sessions,
            projects,
            labels: {
              defaultProject: t("session:group.defaultProject"),
              terminal: t("session:terminal.title"),
              files: t("nav:items.files"),
              session: t("nav:jump.sections.sessions"),
              screen: (n) => t("session:group.defaultName", { n }),
              newSession: (project) => t("nav:jump.actions.newSession", { project }),
              newTerminal: (project) => t("nav:jump.actions.newTerminal", { project }),
              projectDetail: (count, last) =>
                count === 0
                  ? t("nav:jump.projectEmpty")
                  : t("nav:jump.projectDetail", { count, ago: timeAgo(last, Date.now()) }),
            },
          })
        : [],
    [open, groups, activeGroupId, sessions, projects, t],
  );

  if (!open) return null;
  const close = () => setOpen(false);

  const run = async (entry: JumpEntry) => {
    close();
    const layout = useLayoutStore.getState();
    const target = entry.target;
    switch (target.kind) {
      case "project":
        layout.setActiveProject(target.projectId);
        navigate("/live");
        return;
      case "screen":
        layout.setActiveGroup(target.groupId);
        navigate("/live");
        return;
      case "pane":
        layout.setActiveGroup(target.groupId);
        layout.focusLeaf(target.leafId);
        navigate(target.sessionId ? `/live/${target.sessionId}` : "/live");
        return;
      case "session":
        layout.openSessionEphemeral(target.sessionId, target.projectId);
        navigate(`/live/${target.sessionId}`);
        return;
      case "action": {
        const runtime = useRuntimeStore.getState();
        const projectId = target.projectId ?? selectActiveProjectId(layout);
        const project = runtime.projects.find((p) => p.id === projectId);
        const path = project?.path ?? runtime.workspace ?? undefined;
        // eslint-disable-next-line i18next/no-literal-string -- PaneContent kind, not UI copy
        if (target.action === "newTerminal") layout.addGroup({ kind: "terminal", cwd: path });
        // A new session in the project, aimed at its folder (Default: a dated one).
        else await startSessionScreen(projectId);
        navigate("/live");
        return;
      }
    }
  };

  /** ⌘↵ on a conversation that is not open anywhere: open it in a pane
   *  beside the current one rather than in place — the palette's ⌘-click. */
  const openBeside = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
    const entry = entries.find((x) => x.id === selected);
    if (entry?.target.kind !== "session") return;
    e.preventDefault();
    close();
    // eslint-disable-next-line i18next/no-literal-string -- SplitDir enum, not UI copy
    useLayoutStore.getState().split("row", entry.target.sessionId);
    navigate(`/live/${entry.target.sessionId}`);
  };
  const sections = search.trim() ? SEARCH_SECTIONS : IDLE_SECTIONS;

  const icon = (entry: JumpEntry) => {
    switch (entry.target.kind) {
      case "action":
        return <Plus size={15} />;
      case "project":
        return <Folder size={15} />;
      case "screen":
        return <LayoutGrid size={15} />;
      case "pane":
        return entry.target.sessionId ? <MessageSquare size={15} /> : <TerminalIcon size={15} />;
      case "session":
        return <MessageSquare size={15} />;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 pt-[14vh]" onClick={close}>
      {/* A dialog, so an Esc a running turn would take for an interrupt is
          recognised as the palette's whichever listener runs first. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("nav:jump.ariaLabel")}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl"
      >
        <Command
          label={t("nav:jump.ariaLabel")}
          filter={matchShown}
          value={selected}
          onValueChange={setSelected}
          onKeyDown={openBeside}
          className="overflow-hidden rounded-card border border-border bg-surface shadow-pop"
        >
          <Command.Input
            autoFocus
            value={search}
            onValueChange={setSearch}
            placeholder={t("nav:jump.placeholder")}
            className="w-full border-b border-border bg-transparent px-4 py-3 text-sm text-text outline-none placeholder:text-muted"
          />
          <Command.List className="max-h-[60vh] overflow-y-auto p-2">
            <Command.Empty className="px-3 py-6 text-center text-sm text-muted">{t("nav:jump.noResults")}</Command.Empty>
            {sections.map((section) => {
              const rows = entries.filter((e) => e.section === section);
              if (rows.length === 0) return null;
              return (
                <Command.Group
                  key={section}
                  heading={t(`nav:jump.sections.${section}`)}
                  className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-muted"
                >
                  {rows.map((entry) => (
                    <Command.Item
                      key={entry.id}
                      value={entry.id}
                      keywords={[entry.label, entry.detail ?? ""]}
                      onSelect={() => void run(entry)}
                      className="flex cursor-pointer items-center gap-3 rounded-input px-3 py-2 text-sm text-text data-[selected=true]:bg-surface-2"
                    >
                      <span className="shrink-0 text-muted">{icon(entry)}</span>
                      <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                      {entry.detail && <span className="max-w-[45%] shrink-0 truncate text-xs text-muted">{entry.detail}</span>}
                    </Command.Item>
                  ))}
                </Command.Group>
              );
            })}
          </Command.List>
          {/* What the keys do, said once at the bottom rather than learned by accident. */}
          <div className="flex items-center gap-4 border-t border-border px-4 py-2 text-[11px] text-muted">
            {/* eslint-disable i18next/no-literal-string -- key names, not UI copy */}
            <span><Kbd>↵</Kbd> {t("nav:jump.hints.open")}</span>
            <span><Kbd>{isMac ? "⌘↵" : "Ctrl ↵"}</Kbd> {t("nav:jump.hints.beside")}</span>
            <span className="ml-auto"><Kbd>esc</Kbd> {t("nav:jump.hints.close")}</span>
            {/* eslint-enable i18next/no-literal-string */}
          </div>
        </Command>
      </div>
    </div>
  );
}

/** A key name in a hint line. */
function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="mr-1 rounded border border-border bg-surface-2 px-1 py-px font-sans text-[10.5px] text-text/80">{children}</kbd>;
}
