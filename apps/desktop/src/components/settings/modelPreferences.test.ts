import { beforeEach, describe, expect, it } from "vitest";
import {
  FAVORITES_KEY,
  RECENT_KEY,
  loadModelPreferences,
  recordRecent,
  saveModelPreferences,
  toggleFavorite,
} from "./modelPreferences";

describe("model preferences", () => {
  beforeEach(() => window.localStorage.clear());

  it("falls back safely when stored JSON is invalid", () => {
    window.localStorage.setItem(FAVORITES_KEY, "not-json");
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(["openai/gpt-5", 7]));
    expect(loadModelPreferences()).toEqual({ favorites: [], recent: ["openai/gpt-5"] });
  });

  it("toggles a favorite without duplicates", () => {
    const added = toggleFavorite({ favorites: [], recent: [] }, "openai/gpt-5");
    expect(added.favorites).toEqual(["openai/gpt-5"]);
    expect(toggleFavorite(added, "openai/gpt-5").favorites).toEqual([]);
  });

  it("records recent models newest-first, deduplicated, and capped at eight", () => {
    const seed = { favorites: [], recent: Array.from({ length: 8 }, (_, i) => `p/m${i}`) };
    expect(recordRecent(seed, "p/m3").recent).toEqual([
      "p/m3", "p/m0", "p/m1", "p/m2", "p/m4", "p/m5", "p/m6", "p/m7",
    ]);
    expect(recordRecent(seed, "p/new").recent).toHaveLength(8);
    expect(recordRecent(seed, "p/new").recent[0]).toBe("p/new");
  });

  it("round-trips preferences through localStorage", () => {
    saveModelPreferences({ favorites: ["openai/o3"], recent: ["ollama/qwen"] });
    expect(loadModelPreferences()).toEqual({
      favorites: ["openai/o3"],
      recent: ["ollama/qwen"],
    });
  });
});
