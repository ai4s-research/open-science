import { useEffect, useMemo, useState } from "react";
import { Clock3, Loader2, Search, Star, X } from "lucide-react";
import type { ProviderInfo } from "@ai4s/sdk";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { inputCls } from "./inputCls";
import {
  filterModelOptions,
  flattenModelOptions,
  type ModelFilter,
  type ModelOption,
} from "./modelCatalog";
import {
  loadModelPreferences,
  recordRecent,
  saveModelPreferences,
  toggleFavorite,
  type ModelPreferences,
} from "./modelPreferences";

interface ModelBrowserProps {
  providers: ProviderInfo[];
  defaultModel: string | null;
  busy: boolean;
  onSelect: (model: string) => Promise<boolean>;
  onManageProviders: () => void;
}

export function ModelBrowser({ providers, defaultModel, busy, onSelect, onManageProviders }: ModelBrowserProps) {
  const { t } = useTranslation(["settings", "common"]);
  const [filter, setFilter] = useState<ModelFilter>({ kind: "all" });
  const [query, setQuery] = useState("");
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<ModelPreferences>(loadModelPreferences);
  const options = useMemo(() => flattenModelOptions(providers), [providers]);
  const visible = useMemo(
    () => filterModelOptions(options, filter, query, preferences.favorites, preferences.recent),
    [filter, options, preferences, query],
  );
  const unavailableDefault = Boolean(defaultModel && !options.some((model) => model.key === defaultModel));
  const disabled = busy || pendingModel !== null;

  useEffect(() => {
    if (filter.kind === "provider" && !providers.some((provider) => provider.id === filter.providerID)) {
      setFilter({ kind: "all" });
    }
  }, [filter, providers]);

  const updatePreferences = (next: ModelPreferences) => {
    setPreferences(next);
    saveModelPreferences(next);
  };

  const selectModel = async (model: ModelOption) => {
    if (disabled || model.key === defaultModel) return;
    setPendingModel(model.key);
    try {
      if (await onSelect(model.key)) updatePreferences(recordRecent(preferences, model.key));
    } catch {
      // The caller owns error presentation; a rejection is a failed selection here.
    } finally {
      setPendingModel(null);
    }
  };

  const filterCount = (kind: "favorites" | "recent") =>
    filterModelOptions(options, { kind }, "", preferences.favorites, preferences.recent).length;
  const filters: Array<{ filter: ModelFilter; label: string; count: number; recent?: boolean }> = [
    { filter: { kind: "all" }, label: t("model.allModels"), count: options.length },
    { filter: { kind: "favorites" }, label: t("model.favorites"), count: filterCount("favorites") },
    { filter: { kind: "recent" }, label: t("model.recent"), count: filterCount("recent"), recent: true },
  ];

  const sameFilter = (a: ModelFilter, b: ModelFilter) =>
    a.kind === b.kind && (a.kind !== "provider" || (b.kind === "provider" && a.providerID === b.providerID));

  const emptyText = query.trim()
    ? t("model.noResults", { query: query.trim() })
    : filter.kind === "favorites"
      ? t("model.emptyFavorites")
      : filter.kind === "recent"
        ? t("model.emptyRecent")
        : t("model.noModels");

  return (
    <div>
      {unavailableDefault && (
        <div className="mb-3 rounded-input border border-warn/30 bg-warn/10 px-3 py-2 font-mono text-xs text-warn">
          {t("model.unavailableDefault", { model: defaultModel })}
        </div>
      )}
      {defaultModel === null && options.length > 0 && (
        <p className="mb-3 text-xs text-muted">{t("model.notSet")}</p>
      )}
      {options.length === 0 ? (
        <div className="rounded-input border border-dashed border-border px-4 py-6 text-center">
          <p className="text-[13px] text-muted">{t("model.noModels")}</p>
          <button className="mt-2 text-xs font-medium text-accent hover:underline" onClick={onManageProviders}>
            {t("model.manageProviders")}
          </button>
        </div>
      ) : (
        <div className="grid overflow-hidden rounded-input border border-border sm:grid-cols-[148px_minmax(0,1fr)]">
          <nav aria-label={t("model.filtersLabel")} className="border-b border-border bg-surface-2 p-2 sm:border-b-0 sm:border-r">
            {filters.map((item) => (
              <FilterButton key={item.filter.kind} label={item.label} count={item.count} recent={item.recent}
                active={sameFilter(filter, item.filter)} onClick={() => setFilter(item.filter)} />
            ))}
            <div className="my-2 h-px bg-border" />
            {providers.map((provider) => {
              // eslint-disable-next-line i18next/no-literal-string -- discriminated-union key, not display text
              const providerFilter: ModelFilter = { kind: "provider", providerID: provider.id };
              return <FilterButton key={provider.id} label={provider.name} count={provider.models.length}
                active={sameFilter(filter, providerFilter)} onClick={() => setFilter(providerFilter)} />;
            })}
          </nav>
          <div className="min-w-0 p-3">
            <label className="relative block">
              <span className="sr-only">{t("model.searchLabel")}</span>
              <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -mt-[6.5px] text-muted" />
              <input type="search" value={query} onChange={(event) => setQuery(event.target.value)}
                aria-label={t("model.searchLabel")} placeholder={t("model.searchPlaceholder")}
                className={inputCls("w-full pl-8 pr-8")} />
              {query && <button aria-label={t("model.clearSearch")} onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -mt-3 rounded p-1 text-muted hover:text-text"><X size={14} /></button>}
            </label>
            <div role="list" aria-label={t("model.listLabel")} className="mt-3 max-h-80 space-y-1 overflow-y-auto pr-1">
              {visible.length === 0 ? (
                <div className="px-3 py-8 text-center text-xs text-muted">
                  <p>{emptyText}</p>
                  {query && <button className="mt-2 text-accent hover:underline" onClick={() => setQuery("")}>{t("model.clearSearch")}</button>}
                </div>
              ) : visible.map((model) => {
                const current = model.key === defaultModel;
                const pending = model.key === pendingModel;
                const favorite = preferences.favorites.includes(model.key);
                return (
                  <div role="listitem" key={model.key} className={cn("flex rounded-input border transition-colors", current ? "border-accent bg-accent/10" : "border-border bg-surface hover:bg-surface-2")}>
                    {/* Never DOM-disable the rows: a disabled element leaves the
                        tab order and the browser drops focus to <body>, so a
                        keyboard user would lose their place on every switch.
                        aria-disabled + the selectModel guard block interaction. */}
                    <button aria-current={current ? "true" : undefined}
                      aria-disabled={disabled || current ? "true" : undefined}
                      onClick={() => void selectModel(model)}
                      className={cn("min-w-0 flex-1 px-3 py-2 text-left", disabled && "text-muted")}>
                      <span className="flex items-center gap-2 text-[13px] font-medium text-text">
                        <span className="truncate">{model.modelName}</span>
                        {current && <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">{t("model.currentDefault")}</span>}
                        {pending && <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-accent"><Loader2 size={10} className="animate-spin" />{t("model.switching")}</span>}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-muted">{model.providerName}{model.modelName !== model.modelID ? ` · ${model.modelID}` : ""}</span>
                    </button>
                    <button aria-pressed={favorite} aria-disabled={disabled ? "true" : undefined}
                      aria-label={t(favorite ? "model.removeFavorite" : "model.addFavorite", { model: model.modelName })}
                      onClick={() => { if (!disabled) updatePreferences(toggleFavorite(preferences, model.key)); }}
                      className="m-1.5 rounded-input p-2 text-muted hover:bg-surface-2 hover:text-accent">
                      <Star size={14} className={favorite ? "fill-current text-accent" : ""} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FilterButton({ label, count, active, recent = false, onClick }: { label: string; count: number; active: boolean; recent?: boolean; onClick: () => void }) {
  return <button aria-pressed={active} onClick={onClick}
    className={cn("flex w-full items-center gap-2 rounded-input px-2.5 py-2 text-left text-xs transition-colors", active ? "bg-surface text-text shadow-sm" : "text-muted hover:bg-surface hover:text-text")}>
    {recent && <Clock3 size={12} />}
    <span className="min-w-0 flex-1 truncate">{label}</span><span className="text-[10px] text-muted">{count}</span>
  </button>;
}
