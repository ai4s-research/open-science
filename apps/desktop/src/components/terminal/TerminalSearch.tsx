import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CaseSensitive, ChevronDown, ChevronUp, Regex, X } from "lucide-react";
import type { SearchAddon } from "@xterm/addon-search";
import { cn } from "@/lib/cn";
import { clearSearch, queryIsUsable, safeFind, searchOptions } from "./findInTerminal";

/**
 * Find in a terminal — ⌘F / Ctrl+F.
 *
 * Borrowed from Orca's `TerminalSearch`, down to its two hard-won details (see
 * `findInTerminal.ts`): explicit decoration colours, because xterm's defaults
 * vanish into a terminal background, and a guarded `find`, because the addon
 * can throw while building a highlight and take the pane down with it.
 *
 * It floats over the terminal rather than pushing it: a search must not reflow
 * the thing being searched, or the line you were looking at moves as you type.
 */
export function TerminalSearch({
  addon,
  onClose,
}: {
  addon: SearchAddon | null;
  onClose: () => void;
}) {
  const { t } = useTranslation("session");
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [results, setResults] = useState<{ index: number; count: number } | null>(null);
  const usable = queryIsUsable(query);

  // xterm reports what it found, so the bar can say "3 / 17" rather than leave
  // the reader pressing Enter to find out whether there are more.
  useEffect(() => {
    if (!addon) return;
    const sub = addon.onDidChangeResults((r) =>
      setResults(r ? { index: r.resultIndex + 1, count: r.resultCount } : null),
    );
    return () => sub.dispose();
  }, [addon]);

  // Typing searches as you go, from the top — incremental, so the view does not
  // jump past matches while the word is still being spelled.
  useEffect(() => {
    if (!addon) return;
    if (!query || !usable) {
      clearSearch(addon);
      setResults(null);
      return;
    }
    safeFind(
      (term, options) => addon.findNext(term, options),
      query,
      searchOptions({ caseSensitive, regex, incremental: true }),
    );
  }, [addon, query, caseSensitive, regex, usable]);

  // Leaving takes the highlights with it.
  useEffect(() => () => clearSearch(addon), [addon]);

  const step = (direction: "next" | "previous") => {
    if (!addon || !query || !usable) return;
    const options = searchOptions({ caseSensitive, regex });
    safeFind(
      (term, opts) =>
        direction === "next" ? addon.findNext(term, opts) : addon.findPrevious(term, opts),
      query,
      options,
    );
  };

  return (
    <div
      // The terminal has the keyboard; every key here is the bar's own.
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onClose();
        // eslint-disable-next-line i18next/no-literal-string -- step direction, not UI copy
        else if (e.key === "Enter") step(e.shiftKey ? "previous" : "next");
      }}
      className="absolute right-2 top-2 z-20 flex items-center gap-0.5 rounded-card border border-border bg-surface/95 px-1.5 py-1 shadow-pop backdrop-blur"
    >
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("terminal.search.placeholder")}
        aria-label={t("terminal.search.placeholder")}
        className="h-6 w-44 min-w-0 bg-transparent px-1 text-[12px] text-text outline-none placeholder:text-muted"
      />
      <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-muted">
        {!query ? "" : results?.count ? `${results.index}/${results.count}` : t("terminal.search.none")}
      </span>
      <Toggle
        active={caseSensitive}
        label={t("terminal.search.matchCase")}
        onClick={() => setCaseSensitive((v) => !v)}
      >
        <CaseSensitive size={13} strokeWidth={1.5} />
      </Toggle>
      <Toggle active={regex} label={t("terminal.search.regex")} onClick={() => setRegex((v) => !v)}>
        <Regex size={13} strokeWidth={1.5} />
      </Toggle>
      {/* eslint-disable i18next/no-literal-string -- step directions, not UI copy */}
      <Toggle label={t("terminal.search.previous")} onClick={() => step("previous")}>
        <ChevronUp size={13} strokeWidth={1.5} />
      </Toggle>
      <Toggle label={t("terminal.search.next")} onClick={() => step("next")}>
        <ChevronDown size={13} strokeWidth={1.5} />
      </Toggle>
      {/* eslint-enable i18next/no-literal-string */}
      <Toggle label={t("terminal.search.close")} onClick={onClose}>
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
      // The terminal keeps the caret: the bar's buttons must not steal it.
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
