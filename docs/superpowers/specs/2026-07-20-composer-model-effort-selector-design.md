# Composer Model and Reasoning Selector

## Purpose

Open Science Desktop currently shows the configured model as read-only status in
the sidebar and exposes default-model changes in Settings. A researcher cannot
quickly choose a different model for one conversation, distinguish that choice
from the global default, or select a supported reasoning level before sending a
message.

Add one compact control to the lower-right corner of the composer, immediately
before the Send button. The control lets the user choose both the model and its
reasoning variant, then apply the combination either to the current conversation
or to the current conversation plus future new conversations.

## Product Decisions

### Placement

The composer footer remains one row:

- Left: Attach, Agent mode, Approval mode.
- Right: Model and reasoning selector, Send.

The selector uses the existing composer visual language and displays the active
combination, for example `GLM-5.2 · Provider default`, `GPT-5.6 Sol · High`, or
`Claude Sonnet 5 · Max`. It opens upward so it does not compete with the Send
button or extend the composer vertically when closed.

The sidebar retains runtime readiness but removes the redundant model status row.
Settings remains the place for connecting providers, editing custom endpoints,
and managing the full model catalog.

### Selection Flow

Opening the selector shows a searchable model list grouped by provider. Recent
models and favorites reuse the existing model-browser preferences. Selecting a
model reveals only the reasoning variants reported for that model. If the runtime
reports no variants, the only choice is `Provider default`; the UI must not invent
generic Low, Medium, or High values.

The footer of the popover provides two explicit actions:

1. `Use for this conversation` applies the selected model and variant only to the
   current draft or open conversation.
2. `Use here and set as default` applies the selection to the current conversation
   and makes it the initial selection for conversations created later.

Neither action changes the model of other existing conversations. The active
model and reasoning variant are always visible on the closed composer control.

### Reasoning Capability

OpenCode represents reasoning levels as model variants. The application reads the
`variants` exposed by the runtime's provider/model catalog and passes the selected
variant with each prompt. Labels are localized for common names while preserving
the provider's exact variant identifier internally.

Custom providers currently configured with empty `variants` remain usable with
`Provider default`. A separate future provider-configuration enhancement may let
users define and validate custom variants, but this feature does not guess
provider-specific request parameters or claim unsupported controls work.

## State Model

Introduce a `ModelSelection` value:

```ts
interface ModelSelection {
  model: string; // provider/model
  variant: string | null; // null means provider default
}
```

The runtime store owns:

- `defaultSelection`: the initial selection for new conversations.
- `sessionSelections`: selections keyed by OpenCode session ID.
- `draftSelection`: the selection for the not-yet-created draft.

Selection precedence when sending is:

1. Current session selection.
2. Current draft selection while creating its first session.
3. Default selection.
4. Runtime/provider default when no application selection exists.

When a draft creates a real OpenCode session, its selection is moved to the new
session ID. Starting a blank draft resets `draftSelection` from
`defaultSelection`. Deleting a session removes its stored selection.

Session selections and the default variant are stored in the app's existing local
preference mechanism so switching sessions or restarting the desktop app preserves
the visible and effective choice. Stale entries are pruned when sessions are
deleted. A saved model or variant that no longer exists is handled as unavailable,
not silently remapped.

## Runtime and Data Flow

### Catalog Loading

The SDK's provider-model type is extended to retain each model's `variants` instead
of reducing models to ID and display name. The composer selector consumes the same
catalog and preference helpers as the Settings model browser; it does not maintain
a separate model registry.

### Sending a Prompt

The prompt request is extended from model-only routing to include the selected
variant:

```json
{
  "model": {
    "providerID": "ephone",
    "modelID": "gpt-5.6-sol"
  },
  "variant": "high"
}
```

`variant` is omitted when the selection uses `Provider default`. Prompt sending,
automatic title generation, follow-up turns, command starters, and goal-resume
nudges must all use the same resolved selection. Provenance and run records capture
both the model and variant so a research result can be reproduced.

### Setting the Default

`Use here and set as default` performs two operations as one user action:

1. Persist the selected model through the existing OpenCode global-config path.
2. Persist the default variant in Open Science preferences and apply the complete
   selection to the current conversation.

The existing runtime reconnect required by a global model change remains masked by
the switching state. A conversation-only change does not alter global config and
does not restart the runtime.

## Error Handling

- Catalog loading failure disables the selector and links to Models settings; it
  does not show a false empty-model state.
- A model with no reported variants offers `Provider default` only.
- A previously selected model or variant that disappears is shown as unavailable.
  Sending is blocked until the user chooses an available combination or explicitly
  returns to the provider default for an available model.
- If setting the global default fails before persistence, neither the current
  selection nor the displayed default changes.
- If the global configuration is written but reconnect fails, the UI reports that
  the default was saved but the runtime could not reconnect, matching the existing
  model-switch recovery contract.
- Provider request failures continue through the existing retry and session-error
  surfaces; the error includes the attempted model and variant for diagnosis.

## Accessibility and Interaction

- The closed selector is a named button with the active model and reasoning level.
- The popover supports keyboard search, arrow navigation, Enter to select, and
  Escape to close without applying changes.
- Focus returns to the selector after closing and to the composer after applying.
- Current conversation and default selections use text labels as well as icons;
  meaning does not depend on color.
- The selector truncates long model names without moving or shrinking the Send
  button. The full provider/model identifier is available as accessible text.
- The control is disabled while a turn is sending or a default-model reconnect is
  in progress, preventing the displayed selection from diverging mid-turn.

## Verification

Automated coverage must prove:

- The selector renders in the composer immediately before Send.
- The model catalog is grouped, searchable, and reuses favorites and recent items.
- Only runtime-reported variants appear; empty variants yield `Provider default`.
- A conversation-only selection affects prompt bodies but not global config.
- A default selection updates global config, the current conversation, and the next
  draft without changing other existing conversations.
- Draft selection transfers to the newly created session.
- Switching conversations and restarting restores each conversation's selection.
- Deleted sessions lose their persisted selection.
- Every model-mediated send path resolves and passes the same model and variant.
- Provenance and run records include the active variant.
- Unavailable models, unavailable variants, catalog failures, write failures, and
  reconnect failures display the specified states.
- Keyboard navigation and accessible names cover the closed control and popover.

Manual packaged-app verification must confirm that the selector opens upward,
stays aligned at narrow window widths, does not displace Send, and that a real
provider request uses the selected variant when the provider reports support.

## Out of Scope

- Guessing reasoning parameters for custom providers with empty variant metadata.
- Automatically routing tasks to different models.
- Changing provider credentials or connection flows.
- Assigning different models to individual tools or subagents.
- Redesigning the rest of the composer or Settings page.
