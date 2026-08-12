import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import type { ProviderInfo } from "@ai4s/sdk";
import { useRuntimeStore } from "@/lib/runtime";
import { getAgentModels, getAgentVariants, setAgentModel, setAgentVariant } from "@/lib/tauri";
import { flattenModelOptions } from "./modelCatalog";
import { Section } from "./Section";

/** Utility agents the runtime runs on its own behalf — titling a session,
 *  summarizing, compacting context. They do short mechanical work, so a fast
 *  model here is a pure win; they are listed separately from the agents the
 *  user talks to because they never appear in the composer. */
const UTILITY_AGENTS = ["title", "summary", "compaction"] as const;

/** Reasoning-effort variant names are provider tokens (the same in every
 *  language), so they are title-cased in place rather than translated —
 *  matching the composer's effort slider. */
function labelVariant(name: string): string {
  if (name === "xhigh") return "X-High";
  return name.charAt(0).toLocaleUpperCase() + name.slice(1);
}

/**
 * One model and one reasoning effort per agent (#63, #71). A reviewer or
 * explorer subagent can run a fast model while the main agent reasons on a
 * strong one; the composer's effort slider only reaches the turn the user
 * sends, so a subagent's effort has to be pinned here. Anything left on
 * "default" follows the global model / the model's own default effort.
 */
export function AgentModelsCard({ providers }: { providers: ProviderInfo[] }) {
  const { t } = useTranslation(["settings", "common"]);
  const agents = useRuntimeStore((s) => s.agents);
  const defaultModel = useRuntimeStore((s) => s.defaultModel);
  // Keeps this card (and the model browser) on screen while the sidecar
  // restarts to pick the change up, instead of collapsing to the connect prompt.
  const reloadRuntimeConfig = useRuntimeStore((s) => s.reloadRuntimeConfig);

  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [efforts, setEfforts] = useState<Record<string, string>>({});
  const [busyAgent, setBusyAgent] = useState<string | null>(null);
  // Both come from the same config file; reconciliation below needs BOTH, since
  // an agent's effective model decides which efforts are legal.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void Promise.all([getAgentModels(), getAgentVariants()]).then(([models, variants]) => {
      setOverrides(models);
      setEfforts(variants);
      setLoaded(true);
    });
  }, []);

  const options = useMemo(() => flattenModelOptions(providers), [providers]);
  // Effort levels each model exposes — the vocabulary differs per model, so a
  // row's choices follow whichever model that agent actually runs.
  const variantsByKey = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const p of providers) {
      for (const m of p.models) map.set(`${p.id}/${m.id}`, m.variants ?? []);
    }
    return map;
  }, [providers]);
  // Agents the user can address, plus the runtime's own utility agents. The
  // list is deduped: a runtime may already expose "summary" as an agent.
  const rows = useMemo(() => {
    const named = agents.map((a) => a.name);
    const extra = UTILITY_AGENTS.filter((u) => !named.includes(u));
    return [...named, ...extra];
  }, [agents]);

  const variantsFor = (agent: string) =>
    variantsByKey.get(overrides[agent] ?? defaultModel ?? "") ?? [];

  // A pinned effort can stop existing under the runtime it was chosen for: from
  // 1.18 a model's efforts come from the catalog's own `reasoning_options`, and
  // some models lost levels the previous runtime synthesized (verified on the
  // bundled binaries: `deepseek-v4-flash-free` lost `medium`, two models lost
  // their efforts entirely — #74). The runtime accepts such a value without
  // complaint and then silently applies nothing, so reconcile it away: the row
  // must not display an effort that no longer applies, and the config must not
  // keep one. A model absent from the catalog is left alone — that is a dangling
  // model, not a dropped level, and its effort is still meaningful if it returns.
  useEffect(() => {
    if (!loaded || providers.length === 0) return;
    for (const [agent, effort] of Object.entries(efforts)) {
      if (!effort) continue;
      const known = variantsByKey.get(overrides[agent] ?? defaultModel ?? "");
      if (!known || known.includes(effort)) continue;
      void setAgentVariant(agent, "");
      setEfforts((prev) => {
        const next = { ...prev };
        delete next[agent];
        return next;
      });
    }
  }, [loaded, providers, efforts, overrides, defaultModel, variantsByKey]);

  const choose = async (agent: string, model: string) => {
    setBusyAgent(agent);
    // Agents are constructed when the sidecar loads its config, so this restarts
    // it — done inside reloadRuntimeConfig so the surface survives the gap.
    await reloadRuntimeConfig(async () => {
      await setAgentModel(agent, model);
      // A pinned effort belongs to the model it was chosen for: the new model
      // may not offer that level at all, and OpenCode would reject the turn.
      // Drop it rather than leave a setting that cannot be honoured.
      const kept = variantsByKey.get(model || defaultModel || "") ?? [];
      const effort = efforts[agent];
      if (effort && !kept.includes(effort)) {
        await setAgentVariant(agent, "");
        setEfforts((prev) => {
          const next = { ...prev };
          delete next[agent];
          return next;
        });
      }
      setOverrides((prev) => {
        const next = { ...prev };
        if (model) next[agent] = model;
        else delete next[agent];
        return next;
      });
    });
    setBusyAgent(null);
  };

  const chooseEffort = async (agent: string, variant: string) => {
    setBusyAgent(agent);
    await reloadRuntimeConfig(async () => {
      await setAgentVariant(agent, variant);
      setEfforts((prev) => {
        const next = { ...prev };
        if (variant) next[agent] = variant;
        else delete next[agent];
        return next;
      });
    });
    setBusyAgent(null);
  };

  return (
    <Section title={t("agentModels.title")} hint={t("agentModels.hint")}>
      {options.length === 0 ? (
        <p className="text-[13px] text-muted">{t("agentModels.noModels")}</p>
      ) : (
        <div className="divide-y divide-faint">
          {/* Which of these rows affect the messages the user actually sends,
              and how a conversation's own pick relates to them (#85, #96). */}
          <p className="pb-2 text-[12px] leading-relaxed text-muted">
            {t("agentModels.primaryHint")}
          </p>
          {rows.map((name) => {
            const variants = variantsFor(name);
            return (
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
                {/* Effort only exists for models that expose reasoning levels;
                    for the rest there is nothing to choose, so nothing shows. */}
                {variants.length > 0 && (
                  <select
                    value={efforts[name] ?? ""}
                    disabled={busyAgent !== null}
                    onChange={(e) => void chooseEffort(name, e.target.value)}
                    aria-label={t("agentModels.effortFor", { agent: name })}
                    className="w-[7.5rem] shrink-0 rounded-input border border-border bg-surface px-2 py-1 text-xs text-text outline-none focus:border-accent disabled:opacity-50"
                  >
                    <option value="">{t("agentModels.defaultEffort")}</option>
                    {variants.map((v) => (
                      <option key={v} value={v}>
                        {labelVariant(v)}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}
