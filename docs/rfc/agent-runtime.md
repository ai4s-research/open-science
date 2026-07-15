# RFC: An `AgentRuntime` boundary

Status: **Phase 1 implemented in this PR; Phases 2–3 open for discussion.**
Target: land before v0.4.0 ACP work (see "Timing").

## TL;DR

Open Science Desktop already treats `packages/sdk` as *the* boundary between the
UI and the agent runtime (an architecture rule in `AGENTS.md`). In practice the
boundary is a **concrete class, `OpenCodeClient`**, not an interface, and the only
runtime is a bundled OpenCode sidecar. This RFC proposes formalizing that boundary
as a small, runtime-agnostic **`AgentRuntime` interface** that `OpenCodeClient`
implements — **no behavioral change, no second runtime, no user-facing switch** —
so the seam the project already depends on is explicit and ready for future work.

## Motivation

### What the docs promise

`AGENTS.md` and `docs/PRD.md` (§10.3) both name "agent runtime decoupled" and
"pluggable" as an architectural goal. The `TECHNICAL_DESIGN.md` one-liner calls
the project a "replaceable agent runtime."

### What the code does today

The seam exists, but informally. The whole app reaches the runtime through one
class, and one place builds it:

| Layer | Fact | Reference |
| --- | --- | --- |
| SDK | A single concrete class, no `interface` | `packages/sdk/src/OpenCodeClient.ts:54` |
| Frontend | Exactly **one** instantiation site | `apps/desktop/src/lib/runtime.ts:654` |
| Store | Imports the concrete class, not an abstraction | `apps/desktop/src/lib/runtime.ts:3` |
| Events | Type names are OpenCode's wire names (`message.part.updated`) | `packages/sdk/src/types.ts` |
| Desktop shell | Bundles and supervises the OpenCode binary | `apps/desktop/src-tauri/src/runtime.rs` |

The "decoupling" is real *de facto* — every call is centralized — but it is not
*expressed* in the types. A maintainer cannot tell from a signature "this part is
runtime-specific" vs. "this part is the app's contract."

### Why formalize it now (without building a second runtime)

Three reasons, in order of weight:

1. **It is cheap and nearly free.** The interface already exists implicitly; this
   only makes it `export interface`. No behavior changes, no migration, no risk to
   the shipping app. Pure YAGNI-safe: we extract *what is already there*.
2. **It sharpens future discussions.** Upstream's v0.4.0 plan includes
   **Agent Client Protocol (ACP)** support (#14) and **LAN / messaging surfaces**
   (#3, #20). Both touch "what does it mean to drive the runtime?" Having a named
   boundary lets those features be debated against a stable contract instead of
   against `OpenCodeClient`'s private method list.
3. **It records the seam for contributors.** A new contributor reading
   `lib/runtime.ts` today cannot see which methods are essential vs. incidental.
   An interface with a short contract per method answers that in one place.

### Non-goals

- **No second runtime.** This RFC does *not* propose building an alternative to
  OpenCode. OpenCode remains the only implementation.
- **No user-facing "choose your runtime" setting.** Product surface stays exactly
  as today.
- **No ACP implementation.** ACP is referenced as *alignment context*, not as work
  this RFC does. See "Relationship to ACP".
- **No event-name neutralization now.** Renaming `message.part.updated` → a neutral
  name is deferred (it is the noisiest part; see "Phases").

## Proposed interface (implemented in this PR)

Derived from the **runtime methods + listener hooks `lib/runtime.ts` actually
uses today** (verified by grep). Nothing invented; this is the current surface,
named and contracted. The interface lives at `packages/sdk/src/runtime.ts`, and
`OpenCodeClient` now `implements AgentRuntime`.

```ts
// packages/sdk/src/runtime.ts

/** The boundary AGENTS.md already mandates. OpenCodeClient is the sole impl. */
export interface AgentRuntime {
  // lifecycle
  connect(): Promise<void>;
  close(): void;
  getStatus(): RuntimeStatus;
  onStatus(listener: (s: RuntimeStatus) => void): () => void;
  onEvent(listener: (e: RuntimeEvent) => void): () => void;

  // sessions (a conversation)
  createSession(): Promise<string>;
  listSessions(): Promise<SessionMeta[]>;
  deleteSession(id: string): Promise<void>;
  getMessages(id: string): Promise<HistoryMessage[]>;
  sendPrompt(id: string, text: string): Promise<void>;
  abortSession(id: string): Promise<void>;

  // discovery (what this runtime can do)
  listSkills(): Promise<SkillInfo[]>;
  listAgents(): Promise<AgentInfo[]>;
  listCommands(): Promise<CommandInfo[]>;

  // model selection
  getDefaultModel(): Promise<string | null>;
  setDefaultModel(model: string): Promise<void>;

  // agent-driven execution (a full turn, not a single prompt)
  runShell(sessionId: string, command: string, agent?: string): Promise<void>;
  runCommand(sessionId: string, command: string, args?: string): Promise<void>;

  // interactive requests (agent asks; user must answer)
  listQuestions(sessionId?: string): Promise<QuestionAskedEvent[]>;
  listPermissions(sessionId?: string): Promise<PermissionAskedEvent[]>;
  answerQuestion(requestId: string, answers: string[][]): Promise<void>;
  rejectQuestion(requestId: string): Promise<void>;
  replyPermission(requestId: string, reply: PermissionReply): Promise<void>;
}
```

Notes on the contract:

- **Provider/MCP/OAuth methods are intentionally excluded.** They are
  *configuration* of OpenCode-the-implementation, not of "an agent runtime." If a
  future runtime has no notion of providers, it should not have to stub them. This
  split is the most useful thing the interface makes visible.
- **Event type names stay as-is for now** (`message.part.updated` etc. live behind
  a normalized `RuntimeEvent` alias). Renaming is a later, separate decision.

## Relationship to ACP (v0.4.0 #14)

[Agent Client Protocol](https://github.com/agentclientprotocol/agent-client-protocol)
(Zed, Aug 2025; JSON-RPC over stdio; "LSP for agents") is an emerging standard
for *editors driving agents*. Upstream already lists ACP under v0.4.0.

This RFC is **complementary, not competing**:

- ACP standardizes the **editor → agent** direction (an external editor drives our
  runtime). That is an *additive* surface — "Open Science as a runtime others can
  drive."
- `AgentRuntime` standardizes the **app UI → runtime** direction *internally*. That
  is the seam *we already rely on*.

The two are orthogonal. But if/when ACP lands, a clean internal boundary means the
ACP adapter can target `AgentRuntime` (or sit beside it) without `lib/runtime.ts`
being rewritten around OpenCode specifics. Naming the boundary *before* ACP work
starts is the main timing argument.

## Phased rollout (each step independently mergeable)

| Phase | Change | Risk | Reversible |
| --- | --- | --- | --- |
| **0** | Discussion only. Document the seam, agree on the method set. | None | N/A |
| **1** (this PR) ✅ | Add `interface AgentRuntime`; `OpenCodeClient implements AgentRuntime`. `lib/runtime.ts` types its internal `client` against the interface, still constructed as `new OpenCodeClient(...)`. No behavior change. typecheck + lint green; `opencode-client.node.test.ts` (16 tests) green. | Trivial | Yes |
| **2** | Decide event-name neutralization: alias OpenCode wire names behind `RuntimeEvent`. | Low | Yes |
| **3** (future, out of scope) | A second runtime, ACP adapter, or a "custom endpoint" provider — only if a concrete need appears. | — | — |

**Phase 1 is implemented in this PR.** Phases 2–3 are listed so reviewers see the
trajectory and can object early.

## Open questions (what I want from discussion)

1. **Method-set agreement.** Are the 15 methods above the right *minimal* contract,
   or should provider/MCP config be in-scope (i.e., every runtime is expected to
   expose providers)?
2. **ACP alignment.** Should the event shape deliberately mirror ACP's session/
   message/part model now, to make a future adapter cheap — or keep OpenCode's
   shape and reconcile later?
3. **Naming & location.** `AgentRuntime` in `packages/sdk/src/runtime.ts`? Or a
   `packages/runtime-contract` to signal it is shared, not SDK-owned?
4. **Timing.** Land Phase 1 before v0.4.0 ACP work starts, or fold it into #14?
5. **Testing the seam.** Would a mock `AgentRuntime` (the SDK already ships
   `mockServer.ts`) become the basis for frontend tests without a sidecar?

## Alternatives considered

- **Status quo (do nothing).** Valid; the app works. Cost: the v0.4.0 ACP and
  LAN-surface work will re-litigate "what is runtime-specific" inside a 1.6k-line
  store file, with no named contract to anchor on.
- **Build a second runtime now.** Explicitly rejected — no demonstrated need, and
  it would invert the "extract what exists" principle into "design for an imagined
  second implementation."
- **Adopt ACP as the internal boundary.** Rejected for now: ACP is editor-facing
  and still maturing; our internal seam predates it and serves a different
  direction. Worth revisiting once #14 ships.

## Timing

This RFC targets the window **after v0.2.1/v0.3.0 and before v0.4.0 ACP work
begins** — the moment where naming the seam is cheapest and most useful. It is not
a v0.3.0 deliverable and should not delay UX work tracked in #20–#22.

## References

- `AGENTS.md` — "The UI never calls OpenCode directly — it goes through
  `packages/sdk`."
- `docs/PRD.md` §10.3 — "Frontend, desktop shell, and agent runtime decoupled."
- `docs/TECHNICAL_DESIGN.md` §5 — OpenCode as bundled sidecar; `OpenCodeClient`.
- Upstream roadmap: v0.4.0 "Agent Client Protocol (ACP) support" (#14), LAN web UI
  (#3), messaging integrations (#20).
- [Agent Client Protocol](https://github.com/agentclientprotocol/agent-client-protocol)
