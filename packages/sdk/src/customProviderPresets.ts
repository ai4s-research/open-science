export type CustomProviderCompatibility = "@ai-sdk/openai-compatible" | "@ai-sdk/anthropic";

export type CustomProviderModality = "text" | "audio" | "image" | "video" | "pdf";

export type CustomProviderPresetLabelKey =
  | "providers.minimaxGlobalOpenai"
  | "providers.minimaxGlobalAnthropic"
  | "providers.minimaxCnOpenai"
  | "providers.minimaxCnAnthropic";

export interface CustomProviderModel {
  id: string;
  name?: string;
  context?: number;
  cost?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  };
  modalities?: {
    input?: CustomProviderModality[];
    output?: CustomProviderModality[];
  };
  reasoning?: boolean;
  /** Provider-reported thinking modes; selectable modes are serialized as variants. */
  thinking?: string[];
  variants?: Record<string, Record<string, unknown>>;
}

export interface CustomProviderPreset {
  id: string;
  providerId: string;
  name: string;
  region: "global" | "cn";
  compatibility: "openai" | "anthropic";
  npm: CustomProviderCompatibility;
  baseURL: string;
  labelKey: CustomProviderPresetLabelKey;
  models: readonly CustomProviderModel[];
}

const MINIMAX_MODELS: CustomProviderModel[] = [
  {
    id: "MiniMax-M3",
    context: 1_000_000,
    modalities: { input: ["text", "image", "video"] },
    reasoning: true,
    thinking: ["adaptive", "disabled"],
    variants: {
      adaptive: { thinking: { type: "adaptive" } },
      disabled: { thinking: { type: "disabled" } },
    },
  },
  {
    id: "MiniMax-M2.7",
    context: 204_800,
    modalities: { input: ["text"] },
    reasoning: true,
    // Always-on thinking has no selectable request override.
    thinking: ["always_on"],
  },
];

function makePreset(
  id: string,
  region: CustomProviderPreset["region"],
  compatibility: CustomProviderPreset["compatibility"],
  baseURL: string,
  labelKey: CustomProviderPresetLabelKey,
): CustomProviderPreset {
  return {
    id,
    providerId: "minimax",
    name: "MiniMax",
    region,
    compatibility,
    npm: compatibility === "openai" ? "@ai-sdk/openai-compatible" : "@ai-sdk/anthropic",
    baseURL,
    labelKey,
    models: MINIMAX_MODELS,
  };
}

/** Curated presets for the custom endpoint form: a shortcut past typing a base
 *  URL, a model list and a context window by hand. Nothing here privileges a
 *  provider — every field a preset fills stays editable, and a provider reaches
 *  the app the same way with or without an entry in this list. MiniMax is here
 *  because its four endpoints (two protocols x two regions) are the ones people
 *  get wrong; add others as data, not as new code. */
export const CUSTOM_PROVIDER_PRESETS: readonly CustomProviderPreset[] = [
  makePreset(
    "minimax-global-openai",
    "global",
    "openai",
    "https://api.minimax.io/v1",
    "providers.minimaxGlobalOpenai",
  ),
  makePreset(
    "minimax-global-anthropic",
    "global",
    "anthropic",
    "https://api.minimax.io/anthropic",
    "providers.minimaxGlobalAnthropic",
  ),
  makePreset(
    "minimax-cn-openai",
    "cn",
    "openai",
    "https://api.minimaxi.com/v1",
    "providers.minimaxCnOpenai",
  ),
  makePreset(
    "minimax-cn-anthropic",
    "cn",
    "anthropic",
    "https://api.minimaxi.com/anthropic",
    "providers.minimaxCnAnthropic",
  ),
];
