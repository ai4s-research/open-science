import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpToLine,
  ExternalLink,
  History,
  Loader2,
  NotebookPen,
  Play,
  Plus,
  RefreshCw,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type { NotebookCell } from "@ai4s/shared";
import { previewUrl, readArtifact, writeWorkspaceFile } from "@/lib/artifactFile";
import { isGatewayWeb } from "@/lib/webMode";
import { useRuntimeStore } from "@/lib/runtime";
import { ProvenancePanel } from "@/components/inspector/ProvenancePanel";
import { PaneTitlebarInset } from "@/components/inspector/RightPane";
import { parseIpynb, serializeIpynb, notebookLanguage } from "@/lib/notebook-file";
import {
  formatExecResult,
  isCodeLanguage,
  kernelExecute,
  kernelReset,
  type KernelLanguage,
} from "@/lib/kernel";
import { toast } from "@/lib/toast";
import { isTauri, jupyterStatus, openJupyterLab, pythonInterpreter } from "@/lib/tauri";
import { useScrollMemory } from "@/lib/scrollMemory";
import { cn } from "@/lib/cn";

/**
 * Runnable editor for a real workspace .ipynb. Used full-page (Notebooks page)
 * and as the right-pane inspector next to a conversation — the agent edits the
 * same file, so Reload picks up its changes.
 */
export function NotebookEditor({
  path,
  root,
  onBack,
  onClose,
  controls,
  compactHeader = false,
}: {
  path: string;
  /** Folder tree `path` resolves in (default the active workspace). The
   *  kernel also runs with the notebook's own folder as cwd. */
  root?: "workspace" | "base";
  /** Back navigation (full-page use). */
  onBack?: () => void;
  /** Close the pane (inspector use). */
  onClose?: () => void;
  /** Pane-level header buttons (e.g. maximize), rendered before Close. */
  controls?: React.ReactNode;
  /** Match the 32px header used by tiled Session panes. */
  compactHeader?: boolean;
}) {
  const { t } = useTranslation(["pages", "common"]);
  const [cells, setCells] = useState<NotebookCell[] | null>(null);
  const [language, setLanguage] = useState<KernelLanguage>("python");
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<number | null>(null);
  const [saved, setSaved] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  // Which interpreter cells run on — shown in the header so "no Python found"
  // is visible before the first run, not after it fails.
  const [pyInfo, setPyInfo] = useState<{ label: string; title: string; ok: boolean } | null>(null);
  // Whether the app-managed Jupyter env exists — gates the "Open in JupyterLab"
  // header button, offered wherever a notebook is viewed.
  const [jupyterInstalled, setJupyterInstalled] = useState(false);
  const [openingLab, setOpeningLab] = useState(false);
  // The selected cell, and whether the keyboard is typing INTO it or driving it
  // (Jupyter's edit vs command mode). Command mode is what makes "select a cell
  // and press a/b" work at all — without it every key is just text (#93).
  const [activeId, setActiveId] = useState<number | null>(null);
  const [mode, setMode] = useState<"edit" | "command">("edit");
  const cellRefs = useRef(new Map<number, HTMLDivElement | null>());
  const codeRefs = useRef(new Map<number, HTMLTextAreaElement | null>());
  /** Set when the keyboard put us into edit mode, so the caret lands at the end. */
  const caretToEnd = useRef(false);
  const cellsRef = useRef<NotebookCell[] | null>(null);
  cellsRef.current = cells;
  const rawRef = useRef<string | null>(null);
  const savedRef = useRef(true);
  savedRef.current = saved;

  // Web client: notebooks are viewed read-only over the gateway — scope reads to
  // the VIEWED session's folder (SessionMeta), not the host's active workspace.
  const sessionDir = useRuntimeStore(
    (s) => (root === "base" ? undefined : s.sessions.find((x) => x.id === s.currentId)?.directory ?? s.workspace ?? undefined),
  );

  // Read the raw .ipynb text — from the gateway in web, from Tauri on desktop.
  const readRaw = useCallback(async (): Promise<string | null> => {
    if (isGatewayWeb) {
      const url = await previewUrl(path, root, sessionDir);
      const r = url ? await fetch(url) : null;
      return r && r.ok ? await r.text() : null;
    }
    const f = await readArtifact(path, root);
    return f && f.encoding === "utf8" ? f.data : null;
  }, [path, root, sessionDir]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const raw = await readRaw();
      if (raw === null) throw new Error("could not read the notebook");
      rawRef.current = raw;
      setLanguage(notebookLanguage(raw));
      setCells(parseIpynb(raw));
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [readRaw]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void jupyterStatus().then((s) => setJupyterInstalled(Boolean(s?.installed)));
  }, []);

  const openLab = async () => {
    setOpeningLab(true);
    try {
      // The lab is rooted at the active workspace, so a "workspace"-rooted
      // notebook's path IS the lab-relative path — deep-link straight to it.
      // A "base" path spans session folders outside that root, so just open home.
      const ok = await openJupyterLab(root === "base" ? undefined : path);
      if (ok) toast.success("Opening JupyterLab in your browser…");
      else toast.error("Set up Jupyter first — Settings → MCP servers → Jupyter.");
    } catch (e) {
      toast.error(`Could not open JupyterLab: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setOpeningLab(false);
    }
  };

  useEffect(() => {
    if (language !== "python") {
      setPyInfo(null);
      return;
    }
    let alive = true;
    void pythonInterpreter().then((info) => {
      if (!alive || !info) return;
      setPyInfo(
        info.resolved
          ? {
              label: info.resolved.split(/[\\/]/).pop() ?? info.resolved,
              title: `${info.resolved} (${info.source})`,
              ok: true,
            }
          : { label: "no Python", title: info.error ?? "no Python found", ok: false },
      );
    });
    return () => {
      alive = false;
    };
  }, [language]);

  // Follow the agent live: while the user isn't mid-edit, poll the file and
  // reload when its content changed on disk (the agent writes via Jupyter).
  useEffect(() => {
    const t = setInterval(() => {
      if (!savedRef.current) return; // never clobber unsaved local edits
      void (async () => {
        try {
          const raw = await readRaw();
          if (raw !== null && rawRef.current !== null && raw !== rawRef.current) {
            rawRef.current = raw;
            setLanguage(notebookLanguage(raw));
            setCells(parseIpynb(raw));
          }
        } catch {
          /* transient read failures are fine */
        }
      })();
    }, 2000);
    return () => clearInterval(t);
  }, [readRaw]);

  const save = useCallback(async () => {
    const current = cellsRef.current;
    if (!current) return;
    try {
      const out = serializeIpynb(current);
      await writeWorkspaceFile(path, out, root);
      rawRef.current = out; // our own write is not an external change
      setSaved(true);
    } catch (e) {
      toast.error(`Could not save: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [path, root]);

  // Debounced autosave: runs AFTER React commits the latest cells, so the file
  // always gets the freshest state (saving inside handlers would race setState).
  useEffect(() => {
    if (saved || !cells) return;
    const t = setTimeout(() => void save(), 500);
    return () => clearTimeout(t);
  }, [cells, saved, save]);

  const update = (index: number, patch: Partial<NotebookCell>) => {
    setCells((c) => c?.map((cell) => (cell.index === index ? { ...cell, ...patch } : cell)) ?? null);
    setSaved(false);
  };

  // True while a user-requested Stop is in flight, so the resulting kernel
  // error renders as "Interrupted", not as a crash.
  const interruptRef = useRef(false);

  const run = async (cell: NotebookCell) => {
    if (running !== null) return;
    setRunning(cell.index);
    update(cell.index, { output: "running…" });
    try {
      const lang = isCodeLanguage(cell.language) ? cell.language : language;
      const res = await kernelExecute(cell.code, lang, path, root);
      update(cell.index, {
        output: res ? formatExecResult(res) : "(local kernel available only in the desktop app)",
      });
    } catch (e) {
      update(cell.index, {
        output: interruptRef.current
          ? "Interrupted — the kernel was restarted; variables were reset."
          : `kernel error: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      interruptRef.current = false;
      setRunning(null);
    }
  };

  // Stop a hung cell: kill THIS notebook's kernel — the blocked execute then
  // errors out and `run` reports the interruption. Reset is best-effort.
  const stop = async () => {
    interruptRef.current = true;
    try {
      await kernelReset(language, path, root);
    } catch {
      /* the execute's own error path reports the state */
    }
  };

  // `index` is a cell's STABLE identity — its React key, and what update/run/
  // remove address it by. It is deliberately not the number shown to the user:
  // serialization follows array order, so the "[n]" label and the aria names
  // come from the position at render time. Renumbering on every structural edit
  // would change the key of every cell below an insert, destroying and
  // rebuilding them — on a big notebook that is a visible freeze.
  const nextId = (list: NotebookCell[]) => list.reduce((m, c) => Math.max(m, c.index), 0) + 1;

  const addCell = () => {
    const cur = cellsRef.current ?? [];
    const created = nextId(cur);
    setCells([...cur, { index: created, language, code: "" }]);
    setActiveId(created);
    setMode("edit");
    setSaved(false);
  };

  /** Insert an empty cell beside the cell with id `id`. `next` is the mode to
   *  land in: typing after a button click, still driving after an `a`/`b` key. */
  const insertCell = (id: number, where: "above" | "below", next: "edit" | "command" = "edit") => {
    const cur = cellsRef.current;
    if (!cur) return;
    const at = cur.findIndex((cell) => cell.index === id);
    if (at < 0) return;
    const created = nextId(cur);
    const pos = where === "above" ? at : at + 1;
    setCells([
      ...cur.slice(0, pos),
      { index: created, language, code: "" },
      ...cur.slice(pos),
    ]);
    setActiveId(created);
    setMode(next);
    setSaved(false);
  };

  const removeCell = (id: number) => {
    const cur = cellsRef.current;
    if (!cur) return;
    const at = cur.findIndex((cell) => cell.index === id);
    if (at < 0) return;
    const rest = cur.filter((cell) => cell.index !== id);
    setCells(rest);
    // Keep a cell selected: the one that slid into this slot, else the last.
    setActiveId(rest.length === 0 ? null : rest[Math.min(at, rest.length - 1)]!.index);
    setMode("command");
    setSaved(false);
  };

  // Where the user was in this notebook, restored when they come back to it
  // (session switch, pane reopen) — once the cells are in, so the offset holds.
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = useScrollMemory(scrollRef, `file:${path}`, cells !== null);

  const onCellKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>, cell: NotebookCell) => {
    if ((e.metaKey || e.ctrlKey || e.shiftKey) && e.key === "Enter") {
      e.preventDefault();
      void run(cell);
      return;
    }
    // Esc leaves the text and drives the cell instead — the same door into
    // command mode Jupyter uses, and the only one that frees bare a/b/j/k.
    if (e.key === "Escape") {
      e.preventDefault();
      setActiveId(cell.index);
      setMode("command");
    }
  };

  /** Command mode: the cell is selected but not being typed into, so single
   *  keys act on the notebook. Modified chords are left to the browser/OS. */
  const onCellCommandKeyDown = (e: KeyboardEvent<HTMLDivElement>, cell: NotebookCell) => {
    // Keys pressed in the textarea BUBBLE to this container, so without these
    // guards typing "ab" in a cell would insert two cells instead of two
    // characters. Only the container's own keys, and only in command mode.
    if (e.target !== e.currentTarget || mode !== "command") return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Selection moves by POSITION; `index` is an opaque id, so it cannot be
    // stepped arithmetically once cells have been inserted or removed.
    const at = cells?.findIndex((c) => c.index === cell.index) ?? -1;
    switch (e.key) {
      case "Enter":
        e.preventDefault();
        caretToEnd.current = true;
        setMode("edit");
        break;
      case "a":
        e.preventDefault();
        insertCell(cell.index, "above", "command");
        break;
      case "b":
        e.preventDefault();
        insertCell(cell.index, "below", "command");
        break;
      case "ArrowUp":
      case "k":
        if (cells && at > 0) {
          e.preventDefault();
          setActiveId(cells[at - 1]!.index);
        }
        break;
      case "ArrowDown":
      case "j":
        if (cells && at >= 0 && at < cells.length - 1) {
          e.preventDefault();
          setActiveId(cells[at + 1]!.index);
        }
        break;
    }
  };

  // Put the caret where the selection now is. Runs only on a real selection or
  // mode change, so it never steals focus from whatever else the user clicked.
  useEffect(() => {
    if (activeId === null) return;
    if (mode === "command") {
      cellRefs.current.get(activeId)?.focus();
      return;
    }
    const code = codeRefs.current.get(activeId);
    code?.focus();
    // Only when edit mode was ENTERED by keyboard: Jupyter drops the caret at
    // the end of the cell. A click must keep the caret where it was clicked.
    if (caretToEnd.current && code) code.setSelectionRange(code.value.length, code.value.length);
    caretToEnd.current = false;
  }, [activeId, mode]);

  return (
    <div className="flex h-full flex-col">
      <div
        className={cn(
          "flex shrink-0 items-center border-b",
          compactHeader
            ? "h-8 gap-1 border-faint px-2.5"
            : "h-12 gap-2 border-border px-4",
        )}
      >
        <PaneTitlebarInset />
        {onBack && (
          <button
            className="text-text hover:opacity-60"
            aria-label={t("notebooks.editor.backAria")}
            onClick={onBack}
          >
            <ArrowLeft size={14} strokeWidth={1.5} />
          </button>
        )}
        <NotebookPen size={14} strokeWidth={1.5} className="shrink-0 text-text" />
        <h1 className="truncate text-[13px] font-medium text-text">{path}</h1>
        <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
          {language === "r" ? t("notebooks.editor.languageR") : t("notebooks.editor.languagePython")}
        </span>
        {pyInfo && (
          <span
            className={cn(
              "hidden shrink-0 font-mono text-[11px] md:inline",
              pyInfo.ok ? "text-muted" : "text-error",
            )}
            title={`${pyInfo.title} — change it in Settings → Local Python kernel`}
          >
            {pyInfo.label}
          </span>
        )}
        <span className="shrink-0 text-xs text-muted">
          {saved ? t("notebooks.editor.saved") : t("notebooks.editor.unsaved")}
        </span>
        <div className="flex-1" />
        {isTauri && jupyterInstalled && (
          <button
            className="flex items-center gap-1 text-text hover:opacity-60 disabled:opacity-40"
            aria-label={t("notebooks.editor.openJupyterLabAria")}
            title={t("notebooks.openJupyterLabTitle")}
            disabled={openingLab}
            onClick={() => void openLab()}
          >
            <ExternalLink size={14} strokeWidth={1.5} />
          </button>
        )}
        <button
          className={cn(showHistory ? "text-accent" : "text-text hover:opacity-60")}
          aria-label={t("notebooks.editor.historyAria")}
          title={t("notebooks.editor.historyTitle")}
          aria-pressed={showHistory}
          onClick={() => setShowHistory((v) => !v)}
        >
          <History size={14} strokeWidth={1.5} />
        </button>
        <button
          className="text-text hover:opacity-60"
          aria-label={t("notebooks.editor.reloadAria")}
          title={t("notebooks.editor.reloadTitle")}
          onClick={() => void load()}
        >
          <RefreshCw size={14} strokeWidth={1.5} />
        </button>
        {controls}
        {onClose && (
          <button
            className="text-text hover:opacity-60"
            aria-label={t("notebooks.editor.closeAria")}
            onClick={onClose}
          >
            <X size={14} strokeWidth={1.5} />
          </button>
        )}
      </div>

      {showHistory && (
        <div className="flex-1 overflow-y-auto bg-surface-2">
          <ProvenancePanel path={path} language={language} />
        </div>
      )}
      <div ref={scrollRef} onScroll={onScroll} className={cn("flex-1 overflow-y-auto", showHistory && "hidden")}>
        <div className="mx-auto max-w-3xl px-6 py-5">
          {error && <div className="text-sm text-error">{error}</div>}
          {!error && !cells && (
            <div className="flex items-center gap-2 text-sm text-muted">
              <Loader2 size={14} className="animate-spin" /> {t("files.loading")}
            </div>
          )}
          {cells?.map((cell, i) => (
            <div
              key={cell.index}
              // Focusable so command mode has somewhere to live; not in the tab
              // order, because Esc from the code is the way in (as in Jupyter).
              ref={(el) => void cellRefs.current.set(cell.index, el)}
              tabIndex={-1}
              onKeyDown={(e) => onCellCommandKeyDown(e, cell)}
              className={cn(
                "group mb-4 rounded-input outline-none",
                mode === "command" &&
                  activeId === cell.index &&
                  "ring-1 ring-accent ring-offset-2 ring-offset-bg",
              )}
            >
              <div className="mb-1 flex items-center gap-2 text-xs text-muted">
                <span className="font-mono">[{i + 1}]</span>
                <span>{cell.language}</span>
                {isCodeLanguage(cell.language) &&
                  (running === cell.index ? (
                    // Always visible while running (not hover-gated): a hung
                    // cell must offer a way out without restarting the app.
                    <button
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-error hover:bg-surface-2"
                      aria-label={`Stop cell ${i + 1}`}
                      title={t("notebooks.editor.stopCellTitle")}
                      onClick={() => void stop()}
                    >
                      <Square size={10} fill="currentColor" />
                      {t("notebooks.editor.stopLabel")}
                    </button>
                  ) : (
                    <button
                      className="hidden items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-surface-2 hover:text-text group-hover:flex"
                      aria-label={`Run cell ${i + 1}`}
                      onClick={() => void run(cell)}
                      disabled={running !== null}
                    >
                      <Play size={11} />
                      {t("notebooks.editor.runLabel")}
                    </button>
                  ))}
                <button
                  className="hidden rounded px-1 py-0.5 hover:bg-surface-2 hover:text-text group-hover:block"
                  aria-label={`Insert cell above ${i + 1}`}
                  onClick={() => insertCell(cell.index, "above")}
                >
                  <ArrowUpToLine size={11} />
                </button>
                <button
                  className="hidden rounded px-1 py-0.5 hover:bg-surface-2 hover:text-text group-hover:block"
                  aria-label={`Insert cell below ${i + 1}`}
                  onClick={() => insertCell(cell.index, "below")}
                >
                  <ArrowDownToLine size={11} />
                </button>
                <button
                  className="hidden rounded px-1 py-0.5 hover:bg-surface-2 hover:text-error group-hover:block"
                  aria-label={`Delete cell ${i + 1}`}
                  onClick={() => removeCell(cell.index)}
                >
                  <Trash2 size={11} />
                </button>
              </div>
              <textarea
                ref={(el) => void codeRefs.current.set(cell.index, el)}
                value={cell.code}
                onChange={(e) => update(cell.index, { code: e.target.value })}
                onKeyDown={(e) => onCellKeyDown(e, cell)}
                // Typing in a cell IS selecting it, however focus got here.
                onFocus={() => {
                  setActiveId(cell.index);
                  setMode("edit");
                }}
                rows={Math.min(Math.max(cell.code.split("\n").length, 1), 14)}
                spellCheck={false}
                className={cn(
                  "w-full resize-none rounded-input border border-border bg-surface p-3 font-mono text-[12.5px] leading-relaxed text-text outline-none focus:border-accent/50",
                  !isCodeLanguage(cell.language) && "bg-surface-2 text-muted",
                )}
                aria-label={`Cell ${i + 1}`}
              />
              {cell.output && (
                <pre className="mt-1.5 whitespace-pre-wrap rounded-input border border-border bg-surface-2 p-3 font-mono text-[12px] text-text">
                  {cell.output}
                </pre>
              )}
              {cell.image && (
                <img
                  src={`data:image/png;base64,${cell.image}`}
                  alt={`Cell ${cell.index} figure`}
                  className="mt-1.5 max-w-full rounded-input border border-border bg-white p-2"
                />
              )}
            </div>
          ))}
          {cells && (
            <button
              className="flex items-center gap-1.5 rounded-input border border-dashed border-border px-3 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-text"
              onClick={addCell}
            >
              <Plus size={12} /> {t("notebooks.editor.addCellLabel")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
