import { useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, CornerDownLeft, NotebookPen, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { NotebookCell, NotebookInspector as NotebookInspectorT } from "@ai4s/shared";
import { CodeViewer } from "@/components/code-viewer/CodeViewer";
import { PaneTitlebarInset } from "./RightPane";
import { formatExecResult, kernelExecute } from "@/lib/kernel";
import { useScrollMemory } from "@/lib/scrollMemory";
import { useWheelChain } from "@/lib/wheelChain";

export function NotebookInspector({
  data,
  onClose,
  onEvaluate,
  controls,
}: {
  data: NotebookInspectorT;
  onClose: () => void;
  /** Forward the expression to the agent's live kernel (live session only). */
  onEvaluate?: (expr: string) => void;
  /** Pane-level header buttons (e.g. maximize), rendered before Close. */
  controls?: React.ReactNode;
}) {
  const { t } = useTranslation(["inspector", "common"]);
  const [cells, setCells] = useState<NotebookCell[]>(data.cells);
  const [expr, setExpr] = useState("");
  const [busy, setBusy] = useState(false);
  // Viewing position, restored when this notebook is reopened.
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = useScrollMemory(scrollRef, `nb:${data.name}`);
  // Code cells scroll sideways — hand their vertical gestures back to the pane.
  useWheelChain(scrollRef);

  const evaluate = async () => {
    const code = expr.trim();
    if (!code || busy) return;
    const nextIndex = (cells[cells.length - 1]?.index ?? 0) + 1;
    setCells((c) => [...c, { index: nextIndex, language: "python", code, output: t("notebook.running") }]);
    setExpr("");

    const setOutput = (output: string) =>
      setCells((c) => c.map((cell) => (cell.index === nextIndex ? { ...cell, output } : cell)));

    setBusy(true);
    try {
      // Run on the real local Python kernel when in the desktop app.
      const res = await kernelExecute(code);
      if (res) setOutput(formatExecResult(res));
      else if (onEvaluate) {
        onEvaluate(code);
        setOutput(t("notebook.sentToKernel"));
      } else {
        setOutput(t("notebook.localOnly"));
      }
    } catch (e) {
      setOutput(t("notebook.kernelError", { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void evaluate();
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 select-none items-center gap-2 border-b border-border px-4">
        <PaneTitlebarInset />
        <NotebookPen size={14} strokeWidth={1.5} className="text-text" />
        <span className="text-sm font-medium text-text">{t("notebook.title")}</span>
        <div className="flex-1" />
        {controls}
        <button className="text-text hover:opacity-60" aria-label={t("shell.closeInspector")} onClick={onClose}>
          <X size={14} strokeWidth={1.5} />
        </button>
      </header>

      <div className="flex items-center gap-3 border-b border-border px-4 py-2">
        <span className="rounded-input bg-surface-2 px-2 py-1 text-sm font-medium text-text">
          {data.name}
        </span>
        <span className="text-sm text-muted">{t("notebook.sharedWithAgent")}</span>
        <div className="flex-1" />
        {data.live && (
          <span className="flex items-center gap-1 text-sm text-ok">
            <span className="h-1.5 w-1.5 rounded-full bg-ok" /> {t("notebook.live")}
            <ChevronDown size={14} />
          </span>
        )}
      </div>

      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto p-4">
        {cells.map((cell) => (
          <div key={cell.index} className="mb-4">
            <div className="mb-1 flex items-center gap-2 text-xs text-muted">
              <span className="font-mono">[{cell.index}]</span>
              <span>{cell.language}</span>
            </div>
            <CodeViewer code={cell.code} language={cell.language} startLine={1} />
            {cell.output && (
              <div className="mt-2">
                <div className="mb-1 text-xs text-muted">{t("notebook.outputLabel")}</div>
                <pre className="whitespace-pre-wrap rounded-input border border-border bg-surface-2 p-3 font-mono text-[12.5px] text-text">
                  {cell.output}
                </pre>
              </div>
            )}
          </div>
        ))}
      </div>

      <footer className="border-t border-border px-4 py-3">
        <div className="text-sm font-medium text-text">{data.kernelLabel}</div>
        <div className="mt-1 mb-2 text-xs leading-relaxed text-muted">{data.kernelNote}</div>
        <div className="flex items-center gap-2 rounded-input border border-border bg-surface-2 px-3 py-2">
          <span className="font-mono text-xs text-muted">&gt;&gt;&gt;</span>
          <input
            value={expr}
            onChange={(e) => setExpr(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("notebook.exprPlaceholder")}
            className="flex-1 bg-transparent font-mono text-[13px] text-text outline-none placeholder:text-muted"
            aria-label={t("notebook.exprAria")}
          />
          <button
            className="text-muted hover:text-text disabled:opacity-30"
            aria-label={t("notebook.runAria")}
            onClick={() => void evaluate()}
            disabled={!expr.trim() || busy}
          >
            <CornerDownLeft size={15} />
          </button>
        </div>
      </footer>
    </div>
  );
}
