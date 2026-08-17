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
}

export type ModelFilter =
  | { kind: "all" }
  | { kind: "favorites" }
  | { kind: "recent" }
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
    })),
  );
}

/** The options a user may pick, i.e. everything the provider still serves. */
export function selectableModelOptions(options: ModelOption[]): ModelOption[] {
  return options.filter((model) => model.available);
}

/**
 * Where the configured default model should land after a provider change made
 * it dangling (provider removed, or its models renamed): null when the default
 * is still in the catalog — or nothing is left to fall back to — otherwise the
 * closest valid "provider/model" key: the same provider's first model when the
 * provider survived, else the first model of the first provider.
 */
export function fallbackDefaultModel(providers: ProviderInfo[], defaultModel: string): string | null {
  const options = flattenModelOptions(providers);
  // A retired model still counts as configured: silently re-pointing it would
  // change the user's model without asking — onto a paid one, for a provider
  // like Zen where the free tier is what they chose. The pickers say so and let
  // them choose. Only a model that has left the catalog entirely is dangling.
  if (options.some((m) => m.key === defaultModel)) return null;
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
): ModelOption[] {
  const normalized = query.trim().toLocaleLowerCase();
  const candidates = baseOptions(options, filter, favorites, recent);
  if (!normalized) return candidates;
  return candidates.filter((model) =>
    [model.modelName, model.modelID, model.providerName, model.providerID]
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalized),
  );
}
