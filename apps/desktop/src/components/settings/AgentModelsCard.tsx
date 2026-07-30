import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import type { ProviderInfo } from "@ai4s/sdk";
import { useRuntimeStore } from "@/lib/runtime";
import { getAgentModels, setAgentModel } from "@/lib/tauri";
import { flattenModelOptions } from "./modelCatalog";
import { Section } from "./Section";

/** Utility agents the runtime runs on its own behalf — titling a session,
 *  summarizing, compacting context. They do short mechanical work, so a fast
 *  model here is a pure win; they are listed separately from the agents the
 *  user talks to because they never appear in the composer. */
const UTILITY_AGENTS = ["title", "summary", "compaction"] as const;

/**
 * One model per agent (#63). A reviewer or explorer subagent can run a fast
 * model while the main agent reasons on a strong one; anything left on
 * "default" follows the global model.
 */
export function AgentModelsCard({ providers }: { providers: ProviderInfo[] }) {
  const { t } = useTranslation(["settings", "common"]);
  const agents = useRuntimeStore((s) => s.agents);
  const defaultModel = useRuntimeStore((s) => s.defaultModel);
  const reconnect = useRuntimeStore((s) => s.connectRetry);

  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [busyAgent, setBusyAgent] = useState<string | null>(null);

  useEffect(() => {
    void getAgentModels().then(setOverrides);
  }, []);

  const options = useMemo(() => flattenModelOptions(providers), [providers]);
  // Agents the user can address, plus the runtime's own utility agents. The
  // list is deduped: a runtime may already expose "summary" as an agent.
  const rows = useMemo(() => {
    const named = agents.map((a) => a.name);
    const extra = UTILITY_AGENTS.filter((u) => !named.includes(u));
    return [...named, ...extra];
  }, [agents]);

  const choose = async (agent: string, model: string) => {
    setBusyAgent(agent);
    await setAgentModel(agent, model);
    setOverrides((prev) => {
      const next = { ...prev };
      if (model) next[agent] = model;
      else delete next[agent];
      return next;
    });
    // Agents are constructed when the sidecar loads its config.
    await reconnect();
    setBusyAgent(null);
  };

  return (
    <Section title={t("agentModels.title")} hint={t("agentModels.hint")}>
      {options.length === 0 ? (
        <p className="text-[13px] text-muted">{t("agentModels.noModels")}</p>
      ) : (
        <div className="divide-y divide-faint">
          {rows.map((name) => (
            <div key={name} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
              <span className="min-w-0 flex-1 truncate text-[13px] text-text">{name}</span>
              {busyAgent === name && (
                <Loader2 size={13} className="shrink-0 animate-spin text-muted" />
              )}
              <select
                value={overrides[name] ?? ""}
                disabled={busyAgent !== null}
                onChange={(e) => void choose(name, e.target.value)}
                aria-label={t("agentModels.modelFor", { agent: name })}
                className="max-w-[16rem] shrink-0 rounded-input border border-border bg-surface px-2 py-1 text-xs text-text outline-none focus:border-accent disabled:opacity-50"
              >
                <option value="">
                  {defaultModel
                    ? t("agentModels.followDefaultNamed", { model: defaultModel })
                    : t("agentModels.followDefault")}
                </option>
                {options.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.key}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
