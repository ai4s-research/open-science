import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { isTauri } from "@/lib/tauri";
import { useRuntimeStore } from "@/lib/runtime";
import {
  ACP_PRESETS,
  activeAcpAgentId,
  formatCommandArgs,
  loadAcpAgents,
  newAcpAgentId,
  parseCommandArgs,
  saveAcpAgents,
  setActiveAcpAgentId,
  type AcpAgentConfig,
} from "@/lib/acpAgents";
import { inputCls } from "./inputCls";
import { Section } from "./Section";

/**
 * Settings → Runtime → the agent this app drives (#14).
 *
 * The bundled OpenCode runtime, or any agent that speaks the Agent Client
 * Protocol over stdio — Codex, Gemini CLI, Claude Code, anything else with an
 * ACP server. Adding one is configuring a COMMAND, which is why there is no
 * per-agent code here (docs/rfc/multi-agent-acp.md).
 *
 * Desktop only: the agent runs as a child process on this host, which the
 * gateway web client (a phone) does not have — so the card is hidden there
 * rather than offering a control that cannot work.
 */
export function AcpAgentsCard() {
  const { t } = useTranslation(["settings", "common"]);
  const [agents, setAgents] = useState<AcpAgentConfig[]>(() => loadAcpAgents());
  const [selected, setSelected] = useState<string | null>(() => activeAcpAgentId());
  const [editing, setEditing] = useState<AcpAgentConfig | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  const status = useRuntimeStore((s) => s.status);
  const runtimeKind = useRuntimeStore((s) => s.runtimeKind);
  const error = useRuntimeStore((s) => s.error);

  if (!isTauri) return null;

  /** Persist the list, then reconnect if what is RUNNING no longer matches it.
   *  A reconnect kills the old child and starts the new one — cheap, and the
   *  only way the change is real (the runtime is chosen at connect time). */
  const apply = (next: AcpAgentConfig[], nextSelected: string | null, reconnect: boolean) => {
    saveAcpAgents(next);
    setActiveAcpAgentId(nextSelected);
    setAgents(next);
    setSelected(nextSelected);
    if (!reconnect) return;
    setBusy(true);
    void useRuntimeStore
      .getState()
      .connectRetry(8)
      .finally(() => setBusy(false));
  };

  const select = (id: string | null) => {
    if (busy || id === selected) return;
    apply(agents, id, true);
  };

  const save = (agent: AcpAgentConfig) => {
    const exists = agents.some((a) => a.id === agent.id);
    const next = exists ? agents.map((a) => (a.id === agent.id ? agent : a)) : [...agents, agent];
    setEditing(null);
    setAdding(false);
    // Editing the agent that is currently running changes the command that
    // process was started from — restart it, or Settings would describe one
    // agent while another one answers.
    apply(next, selected, selected === agent.id);
  };

  const remove = (id: string) => {
    const next = agents.filter((a) => a.id !== id);
    // Removing the selected agent falls back to the bundled runtime; the app
    // must never end up selecting an agent that is no longer configured.
    apply(next, selected === id ? null : selected, selected === id);
  };

  const running = runtimeKind === "acp" && status === "ready";

  return (
    <Section title={t("acp.title")} hint={t("acp.hint")} flush>
      <div className="divide-y divide-faint">
        <RuntimeRow
          title={t("acp.bundled")}
          subtitle={t("acp.bundledHint")}
          selected={selected === null}
          busy={busy}
          onSelect={() => select(null)}
        />

        {agents.map((agent) =>
          editing?.id === agent.id ? (
            <AgentForm
              key={agent.id}
              initial={agent}
              onCancel={() => setEditing(null)}
              onSave={save}
            />
          ) : (
            <RuntimeRow
              key={agent.id}
              title={agent.name}
              subtitle={[agent.command, formatCommandArgs(agent.args)].filter(Boolean).join(" ")}
              mono
              selected={selected === agent.id}
              busy={busy}
              onSelect={() => select(agent.id)}
              actions={
                <>
                  <button
                    className={iconBtn()}
                    aria-label={t("acp.edit")}
                    title={t("acp.edit")}
                    onClick={() => {
                      setAdding(false);
                      setEditing(agent);
                    }}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    className={iconBtn("hover:text-error")}
                    aria-label={t("acp.remove")}
                    title={t("acp.remove")}
                    onClick={() => remove(agent.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </>
              }
            />
          ),
        )}

        {adding ? (
          <AgentForm
            initial={{ id: newAcpAgentId(agents), name: "", command: "", args: [] }}
            onCancel={() => setAdding(false)}
            onSave={save}
          />
        ) : (
          <div className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                className={ghostBtn()}
                onClick={() => {
                  setEditing(null);
                  setAdding(true);
                }}
              >
                <Plus size={13} />
                {t("acp.add")}
              </button>
              {/* One click for the agents this app was verified against — still
                  an ordinary entry afterwards, editable like any other. */}
              {ACP_PRESETS.filter((p) => !agents.some((a) => a.name === p.name)).map((preset) => (
                <button
                  key={preset.name}
                  className={ghostBtn("text-muted")}
                  onClick={() => save({ ...preset, args: [...preset.args], id: newAcpAgentId(agents) })}
                >
                  <Plus size={13} />
                  {preset.name}
                </button>
              ))}
            </div>
            <p className="mt-2.5 text-xs leading-relaxed text-muted">{t("acp.limits")}</p>
            {runtimeKind === "acp" && (
              <p className={cn("mt-2 text-xs", running ? "text-muted" : "text-error")}>
                {running ? t("acp.running") : (error ?? t("acp.starting"))}
              </p>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}

/** One selectable runtime: the bundled one, or a configured ACP agent. */
function RuntimeRow({
  title,
  subtitle,
  mono = false,
  selected,
  busy,
  onSelect,
  actions,
}: {
  title: string;
  subtitle: string;
  mono?: boolean;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        aria-label={title}
        onClick={onSelect}
        disabled={busy}
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors",
          selected ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface-2",
        )}
      >
        {busy && selected ? (
          <Loader2 size={9} className="animate-spin" />
        ) : selected ? (
          <Check size={9} />
        ) : null}
      </button>
      <button
        type="button"
        onClick={onSelect}
        disabled={busy}
        className="min-w-0 flex-1 text-left"
      >
        <div className="text-[13px] font-medium text-text">{title}</div>
        <div className={cn("mt-0.5 truncate text-xs text-muted", mono && "font-mono")}>
          {subtitle}
        </div>
      </button>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </div>
  );
}

/** Add / edit one agent: a name, a command, and its arguments. */
function AgentForm({
  initial,
  onCancel,
  onSave,
}: {
  initial: AcpAgentConfig;
  onCancel: () => void;
  onSave: (agent: AcpAgentConfig) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const [name, setName] = useState(initial.name);
  const [command, setCommand] = useState(initial.command);
  const [args, setArgs] = useState(formatCommandArgs(initial.args));

  const submit = () => {
    const cmd = command.trim();
    if (!cmd) return;
    onSave({
      id: initial.id,
      name: name.trim() || cmd,
      command: cmd,
      args: parseCommandArgs(args),
    });
  };

  return (
    <div className="space-y-2 px-4 py-3">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t("acp.namePlaceholder")}
        aria-label={t("acp.nameLabel")}
        className={inputCls("w-full")}
      />
      <input
        value={command}
        onChange={(e) => setCommand(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder={t("acp.commandPlaceholder")}
        aria-label={t("acp.commandLabel")}
        className={inputCls("w-full font-mono")}
        spellCheck={false}
      />
      <input
        value={args}
        onChange={(e) => setArgs(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder={t("acp.argsPlaceholder")}
        aria-label={t("acp.argsLabel")}
        className={inputCls("w-full font-mono")}
        spellCheck={false}
      />
      <div className="flex gap-2">
        <button className={accentBtn()} onClick={submit} disabled={!command.trim()}>
          {t("common:actions.save")}
        </button>
        <button className={ghostBtn()} onClick={onCancel}>
          {t("common:actions.cancel")}
        </button>
      </div>
    </div>
  );
}

// Color-based hover/disabled, never `opacity` (which flickers in WKWebView).
const accentBtn = (extra = "") =>
  cn(
    "flex h-8 shrink-0 items-center gap-1.5 rounded-input bg-accent px-3 text-[13px] font-medium",
    "text-accent-fg transition-colors hover:bg-accent/90 disabled:bg-accent/50",
    extra,
  );
const ghostBtn = (extra = "") =>
  cn(
    "flex h-8 shrink-0 items-center gap-1.5 rounded-input border border-border px-3 text-[13px]",
    "text-text transition-colors hover:bg-surface-2",
    extra,
  );
const iconBtn = (extra = "") =>
  cn(
    "flex h-7 w-7 items-center justify-center rounded-input text-muted",
    "transition-colors hover:bg-surface-2 hover:text-text",
    extra,
  );
