import { useEffect, useMemo, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { CaseSensitive, ChevronDown, ChevronUp, Regex, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { clearHighlights, findRanges, paintHighlights, revealRange } from "@/lib/findInPage";

/**
 * Find in rendered content — ⌘F / Ctrl+F.
 *
 * The same bar the terminal has, over a conversation instead: a query, match
 * case, regular expression, previous/next, and a count. It searches the element
 * handed to it, so a pane finds within ITSELF rather than across a window that
 * may hold four conversations.
 *
 * `generation` is bumped by the caller when the content changed underneath —
 * a streaming answer adds text while the bar is open, and matches found in a
 * paragraph that has since re-rendered point at nodes no longer in the
 * document.
 */
export function FindBar({
  scope,
  generation = 0,
  onClose,
}: {
  scope: RefObject<HTMLElement | null>;
  generation?: number;
  onClose: () => void;
}) {
  const { t } = useTranslation("session");
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [index, setIndex] = useState(0);

  const ranges = useMemo(() => {
    const root = scope.current;
    if (!root || !query) return [];
    return findRanges(root, query, { caseSensitive, regex });
    // `generation` is the point: it re-runs the search when the content moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, query, caseSensitive, regex, generation]);

  // A shorter result list must not leave the cursor past its end.
  const current = ranges.length === 0 ? 0 : Math.min(index, ranges.length - 1);

  useEffect(() => {
    paintHighlights(ranges, ranges[current] ?? null);
  }, [ranges, current]);

  // Only on a deliberate step, never on every keystroke: scrolling the
  // conversation while the word is still being typed loses the reader's place.
  const step = (delta: number) => {
    if (ranges.length === 0) return;
    const next = (current + delta + ranges.length) % ranges.length;
    setIndex(next);
    const range = ranges[next];
    if (range) revealRange(range);
  };

  useEffect(() => () => clearHighlights(), []);

  return (
    <div
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onClose();
        else if (e.key === "Enter") step(e.shiftKey ? -1 : 1);
      }}
      className="absolute right-3 top-3 z-30 flex items-center gap-0.5 rounded-card border border-border bg-surface/95 px-1.5 py-1 shadow-pop backdrop-blur"
    >
      <input
        autoFocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        placeholder={t("find.placeholder")}
        aria-label={t("find.placeholder")}
        className="h-6 w-44 min-w-0 bg-transparent px-1 text-[12px] text-text outline-none placeholder:text-muted"
      />
      <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-muted">
        {!query ? "" : ranges.length ? `${current + 1}/${ranges.length}` : t("find.none")}
      </span>
      <Toggle
        active={caseSensitive}
        label={t("find.matchCase")}
        onClick={() => setCaseSensitive((v) => !v)}
      >
        <CaseSensitive size={13} strokeWidth={1.5} />
      </Toggle>
      <Toggle active={regex} label={t("find.regex")} onClick={() => setRegex((v) => !v)}>
        <Regex size={13} strokeWidth={1.5} />
      </Toggle>
      <Toggle label={t("find.previous")} onClick={() => step(-1)}>
        <ChevronUp size={13} strokeWidth={1.5} />
      </Toggle>
      <Toggle label={t("find.next")} onClick={() => step(1)}>
        <ChevronDown size={13} strokeWidth={1.5} />
      </Toggle>
      <Toggle label={t("find.close")} onClick={onClose}>
        <X size={13} strokeWidth={1.5} />
      </Toggle>
    </div>
  );
}

function Toggle({
  active = false,
  label,
  onClick,
  children,
}: {
  active?: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      // The query keeps the caret: a button here must not take it away.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "shrink-0 rounded-md p-1 transition-colors",
        active ? "bg-accent/15 text-accent" : "text-muted hover:bg-surface-2 hover:text-text",
      )}
    >
      {children}
    </button>
  );
}
