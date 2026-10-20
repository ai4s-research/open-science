import { useTranslation } from "react-i18next";
import { Command, defaultFilter } from "cmdk";
import { Folder, MessagesSquare, Plus } from "lucide-react";
import { DEFAULT_PROJECT, selectActiveProjectId, useLayoutStore } from "@/lib/layout";
import { useRuntimeStore } from "@/lib/runtime";
import { projectIdForSession } from "@/lib/projectScope";
import { timeAgo } from "@/lib/relativeTime";

const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

/** cmdk row values — internal ids, never shown. */
// eslint-disable-next-line i18next/no-literal-string -- internal id, not UI copy
const DEFAULT_VALUE = "project:default";
const valueOf = (projectId: string) => (projectId ? `project:${projectId}` : DEFAULT_VALUE);

/** Match on the row's name, never on its internal id. */
const matchShown = (_value: string, search: string, keywords?: string[]) =>
  defaultFilter((keywords ?? []).join(" "), search);

/**
 * "New" asks where: the sidebar's New sits above every project, so it cannot
 * say by itself where a conversation would go — this does. Centered, in the
 * same shape as ⌘J.
 *
 * The project on display comes first and is already highlighted, so Enter
 * starts the conversation there: asking costs a keyboard user nothing. The
 * rest follow by when they were last used, then "in no project", then a new
 * project. ⌘T skips the question entirely (the hint says so).
 */
export function NewSessionPicker({
  onPick,
  onNewProject,
  onClose,
}: {
  /** A project id, or DEFAULT_PROJECT for a session in no project. */
  onPick: (projectId: string) => void;
  onNewProject?: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["nav", "session"]);
  const projects = useRuntimeStore((s) => s.projects);
  const sessions = useRuntimeStore((s) => s.sessions);
  const current = useLayoutStore(selectActiveProjectId);

  const usage = new Map<string, { count: number; last?: number }>();
  for (const s of sessions) {
    if (s.parentId) continue;
    const id = projectIdForSession(s.id, sessions, projects);
    const u = usage.get(id) ?? { count: 0 };
    u.count += 1;
    if (s.updated && (u.last ?? 0) < s.updated) u.last = s.updated;
    usage.set(id, u);
  }
  const now = Date.now();
  const detail = (id: string) => {
    const u = usage.get(id);
    return u ? t("jump.projectDetail", { count: u.count, ago: timeAgo(u.last, now) }) : t("jump.projectEmpty");
  };
  const others = projects
    .filter((p) => p.id !== current)
    .sort((a, b) => (usage.get(b.id)?.last ?? b.createdAt) - (usage.get(a.id)?.last ?? a.createdAt));
  const currentProject = projects.find((p) => p.id === current);
  const noProject = t("newPicker.noProject");

  const row = "flex cursor-pointer items-center gap-3 rounded-input px-3 py-2 text-sm text-text data-[selected=true]:bg-surface-2";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4"
      onClick={onClose}
      // Esc is the picker's: it must not reach the session page and interrupt a turn.
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("newPicker.title")}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md"
      >
        <Command
          label={t("newPicker.title")}
          filter={matchShown}
          defaultValue={valueOf(current)}
          className="overflow-hidden rounded-card border border-border bg-surface shadow-pop"
        >
          <div className="px-4 pb-1 pt-3.5">
            <div className="text-[15px] font-semibold text-text">{t("newPicker.title")}</div>
            <div className="mt-0.5 text-xs text-muted">{t("newPicker.subtitle")}</div>
          </div>
          <Command.Input
            autoFocus
            placeholder={t("newPicker.search")}
            className="w-full border-b border-border bg-transparent px-4 py-2.5 text-sm text-text outline-none placeholder:text-muted"
          />
          <Command.List className="max-h-[50vh] overflow-y-auto p-2">
            <Command.Empty className="px-3 py-6 text-center text-sm text-muted">{t("jump.noResults")}</Command.Empty>
            {/* Where the user is: first, highlighted, Enter. */}
            <Command.Item
              value={valueOf(current)}
              keywords={[currentProject?.name ?? noProject]}
              onSelect={() => onPick(current)}
              className={row}
            >
              {currentProject ? <Folder size={15} className="shrink-0 text-accent" /> : <MessagesSquare size={15} className="shrink-0 text-accent" />}
              <span className="min-w-0 flex-1 truncate">{currentProject?.name ?? noProject}</span>
              <span className="shrink-0 rounded bg-accent/10 px-1.5 py-px text-[11px] text-accent">{t("newPicker.current")}</span>
            </Command.Item>
            {others.map((p) => (
              <Command.Item key={p.id} value={valueOf(p.id)} keywords={[p.name]} onSelect={() => onPick(p.id)} className={row}>
                <Folder size={15} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                <span className="shrink-0 text-xs text-muted">{detail(p.id)}</span>
              </Command.Item>
            ))}
            {current !== DEFAULT_PROJECT && (
              <Command.Item value={DEFAULT_VALUE} keywords={[noProject]} onSelect={() => onPick(DEFAULT_PROJECT)} className={row}>
                <MessagesSquare size={15} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate">{noProject}</span>
                <span className="shrink-0 text-xs text-muted">{detail(DEFAULT_PROJECT)}</span>
              </Command.Item>
            )}
            {onNewProject && (
              <>
                <Command.Separator className="my-1 h-px bg-border" />
                <Command.Item value="new-project" keywords={[t("newPicker.newProject")]} onSelect={onNewProject} className={row}>
                  <Plus size={15} className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate">{t("newPicker.newProject")}</span>
                </Command.Item>
              </>
            )}
          </Command.List>
          <div className="flex items-center gap-4 border-t border-border px-4 py-2 text-[11px] text-muted">
            <span>
              {/* eslint-disable-next-line i18next/no-literal-string -- key name, not UI copy */}
              <Kbd>↵</Kbd> {t("newPicker.hintCreate")}
            </span>
            <span>
              {/* eslint-disable-next-line i18next/no-literal-string -- keyboard shortcut, not UI copy */}
              <Kbd>{isMac ? "⌘T" : "Ctrl T"}</Kbd> {t("newPicker.hintQuick")}
            </span>
            <span className="ml-auto">
              {/* eslint-disable-next-line i18next/no-literal-string -- key name, not UI copy */}
              <Kbd>esc</Kbd> {t("jump.hints.close")}
            </span>
          </div>
        </Command>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="mr-1 rounded border border-border bg-surface-2 px-1 py-px font-sans text-[10.5px] text-text/80">{children}</kbd>;
}
