import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Check, Copy, Pencil, Plus, RefreshCw, SquareTerminal, Trash2 } from "lucide-react";
import { toast } from "@/lib/toast";
import { Section } from "./Section";
import { inputCls } from "./inputCls";
import { cn } from "@/lib/cn";
import { isTauri } from "@/lib/tauri";
import { useLayoutStore } from "@/lib/layout";
import { stopAcpAgent, useRuntimeStore } from "@/lib/runtime";
import {
  formatCommandArgs,
  loadAcpAgents,
  newAcpAgentId,
  parseCommandArgs,
  saveAcpAgents,
  type AcpAgentConfig,
} from "@/lib/acpAgents";
import {
  CLI_AGENTS,
  ensureCliAgent,
  installCommand,
  useDetectedAgents,
  useInstalledAgents,
  type CliAgent,
} from "@/lib/cliAgents";
import { OPENCODE_NAME, runsCatalogCommand } from "@/lib/agentChoices";
import { AgentAccounts } from "./AgentAccounts";

const isWindows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

/**
 * Settings → Agents: every agent a conversation can run on, side by side, and
 * which one a new conversation starts on (#14).
 *
 * OpenCode is built in. Claude Code, Codex, Gemini CLI and pi are listed when
 * they are installed, each with the accounts it can run as; the ones that are
 * not installed sit under "Available to install" with the vendor's command.
 * Any other command that speaks ACP can be added by hand.
 *
 * Desktop only: an agent is a process on this host, which the gateway web client
 * (a phone) does not have.
 */
export function AgentsCard() {
  const { t } = useTranslation(["settings", "common"]);
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AcpAgentConfig[]>(() => loadAcpAgents());
  const selected = useRuntimeStore((s) => s.defaultRuntime);
  const installed = useInstalledAgents();
  const redetect = useDetectedAgents((s) => s.redetect);
  const [detecting, setDetecting] = useState(false);
  const [editing, setEditing] = useState<AcpAgentConfig | null>(null);
  const [adding, setAdding] = useState(false);
  if (!isTauri) return null;

  const custom = agents.filter((a) => !CLI_AGENTS.some((c) => c.id === a.id) && !runsCatalogCommand(a));
  const available = installed === null ? [] : CLI_AGENTS.filter((c) => !installed.some((i) => i.id === c.id));
  // A default saved from an old one-click preset names the same command under
  // another id; it reads as that catalog agent.
  const selectedEntry = agents.find((a) => a.id === selected);
  const selectedCatalog =
    selectedEntry && runsCatalogCommand(selectedEntry)
      ? CLI_AGENTS.find((c) => [c.command, ...c.args].join(" ") === [selectedEntry.command, ...selectedEntry.args].join(" "))?.id
      : undefined;
  const isSelected = (id: string | null) => (selectedCatalog ?? selected) === id;

  const apply = (next: AcpAgentConfig[], nextSelected: string | null) => {
    saveAcpAgents(next);
    useRuntimeStore.getState().setDefaultRuntime(nextSelected);
    setAgents(next);
  };

  const selectCatalog = (agent: CliAgent) => {
    ensureCliAgent(agent);
    apply(loadAcpAgents(), agent.id);
  };

  const save = (agent: AcpAgentConfig) => {
    const exists = agents.some((a) => a.id === agent.id);
    const next = exists ? agents.map((a) => (a.id === agent.id ? agent : a)) : [...agents, agent];
    setEditing(null);
    setAdding(false);
    // A running process was started from the old command: stop it, and the
    // next message starts the new one (its conversations resume there).
    if (exists) stopAcpAgent(agent.id);
    apply(next, selected);
  };

  const remove = (id: string) => {
    stopAcpAgent(id);
    // Removing the default falls back to OpenCode; the app must never default
    // to an agent that is no longer configured.
    apply(
      agents.filter((a) => a.id !== id),
      selected === id ? null : selected,
    );
  };

  const detectAgain = async () => {
    setDetecting(true);
    try {
      await redetect();
    } finally {
      setDetecting(false);
    }
  };

  /** The vendor's installer, typed into a new terminal so the user sees it run
   *  and can answer any prompt. Detection runs again when they come back. */
  const installInTerminal = (agent: CliAgent) => {
    useLayoutStore.getState().addGroup({
      // eslint-disable-next-line i18next/no-literal-string -- PaneContent kind, not UI copy
      kind: "terminal",
      name: agent.name,
      command: installCommand(agent, isWindows),
    });
    navigate("/live");
  };

  return (
    <>
      <Section title={t("agents.title")} hint={t("agents.hint")} flush>
        <div className="divide-y divide-faint">
          <AgentRow
            title={OPENCODE_NAME}
            badge={t("agents.builtIn")}
            subtitle={t("agents.opencodeHint")}
            selected={isSelected(null)}
            onSelect={() => apply(agents, null)}
          />

          {(installed ?? []).map((agent) => (
            <div key={agent.id}>
              <AgentRow
                title={agent.name}
                subtitle={[agent.command, formatCommandArgs(agent.args)].join(" ")}
                mono
                selected={isSelected(agent.id)}
                onSelect={() => selectCatalog(agent)}
              />
              <AgentAccounts agent={agent} />
            </div>
          ))}

          {custom.map((agent) =>
            editing?.id === agent.id ? (
              <AgentForm key={agent.id} initial={agent} onCancel={() => setEditing(null)} onSave={save} />
            ) : (
              <AgentRow
                key={agent.id}
                title={agent.name}
                subtitle={[agent.command, formatCommandArgs(agent.args)].filter(Boolean).join(" ")}
                mono
                selected={isSelected(agent.id)}
                onSelect={() => apply(agents, agent.id)}
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
              <p className="mt-2.5 text-xs leading-relaxed text-muted">{t("acp.limits")}</p>
            </div>
          )}
        </div>
      </Section>

      <Section
        title={t("agents.availableTitle")}
        hint={t("agents.availableHint")}
        flush
      >
        <div className="divide-y divide-faint">
          {available.map((agent) => (
            <InstallRow key={agent.id} agent={agent} onInstall={() => installInTerminal(agent)} />
          ))}
          <div className="flex items-center gap-3 px-4 py-3">
            <p className="min-w-0 flex-1 text-xs text-muted">
              {installed === null
                ? t("agents.detecting")
                : available.length === 0
                  ? t("agents.allInstalled")
                  : t("agents.detectHint")}
            </p>
            <button className={ghostBtn()} onClick={() => void detectAgain()} disabled={detecting}>
              <RefreshCw size={13} className={cn(detecting && "animate-spin")} />
              {t("agents.detectAgain")}
            </button>
          </div>
        </div>
      </Section>
    </>
  );
}

/** One agent not on this machine: its install command, to copy or to run. */
function InstallRow({ agent, onInstall }: { agent: CliAgent; onInstall: () => void }) {
  const { t } = useTranslation(["settings", "common"]);
  const command = installCommand(agent, isWindows);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      toast.success(t("agents.copied"));
    } catch {
      toast.error(t("agents.copyFailed"));
    }
  };
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-text">{agent.name}</div>
        <div className="mt-0.5 select-text truncate font-mono text-xs text-muted">{command}</div>
      </div>
      <button className={iconBtn()} aria-label={t("agents.copy")} title={t("agents.copy")} onClick={() => void copy()}>
        <Copy size={13} />
      </button>
      <button className={ghostBtn()} onClick={onInstall}>
        <SquareTerminal size={13} />
        {t("agents.install")}
      </button>
    </div>
  );
}

/** One selectable agent. */
function AgentRow({
  title,
  badge,
  subtitle,
  mono = false,
  selected,
  onSelect,
  actions,
}: {
  title: string;
  badge?: string;
  subtitle: string;
  mono?: boolean;
  selected: boolean;
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
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors",
          selected ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface-2",
        )}
      >
        {selected && <Check size={9} />}
      </button>
      <button type="button" onClick={onSelect} className="min-w-0 flex-1 text-left">
        <div className="flex items-center gap-2 text-[13px] font-medium text-text">
          {title}
          {badge && <span className="text-[11px] font-normal text-muted">{badge}</span>}
        </div>
        <div className={cn("mt-0.5 truncate text-xs text-muted", mono && "font-mono")}>{subtitle}</div>
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
    onSave({ id: initial.id, name: name.trim() || cmd, command: cmd, args: parseCommandArgs(args) });
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
