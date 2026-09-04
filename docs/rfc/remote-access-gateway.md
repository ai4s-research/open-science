# RFC: Remote Access Gateway — one authenticated API for CLI, LAN web, and beyond

Status: **Phases 1-3 shipped. Phase 4 open.** Phase 3 landed larger than
described here: a thin client alone would have been a remote control for a
running desktop, because the gateway lives inside the Tauri app and a Tauri app
cannot start without a display. So the server core was extracted into its own
crate (`crates/osd-core`, no Tauri) and `osd server` runs the whole workbench —
including the real web client — where there is no screen at all. See the
Phase 3 note below.
Target: v0.4.0 "Reach & interop" (see `docs/PRD.md` §9). Builds on the
`AgentRuntime` seam (#24) and `BaseAgentRuntime` (#36).

## TL;DR

Everything in the "reach the workbench from outside the desktop window" bucket —
**CLI, LAN web UI (#3), cloud tunnel, Feishu/Slack bots (#20), and exposing Open
Science *as* an ACP server (#14)** — is **one deliverable, not five features**.
They are all *clients* of a single **authenticated API gateway** that re-exposes
the runtime-agnostic `AgentRuntime` seam over the network. The distance
(in-process → loopback → LAN → public URL) is a **binding + auth** question, not
a per-feature one.

The same seam consumed in the *other* direction — a `RemoteRuntime` that speaks
the gateway's wire protocol — is the "remote agent runtime" half of #35. **The
gateway and the remote runtime are the two ends of one pipe**; build the server
well and the remote client falls out nearly free.

This RFC defines the wire API, the permission model, the cross-client sync
semantics, the security boundary, and a phased plan.

## Motivation

### The user needs (who actually uses this, and to do what)

| Scenario | Who | Wants | Implies |
| --- | --- | --- | --- |
| **Check progress from the couch** (LAN web) | the same user, desktop still on | read a running task, approve a prompt, add a follow-up | list/open sessions, live stream, answer approvals, send a prompt |
| **CLI / CI / scripting** | headless, nobody watching | fire a task → wait → grab artifacts | create session, send prompt, stream/poll to idle, read files, **non-interactive permission policy** |
| **Chat bot** (Feishu / Slack) | drop a task in a group | submit → get notified → read the result | create session, send prompt, **completion notification**, read **artifacts** (not the token stream) |
| **Remote agent runtime** (#35) | the desktop, driving a runtime elsewhere | run the agent on another machine | the full contract, over the network = `RemoteRuntime` |
| **External editor / agent** (ACP, #14) | Zed / a CLI agent | drive the runtime programmatically | the same seam in ACP's dialect |

Two things fall out of this table:

1. **"See the result" often means the deliverables, not the chat text.** CLI and
   bots want `report.md`, `figures/*.png`, `provenance.jsonl` — which OpenCode
   does not own. The workspace/file surface is therefore first-class, not an
   afterthought.
2. **The permission story splits on "is anyone there to ask?"** Interactive
   clients can be *asked*; non-interactive ones cannot — so their policy must be
   *pre-authorized*, and anything outside it is **denied**, never left hanging.

### Why one gateway, not five features

The `AgentRuntime` interface (`packages/sdk/src/runtime.ts:31`) is already the
"unified API" this needs: `createSession` / `listSessions` / `deleteSession` /
`getMessages` (session management), `sendPrompt` / `runShell` / `runCommand` /
`abortSession` (input), `onEvent` / `getMessages` (results), and
`replyPermission` / `answerQuestion` (the interactive requests OpenAI-style APIs
have no concept of). CLI, LAN web, tunnel, and bots differ only in **transport +
binding + auth**. Building five adapters would reinvent the seam five times.

### What already exists (the gateway is ~80% substrate)

| Need | Status | Reference |
| --- | --- | --- |
| Runtime-agnostic contract | ✅ shipped | `packages/sdk/src/runtime.ts:31` (#24) |
| Listener/status base class | ✅ shipped | `packages/sdk/src/base-runtime.ts` (#36) |
| Session CRUD / prompt / events | ✅ via OpenCode HTTP+SSE | `OpenCodeClient.ts` |
| Directory listing / file read | ✅ (Tauri IPC today) | `src-tauri/src/artifact_file.rs:385` (`list_dir`) |
| Loopback HTTP server pattern | ✅ (static file preview) | `src-tauri/src/preview_server.rs` |
| Per-run auth secret | ✅ (sidecar Basic-auth password) | `src-tauri/src/runtime.rs:438` |
| Permission engine (allow/ask/deny, last-match-wins) | ✅ | `src-tauri/src/opencode_config.rs:35` |
| Cross-session live updates in the desktop | ✅ (events folded by `sessionId`) | `src-tauri`… `apps/desktop/src/lib/runtime.ts:849` |

The **gaps** are small and specific: a network-facing authenticated server, a
stable (not per-run) token with scopes, a file/workspace endpoint over HTTP, a
notification for sessions created by another client, and a per-client permission
policy engine.

## Design

### The seam, in two directions

```
                       AgentRuntime  (contract — #24)
                              │
      northbound (this RFC)   │   southbound (v0.5.0)
   ┌──────────────────────────┼──────────────────────────┐
   │                          │                           │
Gateway server  ───────────►  local runtime          RemoteRuntime (client)
(authed HTTP+SSE)             (OpenCodeClient →        implements AgentRuntime,
   ▲   ▲   ▲   ▲               opencode sidecar)        speaks the gateway wire
   │   │   │   │                                            │
  CLI web tunnel bot                              (the desktop, driving a
                                                   runtime on another machine)
```

`RemoteRuntime` is literally the gateway consumed by its own client. One wire
protocol serves both.

### Wire API

**Shape:** REST for commands + SSE for the event stream — deliberately mirroring
what `OpenCodeClient` already does, so `RemoteRuntime` is nearly a clone and
`curl` / a Feishu webhook can drive it trivially. (A JSON-RPC/WebSocket dialect
is added later only for "Open Science *as* an ACP server," which needs
bidirectional framing.)

**Base:** `/{version}/…`, e.g. `/v1`. All responses JSON. Auth on every request
(see below).

| Group | Endpoint | Maps to | Notes |
| --- | --- | --- | --- |
| Health | `GET /v1/health`, `GET /v1/whoami` | — | liveness; token's scope/mode |
| Sessions | `POST /v1/sessions` | `createSession` | returns `{id}` |
| | `GET /v1/sessions` | `listSessions` | |
| | `DELETE /v1/sessions/:id` | `deleteSession` | |
| | `GET /v1/sessions/:id/messages` | `getMessages` | history replay |
| Turns | `POST /v1/sessions/:id/prompt` | `sendPrompt` | body `{text, agent?, model?}`; 409 if busy |
| | `POST /v1/sessions/:id/abort` | `abortSession` | |
| | `POST /v1/sessions/:id/shell` `/command` | `runShell` / `runCommand` | mode-gated |
| | `POST /v1/sessions/:id/revert` `/unrevert` | `revert` / `unrevert` | idle-only |
| Events | `GET /v1/events` (SSE) | `onEvent` | workspace-wide; normalized `OpenCodeEvent` + `sessions.changed` |
| Interactive | `GET /v1/permissions` `GET /v1/questions` | `listPermissions` / `listQuestions` | recovery |
| | `POST /v1/permissions/:rid/reply` | `replyPermission` | interactive clients only |
| | `POST /v1/questions/:rid/answer` `/reject` | `answerQuestion` / `rejectQuestion` | |
| Capability | `GET /v1/skills` `/agents` `/commands` `/models` | discovery | |
| | `GET|PUT /v1/model` | `getDefaultModel` / `setDefaultModel` | runtime config → syncs |
| **Files** ⭐ | `GET /v1/fs/list?path=&root=` | `list_dir` (`artifact_file.rs`) | non-recursive, sandboxed |
| | `GET /v1/fs/read?path=&root=` | `read_artifact` | MIME + range |
| Projects | `GET /v1/workspaces`, `POST /v1/workspaces/switch` | project.rs | which folder is active |

**Never over the wire:** API keys / secrets. They live in the OS keychain and
must never appear in any endpoint, event, log, or export — regardless of client
or claimed purpose. Provider/MCP *key* configuration stays desktop-only.

### Permission model — one ladder, two resolutions

OpenCode's permission engine is `allow | ask | deny`, last-match-wins over
patterns (`opencode_config.rs:6`). Every client mode maps onto it. The desktop's
two existing modes (`approve` = ask on dangerous, `full` = allow all —
`lib/tauri.ts:85`) are the middle and top of a shared ladder:

| Mode | Interactive client (desktop / LAN web) | Non-interactive (CLI / CI / bot) | Suggested use |
| --- | --- | --- | --- |
| **read-only** *(new)* | read-only; write/exec/edit → **deny** | same | a token you hand out or expose; couch monitoring |
| **guarded** (= desktop `approve`) | dangerous ops **prompt** | **pre-authorized allowlist; everything else denied** | default |
| **yolo** (= desktop `full`) | everything in-workspace just runs | same | **sandbox / disposable machine only** ⚠️ |

**The key insight:** a non-interactive client has nobody to ask, so `ask`
collapses to *allow if pre-authorized, else `deny` (reject) — never hang*. That
is exactly "pre-authorize permissions; reject anything outside." The allowlist
maps straight to OpenCode rules, e.g. `--allow "bash:pytest *" --allow edit
--deny webfetch` → `allow` rules + a `deny` fallthrough.

**Scoping:** a **token carries a ceiling mode** (a LAN share token → read-only; a
sandbox CLI token → yolo). A token can never exceed its ceiling. Within the
ceiling, a single run may narrow the allowlist further.

**Implementation (Phase 1): the gateway is the policy engine.** OpenCode stays in
`approve` (so it *asks*); the gateway intercepts `permission.asked` events and,
for a policy-bound client, auto-replies `replyPermission("once")` or
`("reject")` per the token's mode/allowlist. This reuses existing plumbing
(events + `replyPermission`), needs **zero** OpenCode-config surgery, and is
naturally per-session (events carry `sessionId`). Interactive clients still get
the prompt. yolo = auto-allow all; guarded = decide per allowlist.

*Honest limit:* the gateway can only decide on operations OpenCode chooses to
ask about. A true **read-only** clamp (blocking even `edit`/file writes) needs
OpenCode to ask about more — a per-session permission profile (to confirm
against OpenCode) or a per-token sidecar. Phase 1 therefore enforces read-only
**at the gateway API layer** (reject all exec/edit/write endpoints for that
token) and defers a kernel-level clamp.

### Cross-client sync — "should the UI follow along?"

**Yes, and it is mostly free.** Once a network API exists, the desktop UI and
every remote client are peer *views* of one shared state whose source of truth is
the runtime (`opencode.db`), not any UI. Sync is therefore a consequence of the
architecture, not a per-action feature.

The dividing line:

> **Sync the shared substrate** — sessions, messages, approvals, runtime config
> (model), files/artifacts. **Keep view/preference state client-local** —
> selected session (`currentId`), open panels, composer drafts, theme, zoom,
> language. The test: *is it in the runtime/workspace, or is it about how this
> window looks?*

What this means for the concrete cases the product owner raised:

| Action from a remote client | Desktop behavior | Status |
| --- | --- | --- |
| **send a message** to session X | X's transcript updates live; sidebar shows the running spinner | ✅ already works — events are folded by `sessionId` into any thread (`runtime.ts:849`), the SSE stream is workspace-wide, cross-session spinner shipped (`8911feb`) |
| **create a session** | appears in the sidebar immediately | ⚠️ needs a nudge — there is no `session.created` event; the gateway emits **`sessions.changed`** on create → desktop calls `refreshSessions()` |
| **answer an approval** | the prompt clears on the other client too | ✅ workspace-global; `permission.resolved` already clears it |
| **change the model** | reflected everywhere | ✅ runtime config |
| **change theme / zoom / select a session** | no effect on other clients | ✅ correct — view state is local |

So the only new sync work is the **`sessions.changed`** signal (decision:
gateway-emitted on create, not desktop polling — immediate and accurate).

### Auth & binding

- **Token:** a stable, high-entropy bearer token (not the per-run sidecar
  password, which regenerates every launch and cannot be handed to a LAN
  client). Stored in the OS keychain. Shown, copyable, and **rotatable** in
  Settings. Carries a ceiling mode.
- **Binding:** **loopback (`127.0.0.1`) by default.** Exposing to the LAN
  (`0.0.0.0`) is an explicit, deliberate action in Settings with a clear warning.
  The OpenCode sidecar itself **stays loopback-only, always** — the gateway is
  the *only* thing that ever binds outward, and it is the only thing that
  understands the external token.
- **Tunnel:** just the same gateway + token reached through `cloudflared`/`frp`.
  No new API; optionally a one-click helper later.

This preserves the non-negotiable safety defaults (`AGENTS.md`): workspace-only
access, approval-by-default, keychain-only secrets, auditable network access.

### Where it lives

A Rust gateway in `src-tauri`, modeled directly on `preview_server.rs`: a
**std-only `TcpListener` with a thread per connection** — no new crates
(`reqwest` blocking + `getrandom` are already in the tree; `axum`/`tokio-net`
are not, and adding them would be the crate's first async HTTP server for no
real gain at this scale). SSE is a long-lived response the connection thread
streams to. It resides *in front of* the sidecar: agent calls proxy/translate
to OpenCode's HTTP+SSE (Phase 1 has a single runtime, so a translating proxy is
pragmatic while the *external* API stays contract-shaped and model-agnostic);
file calls reuse `artifact_file.rs` directly. It must outlive the webview (CLI
works with the window closed), so it is owned by the Rust process, not the UI.

### UI (aesthetics & usability are requirements)

A new **Settings → Remote Access** section, consistent with the existing
Codex-style settings:

- a master **enable** toggle (off by default);
- **binding** choice — *This device only (loopback)* vs *Local network* — the
  latter gated behind an explicit confirm explaining the exposure;
- the **token**: masked, with copy + regenerate, and the live URLs (loopback +
  detected LAN address, with a QR code for phones);
- **permission mode** for the issued token (read-only / guarded / yolo) with the
  same iconography as the composer's approval switch (`Hand` / `Zap`), and a
  plain-language caption per mode (yolo carries the "sandbox machines only"
  warning);
- a small **live status** line: bound address, connected clients, last request.

The LAN client itself (Phase 2) is a clean, self-contained responsive web page
served by the gateway — the couch/phone loop (list → open → stream → approve →
send), not a port of the full desktop app.

## Phased plan

Each slice is independently verifiable; the security-sensitive exposure is
deferred until the mechanism is proven on loopback.

- **Phase 1 — Loopback gateway + local visibility (this round).**
  Rust axum gateway bound to `127.0.0.1`; bearer token in the keychain with a
  ceiling mode; endpoints for sessions / turns / events(SSE) / files / health;
  the gateway policy engine (yolo + guarded-allowlist; read-only enforced at the
  API layer); the `sessions.changed` sync so remote-created sessions appear in
  the desktop; the **Settings → Remote Access** UI. *Verify:* `curl` with a
  bearer token creates a session, sends a prompt, streams results over SSE, and
  lists workspace files — and that session shows up in the desktop sidebar.
- **Phase 2 — LAN web + opt-in binding.** `0.0.0.0` binding behind an explicit
  confirm; the served responsive web client; QR to a phone.
- **Phase 3 — CLI + headless server (shipped).** `crates/osd-cli` (`osd`) is
  both halves: `osd server` serves the workbench with no window (the web client
  is compiled into the binary), and the client subcommands drive any gateway —
  including a running desktop's, found through the port it records beside its
  token. Three contract gaps were closed to make scripting possible at all:
  a directory on session creation (project-scoped runs, #81), a session status
  endpoint (so `--wait` waits for a REPLY, not for "accepted"), and model/agent
  on the prompt (so a run can state what it ran on). Pre-authorized runs
  (`--allow`/`--deny`) are NOT done: approvals still surface as pending
  requests, answered with `osd permission allow|deny`, which keeps the
  AGENTS.md rule that nothing dangerous runs unasked.
- **Phase 4 — Cloud tunnel & bots.** Optional one-click `cloudflared`; a Feishu
  (and Slack) bot that relays `sendPrompt` → streamed events, and fetches
  artifacts for "give me the result."
- **Later (v0.5.0 overlap).** `RemoteRuntime` as a first-class runtime (remote
  agent execution, #35); Open Science *as* an ACP server (#14). Both reuse this
  wire protocol.

## Open questions

1. Does OpenCode support a **per-session permission profile** (so read-only can
   be clamped in the kernel, not just the gateway API layer)? If not, is a
   per-token sidecar worth it, or is API-layer read-only sufficient for v1?
2. **Interactive escalation for headless runs:** when a CLI run hits an
   `ask` outside its allowlist, default is `deny`. Should there be an opt-in
   "escalate to a live desktop approver if one is connected" (possible because
   permissions are workspace-global)?
3. **Token granularity:** one token with a ceiling mode (Phase 1) vs multiple
   named tokens with independent scopes (a share-token vs a CLI-token). Start
   with one; grow to many?
4. **Concurrent prompts to one session:** reject with 409 (Phase 1) vs queue.
