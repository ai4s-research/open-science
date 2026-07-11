# Model Selection Browser Design

**Date:** 2026-07-12

**Status:** Approved for implementation planning

## Context

The Settings page currently renders every available model in one native `<select>` grouped by provider. A typical connected setup can expose more than 90 models. The control has no search, favorites, recent history, or provider filter, and it shares one card with provider authentication and endpoint management. The result is slow model discovery and an unclear separation between choosing a model and configuring where models come from.

The current runtime behavior is otherwise sound: selecting a default model persists it through OpenCode, masks the required sidecar reconnect with the runtime `switching` state, and keeps the rest of the app from flashing offline.

## Goals

- Make a large model catalog fast to browse and search.
- Separate model selection from provider configuration.
- Preserve the existing immediate-selection and transparent-reconnect behavior.
- Add local favorites and recent models without changing provider or runtime APIs.
- Keep the design usable by mouse and keyboard in every shipped locale.

## Non-goals

- Per-session or per-message model overrides.
- Model capability tags such as reasoning, coding, or vision. The current provider API exposes only model ID and name, so inferred capability metadata would be unreliable.
- Ranking, benchmarking, pricing, or recommending models.
- Backend, OpenCode protocol, or provider catalog changes.
- Changing how provider credentials, OAuth, custom endpoints, or imported OpenCode logins are stored.

## Chosen UX

### Model card

The existing Models and Providers card becomes a model-focused card titled `Model`. It contains a persistent two-column browser:

- The left rail contains `All models`, `Favorites`, `Recent`, and one entry for each connected provider.
- `All models`, `Favorites`, and provider entries show their currently available model count.
- The right pane contains a search field followed by a scrollable model list.
- Search is case-insensitive and matches the model display name, model ID, and provider display name.
- Search applies inside the active left-rail filter. `All models` is the initial filter.
- Each model row shows the model display name, provider name, model ID when it adds information, a favorite button, and a `Current default` state when applicable.
- Clicking the model row immediately applies that model as the default.
- Clicking the favorite button changes only the favorite state and never selects the model.
- Before invoking the runtime store, the browser records the clicked model as the pending model. While the runtime is switching, model rows are disabled and that pending row shows a switching indicator. Repeated selections are blocked until the operation finishes, then the pending value is cleared.
- The existing disconnected-runtime message remains when the provider list is unavailable.

### Provider card

Provider configuration moves into a separate card directly below the model card.

- The collapsed card shows the number and names of connected providers and a `Manage` action.
- Expanding the card reveals the existing provider list, credential removal actions, provider catalog search, OAuth/API-key flows, custom endpoint form, and OpenCode CLI login import.
- Connecting or removing a provider refreshes the model browser automatically.
- Provider changes do not silently replace the current default model.
- If the active provider disappears, the runtime remains the source of truth for the default-model value; the model browser shows that the configured model is unavailable until the user selects an available model.

## Component Boundaries

The large Settings page should not absorb the new browser implementation. The feature is divided into focused units:

- `ModelBrowser` owns search text, active filter, the pending model ID, derived visible rows, selection controls, and the two-column presentation.
- `ModelFilterRail` renders the special filters and connected-provider filters with counts.
- `ModelList` renders available model rows and the empty states for search, favorites, and recent history.
- `ModelRow` separates the row selection target from the favorite button and exposes accessible names and states.
- `ProviderManagerCard` wraps the existing provider-management UI behind a collapsed summary without changing its underlying connection flows.
- A small model-preferences module owns serialization, validation, favorite toggling, and recent-history updates. It has no dependency on the runtime client.
- Pure filtering and normalization helpers accept provider/model data and preference state, making search and count behavior deterministic and easy to test.

`SettingsPage` remains responsible for loading provider data, invoking the runtime store, refreshing after provider changes, owning the expanded/collapsed Provider-card state, and composing the two cards. The no-model empty state receives an explicit callback that expands the Provider card.

## Local Preference Data

Favorites and recent models are local UI preferences, stored in `window.localStorage` using versioned keys under the existing `ai4s.*` namespace.

Each model is identified by the canonical string `providerID/modelID`.

- Favorites are stored as a deduplicated array of canonical model IDs.
- Recent models are stored newest-first, deduplicated, and capped at 8 entries.
- A model is added to recent history only after `setDefaultModel()` succeeds.
- A failed model switch does not change recent history.
- Favorites and recent entries are not deleted when a provider disconnects. Unavailable entries are hidden from the model list and become visible again if the provider reconnects.
- Invalid localStorage JSON or non-string entries are ignored and replaced with an empty valid state on the next preference update.
- Preferences never enter OpenCode configuration, provenance, logs, exports, or provider requests.

## Selection Data Flow

1. The user clicks an available model row.
2. `SettingsPage` invokes the existing runtime store `setDefaultModel(providerID/modelID)` operation.
3. The runtime store sets `switching`, persists the OpenCode default model, updates `defaultModel`, and reconnects the event stream.
4. On success, the UI records the canonical model ID in recent history and shows the existing success toast.
5. If OpenCode rejects the configuration write, the previous default and recent history remain unchanged.
6. If OpenCode accepts the new default but the subsequent event-stream reconnect fails, the runtime store's `defaultModel` remains authoritative. The UI displays that value, does not record the selection in recent history until the complete operation succeeds, and shows the reconnect error instead of claiming that the model was rolled back.
7. In every failure path, controls become available again after `switching` clears and the pending model ID is removed.

No optimistic default-model mutation is introduced outside the runtime store.

## Search and Filtering Rules

- Text is normalized with `trim().toLocaleLowerCase()` before matching.
- The searchable text for a row contains the model name, model ID, provider name, and provider ID.
- An empty query returns every available model in the active filter.
- Provider filters include only models from that provider.
- Favorites and Recent include only currently available models while retaining unavailable preference entries in storage.
- Recent order is preserved when searching; other filters preserve provider order and the model order returned by the runtime.
- A zero-result state explains whether no model matches the search or the selected Favorites/Recent filter is empty.

## Accessibility and Keyboard Behavior

- The filter rail is a labeled navigation/list control with a visible active state.
- Every model row has a distinct keyboard-focusable selection button.
- Every favorite control is a separate button with localized `Add to favorites` or `Remove from favorites` text.
- The current default model exposes an accessible selected/current state and does not rely on color alone.
- Search has a persistent label or accessible name, not placeholder-only identification.
- Focus indicators use the existing design tokens and remain visible in light and dark themes.
- All new user-facing strings are added to every shipped locale and covered by locale parity tests.

## Error and Empty States

- Runtime disconnected: retain the existing prompt to connect before configuring models.
- Provider refresh failure: retain the last successfully loaded provider list when available; otherwise show a localized unavailable message.
- Model configuration failure: keep the previous default and recent history unchanged, show the error toast, and re-enable controls.
- Reconnect failure after a successful configuration write: show the runtime store's authoritative default, keep recent history unchanged, surface the reconnect error, and re-enable controls without claiming rollback.
- No connected models: show a direct action that expands the Provider card.
- Empty Favorites or Recent: explain how the list becomes populated.
- Search with no results: show the query and offer to clear it without changing the active filter.
- Configured model unavailable: display its canonical ID as unavailable and require an explicit user selection to replace it.

## Testing Strategy

### Pure helper tests

- Search matches model name, model ID, provider name, and provider ID without case sensitivity.
- Provider, Favorites, Recent, and All filters return the expected rows and counts.
- Recent ordering is stable, deduplicated, and limited to 8 entries.
- Invalid stored preference data is handled safely.
- Unavailable favorite and recent IDs remain in storage but are absent from visible rows.

### Component tests

- The left rail renders special filters and all connected providers with counts.
- Search narrows the active filter and clear-search restores it.
- Clicking a model invokes `setDefaultModel()` once and blocks repeated selection while switching.
- A successful switch updates recent history and the current-default marker.
- A rejected configuration write preserves the previous default and recent history and exposes the error state.
- A reconnect failure after a successful write keeps the UI aligned with the runtime store, does not update recent history, and exposes the reconnect error.
- Clicking the favorite button does not select the row.
- Keyboard focus and activation work for filters, model rows, and favorite buttons.
- Provider management is collapsed by default, expands on demand, and retains the existing connect/remove/custom/import flows.
- Connecting a provider refreshes available models without changing the current default.

### Regression tests

- Existing runtime tests continue to prove that model switching performs exactly one masked reconnect and does not flash the app offline.
- Existing Settings localization tests continue to pass.
- Locale parity tests cover every new string across all shipped languages.
- Type checking, lint, and the complete desktop test suite remain green.

## Acceptance Criteria

- A user with more than 90 available models can find a known model by name, ID, or provider without opening a native select menu.
- A user can browse all models, favorites, recent models, or one provider from the left rail.
- A single model-row click changes the default through the existing transparent reconnect flow.
- Favorites persist across app restarts and provider disconnect/reconnect cycles.
- Recent history contains only successful selections, is deduplicated, and never exceeds 8 entries.
- Provider configuration is visually and behaviorally separate from model selection.
- A rejected configuration write never changes the current default or recent history.
- A reconnect failure after a successful write never corrupts local preferences or presents a default that disagrees with the runtime store.
- The feature is fully keyboard accessible and localized in every shipped interface language.
- No backend or provider API changes are required.
