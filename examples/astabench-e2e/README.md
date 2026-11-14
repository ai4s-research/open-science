# AstaBench End-to-End Discovery Adapter for Open Science Desktop (OSD)

This directory contains the Inspect AI solver adapter and frozen-harness configuration used to evaluate Open Science Desktop (`OSD`) on the AstaBench End-to-End Discovery benchmark (`e2e_discovery_test` and `e2e_discovery_hard_test`), released under the repository's MIT License.

## Contents

- `adapters/astabench/osd_solver.py` — Inspect AI `@solver` (`osd_agent`) that bridges official AstaBench sample tools (including stateful `python_session` execution and kernel recovery controls) to an isolated OSD session over MCP, normalizes the final E2E JSON output contract, and maps token usage to Inspect `ModelUsage`.
- `adapters/astabench/open_science_solver.py` — Helper that loads the OSD harness policy (`runtime/harness/AGENTS.md`).
- `configs/profiles/astabench-e2e-discovery.json` — Benchmark profile and output contract configuration (`astabench-e2e-discovery-v5`).
- `skills/scientific-discovery/SKILL.md` — Capability skill loaded by the E2E discovery profile.
- `runtime/harness/AGENTS.md` — Bounded-execution harness policy overlay used for the E2E evaluation runs.

## Provenance and Revision Notes

- **OSD application revision**: `74f3afa0c72505fad887b3d3eb6a74cf1919e377`
- **AstaBench revision**: `5c844b7451e3a98cd0df71ea626bb217803d2bed` (`inspect_ai==0.3.114`)
- `open_science_solver.py`, `configs/profiles/astabench-e2e-discovery.json`, `skills/scientific-discovery/SKILL.md`, and `runtime/harness/AGENTS.md` match the exact SHA-256 hashes recorded in the September 2026 E2E run manifests.
- `adapters/astabench/osd_solver.py` is the retained adapter snapshot (`1d72df1d16ded72e989a88b1f47b7deabe967cf2c196fc2e576fc6e2b245cb8f`) from the local evaluation harness repository.
