# Model Selection Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Settings page's large native model dropdown with a searchable two-column model browser and move provider configuration into a separate collapsed card.

**Architecture:** Keep OpenCode and `useRuntimeStore.setDefaultModel()` as the source of truth. Add pure catalog derivation and local-preference modules, build focused `ModelBrowser` and `ProviderManagerCard` components, then integrate them into `SettingsPage` without changing provider authentication or runtime APIs.

**Tech Stack:** React 18, TypeScript, Zustand, Tailwind CSS, i18next, Vitest, Testing Library, Tauri 2.

## Global Constraints

- Follow `AGENTS.md`: project files and code are English, changes are minimal and verifiable, and conclusions are tied to tests or runtime evidence.
- Preserve immediate model selection and the existing masked OpenCode reconnect.
- Do not add backend, SDK, provider-catalog, per-session model, pricing, ranking, recommendation, or inferred capability metadata.
- Store favorites and recent models only in browser `localStorage` under versioned `ai4s.*` keys.
- Record a model in recent history only when `setDefaultModel()` completes successfully; cap history at 8 canonical `providerID/modelID` entries.
- A post-write reconnect failure must display the runtime store's authoritative `defaultModel`; do not claim rollback.
- Add every new user-facing key to all seven shipped locales: `en`, `zh-Hans`, `ja`, `es`, `de`, `fr`, and `ko`.
- Preserve the current no-opacity-transition rule in Settings controls to avoid packaged WKWebView repaint flicker.
- Before Task 1, create or enter the implementation worktree with `superpowers:using-git-worktrees`, then run `corepack pnpm install --frozen-lockfile` from its root.

---

### Task 1: Pure model catalog and filtering logic

**Files:**
- Create: `apps/desktop/src/components/settings/modelCatalog.ts`
- Create: `apps/desktop/src/components/settings/modelCatalog.test.ts`

**Interfaces:**
- Consumes: `ProviderInfo[]` from `@ai4s/sdk`, favorite canonical IDs, and recent canonical IDs.
- Produces: `ModelOption`, `ModelFilter`, `flattenModelOptions()`, `filterModelOptions()`, and `countModelOptions()` for the UI in Task 3.

- [ ] **Step 1: Write the failing catalog tests**

Create `modelCatalog.test.ts` with concrete provider fixtures and assertions:

```ts
import { describe, expect, it } from "vitest";
import type { ProviderInfo } from "@ai4s/sdk";
import {
  countModelOptions,
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

  it("limits a provider filter and counts each available filter", () => {
    const filter: ModelFilter = { kind: "provider", providerID: "openai" };
    expect(filterModelOptions(options, filter, "", favorites, recent).map((m) => m.key))
      .toEqual(["openai/gpt-5.2", "openai/o3"]);
    expect(countModelOptions(options, { kind: "all" }, favorites, recent)).toBe(3);
    expect(countModelOptions(options, { kind: "favorites" }, favorites, recent)).toBe(1);
    expect(countModelOptions(options, { kind: "recent" }, favorites, recent)).toBe(2);
    expect(countModelOptions(options, filter, favorites, recent)).toBe(2);
  });
});
```

- [ ] **Step 2: Run the tests and verify the missing-module failure**

Run:

```powershell
corepack pnpm --filter @ai4s/desktop exec vitest run src/components/settings/modelCatalog.test.ts
```

Expected: FAIL because `./modelCatalog` does not exist.

- [ ] **Step 3: Implement the pure catalog module**

Create `modelCatalog.ts`:

```ts
import type { ProviderInfo } from "@ai4s/sdk";

export interface ModelOption {
  key: string;
  providerID: string;
  providerName: string;
  modelID: string;
  modelName: string;
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
    })),
  );
}

function baseOptions(
  options: ModelOption[],
  filter: ModelFilter,
  favorites: string[],
  recent: string[],
): ModelOption[] {
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

export function countModelOptions(
  options: ModelOption[],
  filter: ModelFilter,
  favorites: string[],
  recent: string[],
): number {
  return baseOptions(options, filter, favorites, recent).length;
}
```

- [ ] **Step 4: Run the focused test and typecheck**

Run:

```powershell
corepack pnpm --filter @ai4s/desktop exec vitest run src/components/settings/modelCatalog.test.ts
corepack pnpm typecheck
```

Expected: catalog tests PASS and typecheck exits 0.

- [ ] **Step 5: Commit the catalog unit**

```powershell
git add apps/desktop/src/components/settings/modelCatalog.ts apps/desktop/src/components/settings/modelCatalog.test.ts
git commit -m "feat(settings): add model catalog filtering"
```

---

### Task 2: Local favorites and recent-model persistence

**Files:**
- Create: `apps/desktop/src/components/settings/modelPreferences.ts`
- Create: `apps/desktop/src/components/settings/modelPreferences.test.ts`

**Interfaces:**
- Consumes: canonical model IDs in `providerID/modelID` format.
- Produces: `ModelPreferences`, `loadModelPreferences()`, `saveModelPreferences()`, `toggleFavorite()`, and `recordRecent()` for Task 3.

- [ ] **Step 1: Write the failing persistence tests**

```ts
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
```

- [ ] **Step 2: Run the focused test and verify it fails because the module is missing**

```powershell
corepack pnpm --filter @ai4s/desktop exec vitest run src/components/settings/modelPreferences.test.ts
```

Expected: FAIL resolving `./modelPreferences`.

- [ ] **Step 3: Implement validated versioned localStorage persistence**

```ts
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
```

- [ ] **Step 4: Run focused tests and typecheck**

```powershell
corepack pnpm --filter @ai4s/desktop exec vitest run src/components/settings/modelPreferences.test.ts
corepack pnpm typecheck
```

Expected: preference tests PASS and typecheck exits 0.

- [ ] **Step 5: Commit the persistence unit**

```powershell
git add apps/desktop/src/components/settings/modelPreferences.ts apps/desktop/src/components/settings/modelPreferences.test.ts
git commit -m "feat(settings): persist model favorites and recent history"
```

---

### Task 3: Searchable two-column ModelBrowser

**Files:**
- Create: `apps/desktop/src/components/settings/ModelBrowser.tsx`
- Create: `apps/desktop/src/components/settings/ModelBrowser.test.tsx`
- Modify: `apps/desktop/src/i18n/locales/en/settings.json`
- Modify: `apps/desktop/src/i18n/locales/zh-Hans/settings.json`
- Modify: `apps/desktop/src/i18n/locales/ja/settings.json`
- Modify: `apps/desktop/src/i18n/locales/es/settings.json`
- Modify: `apps/desktop/src/i18n/locales/de/settings.json`
- Modify: `apps/desktop/src/i18n/locales/fr/settings.json`
- Modify: `apps/desktop/src/i18n/locales/ko/settings.json`

**Interfaces:**
- Consumes: Task 1 catalog helpers, Task 2 preference helpers, `ProviderInfo[]`, controlled `defaultModel`, `busy`, `onSelect(model): Promise<boolean>`, and `onManageProviders()`.
- Produces: an accessible `ModelBrowser` component used by `SettingsPage` in Task 5.

- [ ] **Step 1: Add failing component tests for filters, search, keyboard access, favorites, pending selection, success, and failure**

Use this fixture and test structure in `ModelBrowser.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "@ai4s/sdk";
import { loadModelPreferences } from "./modelPreferences";
import { ModelBrowser } from "./ModelBrowser";

const providers: ProviderInfo[] = [
  { id: "openai", name: "OpenAI", models: [
    { id: "gpt-5.2", name: "GPT-5.2" },
    { id: "o3", name: "o3" },
  ] },
  { id: "ollama", name: "Ollama Cloud", models: [
    { id: "qwen3-coder", name: "Qwen3 Coder" },
  ] },
];

describe("ModelBrowser", () => {
  beforeEach(() => window.localStorage.clear());

  it("filters by provider and searches the active filter", async () => {
    render(<ModelBrowser providers={providers} defaultModel={null} busy={false}
      onSelect={vi.fn()} onManageProviders={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Ollama Cloud/ }));
    expect(screen.getByRole("button", { name: /^Qwen3 Coder/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /GPT-5.2/ })).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search models" }), "missing");
    expect(screen.getByText(/No models match/)).toBeInTheDocument();
  });

  it("favorites without selecting and persists the result", async () => {
    const onSelect = vi.fn<(model: string) => Promise<boolean>>();
    render(<ModelBrowser providers={providers} defaultModel={null} busy={false}
      onSelect={onSelect} onManageProviders={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Add o3 to favorites" }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(loadModelPreferences().favorites).toEqual(["openai/o3"]);
    await userEvent.click(screen.getByRole("button", { name: /Favorites/ }));
    expect(screen.getByRole("button", { name: /^o3/ })).toBeInTheDocument();
  });

  it("supports keyboard activation for filters, favorites, and model rows", async () => {
    const onSelect = vi.fn().mockResolvedValue(true);
    render(<ModelBrowser providers={providers} defaultModel={null} busy={false}
      onSelect={onSelect} onManageProviders={vi.fn()} />);

    const providerFilter = screen.getByRole("button", { name: /Ollama Cloud/ });
    providerFilter.focus();
    await userEvent.keyboard("{Enter}");

    const favoriteButton = screen.getByRole("button", { name: "Add Qwen3 Coder to favorites" });
    favoriteButton.focus();
    await userEvent.keyboard(" ");
    expect(loadModelPreferences().favorites).toEqual(["ollama/qwen3-coder"]);
    expect(onSelect).not.toHaveBeenCalled();

    const modelRow = screen.getByRole("button", { name: /^Qwen3 Coder/ });
    modelRow.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("ollama/qwen3-coder"));
  });

  it("blocks repeated selection while pending and records recent only on success", async () => {
    let resolveSelection!: (value: boolean) => void;
    const onSelect = vi.fn(() => new Promise<boolean>((resolve) => { resolveSelection = resolve; }));
    render(<ModelBrowser providers={providers} defaultModel="openai/gpt-5.2" busy={false}
      onSelect={onSelect} onManageProviders={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /^o3/ }));
    expect(screen.getByText("Switching…")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Qwen3 Coder/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    resolveSelection(true);
    await waitFor(() => expect(loadModelPreferences().recent).toEqual(["openai/o3"]));
  });

  it("does not update recent history when selection fails", async () => {
    const onSelect = vi.fn().mockResolvedValue(false);
    render(<ModelBrowser providers={providers} defaultModel="openai/gpt-5.2" busy={false}
      onSelect={onSelect} onManageProviders={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /^o3/ }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("openai/o3"));
    expect(loadModelPreferences().recent).toEqual([]);
  });

  it("shows an unavailable configured default and exposes provider management when empty", () => {
    const onManageProviders = vi.fn();
    const { rerender } = render(<ModelBrowser providers={providers} defaultModel="gone/model" busy={false}
      onSelect={vi.fn()} onManageProviders={onManageProviders} />);
    expect(screen.getByText(/Configured model unavailable: gone\/model/)).toBeInTheDocument();
    rerender(<ModelBrowser providers={[]} defaultModel={null} busy={false}
      onSelect={vi.fn()} onManageProviders={onManageProviders} />);
    expect(screen.getByRole("button", { name: "Manage providers" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the focused component test and verify the missing-component failure**

```powershell
corepack pnpm --filter @ai4s/desktop exec vitest run src/components/settings/ModelBrowser.test.tsx
```

Expected: FAIL resolving `./ModelBrowser`.

- [ ] **Step 3: Add the exact new model strings to all seven locale files**

Add these keys beneath each locale's existing `model` object. Use the following exact translations; keep i18next interpolation names unchanged:

| Key | en | zh-Hans | ja | es | de | fr | ko |
|---|---|---|---|---|---|---|---|
| `filtersLabel` | Model filters | 模型筛选 | モデルフィルター | Filtros de modelos | Modellfilter | Filtres de modèles | 모델 필터 |
| `allModels` | All models | 全部模型 | すべてのモデル | Todos los modelos | Alle Modelle | Tous les modèles | 모든 모델 |
| `favorites` | Favorites | 收藏 | お気に入り | Favoritos | Favoriten | Favoris | 즐겨찾기 |
| `recent` | Recent | 最近使用 | 最近使用したモデル | Recientes | Zuletzt verwendet | Récents | 최근 사용 |
| `searchLabel` | Search models | 搜索模型 | モデルを検索 | Buscar modelos | Modelle suchen | Rechercher des modèles | 모델 검색 |
| `searchPlaceholder` | Search by model, ID, or provider | 按模型、ID 或供应商搜索 | モデル、ID、プロバイダーで検索 | Buscar por modelo, ID o proveedor | Nach Modell, ID oder Anbieter suchen | Rechercher par modèle, ID ou fournisseur | 모델, ID 또는 공급자로 검색 |
| `listLabel` | Available models | 可用模型 | 利用可能なモデル | Modelos disponibles | Verfügbare Modelle | Modèles disponibles | 사용 가능한 모델 |
| `currentDefault` | Current default | 当前默认 | 現在のデフォルト | Predeterminado actual | Aktueller Standard | Modèle par défaut actuel | 현재 기본값 |
| `switching` | Switching… | 切换中… | 切り替え中… | Cambiando… | Wird gewechselt… | Changement… | 전환 중… |
| `unavailableDefault` | Configured model unavailable: {{model}} | 已配置的模型不可用：{{model}} | 設定済みモデルは利用できません: {{model}} | El modelo configurado no está disponible: {{model}} | Konfiguriertes Modell nicht verfügbar: {{model}} | Modèle configuré indisponible : {{model}} | 구성된 모델을 사용할 수 없음: {{model}} |
| `noModels` | No models available. | 没有可用模型。 | 利用可能なモデルがありません。 | No hay modelos disponibles. | Keine Modelle verfügbar. | Aucun modèle disponible. | 사용 가능한 모델이 없습니다. |
| `manageProviders` | Manage providers | 管理供应商 | プロバイダーを管理 | Administrar proveedores | Anbieter verwalten | Gérer les fournisseurs | 공급자 관리 |
| `emptyFavorites` | Favorite models appear here. | 收藏的模型会显示在这里。 | お気に入りのモデルがここに表示されます。 | Los modelos favoritos aparecen aquí. | Favorisierte Modelle erscheinen hier. | Les modèles favoris apparaissent ici. | 즐겨찾기 모델이 여기에 표시됩니다. |
| `emptyRecent` | Successfully selected models appear here. | 成功选择过的模型会显示在这里。 | 選択に成功したモデルがここに表示されます。 | Los modelos seleccionados correctamente aparecen aquí. | Erfolgreich ausgewählte Modelle erscheinen hier. | Les modèles sélectionnés avec succès apparaissent ici. | 성공적으로 선택한 모델이 여기에 표시됩니다. |
| `noResults` | No models match “{{query}}”. | 没有模型匹配“{{query}}”。 | 「{{query}}」に一致するモデルはありません。 | Ningún modelo coincide con «{{query}}». | Keine Modelle entsprechen „{{query}}“. | Aucun modèle ne correspond à « {{query}} ». | “{{query}}”와 일치하는 모델이 없습니다. |
| `clearSearch` | Clear search | 清除搜索 | 検索をクリア | Borrar búsqueda | Suche löschen | Effacer la recherche | 검색 지우기 |
| `addFavorite` | Add {{model}} to favorites | 将 {{model}} 添加到收藏 | {{model}} をお気に入りに追加 | Añadir {{model}} a favoritos | {{model}} zu Favoriten hinzufügen | Ajouter {{model}} aux favoris | {{model}}을 즐겨찾기에 추가 |
| `removeFavorite` | Remove {{model}} from favorites | 从收藏中移除 {{model}} | {{model}} をお気に入りから削除 | Quitar {{model}} de favoritos | {{model}} aus Favoriten entfernen | Retirer {{model}} des favoris | {{model}}을 즐겨찾기에서 제거 |

- [ ] **Step 4: Implement `ModelBrowser` with controlled runtime state and local preferences**

Implement these exact behaviors in `ModelBrowser.tsx`:

```tsx
import { useEffect, useMemo, useState } from "react";
import { Clock3, Loader2, Search, Star, X } from "lucide-react";
import type { ProviderInfo } from "@ai4s/sdk";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import {
  countModelOptions,
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
    } finally {
      setPendingModel(null);
    }
  };

  const filters: Array<{ filter: ModelFilter; label: string; count: number; recent?: boolean }> = [
    { filter: { kind: "all" }, label: t("model.allModels"), count: options.length },
    { filter: { kind: "favorites" }, label: t("model.favorites"), count: countModelOptions(options, { kind: "favorites" }, preferences.favorites, preferences.recent) },
    { filter: { kind: "recent" }, label: t("model.recent"), count: countModelOptions(options, { kind: "recent" }, preferences.favorites, preferences.recent), recent: true },
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

  if (options.length === 0) {
    return (
      <div className="rounded-input border border-dashed border-border px-4 py-6 text-center">
        <p className="text-[13px] text-muted">{t("model.noModels")}</p>
        <button className="mt-2 text-xs font-medium text-accent hover:underline" onClick={onManageProviders}>
          {t("model.manageProviders")}
        </button>
      </div>
    );
  }

  return (
    <div>
      {unavailableDefault && (
        <div className="mb-3 rounded-input border border-warn/30 bg-warn/10 px-3 py-2 font-mono text-xs text-warn">
          {t("model.unavailableDefault", { model: defaultModel })}
        </div>
      )}
      <div className="grid overflow-hidden rounded-input border border-border sm:grid-cols-[148px_minmax(0,1fr)]">
        <nav aria-label={t("model.filtersLabel")} className="border-b border-border bg-surface-2 p-2 sm:border-b-0 sm:border-r">
          {filters.map((item) => (
            <FilterButton key={item.filter.kind} label={item.label} count={item.count} recent={item.recent}
              active={sameFilter(filter, item.filter)} onClick={() => setFilter(item.filter)} />
          ))}
          <div className="my-2 h-px bg-border" />
          {providers.map((provider) => {
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
              className="h-9 w-full rounded-input border border-border bg-surface pl-8 pr-8 text-[13px] text-text outline-none placeholder:text-muted focus:border-accent/60" />
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
                  <button disabled={disabled || current} aria-current={current ? "true" : undefined}
                    onClick={() => void selectModel(model)} className="min-w-0 flex-1 px-3 py-2 text-left disabled:text-muted">
                    <span className="flex items-center gap-2 text-[13px] font-medium text-text">
                      <span className="truncate">{model.modelName}</span>
                      {current && <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">{t("model.currentDefault")}</span>}
                      {pending && <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-accent"><Loader2 size={10} className="animate-spin" />{t("model.switching")}</span>}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted">{model.providerName}{model.modelName !== model.modelID ? ` · ${model.modelID}` : ""}</span>
                  </button>
                  <button aria-pressed={favorite} disabled={disabled}
                    aria-label={t(favorite ? "model.removeFavorite" : "model.addFavorite", { model: model.modelName })}
                    onClick={() => updatePreferences(toggleFavorite(preferences, model.key))}
                    className="m-1.5 rounded-input p-2 text-muted hover:bg-surface-2 hover:text-accent disabled:text-muted">
                    <Star size={14} className={favorite ? "fill-current text-accent" : ""} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
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
```

- [ ] **Step 5: Run component, catalog, preference, and locale parity tests**

```powershell
corepack pnpm --filter @ai4s/desktop exec vitest run src/components/settings/ModelBrowser.test.tsx src/components/settings/modelCatalog.test.ts src/components/settings/modelPreferences.test.ts src/i18n/parity.test.ts
corepack pnpm typecheck
corepack pnpm lint
```

Expected: all focused tests PASS; typecheck and lint exit 0.

- [ ] **Step 6: Commit the model browser and translations**

```powershell
git add apps/desktop/src/components/settings/ModelBrowser.tsx apps/desktop/src/components/settings/ModelBrowser.test.tsx apps/desktop/src/i18n/locales
git commit -m "feat(settings): add searchable model browser"
```

---

### Task 4: Collapsible provider-management card

**Files:**
- Create: `apps/desktop/src/components/settings/ProviderManagerCard.tsx`
- Create: `apps/desktop/src/components/settings/ProviderManagerCard.test.tsx`
- Modify: all seven `apps/desktop/src/i18n/locales/*/settings.json` files.

**Interfaces:**
- Consumes: `ProviderInfo[]`, controlled `expanded`, `onExpandedChange(expanded)`, `disabled`, and existing provider-management JSX as `children`.
- Produces: `ProviderManagerCard`, used in Task 5 without changing any auth handlers.

- [ ] **Step 1: Write the failing card tests**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "@ai4s/sdk";
import { ProviderManagerCard } from "./ProviderManagerCard";

const providers: ProviderInfo[] = [
  { id: "openai", name: "OpenAI", models: [] },
  { id: "opencode", name: "OpenCode Zen", models: [] },
];

describe("ProviderManagerCard", () => {
  it("summarizes providers and keeps management content collapsed", () => {
    render(<ProviderManagerCard providers={providers} expanded={false} disabled={false}
      onExpandedChange={vi.fn()}><div>Provider controls</div></ProviderManagerCard>);
    expect(screen.getByText(/2 connected: OpenAI, OpenCode Zen/)).toBeInTheDocument();
    expect(screen.queryByText("Provider controls")).not.toBeInTheDocument();
  });

  it("requests expansion and exposes controlled expanded content", async () => {
    const onExpandedChange = vi.fn();
    const { rerender } = render(<ProviderManagerCard providers={providers} expanded={false} disabled={false}
      onExpandedChange={onExpandedChange}><div>Provider controls</div></ProviderManagerCard>);
    await userEvent.click(screen.getByRole("button", { name: "Manage" }));
    expect(onExpandedChange).toHaveBeenCalledWith(true);
    rerender(<ProviderManagerCard providers={providers} expanded disabled={false}
      onExpandedChange={onExpandedChange}><div>Provider controls</div></ProviderManagerCard>);
    expect(screen.getByText("Provider controls")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse" })).toHaveAttribute("aria-expanded", "true");
  });
});
```

- [ ] **Step 2: Run the test and verify the missing-component failure**

```powershell
corepack pnpm --filter @ai4s/desktop exec vitest run src/components/settings/ProviderManagerCard.test.tsx
```

Expected: FAIL resolving `./ProviderManagerCard`.

- [ ] **Step 3: Add provider-card translations to all seven locales**

Add exact translations under `providers`:

| Key | en | zh-Hans | ja | es | de | fr | ko |
|---|---|---|---|---|---|---|---|
| `title` | Providers | 供应商 | プロバイダー | Proveedores | Anbieter | Fournisseurs | 공급자 |
| `hint` | Authentication, custom endpoints, and imported OpenCode logins | 登录认证、自定义端点和导入的 OpenCode 登录信息 | 認証、カスタムエンドポイント、インポートした OpenCode ログイン | Autenticación, endpoints personalizados e inicios de sesión de OpenCode importados | Authentifizierung, benutzerdefinierte Endpunkte und importierte OpenCode-Anmeldungen | Authentification, points de terminaison personnalisés et connexions OpenCode importées | 인증, 사용자 지정 엔드포인트 및 가져온 OpenCode 로그인 |
| `manage` | Manage | 管理 | 管理 | Administrar | Verwalten | Gérer | 관리 |
| `collapse` | Collapse | 收起 | 折りたたむ | Contraer | Einklappen | Réduire | 접기 |
| `connectedSummary_other` | {{count}} connected: {{names}} | 已连接 {{count}} 个：{{names}} | {{count}} 件接続済み: {{names}} | {{count}} conectados: {{names}} | {{count}} verbunden: {{names}} | {{count}} connectés : {{names}} | {{count}}개 연결됨: {{names}} |
| `noneConnected` | No providers connected | 未连接供应商 | 接続済みプロバイダーなし | No hay proveedores conectados | Keine Anbieter verbunden | Aucun fournisseur connecté | 연결된 공급자 없음 |

- [ ] **Step 4: Implement the controlled provider card**

```tsx
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { ProviderInfo } from "@ai4s/sdk";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";

interface ProviderManagerCardProps {
  providers: ProviderInfo[];
  expanded: boolean;
  disabled: boolean;
  onExpandedChange: (expanded: boolean) => void;
  children: ReactNode;
}

export function ProviderManagerCard({ providers, expanded, disabled, onExpandedChange, children }: ProviderManagerCardProps) {
  const { t } = useTranslation("settings");
  const names = providers.map((provider) => provider.name).join(", ");
  const summary = providers.length
    ? t("providers.connectedSummary", { count: providers.length, names })
    : t("providers.noneConnected");
  return (
    <section className="mt-5 rounded-card border border-border bg-surface shadow-card">
      <header className="flex items-center gap-3 px-5 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-serif text-[15px] text-text">{t("providers.title")}</h2>
          <p className="mt-0.5 truncate text-xs text-muted">{summary}</p>
          <p className="mt-0.5 text-xs text-muted">{t("providers.hint")}</p>
        </div>
        <button disabled={disabled} aria-expanded={expanded}
          onClick={() => onExpandedChange(!expanded)}
          className="flex h-9 shrink-0 items-center gap-1 rounded-input border border-border bg-surface px-3 text-[13px] text-text transition-colors hover:bg-surface-2 disabled:text-muted">
          <ChevronRight size={13} className={cn("transition-transform", expanded && "rotate-90")} />
          {t(expanded ? "providers.collapse" : "providers.manage")}
        </button>
      </header>
      {expanded && <div className="border-t border-border px-5 py-4">{children}</div>}
    </section>
  );
}
```

- [ ] **Step 5: Run focused tests, locale parity, typecheck, and lint**

```powershell
corepack pnpm --filter @ai4s/desktop exec vitest run src/components/settings/ProviderManagerCard.test.tsx src/i18n/parity.test.ts
corepack pnpm typecheck
corepack pnpm lint
```

Expected: tests PASS; typecheck and lint exit 0.

- [ ] **Step 6: Commit the provider card**

```powershell
git add apps/desktop/src/components/settings/ProviderManagerCard.tsx apps/desktop/src/components/settings/ProviderManagerCard.test.tsx apps/desktop/src/i18n/locales
git commit -m "feat(settings): separate provider management"
```

---

### Task 5: Integrate both cards into SettingsPage

**Files:**
- Modify: `apps/desktop/src/app/routes/SettingsPage.tsx:1-50, 124-140, 268-275, 571-842, 1331-1338`
- Modify: `apps/desktop/src/app/routes/SettingsPage.i18n.test.tsx`

**Interfaces:**
- Consumes: `ModelBrowser` and `ProviderManagerCard` from Tasks 3 and 4.
- Produces: the final Settings flow; `saveModel(model): Promise<boolean>` is the success boundary used by recent history.

- [ ] **Step 1: Add a failing Settings integration test**

Append this test and import `useRuntimeStore`:

```tsx
import { useRuntimeStore } from "@/lib/runtime";

it("renders separate model browsing and provider management surfaces when connected", async () => {
  const original = useRuntimeStore.getState();
  useRuntimeStore.setState({ status: "ready", defaultModel: null });
  const view = renderAt("/settings");
  expect(await screen.findByRole("button", { name: "Manage providers" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { level: 2, name: "Providers" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Manage" })).toHaveAttribute("aria-expanded", "false");
  view.unmount();
  useRuntimeStore.setState({ status: original.status, defaultModel: original.defaultModel });
});
```

- [ ] **Step 2: Run the Settings test and verify it fails before integration**

```powershell
corepack pnpm --filter @ai4s/desktop exec vitest run src/app/routes/SettingsPage.i18n.test.tsx
```

Expected: FAIL because no `Model filters` navigation or Providers card exists.

- [ ] **Step 3: Update Settings imports and state**

- Remove `ChevronDown` from the Lucide import; retain `ChevronRight` for the custom-endpoint control.
- Add:

```ts
import { ModelBrowser } from "@/components/settings/ModelBrowser";
import { ProviderManagerCard } from "@/components/settings/ProviderManagerCard";
```

- Add controlled card state beside the other provider-flow state:

```ts
const [providerManagerOpen, setProviderManagerOpen] = useState(false);
```

- [ ] **Step 4: Replace `saveModel` with an explicit boolean success boundary**

Do not use the generic `run()` wrapper because it catches errors and returns no success value. Use:

```ts
const saveModel = async (model: string): Promise<boolean> => {
  setBusy(true);
  try {
    await useRuntimeStore.getState().setDefaultModel(model);
    toast.success(t("toast.defaultModelSet", { model }));
    return true;
  } catch (error) {
    toast.error(`${t("toast.couldNotSetModel")}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    setBusy(false);
  }
};
```

This deliberately removes the unnecessary provider/catalog refresh after a model-only change. Provider connection and removal handlers continue using `run()` and `refreshAll()`.

- [ ] **Step 5: Replace the native select and provider divider with the two independent cards**

Replace the old model `<select>` and the old `Divider` call with this complete Model card:

```tsx
{/* ---- Models ---- */}
<Card title={t("model.title")} hint={t("model.hint")}>
  {!connected ? (
    <p className="text-[13px] text-muted">{t("model.connectPrompt")}</p>
  ) : (
    <ModelBrowser
      providers={providers}
      defaultModel={defaultModel}
      busy={busy}
      onSelect={saveModel}
      onManageProviders={() => setProviderManagerOpen(true)}
    />
  )}
</Card>
```

Remove the old wrapping `<Card>` and its connected-state fragment around provider controls. Immediately before the existing bordered provider list whose opening line is:

```tsx
<div className="overflow-hidden rounded-input border border-border">
```

insert:

```tsx
{/* ---- Providers ---- */}
<ProviderManagerCard
  providers={providers}
  expanded={providerManagerOpen}
  disabled={!connected || busy}
  onExpandedChange={setProviderManagerOpen}
>
  {connected && (
    <>
```

Immediately after the existing `isTauri &&` import-login button block, insert:

```tsx
    </>
  )}
</ProviderManagerCard>
```

This leaves every line of the existing provider rows, catalog search/auth panel, OAuth status panel, custom endpoint panel, and import-login button unchanged while moving their visual boundary. Delete the now-unused `Divider` helper at old lines 1331-1338. Do not duplicate or rewrite provider authentication logic.

- [ ] **Step 6: Run integration and all focused feature tests**

```powershell
corepack pnpm --filter @ai4s/desktop exec vitest run src/app/routes/SettingsPage.i18n.test.tsx src/components/settings/ModelBrowser.test.tsx src/components/settings/ProviderManagerCard.test.tsx src/components/settings/modelCatalog.test.ts src/components/settings/modelPreferences.test.ts src/i18n/parity.test.ts
corepack pnpm typecheck
corepack pnpm lint
```

Expected: all focused tests PASS; typecheck and lint exit 0.

- [ ] **Step 7: Commit the Settings integration**

```powershell
git add apps/desktop/src/app/routes/SettingsPage.tsx apps/desktop/src/app/routes/SettingsPage.i18n.test.tsx
git commit -m "feat(settings): integrate model and provider cards"
```

---

### Task 6: Full regression, Windows package, visual QA, and milestone record

**Files:**
- Modify: `PROGRESS.md`

**Interfaces:**
- Consumes: the complete feature from Tasks 1-5.
- Produces: verified tests/build, real Windows UI evidence, and the required project milestone entry.

- [ ] **Step 1: Run the full frontend verification suite**

```powershell
corepack pnpm test
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm build
```

Expected: all desktop tests pass with zero failures; typecheck, lint, and Vite production build exit 0.

- [ ] **Step 2: Ensure ignored runtime bundle inputs exist in the implementation worktree**

If either `apps/desktop/src-tauri/binaries/opencode-x86_64-pc-windows-msvc.exe` or `runtime/skills/external/ai4s-skills/.commit` is absent, run:

```powershell
& 'D:\Program Files\Git\bin\bash.exe' scripts/dev/fetch-opencode.sh
& 'D:\Program Files\Git\bin\bash.exe' scripts/dev/fetch-uv.sh
& 'D:\Program Files\Git\bin\bash.exe' scripts/dev/fetch-skills.sh
```

Expected: the two Windows sidecars and both external skill packs are present in their git-ignored locations.

- [ ] **Step 3: Build the Windows Tauri application in the VS developer environment**

Import the environment from `C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat`, then run:

```powershell
corepack pnpm --filter @ai4s/desktop tauri build
```

Expected: exit 0 and fresh `ai4s-workbench.exe`, MSI, and NSIS installer artifacts under `apps/desktop/src-tauri/target/release`.

- [ ] **Step 4: Perform visual QA in the built Windows app**

Use the `computer-use` skill to inspect the built app without automating credentials or provider logins. Verify these visible facts:

1. The Model card has a left filter rail and right search/list pane; no native default-model select remains.
2. Search by a known model ID narrows the visible list and clearing search restores it.
3. Favorites can be toggled without changing the current-default marker.
4. Recent and provider filters are visible with counts.
5. The Providers card is collapsed on initial render and expands to the unchanged provider controls.
6. Light-theme focus, selected, disabled, empty, and unavailable states remain legible; inspect dark theme only if switching it does not disturb the user's current preference.

Expected: no clipping, overlap, flicker, blank controls, or inaccessible action labels at the current window size.

- [ ] **Step 5: Add the required milestone line to `PROGRESS.md`**

Run `Get-Date -Format 'yyyy-MM-dd HH:mm'`. Prepend one line immediately below `# Progress` using that exact output, followed by this fixed conclusion:

```text
 · feat(settings): replaced the large native model dropdown with a searchable two-column browser (all/favorites/recent/provider filters), local favorite/recent persistence, immediate masked switching, and a separate collapsed provider-management card; full frontend tests, typecheck, lint, Windows Tauri build, and visual QA pass.
```

- [ ] **Step 6: Commit the milestone record**

```powershell
git add PROGRESS.md
git commit -m "docs(progress): record model browser milestone"
```

- [ ] **Step 7: Run final repository verification**

```powershell
git status --short --branch
git log --oneline -7
corepack pnpm test
corepack pnpm typecheck
corepack pnpm lint
```

Expected: clean worktree, the planned feature commits at the branch tip, 0 test failures, and successful typecheck/lint.

## Plan Self-Review Checklist

- Spec coverage: Tasks 1-5 cover search, filters, favorites, recent history, immediate selection, unavailable defaults, provider separation, accessibility, localization, and truthful failure semantics; Task 6 covers packaging and visual acceptance.
- Completeness scan: no unresolved markers, deferred implementation, or unspecified error-handling steps remain.
- Type consistency: canonical model IDs are `string`; `ModelBrowser.onSelect` is `Promise<boolean>` in Tasks 3 and 5; `ProviderManagerCard` is controlled by `expanded` and `onExpandedChange` in Tasks 4 and 5.
- Scope: no backend, SDK, capability metadata, recommendation, or per-session model changes are included.
