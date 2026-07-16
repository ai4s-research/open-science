# Integrating a new agent runtime

Open Science Desktop is model-agnostic and runtime-pluggable: the bundled
**OpenCode** is the default, but any agent that can be driven as a process can be
wired in as an `AgentRuntime`. This guide shows a contributor how to add one.

> The architecture and rationale live in [`docs/rfc/agent-runtime.md`](./rfc/agent-runtime.md)
> and [`docs/rfc/multi-agent-acp.md`](./rfc/multi-agent-acp.md). This page is the
> **how-to**.

## What you are building

A class that talks to *your* agent and speaks the app's normalized event stream.
The app (store, provenance, runs, UI) only knows the `AgentRuntime` contract —
it never sees your agent's native protocol.

```
your agent binary  ←─ your protocol ─→  YourRuntime  ──→  app (unchanged)
                                         implements AgentRuntime
```

## The two building blocks

Everything you need is exported from `@ai4s/sdk`:

| Export | Role |
| --- | --- |
| `BaseAgentRuntime` | **Extend this.** Gives you the listener + status machinery (`getStatus`, `onEvent`, `onStatus`, and protected `emit`/`setStatus`) for free — identical across every runtime. |
| `AgentRuntime` (type) | The interface your class satisfies. `extends BaseAgentRuntime` covers the listener methods; you implement the rest. |

If your agent speaks **JSON-RPC over stdio** (Codex's `app-server`, or any ACP
agent), you also get a transport for free:

| Export | Role |
| --- | --- |
| `StdioJsonRpcClient` | Spawns a child process, frames line-delimited JSON-RPC 2.0, matches requests to responses by id, and delivers notifications. Used by `CodexRuntime`; reusable for any stdio agent. |

## The 5 steps

### 1. Extend `BaseAgentRuntime`

```ts
import { BaseAgentRuntime, StdioJsonRpcClient } from "@ai4s/sdk";
import type { OpenCodeEvent } from "@ai4s/sdk";

export class MyAgentRuntime extends BaseAgentRuntime {
  // …your fields…
}
```

`getStatus` / `onEvent` / `onStatus` are inherited. You do **not** write them.

### 2. Implement `connect()` / `close()`

Call `this.setStatus("connecting")` when you start, `"ready"` once connected,
`"error"` on failure, and `this.setStatus("offline")` in `close()`. The status
badge in the UI follows these automatically.

```ts
async connect(): Promise<void> {
  this.setStatus("connecting");
  // spawn your agent / open your transport
  this.setStatus("ready");
}
close(): void {
  // tear down
  this.setStatus("offline");
}
```

### 3. Translate your agent's output into `OpenCodeEvent`

This is the heart of the integration. Call `this.emit(event)` for every
normalized event so the app's store, provenance, and runs recorder pick it up.
The five event types that matter:

| Your agent produces | Emit this | Why |
| --- | --- | --- |
| A chunk of assistant text | `text.updated` | Streams into the chat. Emit the **full accumulated** text so far (not just the delta) — the app upserts by `partId`. |
| A tool/command running | `tool.updated` (status `running`) | Shows the tool card. |
| A tool/command finishing | `tool.updated` (status `success`/`failed`) | Resolves the tool card. |
| A command needing approval | `permission.asked` | Pops the approval dialog; the turn pauses until the user replies. |
| The turn ending | `session.idle` | Unlocks the composer. |

```ts
// text arriving in pieces — accumulate, then emit the full value
this.emit({
  type: "text.updated",
  sessionId: threadId,
  partId: "text",
  text: accumulated,
});
```

### 4. Implement the session methods

| Method | What to do | If your agent has no equivalent |
| --- | --- | --- |
| `createSession()` | Start a conversation; return its id | — (required) |
| `sendPrompt(id, text, agent?, model?)` | Drive one turn; await completion | — (required) |
| `abortSession(id)` | Cancel the in-flight turn | best-effort |
| `getMessages(id)` | Load history | return `[]` or replay what you buffered |
| `listSessions()` / `deleteSession()` | History management | return `[]` / no-op |
| `listSkills()` / `listAgents()` / `listCommands()` | Capability discovery | return `[]` (honest, not fake) |
| `getDefaultModel()` / `setDefaultModel()` | Model picker | return `null` / no-op |
| `runShell()` / `runCommand()` | Shell & slash modes | no-op if unsupported |
| `listQuestions()` / `listPermissions()` | Pending interactive requests | return `[]` |
| `answerQuestion()` / `rejectQuestion()` / `replyPermission()` | Reply to the agent | implement for approval-based agents |

**Return empty/no-op for things your agent doesn't have — don't fake data.** The
UI gracefully hides surfaces that report empty.

### 5. Test against a mock, not a real agent

Your agent binary may need a license, a key, or a network — CI has none of those.
Write tests with a **mock** that speaks your protocol. See
`apps/desktop/src/test/codex-runtime.test.ts`: it spawns a tiny `node -e` script
that echoes the codex JSON-RPC shape, so the test runs anywhere.

```
✓ connect, createSession, and stream a turn into normalized events
✓ maps a command-approval request to permission.asked
✓ status transitions through connecting → ready → offline
```

## Reference implementation

[`CodexRuntime`](../packages/sdk/src/CodexRuntime.ts) is the worked example. It
spawns `codex app-server`, drives it with `StdioJsonRpcClient`, and translates
codex's `thread/message` / `thread/command` / `thread/commandApprovalRequest` /
`thread/completed` notifications into the five `OpenCodeEvent` types above. Read
it alongside this guide.

## The ACP shortcut

If your agent already speaks the **[Agent Client Protocol](https://agentclientprotocol.com/)**
(many do — Gemini CLI, Copilot CLI, Claude Code, and soon others), you don't
write a per-agent class at all: you'll configure it as an ACP server once
`AcpRuntime` lands (tracked in [#25](../docs/rfc/multi-agent-acp.md)). A custom
runtime is for agents with a **private** protocol, like codex's app-server today.

## Checklist for a PR

- [ ] Class `extends BaseAgentRuntime`, `implements AgentRuntime`.
- [ ] `connect`/`close` drive `setStatus` through the lifecycle.
- [ ] Agent output is translated into the five `OpenCodeEvent` types.
- [ ] Methods your agent doesn't support return empty/no-op (no fake data).
- [ ] A mock-based test in `apps/desktop/src/test/` passes without the real binary.
- [ ] `pnpm typecheck` + `pnpm lint` green (the `implements` clause enforces the interface).
