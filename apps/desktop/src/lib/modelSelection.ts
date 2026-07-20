import type { ProviderInfo } from "@ai4s/sdk";

export const MODEL_SELECTIONS_KEY = "ai4s.modelSelections.v1";

export interface ModelSelection {
  model: string;
  variant: string | null;
}

export interface SelectionPreferences {
  defaultSelection: ModelSelection | null;
  sessionSelections: Record<string, ModelSelection>;
  draftSelection: ModelSelection | null;
}

export type SelectionAvailability =
  | "available"
  | "model-unavailable"
  | "variant-unavailable";

export function resolveSelection(input: {
  currentId: string | null;
  defaultSelection: ModelSelection | null;
  sessionSelections: Record<string, ModelSelection>;
  draftSelection: ModelSelection | null;
}): ModelSelection | null {
  return input.currentId
    ? input.sessionSelections[input.currentId] ?? input.defaultSelection
    : input.draftSelection ?? input.defaultSelection;
}

export function selectionAvailability(
  selection: ModelSelection | null,
  providers: ProviderInfo[],
): SelectionAvailability {
  if (!selection) return "model-unavailable";
  const [providerID, ...modelParts] = selection.model.split("/");
  const modelID = modelParts.join("/");
  const model = providers.find((p) => p.id === providerID)?.models.find((m) => m.id === modelID);
  if (!model) return "model-unavailable";
  if (selection.variant && !model.variants.includes(selection.variant)) return "variant-unavailable";
  return "available";
}

export function loadSelectionPreferences(): SelectionPreferences {
  if (typeof window === "undefined") return emptyPreferences();
  try {
    const raw = window.localStorage.getItem(MODEL_SELECTIONS_KEY);
    if (!raw) return emptyPreferences();
    const parsed = JSON.parse(raw) as Partial<SelectionPreferences>;
    return {
      defaultSelection: parsed.defaultSelection ?? null,
      sessionSelections: parsed.sessionSelections ?? {},
      draftSelection: parsed.draftSelection ?? null,
    };
  } catch {
    return emptyPreferences();
  }
}

export function saveSelectionPreferences(prefs: SelectionPreferences): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MODEL_SELECTIONS_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage full or unavailable — swallow silently, startup still works
  }
}

function emptyPreferences(): SelectionPreferences {
  return {
    defaultSelection: null,
    sessionSelections: {},
    draftSelection: null,
  };
}
