# runtime/skills

Scientific skills, layered:

```text
skills/
  core/      # self-authored skills specific to this app (traceability-review;
             # other dirs are roadmap placeholders until they get a SKILL.md)
  external/  # third-party skill packs, fetched by script — git-ignored
  user/      # user-installed / custom skills (live in the runtime workspace)
```

Core skills are bundled as the `skills-core/` app resource and deployed next to
the external pack on every sidecar start; directories without a `SKILL.md` are
skipped.

## Default pack: ai4s-skills (bundled into the installer)

The default scientific skills come from
[ai4s-research/ai4s-skills](https://github.com/ai4s-research/ai4s-skills)
(research-explorer, literature-survey, experiment-suite, paper-writer,
integrity-auditor, mindmap-render, ai4s-agent).

How they ship, end to end:

1. `scripts/dev/fetch-skills.sh` (run locally and in CI) downloads the pack at a
   pinned commit into `external/ai4s-skills/`.
2. `tauri.conf.json` bundles that directory as an app resource (`resources/skills/`).
3. On every sidecar start, `runtime.rs::deploy_bundled_skills` syncs the pack into
   the app-private profile's global skills dir (`<xdg-config>/opencode/skills/`),
   which OpenCode scans regardless of project detection. Bundled skill directories
   are replaced on app upgrade; the workspace's own `.opencode/skills/` stays
   reserved for user-installed skills. Skill listing must be workspace-scoped
   (`GET /api/skill?directory=…`) — the SDK does this via its `directory` option.

To bump the pack version, update `AI4S_SKILLS_COMMIT` in `fetch-skills.sh`.

## Office pack: Anthropic document skills (bundled into the installer)

The docx / pdf / pptx / xlsx skills come from Anthropic's open-source
[anthropics/skills](https://github.com/anthropics/skills) repo (Apache-2.0;
each skill directory keeps its own `LICENSE.txt`). Same pipeline as above:
`fetch-skills.sh` pins them into `external/anthropic-skills/`, bundled as the
`skills-office/` app resource, deployed by `deploy_bundled_skills`. Bump via
`ANTHROPIC_SKILLS_COMMIT` in `fetch-skills.sh`.

## Browser skill: official agent-browser core guide

`scripts/dev/fetch-agent-browser.sh` fetches both the pinned sidecar and the
official `skill-data/core` directory from the same agent-browser tag. The build
adds only a small Open Science Desktop MCP/lifecycle adapter, bundles the result
as `skills-agent-browser/`, and deploys it as `open-science-browser`. This keeps
the browser workflow version-matched without copying an upstream guide into git.
While the connector is configured, the runtime hides the unrelated legacy
`browser-control` user skill so OpenCode cannot select the wrong transport.

## Third-party skills

Do **not** enable large third-party collections (e.g. ~148 K-Dense skills) by
default. Use curated install, enable by domain, and always surface each skill's
license, dependencies, and risk.

Each skill directory must contain a `SKILL.md`.
