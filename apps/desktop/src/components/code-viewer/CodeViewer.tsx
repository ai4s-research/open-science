import { useMemo } from "react";
import hljs from "highlight.js/lib/common";
import { HSCROLL_ATTR } from "@/lib/wheelChain";
// Token colors are theme-scoped in index.css (.hljs-* on --hl-* variables) —
// a stylesheet import here would hardcode one theme for all three.

interface Props {
  code: string;
  language?: string;
  startLine?: number;
}

/** Read-only code with a line-number gutter. Scrolls horizontally; no wrapping. */
export function CodeViewer({ code, language, startLine = 1 }: Props) {
  const html = useMemo(() => {
    try {
      if (language && hljs.getLanguage(language)) {
        return hljs.highlight(code, { language }).value;
      }
      return hljs.highlightAuto(code).value;
    } catch {
      return escapeHtml(code);
    }
  }, [code, language]);

  const lineCount = code.replace(/\n$/, "").split("\n").length;

  return (
    <div
      {...{ [HSCROLL_ATTR]: "" }}
      className="flex overflow-x-auto overflow-y-hidden rounded-input border border-border bg-surface font-mono text-[12.5px] leading-[1.55]"
    >
      <div
        aria-hidden
        className="select-none border-r border-border bg-surface-2 px-3 py-3 text-right text-muted"
      >
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i}>{startLine + i}</div>
        ))}
      </div>
      <pre className="flex-1 overflow-visible px-4 py-3">
        <code className="hljs bg-transparent" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
