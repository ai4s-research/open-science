import { useMemo } from "react";
import ReactMarkdown, { type Options as ReactMarkdownOptions } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { cn } from "@/lib/cn";
import { HSCROLL_ATTR } from "@/lib/wheelChain";
import { openExternal } from "@/lib/tauri";

/** Two contexts render markdown: chat bubbles (theme colors, compact) and the
 *  file-preview "paper" (document-neutral black-on-white, editorial scale —
 *  like the Office previews, a document keeps its own colors in dark mode). */
type Variant = "chat" | "document";

const STYLES: Record<Variant, Record<string, string>> = {
  chat: {
    // Block gaps are ~a blank line apart, not a half one: long answers were
    // hard to scan because paragraphs ran together (#63).
    // `break-words`: a long URL or file path is one unbreakable word, and a
    // paragraph cannot shrink below it — the message then stuck out past the
    // pane and the whole conversation could be dragged sideways.
    root: "text-[15px] leading-relaxed text-text break-words",
    p: "my-3.5 first:mt-0 last:mb-0",
    a: "text-link underline underline-offset-2",
    code: "rounded bg-surface-2 px-1 py-0.5 font-mono text-[13px] text-link",
    pre: "my-4 overflow-x-auto overflow-y-hidden rounded-input bg-surface-2 p-3 font-mono text-[13px] leading-5 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-text",
    ul: "my-3.5 ml-5 list-disc space-y-1.5",
    ol: "my-3.5 ml-5 list-decimal space-y-1.5",
    h1: "mb-3 mt-6 text-2xl font-semibold first:mt-0",
    h2: "mb-2.5 mt-6 text-xl font-semibold first:mt-0",
    h3: "mb-2 mt-5 text-lg font-semibold first:mt-0",
    h4: "mb-1.5 mt-4 text-base font-semibold first:mt-0",
    blockquote: "my-3.5 border-l-2 border-border pl-3 text-muted",
    hr: "my-4 border-border",
    table: "border-collapse text-sm",
    th: "border border-border bg-surface-2 px-3 py-1.5 text-left font-semibold",
    td: "border border-border px-3 py-1.5",
  },
  // Editorial-blog paper: warm ink on white, serif headings, terracotta accent
  // (#c15f3c — the app's brand). Theme-independent by design: a document reads
  // the same in light or dark mode, so colors are fixed, not tokens.
  //
  // Two font stacks, both explicit so the paper never inherits the app's UI
  // font. Body: a comfortable reading sans (SF/Segoe + PingFang for Chinese).
  // Headings: the finest reading serifs that actually ship on macOS/Windows
  // (Iowan/Charter → Georgia), CJK falling back to Songti.
  document: {
    root: "text-[16px] leading-[1.8] text-[#2b2620] antialiased [font-feature-settings:'liga','kern'] [font-family:-apple-system,'SF_Pro_Text','Segoe_UI','PingFang_SC','Microsoft_YaHei',sans-serif] selection:bg-[#f2d9cd]",
    p: "my-4 tracking-[0.006em] [text-wrap:pretty] first:mt-0 last:mb-0",
    a: "font-medium text-[#bf5a34] underline decoration-[#e2bdac] decoration-1 underline-offset-[3px] transition-colors hover:decoration-[#bf5a34]",
    code: "rounded-[4px] bg-[#f7f0ea] px-1.5 py-0.5 font-mono text-[13px] text-[#a94e2c] ring-1 ring-[#eee0d6]",
    pre: "my-5 overflow-x-auto overflow-y-hidden rounded-lg bg-[#faf6f2] p-4 font-mono text-[13px] leading-6 ring-1 ring-[#ece2d9] [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[#4b433a] [&_code]:ring-0",
    ul: "my-4 ml-[1.15em] list-disc space-y-2 marker:text-[#c98a6b]",
    ol: "my-4 ml-[1.15em] list-decimal space-y-2 marker:text-[13px] marker:font-medium marker:text-[#c98a6b]",
    // Serif display headings give the editorial/blog feel; the stack falls back
    // to system CJK serif so Chinese posts read as editorial too. Tracking stays
    // near-zero — negative tracking crams CJK glyphs.
    h1: "mb-3 mt-10 text-[33px] font-bold leading-[1.25] tracking-[-0.01em] text-[#1c1915] [text-wrap:balance] first:mt-0 [font-family:'Iowan_Old_Style','Charter',Georgia,'Songti_SC','Noto_Serif_CJK_SC',serif]",
    h2: "mb-4 mt-11 flex items-baseline gap-2.5 text-[23px] font-semibold leading-snug tracking-[-0.005em] text-[#1c1915] [text-wrap:balance] before:relative before:top-[0.14em] before:h-[0.82em] before:w-[3px] before:shrink-0 before:rounded-full before:bg-[#c15f3c] before:content-[''] first:mt-0 [font-family:'Iowan_Old_Style','Charter',Georgia,'Songti_SC','Noto_Serif_CJK_SC',serif]",
    h3: "mb-2 mt-8 text-[18.5px] font-semibold leading-snug text-[#2b2620] first:mt-0 [font-family:'Iowan_Old_Style','Charter',Georgia,'Songti_SC','Noto_Serif_CJK_SC',serif]",
    h4: "mb-2 mt-6 text-[12.5px] font-semibold uppercase tracking-[0.08em] text-[#9a8d7c] first:mt-0",
    blockquote: "my-5 rounded-r-md border-l-[3px] border-[#d98c6a] bg-[#faf6f2] py-1.5 pl-5 pr-4 text-[#6b6155] [&_p]:my-1.5",
    hr: "mx-auto my-10 w-12 border-t-2 border-[#e6ddd2]",
    table: "border-collapse text-[14px] tabular-nums",
    th: "border-b-2 border-[#e2d5c8] px-4 py-2.5 text-left font-semibold text-[#1c1915]",
    td: "border-b border-[#efe8df] px-4 py-2.5",
  },
};

// remark-math only recognizes dollar delimiters ($…$ / $$…$$), but models
// often emit the LaTeX bracket forms \(…\) / \[…\] instead, which then show
// as raw source (#51). Normalize brackets to dollars before parsing, leaving
// fenced code and inline code untouched. An unterminated fence runs to the
// end of input, mirroring how markdown itself treats one mid-stream. The
// lookbehinds keep `\\[2pt]`-style LaTeX row breaks from opening a block.
const CODE_OR_BRACKET_MATH =
  /(```|~~~)[\s\S]*?(?:\1|$)|`[^`\n]*`|(?<!\\)\\\[([\s\S]*?)(?<!\\)\\\]|(?<!\\)\\\(([\s\S]*?)(?<!\\)\\\)/g;

function normalizeMathDelimiters(markdown: string): string {
  if (!markdown.includes("\\[") && !markdown.includes("\\(")) return markdown;
  return markdown.replace(CODE_OR_BRACKET_MATH, (match, _fence, display, inline) =>
    display !== undefined ? `$$${display}$$` : inline !== undefined ? `$${inline}$` : match,
  );
}

// Math costs two extra passes over every node of every message — remark-math on
// the mdast, rehype-katex on the hast — and almost no message contains any. The
// parse is the main cost of mounting a conversation, and a screen switch mounts
// every message of every pane at once (#92), so the plugins are attached only
// when a dollar delimiter survived normalization. A `$` that turns out to be
// prose (a price) merely puts us back on the old path for that one message.
type Plugins = Pick<ReactMarkdownOptions, "remarkPlugins" | "rehypePlugins">;
const MATH_PLUGINS: Plugins = {
  remarkPlugins: [remarkGfm, remarkMath],
  rehypePlugins: [[rehypeKatex, { throwOnError: false }]],
};
const PLAIN_PLUGINS: Plugins = { remarkPlugins: [remarkGfm], rehypePlugins: [] };

function pluginsFor(markdown: string): Plugins {
  return markdown.includes("$") ? MATH_PLUGINS : PLAIN_PLUGINS;
}

export function MarkdownViewer({
  children,
  className,
  variant = "chat",
}: {
  children: string;
  className?: string;
  variant?: Variant;
}) {
  const s = STYLES[variant];
  const normalized = useMemo(() => normalizeMathDelimiters(children), [children]);
  const plugins = useMemo(() => pluginsFor(normalized), [normalized]);
  return (
    <div className={cn(s.root, className)}>
      {/* Math (KaTeX) — $…$/$$…$$ natively, \(…\)/\[…\] via the normalization
          above. `throwOnError: false` keeps a malformed expression from
          blanking the whole message — it shows the source in red instead. Both
          math plugins are dropped for a message with no dollar delimiter at
          all; see pluginsFor. */}
      <ReactMarkdown
        {...plugins}
        components={{
          p: ({ children }) => <p className={s.p}>{children}</p>,
          a: ({ children, href }) => (
            <a
              href={href}
              className={s.a}
              onClick={(event) => {
                // Never let a document link navigate the application WebView:
                // even a relative or unsupported URL would replace the current
                // Screen with an invalid app route. Only approved http(s) URLs
                // are handed to the system browser by openExternal.
                event.preventDefault();
                event.stopPropagation();
                if (href && /^https?:\/\//i.test(href)) void openExternal(href);
              }}
            >
              {children}
            </a>
          ),
          code: ({ children }) => <code className={s.code}>{children}</code>,
          // Block code: the plain wrapper — its inner <code> is restyled via [&_code].
          // Marked as a horizontal scroll box so a vertical swipe over it is
          // handed back to the conversation (see lib/wheelChain).
          pre: ({ children }) => (
            <pre {...{ [HSCROLL_ATTR]: "" }} className={s.pre}>
              {children}
            </pre>
          ),
          ul: ({ children }) => <ul className={s.ul}>{children}</ul>,
          ol: ({ children }) => <ol className={s.ol}>{children}</ol>,
          li: ({ children }) => <li>{children}</li>,
          // Document elements (headings, quotes, tables, rules) — Tailwind's
          // preflight strips the browser defaults, so each needs explicit style.
          h1: ({ children }) => <h1 className={s.h1}>{children}</h1>,
          h2: ({ children }) => <h2 className={s.h2}>{children}</h2>,
          h3: ({ children }) => <h3 className={s.h3}>{children}</h3>,
          h4: ({ children }) => <h4 className={s.h4}>{children}</h4>,
          blockquote: ({ children }) => <blockquote className={s.blockquote}>{children}</blockquote>,
          hr: () => <hr className={s.hr} />,
          // `overflow-y-hidden` is load-bearing, not decoration: CSS turns the
          // other axis of a scroll container from `visible` into `auto`, so a
          // wide table also became a VERTICAL scroller — by exactly the height
          // its horizontal scrollbar steals. The wheel then latched onto those
          // few pixels and the conversation would not scroll while the pointer
          // sat over a table.
          table: ({ children }) => (
            <div {...{ [HSCROLL_ATTR]: "" }} className="my-4 overflow-x-auto overflow-y-hidden">
              <table className={s.table}>{children}</table>
            </div>
          ),
          th: ({ children }) => <th className={s.th}>{children}</th>,
          td: ({ children }) => <td className={s.td}>{children}</td>,
        }}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
}
