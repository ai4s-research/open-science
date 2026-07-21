import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderInfo } from "@ai4s/sdk";
import {
  loadSelectionPreferences,
  resolveSelection,
  saveSelectionPreferences,
  selectionAvailability,
} from "./modelSelection";

const providers: ProviderInfo[] = [
  { id: "p", name: "P", models: [{ id: "base", name: "Base", variants: [] }] },
  { id: "q", name: "Q", models: [{ id: "deep", name: "Deep", variants: ["low", "high"] }] },
];

describe("resolveSelection", () => {
  const fallback = { model: "p/base", variant: null };

  it("prefers current session selection over default", () => {
    expect(resolveSelection({
      currentId: "ses_1",
      defaultSelection: fallback,
      sessionSelections: { ses_1: { model: "q/deep", variant: "high" } },
      draftSelection: null,
    })).toEqual({ model: "q/deep", variant: "high" });
  });

  it("falls back to default when session has no entry", () => {
    expect(resolveSelection({
      currentId: "ses_1",
      defaultSelection: fallback,
      sessionSelections: {},
      draftSelection: null,
    })).toEqual(fallback);
  });

  it("uses draft when no current session", () => {
    expect(resolveSelection({
      currentId: null,
      defaultSelection: fallback,
      sessionSelections: {},
      draftSelection: { model: "p/base", variant: "low" },
    })).toEqual({ model: "p/base", variant: "low" });
  });

  it("falls back to default when no draft", () => {
    expect(resolveSelection({
      currentId: null,
      defaultSelection: fallback,
      sessionSelections: {},
      draftSelection: null,
    })).toEqual(fallback);
  });
});

describe("selectionAvailability", () => {
  it("returns available for an existing model with no variant", () => {
    expect(selectionAvailability({ model: "p/base", variant: null }, providers)).toBe("available");
  });

  it("returns available for a variant that exists", () => {
    expect(selectionAvailability({ model: "q/deep", variant: "high" }, providers)).toBe("available");
  });

  it("returns variant-unavailable when variant is missing from non-empty list", () => {
    expect(selectionAvailability(
      { model: "q/deep", variant: "max" },
      [{ id: "q", name: "Q", models: [{ id: "deep", name: "Deep", variants: ["low", "high"] }] }],
    )).toBe("variant-unavailable");
  });

  it("returns available for any variant when provider returns empty variants", () => {
    expect(selectionAvailability(
      { model: "p/base", variant: "high" },
      [{ id: "p", name: "P", models: [{ id: "base", name: "Base", variants: [] }] }],
    )).toBe("available");
  });

  it("returns model-unavailable when model does not exist", () => {
    expect(selectionAvailability({ model: "missing/x", variant: null }, providers)).toBe("model-unavailable");
  });

  it("returns model-unavailable for null selection", () => {
    expect(selectionAvailability(null, providers)).toBe("model-unavailable");
  });
});

describe("loadSelectionPreferences / saveSelectionPreferences", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  it("loads empty preferences when key is absent", () => {
    expect(loadSelectionPreferences()).toEqual({
      defaultSelection: null,
      sessionSelections: {},
      draftSelection: null,
    });
  });

  it("loads empty preferences on malformed JSON", () => {
    window.localStorage.setItem("ai4s.modelSelections.v1", "{not json");
    expect(loadSelectionPreferences()).toEqual({
      defaultSelection: null,
      sessionSelections: {},
      draftSelection: null,
    });
  });

  it("preserves all three fields through save/load", () => {
    const prefs = {
      defaultSelection: { model: "p/base", variant: null },
      sessionSelections: { ses_a: { model: "q/deep", variant: "high" } },
      draftSelection: null,
    };
    saveSelectionPreferences(prefs);
    expect(loadSelectionPreferences()).toEqual(prefs);
  });
});
