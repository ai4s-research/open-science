# AI4S Workbench Desktop — Technical Design

> **Implementation status (v0.1, 2026-07-02).** Built and verified: Tauri 2 shell + React
> UI; **OpenCode** bundled as an isolated sidecar (auto-started, app-private config/data,
> dedicated port); `OpenCodeClient` over HTTP + SSE; real multi-session chat with history;
> Skills page backed by OpenCode's real skills/agents; macOS `.dmg`; cross-platform CI.
> Planned (not yet built): self-authored scientific skills, MCP connectors, provenance/
> reviewer engine, literature search, Jupyter runtime, remote compute. This document is the
> target design; sections mixing built vs planned are noted inline.

## 1. Technical goals

A high-performance, open-source research workbench with macOS / Windows installers.
Design priorities: fast startup; smooth UI; simple install; replaceable agent runtime;
local and sandboxed execution; MCP / skills / workflow support; artifact provenance;
extensibility to Jupyter, HPC, Modal, Docker, and remote servers.

## 2. Overall architecture

```text
AI4S Workbench Desktop
├── Desktop Shell: Tauri 2
├── Frontend: React + TypeScript + Vite
├── UI System: Tailwind CSS + Radix UI / shadcn-style components
├── Local Service: Rust commands + bundled OpenCode sidecar
├── Agent Runtime: OpenCode (bundled single-binary sidecar)
├── Agent Protocol: OpenCode HTTP + SSE API (opencode serve)
├── Skills Layer: OpenCode skills/agents + optional third-party scientific skills
├── MCP Layer: filesystem / paper-search / BioMCP / Zotero / GitHub / custom
├── Execution Layer: OpenCode agents/tools + optional Jupyter Kernel Gateway
├── Storage: Local workspace + SQLite + JSONL provenance
└── Packaging: Tauri DMG / APP / NSIS / MSI
```

## 3. Tauri over Electron

### 3.1 Recommendation

v1 uses **Tauri 2 + React + TypeScript + Vite**. Not Electron.

Reasons: Tauri is lighter with smaller installers; it uses the OS-native WebView,
suited to tool-type desktop apps; it is cross-platform (macOS / Windows / Linux); it
allows any frontend framework; and a Rust backend is well-suited to local files,
security, process management, and sidecar orchestration. Tauri positions itself around
small, fast, secure cross-platform apps built from a single codebase.

### 3.2 When Electron might fit

If later needs arise — complex browser capabilities, a more mature desktop ecosystem,
identical embedded Chromium behavior, or many native Node.js modules — Electron could be
reconsidered. But AI4S Workbench's core is the workbench, files, agent, runtime, and
artifacts, which do not need Chromium-level capabilities, so Tauri fits better.

## 4. Frontend

### 4.1 Stack

React · TypeScript · Vite · Tailwind CSS · Radix UI · TanStack Query · Zustand ·
React Router · Monaco Editor · Markdown renderer · ECharts / Plotly / Observable Plot.

### 4.2 Module layout

```text
src/
  app/{routes,layout,providers}
  components/{sidebar,topbar,command-palette,cards,artifact-viewer,
             approval-dialog,tool-call-card,code-viewer,markdown-viewer}
  features/{onboarding,projects,chat,agent-runtime,literature,artifacts,
            provenance,review,skills,settings}
  lib/{api,events,store,theme}
```

### 4.3 UI performance strategy

Streaming chat render; virtualized log lists; lazy file tree; paginated CSV; chunked
large-Markdown render; on-demand figures; cached artifact previews; a unified agent
event bus; all heavy work off to sidecar / worker; the Tauri main process does system
capabilities only, not heavy computation.

## 5. Agent runtime

### 5.1 Choice: OpenCode (bundled)

The agent runtime is **OpenCode** (`anomalyco/opencode`, MIT), pinned to a stable
release (`OPENCODE_VERSION`, currently 1.18.12). It is distributed as a **single
binary**, which makes it ideal to bundle as a desktop sidecar — no Python/Node runtime
to package. It supports MCP, skills, and agents, is model-agnostic (BYOK), and serves as
an open-source coding/agent runtime in the spirit of Claude Code.

OpenCode exposes an HTTP + SSE server (`opencode serve`) that a GUI can drive directly —
sessions, prompts, streaming assistant/tool output, skills, and agents.

### 5.2 Desktop ↔ OpenCode communication

The app talks to OpenCode over its HTTP + SSE API, wrapped by `packages/sdk`
(`OpenCodeClient`). Key endpoints:

| Endpoint | Use |
| --- | --- |
| `POST /session` · `GET /session` | Create / list sessions (conversation history) |
| `GET /session/:id/message` | Load a session's history |
| `POST /session/:id/prompt_async` | Send a prompt |
| `GET /event` (SSE) | Stream `message.part.updated` (text/tool), `session.idle`, `session.error` |
| `GET /api/skill` · `GET /agent` | Real loaded skills / agents |

Flow:

```text
App launch → Rust starts the bundled `opencode serve` (dedicated free port)
↓
OpenCodeClient opens GET /event (SSE) and creates/loads sessions
↓
Prompt → POST /session/:id/prompt_async
↓
SSE streams message.part.updated / session.idle → folded into thread blocks by part/call id
↓
Frontend renders streaming messages, tool cards, and per-session history
```

### 5.3 Bundling & isolation (no interference)

OpenCode is bundled as a Tauri **sidecar** (`externalBin`, one binary per target triple,
git-ignored and fetched by `scripts/dev/fetch-opencode.sh`). The Rust side
(`src-tauri/src/runtime.rs`) starts it so it never collides with a user's own OpenCode:

- runs the **bundled** binary (not the user's `PATH`);
- on a **dedicated free port** (not the default 4096);
- with an **app-private** config/data dir via `XDG_CONFIG_HOME`/`XDG_DATA_HOME` under
  `~/Library/Application Support/com.ai4s.workbench/runtime/` (macOS) — so the user's
  sessions/config are never touched;
- but it **shares the user's login**: the user's `auth.json` (OpenCode credentials / free
  access) is copied read-only into the sandbox at startup, so the bundled runtime can
  reply out of the box without a separate login. We only read the user's auth file; we
  never modify it or their sessions.
- killed on app exit.

The user's model provider key (entered in Settings) is written into that app-private
`opencode.json` by the `configure_opencode` Rust command, and the sidecar is restarted
to pick it up. Keys never enter the user's global OpenCode config, logs, or git.

## 6. Skills & MCP

### 6.1 Skill layering

```text
skills/
  core/      # reproducible-research, literature-review, figure-provenance,
             # citation-reviewer, paper-to-report
  external/  # K-Dense scientific-agent-skills
  user/      # custom skills
```

### 6.2 v1 built-in skills

| Skill | Purpose |
| --- | --- |
| `reproducible-research` | Standardize project structure, artifacts, logs, reproducibility |
| `literature-review` | Search, filter, summarize literature |
| `bibliometric-analysis` | Year trends, keywords, journal distribution, clustering |
| `figure-provenance` | Figures must trace to code and data |
| `citation-reviewer` | Check citation format and sources |
| `paper-to-report` | Generate a Markdown report |

### 6.3 Third-party skills

`K-Dense-AI/scientific-agent-skills` (large set; compatible with Cursor, Claude Code,
Codex, OpenCode) can be added later. Do **not** enable all ~148 skills by default: use
curated install, enable by domain, and show license, dependencies, and risk. (Curated
third-party install is a later feature; today the Skills page lists the real skills
OpenCode has loaded — built-in + project `.opencode/skill/` + user config.)

### 6.4 MCP servers

First batch: `filesystem` (project files), `paper-search-mcp` (literature), `BioMCP`
(biomedical databases), `Zotero MCP` (library), `GitHub MCP` (repos/issues/releases),
`local runtime MCP` (execution status). v1 ships filesystem + paper search first;
BioMCP and Zotero follow.

## 7. Execution layer

```text
Execution Layer
├── OpenCode tools (local, in the bundled runtime)
├── Docker sandbox            (optional, advanced)
├── SSH / Modal remote        (optional, advanced — later)
└── Jupyter Kernel Gateway    (later)
```

OpenCode executes its tools locally within the bundled runtime, gated by its permission
system. Heavier/remote execution (Docker sandbox, SSH, Modal) is optional and belongs in
an advanced "Remote Compute" area, never the default path.

**v1 default:** local execution + manual approval for high-risk actions. Do not
hard-depend on Docker Desktop or WSL in v1 — that raises the install barrier and is not
consumer-grade.

**v0.3 Jupyter Kernel Gateway** for a more notebook-like experience:

```text
Desktop App → Local Runtime Manager → Jupyter Kernel Gateway → Python / R kernel
→ stream output / figures / tables
```

Jupyter Kernel Gateway is a headless Jupyter kernel server addressable over REST /
WebSocket.

## 8. Local Runtime Manager

### 8.1 Why

The installer should not bundle every scientific dependency (huge installer, slow
updates, cross-platform pain, dependency conflicts, hard debugging). Instead: a
lightweight installer + a first-launch Runtime Manager + on-demand scientific env.

### 8.2 Responsibilities

Detect OpenCode; detect Python / uv / Node / Git; create the workspace; create isolated
environments; install base Python packages; manage scientific tool dependencies; start
the OpenCode server; start an optional Jupyter Gateway; monitor runtime health.

### 8.3 Runtime directory

```text
~/.ai4s-workbench/
  config/  runtime/{opencode,python,node}/  profiles/ai4s-workbench/
  workspaces/  logs/  cache/  secrets/
```

Windows: `%APPDATA%/AI4S Workbench/` · macOS: `~/Library/Application Support/AI4S Workbench/`

## 9. Storage

### 9.1 Project structure

```text
workspace/
  project.json  plan.md
  data/{raw,processed}/  papers/  parsed/  scripts/  notebooks/
  figures/  reports/  artifacts/  reviews/
  provenance.jsonl  manifest.json
```

### 9.2 SQLite

Stores: project list, session index, artifact index, literature metadata index,
tool-call state, user settings, runtime state.

### 9.3 JSONL

`provenance.jsonl` is an append-only execution record — easy to read, diff, recover,
export, and open-source friendly.

## 10. Artifact provenance

### 10.1 Manifest

```json
{
  "project_id": "bci-trends",
  "created_at": "",
  "artifacts": [
    {
      "id": "fig_year_trend",
      "type": "figure",
      "path": "figures/year_trend.png",
      "created_by_step": "step_004",
      "input_files": ["data/processed/corpus.csv"],
      "code_files": ["scripts/analyze.py"],
      "status": "reviewed"
    }
  ]
}
```

### 10.2 Provenance event

```json
{
  "event_id": "evt_001",
  "step_id": "step_004",
  "type": "code_execution",
  "tool": "python",
  "command": "python scripts/analyze.py",
  "input_files": ["data/processed/corpus.csv"],
  "output_files": ["figures/year_trend.png"],
  "started_at": "",
  "finished_at": "",
  "status": "success"
}
```

### 10.3 Reviewer rules (v1, deterministic)

Artifact exists; output is recorded in provenance; figure has a code file; table has
source data; report includes limitations; citation has a recognizable ID; script can
be re-run.

## 11. Security

### 11.1 Default permissions

The agent may only access the current workspace; command execution requires approval;
it cannot delete files outside the workspace; it cannot read the whole Home directory;
it cannot auto-upload files; it cannot silently install dependencies.

### 11.2 Approval levels

| Action | Default |
| --- | --- |
| Read current project files | Allow |
| Write current project files | Allow (shown) |
| Overwrite file | Ask |
| Delete file | Require approval |
| Shell command | Require approval |
| Install dependency | Require approval |
| Network access | First-time approval |
| Connect remote server | Require approval |
| Access files outside workspace | Require approval |

OpenCode has a per-tool permission system (allow / ask / deny per agent). The desktop
maps high-risk actions to "ask" and must never blanket-allow them.

### 11.3 API keys

Stored in macOS Keychain / Windows Credential Manager (fallback: encrypted local
secrets). Never enter provenance, logs, crash reports, git, or exported projects.

## 12. Packaging & release

### 12.1 macOS

Outputs: `AI4S-Workbench-aarch64.dmg`, `AI4S-Workbench-x64.dmg`,
`AI4S-Workbench-universal.dmg` (later). Code signing / notarization needs an Apple
Developer account; a free account cannot notarize, so users may still see an
"unverified" prompt.

### 12.2 Windows

Outputs: `AI4S-Workbench-Setup.exe`, `AI4S-Workbench.msi` (later). Prefer the NSIS
`Setup.exe` in v1 for a familiar install experience. Unsigned apps run but may trigger
SmartScreen; formal release needs a code-signing certificate (EV certs earn SmartScreen
reputation faster). Early GitHub Release preview builds may be unsigned, but the README
must say so.

### 12.3 Auto update

Tauri updater with GitHub Releases + `latest.json` + a Tauri updater signature (update
packages must be signed; signature verification cannot be disabled). v0.1 no forced
auto-update; v0.2 adds a GitHub Releases updater; v0.3 adds in-app update prompts.

### 12.4 CI/CD

GitHub Actions build matrix:

```yaml
macos-latest:
  - aarch64-apple-darwin
  - x86_64-apple-darwin
windows-latest:
  - x86_64-pc-windows-msvc
```

The official Tauri GitHub Action builds native binaries for macOS / Linux / Windows and
uploads to a GitHub Release.

## 13. Process model

### 13.1 Startup

```text
User opens app → Tauri starts → Frontend loads → Runtime Manager checks dependencies
→ Start OpenCode sidecar → Connect to Gateway → Load projects → Ready
```

### 13.2 Agent task

```text
User submits task → Frontend sends prompt to OpenCode → OpenCode plans
→ Frontend renders plan approval card → User approves → OpenCode executes tools
→ Tool events stream back → Runtime writes artifacts → Provenance service records events
→ Reviewer runs checks → Frontend updates artifact/review panels
```

## 14. High-performance design

### 14.1 UI

Layered state: UI state in Zustand, server/runtime state in TanStack Query, streaming
events in an event bus. Big-data optimizations: paginated CSV preview, virtualized log
viewer, lazy Markdown render, lazy artifact load. Render optimizations: memoized
tool-call cards, batched message chunks, `requestAnimationFrame` batching, background
task workers.

### 14.2 Runtime

Persistent OpenCode server; reused project sessions; incremental file index; artifact
hash cache; per-project reused Python env; literature metadata cache; cached PDF parse
results; figure preview thumbnails.

### 14.3 Startup targets

```text
App UI cold start: < 3s
Runtime ready: < 10s
First agent response: < 5s after runtime ready
```

Strategy: UI first, runtime after; show runtime-loading state on Home; a failed OpenCode
connection must not block the UI; first-time dependency install happens in onboarding.

## 15. Error handling

### 15.1 Runtime errors

OpenCode not started; Gateway start failure; port in use; missing API key; model
connection failure; workspace permission denied; broken Python env; Docker unavailable;
MCP server start failure. Each must provide: a human-readable explanation, collapsible
technical details, a one-click fix button, and a copy-logs button.

### 15.2 Agent errors

Tool-call failure; literature source rate-limited; dependency install failure; code run
failure; file permission failure; citation check failure. Must show: the failed step,
the cause, a fallback suggestion, a retry button, and an edit-plan button.

## 16. Repository structure

Monorepo:

```text
ai4s-workbench/
  apps/desktop/{src,src-tauri}/
  packages/{ui,shared,sdk}/
  runtime/{manager,opencode-profile,mcp,skills}/
  docs/{PRD.md,TECHNICAL_DESIGN.md}
  examples/bci-trends/
  scripts/{release,dev}/     # dev/fetch-opencode.sh fetches the pinned sidecar
```

- `apps/desktop` — Tauri + React desktop app; `src-tauri/src/runtime.rs` supervises the
  bundled OpenCode sidecar (`OpenCodeClient` lives in `packages/sdk`).
- `runtime/manager` — local runtime manager (detect deps, workspace, provenance, logs).
- `runtime/opencode-profile` — the AI4S Workbench OpenCode config/skills bundle.
- `runtime/skills` — self-authored scientific skills.
- `examples` — the complete demo project.

## 17. v0.1 task breakdown

### 17.1 Day-one goals

1. Init Tauri + React.
2. Build the main layout.
3. Build a static onboarding page.
4. Build a static project workspace page.
5. Build tool-call card / artifact card / approval dialog.
6. Bundle + auto-start OpenCode; connect via `OpenCodeClient` (HTTP + SSE).
7. Ship the OpenCode config/skills bundle.
8. Write the 3 core skills.
9. Build static artifacts for the BCI demo.
10. Draft the GitHub Actions build.

### 17.2 v0.1 must deliver

macOS app runs; Windows app runs; README has screenshots; a complete demo; API key
config; open a workspace; a bundled OpenCode the app auto-starts and drives (sessions,
streaming, history, skills); show plan / tool / artifact / review; export `report.md`.

## 18. Technical risks

### 18.1 OpenCode desktop integration

Risk: OpenCode API changes across versions. Mitigation: wrap `OpenCodeClient`; never call
OpenCode directly from the UI; **pin the OpenCode version** (`OPENCODE_VERSION`); bundle
the pinned binary so the app is not affected by the user's own OpenCode.

### 18.2 Windows environment complexity

Risk: WebView2, permissions, Defender, SmartScreen, PATH, missing Python / Git / Node.
Mitigation: the Runtime Manager detects the environment; do not hard-depend on system
Python early; provide a portable fallback; code-sign for formal releases.

### 18.3 Installer size

Risk: bundling a large runtime and scientific packages makes the installer huge.
Mitigation: OpenCode is a single ~44 MB-installer sidecar (cheap to bundle); keep the app
body light; install heavy scientific dependencies on demand as optional Science Packs;
defer Docker / Jupyter.

### 18.4 Agent safety

Risk: the agent runs commands, reads/writes files, accesses the network. Mitigation:
manual approval by default; workspace allowlist; isolated local secrets; dangerous-
command dialogs; optional Docker sandbox; full provenance recording.

## 19. Final stack

```text
Tauri 2
React + TypeScript + Vite
Tailwind + Radix UI
OpenCode as agent runtime (bundled single-binary sidecar, pinned OPENCODE_VERSION)
OpenCode HTTP + SSE API via OpenCodeClient (packages/sdk)
OpenCode skills/agents + optional third-party scientific skills
Local workspace + SQLite + JSONL provenance
DMG / NSIS / MSI installers via GitHub Actions
GitHub Releases (self-contained; sidecar fetched at build time)
```

One line:

**Use Tauri for a high-performance modern desktop shell, a bundled+isolated OpenCode as
the Claude Code alternative layer, scientific skills and MCP as the research capability
layer, and provenance/reviewer as the real moat of an open-source Claude Science alternative.**
