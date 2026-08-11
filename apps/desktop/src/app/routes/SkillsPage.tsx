import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Bot, Boxes, Check, Package, Puzzle, X } from "lucide-react";
import { useRuntimeStore } from "@/lib/runtime";
import { cn } from "@/lib/cn";
import { isGatewayWeb } from "@/lib/webMode";

/**
 * Skills, agents, install-a-skill, and detected scientific environment — all real:
 * skills/agents from the OpenCode runtime, environment from the host system.
 */
export function SkillsPage() {
  const { t } = useTranslation(["pages", "common"]);
  const navigate = useNavigate();
  // Individual selectors, not a bare `useRuntimeStore()`: the latter re-renders
  // this page on every unrelated store mutation, including the SSE fold storm of
  // an active session (#34).
  const skills = useRuntimeStore((s) => s.skills);
  const agents = useRuntimeStore((s) => s.agents);
  const tools = useRuntimeStore((s) => s.tools);
  const status = useRuntimeStore((s) => s.status);
  const loadCatalog = useRuntimeStore((s) => s.loadCatalog);
  const detectTools = useRuntimeStore((s) => s.detectTools);
  const installSkill = useRuntimeStore((s) => s.installSkill);
  const connected = status === "ready";
  const [text, setText] = useState("");
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    if (connected) void loadCatalog();
    void detectTools();
  }, [connected, loadCatalog, detectTools]);

  const onInstall = async () => {
    if (!text.trim()) return;
    setInstalling(true);
    const result = await installSkill(text.trim());
    setInstalling(false);
    if (!result) return; // failed — the store surfaced the reason
    setText("");
    // A pasted SKILL.md is already installed (the store toasts it); anything
    // else runs in an agent session worth watching.
    if (result.kind === "session") navigate(`/live/${result.id}`);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 py-8">
        <h1 className="font-serif text-xl text-text">{t("skills.title")}</h1>
        <p className="mt-1 text-sm text-muted">
          {t("skills.description.prefix")}
          {/* eslint-disable-next-line i18next/no-literal-string -- literal filesystem path, not prose */}
          <span className="font-mono">.opencode/skills/</span>
          {t("skills.description.suffix")}
        </p>

        {/* Install a skill (#1) */}
        <Section title={t("skills.install.sectionTitle")} icon={<Boxes size={15} />}>
          <div className="p-4">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t("skills.install.placeholder")}
              rows={3}
              className="w-full resize-y rounded-input border border-border bg-surface px-3 py-2 text-sm text-text outline-none placeholder:text-muted"
            />
            <div className="mt-2 flex items-center gap-3">
              <button
                onClick={onInstall}
                disabled={!connected || !text.trim() || installing}
                className="rounded-input bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:opacity-90 disabled:opacity-40"
              >
                {installing ? t("skills.install.starting") : t("skills.install.cta")}
              </button>
              <span className="text-xs text-muted">
                {connected ? t("skills.install.hintConnected") : t("skills.install.hintDisconnected")}
              </span>
            </div>
          </div>
        </Section>

        {/* Environment (#2) — host tool detection is local-only; hide in web. */}
        {!isGatewayWeb && (
          <Section title={t("skills.environment.sectionTitle")} icon={<Package size={15} />}>
            {tools.length === 0 && <Empty>{t("skills.environment.detectionUnavailable")}</Empty>}
            {tools.map((tool) => (
              <div key={tool.name} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                {tool.found ? <Check size={15} className="text-ok" /> : <X size={15} className="text-muted" />}
                <span className="w-24 text-text">{tool.name}</span>
                <span className="flex-1 truncate font-mono text-xs text-muted">
                  {tool.found ? tool.version ?? t("skills.environment.found") : t("skills.environment.notFound")}
                </span>
                {/* #68: the bundled uv and the managed Jupyter env are off any
                    PATH — say so, instead of reading as the user's own install. */}
                {tool.managed && (
                  <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
                    {t("skills.environment.appManaged")}
                  </span>
                )}
              </div>
            ))}
            <p className="px-4 py-2 text-xs text-muted">{t("skills.environment.note")}</p>
          </Section>
        )}

        {connected ? (
          <>
            <Section title={t("skills.agentsSection.sectionTitle", { count: agents.length })} icon={<Bot size={15} />}>
              {agents.length === 0 && <Empty>{t("skills.agentsSection.empty")}</Empty>}
              {agents.map((a) => {
                const mode = modeOf(a.mode);
                const modeLabel = mode ? t(`skills.agentsSection.agentMode.${mode}`) : a.mode;
                return <RowItem key={a.name} name={a.name} desc={a.description} tag={modeLabel} />;
              })}
            </Section>
            <Section title={t("skills.skillsListSection.sectionTitle", { count: skills.length })} icon={<Puzzle size={15} />}>
              {skills.length === 0 && <Empty>{t("skills.skillsListSection.empty")}</Empty>}
              {skills.map((s) => {
                const source = sourceOf(s.location);
                const sourceLabel =
                  source === "builtin"
                    ? t("skills.skillsListSection.source.builtin")
                    : source === "project"
                      ? t("skills.skillsListSection.source.project")
                      : source === "user"
                        ? t("skills.skillsListSection.source.user")
                        : undefined;
                return <RowItem key={s.name} name={s.name} desc={s.description} tag={sourceLabel} />;
              })}
            </Section>
          </>
        ) : (
          <div className="mt-6 rounded-card border border-border bg-surface p-5 text-sm text-muted">
            {t("skills.disconnected")}
          </div>
        )}
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

// AgentInfo.mode is typed `string` (external SDK), but OpenCode only ever
// emits "primary" | "subagent" | "all" — see useRuntimeStore's a.mode ===
// "primary" check. Narrow to the known set so we can translate it; unknown
// values (future SDK additions) fall back to the raw string at the call site.
type AgentMode = "primary" | "subagent" | "all";

function modeOf(mode?: string): AgentMode | undefined {
  return mode === "primary" || mode === "subagent" || mode === "all" ? mode : undefined;
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted">
        {icon} {title}
      </h2>
      <div className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface">
        {children}
      </div>
    </section>
  );
}

function RowItem({ name, desc, tag }: { name: string; desc: string; tag?: string }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <Package size={16} className="mt-0.5 shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-text">{name}</div>
        <div className={cn("text-xs text-muted", "line-clamp-2")}>{desc}</div>
      </div>
      {tag && (
        <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted ring-1 ring-border">
          {tag}
        </span>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-6 text-center text-sm text-muted">{children}</div>;
}
