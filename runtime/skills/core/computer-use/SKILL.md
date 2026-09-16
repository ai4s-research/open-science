---
name: computer-use
description: Use when a task needs an app on the user's own screen — a native desktop application (instrument control software, Origin, GraphPad, ImageJ, a reference manager, a spreadsheet), or a desktop browser window that needs window-level control. Read before the first `computer` call. Covers the observe-act-observe loop, why element indexes go stale, which action to prefer for which control, what "unverified" means and why it must never be reported as success, and the recovery for each error code. Not for page-level web automation (use the browser connector) and not for anything that can be done from the shell.
---

# Computer use

`computer` reads an app's **accessibility tree** and acts on the numbered
elements in it. The tree is the interface; a screenshot is confirmation. This
design, and most of the rules below, come from
[Orca](https://github.com/stablyai/orca) (MIT).

## Before anything else

Use this only when there is no better route. A file is read with `read`, a
computation is run in the shell, a web page is driven by the browser connector.
Reach for `computer` when the capability lives in a desktop app and nowhere else.

The user sees a permission prompt on the first call of a session. Say what you
intend to do before you make it.

**Never** push, submit a form, send a message, buy, delete, or change an account
setting unless the user asked for that exact thing. If an app holds content the
user did not ask about, read only what the task needs.

## The loop

```
computer(action: "list_apps")
computer(action: "get_state", app: "com.spotify.client")
computer(action: "click", app: "com.spotify.client", elementIndex: 42)
computer(action: "get_state", app: "com.spotify.client")
```

Observe, act once, observe again. Every action already returns the new state, so
the reply to an action is also the next thing you read.

## Element indexes go stale

The numbers in the tree are valid for **that** snapshot of **that** window.
Navigation, scrolling, a focus change, a dialog, an app re-render, or simply a
few seconds passing can invalidate them.

- Re-read the tree after anything that changes the UI.
- Indexes are **sparse** — noisy sections are omitted. Never infer a valid index
  from the element count, and never guess one that is not printed.
- One window at a time: once you pick `windowId` (or `windowIndex`), pass the
  same one to every later call until you mean to change window.

## Picking the app

Prefer the bundle id from `list_apps`; a name is fine when unambiguous;
`pid:<number>` only when neither is. `app` names a **desktop application**, never
a website — Gmail is `com.google.Chrome`, not "Gmail".

When an app has several windows, run `list_windows` first. Use `windowId` when
the listed id is not null, `windowIndex` otherwise.

## Which action

- **Editable field** → `set_value`. It writes the value and can usually read it
  back, which is the only way to prove the text landed.
- **Button, link, checkbox, menu item** → `click`.
- **An action the tree explicitly lists on an element** → `perform_action` with
  that exact name.
- `type_text` only after a field is focused *and* the tree confirms a focused
  text receiver. Synthetic keystrokes go into the void; they are never verified.
- `press_key` for one key (Return, Escape, Tab, arrows). `hotkey` for one
  modifier chord plus one key (`CmdOrCtrl+A`). Prefer `CmdOrCtrl+…` so the same
  call works on every platform.
- Modifier-click is `click` with `modifiers`. Never send separate
  modifier-down/modifier-up calls: an interruption between them leaves a
  modifier logically held down on the user's machine.
- `paste_text` for a long or exact body, into a field you have confirmed has
  focus.

## Verified vs. unverified

Every action reports whether its effect could be **read back**:

| Report | What it means |
|---|---|
| `verified <property>` | The changed value was read back. It happened. |
| `unverified (accessibility action unasserted)` | The call succeeded; nothing checked the result. |
| `unverified (synthetic input)` | Input was fired at the OS. Unverifiable in principle. |
| `unverified (clipboard paste)` | Same, through the clipboard. |
| no verification at all | Treat as unverified. |

**An unverified action is not a completed action.** Read the state back before
telling the user it worked, and if the action could have sent, submitted, bought
or deleted something, say plainly that the effect is unproven.

## Screenshots

Off by default: the tree is what you act on, and an image you did not need is
pure cost. Pass `screenshot: true` when pixels are the answer — confirming
something visually, reading a chart or canvas the tree cannot describe, or
picking coordinates.

The reply carries the image and its path. If it reports a scale other than 1,
convert before using pixel coordinates:

```
x = screenshot_pixel_x / scale
y = screenshot_pixel_y / scale
```

Coordinates are **window-local**, and only valid for the window that screenshot
came from. Prefer an element index whenever one exists.

On Linux and Windows a screenshot may come from the visible desktop region, so
another window can cover the target. Pass `restoreWindow: true` when the pixels
matter; when you cannot take focus, trust the tree over the pixels.

## App notes

**Browsers.** Set the address field directly with `set_value`, then
`press_key: "Return"` — do not assume typed text reached the address bar. Use
`restoreWindow: true` when the browser is not frontmost. A large tab strip is
deliberately compacted to the active tab plus an "inactive browser tabs omitted"
marker; work on the current page unless the user asked about tabs.

**Forms inside a browser page** (a compose window, a web app) expose
accessibility actions without necessarily moving DOM focus. After each field
action, check which element actually has focus; if it did not move, `Tab` from a
known field or fall back to window-local coordinates from a fresh screenshot.

**Instrument and analysis software** often renders its plots as one opaque
element. Read the controls from the tree, and take a screenshot for the plot.

**Shallow trees.** Some apps draw their own interface and expose almost nothing.
Two different things look the same from here:

- The state report says the tree is *being built* — that is an app whose
  accessibility is switched on the moment you read it. Read again in a few
  seconds; the real tree arrives. Do not go to coordinates.
- The tree really is empty, and stays empty on a second read. Then take a
  screenshot, work from coordinates, and say in your answer that you are working
  from pixels, because that path cannot be verified.

## Errors

Each is a named recovery, not a retry.

- `app_not_found` — run `list_apps`, use the bundle id. For a web app, target the
  browser app, not the site name.
- `app_blocked` — stop. That app is deliberately out of reach.
- `window_not_found` / `window_stale` — run `list_windows`, take a current
  selector, read state again.
- `window_not_focused` — retry **once** with `restoreWindow: true`. If it says
  restore was already requested, stop retrying and ask the user to bring the app
  forward. For editable fields prefer `set_value`, which often works unfocused.
  On a coordinate click the message names what was in front instead: another
  app's window over that point, or nothing frontmost at all. Move that window out
  of the way rather than retrying the same click.
- `element_not_found` — the index is stale. Read state again.
- `element_not_clickable` — no actionable frame. Use a parent or child element
  that has one, or coordinates from a fresh screenshot.
- `action_not_supported` — read the element's listed actions and use one of
  those, or fall back to `click` / `set_value`.
- `value_not_settable` — the element refuses direct writes. Focus it and use
  keyboard input, and inspect the result.
- `unsupported_capability` — this platform's provider cannot do it. Use a
  different verb, or tell the user. On Linux this can also mean a missing
  desktop dependency, which the message names.
- `invalid_argument` — fix the arguments. Do not send the same call again.
- `action_timeout` — read the state before retrying, then use a simpler action.
- `screenshot_failed` — the tree may still be enough. If the message names Screen
  Recording, the user grants it in Settings → Computer Use. Note it is granted to
  **Open Science** itself, not to the helper that Accessibility is granted to —
  macOS attributes screen capture to the app that started the request.
- `permission_denied` / `accessibility_error` — on macOS, Accessibility has not
  been granted to **Open Science Computer Use**. Tell the user to open
  Settings → Computer Use and grant it; you cannot grant it for them.

An empty tree with no screenshot usually means the app has no visible window, is
minimized, or the permission is missing.
