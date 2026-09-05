import { useEffect, useRef, useState } from "react";
import { Code2, Download, Eye, ExternalLink, FileSearch, History, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FilePreviewInspector as FilePreviewInspectorT, FileRoot } from "@ai4s/shared";
import { previewKindForName, type PreviewKind } from "@/lib/artifacts";
import {
  base64ToBytes,
  openArtifactExternally,
  previewUrl,
  probeLargeFile,
  readArtifact,
  type LargeFilePointer,
} from "@/lib/artifactFile";
import { isGatewayWeb } from "@/lib/webMode";
import { useRuntimeStore } from "@/lib/runtime";
import { parseTableFile } from "@/lib/csv";
import { formatNumber } from "@/i18n/format";
import { CodeViewer } from "@/components/code-viewer/CodeViewer";
import { MarkdownViewer } from "@/components/markdown-viewer/MarkdownViewer";
import { ProvenancePanel } from "./ProvenancePanel";
import { TablePreview } from "./TablePreview";
import { TableChart } from "./TableChart";
import { canChart } from "@/lib/tableChart";
import { DocxView, PptxView, XlsxView } from "./OfficePreview";
import { MoleculeView } from "./MoleculeView";
import { MeshView } from "./MeshView";
import { GenomeView } from "./GenomeView";
import { FitsView } from "./FitsView";
import { DosView } from "./DosView";
import { BandView } from "./BandView";
import { QCodeView } from "./QCodeView";
import { AnomalyMapView } from "./AnomalyMapView";
import { PhaseView } from "./PhaseView";
import { useScrollMemory } from "@/lib/scrollMemory";
import { useWheelChain } from "@/lib/wheelChain";
import { cn } from "@/lib/cn";
import { samePath } from "@/lib/workspacePath";
import { PaneTitlebarInset } from "./RightPane";

/**
 * Right-pane preview for any workspace file. Strategy (no format conversion):
 * pdf / image / html — served from the local file server (http://127.0.0.1)
 * and rendered by the webview's NATIVE viewers via <iframe>/<img>;
 * csv/tsv — parsed to a table; docx/xlsx/pptx — local JS renderers fed raw
 * bytes; everything else — code/text.
 */
export function FilePreviewInspector({
  data,
  workspaceDirectory,
  onClose,
  controls,
  embedded = false,
  compactHeader = false,
  title,
  onTitlePointerDown,
}: {
  data: FilePreviewInspectorT;
  /** Directory that owns this file. Keeps split-pane previews bound to their
   *  session instead of following whichever session is focused globally. */
  workspaceDirectory?: string;
  onClose?: () => void;
  /** Pane-level header buttons (e.g. maximize), rendered before Close. */
  controls?: React.ReactNode;
  /** Compact chrome when the same native preview is embedded in a message. */
  embedded?: boolean;
  /** Match the 32px header used by tiled Session panes. */
  compactHeader?: boolean;
  /** Optional presentation title; the underlying filename remains unchanged. */
  title?: string;
  /** Dedicated panes use the title as their drag handle. */
  onTitlePointerDown?: React.PointerEventHandler<HTMLSpanElement>;
}) {
  const { t } = useTranslation(["inspector", "common"]);
  const activeWorkspace = useRuntimeStore((s) => s.workspace);
  // Desktop file commands are intentionally scoped to the active workspace.
  // Focusing another split pane changes that workspace asynchronously; do not
  // issue a read against the old root, and do not reload a background preview
  // from the newly focused pane's root.
  const waitingForWorkspace =
    !isGatewayWeb &&
    data.root !== "base" &&
    workspaceDirectory !== undefined &&
    activeWorkspace !== null &&
    !samePath(workspaceDirectory, activeWorkspace);
  const kind = previewKindForName(data.filename);
  const needsUrl = kind === "pdf" || kind === "image" || kind === "html" || kind === "video";
  const needsText =
    kind === "table" || kind === "text" || kind === "html" || kind === "markdown" ||
    kind === "molecule" || kind === "genome" || kind === "qcode" || kind === "anomaly" ||
    kind === "phase";
  const needsBytes =
    kind === "docx" || kind === "xlsx" || kind === "pptx" || kind === "mesh" ||
    kind === "fits" || kind === "dos" || kind === "bands";

  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(data.content ?? null);
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  // Web client: a direct gateway URL for the file — powers img/iframe previews,
  // the text/bytes fetch, and the open/download action.
  const [dl, setDl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"preview" | "code">(kind === "text" ? "code" : "preview");
  const [showHistory, setShowHistory] = useState(false);

  // Clear the previous file even when this pane is currently in the background
  // and must wait for its workspace to become active before loading the next
  // one. A focus change alone does not touch these values.
  useEffect(() => {
    setError(null);
    setLoading(true);
    setText(data.content ?? null);
    setUrl(null);
    setBytes(null);
    setDl(null);
  }, [data.path, data.content, data.root, workspaceDirectory]);

  useEffect(() => {
    let cancelled = false;
    if (waitingForWorkspace) {
      // The preview belongs to a session whose workspace isn't the active one
      // (another split pane has focus). Never spin on "loading" while parked:
      // settle into an explicit wait note, and the effect re-runs the moment
      // the owning workspace gains focus (waitingForWorkspace flips).
      setLoading(false);
      setError(null);
      return () => {
        cancelled = true;
      };
    }
    (async () => {
      try {
        // Web client: everything flows from one gateway file URL — image/pdf via
        // <img>/<iframe>, text/bytes fetched from it, and it doubles as the
        // open/download link. (readArtifact/preview_url are Tauri-only.)
        if (isGatewayWeb) {
          const u = await previewUrl(data.path, data.root, workspaceDirectory);
          if (cancelled) return;
          setDl(u);
          if (needsUrl) setUrl(u);
          if (needsText && data.content === undefined) {
            const r = u ? await fetch(u) : null;
            if (cancelled) return;
            if (r && r.ok) setText(await r.text());
            else if (kind !== "html" && kind !== "markdown") setError(t("filePreview.mobileNoPreview"));
          }
          if (needsBytes) {
            const r = u ? await fetch(u) : null;
            if (cancelled) return;
            if (r && r.ok) setBytes(await r.arrayBuffer());
            else setError(t("filePreview.mobileNoPreview"));
          }
          return;
        }

        if (needsUrl) {
          const u = await previewUrl(data.path, data.root);
          if (cancelled) return;
          setUrl(u);
          // Browser dev has no local server; html can still preview inline content.
          if (!u && kind !== "html") {
            setError(t("filePreview.desktopOnly"));
          }
        }
        if (needsText && data.content === undefined) {
          const f = await readArtifact(data.path, data.root);
          if (cancelled) return;
          if (f && f.encoding === "utf8") setText(f.data);
          // The file was read but isn't text — say so instead of falling
          // through to the "desktop app" note while inside the desktop app.
          else if (f) setError(t("filePreview.binaryNoPreview"));
          else if (kind !== "html" && kind !== "markdown")
            setError(t("filePreview.desktopOnly"));
        }
        if (needsBytes) {
          const f = await readArtifact(data.path, data.root);
          if (cancelled) return;
          if (f && f.encoding === "base64") setBytes(base64ToBytes(f.data));
          else setError(t("filePreview.desktopOnly"));
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `t` intentionally excluded: this effect loads a file, not a UI label; a
    // locale switch mid-load shouldn't re-trigger a network/disk read to refresh
    // an error string.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    data.path,
    data.content,
    data.root,
    kind,
    needsUrl,
    needsText,
    needsBytes,
    waitingForWorkspace,
    workspaceDirectory,
  ]);

  // Open in the OS app on desktop; open/download via the browser in web.
  const openOrDownload = () => {
    if (waitingForWorkspace) return;
    if (isGatewayWeb) {
      if (dl) window.open(dl, "_blank", "noopener");
    } else {
      void openArtifactExternally(data.path, data.root);
    }
  };

  const canToggle =
    kind === "html" || kind === "markdown" || kind === "molecule" || kind === "genome";

  // Where the user was in this file, restored when they come back to it —
  // history browsing keeps its own offset so the two don't clobber each other.
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = useScrollMemory(
    scrollRef,
    showHistory ? `history:${data.path}` : `file:${data.path}`,
    showHistory || !loading,
  );
  // A code or table preview is a horizontal scroll box; without this a vertical
  // trackpad swipe over one moves nothing at all.
  useWheelChain(scrollRef);

  return (
    <div className={cn("flex h-full flex-col", embedded && "overflow-hidden rounded-card border border-border bg-surface")}>
      <header
        className={cn(
          "flex shrink-0 select-none items-center border-b",
          embedded
            ? "h-10 gap-2 border-border px-3"
            : compactHeader
              ? "h-8 gap-1 border-faint px-2.5"
              : "h-12 gap-2 border-border px-4",
        )}
      >
        <PaneTitlebarInset />
        <span
          onPointerDown={onTitlePointerDown}
          className={cn(
            "truncate font-medium text-text",
            compactHeader ? "text-[13px]" : "text-sm",
            onTitlePointerDown && "cursor-grab select-none active:cursor-grabbing",
          )}
          title={title ?? (data.path && data.path !== data.filename ? data.path : data.filename)}
        >
          {title ?? data.path ?? data.filename}
        </span>
        <span className={cn("rounded bg-surface-2 px-1.5 py-0.5 text-muted", compactHeader ? "text-[10px]" : "text-xs")}>
          {t(`filePreview.artifactKind.${data.artifact}`)}
        </span>
        {canToggle && (
          <div className="ml-2 flex items-center gap-1 rounded-input bg-surface-2 p-0.5">
            {/* eslint-disable-next-line i18next/no-literal-string -- "preview" is an internal tab id, not display text (the visible label is t("filePreview.tabs.preview")) */}
            <ToggleBtn active={tab === "preview"} onClick={() => setTab("preview")}>
              <Eye size={13} /> {t("filePreview.tabs.preview")}
            </ToggleBtn>
            {/* eslint-disable-next-line i18next/no-literal-string -- "code" is an internal tab id, not display text (the visible label is t("filePreview.tabs.code")) */}
            <ToggleBtn active={tab === "code"} onClick={() => setTab("code")}>
              <Code2 size={13} /> {t("filePreview.tabs.code")}
            </ToggleBtn>
          </div>
        )}
        <div className="flex-1" />
        <button
          className={cn(showHistory ? "text-accent" : "text-text hover:opacity-60")}
          aria-label={t("filePreview.historyAria")}
          title={t("filePreview.historyTitle")}
          aria-pressed={showHistory}
          onClick={() => setShowHistory((v) => !v)}
        >
          <History size={14} strokeWidth={1.5} />
        </button>
        <button
          className="text-text hover:opacity-60 disabled:cursor-wait disabled:opacity-40"
          aria-label={isGatewayWeb ? t("filePreview.download") : t("filePreview.openExternally")}
          title={isGatewayWeb ? t("filePreview.download") : t("filePreview.openExternallyTitle")}
          onClick={openOrDownload}
          disabled={waitingForWorkspace}
        >
          {isGatewayWeb ? <Download size={14} strokeWidth={1.5} /> : <ExternalLink size={14} strokeWidth={1.5} />}
        </button>
        {controls}
        {onClose && (
          <button className="text-text hover:opacity-60" aria-label={t("shell.closeInspector")} onClick={onClose}>
            <X size={14} strokeWidth={1.5} />
          </button>
        )}
      </header>

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto bg-surface-2">
        {showHistory && <ProvenancePanel path={data.path} language={data.language} />}
        {!showHistory && waitingForWorkspace && (
          <div className="flex items-center gap-2 p-4 text-sm text-muted">
            <Loader2 size={15} className="animate-spin" />{" "}
            {t("filePreview.waitingWorkspace", { filename: data.filename })}
          </div>
        )}
        {!showHistory && loading && (
          <div className="flex items-center gap-2 p-4 text-sm text-muted">
            <Loader2 size={15} className="animate-spin" /> {t("filePreview.loading", { filename: data.filename })}
          </div>
        )}
        {!showHistory && !loading && error && (
          <PreviewError
            error={error}
            filename={data.filename}
            path={data.path}
            root={data.root}
            onOpenExternally={openOrDownload}
          />
        )}
        {!showHistory && !loading && !error && (
          <Body
            kind={kind}
            url={url}
            text={text}
            bytes={bytes}
            showCode={tab === "code"}
            filename={data.filename}
            path={data.path}
            language={data.language}
          />
        )}
      </div>
    </div>
  );
}

function Body({
  kind,
  url,
  text,
  bytes,
  showCode,
  filename,
  path,
  language,
}: {
  kind: PreviewKind;
  url: string | null;
  text: string | null;
  bytes: ArrayBuffer | null;
  showCode: boolean;
  filename: string;
  path: string;
  language?: string;
}) {
  const { t } = useTranslation(["inspector", "common"]);
  if (kind === "docx" || kind === "xlsx" || kind === "pptx") {
    // Office views scroll internally (the outer pane never does), so they
    // carry their own scroll memory, keyed apart from the outer container's.
    if (!bytes) return <Note text={t("filePreview.desktopOnly")} />;
    if (kind === "docx") return <DocxView bytes={bytes} scrollKey={`office:${path}`} />;
    if (kind === "xlsx") return <XlsxView bytes={bytes} scrollKey={`office:${path}`} />;
    return <PptxView bytes={bytes} scrollKey={`office:${path}`} />;
  }
  if (kind === "mesh") {
    return bytes !== null ? (
      <MeshView filename={filename} bytes={bytes} />
    ) : (
      <Note text={t("filePreview.desktopOnly")} />
    );
  }
  if (kind === "fits") {
    return bytes !== null ? (
      <FitsView filename={filename} bytes={bytes} />
    ) : (
      <Note text={t("filePreview.desktopOnly")} />
    );
  }
  if (kind === "dos") {
    return bytes !== null ? (
      <DosView filename={filename} bytes={bytes} />
    ) : (
      <Note text={t("filePreview.desktopOnly")} />
    );
  }
  if (kind === "bands") {
    return bytes !== null ? (
      <BandView filename={filename} bytes={bytes} />
    ) : (
      <Note text={t("filePreview.desktopOnly")} />
    );
  }
  if (kind === "qcode") {
    return text !== null ? (
      <QCodeView filename={filename} text={text} />
    ) : (
      <Note text={t("filePreview.desktopOnly")} />
    );
  }
  if (kind === "anomaly") {
    return text !== null ? (
      <AnomalyMapView filename={filename} text={text} />
    ) : (
      <Note text={t("filePreview.desktopOnly")} />
    );
  }
  if (kind === "phase") {
    return text !== null ? (
      <PhaseView filename={filename} text={text} />
    ) : (
      <Note text={t("filePreview.desktopOnly")} />
    );
  }
  if (kind === "molecule") {
    if (showCode) {
      return text !== null ? (
        <div className="p-3">
          <CodeViewer code={text} language={language} />
        </div>
      ) : (
        <Note text={t("filePreview.sourceDesktopOnly")} />
      );
    }
    return text !== null ? (
      <MoleculeView filename={filename} text={text} />
    ) : (
      <Note text={t("filePreview.desktopOnly")} />
    );
  }
  if (kind === "genome") {
    if (showCode) {
      return text !== null ? (
        <div className="p-3">
          <CodeViewer code={text} language={language} />
        </div>
      ) : (
        <Note text={t("filePreview.sourceDesktopOnly")} />
      );
    }
    return text !== null ? (
      <GenomeView filename={filename} text={text} />
    ) : (
      <Note text={t("filePreview.desktopOnly")} />
    );
  }
  if (kind === "markdown") {
    if (showCode) {
      return text !== null ? (
        <div className="p-3">
          <CodeViewer code={text} language="markdown" />
        </div>
      ) : (
        <Note text={t("filePreview.sourceDesktopOnly")} />
      );
    }
    // A document reads as a page: white paper, black text, whatever the app
    // theme — the same document-neutral canvas the Office previews use.
    return text !== null ? (
      <div className="min-h-full px-6 py-8">
        <div className="mx-auto max-w-[760px] rounded-sm bg-white px-12 py-11 shadow-[0_1px_4px_rgba(0,0,0,.25)] max-sm:px-6 max-sm:py-7">
          <MarkdownViewer variant="document">{text}</MarkdownViewer>
        </div>
      </div>
    ) : (
      <Note text={t("filePreview.desktopOnly")} />
    );
  }
  if (kind === "html" && showCode) {
    return text !== null ? (
      <div className="p-3">
        <CodeViewer code={text} language="html" />
      </div>
    ) : (
      <Note text={t("filePreview.sourceDesktopOnly")} />
    );
  }
  if (kind === "html") {
    // Served URL preferred (relative assets resolve); srcdoc as browser fallback.
    if (url) {
      return (
        <iframe
          title={t("filePreview.htmlPreviewTitle")}
          src={url}
          sandbox="allow-scripts"
          className="h-full min-h-[480px] w-full bg-white"
        />
      );
    }
    if (text !== null) {
      return (
        <iframe
          title={t("filePreview.htmlPreviewTitle")}
          srcDoc={text}
          sandbox="allow-scripts"
          className="h-full min-h-[480px] w-full bg-white"
        />
      );
    }
    return <Note text={t("filePreview.desktopOnly")} />;
  }
  if (kind === "pdf") {
    // The webview's native PDF viewer (WKWebView / WebView2) renders the served URL.
    return url ? (
      <iframe title={t("filePreview.pdfPreviewTitle")} src={url} className="h-full min-h-[480px] w-full" />
    ) : (
      <Note text={t("filePreview.desktopOnly")} />
    );
  }
  if (kind === "image") {
    return url ? (
      <div className="flex justify-center p-4">
        <img src={url} alt={filename} className="max-w-full rounded-sm bg-white shadow-card" />
      </div>
    ) : (
      <Note text={t("filePreview.desktopOnly")} />
    );
  }
  if (kind === "video") {
    // The local file server answers Range requests, so the native <video>
    // element streams and seeks straight from http://127.0.0.1.
    return url ? (
      <div className="flex justify-center p-4">
        <video
          src={url}
          controls
          className="max-h-[80vh] max-w-full rounded-sm bg-black shadow-card"
        />
      </div>
    ) : (
      <Note text={t("filePreview.desktopOnly")} />
    );
  }
  if (kind === "table") {
    return text !== null ? (
      <TableView table={parseTableFile(filename, text)} />
    ) : (
      <Note text={t("filePreview.desktopOnly")} />
    );
  }
  return text !== null ? (
    <div className="p-3">
      <CodeViewer code={text} language={language} />
    </div>
  ) : (
    <Note text={t("filePreview.desktopOnly")} />
  );
}

function Note({ text }: { text: string }) {
  return <div className="p-4 text-sm text-muted">{text}</div>;
}

/** Tabular file preview with a Table ↔ Chart toggle. The Chart tab appears only
 *  when the data has a numeric column to plot (P1-5 native chart surface). */
function TableView({ table }: { table: import("@/lib/csv").ParsedTable }) {
  const { t } = useTranslation(["inspector", "common"]);
  const [view, setView] = useState<"table" | "chart">("table");
  const chartable = canChart(table);
  return (
    <div className="flex h-full flex-col">
      {chartable && (
        <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
          {/* eslint-disable-next-line i18next/no-literal-string -- "table" is an internal view id, not display text (the visible label is t("filePreview.tableView.table")) */}
          <ToggleBtn active={view === "table"} onClick={() => setView("table")}>
            {t("filePreview.tableView.table")}
          </ToggleBtn>
          {/* eslint-disable-next-line i18next/no-literal-string -- "chart" is an internal view id, not display text (the visible label is t("filePreview.tableView.chart")) */}
          <ToggleBtn active={view === "chart"} onClick={() => setView("chart")}>
            {t("filePreview.tableView.chart")}
          </ToggleBtn>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {view === "chart" && chartable ? (
          <TableChart table={table} />
        ) : (
          <TablePreview table={table} />
        )}
      </div>
    </div>
  );
}

/** Preview errors. A "too large" file gets a helpful card — the preview is
 *  capped so a huge file can't lock the app. The user can open it in the OS
 *  app, or **inspect it without loading**: the large-file probe returns a
 *  compact memory pointer (schema / shape / sample / key numbers) by streaming
 *  and sampling, so even a 90 GB file is introspected, never loaded. */
export function PreviewError({
  error,
  filename,
  path,
  root,
  onOpenExternally,
}: {
  error: string;
  filename: string;
  path?: string;
  root?: FileRoot;
  onOpenExternally: () => void;
}) {
  const { t } = useTranslation(["inspector", "common"]);
  const tooLarge = /too large/i.test(error);
  const [pointer, setPointer] = useState<LargeFilePointer | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);

  const inspect = async () => {
    if (!path) return;
    setProbing(true);
    setProbeError(null);
    try {
      setPointer(await probeLargeFile(path, root));
    } catch (e) {
      setProbeError(e instanceof Error ? e.message : String(e));
    } finally {
      setProbing(false);
    }
  };

  if (!tooLarge) return <div className="p-4 text-sm text-muted">{error}</div>;
  return (
    <div className="p-4">
      <div className="rounded-card border border-border bg-surface p-4 text-sm text-muted">
        <div className="mb-1 font-medium text-text">{t("filePreview.tooLarge", { filename })}</div>
        <p className="mb-3">{t("filePreview.tooLargeBody")}</p>
        <div className="flex flex-wrap gap-2">
          {path && (
            <button
              className="inline-flex items-center gap-1.5 rounded-input border border-border bg-surface-2 px-2.5 py-1.5 text-[13px] text-text hover:bg-surface disabled:opacity-60"
              onClick={() => void inspect()}
              disabled={probing}
            >
              {probing ? <Loader2 size={13} className="animate-spin" /> : <FileSearch size={13} />}
              {t("filePreview.inspectWithoutLoading")}
            </button>
          )}
          <button
            className="inline-flex items-center gap-1.5 rounded-input border border-border bg-surface-2 px-2.5 py-1.5 text-[13px] text-text hover:bg-surface"
            onClick={onOpenExternally}
          >
            <ExternalLink size={13} /> {t("filePreview.openExternally")}
          </button>
        </div>
        {probeError && <div className="mt-3 text-[13px] text-error">{probeError}</div>}
        {pointer && <LargeFilePointerPanel p={pointer} />}
      </div>
    </div>
  );
}

/** Render the probe's memory pointer as a compact, readable fact sheet. */
function LargeFilePointerPanel({ p }: { p: LargeFilePointer }) {
  const { t } = useTranslation(["inspector", "common"]);
  if (p.error) return <div className="mt-3 text-[13px] text-error">{p.error}</div>;
  const fmt = (n: number) => formatNumber(n);
  const rows: [string, string][] = [];
  if (p.format) rows.push([t("filePreview.pointer.format"), p.format]);
  if (p.size) rows.push([t("filePreview.pointer.size"), p.size + (p.gzipped ? ` ${t("filePreview.pointer.gzipped")}` : "")]);
  if (p.approx_rows !== undefined) rows.push([t("filePreview.pointer.approxRows"), fmt(p.approx_rows)]);
  if (p.num_rows !== undefined) rows.push([t("filePreview.pointer.rows"), fmt(p.num_rows)]);
  if (p.approx_reads !== undefined) rows.push([t("filePreview.pointer.approxReads"), fmt(p.approx_reads)]);
  if (p.approx_sequences !== undefined) rows.push([t("filePreview.pointer.approxSequences"), fmt(p.approx_sequences)]);
  if (p.approx_variants !== undefined) rows.push([t("filePreview.pointer.approxVariants"), fmt(p.approx_variants)]);
  if (p.n_columns !== undefined) rows.push([t("filePreview.pointer.columns"), fmt(p.n_columns)]);
  if (p.read_length)
    rows.push([
      t("filePreview.pointer.readLength"),
      t("filePreview.pointer.readLengthValue", {
        min: p.read_length.min,
        max: p.read_length.max,
        mean: p.read_length.mean,
      }),
    ]);
  if (p.samples?.length) rows.push([t("filePreview.pointer.samples"), p.samples.join(", ")]);

  return (
    <div className="mt-3 rounded-input border border-border bg-surface-2 p-3">
      {p.hint && <div className="mb-2 text-[13px] text-text">{p.hint}</div>}
      {rows.length > 0 && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[12.5px]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="break-all font-mono text-text">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {p.columns && p.columns.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-[12px] text-muted">{t("filePreview.pointer.schema")}</div>
          <div className="flex flex-wrap gap-1">
            {p.columns.slice(0, 40).map((c) => (
              <span key={c.name} className="rounded bg-surface px-1.5 py-0.5 font-mono text-[11.5px] text-text">
                {c.name} <span className="text-muted">{c.dtype}</span>
              </span>
            ))}
          </div>
        </div>
      )}
      {p.datasets && p.datasets.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-[12px] text-muted">{t("filePreview.pointer.datasets")}</div>
          <div className="flex flex-col gap-0.5 font-mono text-[11.5px] text-text">
            {p.datasets.slice(0, 20).map((d) => (
              <span key={d.path}>{d.path} <span className="text-muted">[{d.shape.join("×")}] {d.dtype}</span></span>
            ))}
          </div>
        </div>
      )}
      {p.sample_ids && p.sample_ids.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-[12px] text-muted">{t("filePreview.pointer.sampleIds")}</div>
          <div className="font-mono text-[11.5px] text-text">{p.sample_ids.slice(0, 5).join(", ")}</div>
        </div>
      )}
      {p.note && <div className="mt-2 text-[11.5px] italic text-muted">{p.note}</div>}
    </div>
  );
}

function ToggleBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 rounded px-2 py-1 text-xs",
        active ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text",
      )}
    >
      {children}
    </button>
  );
}
