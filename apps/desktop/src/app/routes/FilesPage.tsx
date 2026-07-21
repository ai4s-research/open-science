import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronRight,
  Dna,
  FileText,
  Film,
  FlaskConical,
  Folder,
  Image as ImageIcon,
  Highlighter,
  Loader2,
  NotebookPen,
  Sheet,
  X,
} from "lucide-react";
import { extOf, extToKind, previewKindForName, type PreviewKind } from "@/lib/artifacts";
import { listDir, type DirEntry } from "@/lib/artifactFile";
import { isTauri, workspaceBase } from "@/lib/tauri";
import { getClient, useRuntimeStore } from "@/lib/runtime";
import { baseName } from "@/components/thread/WorkspaceChip";
import { NotebookEditor } from "@/components/notebook/NotebookEditor";
import { FilePreviewInspector } from "@/components/inspector/FilePreviewInspector";
import { FileContextMenu } from "@/components/files/FileContextMenu";
import { PaneTitlebarInset } from "@/components/inspector/RightPane";
import { cn } from "@/lib/cn";

const EXT_LANG: Record<string, string> = {
  py: "python", r: "r", jl: "julia", sh: "bash", tex: "latex", md: "markdown",
};

function iconFor(entry: DirEntry) {
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

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * GLOBAL file explorer: browses from the base folder (Settings → Workspace),
 * which holds every session's dated folder — not the active session only.
 * Directories are navigable via a breadcrumb; files open in the same viewers
 * used elsewhere (figures, tables, PDF, molecule, genome tracks, notebooks),
 * so all past work is reachable in one place.
 */
export function FilesPage() {
  const { t } = useTranslation(["pages", "common"]);
  const [dir, setDir] = useState(""); // base-relative; "" = the base folder
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<DirEntry | null>(null);
  // The base folder's path, for the root crumb (name + full path on hover).
  const [basePath, setBasePath] = useState<string | null>(null);
  useEffect(() => {
    void workspaceBase().then(setBasePath).catch(() => {});
  }, []);

  const load = useCallback(async (rel: string) => {
    setEntries(null);
    setError(null);
    try {
      // base-rooted listing — stays on the host layer per RFC §4.2 Decision 2
      // (the seam exposes only the runtime's working dir, not the projects root).
      setEntries(await listDir(rel, "base"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setEntries([]);
    }
  }, []);

  useEffect(() => {
    void load(dir);
  }, [dir, load]);

  const open = (entry: DirEntry) => {
    if (entry.isDir) {
      setSelected(null);
      setDir(entry.path);
    } else {
      setSelected(entry);
    }
  };

  const crumbs = dir ? dir.split("/") : [];

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-72 shrink-0 flex-col border-r border-border">
        <div className="flex flex-wrap items-center gap-0.5 border-b border-border px-3 py-2.5 text-[13px]">
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
              {isTauri ? t("files.folderEmpty") : t("files.explorerUnavailableWeb")}
            </div>
          )}
          {entries?.map((entry) => (
            <FileContextMenu key={entry.path} entry={entry} root="base">
              <button
                onClick={() => open(entry)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-input px-2 py-1.5 text-left text-[13px] hover:bg-surface-2",
                  selected?.path === entry.path ? "bg-surface-2 text-text" : "text-text/90",
                )}
              >
                {iconFor(entry)}
                <span className="flex-1 truncate">{entry.name}</span>
                {!entry.isDir && <span className="shrink-0 text-[11px] text-muted">{humanSize(entry.size)}</span>}
                {entry.isDir && <ChevronRight size={14} className="shrink-0 text-muted" />}
              </button>
            </FileContextMenu>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {selected ? (
          <FilePreview key={selected.path} entry={selected} root="base" onClose={() => setSelected(null)} />
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted">
            {t("files.selectFilePrompt")}
          </div>
        )}
      </div>
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
  onClose,
  controls,
}: {
  onClose: () => void;
  /** Pane-level header buttons (e.g. maximize), rendered before Close. */
  controls?: React.ReactNode;
}) {
  const { t } = useTranslation(["pages", "common"]);
  const workspace = useRuntimeStore((s) => s.workspace);
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<DirEntry | null>(null);

  // A session switch moves the active folder — restart at its root.
  useEffect(() => {
    setSelected(null);
    setDir("");
  }, [workspace]);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    const client = getClient();
    const listing = client ? client.listDir(dir) : Promise.resolve([]);
    listing
      .then((e) => {
        if (!cancelled) setEntries(e);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setEntries([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [dir, workspace]);

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
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <PaneTitlebarInset />
        <Folder size={14} strokeWidth={1.5} className="shrink-0 text-text" />
        <span className="truncate text-sm font-medium text-text" title={workspace ?? undefined}>
          {baseName(workspace)}
        </span>
        <span className="text-xs text-muted">{t("files.pane.subtitle")}</span>
        <div className="flex-1" />
        {controls}
        <button className="text-text hover:opacity-60" aria-label={t("files.pane.closeAria")} onClick={onClose}>
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>
      {crumbs.length > 0 && (
        <div className="flex flex-wrap items-center gap-0.5 border-b border-border px-3 py-2 text-[12px]">
          <button className="rounded px-1 text-link hover:bg-surface-2" onClick={() => setDir("")}>
            {baseName(workspace)}
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
          <FileContextMenu key={entry.path} entry={entry} root="workspace">
            <button
              onClick={() => (entry.isDir ? setDir(entry.path) : setSelected(entry))}
              className="flex w-full items-center gap-2 rounded-input px-2 py-1.5 text-left text-[13px] text-text/90 hover:bg-surface-2"
            >
              {iconFor(entry)}
              <span className="flex-1 truncate">{entry.name}</span>
              {!entry.isDir && <span className="shrink-0 text-[11px] text-muted">{humanSize(entry.size)}</span>}
              {entry.isDir && <ChevronRight size={14} className="shrink-0 text-muted" />}
            </button>
          </FileContextMenu>
        ))}
      </div>
    </div>
  );
}
