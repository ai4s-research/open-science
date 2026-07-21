# RFC: Runtime evolution — data-driven defs, transport engines, and `WorkspaceOps`

Status: **Proposal — seeking discussion. No code change in this RFC.**
Builds on: [`agent-runtime.md`](./agent-runtime.md) (Phase 1 merged in #24, #36) and
[`multi-agent-acp.md`](./multi-agent-acp.md) (proposal, #25). Supersedes neither; this
RFC refines the *shape* of both in light of new evidence.

## TL;DR

Two prior RFCs established Open Science Desktop's runtime seam: `agent-runtime.md`
formalized `interface AgentRuntime` (Phase 1 merged), and `multi-agent-acp.md` proposed
ACP as a first-class transport (still a proposal). Since then, **a production project —
[open-design](https://github.com/nexu-io/open-design) v0.10.0, MIT, 24 coding-agent
integrations — has shipped the architecture `multi-agent-acp.md` only proposed**, with a
twist: ACP as preferred transport (validating that RFC's thesis) *and* a **data-driven
"definition object" pattern** instead of an `AgentRuntime`-style class interface. Adding
an ACP-speaking agent there costs ~25 lines, not a full class.

This RFC argues that open-design's shipped reality is strong evidence for a specific
refinement of both prior RFCs: keep the ACP direction, but evolve the per-runtime shape
from **class-implements-interface** toward **data definition + shared transport engines**,
and add a small **`WorkspaceOps`** surface to the seam so the v0.4 northbound gateway can
proxy file operations through the same boundary it proxies prompts through. It proposes
no code change in itself; it amends the two prior RFCs and lays out a phased path whose
first step is a behavior-preserving refactor in the spirit of #36.

## 1. Background

Open Science Desktop's runtime boundary was formalized in two prior RFCs:

- **`agent-runtime.md`** landed Phase 1: `interface AgentRuntime` in
  `packages/sdk/src/runtime.ts`, `BaseAgentRuntime` shared plumbing in `base-runtime.ts`
  (#36). The UI now talks to the runtime only through that interface; the concrete
  `OpenCodeClient` is reachable only via `getClient()` for OpenCode-specific
  provider/MCP/OAuth surface. Phases 2–3 (a second runtime to validate the seam, then
  transport generalization) remain open.
- **`multi-agent-acp.md`** proposed adopting the Agent Client Protocol as a first-class
  transport, arguing — against the "write a `CodexAdapter` per agent" instinct — that ACP
  turns "support agent X" into "configure a stdio command." Status: proposal, no code yet.
  `CodexRuntime` (#28) exists as a prototype under verification.

Since those RFCs, two things have changed:

1. **We have a working prototype that exposes the cost of the interface+class shape.**
   `CodexRuntime` in #28 re-implements `connect`/`createSession`/`sendPrompt`/event-stream
   normalization from scratch against the `AgentRuntime` interface, even though most of
   what it does is identical to `OpenCodeClient` apart from the protocol dialect. This is
   the first real data point on how expensive "add a runtime" is under the current shape,
   and it is higher than the original RFC estimated.
2. **A production project — open-design — has shipped the architecture
   `multi-agent-acp.md` only proposed**, with the twist in the TL;DR. This RFC treats (2)
   as the core piece of new evidence.

**What this RFC does *not* propose:**

- Removing or rewriting the merged `AgentRuntime` interface / `BaseAgentRuntime`
  (#24, #36). Those land as-is.
- Abandoning OpenCode as the bundled default runtime.
- Any change to the provider/MCP/OAuth surface reachable via `getClient()`.
- Any change to the safety/privacy layer (workspace-only access, approval-gated dangerous
  commands, keychain-only secrets).

## 2. New evidence: how open-design ships 24 agents

> The claims in this section come from reading open-design v0.10.0's source directly
> (`apps/daemon/src/runtimes/`, `apps/daemon/src/acp.ts`, and the stream parsers).
> References are to that codebase, not ours.

### 2.1 The shape: data definitions, not runtime classes

open-design has **no `AgentRuntime` interface and no per-agent class**. Each agent is a
plain `RuntimeAgentDef` struct (`apps/daemon/src/runtimes/types.ts:93-238`):

```ts
type RuntimeAgentDef = {
  id: string;
  bin: string;                              // CLI binary
  buildArgs: (prompt, opts) => string[];    // the ONLY required function
  streamFormat: string;                     // selects the transport engine
  fallbackModels: RuntimeModelOption[];
  // ... opt-in capability hooks
};
```

Every adapter file ends with `} satisfies RuntimeAgentDef;` — compile-time shape check, no
runtime validation, no constructor. The Claude adapter (`runtimes/defs/claude.ts`) is 98
lines; the entire Kimi adapter (`kimi.ts`) is **27 lines**.

**24 agents are registered as one line each** in a static array
(`apps/daemon/src/runtimes/registry.ts:28-53`); a duplicate-id guard throws at module
load. Adding a built-in agent = create one def file + add one line to the array.

### 2.2 The polymorphism axis: `streamFormat`, not `class`

Where Open Science's `OpenCodeClient` hides which protocol it speaks inside one class,
open-design declares a small enum of **stream formats** and dispatches once:

| `streamFormat`        | Engine                                        | Used by                                  |
| --------------------- | --------------------------------------------- | ---------------------------------------- |
| `acp-json-rpc`        | `acp.ts` (1,744 lines, shared)                | 9 agents (kimi, hermes, kiro, vibe, …)   |
| `claude-stream-json`  | `claude-stream.ts` (622 lines)                | claude, codebuddy                        |
| `json-event-stream`   | `json-event-stream.ts` (872 lines, 5 sub-parsers) | opencode, codex, cursor, gemini, kimi (legacy) |
| `copilot-stream-json` / `qoder-stream-json` / `pi-rpc` / `plain` | per-format          | the rest                                 |

The dispatch is a single `if (streamFormat === ...)` chain in `server.ts:7995-8280`.
**Adding a new agent that reuses an existing format is ~25 lines; adding a new format is
a one-time ~500-line parser investment amortized over every future agent that speaks
it.**

### 2.3 ACP is the stated preferred transport

open-design's own docs (`docs/new-agent-runtime-acp.md:5-7`) say explicitly:

> New agent runtimes should expose an **ACP over stdio** CLI mode.

And `docs/agent-adapters.md:9-11` frames the whole project as:

> The code agent space has already converged on a few strong implementations …
> Reimplementing another one is worse than just talking to all of them.

The recent commit `ab4532412 [codex] Restore Kimi ACP and retire Gemini CLI runtime
(#5023)` is telling: the Gemini CLI runtime was **retired** because it never fit cleanly,
and the project is converging on **ACP-first, with per-CLI parsers as legacy baggage** for
incumbents that pre-date ACP (Claude, Codex, Cursor).

### 2.4 Behavior differences are data, not code paths

Two concrete examples of the pattern:

- **Session resume**: instead of each adapter writing resume logic, the def declares one
  of three flags — `resumesSessionViaCli` (daemon mints id, e.g. claude `--session-id`),
  `capturesSessionIdFromStream` (agent mints id, daemon reads it — codex
  `thread.started.thread_id`), `resumesSessionViaAcpLoad` (ACP `session/load`). The resume
  code branches on the flag, not on agent id (`types.ts:175-201`).
- **MCP injection**: four named strategies — `claude-mcp-json` / `acp-merge` /
  `opencode-env-content` / `mimo-env-content` (`types.ts:160-164`). An adapter picks one
  rather than implementing MCP forwarding.

### 2.5 Numbers

- **Per-agent def**: 24 files, 2,118 lines total. Median ~50 lines. Smallest 21 lines.
- **Shared engines**: `acp.ts` 1,744 + `json-event-stream.ts` 872 + `claude-stream.ts`
  622 + `pi-rpc.ts` 684 + smaller = ~5,000 lines of transport, amortized over 24 agents.
- **Marginal cost of a new ACP agent**: **~25 lines.**
- **Marginal cost under our current shape** (extrapolated from #28): a full class
  reimplementing the `AgentRuntime` interface — hundreds of lines, most of it boilerplate
  duplicating `OpenCodeClient`.

### 2.6 What open-design deliberately does *not* put on the runtime

This matters for us: open-design's runtime layer **exposes no file/workspace methods**.
File ops live in a separate daemon HTTP layer (`workspace-contract.ts`, `byok-tools.ts`).
Their product is a design-chat tool; the agent CLI owns its own files and open-design
never needs to browse them on the agent's behalf.

This is a **point of divergence, not agreement** — see §4.

## 3. Patterns worth porting (and one to skip)

This section distills four patterns from §2 that translate to Open Science Desktop, and
calls out one pattern we should *not* copy.

### 3.1 Port: data-driven runtime definitions

**The pattern.** Replace "one class per runtime" with "one data definition per runtime +
a small number of shared engines that consume definitions." A runtime author writes a
record describing what makes their runtime different; the engines handle spawning,
event-stream parsing, cancellation, resume.

**Why it translates.** Our `BaseAgentRuntime` (#36) already extracted the listener/status
plumbing that every runtime shares. The next step in the same direction is to extract the
*protocol-handling* plumbing too: today every runtime will re-implement
`connect`/`createSession`/`sendPrompt`/event-stream normalization, even though the parts
that *differ* across runtimes are typically just the argv shape and the event-dialect.
open-design shows that those differences fit in a data record.

**Shape sketch** (illustrative — not the final API):

```ts
type RuntimeDef = {
  id: string;
  // How to talk to this runtime. Selects a transport engine + its config.
  transport:
    | { kind: "opencode-http"; baseUrl: string; password?: string; directory?: string }
    | { kind: "acp-stdio"; command: string; args: string[] }
    | { kind: "codex-stream-json"; command: string; args: string[] };
  // Optional capability hooks, undefined = engine default.
  resumesSessionVia?: "cli" | "stream-capture" | "acp-load";
  defaultModel?: string;
};
```

`OpenCodeClient` becomes `opencodeDef: RuntimeDef` + a shared `OpenCodeHttpEngine` that
consumes it. `CodexRuntime` (#28) becomes `codexDef: RuntimeDef` consumed by a
`StreamJsonEngine` — not a class.

**What this is *not*.** Not a rewrite of `OpenCodeClient`'s internals. The engine is the
current `OpenCodeClient` code, refactored to read its inputs from a def instead of
constructor args. Behavior is preserved; this is a structural refactor in the spirit of
#36.

### 3.2 Port: `streamFormat` as the polymorphism axis

**The pattern.** Declare the protocol dialect as a field; dispatch once to the matching
parser. The set of formats is the system's extensibility axis, not the set of classes.

**Why it translates.** Our `AgentRuntime` interface currently hides which dialect a
runtime speaks — the UI doesn't know, and shouldn't. But the *engines* need to know, and
today that knowledge is implicit (it's whatever `OpenCodeClient` happens to do
internally). Making it an explicit field is what lets a single engine serve many
runtimes.

For us, the realistic format set in the medium term is small:

- `opencode-http` — the bundled default (OpenCode over HTTP+SSE).
- `acp-stdio` — the v0.5 transport (`multi-agent-acp.md`).
- Possibly `codex-stream-json` if we want Codex *before* its ACP mode is ready (but see
  §3.5 and §5.2's deprecation stance).

### 3.3 Port: named strategy fields for cross-cutting behavior

**The pattern.** Behavior that varies across runtimes but isn't protocol dialect —
session resume, MCP injection, capability gating — is expressed as a named field on the
def, not implemented per-runtime.

**Why it translates.** We already have one cross-cutting concern that will vary by
runtime: **session resume** (OpenCode persists sessions server-side; ACP has
`session/load`; a generic stream agent might capture an id from stdout). open-design's
three-flag vocabulary (`resumesSessionViaCli` / `capturesSessionIdFromStream` /
`resumesSessionViaAcpLoad`) maps almost 1:1 onto our needs.

We likely don't need open-design's four MCP-injection strategies yet — our MCP surface is
OpenCode-specific and reached via `getClient()`. YAGNI; add strategies when a second
runtime needs them.

### 3.4 Port: capability probing at detection time

**The pattern.** At detection, spawn `<bin> --help` once and cache which optional flags
the runtime supports; consult the cache when building argv so old or forked binaries
don't die on unknown options.

**Why it translates.** We already track OpenCode version (`OPENCODE_VERSION`) and the
codebase has historical scars from flag drift across OpenCode versions (see PROGRESS.md
entries on `plan_exit`, plugin loading). A `capabilityFlags` cache keyed by detected
version would have prevented several of those.

### 3.5 Skip (for now): spawn-per-turn process model

open-design spawns a fresh child process for every `/api/chat` request and relies on the
agent CLI's own session store for continuity. This fits its chat-product model.

**We should not copy this.** Our UX is built on a long-lived sidecar with a persistent
SSE stream: live tool-call rendering, streaming bash output folding, subagent event
routing, and the entire provenance/run-capture pipeline all assume the runtime is
*always on*. Switching to spawn-per-turn would be a product-level change, not an
architecture-level one, and it is orthogonal to the def-vs-class question. **Keep our
sidecar model; adopt the def pattern on top of it.**

## 4. Where we diverge: file and workspace operations on the seam

### 4.1 open-design's choice doesn't apply to us

open-design deliberately puts no file/workspace methods on its runtime layer (§2.6).
That's the right call *for a design-chat product*: the agent CLI owns its workspace,
open-design never needs to browse or modify files on the agent's behalf, and a
`readFile` on the runtime interface would be dead weight.

**Our product is different.** Open Science Desktop's entire value proposition is
reproducible, auditable artifacts: every figure, table, report, and run record must
trace to the code, inputs, and conversation that produced it (`PRD.md` §4.3, §5.1.9).
The runtime seam is the natural observation point for that tracing — it's where writes
happen (`apply_patch`, `write`, `edit` events already drive `provenance.jsonl`), and it's
where the v0.4 northbound gateway will proxy workspace browsing for LAN/CLI/messaging
clients (`PRD.md` §v0.4).

If file/workspace operations stay locked in Tauri commands (as they are today — see
`apps/desktop/src-tauri/src/artifact_file.rs`), then:

- The v0.4 API gateway cannot expose "browse this session's files" without a second,
  parallel path alongside `AgentRuntime`.
- A future remote runtime (v0.5) can't proxy file reads through the same seam it proxies
  prompts through — remote execution and remote file access become two different
  protocols.
- The provenance pipeline becomes harder to generalize, because it observes writes
  through events but reads through Tauri, and the two views can drift.

### 4.2 The proposal: a small `WorkspaceOps` surface on the seam

Add a narrow, explicit file/workspace interface alongside `AgentRuntime`. Concretely:

```ts
// Illustrative — final shape to be decided in the implementing PR.
interface WorkspaceOps {
  listDir(relPath: string): Promise<DirEntry[]>;
  readFile(relPath: string): Promise<{ bytes: Uint8Array } | { text: string }>;
  writeFile(relPath: string, content: string | Uint8Array): Promise<void>;
  deleteFile(relPath: string): Promise<void>;
}
```

Two design decisions, each with a recommended answer:

**Decision 1 — Separate interface or merged into `AgentRuntime`?**

Recommended: **separate `WorkspaceOps` interface; a runtime may implement it or not.**
Merging into `AgentRuntime` would force every runtime (including future minimal ACP-only
ones) to implement file IO, which is exactly the over-coupling §3 warns against. A
separate optional interface lets the desktop host expose file ops (it always can — it
owns the filesystem) while a remote/ACP runtime can decline or proxy.

**Decision 2 — What does "workspace" mean? Is the desktop's `base` concept on the
interface?**

Recommended: **the interface knows only one root — the runtime's current working
directory.** The desktop's `base` concept (the `~/Documents/OpenScience` projects root,
used by `listProjects`/`createProject`/`importProject`) is a *host-app* concern, not a
runtime concern. It stays in Tauri commands, reachable directly, exactly as today. The
`WorkspaceOps` interface corresponds only to what a runtime-scoped agent can see: its
own working folder.

This split is clean: file *provenance* (writes observable through runtime events) and
workspace *browsing* (reads through `WorkspaceOps`) both live on the seam; project-level
concerns (the `base` directory, project listing, pinning) stay on the host.

### 4.3 The desktop implementation is a thin adapter, not a new engine

Today's `OpenCodeClient` doesn't touch files — all file ops go from React →
`lib/tauri.ts` → Tauri commands (`artifact_file.rs`). Under this proposal,
`OpenCodeClient implements WorkspaceOps` by forwarding each method to the corresponding
Tauri command via `invoke()`. No Rust changes; no new transport engine; the existing
commands and the existing 25 MB preview cap (etc.) keep working unchanged.

This is the cheapest possible realization of the seam, and it's also the right one: the
desktop host *is* the filesystem owner, so the desktop runtime is the natural place to
expose it. A future remote runtime would implement `WorkspaceOps` by forwarding over its
transport (HTTP for the gateway, ACP for a remote agent) — which is exactly the
unification v0.4/v0.5 need.

### 4.4 Why this is in the same RFC as the def+transport refactor

File ops and the def+transport refactor look unrelated, but they answer the same
question: **what belongs on the runtime seam?** The def+transport refactor (§3) shrinks
the per-runtime cost by pulling protocol dialect *out* of per-runtime code. The
`WorkspaceOps` addition (§4) grows the seam's surface by putting file operations *on*
it. Doing only one leaves the v0.4 gateway half-built: def+transport without
`WorkspaceOps` can proxy prompts to any agent but can't browse files; `WorkspaceOps`
without def+transport exposes files but the gateway still speaks only OpenCode.

Doing both in one architectural arc is what makes the v0.4 "one authenticated API
gateway" deliverable a single coherent thing rather than two stitched-together halves.

## 5. Proposed amendments to the existing RFCs

This RFC amends — does not replace — `agent-runtime.md` and `multi-agent-acp.md`. Each
amendment is a delta against the merged/proposed text, scoped so it can be accepted or
rejected independently.

### 5.1 Amendment to `agent-runtime.md` — Phase 2 redefined

**Current text** (Phase 2, `agent-runtime.md` Phased rollout): land a second runtime
against the `AgentRuntime` interface to validate the seam. `CodexRuntime` (#28) is the
prototype.

**Proposed change.** Reframe Phase 2 as **"refactor `OpenCodeClient` into a `RuntimeDef`
+ shared transport engine"** rather than "add a second runtime." The validation goal is
the same (prove the seam is real by exercising it from a non-OpenCode runtime), but the
*order* reverses:

- **Old Phase 2:** add `CodexRuntime` → exposes seam friction → refactor.
- **New Phase 2:** refactor OpenCode into def+engine → *then* add the second runtime as a
  thin def, so the friction is never shipped.

**Rationale.** #28's current prototype already demonstrates the friction: hundreds of
lines re-implementing lifecycle/session/event-stream methods against the interface, most
of which are byte-for-byte identical to `OpenCodeClient` apart from the protocol dialect.
Landing it as-is would ship a second copy of the cost. Refactoring first means the
second runtime lands as a ~50-line def, which is the entire point of having a seam.

**What stays.** Phase 1 (`AgentRuntime` interface, `BaseAgentRuntime` plumbing — #24,
#36) stays as merged. The interface itself is not removed in this RFC; it becomes the
*consumer-facing* contract (what the UI/store holds) while the def+engine layer is the
*producer-facing* contract (what runtime authors write). The two can coexist during
transition: `OpenCodeClient implements AgentRuntime` today, and can be re-expressed as
`{ def, engine }.implements(AgentRuntime)` later without breaking the store.

### 5.2 Amendment to `multi-agent-acp.md` — ACP-first, now with precedent

**Current text** (`multi-agent-acp.md` TL;DR + §"Why ACP, not per-agent adapters"):
argues for ACP on theoretical grounds — turns "support agent X" into "configure a stdio
command" — but acknowledges the proposal has no production precedent yet.

**Proposed change.** Strengthen the argument by citing open-design as production
precedent (§2 of this RFC), and adopt its convergence conclusion explicitly: **ACP
becomes the preferred transport for new runtimes; per-CLI stream parsers
(claude-stream-json, codex-stream-json, etc.) are accepted only for incumbents that
pre-date stable ACP, and are deprecated once the agent ships a stable ACP mode.**

Concretely, this changes one open question in `multi-agent-acp.md`. The original asks
"do we need per-agent adapters at all?" The amended answer: **no for new agents; yes,
temporarily, for Claude/Codex/Cursor-class incumbents that don't yet expose stable
ACP.** open-design's `ab4532412` commit (retiring Gemini CLI runtime in favor of Kimi
ACP) is the model: when an agent's ACP mode matures, the bespoke parser is retired.

**What stays.** The core architecture proposed in `multi-agent-acp.md` — `AcpRuntime` as
a transport, OpenCode staying as bundled default, ACP not replacing anything — stays
exactly as proposed. The amendment only adds evidence and sharpens the deprecation
policy.

### 5.3 No amendment to the safety/privacy RFC layer

The `AgentRuntime` seam's safety properties (workspace-only access, approval-gated
dangerous commands, keychain-only secrets — `AGENTS.md` Safety defaults) are orthogonal
to the def-vs-class and transport questions. **No change.** A `RuntimeDef` is subject to
the same approval/scoping rules as `OpenCodeClient` is today; an ACP transport is
subject to the same network/secret rules as the HTTP transport. This is called out
explicitly so reviewers don't read "new transport" as "new attack surface" — it isn't.

### 5.4 Summary of amendments

| RFC                     | Change                                                                               | Status after this RFC                                                |
| ----------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `agent-runtime.md` Phase 2 | "Add 2nd runtime" → "Refactor OpenCode into def+engine, then add 2nd runtime as def" | Phase 1 merged; Phase 2 redefined; Phase 3 folded into Phase 2       |
| `multi-agent-acp.md`    | Add open-design precedent; adopt ACP-first + deprecation policy for bespoke parsers  | Proposal, strengthened                                               |
| Safety/privacy layer    | None                                                                                 | Unchanged                                                            |

## 6. Phased rollout (each step independently mergeable)

This is a sketch of how the amendments could land as a sequence of PRs. Each step is
independently mergeable and behavior-preserving unless noted. Nothing here is
binding — the goal of this RFC is to agree on §3–§5; the rollout order is itself an open
question (§7.4).

### Step 1 — `WorkspaceOps` on the seam (small, low-risk)

- Define `interface WorkspaceOps` in `packages/sdk/src/`.
- `OpenCodeClient implements WorkspaceOps` by forwarding to the existing Tauri commands
  via `invoke()`. No Rust changes.
- Migrate one or two React call sites (e.g. `FilesPage.tsx`'s `listDir`, `readArtifact`)
  to go through the seam instead of `lib/tauri.ts` directly. The rest migrate
  opportunistically.
- **Net effect:** the seam now covers file operations. The v0.4 gateway can proxy file
  browsing from day one. No user-visible change.

### Step 2 — `RuntimeDef` + `OpenCodeHttpEngine` refactor (structural, behavior-preserving)

- Introduce `RuntimeDef` (data struct) and an `OpenCodeHttpEngine` that consumes it.
- Re-express `OpenCodeClient` as `{ opencodeDef, engine }` that still `implements
  AgentRuntime`. Store contract (`client: AgentRuntime`) is unchanged.
- No new runtime, no new transport. Pure refactor in the spirit of #36.
- **Net effect:** the per-runtime "what's different about this one" lives in a data
  record; the shared "how to talk HTTP+SSE to an OpenCode-class runtime" lives in an
  engine. `CodexRuntime` (#28) is **set aside** at this step (see §5.1) — its useful
  residue is the friction inventory that motivates the refactor.

### Step 3 — ACP transport engine (the v0.5 cornerstone)

- Implement an `AcpStdioEngine` covering the subset of ACP we need (`initialize` /
  `session/new` / `session/load` / `session/set_model` / `session/prompt` /
  `session/cancel`).
- A minimal ACP runtime def (e.g. for a `zcode` or `pi` CLI available in our test
  environments) lands as a ~30-line def consumed by the engine. This is the validation
  that `multi-agent-acp.md`'s thesis holds on our seam.
- Reference: open-design's `acp.ts` for the protocol shape; we implement a subset, not a
  port.
- **Net effect:** Open Science Desktop can run a second agent through the same UI. No
  OpenCode code path changed.

### Step 4 — Northbound API gateway (the v0.4 deliverable, now unlocked)

- A loopback-bound, bearer-token-authenticated HTTP+SSE server that exposes
  `AgentRuntime` + `WorkspaceOps` to non-desktop clients.
- LAN web UI, CLI client, and messaging integrations become thin clients of this one
  gateway. Each is a separate deliverable; the gateway is the foundation.
- **Net effect:** the PRD §v0.4 "one authenticated API gateway" deliverable becomes one
  coherent thing, not a per-surface re-implementation.

Steps 1 and 2 are tightly scoped and independently mergeable. Steps 3 and 4 are larger
and may themselves decompose; this RFC does not commit to their internal ordering.

## 7. Open questions (what I want from discussion)

These are the questions I genuinely don't have a settled answer to. The point of
circulating this RFC is to resolve them in public, not to advocate a position.

### 7.1 Is the def-vs-class shift worth the refactor cost?

open-design's evidence is strong, but they also have ~5,000 lines of shared engines to
amortize the pattern over. We have one runtime today. Is the def+engine refactor (Step 2)
worth doing *before* a second runtime forces it, or should we wait until ACP (Step 3)
makes the cost structure concrete? My weak preference is "do it first, so the second
runtime lands cheap," but I want pushback.

### 7.2 `WorkspaceOps` — separate interface, or merged into `AgentRuntime`?

§4.2 recommends separate. The counter-argument: with only one runtime today, merging is
simpler and we can always split later (YAGNI in the other direction). Which bias is
right for us?

### 7.3 The `base` vs `workspace` boundary

§4.2 puts `base` (the projects root) firmly on the host-app side, off the seam. Is there
a v0.4/v0.5 scenario where a non-desktop client (the LAN UI, the CLI) needs to list or
manage projects — and if so, does that pull `base` onto the seam after all?

### 7.4 Rollout ordering

§6 sketches Steps 1→4. Is that the right order? In particular:

- Does `WorkspaceOps` (Step 1) make sense to land *before* the def refactor (Step 2), or
  should we wait until the seam's shape has settled?
- Should the ACP engine (Step 3) precede the gateway (Step 4), or is the gateway better
  built against the OpenCode-only seam first and broadened later?

### 7.5 Does `CodexRuntime` (#28) get withdrawn?

§5.1 implies yes — its value is the friction inventory, not the code. But the work in #28
is real and the conversation there may want to preserve a path forward. Should #28 be
formally closed in favor of Step 2 + Step 3, or kept open as a reference implementation
that the refactor must subsume?

### 7.6 ACP engine — port a subset of open-design's `acp.ts`, or implement from spec?

open-design's `acp.ts` is 1,744 lines and handles many agents we don't need. The
[ACP spec](https://agentclientprotocol.com/) is the canonical source. For Step 3, do we
implement from spec (cleaner, smaller, more work) or adapt open-design's MIT-licensed
code (faster, carries patterns we may not want)?

### 7.7 Naming

`RuntimeDef` / `streamFormat` / `WorkspaceOps` are placeholder names borrowed or adapted
from open-design. They may collide with existing concepts or read oddly in our
codebase. Open to better names.

## 8. Alternatives considered

### 8.1 Status quo: ship #28 as-is, leave the seam class-based

Rejected. #28 demonstrates the per-runtime cost is too high to repeat for a third or
fourth runtime, and the def+engine refactor is independently useful (it shrinks
`OpenCodeClient`'s surface even with zero additional runtimes).

### 8.2 Full port of open-design's runtime layer

Rejected. open-design's ~11,000-line runtime layer is sized for 24 agents and a
spawn-per-turn model. We have different constraints (sidecar model, provenance seam,
smaller agent surface in the medium term). We borrow the *patterns*, not the codebase.

### 8.3 Defer everything until v0.4 forces a decision

Rejected. The v0.4 northbound gateway is blocked on `WorkspaceOps` (§4.1), and its design
quality depends on whether the seam's shape has settled. Letting v0.4 retrofit the seam
under deadline pressure is how seams get carved up into per-feature shortcuts.

### 8.4 Make `WorkspaceOps` a Tauri-only concern, not a seam concern

Rejected. This preserves the status quo and gives the v0.4 gateway no choice but to
build a second, parallel path for file operations alongside `AgentRuntime` — the exact
split the seam was meant to prevent.

## 9. References

- Prior RFCs: [`agent-runtime.md`](./agent-runtime.md), [`multi-agent-acp.md`](./multi-agent-acp.md).
- Merged PRs: [#24](https://github.com/ai4s-research/open-science/pull/24) (AgentRuntime
  interface), [#36](https://github.com/ai4s-research/open-science/pull/36)
  (BaseAgentRuntime).
- Open PR: [#28](https://github.com/ai4s-research/open-science/pull/28) (CodexRuntime
  prototype — this RFC proposes withdrawing it; see §7.5).
- External: [open-design](https://github.com/nexu-io/open-design) v0.10.0 (MIT); the
  [Agent Client Protocol](https://agentclientprotocol.com/) spec.
- Internal: `packages/sdk/src/runtime.ts`, `packages/sdk/src/base-runtime.ts`,
  `packages/sdk/src/OpenCodeClient.ts`, `apps/desktop/src-tauri/src/artifact_file.rs`,
  `docs/PRD.md` §v0.4 / §v0.5.
