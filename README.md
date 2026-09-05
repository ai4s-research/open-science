<div align="center">

[![Open Science Desktop — Local-first AI research workbench](./docs/assets/banner.webp)](https://github.com/ai4s-research/open-science)

# Open Science Desktop

**Local-first, model-agnostic AI research workbench for macOS, Windows & Linux.**

Formerly Open Science. An open-source desktop alternative to Claude Science and
similar AI-for-science workbenches — built with Tauri, MCP, agent skills, and
reproducible artifacts. It connects agents, notebooks, files, figures, reports,
runs, and review into one auditable desktop workflow.

<p>
  <b>English</b> ·
  <a href="./README.zh.md">简体中文</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.es.md">Español</a> ·
  <a href="./README.de.md">Deutsch</a> ·
  <a href="./README.fr.md">Français</a> ·
  <a href="./README.ko.md">한국어</a>
</p>

<p>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://doi.org/10.5281/zenodo.21351225"><img src="https://img.shields.io/badge/DOI-10.5281%2Fzenodo.21351225-1682D4" alt="DOI"></a>
  <a href="https://internscience.github.io/ResearchClawBench-Home/"><img src="https://img.shields.io/badge/%F0%9F%8F%86%20%231-ResearchClawBench-FFB300" alt="#1 on ResearchClawBench"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue" alt="Platforms">
  <img src="https://img.shields.io/badge/i18n-7%20languages-5B8DEF" alt="7 interface languages">
  <img src="https://img.shields.io/badge/built%20with-Tauri%202%20%2B%20React-24C8DB" alt="Built with Tauri + React">
  <img src="https://img.shields.io/badge/runtime-OpenCode-success" alt="OpenCode runtime">
  <a href="https://discord.gg/fWNMDKcd5P"><img src="https://img.shields.io/badge/Join-Discord-5865F2" alt="Join Discord"></a>
  <a href="http://makeapullrequest.com"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome"></a>
  <a href="https://linux.do"><img src="https://img.shields.io/badge/Join-linux.do-orange" alt="linux.do"></a>
</p>

</div>

---

## News

- **2026-08-18** — 🖥️ **Runs without a screen, and the terminal command comes with it.** `osd server` starts the whole workbench — workspace, agent runtime, and the *same* web UI — on a machine with no display, and `osd session send … --wait` drives it from a script or another agent. `osd` ships inside the desktop installer and puts itself on your PATH on first launch; on a server the archive needs nothing installed. Models, keys and approvals are all configurable from the terminal (`osd model`, `osd auth`, `osd approval`).
- **2026-08-13** — 🔌 **Speaks the Agent Client Protocol, both directions.** Drive Codex, Gemini CLI, Claude Code, or any other ACP agent from inside this app — with its own models, history, and your MCP connectors — or drive Open Science itself from Zed, JetBrains, or Neovim. *(v0.4.0)*
- **2026-08-01** — 🗂️ **Projects, memory, and full history.** Group sessions into named projects (import an existing repo *in place*, no copying), give the agent persistent global and project memory, and reach every past conversation through a searchable history with archive, restore, and export. *(v0.3.1)*
- **2026-07-24** — 🪟 **Split-pane tiling.** Tile sessions side by side, drag panes to re-dock them, keep several independent Screens, and run a different model in each pane. *(v0.3.0)*
- **2026-07-21** — 🌐 **Access from anywhere — even your phone.** A token-authenticated gateway serves the *real* desktop UI to a CLI, a browser on your LAN, or your phone (loopback by default; LAN is opt-in). Start a run at your desk and read the finished figure and report on your phone. *(v0.2.3)*
- **2026-07-21** — 🧭 **Browser control.** The agent can drive your own Chrome — profile and logins intact — to read the live web the way you do, or an isolated private browser on demand. *(v0.2.3)*
- **2026-07-09** — 🎉 **#1 on ResearchClawBench.** Open Science Desktop ranks #1 by scored-task average on [ResearchClawBench](https://internscience.github.io/ResearchClawBench-Home/), an end-to-end benchmark for autonomous scientific research agents (Pass@1 leaderboard).

---

## Contents

- [✨ What it does](#what-it-does)
- [🎬 See it in action](#see-it-in-action)
- [🧪 Current capabilities](#current-capabilities)
- [🔌 Skills and connectors](#skills-and-connectors)
- [📦 Install](#install)
- [🖥️ Headless & CLI (`osd`)](#headless--cli-osd)
- [🚀 Build from source](#build-from-source)
- [🔒 Safety and privacy](#safety-and-privacy)
- [🗂️ Repository layout](#repository-layout)
- [📌 Status](#status)
- [🤝 Contributing](#contributing)
- [📖 Citation](#citation)
- [⚖️ License](#license)

## What it does

**Runs the whole research loop** — from a broad direction to a finished paper:
exploration, literature survey, hypothesis, experiment code, analysis, figures, and
write-up, in one continuous, auditable session.

- **Autonomous research agents** — the bundled `ai4s-agent` chains specialist skills
  end to end (explore → survey → experiment → write), and each stage drops a real,
  inspectable artifact into your workspace, not just a chat reply.
- **Everything traces back** — figures, tables, reports, notebooks, and run outputs
  link to the exact code, inputs, environment, model output, and conversation that
  produced them.
- **Local-first and yours** — sessions, data, provenance, notebooks, and run records
  live in local folders on your machine. Nothing leaves by default.
- **Model-agnostic runtime** — the UI talks through `packages/sdk` to a bundled,
  pinned OpenCode sidecar. Bring your own model; providers, skills, and MCP servers
  stay pluggable.
- **Reproducible by construction** — local, SSH/Slurm, Modal, and notebook-batch runs
  are captured as reproducible run records, not loose terminal scrollback.
- **Reach it from anywhere** — a built-in, token-authenticated gateway serves the
  *real* desktop UI to a browser on your LAN or phone (or, with a tunnel, from
  anywhere) — kick off a run at your desk and check on it from your phone over lunch.
  Off by default; loopback-only until you opt in, and API keys never leave the machine.
- **Drives your own browser** — the agent can control your real Chrome, with your
  profile and logins intact, to read the live web the way you do — or an isolated
  private browser when you'd rather it not.
- **Plan before it acts** — `/plan` lays out an execution plan before touching a
  file, and `/goal` fixes the objective, constraints, and acceptance criteria the
  agent then works toward.
- **Built for long projects** — named projects group their sessions, two layers of
  persistent memory (global and per-project) carry what matters between them, and a
  long conversation compacts itself as it approaches the model's context window.
- **Work several threads at once** — tile panes side by side, keep independent
  Screens, and give each pane its own model.
- **Extensible** — agent skills, MCP servers and one-click science connectors,
  `/` commands, `!` shell mode, and a model-agnostic SDK.

## See it in action

**One prompt -> a publication-grade figure, and every point traces to the exact code
and inputs that made it.** No black boxes: open any artifact to see its generating
script, its data files, and the conversation that produced it.

![A rendered cross-species atlas figure beside its generating script and input files in the artifact inspector](./docs/assets/showcase-provenance.webp)

**Literature -> a verifiable report.** Fan the search out across sources, draft a
manuscript rendered as a PDF, and gate it on a citation review — DOIs resolved,
unsourced numbers and figure/code inconsistencies flagged — before anything ships.

![A protein-language-model literature survey compiled into a PDF manuscript, with a citation reviewer confirming every DOI resolves](./docs/assets/showcase-literature.webp)

**Drives your own Chrome.** The agent reads the live web through your real browser
profile — logins and all — then turns what it finds into a figure and a sortable CSV.

![The agent driving the user's own Chrome via open-science-browser to harvest bioRxiv preprints into a chart and CSV](./docs/assets/showcase-browser.webp)

**Research from anywhere — even your phone.** A built-in authenticated gateway serves
the *real* desktop UI to a browser on your LAN (or a tunnel), so you can kick off a run
at your desk and read the finished figure and report on your phone.

<table align="center">
  <tr>
    <td align="center" width="33%"><img src="./docs/assets/showcase-mobile-home.webp" width="240" alt="The workbench in a phone browser: the new-session screen with starter analyses"><br><sub>New session</sub></td>
    <td align="center" width="33%"><img src="./docs/assets/showcase-mobile-run.webp" width="240" alt="A completed dose-response analysis — script, results, figure, and report — on a phone"><br><sub>A finished analysis</sub></td>
    <td align="center" width="33%"><img src="./docs/assets/showcase-mobile-reproduce.webp" width="240" alt="Reproducing an scVI benchmark, with its ARI-vs-epoch figure, viewed on a phone"><br><sub>A reproduced benchmark</sub></td>
  </tr>
</table>

<details>
<summary><b>More screenshots</b></summary>

<br>

![Reproducing an scVI integration benchmark on a remote A100 with a pinned environment, execution log, and provenance](./docs/assets/showcase-remote.webp)

![An 8-arm scVI hyperparameter sweep table beside a live analysis notebook sharing the agent's kernel](./docs/assets/showcase-experiment.webp)

</details>

## Current capabilities

**The research loop, as skills.** One meta-skill runs the full pipeline; each stage
is a self-contained skill that produces a real, gradeable artifact — runnable on any
model OpenCode supports:

| Skill | Role | Primary output |
| --- | --- | --- |
| `ai4s-agent` | Runs the four skills below, in order | The full research package |
| `research-explorer` | Turn a broad direction into concrete topics | `research_exploration.md`, `topic_matrix.md`, `literature_pre_survey.md` |
| `literature-survey` | Write a literature survey | 6–20 pp PDF, 60+ real citations, LaTeX source, taxonomy figures |
| `experiment-suite` | Build an experiment package | Design doc, runnable code, `results.json` with provenance, figures, report |
| `paper-writer` | Write a research paper | 8–14 pp PDF, 200+ citations, 4–8 figures, tables |
| `mindmap-render` | Render a mindmap | Image generated from a `topic_matrix.md` |
| `integrity-auditor` | Audit a paper's integrity | Image / numerical / logical findings, 4-level evidence grading, `audit_report.md` |

These ship in the `ai4s-skills` pack alongside first-party review skills and the
office/document skills below.

### Platform

| Area | Current state |
| --- | --- |
| Desktop shell | Tauri 2 + React + TypeScript + Vite, with macOS, Windows, and Linux desktop builds. |
| Runtime | Bundled OpenCode sidecar, auto-started by the app, isolated from the user's own OpenCode config/data. |
| Projects | Named project workspaces that group their sessions; import an existing folder in place (never copied) or adopt one already inside the workspace; move an existing session into a project. |
| Sessions | Multi-session chat/history, dated workspace folders, searchable history with archive/restore/export, `@` file and `#` conversation references, `/` commands, and `!` shell mode. |
| Layout | N-ary split-pane tiling with drag-to-dock, independent Screens, per-pane model and reasoning effort, and cross-screen pane drag. |
| Agent modes | `/plan` for plan-then-execute, `/goal` for objective and acceptance criteria, live subagent status in its own panel, and Stop that reflects the runtime's real server state. |
| Memory | Global and per-project memory layers, switchable, plus automatic context compaction as a conversation approaches the model's window. |
| Remote compute | Register machines from your `~/.ssh/config`, probe them, and submit, track, or cancel jobs from the app. |
| Appearance | Light, Warm, and Dark themes with per-theme accents, and UI zoom. |
| Files | Global and per-session file browsing, context menu actions, external open/reveal, copy path, and local preview server. |
| Headless & CLI | `osd server` runs the workbench with no window — same workspace, same runtime, same web UI, served from one self-contained directory — and `osd` drives it (or a running desktop app) from a terminal: sessions, projects, runs, files, approvals, `--wait`, `--json`. |
| Remote access | Token-authenticated gateway that serves the real UI to a CLI, a LAN web browser, or your phone (loopback by default, LAN opt-in); read-only vs full access modes; copy a link with the token embedded to connect in one tap. API keys never cross the wire. |
| Editor interop (ACP) | Speaks the Agent Client Protocol in both directions: run any ACP agent (Codex, Gemini CLI, Claude Code, …) as the runtime behind the ordinary UI, with its own model and reasoning selectors, history replay, and this app's MCP connectors; or let an external editor (Zed, JetBrains, Neovim, …) drive Open Science, reusing the gateway token. |
| Browser control | The agent drives your own Chrome — profile and login state preserved — reading pages through the accessibility tree, or an isolated/private browser on demand. |
| Notebooks | Real `.ipynb` files, Python and R notebook creation, local kernel execution, managed Jupyter environment via bundled `uv`, and an Open JupyterLab action. |
| Runs | Append-only run logs, global SQLite run index, search/facets/pagination, local/remote surfaces, output links, logs, and reproduce prompts. |
| Provenance | `.openscience/provenance.jsonl` tracks file versions and links produced artifacts back to the run or edit that created them. |
| Review | Traceability, statistics-integrity, domain-check, large-file, publication-figure, remote-compute, and Modal run skills are bundled as first-party skills. |
| Viewers | PDF, image, video, HTML, Markdown, code, CSV/TSV tables with charts, DOCX, XLSX, PPTX, molecules, 3D meshes, genome tracks, FITS, DOS/DOSCAR, EIGENVAL bands, qcode, anomaly maps, and phase files. |
| Models | OpenCode provider catalog, OAuth/API-key provider flows, custom OpenAI-compatible endpoints, and local/provider-specific options supported by OpenCode. |
| Interface languages | English, Simplified Chinese, Japanese, Spanish, German, French, and Korean. Portuguese (Brazil) and Arabic are registered but not selectable yet. |

## Skills and connectors

Bundled skills are fetched for builds and releases instead of being committed into
git history:

- `ai4s-skills` pack from `ai4s-research/ai4s-skills`.
- Office/document skills from the Apache-2.0 `anthropics/skills` repository:
  `docx`, `pdf`, `pptx`, and `xlsx`.
- First-party core skills in `runtime/skills/core/`:
  `traceability-review`, `stats-integrity`, `domain-check`, `large-file`,
  `publication-figures`, `remote-compute`, and `modal-run`.

One-click science MCP connectors currently include:

- Literature search: arXiv, PubMed, Crossref, Semantic Scholar, bioRxiv/medRxiv.
- Biomedical databases: PubMed, ClinicalTrials.gov, MyVariant/ClinVar.
- Materials Project.
- FRED economic data.
- Space weather.
- Open-Meteo weather and climate.
- USGS water data.

You can also add any local or remote MCP server from Settings. See
[`docs/CONNECT_YOUR_TOOLS.md`](./docs/CONNECT_YOUR_TOOLS.md).

For a neutral positioning note, see
[`Open Science Desktop vs OpenScience`](./docs/open-science-desktop-vs-openscience.md).

## Install

Download the latest installer from the
[Releases page](https://github.com/ai4s-research/open-science/releases/latest).

- **macOS**: `.dmg` / `.app`, Apple Silicon and Intel, macOS 13 Ventura or later.
- **Windows**: NSIS `.exe`, Windows 10/11 x64 — installs per user, no admin needed. A `.msi` is also published for IT-managed deployment; pick one format and stay on it.
- **Linux**: `.deb` and `.rpm` on x86_64 Linux.

The macOS packages are Developer ID signed, notarized, and stapled, so they open
normally — no `xattr` workaround needed. Windows and Linux builds are not signed yet.

**Windows**: if SmartScreen appears, choose **More info -> Run anyway**.

**Linux**:

```bash
sudo apt install ./Open.Science_*.deb
# or
sudo rpm -i Open.Science-*.rpm
```

## Headless & CLI (`osd`)

A research machine usually has no screen. `osd` is the same workbench without
one: the same workspace layout, the same agent runtime, the same projects, and
the same web UI — served over HTTP instead of drawn in a window.

**On a server, take the archive.** `osd-<version>-<target>` from Releases
unpacks and runs with nothing installed — verified on a bare Ubuntu container
with no packages added at all.

```bash
# Configure the machine (works before any server is running)
./osd auth set anthropic --key sk-…       # stays on this machine, never on the wire
./osd model set anthropic/claude-opus-4-5 # the default for every turn
./osd server --lan                        # prints its URL and access token
```

Keys never have to touch a file: the agent runtime inherits this process's
environment, so `ANTHROPIC_API_KEY=sk-… ./osd server` needs no `auth set` at
all. A self-hosted or proxied endpoint goes in the same command
(`--base-url https://my-gateway.internal/v1`), and `osd auth ls` prints provider
names only — no key is ever printed by anything. Changing a key needs a restart;
the CLI says so rather than leaving you to wonder.

Open the printed URL and you get the real desktop UI in a browser, phone
included. Or drive it from a terminal — on the same machine, over SSH, or from
your laptop:

```bash
osd project new "Reef survey"
id=$(osd session new --project "Reef survey")
osd session send "$id" "Fit the 2015–2024 bleaching trend and write report.md" \
    --model anthropic/claude-sonnet-4-5 --wait
osd fs ls figures/
osd fs get report.md --output ./report.md
```

On Windows the same commands work in PowerShell; only the shell's own syntax
differs:

```powershell
$id = osd session new --project "Reef survey"
osd session send $id "Fit the 2015-2024 bleaching trend and write report.md" --wait
```

**On your own machine it is already installed.** The desktop installer carries
`osd`, and the app puts it on your PATH the first time it starts, so a new
terminal has the command with nothing to set up. It writes one small wrapper
(`~/.local/bin/osd`, or `~/bin` when a terminal already searches that) — never a
symlink, because `osd` finds its runtime next to its real executable. If that
folder is not on PATH, the app adds it to your login profile and Settings →
Remote Access says which file it touched. Nothing else on your shell is changed.

`--wait` returns when the turn is finished, not when it was accepted, and fails
loudly if it produced no reply. `--json` prints the API's own response for
scripts.

### Which model, and who approves what

`osd model` shows the default, `osd model ls` lists what the runtime can
actually serve (the providers this machine has credentials for, current one
marked), and `osd model set <provider/model>` changes it — over the gateway, so
it works against a remote server too. Any single turn can override it with
`osd session send --model … --agent … --effort …`.

Approvals still apply: the agent asks before running commands, deleting files,
installing dependencies or reaching the network. Without a window, `--wait` names
what is waiting and offers both answers — `osd permission ls` /
`osd permission allow <id>` in the terminal, or the gateway URL it prints, which
carries the token so a browser on your laptop or phone can approve it.

For a machine with nobody watching, opt out explicitly:

```bash
osd approval            # what has to be asked today
osd approval set full   # never ask — commands, deletions, installs, network
```

`full` is a deliberate choice, not a default: the agent stays confined to the
workspace, but nothing pauses for you. `osd approval set approve` puts every
rule back.

### As a service

`osd server` is an ordinary foreground process, so systemd runs it as-is. This
unit was run end to end on Ubuntu — enable, restart, crash, stop:

```ini
# /etc/systemd/system/osd.service
[Unit]
Description=Open Science Desktop (headless)
After=network-online.target

[Service]
Type=simple
User=ubuntu
Environment=HOME=/home/ubuntu
ExecStart=/opt/osd/osd server --port 4788
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

`sudo systemctl enable --now osd` and the printed URL and token land in
`journalctl -u osd`. A unit is also the tidiest way to run it: systemd stops the
whole cgroup, so the agent runtime never survives the server, however it dies.

With no `--gateway` given, `osd` talks to a gateway already running on the same
machine — including the desktop app's — so with the app open, `osd session ls`
just works. Otherwise point it anywhere with `osd login --gateway <url> --token
<token>`.

What is *not* there without a desktop: local Jupyter kernels, native file
dialogs, and the OS file manager — the web UI hides those rather than offering
controls that would fail. Two more are worth knowing: **provenance and run
records are written by the desktop client**, so a headless server keeps the
workspace's file history through git snapshots but does not append to
`provenance.jsonl` or the run index.

## Build from source

Prerequisites:

- Node.js >= 20
- pnpm 9
- Rust toolchain
- macOS, Windows, or Linux system dependencies required by Tauri

```bash
git clone https://github.com/ai4s-research/open-science
cd open-science
pnpm install

# Fetch pinned sidecars and bundled skills. These are git-ignored.
bash scripts/dev/fetch-opencode.sh
bash scripts/dev/fetch-uv.sh
bash scripts/dev/fetch-skills.sh

# The osd terminal client is bundled too — it is ours, so it is built, not fetched.
bash scripts/dev/build-osd-sidecar.sh $(rustc -vV | sed -n 's/host: //p')

# Run in development or build installers.
pnpm --filter @ai4s/desktop tauri dev
pnpm --filter @ai4s/desktop tauri build
```

Useful checks:

```bash
pnpm test
pnpm typecheck
pnpm lint
```

## Safety and privacy

- Workspace files, raw data, session history, provenance, notebooks, and run records
  stay local by default.
- Command execution, file deletion, dependency installation, and remote connections
  are human-approved flows in the desktop app.
- Provider credentials are written to app-private runtime config, not to the
  workspace, provenance, git, exports, or global OpenCode config.
- Settings includes a plain-language data-flow view explaining what can be sent to
  the selected model provider.

## Repository layout

| Path | Purpose |
| --- | --- |
| `apps/desktop/` | Tauri + React desktop app. |
| `packages/sdk/` | `OpenCodeClient`; keeps the UI from calling OpenCode directly. |
| `packages/shared/` | Shared domain types and chart palette. |
| `packages/ui/` | Shared UI package. |
| `runtime/skills/core/` | First-party scientific skills. |
| `runtime/skills/external/` | Build-fetched external skills. |
| `runtime/harness/` | Runtime harness knowledge and operator context. |
| `runtime/mcp/` | MCP runtime notes/configuration. |
| `examples/` | Built-in example workspaces. |
| `crates/osd-core/` | The server core — workspace, sidecar, gateway. No Tauri, so it runs headless. |
| `crates/osd-cli/` | `osd`: the headless server and its client. |
| `scripts/dev/` | Sidecar, `uv`, skill fetchers, and focused regression probes. |
| `docs/` | Product, technical, operator, connector, and research notes. |

## Status

The project is a working desktop MVP in active development. The most reliable current
implementation log is [`PROGRESS.md`](./PROGRESS.md). Product and architecture notes
live in [`docs/PRD.md`](./docs/PRD.md) and
[`docs/TECHNICAL_DESIGN.md`](./docs/TECHNICAL_DESIGN.md), but those documents include
target design as well as historical status notes.

Near-term work is focused on Windows code signing, auto-update, broader
Windows/Linux verification, richer connector hardening, and continued
reproducibility review. macOS releases are already signed and notarized.

## Contributing

Issues and PRs are welcome. Keep changes minimal and verifiable, follow
[`AGENTS.md`](./AGENTS.md), and run the checks before opening a PR. For discussion,
join the [Open Science Discord](https://discord.gg/fWNMDKcd5P) or the
[linux.do](https://linux.do) community.

## Citation

If you use Open Science Desktop in your research, please cite it:

```bibtex
@software{open_science_desktop,
  author  = {{The Open Science Desktop Contributors}},
  title   = {Open Science Desktop: a local-first, model-agnostic AI research workbench},
  year    = {2026},
  version = {0.5.2},
  doi     = {10.5281/zenodo.22136307},
  url     = {https://github.com/ai4s-research/open-science},
  license = {MIT}
}
```

GitHub's **"Cite this repository"** button (top of the repo page, generated from
[`CITATION.cff`](./CITATION.cff)) provides the same reference in APA and BibTeX.

## License

[MIT](./LICENSE). Bundled third-party skills and connectors keep their own licenses.

> Open Science Desktop is beta research tooling. Treat outputs as drafts: verify numbers,
> citations, code, and conclusions before publication or decision-making.
