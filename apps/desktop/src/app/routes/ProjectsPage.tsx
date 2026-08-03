import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  MoreHorizontal,
  Pencil,
  Pin,
  Search,
} from "lucide-react";
import type { SessionMeta } from "@ai4s/sdk";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { cn } from "@/lib/cn";
import { useRuntimeStore } from "@/lib/runtime";
import { timeAgo } from "@/lib/relativeTime";
import { openProjectFolder, renameProject, type ProjectInfo } from "@/lib/tauri";
import { isGatewayWeb } from "@/lib/webMode";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

/** The last path segment (folder name) of an absolute workspace path. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

interface Row extends ProjectInfo {
  updated: number;
  sessions: SessionMeta[];
}

export function ProjectsPage() {
  const { t } = useTranslation(["nav", "common"]);
  const navigate = useNavigate();
  const projects = useRuntimeStore((s) => s.projects);
  const sessions = useRuntimeStore((s) => s.sessions);
  const setProjectPinned = useRuntimeStore((s) => s.setProjectPinned);
  const deleteProject = useRuntimeStore((s) => s.deleteProject);

  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<ProjectInfo | null>(null);

  // A stable "now" for the render pass so every row formats against one instant.
  const now = Date.now();

  // Top-level sessions grouped by their workspace path, newest first.
  // Normalize paths so trailing slashes don't split a project's sessions
  // into a separate bucket that never matches the project path.
  const normPath = (p: string) => p.replace(/[\\/]+$/, "");
  const sessionsByPath = useMemo(() => {
    const map = new Map<string, SessionMeta[]>();
    for (const s of sessions) {
      if (s.parentId || !s.directory) continue;
      const key = normPath(s.directory);
      const list = map.get(key) ?? [];
      list.push(s);
      map.set(key, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
    }
    return map;
  }, [sessions]);

  const rows: Row[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects
      .map((p) => {
        const projectSessions = sessionsByPath.get(normPath(p.path)) ?? [];
        const latest = projectSessions[0]?.updated ?? 0;
        return { ...p, sessions: projectSessions, updated: Math.max(latest, p.createdAt) };
      })
      .filter((p) => !q || p.name.toLowerCase().includes(q))
      .sort((a, b) => b.updated - a.updated);
  }, [projects, sessionsByPath, query]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submitRename = async (p: ProjectInfo, name: string) => {
    setRenamingId(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed === p.name) return;
    try {
      await renameProject(p.id, trimmed);
      await useRuntimeStore.getState().refreshProjects();
    } catch {
      /* keep the old name on failure */
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-8">
        <h1 className="font-serif text-2xl leading-tight text-text">{t("projects.heading")}</h1>

        <div className="relative mt-5">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("projects.pageSearch")}
            className="w-full rounded-full border border-border bg-surface py-2.5 pl-10 pr-4 text-sm text-text outline-none placeholder:text-muted focus:border-accent"
          />
        </div>

        {/* Column headers. The fixed 14rem Sources column would leave the name
            no width at all on a phone — below md it is dropped entirely. */}
        <div className="mt-6 grid grid-cols-[minmax(0,1fr)_4rem_auto] items-center gap-3 border-b border-border px-2 pb-2 text-xs font-medium text-muted md:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_5rem_5rem]">
          <span className="whitespace-nowrap">{t("projects.colName")}</span>
          <span className="hidden whitespace-nowrap md:block">{t("projects.colSources")}</span>
          <span className="whitespace-nowrap">{t("projects.colUpdated")}</span>
          <span />
        </div>

        {rows.length === 0 ? (
          <p className="px-2 py-10 text-center text-sm text-muted">{t("projects.noResults")}</p>
        ) : (
          <div className="divide-y divide-border">
            {rows.map((p) => {
              const open = expanded.has(p.id);
              return (
                <div key={p.id}>
                  <div className="group grid grid-cols-[minmax(0,1fr)_4rem_auto] items-center gap-3 px-2 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_5rem_5rem]">
                    {/* Name (+ expand) */}
                    <div className="flex min-w-0 items-center gap-2">
                      <button
                        onClick={() => toggle(p.id)}
                        aria-label={p.name}
                        aria-expanded={open}
                        className="flex min-w-0 items-center gap-2 text-left outline-none"
                      >
                        {p.sessions.length > 0 ? (
                          open ? (
                            <ChevronDown size={14} className="shrink-0 text-muted" />
                          ) : (
                            <ChevronRight size={14} className="shrink-0 text-muted" />
                          )
                        ) : (
                          <Folder size={15} className="shrink-0 text-muted" />
                        )}
                        {renamingId === p.id ? null : (
                          <span className="truncate text-sm font-medium text-text">{p.name}</span>
                        )}
                      </button>
                      {renamingId === p.id && (
                        <RenameInput
                          defaultValue={p.name}
                          onSubmit={(v) => void submitRename(p, v)}
                          onCancel={() => setRenamingId(null)}
                        />
                      )}
                      {p.imported && (
                        <span
                          className="shrink-0 rounded bg-surface-2 px-1 text-[9px] uppercase tracking-wide text-muted"
                          title={p.importedFrom ?? p.path}
                        >
                          {t("projects.importedBadge")}
                        </span>
                      )}
                    </div>

                    {/* Sources — click to open the folder in the OS file manager. */}
                    <div className="hidden min-w-0 md:block">
                      <button
                        onClick={() => void openProjectFolder(p.id)}
                        disabled={isGatewayWeb}
                        title={t("projects.openFolder", { path: p.path })}
                        className="inline-flex max-w-full items-center gap-1.5 truncate rounded-md border border-border bg-surface px-2 py-1 text-xs text-text outline-none enabled:hover:border-accent enabled:hover:bg-surface-2 disabled:cursor-default"
                      >
                        <Folder size={12} className="shrink-0 text-muted" />
                        <span className="truncate">{baseName(p.path)}</span>
                      </button>
                    </div>

                    {/* Updated */}
                    <span className="text-sm tabular-nums text-muted">{timeAgo(p.updated, now)}</span>

                    {/* Actions — rename/remove/pin/open are host-local; hidden in web. */}
                    {!isGatewayWeb && (
                    <div className="flex items-center justify-end gap-0.5">
                      <DropdownMenu.Root>
                        <DropdownMenu.Trigger asChild>
                          <button
                            aria-label={t("projects.more")}
                            title={t("projects.more")}
                            className="rounded p-1 text-muted opacity-0 outline-none hover:bg-surface-2 hover:text-text group-hover:opacity-100 data-[state=open]:opacity-100 max-md:opacity-100"
                          >
                            <MoreHorizontal size={15} />
                          </button>
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content
                            align="end"
                            sideOffset={4}
                            className="z-50 min-w-[160px] rounded-card border border-border bg-surface p-1 text-[13px] text-text shadow-pop"
                          >
                            <DropdownMenu.Item
                              onSelect={() => setConfirmRemove(p)}
                              className="flex cursor-pointer items-center gap-2 rounded-input px-2 py-1.5 text-error outline-none data-[highlighted]:bg-surface-2"
                            >
                              {t("projects.remove")}
                            </DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu.Root>
                      <button
                        onClick={() => void setProjectPinned(p.id, !p.pinned)}
                        aria-label={p.pinned ? t("projects.unpin") : t("projects.pin")}
                        title={p.pinned ? t("projects.unpin") : t("projects.pin")}
                        className={cn(
                          "rounded p-1 outline-none hover:bg-surface-2",
                          p.pinned
                            ? "text-accent opacity-100"
                            : "text-muted opacity-0 hover:text-text group-hover:opacity-100 max-md:opacity-100",
                        )}
                      >
                        <Pin size={14} className={cn(p.pinned && "fill-current")} />
                      </button>
                      <button
                        onClick={() => setRenamingId(p.id)}
                        aria-label={t("projects.rename")}
                        title={t("projects.rename")}
                        className="rounded p-1 text-muted opacity-0 outline-none hover:bg-surface-2 hover:text-text group-hover:opacity-100 max-md:opacity-100"
                      >
                        <Pencil size={14} />
                      </button>
                    </div>
                    )}
                  </div>

                  {/* Expanded sessions */}
                  {open && (
                    <div className="pb-2">
                      {p.sessions.length === 0 ? (
                        <p className="px-8 py-2 text-xs text-muted">{t("projects.noSessions")}</p>
                      ) : (
                        p.sessions.map((s) => (
                          <button
                            key={s.id}
                            onClick={() => navigate(`/live/${s.id}`)}
                            className="grid w-full grid-cols-[minmax(0,1fr)_5rem_1.5rem] items-center gap-3 rounded-input py-1.5 pl-8 pr-2 text-left hover:bg-surface-2"
                          >
                            <span className="truncate text-sm text-text">{s.title}</span>
                            <span className="text-xs tabular-nums text-muted">{timeAgo(s.updated, now)}</span>
                            <ChevronRight size={14} className="justify-self-end text-muted" />
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {confirmRemove && (
        <ConfirmDialog
          title={t("projects.removeTitle", { name: confirmRemove.name })}
          body={t(
            confirmRemove.importMode === "copy"
              ? "projects.removeCopyBody"
              : "projects.removeBody",
          )}
          confirmLabel={t("projects.remove")}
          onConfirm={() => {
            void deleteProject(confirmRemove.id);
            setConfirmRemove(null);
          }}
          onCancel={() => setConfirmRemove(null)}
        />
      )}
    </div>
  );
}

/** Inline rename input used in the Name cell. */
function RenameInput({
  defaultValue,
  onSubmit,
  onCancel,
}: {
  defaultValue: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <input
      ref={ref}
      autoFocus
      defaultValue={defaultValue}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSubmit(e.currentTarget.value);
        else if (e.key === "Escape") onCancel();
      }}
      onBlur={(e) => onSubmit(e.currentTarget.value)}
      className="min-w-0 flex-1 rounded-input border border-accent/50 bg-surface px-2 py-0.5 text-sm text-text outline-none focus:border-accent"
    />
  );
}
