# Composer Model and Reasoning Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Codex-style model and reasoning selector immediately before Send that supports conversation-only choices and a separate default for future conversations.

**Architecture:** Preserve OpenCode as the model source of truth and extend the SDK to retain model variants and pass an optional variant with each prompt. Keep selection policy in a small pure persistence module plus the existing Zustand runtime store, then render a focused popover component from the composer. Record the effective variant beside the model in provenance and run records.

**Tech Stack:** React 18, TypeScript 5.6, Zustand 5, Radix Popover, Vitest and Testing Library, Tauri 2, Rust, OpenCode 1.17.13, pnpm 9.4.

## Global Constraints

- Put one compact model-and-reasoning button in the composer footer immediately before Send.
- Keep Attach, Agent mode, and Approval mode on the left; keep the selector and Send on the right.
- Show only variants returned by OpenCode for the selected model; an empty variant map yields `Provider default` only.
- Support `Use for this conversation` and `Use here and set as default` as distinct actions.
- A default change must not change other existing conversations.
- Persist conversation selections and the default variant across app restarts.
- Pass the same resolved model and variant through every prompt path and into provenance/run records.
- Do not guess reasoning parameters for custom providers with empty variant metadata.
- Do not add dependencies, change provider credentials, or redesign unrelated composer/Settings UI.
- Keep bundle identifier `com.ai4s.workbench` and pinned OpenCode version `1.17.13` unchanged.
- Use TDD: every behavior change begins with a focused failing test and ends with a fresh passing test.

---

## File Structure

- `packages/sdk/src/types.ts` — provider model metadata, including normalized variant IDs.
- `packages/sdk/src/runtime.ts` — runtime-neutral prompt signature with optional variant.
- `packages/sdk/src/OpenCodeClient.ts` — OpenCode catalog normalization and prompt wire payload.
- `apps/desktop/src/lib/modelSelection.ts` — pure selection types, persistence, availability, and resolution.
- `apps/desktop/src/lib/runtime.ts` — catalog ownership, conversation/default selection actions, draft grafting, and send routing.
- `apps/desktop/src/components/thread/ModelEffortSelector.tsx` — searchable model/variant popover and its two apply actions.
- `apps/desktop/src/components/thread/Composer.tsx` — position the selector before Send.
- `apps/desktop/src/app/routes/LiveSessionPage.tsx` — bind store state/actions to the composer.
- `apps/desktop/src/components/sidebar/StatusPills.tsx` — remove the redundant sidebar model row.
- `packages/shared/src/index.ts`, `apps/desktop/src/lib/{provenance,runs}.ts`, and `apps/desktop/src-tauri/src/{provenance,runs}.rs` — record the selected variant.
- `apps/desktop/src/i18n/locales/*/session.json` — localized selector labels.
- Focused adjacent test files prove each boundary before broad verification.

---

### Task 1: Preserve Model Variants and Send Them to OpenCode

**Files:**
- Modify: `packages/sdk/src/types.ts:235-250`
- Modify: `packages/sdk/src/runtime.ts:40-60`
- Modify: `packages/sdk/src/OpenCodeClient.ts:417-435, 670-705`
- Modify: `packages/sdk/src/mockServer.ts:134-165`
- Test: `apps/desktop/src/test/opencode-client.node.test.ts:330-346`

**Interfaces:**
- Produces: `ProviderModelInfo.variants: string[]`.
- Produces: `AgentRuntime.sendPrompt(sessionId, text, agent?, model?, variant?): Promise<void>`.
- Consumes: OpenCode `/config/providers` model shape `{ name?: string; variants?: Record<string, unknown> }`.

- [ ] **Step 1: Write failing SDK tests for catalog variants and prompt variants**

Add a provider fixture whose model has `{ variants: { low: {}, high: {} } }`, then assert:

```ts
expect((await client.listProviders())[0].models[0]).toMatchObject({
  id: "mock-model",
  name: "Mock Model",
  variants: ["low", "high"],
});

await client.sendPrompt(sessionId, "deep analysis", undefined, "mock/mock-model", "high");
expect(server.promptBodies.at(-1)).toMatchObject({
  model: { providerID: "mock", modelID: "mock-model" },
  variant: "high",
});

await client.sendPrompt(sessionId, "provider default", undefined, "mock/mock-model", null);
expect(server.promptBodies.at(-1)).not.toHaveProperty("variant");
```

- [ ] **Step 2: Run the focused SDK test and verify it fails**

Run:

```bash
pnpm --filter @ai4s/desktop test -- src/test/opencode-client.node.test.ts
```

Expected: FAIL because `ProviderModelInfo` has no `variants` and `sendPrompt` accepts no fifth argument.

- [ ] **Step 3: Extend SDK types and normalize the catalog**

Implement:

```ts
export interface ProviderModelInfo {
  id: string;
  name: string;
  variants: string[];
}
```

Normalize without leaking provider-specific option objects:

```ts
const body = (await res.json()) as {
  providers?: Array<{
    id: string;
    name?: string;
    models?: Record<string, { name?: string; variants?: Record<string, unknown> }>;
  }>;
};

models: Object.entries(p.models ?? {}).map(([id, m]) => ({
  id,
  name: m.name ?? id,
  variants: Object.keys(m.variants ?? {}),
})),
```

- [ ] **Step 4: Extend prompt routing with an optional variant**

Use the same signature in `AgentRuntime` and `OpenCodeClient`:

```ts
sendPrompt(
  sessionId: string,
  text: string,
  agent?: string,
  model?: string | null,
  variant?: string | null,
): Promise<void>;
```

Add only a non-empty variant to the request:

```ts
body: JSON.stringify({
  parts: [{ type: "text", text }],
  ...(agent ? { agent } : {}),
  ...(m ? { model: m } : {}),
  ...(variant ? { variant } : {}),
}),
```

- [ ] **Step 5: Run the SDK test and typecheck**

Run:

```bash
pnpm --filter @ai4s/desktop test -- src/test/opencode-client.node.test.ts
pnpm typecheck
```

Expected: focused tests PASS; typecheck PASS after mock `AgentRuntime` implementations accept the optional parameter.

- [ ] **Step 6: Commit the SDK boundary**

```bash
git add packages/sdk/src/types.ts packages/sdk/src/runtime.ts packages/sdk/src/OpenCodeClient.ts packages/sdk/src/mockServer.ts apps/desktop/src/test/opencode-client.node.test.ts
git commit -m "feat: expose model reasoning variants"
```

---

### Task 2: Add Pure Selection Persistence and Availability Rules

**Files:**
- Create: `apps/desktop/src/lib/modelSelection.ts`
- Create: `apps/desktop/src/lib/modelSelection.test.ts`
- Modify: `apps/desktop/src/components/settings/modelCatalog.ts:1-30`
- Test: `apps/desktop/src/components/settings/modelCatalog.test.ts`

**Interfaces:**
- Consumes: `ProviderInfo[]` with `ProviderModelInfo.variants` from Task 1.
- Produces: `ModelSelection`, `SelectionPreferences`, `loadSelectionPreferences`, `saveSelectionPreferences`, `resolveSelection`, `selectionAvailability`, and variant-bearing `ModelOption`.

- [ ] **Step 1: Write failing pure tests**

Cover persistence recovery, precedence, and strict availability:

```ts
const fallback = { model: "p/base", variant: null };
const session = { model: "p/deep", variant: "high" };

expect(resolveSelection({
  currentId: "ses_1",
  defaultSelection: fallback,
  sessionSelections: { ses_1: session },
  draftSelection: null,
})).toEqual(session);

expect(resolveSelection({
  currentId: null,
  defaultSelection: fallback,
  sessionSelections: {},
  draftSelection: { model: "p/base", variant: "low" },
})).toEqual({ model: "p/base", variant: "low" });

expect(selectionAvailability(
  { model: "p/base", variant: "high" },
  [{ id: "p", name: "P", models: [{ id: "base", name: "Base", variants: [] }] }],
)).toBe("variant-unavailable");
```

Also assert malformed localStorage returns empty preferences and that save/load preserves `defaultSelection`, `sessionSelections`, and `draftSelection`.

- [ ] **Step 2: Run the focused pure tests and verify failure**

Run:

```bash
pnpm --filter @ai4s/desktop test -- src/lib/modelSelection.test.ts src/components/settings/modelCatalog.test.ts
```

Expected: FAIL because the module and variant-bearing `ModelOption` do not exist.

- [ ] **Step 3: Implement the pure module**

Use a versioned localStorage key and defensive parsing:

```ts
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
```

Implement `loadSelectionPreferences()` and `saveSelectionPreferences()` so unavailable or malformed storage never prevents startup.

- [ ] **Step 4: Carry variants into model options**

Extend `ModelOption` and `flattenModelOptions`:

```ts
export interface ModelOption {
  key: string;
  providerID: string;
  providerName: string;
  modelID: string;
  modelName: string;
  variants: string[];
}

variants: model.variants,
```

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
pnpm --filter @ai4s/desktop test -- src/lib/modelSelection.test.ts src/components/settings/modelCatalog.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit the pure selection layer**

```bash
git add apps/desktop/src/lib/modelSelection.ts apps/desktop/src/lib/modelSelection.test.ts apps/desktop/src/components/settings/modelCatalog.ts apps/desktop/src/components/settings/modelCatalog.test.ts
git commit -m "feat: persist conversation model selections"
```

---

### Task 3: Route Conversation and Default Selections Through the Runtime Store

**Files:**
- Modify: `apps/desktop/src/lib/runtime.ts:1-220, 360-437, 523-675, 710-757, 1132-1260, 1350-1369, 1469-1495, 1503-1528`
- Modify: `apps/desktop/src/lib/runtime.store.test.ts`

**Interfaces:**
- Consumes: Task 2 selection helpers.
- Produces store state `providers`, `defaultSelection`, `sessionSelections`, `draftSelection`.
- Produces actions `setCurrentSelection(selection): void` and `setDefaultSelection(selection): Promise<void>`.
- Produces derived helpers `currentModelSelection(state): ModelSelection | null` and `selectionForSession(state, sessionId): ModelSelection | null`.

- [ ] **Step 1: Extend the runtime test mock and write failing behavior tests**

Make `sendPromptSpy` record `(sessionId, text, agent, model, variant)`. Add tests that prove:

```ts
useRuntimeStore.getState().setCurrentSelection({ model: "mock/deep", variant: "high" });
const id = await useRuntimeStore.getState().sendPrompt("analyze");
expect(mocks.sendPromptSpy).toHaveBeenLastCalledWith(
  "ses_new", "analyze", undefined, "mock/deep", "high",
);
expect(useRuntimeStore.getState().sessionSelections[id!]).toEqual({
  model: "mock/deep", variant: "high",
});
expect(useRuntimeStore.getState().draftSelection).toBeNull();
```

Add separate tests for:

- changing only the current conversation never calls `setDefaultModel` or reconnects;
- setting a default updates current + next draft;
- setting a default snapshots the previous default into every other existing session without an override;
- switching sessions restores their selections;
- deleting a session removes and persists its selection;
- a missing model or variant blocks send before `client.sendPrompt`;
- `installSkill` uses the resolved model and variant;
- a global-config PATCH failure leaves current and default selections unchanged;
- a reconnect failure after a successful config write retains the saved default selection and reports `modelSwitchError`.

- [ ] **Step 2: Run the runtime store tests and verify failure**

Run:

```bash
pnpm --filter @ai4s/desktop test -- src/lib/runtime.store.test.ts
```

Expected: FAIL because the store has no selection state/actions and sends only `defaultModel`.

- [ ] **Step 3: Initialize and load selection state**

At module initialization:

```ts
const initialSelectionPreferences = loadSelectionPreferences();
```

Add to `RuntimeState` and initial Zustand state:

```ts
providers: ProviderInfo[];
defaultSelection: ModelSelection | null;
sessionSelections: Record<string, ModelSelection>;
draftSelection: ModelSelection | null;
setCurrentSelection: (selection: ModelSelection) => void;
setDefaultSelection: (selection: ModelSelection) => Promise<void>;
```

During `loadCatalog`, store providers and reconcile the runtime's authoritative default model with the saved variant:

```ts
const saved = get().defaultSelection;
const defaultSelection = defaultModel
  ? { model: defaultModel, variant: saved?.model === defaultModel ? saved.variant : null }
  : null;
set(get().switching ? { agents, commands, providers } : {
  agents, commands, providers, defaultModel, defaultSelection,
});
```

- [ ] **Step 4: Implement conversation-only selection and persistence**

```ts
setCurrentSelection: (selection) => {
  set((s) => s.currentId
    ? { sessionSelections: { ...s.sessionSelections, [s.currentId]: selection } }
    : { draftSelection: selection });
  persistSelections(get());
},
```

`persistSelections` writes only the three selection fields through `saveSelectionPreferences`.

- [ ] **Step 5: Implement default selection without mutating other conversations**

Move the existing global PATCH/reconnect body from `setDefaultModel` into
`setDefaultSelection`. Keep `setDefaultModel` as the Settings-compatible adapter:

```ts
setDefaultModel: (model) => get().setDefaultSelection({ model, variant: null }),
```

Before changing the runtime default, snapshot the old effective default into sessions that have no explicit entry. After `client.setDefaultModel(selection.model)`, persist the new default and current selection:

```ts
const previous = get().defaultSelection;
const preserved = { ...get().sessionSelections };
if (previous) {
  for (const session of get().sessions) {
    if (session.id !== get().currentId && !preserved[session.id]) preserved[session.id] = previous;
  }
}

let reconnectError: unknown;
try {
  await client.setDefaultModel(selection.model);
  set({ defaultModel: selection.model });
  if (!(await get().connectRetry())) {
    throw new Error(get().error ?? "Runtime did not reconnect after setting the default model.");
  }
} catch (error) {
  if (get().defaultModel !== selection.model) throw error;
  // PATCH landed but reconnect failed: persist the truthful saved default.
  reconnectError = error;
}

set((s) => ({
  defaultSelection: selection,
  sessionSelections: s.currentId
    ? { ...preserved, [s.currentId]: selection }
    : preserved,
  draftSelection: s.currentId ? s.draftSelection : selection,
}));
persistSelections(get());
if (reconnectError) throw reconnectError;
```

Re-throw a reconnect error after persisting so the UI can state that the default was saved but reconnection failed.

- [ ] **Step 6: Graft drafts, reset drafts, and prune deleted sessions**

In `performTurn`, move `draftSelection` to the new session alongside threads, panes, and `sessionAgents`. In every new-draft path, copy `defaultSelection` into `draftSelection`. In `deleteSession`, delete `sessionSelections[id]` and persist the result.

The graft must be explicit:

```ts
const sessionSelections = { ...s.sessionSelections };
if (s.draftSelection) sessionSelections[id!] = s.draftSelection;
return {
  currentId: id,
  threads,
  panes,
  sessionAgents,
  sessionSelections,
  draftSelection: null,
};
```

- [ ] **Step 7: Resolve and validate before every model-mediated send**

In `sendPrompt`, capture the selection before `performTurn`, validate it against `providers`, and pass both fields:

```ts
const selection = currentModelSelection(s);
if (selectionAvailability(selection, s.providers) !== "available") {
  set({ error: "Choose an available model and reasoning level before sending." });
  return Promise.resolve(null);
}

return performTurn(
  set,
  get,
  text,
  (sid) => withRetry(() => client!.sendPrompt(
    sid, text, agent, selection!.model, selection!.variant,
  )),
  false,
);
```

Apply the same resolved selection to `installSkill`. Shell and slash commands remain unchanged because they do not use the ordinary prompt endpoint.

Export the session-specific resolver used by event metadata:

```ts
export function selectionForSession(
  state: Pick<RuntimeState, "defaultSelection" | "sessionSelections">,
  sessionId: string,
): ModelSelection | null {
  return state.sessionSelections[sessionId] ?? state.defaultSelection;
}
```

- [ ] **Step 8: Run runtime tests and typecheck**

Run:

```bash
pnpm --filter @ai4s/desktop test -- src/lib/runtime.store.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit session routing**

```bash
git add apps/desktop/src/lib/runtime.ts apps/desktop/src/lib/runtime.store.test.ts
git commit -m "feat: route models per conversation"
```

---

### Task 4: Record the Effective Reasoning Variant in Research Metadata

**Files:**
- Modify: `packages/shared/src/index.ts:319-417`
- Modify: `apps/desktop/src/lib/provenance.ts:83-107`
- Modify: `apps/desktop/src/lib/provenance.test.ts`
- Modify: `apps/desktop/src/lib/runs.ts:222-245`
- Modify: `apps/desktop/src/lib/runs.test.ts`
- Modify: `apps/desktop/src/lib/runtime.ts:989-1007`
- Modify: `apps/desktop/src-tauri/src/provenance.rs:22-50, 477-518, 604-624, 650-770`
- Modify: `apps/desktop/src-tauri/src/runs.rs:35-60, 299-350, 375-405, 500-610`

**Interfaces:**
- Consumes: effective `ModelSelection` from Task 3.
- Produces: optional `variant` on `ProvenanceRecord` and `RunRecord` in TypeScript, Rust, JSONL, and Tauri invoke arguments.

- [ ] **Step 1: Write failing TypeScript and Rust tests**

TypeScript bridge assertions:

```ts
await recordProvenance(input, "ses_1", { model: "mock/deep", variant: "high" });
expect(invoke).toHaveBeenCalledWith("record_provenance", expect.objectContaining({
  model: "mock/deep",
  variant: "high",
}));

await recordRun(run, "ses_1", { model: "mock/deep", variant: "high" });
expect(invoke).toHaveBeenCalledWith("record_run", expect.objectContaining({
  model: "mock/deep",
  variant: "high",
}));
```

Rust serialization assertion:

```rust
assert_eq!(serde_json::to_value(&record).unwrap()["variant"], "high");
```

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
pnpm --filter @ai4s/desktop test -- src/lib/provenance.test.ts src/lib/runs.test.ts
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml provenance runs
```

Expected: FAIL because no variant field or command argument exists.

- [ ] **Step 3: Extend shared and frontend bridge records**

Add to both shared records:

```ts
/** OpenCode reasoning variant used for this result, e.g. "high". */
variant?: string;
```

Change frontend bridge functions to accept `ModelSelection | null` and invoke:

```ts
model: selection?.model ?? null,
variant: selection?.variant ?? null,
```

In the event handler, resolve by `sid` rather than using the global default:

```ts
const selection = selectionForSession(get(), sid);
void recordProvenance(input, sid, selection);
void recordRun(run, sid, selection);
```

- [ ] **Step 4: Extend Rust records and append paths compatibly**

Add to both Rust record structs:

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub variant: Option<String>,
```

Thread `variant: Option<String>` through `record_provenance`, `append_record`, `record_run`, and `record_run_inner`. Old JSONL lines remain readable because serde defaults missing optional fields.

- [ ] **Step 5: Update all Rust call sites and test fixtures**

Every existing `append_record` and `record_run_inner` test call receives an additional `None` after `model`; the new test passes `Some("high".into())` and asserts serialized output.

- [ ] **Step 6: Run frontend and Rust tests**

Run:

```bash
pnpm --filter @ai4s/desktop test -- src/lib/provenance.test.ts src/lib/runs.test.ts
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit reproducibility metadata**

```bash
git add packages/shared/src/index.ts apps/desktop/src/lib/provenance.ts apps/desktop/src/lib/provenance.test.ts apps/desktop/src/lib/runs.ts apps/desktop/src/lib/runs.test.ts apps/desktop/src/lib/runtime.ts apps/desktop/src-tauri/src/provenance.rs apps/desktop/src-tauri/src/runs.rs
git commit -m "feat: record reasoning variants in run metadata"
```

---

### Task 5: Build the Searchable Model and Reasoning Popover

**Files:**
- Create: `apps/desktop/src/components/thread/ModelEffortSelector.tsx`
- Create: `apps/desktop/src/components/thread/ModelEffortSelector.test.tsx`
- Modify: `apps/desktop/src/i18n/locales/en/session.json`

**Interfaces:**
- Consumes: `providers: ProviderInfo[]`, `selection: ModelSelection | null`, `defaultSelection: ModelSelection | null`, `busy: boolean`.
- Produces callbacks `onUseConversation(selection)`, `onUseAndDefault(selection): Promise<void>`, and `onManageModels()`.

- [ ] **Step 1: Write failing interaction tests**

Render providers with one model having `variants: ["low", "high"]` and another having `variants: []`. Prove:

```ts
expect(screen.getByRole("button", { name: /Model and reasoning/ })).toHaveTextContent("Deep · High");
await user.click(screen.getByRole("button", { name: /Model and reasoning/ }));
expect(screen.getByRole("dialog", { name: /Choose model and reasoning/ })).toBeVisible();
expect(screen.getByRole("radio", { name: "Low" })).toBeVisible();
expect(screen.getByRole("radio", { name: "High" })).toBeVisible();
```

Then select the empty-variant model and assert only `Provider default` remains. Test provider grouping, search, current/default text badges, Escape dismissal, busy disabled state, long-name truncation class, and both apply callbacks. With an empty provider catalog, assert `Model catalog unavailable` and a `Manage models` button that calls `onManageModels`.

- [ ] **Step 2: Run the component test and verify failure**

Run:

```bash
pnpm --filter @ai4s/desktop test -- src/components/thread/ModelEffortSelector.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the Radix popover shell**

First add this English object under `composer.model` in
`apps/desktop/src/i18n/locales/en/session.json`, so component tests assert real
copy rather than untranslated keys:

```json
{
  "aria": "Model and reasoning: {{model}}, {{effort}}",
  "dialogAria": "Choose model and reasoning",
  "search": "Search models",
  "providerDefault": "Provider default",
  "manageModels": "Manage models",
  "useConversation": "Use for this conversation",
  "useAndDefault": "Use here and set as default",
  "currentConversation": "Current conversation",
  "defaultBadge": "Default",
  "unavailable": "Unavailable",
  "catalogUnavailable": "Model catalog unavailable",
  "effort": {
    "none": "None",
    "minimal": "Minimal",
    "low": "Low",
    "medium": "Medium",
    "high": "High",
    "xhigh": "Extra high",
    "max": "Max"
  }
}
```

Use `@radix-ui/react-popover`; anchor content above/right of the trigger:

```tsx
<Popover.Root open={open} onOpenChange={setOpen}>
  <Popover.Trigger asChild>
    <button
      aria-label={t("composer.model.aria", { model: modelLabel, effort: variantLabel })}
      disabled={busy || !selection}
      className="flex h-7 max-w-[240px] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs text-muted hover:bg-surface-2 hover:text-text disabled:opacity-40"
    >
      <Brain size={12} />
      <span className="truncate">{modelLabel} · {variantLabel}</span>
      <ChevronDown size={11} />
    </button>
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content side="top" align="end" sideOffset={8}
      role="dialog" aria-label={t("composer.model.dialogAria")}
      className="z-30 w-96 rounded-card border border-border bg-surface p-2 shadow-card">
      {/* search, grouped models, variants, actions; empty catalog calls onManageModels */}
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
```

- [ ] **Step 4: Implement model search, grouping, variants, and actions**

Use `flattenModelOptions`, `filterModelOptions`, and existing favorite/recent helpers. Keep a staged `ModelSelection` inside the open popover. Variant choices are exactly:

```ts
const variants = selectedModel?.variants ?? [];
const effortChoices = variants.length > 0 ? variants : [null];
```

Map only display labels (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) through i18n; pass exact IDs to callbacks. Applying either action records the model in Recent, closes the popover, and restores focus.

- [ ] **Step 5: Run component tests and accessibility assertions**

Run:

```bash
pnpm --filter @ai4s/desktop test -- src/components/thread/ModelEffortSelector.test.tsx
```

Expected: PASS with no `act(...)` warnings.

- [ ] **Step 6: Commit the isolated UI component**

```bash
git add apps/desktop/src/components/thread/ModelEffortSelector.tsx apps/desktop/src/components/thread/ModelEffortSelector.test.tsx apps/desktop/src/i18n/locales/en/session.json
git commit -m "feat: add model reasoning popover"
```

---

### Task 6: Integrate the Selector into the Composer and Remove Sidebar Duplication

**Files:**
- Modify: `apps/desktop/src/components/thread/Composer.tsx:90-150, 588-755`
- Modify: `apps/desktop/src/components/thread/Composer.test.tsx:285-352`
- Modify: `apps/desktop/src/app/routes/LiveSessionPage.tsx:39-74, 456-477`
- Modify: `apps/desktop/src/components/sidebar/StatusPills.tsx:1-55`
- Create: `apps/desktop/src/components/sidebar/StatusPills.test.tsx`

**Interfaces:**
- Consumes: Task 3 store state/actions and Task 5 `ModelEffortSelector`.
- Produces: composer props for providers/current/default selection and both apply callbacks.

- [ ] **Step 1: Write failing composer placement and sidebar tests**

Composer test:

```ts
render(<Composer
  onSend={vi.fn()}
  providers={providers}
  modelSelection={{ model: "mock/deep", variant: "high" }}
  defaultModelSelection={{ model: "mock/base", variant: null }}
  onModelSelectionChange={vi.fn()}
  onModelSelectionDefault={vi.fn(async () => {})}
/>);

const selector = screen.getByRole("button", { name: /Model and reasoning/ });
const send = screen.getByRole("button", { name: "Send" });
expect(selector.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
```

Sidebar test asserts Runtime remains and Model is absent.

- [ ] **Step 2: Run focused integration tests and verify failure**

Run:

```bash
pnpm --filter @ai4s/desktop test -- src/components/thread/Composer.test.tsx src/components/sidebar/StatusPills.test.tsx
```

Expected: FAIL because the composer props and selector placement do not exist and sidebar still renders Model.

- [ ] **Step 3: Add optional selector props to Composer**

Add:

```ts
providers?: ProviderInfo[];
modelSelection?: ModelSelection | null;
defaultModelSelection?: ModelSelection | null;
onModelSelectionChange?: (selection: ModelSelection) => void;
onModelSelectionDefault?: (selection: ModelSelection) => Promise<void>;
onManageModels?: () => void;
```

Render `ModelEffortSelector` after `<span className="flex-1" />` and immediately before the working/Send branch. Static mock composers omit the all-or-nothing prop set and render no selector.

- [ ] **Step 4: Bind LiveSessionPage to the runtime store**

Select individual fields to preserve the page's no-repaint-storm rule:

```ts
const providers = useRuntimeStore((s) => s.providers);
const defaultSelection = useRuntimeStore((s) => s.defaultSelection);
const sessionSelections = useRuntimeStore((s) => s.sessionSelections);
const draftSelection = useRuntimeStore((s) => s.draftSelection);
const setCurrentSelection = useRuntimeStore((s) => s.setCurrentSelection);
const setDefaultSelection = useRuntimeStore((s) => s.setDefaultSelection);
const modelSelection = currentModelSelection({
  currentId,
  defaultSelection,
  sessionSelections,
  draftSelection,
});
```

Pass `busy={sending || switching || running}` through Composer to the selector. Convert default-setting errors into the existing toast style, distinguishing `modelSwitchError` where the config persisted but reconnect failed.

Pass `onManageModels={() => navigate("/settings/models")}` so a catalog failure has a concrete recovery path.

- [ ] **Step 5: Simplify StatusPills to Runtime only**

Remove `ModelStatus`, `MODEL_TONE`, and the second `Pill`. Keep the existing Runtime label/value unchanged.

- [ ] **Step 6: Run focused integration tests**

Run:

```bash
pnpm --filter @ai4s/desktop test -- src/components/thread/Composer.test.tsx src/components/thread/ModelEffortSelector.test.tsx src/components/sidebar/StatusPills.test.tsx src/app/routes/SessionPage.test.tsx
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit composer integration**

```bash
git add apps/desktop/src/components/thread/Composer.tsx apps/desktop/src/components/thread/Composer.test.tsx apps/desktop/src/app/routes/LiveSessionPage.tsx apps/desktop/src/components/sidebar/StatusPills.tsx apps/desktop/src/components/sidebar/StatusPills.test.tsx
git commit -m "feat: place model selector beside send"
```

---

### Task 7: Localize, Verify, Package, and Prepare the Upstream Change

**Files:**
- Modify: `apps/desktop/src/i18n/locales/zh-Hans/session.json`
- Modify: `apps/desktop/src/i18n/locales/es/session.json`
- Modify: `apps/desktop/src/i18n/locales/fr/session.json`
- Modify: `apps/desktop/src/i18n/locales/de/session.json`
- Modify: `apps/desktop/src/i18n/locales/ja/session.json`
- Modify: `apps/desktop/src/i18n/locales/ko/session.json`
- Test: `apps/desktop/src/i18n/parity.test.ts`
- Modify: `PROGRESS.md`

**Interfaces:**
- Consumes: all earlier tasks.
- Produces: complete seven-locale copy, green repository checks, an Apple Silicon `.app/.dmg`, and a PR-ready commit series.

- [ ] **Step 1: Add exact i18n keys to every locale**

Add the same key structure under `composer.model`:

```json
{
  "aria": "Model and reasoning: {{model}}, {{effort}}",
  "dialogAria": "Choose model and reasoning",
  "search": "Search models",
  "providerDefault": "Provider default",
  "manageModels": "Manage models",
  "useConversation": "Use for this conversation",
  "useAndDefault": "Use here and set as default",
  "currentConversation": "Current conversation",
  "defaultBadge": "Default",
  "unavailable": "Unavailable",
  "catalogUnavailable": "Model catalog unavailable",
  "effort": {
    "none": "None",
    "minimal": "Minimal",
    "low": "Low",
    "medium": "Medium",
    "high": "High",
    "xhigh": "Extra high",
    "max": "Max"
  }
}
```

Use these exact values for the other locale files; preserve exact variant IDs internally.

`zh-Hans/session.json`:

```json
{
  "aria": "模型和思考程度：{{model}}，{{effort}}",
  "dialogAria": "选择模型和思考程度",
  "search": "搜索模型",
  "providerDefault": "Provider 默认",
  "manageModels": "管理模型",
  "useConversation": "仅用于当前会话",
  "useAndDefault": "用于当前会话并设为默认",
  "currentConversation": "当前会话",
  "defaultBadge": "默认",
  "unavailable": "不可用",
  "catalogUnavailable": "模型目录不可用",
  "effort": { "none": "无", "minimal": "最少", "low": "低", "medium": "中", "high": "高", "xhigh": "超高", "max": "最大" }
}
```

`es/session.json`:

```json
{
  "aria": "Modelo y razonamiento: {{model}}, {{effort}}",
  "dialogAria": "Elegir modelo y nivel de razonamiento",
  "search": "Buscar modelos",
  "providerDefault": "Valor del proveedor",
  "manageModels": "Gestionar modelos",
  "useConversation": "Usar en esta conversación",
  "useAndDefault": "Usar aquí y establecer como predeterminado",
  "currentConversation": "Conversación actual",
  "defaultBadge": "Predeterminado",
  "unavailable": "No disponible",
  "catalogUnavailable": "Catálogo de modelos no disponible",
  "effort": { "none": "Ninguno", "minimal": "Mínimo", "low": "Bajo", "medium": "Medio", "high": "Alto", "xhigh": "Extra alto", "max": "Máximo" }
}
```

`fr/session.json`:

```json
{
  "aria": "Modèle et raisonnement : {{model}}, {{effort}}",
  "dialogAria": "Choisir le modèle et le niveau de raisonnement",
  "search": "Rechercher des modèles",
  "providerDefault": "Valeur du fournisseur",
  "manageModels": "Gérer les modèles",
  "useConversation": "Utiliser pour cette conversation",
  "useAndDefault": "Utiliser ici et définir par défaut",
  "currentConversation": "Conversation actuelle",
  "defaultBadge": "Par défaut",
  "unavailable": "Indisponible",
  "catalogUnavailable": "Catalogue de modèles indisponible",
  "effort": { "none": "Aucun", "minimal": "Minimal", "low": "Faible", "medium": "Moyen", "high": "Élevé", "xhigh": "Très élevé", "max": "Maximum" }
}
```

`de/session.json`:

```json
{
  "aria": "Modell und Denkaufwand: {{model}}, {{effort}}",
  "dialogAria": "Modell und Denkaufwand auswählen",
  "search": "Modelle durchsuchen",
  "providerDefault": "Anbieterstandard",
  "manageModels": "Modelle verwalten",
  "useConversation": "Für diese Unterhaltung verwenden",
  "useAndDefault": "Hier verwenden und als Standard festlegen",
  "currentConversation": "Aktuelle Unterhaltung",
  "defaultBadge": "Standard",
  "unavailable": "Nicht verfügbar",
  "catalogUnavailable": "Modellkatalog nicht verfügbar",
  "effort": { "none": "Kein", "minimal": "Minimal", "low": "Niedrig", "medium": "Mittel", "high": "Hoch", "xhigh": "Extra hoch", "max": "Maximum" }
}
```

`ja/session.json`:

```json
{
  "aria": "モデルと推論レベル：{{model}}、{{effort}}",
  "dialogAria": "モデルと推論レベルを選択",
  "search": "モデルを検索",
  "providerDefault": "プロバイダーのデフォルト",
  "manageModels": "モデルを管理",
  "useConversation": "この会話で使用",
  "useAndDefault": "ここで使用してデフォルトに設定",
  "currentConversation": "現在の会話",
  "defaultBadge": "デフォルト",
  "unavailable": "利用不可",
  "catalogUnavailable": "モデルカタログを利用できません",
  "effort": { "none": "なし", "minimal": "最小", "low": "低", "medium": "中", "high": "高", "xhigh": "非常に高", "max": "最大" }
}
```

`ko/session.json`:

```json
{
  "aria": "모델 및 추론 수준: {{model}}, {{effort}}",
  "dialogAria": "모델 및 추론 수준 선택",
  "search": "모델 검색",
  "providerDefault": "공급자 기본값",
  "manageModels": "모델 관리",
  "useConversation": "이 대화에 사용",
  "useAndDefault": "여기에 사용하고 기본값으로 설정",
  "currentConversation": "현재 대화",
  "defaultBadge": "기본값",
  "unavailable": "사용할 수 없음",
  "catalogUnavailable": "모델 카탈로그를 사용할 수 없음",
  "effort": { "none": "없음", "minimal": "최소", "low": "낮음", "medium": "중간", "high": "높음", "xhigh": "매우 높음", "max": "최대" }
}
```

- [ ] **Step 2: Run parity and all frontend tests**

Run:

```bash
pnpm test
```

Expected: every Vitest suite PASS and locale parity reports no missing or extra keys.

- [ ] **Step 3: Run static and Rust verification**

Run:

```bash
pnpm typecheck
pnpm lint
pnpm build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Expected: all commands exit 0.

- [ ] **Step 4: Append the verified milestone**

First run `date '+%Y-%m-%d %H:%M'`. Add one newest-first line to `PROGRESS.md`
using the returned timestamp only after the commands above pass:

```md
<timestamp from the immediately preceding date command> · feat(desktop): added a composer model/reasoning selector with per-conversation and future-default persistence; SDK, runtime, provenance, frontend, i18n, and Rust tests green.
```

Do not claim packaged-app verification until Step 6 passes.

- [ ] **Step 5: Commit localization and verified milestone**

```bash
git add apps/desktop/src/i18n/locales/*/session.json apps/desktop/src/i18n/parity.test.ts PROGRESS.md
git commit -m "docs: record model selector milestone"
```

- [ ] **Step 6: Build the Apple Silicon desktop bundle**

Fetch pinned, repository-declared assets and build:

```bash
pnpm install --frozen-lockfile
bash scripts/dev/fetch-opencode.sh aarch64-apple-darwin
bash scripts/dev/fetch-skills.sh
pnpm --filter @ai4s/desktop tauri build --target aarch64-apple-darwin
```

Expected: Tauri exits 0 and creates an `.app` and `.dmg` below `apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/`.

- [ ] **Step 7: Verify the packaged app without replacing the installed app**

Launch the built `.app` from its bundle directory and verify:

1. The button appears at the lower right immediately before Send.
2. The popover opens upward at 1440×900 and the minimum 1000×640 window size.
3. Send never moves or shrinks with a long model name.
4. Paratera/EPhone models with empty runtime variants show only `Provider default`.
5. A provider/model that reports variants shows only those variants.
6. Conversation-only selection survives switching sessions and relaunching.
7. Default selection initializes a new conversation and leaves existing conversations unchanged.
8. A real prompt records both model and variant in `.openscience/provenance.jsonl` or `.openscience/runs.jsonl` when that turn creates an artifact/run.

Do not replace `/Applications/Open Science.app` until the user reviews this packaged build.

- [ ] **Step 8: Prepare upstream handoff information**

Run:

```bash
git log --oneline origin/master..HEAD
git diff --stat origin/master...HEAD
git status --short
```

Expected: a focused commit series, a clean worktree, and no credential/config files in the diff. Draft a PR summary covering composer UX, per-conversation/default semantics, truthful variant capability, provenance, and verification. Do not push or open a PR without explicit user authorization.

---

## Final Verification Gate

Before claiming completion, rerun from a clean shell:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
git diff --check origin/master...HEAD
git status --short
```

All commands must exit 0. Report packaged-app manual verification separately from automated checks, and state explicitly whether the built app has or has not replaced `/Applications/Open Science.app`.
