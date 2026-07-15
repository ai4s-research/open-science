# RFC: Multi-agent via the Agent Client Protocol (ACP)

Status: **Proposal — seeking discussion. No code change in this PR.**
Depends on: PR #24 (`AgentRuntime` interface boundary).
Builds on: upstream roadmap v0.4.0 "Agent Client Protocol (ACP) support" (#14).

## TL;DR

The goal is to let users run Open Science Desktop with **Codex, Gemini CLI, Claude
Code, pi, zcode, and agents the community contributes later** — not just OpenCode.
This RFC argues the right way to get there is **not** to write a private adapter
per agent, but to adopt the **[Agent Client Protocol (ACP)](https://agentclientprotocol.com/)**
as a first-class runtime transport. ACP is the emerging "LSP for agents" (JSON-RPC
over stdio; 25+ agents as of March 2026; backed by Zed + JetBrains). Adopting it
turns "support agent X" into "configure a stdio command," and lets community
contributors add agents by writing a standard ACP server rather than learning our
private API.

This does **not** replace OpenCode. OpenCode stays the bundled default. ACP becomes
a *second transport* alongside it.

## Why ACP, not per-agent adapters

The instinctive approach is "write a `CodexAdapter`, a `ZcodeAdapter`, ..." against
the `AgentRuntime` interface from PR #24. That works for one or two agents but
scales badly:

| Concern | Per-agent adapter | ACP |
| --- | --- | --- |
| Add a new agent | Write & maintain a TS adapter against its native API | Configure a stdio command (if it speaks ACP) or run its existing ACP bridge |
| Codex today | bespoke | [`codex-acp`](https://github.com/agentclientprotocol/codex-acp) already exists |
| Gemini CLI / Copilot CLI | bespoke | native ACP support ([Copilot CLI, Jan 2026](https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/)) |
| Claude Code / Qwen / OpenCode | bespoke each | in the ACP ecosystem |
| Community contribution | learn our `AgentRuntime` contract | write a standard ACP server |
| Drift as agents change their API | we track every agent's breaking changes | the agent (or its ACP bridge) owns compat |
| Alignment with upstream #14 | orthogonal / competing | **this *is* #14** |

The decisive point: **upstream's v0.4.0 roadmap already lists "ACP support" (#14).**
"Multi-agent" and "ACP" are the same feature. Designing a private adapter layer
now would build a parallel, smaller ecosystem that we'd later have to reconcile
with ACP anyway.

## What ACP is (brief)

- **JSON-RPC 2.0 over stdio.** The client (us) spawns the agent as a child process
  and speaks JSON-RPC on its stdin/stdout.
- **Two roles:** Client (manages UI, renders chat/diffs/permissions) ↔ Agent
  (handles messages, runs tools).
- **Lifecycle:** `initialize` (negotiate protocol version + capabilities) →
  `session/new` or `session/load` → `session/prompt` (a turn) → `session/cancel`.
- **Streaming:** the agent sends `session/update` notifications during a turn,
  carrying message *parts* (text, tool calls, thoughts, errors). The turn ends
  with a `result` on the original `session/prompt` request.
- **Permissions:** the agent can *request permission* for an action; the client
  replies with allow/deny. Maps directly onto our approval dialog.

Full spec: <https://agentclientprotocol.com/protocol/v1/overview>.

## How it maps onto what we have

The `AgentRuntime` interface (PR #24) was deliberately derived from what
`lib/runtime.ts` already calls. ACP maps onto it almost 1:1 — which is the
strongest evidence the interface is the right shape:

| `AgentRuntime` (our interface) | ACP method(s) |
| --- | --- |
| `connect()` | `initialize` (+ spawn the stdio child) |
| `createSession()` | `session/new` |
| `getMessages(id)` | `session/load` + history parts |
| `sendPrompt(id, text)` | `session/prompt` |
| `abortSession(id)` | `session/cancel` |
| `listSkills()` / `listAgents()` | agent capabilities from `initialize` |
| `getDefaultModel()` / `setDefaultModel()` | model selection in `session/new` params (NOT a spec method — see Open Questions) |
| `onEvent(...)` | `session/update` notifications → normalized events |
| `answerQuestion` / `replyPermission` | `session/prompt` params / permission reply |

The mismatch surface is small and concentrated in two places (see Open Questions):
**model selection** and **provider/MCP configuration**, which ACP does not
standardize the way OpenCode does.

## Proposed architecture

```
                      AgentRuntime  (interface, PR #24)
                            │
            ┌───────────────┴────────────────┐
            │                                │
    OpenCodeClient                   AcpRuntime  (new)
    (existing: HTTP+SSE              (new: JSON-RPC over stdio;
     to bundled sidecar)              spawns any ACP agent as a child)
            │                                │
            │                    ┌───────────┼───────────┬──────────┐
            │                    │           │           │          │
            ▼                    ▼           ▼           ▼          ▼
      bundled opencode      codex-acp   gemini-cli   claude     any ACP
       (default)             (stdio)     (native)    code       server
```

Key points:

- **`AcpRuntime` is the only new code we write.** It `implements AgentRuntime`,
  spawns a child process per configured agent, and speaks JSON-RPC over its
  stdio. The rest of the app (`lib/runtime.ts`, the UI, provenance, runs) is
  unchanged — it already talks to `AgentRuntime`.
- **OpenCode is untouched.** It stays the bundled default; users who want Codex
  etc. pick an ACP agent in Settings.
- **No per-agent code in our repo.** Each agent is a *configuration entry*
  (command + args), not a code module.

## What changes, by layer

| Layer | Change | Effort |
| --- | --- | --- |
| `packages/sdk` | New `AcpRuntime implements AgentRuntime`: stdio child management, JSON-RPC framing, `session/update` → normalized events | **Most of the work** |
| `packages/sdk` | A JSON-RPC client (small; stdio transport) | medium |
| `src-tauri/src/runtime.rs` | Optionally spawn ACP children (or let the TS layer spawn — see Open Questions) | small-medium |
| `lib/runtime.ts` | A runtime *selector*: construct `OpenCodeClient` or `AcpRuntime` based on Settings | small |
| Settings UI | "Agent" picker: bundled OpenCode vs. configured ACP agents (command + args) | medium |
| Provider/MCP config | Stays OpenCode-specific; an ACP agent manages its own model config (or we agree on a convention) | open question |

## Phased rollout

| Phase | Deliverable | Risk |
| --- | --- | --- |
| **0** (this RFC) | Agree ACP is the standard; agree the `AcpRuntime` shape. | None |
| **1** (PR #24) ✅ | `AgentRuntime` interface boundary (landed independently). | Done |
| **2** | `AcpRuntime` skeleton + JSON-RPC stdio transport, proven against one agent with native ACP (e.g. Gemini CLI). Wired behind a dev flag. | Medium |
| **3** | Settings "Agent" picker; run an ACP agent end-to-end (prompt → stream → tool → idle) through the existing UI. | Medium |
| **4** | Permission/question flows across the ACP boundary; provenance/run recording unchanged (they listen to `AgentRuntime` events). | Low-medium |
| **5** | Document "how to add your agent" (it's: write/bring an ACP server, add a Settings entry). Ship as the v0.4.0 #14 story. | Low |

## Open questions (what I want from discussion)

1. **Model selection.** ACP has no `session/set_model` spec method (JetBrains
   filed [AIR-6168](https://youtrack.jetbrains.com/issues/AIR-6168) about this).
   Our Settings assumes the app owns model choice. For ACP agents, should model
   selection be (a) a `session/new` param per the agent's capabilities, (b) the
   agent's own config (out of our hands), or (c) push for an ACP spec addition?
2. **Provider/MCP configuration.** `getClient()` (PR #24) exposes OpenCode's
   provider/MCP/OAuth surface to Settings. ACP agents manage their own. Do we
   show provider config *per agent type* (OpenCode: full; ACP: whatever the agent
   exposes), or keep provider config OpenCode-only for now?
3. **Where do ACP children live?** Spawn from TS (`AcpRuntime` owns the child) or
   from Rust (`src-tauri` supervises it like the OpenCode sidecar)? Rust gives
   cleaner lifecycle/kill-on-exit; TS is simpler to prototype.
4. **Stdio vs. the bundled sidecar.** OpenCode is an HTTP *server* we supervise;
   ACP agents are stdio *children*. The `RuntimeState` in Rust assumes a port+url.
   How much of that model do we generalize vs. keep OpenCode-specific?
5. **Scope of v0.4.0 #14.** Is this RFC the design for #14, or a subset? Should
   we also expose Open Science *as* an ACP server (editor → us), or only consume
   ACP servers (us → agent) in this round?
6. **First agent to prove it.** Gemini CLI (native ACP) is the lowest-friction
   target; Codex needs `codex-acp`. Which should be the Phase 2 proof-of-concept?

## Alternatives considered

- **Per-agent adapters against `AgentRuntime`.** Rejected as the primary path:
   reinvents what ACP already standardizes, doesn't scale, diverges from #14.
   (A *thin* adapter for an agent with no ACP support remains a fallback, but it
   is not the architecture.)
- **Adopt ACP as the *only* runtime, deprecate OpenCode's HTTP transport.**
   Rejected: OpenCode is bundled, working, and battle-tested; forcing it through
   an ACP shim adds risk for no gain. Both transports coexist behind
   `AgentRuntime`.
- **Wait for the ACP spec to add model management before starting.** Rejected:
   we can ship Phases 2–4 with the current spec and refine model selection later.

## References

- ACP spec: <https://agentclientprotocol.com/protocol/v1/overview>
- [`codex-acp`](https://github.com/agentclientprotocol/codex-acp) — Codex via ACP
- [Copilot CLI ACP preview (Jan 2026)](https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/)
- [ACP explained (MorphLLM)](https://www.morphllm.com/agent-client-protocol) — 25+ agents, Mar 2026
- PR #24 — `AgentRuntime` interface boundary (dependency)
- Upstream roadmap v0.4.0 — "ACP support" (#14), LAN web UI (#3), messaging (#20)
