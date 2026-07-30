import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Archive,
  ArchiveRestore,
  Download,
  FolderInput,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Search,
  Trash2,
} from "lucide-react";
import type { SessionMeta } from "@ai4s/sdk";
import { cn } from "@/lib/cn";
import { getClient, useRuntimeStore } from "@/lib/runtime";
import { useLayoutStore } from "@/lib/layout";
import { timeAgo, timeBucket, type TimeBucket } from "@/lib/relativeTime";
import { exportIndex, sessionToMarkdown } from "@/lib/exportSession";
import { useIsMobile } from "@/lib/useIsMobile";
import { isGatewayWeb } from "@/lib/webMode";
import { isTauri, pickFolder, writeExportFile } from "@/lib/tauri";
import { toast } from "@/lib/toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

/** Rows fetched per request. The server answers a 200-row page in ~10 ms at
 *  5k sessions, so this is about how far the list grows per click, not about
 *  server cost. */
const PAGE = 100;

/** Hard stop on one export run, so "export everything" over a decade of
 *  history cannot become an unbounded background job. */
const EXPORT_MAX = 5000;

/** Typing pause before a search hits the server. */
const SEARCH_DEBOUNCE_MS = 200;

const BUCKETS: TimeBucket[] = ["today", "yesterday", "week", "month", "older"];

/**
 * Every conversation the runtime holds, searchable — the answer to "my old
 * sessions disappeared" (#65), and where a conversation is renamed, filed
 * under a project, archived or exported.
 *
 * Both the search and the paging run on the SERVER. A working researcher's
 * history reaches tens of thousands of conversations (measured: ~645 bytes
 * each, so 3.1 MB at 5k), and pulling all of it into the browser to filter
 * client-side would get slower every month. This page holds only the rows it
 * has actually shown.
 */
export function HistoryPage() {
  const { t, i18n } = useTranslation(["nav", "common"]);
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const projects = useRuntimeStore((s) => s.projects);
  const webReadOnly = useRuntimeStore((s) => s.webReadOnly);
  const status = useRuntimeStore((s) => s.status);
  const renameSession = useRuntimeStore((s) => s.renameSession);
  const moveSessionToWorkspace = useRuntimeStore((s) => s.moveSessionToWorkspace);
  const setSessionArchived = useRuntimeStore((s) => s.setSessionArchived);
  const deleteSession = useRuntimeStore((s) => s.deleteSession);

  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [rows, setRows] = useState<SessionMeta[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SessionMeta | null>(null);
  const [confirmExport, setConfirmExport] = useState(false);
  const [exported, setExported] = useState<number | null>(null);

  useEffect(() => {
    const id = setTimeout(() => setQuery(input.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [input]);

  /** Fetch one page. `reset` starts the list over (a new search or filter). */
  const load = useCallback(
    async (reset: boolean) => {
      const client = getClient();
      if (!client) return;
      setLoading(true);
      try {
        const page = await client.querySessions({
          limit: PAGE,
          cursor: reset ? null : cursor,
          ...(query ? { search: query } : {}),
          ...(showArchived ? { archived: true } : {}),
        });
        // Subagent sessions are internals of their parent conversation, and the
        // cursor deliberately overlaps (it re-reads a shared millisecond), so
        // both are handled here rather than assumed of the server.
        setRows((prev) => {
          const base = reset ? [] : prev;
          const seen = new Set(base.map((s) => s.id));
          return [...base, ...page.sessions.filter((s) => !s.parentId && !seen.has(s.id))];
        });
        setCursor(page.nextCursor);
        setExhausted(page.nextCursor === null);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        setExhausted(true);
      } finally {
        setLoading(false);
      }
    },
    [cursor, query, showArchived],
  );

  // A new search or filter restarts the list. `load` is deliberately not a
  // dependency: it changes with `cursor`, which would re-run this on paging.
  useEffect(() => {
    if (status !== "ready") return;
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, showArchived, status]);

  const projectByPath = useMemo(() => new Map(projects.map((p) => [p.path, p])), [projects]);

  const now = Date.now();
  const byBucket = new Map<TimeBucket, SessionMeta[]>();
  for (const s of rows) {
    const bucket = timeBucket(s.updated ?? s.created, now);
    byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), s]);
  }
  const grouped = BUCKETS.filter((b) => byBucket.has(b)).map(
    (b) => [b, byBucket.get(b)!] as const,
  );

  const open = (id: string) => {
    if (!isMobile && !isGatewayWeb) useLayoutStore.getState().openSessionEphemeral(id);
    navigate(`/live/${id}`);
  };

  const patchRow = (id: string, change: Partial<SessionMeta> | null) =>
    setRows((prev) =>
      change === null
        ? prev.filter((s) => s.id !== id)
        : prev.map((s) => (s.id === id ? { ...s, ...change } : s)),
    );

  const toggleArchived = async (s: SessionMeta) => {
    const archived = s.archived == null;
    if (!(await setSessionArchived(s.id, archived))) return;
    // With "show archived" on, the row stays and only its badge changes;
    // otherwise archiving takes it out of this view.
    if (showArchived) patchRow(s.id, { archived: archived ? Date.now() : undefined });
    else patchRow(s.id, null);
  };

  /** Export everything matching the current search/filter into a folder the
   *  user picks, paging as it goes so a huge history is never held at once. */
  const runExport = async () => {
    setConfirmExport(false);
    const client = getClient();
    if (!client) return;
    const directory = await pickFolder();
    if (!directory) return;

    setExported(0);
    const written: Array<{ session: SessionMeta; file: string }> = [];
    let failed = 0;
    let next: number | null = null;
    try {
      for (;;) {
        const page = await client.querySessions({
          limit: PAGE,
          cursor: next,
          ...(query ? { search: query } : {}),
          ...(showArchived ? { archived: true } : {}),
        });
        for (const s of page.sessions) {
          if (s.parentId) continue;
          if (written.length + failed >= EXPORT_MAX) break;
          try {
            const messages = await client.getMessages(s.id);
            const file = await writeExportFile(directory, s.title, sessionToMarkdown(s, messages));
            written.push({ session: s, file: file.split(/[\\/]/).pop() ?? file });
          } catch {
            // One unreadable conversation must not abandon the whole export.
            failed += 1;
          }
          setExported(written.length);
        }
        if (page.nextCursor === null || written.length + failed >= EXPORT_MAX) break;
        next = page.nextCursor;
      }
      if (written.length > 0) {
        await writeExportFile(directory, "index", exportIndex(written, Date.now()));
      }
      toast.success(
        failed > 0
          ? t("history.exportDonePartial", { count: written.length, failed })
          : t("history.exportDone", { count: written.length }),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setExported(null);
    }
  };

  const canWrite = !webReadOnly;
  const empty = !loading && rows.length === 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-8">
        <div className="flex items-start gap-3">
          <h1 className="min-w-0 flex-1 font-serif text-2xl leading-tight text-text">
            {t("history.pageHeading")}
          </h1>
          {/* Export writes files into a folder the user picks — desktop only. */}
          {isTauri && canWrite && (
            <button
              onClick={() => setConfirmExport(true)}
              disabled={exported !== null}
              className="flex shrink-0 items-center gap-1.5 rounded-input border border-border px-2.5 py-1.5 text-xs text-text hover:bg-surface-2 disabled:opacity-50"
            >
              {exported !== null ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Download size={13} />
              )}
              {exported !== null
                ? t("history.exportProgress", { count: exported })
                : t("history.export")}
            </button>
          )}
        </div>

        <div className="relative mt-5">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
          />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t("history.pageSearch")}
            className="w-full rounded-full border border-border bg-surface py-2.5 pl-10 pr-4 text-sm text-text outline-none placeholder:text-muted focus:border-accent"
          />
          {loading && (
            <Loader2
              size={14}
              className="absolute right-4 top-1/2 -translate-y-1/2 animate-spin text-muted"
            />
          )}
        </div>

        <label className="mt-3 flex w-fit cursor-pointer items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--color-accent)]"
          />
          {t("history.showArchived")}
        </label>

        {empty ? (
          <p className="px-2 py-10 text-center text-sm text-muted">
            {query ? t("history.noResults") : t("history.empty")}
          </p>
        ) : (
          grouped.map(([bucket, group]) => (
            <section key={bucket} className="mt-6">
              <h2 className="px-2 pb-2 text-xs font-medium uppercase tracking-wider text-muted">
                {t(`history.groups.${bucket}`)}
              </h2>
              <div className="divide-y divide-border border-t border-border">
                {group.map((s) => {
                  const owner = s.directory ? projectByPath.get(s.directory) : undefined;
                  return (
                    <div
                      key={s.id}
                      className="group grid grid-cols-[minmax(0,1fr)_3.5rem_auto] items-center gap-3 px-2 py-2.5"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <MessageSquare size={14} className="shrink-0 text-muted" />
                        {renamingId === s.id ? (
                          <RenameInput
                            defaultValue={s.title}
                            onSubmit={(v) => {
                              setRenamingId(null);
                              if (v.trim() && v.trim() !== s.title) {
                                patchRow(s.id, { title: v.trim() });
                                void renameSession(s.id, v);
                              }
                            }}
                            onCancel={() => setRenamingId(null)}
                          />
                        ) : (
                          <button
                            onClick={() => open(s.id)}
                            className="min-w-0 flex-1 truncate text-left text-sm text-text outline-none hover:underline"
                          >
                            {s.title}
                          </button>
                        )}
                        {s.archived != null && (
                          <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted ring-1 ring-border">
                            {t("history.archivedBadge")}
                          </span>
                        )}
                        {owner && (
                          <span
                            className="hidden shrink-0 truncate rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted ring-1 ring-border sm:block"
                            title={owner.path}
                          >
                            {owner.name}
                          </span>
                        )}
                      </div>

                      <span
                        className="text-xs tabular-nums text-muted"
                        title={
                          s.updated ? new Date(s.updated).toLocaleString(i18n.language) : undefined
                        }
                      >
                        {timeAgo(s.updated ?? s.created, now)}
                      </span>

                      {canWrite && (
                        <DropdownMenu.Root>
                          <DropdownMenu.Trigger asChild>
                            <button
                              aria-label={t("history.rowActions", { title: s.title })}
                              className="rounded p-1 text-muted opacity-0 outline-none hover:bg-surface-2 hover:text-text group-hover:opacity-100 data-[state=open]:opacity-100 max-md:opacity-100"
                            >
                              <MoreHorizontal size={15} />
                            </button>
                          </DropdownMenu.Trigger>
                          <DropdownMenu.Portal>
                            <DropdownMenu.Content
                              align="end"
                              sideOffset={4}
                              className="z-50 min-w-[190px] rounded-card border border-border bg-surface p-1 text-[13px] text-text shadow-pop"
                            >
                              <DropdownMenu.Item
                                // Mount the editor only after the menu restores
                                // focus to its trigger — done in the same tick,
                                // that restore blurs the fresh input, and a blur
                                // commits, so the rename never opened.
                                onSelect={() => requestAnimationFrame(() => setRenamingId(s.id))}
                                className="flex cursor-pointer items-center gap-2 rounded-input px-2 py-1.5 outline-none data-[highlighted]:bg-surface-2"
                              >
                                <Pencil size={14} className="shrink-0 text-muted" />
                                {t("history.rename")}
                              </DropdownMenu.Item>
                              <DropdownMenu.Sub>
                                <DropdownMenu.SubTrigger className="flex cursor-pointer items-center gap-2 rounded-input px-2 py-1.5 outline-none data-[highlighted]:bg-surface-2 data-[state=open]:bg-surface-2">
                                  <FolderInput size={14} className="shrink-0 text-muted" />
                                  {t("history.moveTo")}
                                </DropdownMenu.SubTrigger>
                                <DropdownMenu.Portal>
                                  <DropdownMenu.SubContent
                                    sideOffset={4}
                                    className="z-50 max-h-[320px] min-w-[190px] overflow-y-auto rounded-card border border-border bg-surface p-1 text-[13px] text-text shadow-pop"
                                  >
                                    {projects.length === 0 && (
                                      <div className="px-2 py-1.5 text-muted">
                                        {t("history.moveToNone")}
                                      </div>
                                    )}
                                    {projects.map((p) => (
                                      <DropdownMenu.Item
                                        key={p.id}
                                        disabled={p.path === s.directory}
                                        onSelect={() => {
                                          patchRow(s.id, { directory: p.path });
                                          void moveSessionToWorkspace(s.id, p.path);
                                        }}
                                        className={cn(
                                          "flex cursor-pointer items-center gap-2 rounded-input px-2 py-1.5 outline-none data-[highlighted]:bg-surface-2",
                                          p.path === s.directory &&
                                            "cursor-default text-muted opacity-60",
                                        )}
                                      >
                                        <span className="truncate">{p.name}</span>
                                      </DropdownMenu.Item>
                                    ))}
                                  </DropdownMenu.SubContent>
                                </DropdownMenu.Portal>
                              </DropdownMenu.Sub>
                              <DropdownMenu.Item
                                onSelect={() => void toggleArchived(s)}
                                className="flex cursor-pointer items-center gap-2 rounded-input px-2 py-1.5 outline-none data-[highlighted]:bg-surface-2"
                              >
                                {s.archived == null ? (
                                  <>
                                    <Archive size={14} className="shrink-0 text-muted" />
                                    {t("history.archive")}
                                  </>
                                ) : (
                                  <>
                                    <ArchiveRestore size={14} className="shrink-0 text-muted" />
                                    {t("history.restore")}
                                  </>
                                )}
                              </DropdownMenu.Item>
                              <DropdownMenu.Item
                                onSelect={() => setPendingDelete(s)}
                                className="flex cursor-pointer items-center gap-2 rounded-input px-2 py-1.5 text-error outline-none data-[highlighted]:bg-surface-2"
                              >
                                <Trash2 size={14} className="shrink-0" />
                                {t("confirmDelete.deleteAction")}
                              </DropdownMenu.Item>
                            </DropdownMenu.Content>
                          </DropdownMenu.Portal>
                        </DropdownMenu.Root>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          ))
        )}

        {!exhausted && rows.length > 0 && (
          <button
            onClick={() => void load(false)}
            disabled={loading}
            className="mx-auto mt-6 block rounded-input border border-border px-3 py-1.5 text-sm text-text hover:bg-surface-2 disabled:opacity-50"
          >
            {loading ? t("history.loading") : t("history.loadMore")}
          </button>
        )}
      </div>

      {confirmExport && (
        <ConfirmDialog
          title={t("history.exportTitle")}
          body={query ? t("history.exportBodyFiltered", { query }) : t("history.exportBody")}
          confirmLabel={t("history.exportConfirm")}
          onConfirm={() => void runExport()}
          onCancel={() => setConfirmExport(false)}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={t("confirmDelete.sessionTitle")}
          body={t("confirmDelete.sessionBody", { title: pendingDelete.title })}
          confirmLabel={t("confirmDelete.deleteAction")}
          onConfirm={() => {
            patchRow(pendingDelete.id, null);
            void deleteSession(pendingDelete.id);
            setPendingDelete(null);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

/** In-place title editor: Enter or blur saves, Escape reverts. */
function RenameInput({
  defaultValue,
  onSubmit,
  onCancel,
}: {
  defaultValue: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const escaped = useRef(false);
  return (
    <input
      autoFocus
      defaultValue={defaultValue}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSubmit(e.currentTarget.value);
        else if (e.key === "Escape") {
          escaped.current = true;
          onCancel();
        }
      }}
      onBlur={(e) => {
        if (!escaped.current) onSubmit(e.currentTarget.value);
      }}
      className="min-w-0 flex-1 rounded-input border border-accent/50 bg-surface px-2 py-0.5 text-sm text-text outline-none focus:border-accent"
    />
  );
}
