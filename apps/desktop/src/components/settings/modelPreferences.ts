export const FAVORITES_KEY = "ai4s.models.favorites.v1";
export const RECENT_KEY = "ai4s.models.recent.v1";
export const RECENT_LIMIT = 8;

export interface ModelPreferences {
  favorites: string[];
  recent: string[];
}

function readStringArray(key: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((item): item is string => typeof item === "string" && item.length > 0))];
  } catch {
    return [];
  }
}

export function loadModelPreferences(): ModelPreferences {
  return {
    favorites: readStringArray(FAVORITES_KEY),
    recent: readStringArray(RECENT_KEY).slice(0, RECENT_LIMIT),
  };
}

export function saveModelPreferences(preferences: ModelPreferences): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(preferences.favorites));
  window.localStorage.setItem(RECENT_KEY, JSON.stringify(preferences.recent));
}

export function toggleFavorite(preferences: ModelPreferences, model: string): ModelPreferences {
  const exists = preferences.favorites.includes(model);
  return {
    ...preferences,
    favorites: exists
      ? preferences.favorites.filter((item) => item !== model)
      : [...preferences.favorites, model],
  };
}

export function recordRecent(preferences: ModelPreferences, model: string): ModelPreferences {
  return {
    ...preferences,
    recent: [model, ...preferences.recent.filter((item) => item !== model)].slice(0, RECENT_LIMIT),
  };
}
