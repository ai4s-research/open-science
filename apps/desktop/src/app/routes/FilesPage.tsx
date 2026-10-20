import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronRight,
  Dna,
  FileText,
  Film,
  FlaskConical,
  Folder,
  FolderSymlink,
  Image as ImageIcon,
  Highlighter,
  Loader2,
  NotebookPen,
  Sheet,
  X,
} from "lucide-react";
import { extOf, extToKind, previewKindForName, type PreviewKind } from "@/lib/artifacts";
import { listDir, type DirEntry } from "@/lib/artifactFile";
import { isTauri, unlinkProjectFolder, workspaceBase } from "@/lib/tauri";
import { isGatewayWeb } from "@/lib/webMode";
import { useIsMobile } from "@/lib/useIsMobile";
import { useRuntimeStore } from "@/lib/runtime";
import { useLayoutStore } from "@/lib/layout";
import { isWithin, pathKey, samePath } from "@/lib/workspacePath";
import { toast } from "@/lib/toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useNavigate } from "react-router-dom";
import { baseName } from "@/components/thread/WorkspaceChip";
import { NotebookEditor } from "@/components/notebook/NotebookEditor";
import { FilePreviewInspector } from "@/components/inspector/FilePreviewInspector";
import { FileContextMenu } from "@/components/files/FileContextMenu";
import { PaneTitlebarInset, PANE_HEADER, PANE_ICON_BUTTON } from "@/components/inspector/RightPane";
import { cn } from "@/lib/cn";
import { useOverlayTitlebar } from "@/lib/store";

const EXT_LANG: Record<string, string> = {
  py: "python", r: "r", jl: "julia", sh: "bash", tex: "latex", md: "markdown",
};

const FILE_LOCATIONS_KEY = "openscience.files.locations.v1";
const GLOBAL_FILES_LOCATION = "base";

function safeDirectory(value: unknown): string {
  if (typeof value !== "string" || value.startsWith("/") || value.includes("\\")) return "";
  return value.split("/").some((part) => part === "..") ? "" : value;
}

function fileLocations(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const value = JSON.parse(window.localStorage.getItem(FILE_LOCATIONS_KEY) ?? "{}") as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).map(([key, dir]) => [key, safeDirectory(dir)]),
    );
  } catch {
    return {};
  }
}

function rememberedDirectory(key: string): string {
  return fileLocations()[key] ?? "";
}

function rememberDirectory(key: string, dir: string): void {
  if (typeof window === "undefined") return;
  const locations = fileLocations();
  locations[key] = safeDirectory(dir);
  try {
    window.localStorage.setItem(FILE_LOCATIONS_KEY, JSON.stringify(locations));
  } catch {
    // Browsing still works when storage is unavailable or full.
  }
}

function iconFor(entry: DirEntry) {
  if (entry.link) return <FolderSymlink size={15} className="text-accent" />;
  if (entry.isDir) return <Folder size={15} className="text-accent" />;
  const kind = previewKindForName(entry.name);
  const cls = "text-muted";
  if (entry.name.endsWith(".ipynb")) return <NotebookPen size={15} className={cls} />;
  if (kind === "image" || kind === "fits" || kind === "anomaly" || kind === "phase") return <ImageIcon size={15} className={cls} />;
  if (kind === "video") return <Film size={15} className={cls} />;
  if (kind === "table") return <Sheet size={15} className={cls} />;
  if (kind === "molecule" || kind === "dos" || kind === "bands") return <FlaskConical size={15} className={cls} />;
  if (kind === "genome") return <Dna size={15} className={cls} />;
  if (kind === "qcode") return <Highlighter size={15} className={cls} />;
  return <FileText size={15} className={cls} />;
}

/**
 * Unlinking a project's linked folder from its row: the link the move put in
 * the project folder (see `LinkedFolder`). Asks first; only the link and its
 * index entry go — the folder it points at is never touched. A link the app did
 * not make has no owner and offers nothing.
 */
function useUnlinkFolder(onDone: () => void) {
  const { t } = useTranslation("pages");
  const projects = useRuntimeStore((s) => s.projects);
  const refreshProjects = useRuntimeStore((s) => s.refreshProjects);
  const [pending, setPending] = useState<{ projectId: string; path: string } | null>(null);
  const ownerOf = (entry: DirEntry) => {
    if (!entry.link || !isTauri) return null;
    for (const p of projects) {
      const l = p.linked?.find((x) => samePath(x.path, entry.link) && x.link.split(/[\\/]/).pop() === entry.name);
      if (l) return { projectId: p.id, path: l.path };
    }
    return null;
  };
  const dialog = pending && (
    <ConfirmDialog
      title={t("files.linked.unlinkTitle")}
      body={t("files.linked.unlinkBody")}
      confirmLabel={t("files.linked.unlink")}
      // eslint-disable-next-line i18next/no-literal-string -- dialog tone, not UI copy
      tone="default"
      onConfirm={() => {
        const { projectId, path } = pending;
        setPending(null);
        void unlinkProjectFolder(projectId, path)
          .then(refreshProjects)
          .then(onDone)
          .catch((e) => toast.error(e instanceof Error ? e.message : String(e)));
      }}
      onCancel={() => setPending(null)}
    />
  );
  return { ownerOf, request: setPending, dialog };
}

/** A row's name, and — for a linked folder — a quiet tag saying so, with where
 *  it really is on hover. */
function EntryName({ entry }: { entry: DirEntry }) {
  const { t } = useTranslation("pages");
  return (
    <>
      <span className="flex-1 truncate">{entry.name}</span>
      {entry.link && (
        <span className="shrink-0 rounded px-1 text-[11px] text-muted" title={entry.link}>
          {t("files.linked.tag")}
        </span>
      )}
    </>
  );
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * GLOBAL file explorer: browses from the base folder (Settings → Workspace),
 * which contains the structured `projects/` and `sessions/` collections — not
 * the active session only.
 * Directories are navigable via a breadcrumb; files open in the same viewers
 * used elsewhere (figures, tables, PDF, molecule, genome tracks, notebooks),
 * so all past work is reachable in one place.
 */
export function FilesPage({
  onOpenFile,
  onClose,
}: {
  onOpenFile?: (entry: DirEntry) => void;
  /** In a pane: the ✕ goes at the end of the breadcrumb row, since this page
   *  has no title bar of its own and the pane adds none. */
  onClose?: () => void;
} = {}) {
  const { t } = useTranslation(["pages", "common"]);
  const isMobile = useIsMobile();
  const overlayTitlebar = useOverlayTitlebar();
  // Base-relative; "" = the base folder. Persisted client-side so returning to
  // Files continues from the directory the user was browsing.
  const [dir, setDirState] = useState(() => rememberedDirectory(GLOBAL_FILES_LOCATION));
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<DirEntry | null>(null);
  // The base folder's path, for the root crumb (name + full path on hover).
  const [basePath, setBasePath] = useState<string | null>(null);
  useEffect(() => {
    void workspaceBase().then(setBasePath).catch(() => {});
  }, []);

  const setDir = (next: string) => {
    rememberDirectory(GLOBAL_FILES_LOCATION, next);
    setDirState(next);
  };

  const load = useCallback(async (rel: string) => {
    setEntries(null);
    setError(null);
    try {
      setEntries(await listDir(rel, "base"));
    } catch (e) {
      if (rel) {
        rememberDirectory(GLOBAL_FILES_LOCATION, "");
        setDirState("");
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
      setEntries([]);
    }
  }, []);

  useEffect(() => {
    void load(dir);
  }, [dir, load]);
  const unlink = useUnlinkFolder(() => void load(dir));

  const open = (entry: DirEntry) => {
    if (entry.isDir) {
      setSelected(null);
      setDir(entry.path);
      return;
    }
    // In a pane the caller opens the file beside the tree; as a route there is
    // nowhere to put it but here, so the page takes itself over.
    if (onOpenFile) onOpenFile(entry);
    else setSelected(entry);
  };

  const crumbs = dir ? dir.split("/") : [];
  // In a pane the file opens BESIDE this one, so there is nothing to preview
  // here: the tree takes the whole pane, the way a file tree does in VS Code or
  // in Orca's sidebar. Keeping the preview column gave every Files pane a dead
  // half reading "Select a file to preview it here" that could never fill.
  const isTree = Boolean(onOpenFile);

  // Phone-width: the fixed 288px list + preview can't share the screen, so the
  // page becomes single-pane — the list fills the width, opening a file swaps
  // to a full-width preview, and its Close button returns to the list.
  return (
    <div className="flex h-full min-h-0">
      <div
        className={cn(
          "flex flex-col",
          isTree
            ? "w-full"
            : cn("border-r border-border", isMobile ? cn("w-full", selected && "hidden") : "w-72 shrink-0"),
        )}
      >
        {/* PANE_HEADER's 32px, so its line meets the preview header's; the
            window drags from it since the page has no titlebar strip above. */}
        <div
          data-tauri-drag-region={overlayTitlebar || undefined}
          className={cn(PANE_HEADER, "gap-0.5 overflow-x-auto whitespace-nowrap px-3 text-[13px]")}
        >
          <button
            className={cn("rounded px-1 hover:bg-surface-2", dir ? "text-link" : "font-medium text-text")}
            onClick={() => setDir("")}
            title={basePath ?? undefined}
          >
            {baseName(basePath)}
          </button>
          {crumbs.map((part, i) => {
            const to = crumbs.slice(0, i + 1).join("/");
            const isLast = i === crumbs.length - 1;
            return (
              <span key={to} className="flex items-center gap-0.5">
                <ChevronRight size={13} className="text-muted" />
                <button
                  className={cn("rounded px-1 hover:bg-surface-2", isLast ? "font-medium text-text" : "text-link")}
                  onClick={() => setDir(to)}
                >
                  {part}
                </button>
              </span>
            );
          })}
          {onClose && (
            <>
              <div className="flex-1" />
              <button
                onClick={onClose}
                aria-label={t("files.pane.closeAria")}
                className="rounded p-1 text-muted hover:bg-border hover:text-error"
              >
                <X size={13} strokeWidth={1.5} />
              </button>
            </>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {entries === null && (
            <div className="flex items-center gap-2 p-2 text-sm text-muted">
              <Loader2 size={14} className="animate-spin" /> {t("files.loading")}
            </div>
          )}
          {error && <div className="p-2 text-sm text-error">{error}</div>}
          {entries && entries.length === 0 && !error && (
            <div className="p-2 text-sm text-muted">
              {isTauri || isGatewayWeb ? t("files.folderEmpty") : t("files.explorerUnavailableWeb")}
            </div>
          )}
          {entries?.map((entry) => (
            <FileContextMenu
              key={entry.path}
              entry={entry}
              root="base"
              onUnlink={unlink.ownerOf(entry) ? () => unlink.request(unlink.ownerOf(entry)) : undefined}
            >
              <button
                onClick={() => open(entry)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-input px-2 py-1.5 text-left text-[13px] hover:bg-surface-2",
                  selected?.path === entry.path ? "bg-surface-2 text-text" : "text-text/90",
                )}
              >
                {iconFor(entry)}
                <EntryName entry={entry} />
                {!entry.isDir && <span className="shrink-0 text-[11px] text-muted">{humanSize(entry.size)}</span>}
                {entry.isDir && <ChevronRight size={14} className="shrink-0 text-muted" />}
              </button>
            </FileContextMenu>
          ))}
        </div>
      </div>

      {unlink.dialog}
      {!isTree && (
        <div className={cn("min-h-0 flex-1", isMobile && !selected && "hidden")}>
          {selected ? (
            <FilePreview key={selected.path} entry={selected} root="base" onClose={() => setSelected(null)} />
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted">
              {t("files.selectFilePrompt")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FilePreview({
  entry,
  root,
  onClose,
  controls,
}: {
  entry: DirEntry;
  root: "workspace" | "base";
  onClose: () => void;
  controls?: React.ReactNode;
}) {
  const ext = extOf(entry.name);
  if (ext === "ipynb")
    return <NotebookEditor path={entry.path} root={root} onClose={onClose} controls={controls} />;
  const kind: PreviewKind = previewKindForName(entry.name);
  return (
    <FilePreviewInspector
      data={{
        variant: "file",
        path: entry.path,
        filename: entry.name,
        artifact: extToKind(ext),
        language: EXT_LANG[ext] ?? (kind === "text" ? ext : undefined),
        root,
      }}
      onClose={onClose}
      controls={controls}
    />
  );
}

/**
 * Compact browser for the CURRENT session's folder, shown in the right
 * inspector pane beside the conversation (the session-scoped quick entry —
 * the Files page itself is global). Clicking a file swaps the pane to its
 * preview; closing the preview returns to the list.
 */
export function SessionFilesPane({
  sessionId,
  sessionDir,
  onClose,
  controls,
}: {
  sessionId: string;
  sessionDir?: string;
  onClose: () => void;
  /** Pane-level header buttons (e.g. maximize), rendered before Close. */
  controls?: React.ReactNode;
}) {
  const { t } = useTranslation(["pages", "common"]);
  const workspace = useRuntimeStore((s) => s.workspace);
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const locationKey = `session:${sessionId}`;
  const [dir, setDirState] = useState(() => rememberedDirectory(locationKey));
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<DirEntry | null>(null);
  const [reloads, setReloads] = useState(0);

  const setDir = (next: string) => {
    setSelected(null);
    rememberDirectory(locationKey, next);
    setDirState(next);
  };

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    listDir(dir, "workspace", sessionDir)
      .then((e) => {
        if (!cancelled) setEntries(e);
      })
      .catch((e) => {
        if (!cancelled) {
          if (dir) {
            rememberDirectory(locationKey, "");
            setDirState("");
            return;
          }
          setError(e instanceof Error ? e.message : String(e));
          setEntries([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [dir, locationKey, sessionDir, reloads]);
  const unlink = useUnlinkFolder(() => setReloads((n) => n + 1));

  // A linked folder lives outside this session's folder — this pane cannot go
  // there — so it opens where it really is, in the Files explorer: beside the
  // conversation on desktop, as the page on phone and web.
  const [base, setBase] = useState<string | null>(null);
  useEffect(() => {
    void workspaceBase().then(setBase).catch(() => {});
  }, []);
  const openLinked = (target: string) => {
    if (!base || !isWithin(target, base) || samePath(target, base)) {
      toast.error(t("files.linked.outsideBase", { path: target }));
      return;
    }
    rememberDirectory(GLOBAL_FILES_LOCATION, pathKey(target).slice(pathKey(base).length + 1));
    // eslint-disable-next-line i18next/no-literal-string -- PaneContent kind, not UI copy
    if (!isMobile && !isGatewayWeb) useLayoutStore.getState().openContentPane({ kind: "files" });
    else navigate("/files");
  };

  if (selected) {
    return (
      <FilePreview
        entry={selected}
        root="workspace"
        onClose={() => setSelected(null)}
        controls={controls}
      />
    );
  }

  const crumbs = dir ? dir.split("/") : [];
  return (
    <div className="flex h-full flex-col">
      {unlink.dialog}
      <div className={PANE_HEADER}>
        <PaneTitlebarInset />
        <Folder size={13} strokeWidth={1.5} className="shrink-0 text-muted" />
        <span
          className="min-w-0 truncate text-[13px] font-medium text-text"
          title={sessionDir ?? workspace ?? undefined}
        >
          {baseName(sessionDir ?? workspace)}
        </span>
        <span className="shrink-0 truncate text-[11px] text-muted">
          {t("files.pane.subtitle")}
        </span>
        <div className="flex-1" />
        {controls}
        <button className={PANE_ICON_BUTTON} aria-label={t("files.pane.closeAria")} onClick={onClose}>
          <X size={13} strokeWidth={1.5} />
        </button>
      </div>
      {crumbs.length > 0 && (
        <div className="flex flex-wrap items-center gap-0.5 border-b border-border px-3 py-2 text-[12px]">
          <button className="rounded px-1 text-link hover:bg-surface-2" onClick={() => setDir("")}>
            {baseName(sessionDir ?? workspace)}
          </button>
          {crumbs.map((part, i) => {
            const to = crumbs.slice(0, i + 1).join("/");
            const isLast = i === crumbs.length - 1;
            return (
              <span key={to} className="flex items-center gap-0.5">
                <ChevronRight size={12} className="text-muted" />
                <button
                  className={cn("rounded px-1 hover:bg-surface-2", isLast ? "font-medium text-text" : "text-link")}
                  onClick={() => setDir(to)}
                >
                  {part}
                </button>
              </span>
            );
          })}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {entries === null && (
          <div className="flex items-center gap-2 p-2 text-sm text-muted">
            <Loader2 size={14} className="animate-spin" /> {t("files.loading")}
          </div>
        )}
        {error && <div className="p-2 text-sm text-error">{error}</div>}
        {entries && entries.length === 0 && !error && (
          <div className="p-2 text-sm text-muted">{t("files.folderEmpty")}</div>
        )}
        {entries?.map((entry) => (
          <FileContextMenu
            key={entry.path}
            entry={entry}
            root="workspace"
            onUnlink={unlink.ownerOf(entry) ? () => unlink.request(unlink.ownerOf(entry)) : undefined}
          >
            <button
              onClick={() =>
                entry.link ? openLinked(entry.link) : entry.isDir ? setDir(entry.path) : setSelected(entry)
              }
              className="flex w-full items-center gap-2 rounded-input px-2 py-1.5 text-left text-[13px] text-text/90 hover:bg-surface-2"
            >
              {iconFor(entry)}
              <EntryName entry={entry} />
              {!entry.isDir && <span className="shrink-0 text-[11px] text-muted">{humanSize(entry.size)}</span>}
              {entry.isDir && <ChevronRight size={14} className="shrink-0 text-muted" />}
            </button>
          </FileContextMenu>
        ))}
      </div>
    </div>
  );
}
