import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import type { ProviderInfo } from "@ai4s/sdk";
import { useRuntimeStore } from "@/lib/runtime";
import { getAgentModels, getAgentVariants, setAgentModel, setAgentVariant } from "@/lib/tauri";
import { flattenModelOptions, selectableModelOptions, type ModelOption } from "./modelCatalog";
import { Row, Section } from "./Section";
import { chipCls } from "./inputCls";
import { cn } from "@/lib/cn";

/** Utility agents the runtime runs on its own behalf — titling a session,
 *  summarizing, compacting context. They do short mechanical work, so a fast
 *  model here is a pure win; they are listed separately from the agents the
 *  user talks to because they never appear in the composer.
 *
 *  Unlike those, they carry no description from the runtime, so the copy for
 *  what each one does lives here — a row labelled only `compaction` tells a
 *  reader nothing, however expert. */
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
  const selectable = useMemo(() => selectableModelOptions(options), [options]);
  // The catalog, grouped by provider. A native <select> shows the chosen
  // OPTION's text, so the option text is what has to be short: listing the full
  // `provider/model` key is what made every row read
  // "Default (kimi-for-coding/kimi-for-coding-hi…" with the answer cut off.
  // The provider moves into the <optgroup> label, where it is said once.
  const byProvider = useMemo(() => {
    const map = new Map<string, { name: string; models: ModelOption[] }>();
    for (const option of selectable) {
      const group = map.get(option.providerID) ?? { name: option.providerName, models: [] };
      group.models.push(option);
      map.set(option.providerID, group);
    }
    return [...map.values()];
  }, [selectable]);
  // Effort levels each model exposes — the vocabulary differs per model, so a
  // row's choices follow whichever model that agent actually runs.
  const variantsByKey = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const p of providers) {
      for (const m of p.models) map.set(`${p.id}/${m.id}`, m.variants ?? []);
    }
    return map;
  }, [providers]);
  // Agents the user can address, plus the runtime's own utility agents, kept
  // as two GROUPS rather than one flat list: which of these answer your
  // messages and which run behind your back is the first thing a reader needs,
  // and a single column of ids never said it. The list is deduped — a runtime
  // may already expose "summary" as an agent, in which case its own
  // description wins and it stays in the group it was announced in.
  const groups = useMemo(() => {
    const named = agents.map((a) => a.name);
    return {
      conversation: agents.map((a) => ({ name: a.name, description: a.description })),
      utility: UTILITY_AGENTS.filter((u) => !named.includes(u)).map((name) => ({
        name,
        description: "",
      })),
    };
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

  const anyBusy = busyAgent !== null;

  /** One agent: what it is on the left, what it runs on the right. */
  const agentRow = (agent: { name: string; description: string }, utility: boolean) => {
    const variants = variantsFor(agent.name);
    const pinned = overrides[agent.name];
    const retired = pinned ? options.find((o) => o.key === pinned && !o.available) : undefined;
    return (
      <Row
        key={agent.name}
        title={agent.name}
        hint={agent.description || (utility ? utilityHint(t, agent.name) : undefined)}
        control={
          <div className="flex shrink-0 items-center gap-1">
            {busyAgent === agent.name && <Loader2 size={13} className="animate-spin text-muted" />}
            <select
              value={pinned ?? ""}
              disabled={anyBusy}
              onChange={(e) => void choose(agent.name, e.target.value)}
              aria-label={t("agentModels.modelFor", { agent: agent.name })}
              className={chipCls("max-w-[13rem] pr-1 disabled:opacity-50")}
            >
              {/* Just "the default" — the Model section above already names it,
                  and repeating a long model name in every row is what pushed
                  the chosen value past the control's width in the first place. */}
              <option value="">{t("agentModels.followDefault")}</option>
              {/* A model this agent is pinned to but the provider has retired.
                  Dropping it would leave the select with no matching value, so
                  the row would claim "follow the default" while the config
                  still pins a dead model. */}
              {retired && (
                <option value={retired.key}>
                  {t("agentModels.retiredOption", { model: retired.modelName })}
                </option>
              )}
              {byProvider.map((group) => (
                <optgroup key={group.name} label={group.name}>
                  {group.models.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.modelName}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {/* Effort only exists for models that expose reasoning levels; for
                the rest there is nothing to choose, so nothing shows. */}
            {variants.length > 0 && (
              <select
                value={efforts[agent.name] ?? ""}
                disabled={anyBusy}
                onChange={(e) => void chooseEffort(agent.name, e.target.value)}
                aria-label={t("agentModels.effortFor", { agent: agent.name })}
                className={chipCls("pr-1 text-muted disabled:opacity-50")}
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
        }
      />
    );
  };

  return (
    <Section title={t("agentModels.title")} hint={t("agentModels.hint")} flush>
      {selectable.length === 0 ? (
        <p className="px-4 py-3 text-[13px] text-muted">{t("agentModels.noModels")}</p>
      ) : (
        <>
          <GroupHeader
            title={t("agentModels.group.conversation")}
            hint={t("agentModels.primaryHint")}
            first
          />
          <div className="divide-y divide-faint">
            {groups.conversation.map((agent) => agentRow(agent, false))}
          </div>
          {groups.utility.length > 0 && (
            <>
              <GroupHeader
                title={t("agentModels.group.utility")}
                hint={t("agentModels.utilityHint")}
              />
              <div className="divide-y divide-faint">
                {groups.utility.map((agent) => agentRow(agent, true))}
              </div>
            </>
          )}
        </>
      )}
    </Section>
  );
}

/** What a utility agent does. These carry no description from the runtime, and
 *  the three are named explicitly rather than by a built key so a missing one
 *  is a type error rather than a blank row. */
function utilityHint(
  t: ReturnType<typeof useTranslation<["settings", "common"]>>["t"],
  name: string,
): string | undefined {
  if (name === "title") return t("agentModels.about.title");
  if (name === "summary") return t("agentModels.about.summary");
  if (name === "compaction") return t("agentModels.about.compaction");
  return undefined;
}

/** A band that says what the rows under it have in common. Without it the two
 *  kinds of agent read as one undifferentiated column of ids. */
function GroupHeader({ title, hint, first }: { title: string; hint: string; first?: boolean }) {
  return (
    <div className={cn("bg-surface-2/50 px-4 py-2", !first && "border-t border-faint")}>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</div>
      <p className="mt-0.5 text-xs leading-relaxed text-muted">{hint}</p>
    </div>
  );
}
