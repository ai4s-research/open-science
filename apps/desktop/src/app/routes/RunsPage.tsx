import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Cpu,
  ExternalLink,
  FileCode2,
  FileOutput,
  FlaskConical,
  Loader2,
  MessageSquare,
  Package,
  RotateCcw,
  ScrollText,
  Search,
  X,
} from "lucide-react";
import type { RunArtifact, RunRecord } from "@ai4s/shared";
import { queryRuns, readRunLog, reproduceRunPrompt, type RunFacet, type RunPage } from "@/lib/runs";
import { openArtifactExternally } from "@/lib/artifactFile";
import { copyText } from "@/lib/clipboard";
import { PaneTitlebarInset } from "@/components/inspector/RightPane";
import { useUiStore } from "@/lib/store";
import { cn } from "@/lib/cn";
import i18n from "@/i18n";

type SincePreset = "24h" | "7d" | "30d";
const SINCE_SECONDS: Record<SincePreset, number> = { "24h": 86_400, "7d": 604_800, "30d": 2_592_000 };

interface Filter {
  search: string;
  status?: string;
  surface?: string;
  since?: SincePreset;
}

/**
 * The runs ledger — experiment executions backed by the global SQLite index
 * over the append-only runs logs. Faceted (status / surface), searchable, and
 * keyset-paginated with infinite scroll, so it stays fast and calm from five
 * runs to hundreds of thousands. Reused by the global `RunsPage` (all sessions)
 * and the per-session `RunsPane` (passes `sessionId` to narrow to one session).
 */
function RunsView({ sessionId }: { sessionId?: string }) {
  const { t } = useTranslation(["runs", "common"]);
  const [filter, setFilter] = useState<Filter>({ search: "" });
  const [debounced, setDebounced] = useState("");
  const [rows, setRows] = useState<RunRecord[]>([]);
  const [facets, setFacets] = useState<RunPage["facets"]>({ status: [], surface: [] });
  const [cursor, setCursor] = useState<RunPage["next"]>(undefined);
  const [state, setState] = useState<"loading" | "loadingMore" | "ready">("loading");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [log, setLog] = useState<{ hash: string; text: string | null } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const setComposerDraft = useUiStore((s) => s.setComposerDraft);

  // Debounce the search box so each keystroke doesn't hit the index.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(filter.search.trim()), 220);
    return () => clearTimeout(timer);
  }, [filter.search]);

  const base = useMemo(
    () => ({
      sessionId,
      search: debounced,
      status: filter.status,
      surface: filter.surface,
      sinceTs: filter.since ? Math.floor(Date.now() / 1000) - SINCE_SECONDS[filter.since] : undefined,
    }),
    [sessionId, debounced, filter.status, filter.surface, filter.since],
  );

  // (Re)load the first page whenever the filter changes.
  useEffect(() => {
    let cancelled = false;
    setState("loading");
    void queryRuns({ ...base, limit: 50 }).then((page) => {
      if (cancelled) return;
      setRows(page.rows);
      setFacets(page.facets);
      setCursor(page.next);
      setState("ready");
      const target = searchParams.get("run");
      setExpanded(target && page.rows.some((r) => r.runId === target) ? target : page.rows[0]?.runId ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [base, searchParams]);

  const loadMore = useCallback(() => {
    if (!cursor || state !== "ready") return;
    setState("loadingMore");
    void queryRuns({ ...base, beforeTs: cursor.ts, beforeRowid: cursor.rowid, limit: 50 }).then((page) => {
      setRows((prev) => [...prev, ...page.rows]);
      setCursor(page.next);
      setState("ready");
    });
  }, [cursor, state, base]);

  // Infinite scroll: load older pages as the sentinel scrolls into view.
  const sentinel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !cursor || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && loadMore(), { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, loadMore]);

  const toggleLog = (hash: string) => {
    if (log?.hash === hash) return setLog(null);
    setLog({ hash, text: null });
    void readRunLog(hash).then((text) =>
      setLog((cur) => (cur?.hash === hash ? { hash, text: text ?? "(log unavailable)" } : cur)),
    );
  };

  const reproduce = (r: RunRecord) => {
    setComposerDraft(reproduceRunPrompt(r));
    navigate(r.sessionId ? `/live/${r.sessionId}` : "/live");
  };

  const copyCommand = (r: RunRecord) => {
    void copyText(r.command).then(() => {
      setCopied(r.runId);
      setTimeout(() => setCopied((c) => (c === r.runId ? null : c)), 1500);
    });
  };

  const toggle = (key: "status" | "surface", value: string) =>
    setFilter((f) => ({ ...f, [key]: f[key] === value ? undefined : value }));

  const okN = count(facets.status, "ok");
  const failedN = count(facets.status, "failed");
  const anyFilter = !!(filter.search || filter.status || filter.surface || filter.since);
  const remoteSurfaces = facets.surface.filter((f) => f.value && f.value !== "local");
  const groups = useMemo(() => groupByDay(rows), [rows]);

  return (
    <>
        {/* Filter bar */}
        {(rows.length > 0 || anyFilter) && (
          <div className="sticky top-0 z-20 -mx-1 flex flex-wrap items-center gap-2 bg-bg/95 px-1 py-2 backdrop-blur">
            <div className="relative min-w-[12rem] flex-1">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <input
                value={filter.search}
                onChange={(e) => setFilter((f) => ({ ...f, search: e.target.value }))}
                placeholder={t("searchPlaceholder")}
                className="w-full rounded-input border border-border bg-surface py-1.5 pl-8 pr-3 text-sm text-text outline-none placeholder:text-muted focus:border-accent"
              />
            </div>
            {/* eslint-disable-next-line i18next/no-literal-string -- "status"/"ok" are internal filter keys, not display text (the visible label is t("filter.ok")) */}
            <FacetChip label={t("filter.ok")} count={okN} active={filter.status === "ok"} onClick={() => toggle("status", "ok")} dot="bg-ok" />
            {/* eslint-disable-next-line i18next/no-literal-string -- "status"/"failed" are internal filter keys, not display text (the visible label is t("filter.failed")) */}
            <FacetChip label={t("filter.failed")} count={failedN} active={filter.status === "failed"} onClick={() => toggle("status", "failed")} dot="bg-error" />
            {remoteSurfaces.map((f) => (
              <FacetChip
                key={f.value}
                label={f.value.toUpperCase()}
                count={f.count}
                active={filter.surface === f.value}
                // eslint-disable-next-line i18next/no-literal-string -- "surface" is an internal filter key, not display text
                onClick={() => toggle("surface", f.value)}
                accent
              />
            ))}
            <div className="flex shrink-0 select-none items-center rounded-full border border-border bg-surface p-0.5 text-xs">
              {/* eslint-disable-next-line i18next/no-literal-string -- internal filter-window keys; "24h"/"7d"/"30d" are displayed verbatim as time-unit shorthand (consistent with existing convention, e.g. "eV"/"GB" units elsewhere), only "all" is display-translated via t("filter.anytime") */}
              {(["all", "24h", "7d", "30d"] as const).map((k) => {
                const active = (filter.since ?? "all") === k;
                return (
                  <button
                    key={k}
                    onClick={() => setFilter((f) => ({ ...f, since: k === "all" ? undefined : k }))}
                    className={cn(
                      "rounded-full px-2 py-0.5 font-medium capitalize transition-colors",
                      active ? "bg-surface-2 text-text" : "text-muted hover:text-text",
                    )}
                  >
                    {k === "all" ? t("filter.anytime") : k}
                  </button>
                );
              })}
            </div>
            {anyFilter && (
              <button className="text-xs text-link hover:underline" onClick={() => setFilter({ search: "" })}>
                {t("filter.clear")}
              </button>
            )}
          </div>
        )}

        {state === "loading" && (
          <div className="mt-8 flex items-center gap-2 text-sm text-muted">
            <Loader2 size={15} className="animate-spin" /> {t("loading")}
          </div>
        )}

        {state !== "loading" && rows.length === 0 && !anyFilter && (
          <div className="mt-8 rounded-input border border-dashed border-border bg-surface px-4 py-8 text-center">
            <FlaskConical size={22} className="mx-auto text-muted" strokeWidth={1.5} />
            <p className="mt-2 text-sm font-medium text-text">{t("empty.title")}</p>
            <p className="mx-auto mt-1 max-w-sm text-xs text-muted">
              {t("empty.bodyPrefix")}
              <span className="font-mono text-text">{t("empty.bodyExample")}</span>
              {t("empty.bodySuffix")}
            </p>
          </div>
        )}

        {state !== "loading" && rows.length === 0 && anyFilter && (
          <div className="mt-8 text-center text-sm text-muted">{t("empty.noMatch")}</div>
        )}

        {/* The ledger — borderless rows grouped under sticky day labels. */}
        <div className="mt-1">
          {groups.map(([label, items]) => (
            <section key={label}>
              <div className="sticky top-[3.25rem] z-10 bg-bg/95 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted backdrop-blur">
                {label}
              </div>
              <ul>
                {items.map((r) => (
                  <RunRow
                    key={r.runId}
                    run={r}
                    open={expanded === r.runId}
                    onToggle={() => setExpanded((e) => (e === r.runId ? null : r.runId))}
                    onReproduce={() => reproduce(r)}
                    onOpenConversation={r.sessionId ? () => navigate(`/live/${r.sessionId}`) : undefined}
                    onCopy={() => copyCommand(r)}
                    copied={copied === r.runId}
                    log={log}
                    onToggleLog={toggleLog}
                  />
                ))}
              </ul>
            </section>
          ))}
          <div ref={sentinel} />
          {state === "loadingMore" && (
            <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted">
              <Loader2 size={13} className="animate-spin" /> {t("loadingMore")}
            </div>
          )}
        </div>
    </>
  );
}

/** Global Runs view (sidebar) — all runs across every session, like the global
 *  Files browser and Notebooks page. */
export function RunsPage() {
  const { t } = useTranslation(["runs", "common"]);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 py-8">
        <header className="mb-4 flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-input bg-accent/10 text-accent">
            <FlaskConical size={17} strokeWidth={1.75} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="font-serif text-xl leading-tight text-text">{t("title")}</h1>
            <p className="mt-0.5 text-sm text-muted">
              {t("description.prefix")}
              <span className="text-text/70">{t("action.reproduce")}</span>
              {t("description.suffix")}
            </p>
          </div>
        </header>
        <RunsView />
      </div>
    </div>
  );
}

/** Per-session Runs pane (session header toggle) — this session's runs only,
 *  beside the chat, like the session's Files pane. */
export function RunsPane({
  sessionId,
  onClose,
  controls,
}: {
  sessionId: string;
  onClose: () => void;
  controls?: React.ReactNode;
}) {
  const { t } = useTranslation(["runs", "common"]);
  return (
    <div className="flex h-full flex-col border-l border-border bg-surface">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <PaneTitlebarInset />
        <FlaskConical size={14} strokeWidth={1.5} className="shrink-0 text-text" />
        <span className="text-sm font-medium text-text">{t("title")}</span>
        <span className="text-xs text-muted">{t("pane.subtitle")}</span>
        <div className="flex-1" />
        {controls}
        <button className="text-text hover:opacity-60" aria-label={t("pane.closeAria")} onClick={onClose}>
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <RunsView sessionId={sessionId} />
      </div>
    </div>
  );
}

function RunRow({
  run: r,
  open,
  onToggle,
  onReproduce,
  onOpenConversation,
  onCopy,
  copied,
  log,
  onToggleLog,
}: {
  run: RunRecord;
  open: boolean;
  onToggle: () => void;
  onReproduce: () => void;
  onOpenConversation?: () => void;
  onCopy: () => void;
  copied: boolean;
  log: { hash: string; text: string | null } | null;
  onToggleLog: (hash: string) => void;
}) {
  const { t } = useTranslation(["runs", "common"]);
  const failed = r.status === "failed";
  const remote = r.surface && r.surface !== "local";
  return (
    <li>
      <button
        className="group flex w-full items-center gap-2.5 rounded-input px-2 py-1.5 text-left hover:bg-surface-2/60"
        onClick={onToggle}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown size={13} className="shrink-0 text-muted" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-muted opacity-40 group-hover:opacity-100" />
        )}
        <span
          className={cn("h-1.5 w-1.5 shrink-0 rounded-full", failed ? "bg-error" : "bg-ok")}
          title={failed ? t("status.failed") : t("status.succeeded")}
        />
        <span className={cn("min-w-0 flex-1 truncate font-mono text-[13px]", failed ? "text-text/70" : "text-text")}>
          {r.command}
        </span>
        {remote && (
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-accent">{r.surface}</span>
        )}
        {r.wallMs != null && <span className="shrink-0 tabular-nums text-xs text-muted">{formatDuration(r.wallMs)}</span>}
        <span className="w-16 shrink-0 text-right text-xs text-muted" title={absoluteTs(r.ts)}>
          {relativeTs(r.ts)}
        </span>
      </button>

      {open && (
        <div className="ml-6 mb-1 space-y-3 border-l border-border-faint pl-4 pt-1 text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            {r.env && (
              <Chip>
                {[r.env.python && `py ${r.env.python}`, r.env.platform, r.env.app && `app ${r.env.app}`]
                  .filter(Boolean)
                  .join(" · ")}
              </Chip>
            )}
            {r.env?.hardware && (
              <Chip icon={<Cpu size={11} />} title={t("hardware.title")}>
                {hardwareLabel(r.env.hardware)}
              </Chip>
            )}
            {r.env?.packages && (
              <Chip icon={<Package size={11} />}>{t("hardware.packageCount", { count: r.env.packages.count })}</Chip>
            )}
            {r.remoteHardware && (
              <Chip icon={<Cpu size={11} />} title={t("hardware.remoteTitle")}>
                {r.remoteHardware}
              </Chip>
            )}
            {r.host && (
              <Chip title={t("host.title")}>
                {r.host}
                {r.jobId && ` · ${t("host.jobLabel")} ${r.jobId}`}
              </Chip>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <Action icon={<RotateCcw size={12} />} onClick={onReproduce} title={t("action.reproduceTitle")}>
              {t("action.reproduce")}
            </Action>
            {r.logHash && (
              <Action icon={<ScrollText size={12} />} onClick={() => onToggleLog(r.logHash!)} active={log?.hash === r.logHash} title={t("action.logTitle")}>
                {t("action.log")}
              </Action>
            )}
            {onOpenConversation && (
              <Action icon={<MessageSquare size={12} />} onClick={onOpenConversation} title={t("action.openConversationTitle")}>
                {t("action.openConversation")}
              </Action>
            )}
            <Action icon={copied ? <Check size={12} /> : <Copy size={12} />} onClick={onCopy} title={t("action.copyTitle")}>
              {copied ? t("action.copied") : t("action.copyCommand")}
            </Action>
          </div>

          {r.code && r.code.length > 0 && <FileGroup icon={<FileCode2 size={12} />} label={t("files.code")} files={r.code} />}
          {r.outputs && r.outputs.length > 0 && (
            <FileGroup icon={<FileOutput size={12} />} label={t("files.outputs")} files={r.outputs} openable />
          )}
          {!r.outputs?.length && remote && (
            <p className="text-muted">
              {t("remote.outputsNotCaptured", { surface: r.surface === "hpc" ? t("remote.hpcLabel") : r.surface })}
            </p>
          )}

          {r.logHash && log?.hash === r.logHash && (
            <div className="overflow-hidden rounded-input border border-border bg-surface-2">
              <div className="border-b border-border px-2.5 py-1 text-[11px] text-muted">{t("log.header")}</div>
              {log.text === null ? (
                <div className="flex items-center gap-2 px-2.5 py-2 text-muted">
                  <Loader2 size={12} className="animate-spin" /> {t("log.loading")}
                </div>
              ) : (
                <pre className="max-h-64 overflow-auto px-2.5 py-2 font-mono text-[11px] leading-relaxed text-text">
                  {log.text}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function FacetChip({
  label,
  count,
  active,
  onClick,
  dot,
  accent,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  dot?: string;
  accent?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-xs transition-colors",
        active
          ? accent
            ? "border-accent bg-accent/10 text-accent"
            : "border-border bg-surface-2 text-text"
          : "border-border bg-surface text-muted hover:text-text",
      )}
    >
      {dot && <span className={cn("h-1.5 w-1.5 rounded-full", dot)} />}
      <span className="font-medium">{label}</span>
      <span className="tabular-nums opacity-70">{count}</span>
    </button>
  );
}

function Chip({ children, icon, title }: { children: React.ReactNode; icon?: React.ReactNode; title?: string }) {
  return (
    <span className="flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-muted" title={title}>
      {icon}
      {children}
    </span>
  );
}

function Action({
  children,
  icon,
  onClick,
  active,
  title,
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  title?: string;
}) {
  return (
    <button className={cn("flex items-center gap-1 hover:underline", active ? "text-text" : "text-link")} onClick={onClick} aria-pressed={active} title={title}>
      {icon}
      {children}
    </button>
  );
}

function FileGroup({ icon, label, files, openable }: { icon: React.ReactNode; label: string; files: RunArtifact[]; openable?: boolean }) {
  const { t } = useTranslation(["runs", "common"]);
  return (
    <div>
      <div className="mb-1 flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider text-muted">
        {icon} {label}
      </div>
      <ul className="space-y-0.5">
        {files.map((f) =>
          openable ? (
            <li key={f.path}>
              <button
                onClick={() => void openArtifactExternally(f.path, "workspace")}
                title={t("files.openTitle")}
                className="group flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-surface-2"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-text group-hover:text-link">{f.path}</span>
                <ExternalLink size={11} className="shrink-0 text-muted opacity-0 group-hover:opacity-100" />
                <span className="shrink-0 tabular-nums text-muted">{humanSize(f.size)}</span>
              </button>
            </li>
          ) : (
            <li key={f.path} className="flex items-center gap-2 px-1">
              <span className="min-w-0 flex-1 truncate font-mono text-text">{f.path}</span>
              <span className="shrink-0 tabular-nums text-muted">{humanSize(f.size)}</span>
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

function count(facets: RunFacet[], value: string): number {
  return facets.find((f) => f.value === value)?.count ?? 0;
}

function hardwareLabel(hw: NonNullable<RunRecord["env"]>["hardware"]): string {
  if (!hw) return "";
  if (hw.gpu && hw.gpu.length > 0) return hw.gpu.join(", ");
  return [hw.cpu, hw.accelerator].filter(Boolean).join(" · ");
}

function groupByDay(runs: RunRecord[]): [string, RunRecord[]][] {
  const groups: [string, RunRecord[]][] = [];
  let current: [string, RunRecord[]] | null = null;
  for (const r of runs) {
    const label = dayLabel(r.ts);
    if (!current || current[0] !== label) {
      current = [label, []];
      groups.push(current);
    }
    current[1].push(r);
  }
  return groups;
}

function dayLabel(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days <= 0) return i18n.t("runs:relative.today");
  if (days === 1) return i18n.t("runs:relative.yesterday");
  if (days < 7) return d.toLocaleDateString(i18n.language, { weekday: "long" });
  return d.toLocaleDateString(i18n.language, { month: "long", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

function relativeTs(ts: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (secs < 60) return i18n.t("runs:relative.justNow");
  if (secs < 3600) return i18n.t("runs:relative.minutesAgo", { count: Math.floor(secs / 60) });
  if (secs < 86_400) return i18n.t("runs:relative.hoursAgo", { count: Math.floor(secs / 3600) });
  return new Date(ts * 1000).toLocaleDateString(i18n.language, { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" });
}

function absoluteTs(ts: number): string {
  return new Date(ts * 1000).toLocaleString(i18n.language, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
