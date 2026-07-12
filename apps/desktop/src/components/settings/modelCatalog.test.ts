import { describe, expect, it } from "vitest";
import type { ProviderInfo } from "@ai4s/sdk";
import {
  filterModelOptions,
  flattenModelOptions,
  type ModelFilter,
} from "./modelCatalog";

const providers: ProviderInfo[] = [
  {
    id: "openai",
    name: "OpenAI",
    models: [
      { id: "gpt-5.2", name: "GPT-5.2" },
      { id: "o3", name: "o3" },
    ],
  },
  {
    id: "ollama-cloud",
    name: "Ollama Cloud",
    models: [{ id: "qwen3-coder", name: "Qwen3 Coder" }],
  },
];

const options = flattenModelOptions(providers);
const favorites = ["openai/o3", "missing/model"];
const recent = ["ollama-cloud/qwen3-coder", "openai/gpt-5.2", "missing/model"];

describe("model catalog", () => {
  it("flattens providers into canonical model options without changing order", () => {
    expect(options.map((m) => m.key)).toEqual([
      "openai/gpt-5.2",
      "openai/o3",
      "ollama-cloud/qwen3-coder",
    ]);
  });

  it.each([
    ["gpt-5.2", ["openai/gpt-5.2"]],
    ["QWEN3", ["ollama-cloud/qwen3-coder"]],
    ["ollama cloud", ["ollama-cloud/qwen3-coder"]],
    ["OPENAI", ["openai/gpt-5.2", "openai/o3"]],
  ])("searches model names, ids, and providers with query %s", (query, expected) => {
    expect(filterModelOptions(options, { kind: "all" }, query, favorites, recent).map((m) => m.key))
      .toEqual(expected);
  });

  it("filters favorites while keeping unavailable favorites outside the visible list", () => {
    expect(filterModelOptions(options, { kind: "favorites" }, "", favorites, recent).map((m) => m.key))
      .toEqual(["openai/o3"]);
  });

  it("preserves recent preference order", () => {
    expect(filterModelOptions(options, { kind: "recent" }, "", favorites, recent).map((m) => m.key))
      .toEqual(["ollama-cloud/qwen3-coder", "openai/gpt-5.2"]);
  });

  it("limits a provider filter (an empty query filters nothing away)", () => {
    const filter: ModelFilter = { kind: "provider", providerID: "openai" };
    expect(filterModelOptions(options, filter, "", favorites, recent).map((m) => m.key))
      .toEqual(["openai/gpt-5.2", "openai/o3"]);
    expect(filterModelOptions(options, { kind: "all" }, "", favorites, recent)).toHaveLength(3);
  });
});
