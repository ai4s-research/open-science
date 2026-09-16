import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Bot, Check, Plus, Puzzle, Search, X } from "lucide-react";
import { useRuntimeStore } from "@/lib/runtime";
import { cn } from "@/lib/cn";
import { isGatewayWeb } from "@/lib/webMode";

/**
 * What this workbench can do, and what it runs on.
 *
 * The page is a LIBRARY, so it is laid out as one: a searchable list of every
 * skill and agent, in a grid, with the machine's toolchain as one quiet line
 * above it. It used to be four stacked cards of the same visual weight — a
 * permanent three-row install box at the top, then a seven-row checklist of
 * found/not-found, then two long single-column lists — which gave the rarest
 * action the most space and made finding one skill among thirty a scroll.
 */
export function SkillsPage() {
  const { t } = useTranslation(["pages", "common"]);
  // Individual selectors, not a bare `useRuntimeStore()`: the latter re-renders
  // this page on every unrelated store mutation, including the SSE fold storm of
  // an active session (#34).
  const skills = useRuntimeStore((s) => s.skills);
  const agents = useRuntimeStore((s) => s.agents);
  const tools = useRuntimeStore((s) => s.tools);
  const status = useRuntimeStore((s) => s.status);
  const loadCatalog = useRuntimeStore((s) => s.loadCatalog);
  const detectTools = useRuntimeStore((s) => s.detectTools);
  const connected = status === "ready";

  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | "skill" | "agent">("all");
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    if (connected) void loadCatalog();
    void detectTools();
  }, [connected, loadCatalog, detectTools]);

  /** Skills and agents as one list: the reader is looking for a capability and
   *  does not, at that moment, care which of the two kinds it is. */
  const entries = useMemo<Entry[]>(() => {
    const all: Entry[] = [
      ...skills.map((s) => ({
        kind: "skill" as const,
        name: s.name,
        description: s.description,
        tag: sourceOf(s.location),
      })),
      ...agents.map((a) => ({
        kind: "agent" as const,
        name: a.name,
        description: a.description,
        // The RAW mode: an SDK that grows a new one must still show it rather
        // than show nothing. `agentModeLabel` translates the ones we know.
        tag: a.mode,
      })),
    ];
    const needle = query.trim().toLowerCase();
    return all
      .filter((e) => kind === "all" || e.kind === kind)
      .filter(
        (e) =>
          !needle ||
          e.name.toLowerCase().includes(needle) ||
          (e.description ?? "").toLowerCase().includes(needle),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [skills, agents, kind, query]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-8 py-7">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="font-serif text-xl text-text">{t("skills.title")}</h1>
          <p className="min-w-0 flex-1 truncate text-[13px] text-muted" title={summaryLine(t)}>
            {summaryLine(t)}
          </p>
          <InstallSkill installing={installing} setInstalling={setInstalling} connected={connected} />
        </header>

        {/* The toolchain, on one line. These are facts you glance at, not rows
            you read: seven of them stacked full-width was a page of whitespace
            for six words of information. */}
        {!isGatewayWeb && tools.length === 0 && (
          <p className="mt-4 text-[12px] text-muted">
            {t("skills.environment.detectionUnavailable")}
          </p>
        )}
        {!isGatewayWeb && tools.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-1.5">
            {tools.map((tool) => (
              <span
                key={tool.name}
                title={
                  tool.found
                    ? (tool.version ?? t("skills.environment.found"))
                    : t("skills.environment.notFound")
                }
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]",
                  tool.found
                    ? "border-border bg-surface text-text"
                    : "border-dashed border-border bg-transparent text-muted",
                )}
              >
                {tool.found ? (
                  <Check size={11} className="shrink-0 text-ok" />
                ) : (
                  <X size={11} className="shrink-0 text-muted" />
                )}
                {tool.name}
                {tool.found ? (
                  tool.version && (
                    <span className="font-mono text-[11px] text-muted">
                      {shortVersion(tool.version)}
                    </span>
                  )
                ) : (
                  // Said, not implied: a dashed outline is a hint, and whether
                  // the machine has R is not something to make the reader hover
                  // for.
                  <span className="text-[11px]">{t("skills.environment.notFound")}</span>
                )}
                {tool.managed && (
                  <span className="rounded bg-surface-2 px-1 text-[10px] text-muted">
                    {t("skills.environment.appManaged")}
                  </span>
                )}
              </span>
            ))}
          </div>
        )}
        {/* What those chips mean for running code — short, and under them
            rather than in a box of its own. */}
        {!isGatewayWeb && tools.length > 0 && (
          <p className="mt-2 text-[11px] leading-relaxed text-muted">
            {t("skills.environment.note")}
          </p>
        )}

        {!connected ? (
          <div className="mt-6 rounded-card border border-border bg-surface p-5 text-sm text-muted">
            {t("skills.disconnected")}
          </div>
        ) : (
          <>
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <label className="relative min-w-[16rem] flex-1">
                <Search
                  size={14}
                  className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
                />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("skills.search")}
                  aria-label={t("skills.search")}
                  className="h-8 w-full rounded-input border border-border bg-surface pl-8 pr-2 text-[13px] text-text outline-none placeholder:text-muted focus:border-accent/50"
                />
              </label>
              <div role="radiogroup" aria-label={t("skills.filter")} className="flex gap-0.5 rounded-input bg-surface-2 p-0.5">
                {/* eslint-disable i18next/no-literal-string -- filter ids, not UI copy */}
                <FilterTab active={kind === "all"} onSelect={() => setKind("all")}>
                  {t("skills.all", { count: skills.length + agents.length })}
                </FilterTab>
                <FilterTab active={kind === "skill"} onSelect={() => setKind("skill")}>
                  {t("skills.skillsListSection.sectionTitle", { count: skills.length })}
                </FilterTab>
                <FilterTab active={kind === "agent"} onSelect={() => setKind("agent")}>
                  {t("skills.agentsSection.sectionTitle", { count: agents.length })}
                </FilterTab>
                {/* eslint-enable i18next/no-literal-string */}
              </div>
            </div>

            {entries.length === 0 ? (
              <p className="mt-10 text-center text-sm text-muted">
                {query ? t("skills.noMatch", { query }) : t("skills.skillsListSection.empty")}
              </p>
            ) : (
              // Two columns on a wide window: thirty capabilities in one screen
              // rather than thirty scrolls.
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {entries.map((entry) => (
                  <EntryCard key={`${entry.kind}:${entry.name}`} entry={entry} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** The page's one-line summary, assembled from the two halves the translations
 *  keep apart (the filesystem path between them is not prose). */
function summaryLine(t: (key: "skills.description.prefix" | "skills.description.suffix") => string): string {
  // eslint-disable-next-line i18next/no-literal-string -- literal filesystem path, not prose
  return `${t("skills.description.prefix")}.opencode/skills/${t("skills.description.suffix")}`;
}

interface Entry {
  kind: "skill" | "agent";
  name: string;
  description: string;
  tag?: string;
}

function EntryCard({ entry }: { entry: Entry }) {
  const { t } = useTranslation("pages");
  const label = entry.kind === "agent" ? agentModeLabel(entry.tag, t) : sourceLabel(entry.tag, t);
  return (
    <article className="flex min-w-0 items-start gap-2.5 rounded-card border border-border bg-surface px-3 py-2.5">
      {entry.kind === "agent" ? (
        <Bot size={15} className="mt-0.5 shrink-0 text-muted" />
      ) : (
        <Puzzle size={15} className="mt-0.5 shrink-0 text-muted" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <h3 className="min-w-0 flex-1 truncate text-[13px] font-medium text-text">{entry.name}</h3>
          {label && (
            <span className="shrink-0 whitespace-nowrap rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">
              {label}
            </span>
          )}
        </div>
        <p className="line-clamp-2 text-[12px] leading-relaxed text-muted">{entry.description}</p>
      </div>
    </article>
  );
}

function FilterTab({
  active,
  onSelect,
  children,
}: {
  active: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className={cn(
        "whitespace-nowrap rounded-[5px] px-2.5 py-1 text-[12px] transition-colors",
        active ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Installing a skill, behind a button.
 *
 * It is the rarest thing done on this page and it used to own the top of it —
 * a permanent three-row textarea plus a two-line explanation, above the list
 * that is the reason anyone comes here.
 */
function InstallSkill({
  connected,
  installing,
  setInstalling,
}: {
  connected: boolean;
  installing: boolean;
  setInstalling: (value: boolean) => void;
}) {
  const { t } = useTranslation("pages");
  const navigate = useNavigate();
  const installSkill = useRuntimeStore((s) => s.installSkill);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");

  const onInstall = async () => {
    if (!text.trim()) return;
    setInstalling(true);
    const result = await installSkill(text.trim());
    setInstalling(false);
    if (!result) return; // failed — the store surfaced the reason
    setText("");
    setOpen(false);
    // A pasted SKILL.md is already installed (the store toasts it); anything
    // else runs in an agent session worth watching.
    if (result.kind === "session") navigate(`/live/${result.id}`);
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        disabled={!connected}
        title={connected ? undefined : t("skills.install.hintDisconnected")}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-input border border-border bg-surface px-2.5 py-1.5 text-[13px] text-text hover:bg-surface-2 disabled:opacity-40"
      >
        <Plus size={13} strokeWidth={1.5} />
        {t("skills.install.cta")}
      </button>
    );
  }

  return (
    <div className="mt-3 w-full rounded-card border border-border bg-surface p-3">
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t("skills.install.placeholder")}
        aria-label={t("skills.install.cta")}
        rows={3}
        className="w-full resize-y rounded-input border border-border bg-surface px-3 py-2 text-sm text-text outline-none placeholder:text-muted focus:border-accent/50"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          onClick={() => void onInstall()}
          disabled={!connected || !text.trim() || installing}
          className="rounded-input bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-fg hover:opacity-90 disabled:opacity-40"
        >
          {installing ? t("skills.install.starting") : t("skills.install.cta")}
        </button>
        <button
          onClick={() => setOpen(false)}
          className="rounded-input px-2.5 py-1.5 text-[13px] text-muted hover:bg-surface-2"
        >
          {t("common:actions.cancel", "Cancel")}
        </button>
        <span className="min-w-0 flex-1 text-[11px] text-muted">
          {t("skills.install.hintConnected")}
        </span>
      </div>
    </div>
  );
}

type SkillSource = "builtin" | "project" | "user";

/** Where a skill came from, read off the path OpenCode reports. Windows paths
 *  arrive with backslashes, so match on a normalized copy. */
function sourceOf(location?: string): SkillSource | undefined {
  if (!location) return undefined;
  const path = location.replace(/\\/g, "/");
  // OpenCode's own built-in skill reports "<built-in>" (v1) or /builtin/… (v2).
  if (path === "<built-in>" || path.includes("/builtin/")) return "builtin";
  // The app profile's skills dir: bundled packs, except the `user/` subtree the
  // skill installer writes to.
  if (path.includes("/xdg-config/opencode/skills/")) {
    return path.includes("/xdg-config/opencode/skills/user/") ? "user" : "builtin";
  }
  if (path.includes("/.opencode/")) return "project";
  // ~/.claude/skills, ~/.agents/skills, and config-declared skill paths.
  return "user";
}

type Say = ReturnType<typeof useTranslation<"pages">>["t"];

function sourceLabel(source: string | undefined, t: Say): string | undefined {
  if (source === "builtin") return t("skills.skillsListSection.source.builtin");
  if (source === "project") return t("skills.skillsListSection.source.project");
  if (source === "user") return t("skills.skillsListSection.source.user");
  return undefined;
}

// AgentInfo.mode is typed `string` (external SDK), but OpenCode only ever
// emits "primary" | "subagent" | "all" — see useRuntimeStore's a.mode ===
// "primary" check. Those three are translated; anything a future SDK adds is
// shown as it came, which is more useful than showing nothing.
function agentModeLabel(mode: string | undefined, t: Say): string | undefined {
  if (mode === "primary") return t("skills.agentsSection.agentMode.primary");
  if (mode === "subagent") return t("skills.agentsSection.agentMode.subagent");
  if (mode === "all") return t("skills.agentsSection.agentMode.all");
  return mode;
}

/** `Python 3.11.7` → `3.11.7`: the chip already says which tool it is, and the
 *  full `Rscript (R) version 4.6.1 (2026-06-24)` line is a tooltip's job. */
function shortVersion(version: string): string {
  return /(\d+\.[\d.]*\d)/.exec(version)?.[1] ?? version;
}
