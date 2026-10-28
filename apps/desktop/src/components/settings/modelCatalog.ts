import type { ProviderInfo } from "@ai4s/sdk";

export interface ModelOption {
  key: string;
  providerID: string;
  providerName: string;
  modelID: string;
  modelName: string;
  /** False when the provider has retired the model — see ProviderModelInfo.
   *  Selectable lists must leave these out; lookups by key must not, or the
   *  model a user already has configured would resolve to nothing. */
  available: boolean;
  /** True only when the catalog says the model costs nothing. */
  free: boolean;
}

export type ModelFilter =
  | { kind: "all" }
  | { kind: "favorites" }
  | { kind: "recent" }
  /** Models that arrived with a recent catalog update. */
  | { kind: "new" }
  | { kind: "provider"; providerID: string };

export function flattenModelOptions(providers: ProviderInfo[]): ModelOption[] {
  return providers.flatMap((provider) =>
    provider.models.map((model) => ({
      key: `${provider.id}/${model.id}`,
      providerID: provider.id,
      providerName: provider.name,
      modelID: model.id,
      modelName: model.name,
      available: model.available !== false,
      free: model.free === true,
    })),
  );
}

/** The options a user may pick, i.e. everything the provider still serves. */
export function selectableModelOptions(options: ModelOption[]): ModelOption[] {
  return options.filter((model) => model.available);
}

/**
 * Where the configured default model should land when it can no longer serve a
 * turn, or null to leave it as it is.
 *
 * - Dangling (provider removed, or its models renamed): the same provider's
 *   first model when the provider survived, else the first model of the first
 *   provider.
 * - Retired but still listed (the provider stopped serving it before the
 *   catalog caught up): only a free model is re-pointed, and only at a free
 *   model of the same provider, so the switch can never start costing money.
 *   A paid one stays, and the picker says it is retired: choosing what to pay
 *   for is the user's call.
 */
export function fallbackDefaultModel(providers: ProviderInfo[], defaultModel: string): string | null {
  const options = flattenModelOptions(providers);
  const current = options.find((m) => m.key === defaultModel);
  if (current) {
    if (current.available || !current.free) return null;
    const free = selectableModelOptions(options).find(
      (m) => m.free && m.providerID === current.providerID,
    );
    return free?.key ?? null;
  }
  const candidates = selectableModelOptions(options);
  if (candidates.length === 0) return null;
  const providerID = defaultModel.split("/")[0];
  return (candidates.find((m) => m.providerID === providerID) ?? candidates[0]).key;
}

function baseOptions(
  all: ModelOption[],
  filter: ModelFilter,
  favorites: string[],
  recent: string[],
  newKeys: string[],
): ModelOption[] {
  // Every list here is a list to pick from, so a retired model belongs in none
  // of them — including favorites and recents, where it is exactly the model a
  // user is most likely to reach for again.
  const options = selectableModelOptions(all);
  if (filter.kind === "provider") return options.filter((m) => m.providerID === filter.providerID);
  if (filter.kind === "favorites") {
    const favoriteSet = new Set(favorites);
    return options.filter((m) => favoriteSet.has(m.key));
  }
  if (filter.kind === "new") {
    const fresh = new Set(newKeys);
    return options.filter((m) => fresh.has(m.key));
  }
  if (filter.kind === "recent") {
    const byKey = new Map(options.map((model) => [model.key, model]));
    return recent.flatMap((key) => {
      const model = byKey.get(key);
      return model ? [model] : [];
    });
  }
  return options;
}

export function filterModelOptions(
  options: ModelOption[],
  filter: ModelFilter,
  query: string,
  favorites: string[],
  recent: string[],
  newKeys: string[] = [],
): ModelOption[] {
  const normalized = query.trim().toLocaleLowerCase();
  const candidates = baseOptions(options, filter, favorites, recent, newKeys);
  if (!normalized) return candidates;
  return candidates.filter((model) =>
    [model.modelName, model.modelID, model.providerName, model.providerID]
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalized),
  );
}
