# Open Science Desktop — Prioritized Requirements (Community-Informed)

> **Purpose.** This document turns real community evidence into concrete,
> prioritized requirements for **Open Science Desktop**, our open-source, local-first,
> reproducible AI research workbench. It complements `PRD.md`: the PRD says
> *what the product is*; this file says *what to build first and why*, tied to
> evidence.
>
> **Evidence base.** v1 drew on feedback about Claude Science (HN, Reddit
> r/comp_chem & r/singularity, LinkedIn) — almost all life-sciences. v2 (this
> revision, 2026-07-05) broadens that base across the major research
> disciplines: physics/astronomy, chemistry/materials, earth/climate/geoscience,
> and the social sciences, plus remaining bio gaps and cross-cutting needs. Full
> transcript with verbatim quotes and sources:
> `docs/research/2026-07-05-multidiscipline-needs.md`.
>
> **The 80/20 finding.** Across every discipline, needs are **~80% shared, ~20%
> discipline-specific**. The shared 80% — reproducibility/provenance, citation
> audit, local compute, HPC, and the connector/renderer *frameworks* — is the
> real moat, is discipline-agnostic, and is **largely built**. The remaining 20%
> (format I/O, data connectors, native viewers, and per-field correctness gates)
> is what makes a physicist / chemist / social scientist feel *"this is for me"*
> — and today it is proven only on biology + climate.
>
> Reading order: priority tiers (P0 → P2). Each requirement carries **Evidence**
> (what users actually said/did), **Requirement**, **Acceptance** (a checkable
> result), and **Status**. Status legend:
>
> - ✅ **Done** — shipped and verified (see `PROGRESS.md`).
> - 🟡 **Partial** — core shipped; named gaps remain.
> - ⬜ **Planned** — not yet built; scoped here.

## 0. Positioning takeaway

The moat of an AI research workbench is **not the model**. It is:

1. a **research agent runtime** (run tools/pipelines, not just chat),
2. a **reproducible artifact system** (every figure/table/notebook traces to
   code, environment, inputs, and conversation),
3. **domain tool/database connectors**, and
4. **domain-correctness gates** — because across *every* field the top complaint
   is code that **runs but is scientifically wrong** (see P0-5).

Open Science Desktop must win on those four axes — plus two things competitors are
criticized for lacking: **multi-discipline breadth** and **Windows support**.

Do **not** market as "open-source Claude Science" or "zero hallucination."
Market as: *"Open Science Desktop — local-first, model-agnostic AI research
workbench for macOS, Windows & Linux."* Sell **traceable / verifiable**, not **perfect**.

---

## P0 — Must-have (the actual moat; core differentiation)

Without these we are "just Jupyter + a chatbot" — the exact criticism leveled at
competitors.

### P0-1 · Run a full workflow end to end, not a chat box — ✅ Done

- **Evidence.** Praise centered on *"it did the whole analysis"* — download data
  → run pipeline → produce figures → draft manuscript → save a traceable record.
  One user automated a workflow that first took ~1 month. This is the confirmed
  cross-discipline workflow: *human leads → agent writes code driving mature
  domain libraries → human validates outputs step by step*.
- **Requirement.** The agent chains: fetch data → run code/pipeline → generate
  figures/tables → write results → persist a reproducible record, in one
  workspace, with visible plan/approval steps.
- **Acceptance.** From a single natural-language request, produce at least one
  figure **and** one report artifact, each linked to the code that made them,
  without the user leaving the app.
- **Status.** ✅ The empty session offers one-click workflow starters (demo
  end-to-end analysis, analyze-my-data, audit-a-report, and the climate-trends
  example on real bundled data); the demo starter verifiably produces code →
  figure → report → stats in one turn, all files surfaced as artifacts with
  provenance. Minor gap: bci-trends is still repo-only.

### P0-2 · Local data + local compute (restricted-environment friendly) — ✅ Done

- **Evidence.** Heavy interest in whether data leaves the machine (WGS, CRAM,
  lab-internal data, HPC). Sensitive data is often locked in TREs; a local server
  + browser UI is seen as the way in. Consensus for clinical/unpublished data:
  *"keep raw data inside your boundary … public, multi-tenant LLMs are not
  recommended for healthcare workloads."*
- **Requirement.** Python/R/shell execution on the local machine by default; raw
  data and computation stay on the user's infrastructure; no silent upload.
- **Acceptance.** A user can complete an analysis with zero data leaving the
  device; the app states plainly what (if anything) is sent to a model provider.
  Persistent kernels keep variables/dataframes/models in memory to avoid reloads.
- **Status.** ✅ Local Python **and R** kernels + Jupyter sidecar (isolated env,
  workspace-scoped). One persistent kernel per notebook keyed by kernelspec
  language; R uses a base-R-only bridge (no IRkernel/jsonlite), so R notebooks
  run cell-by-cell with shared state, last-expression values, stdout/warnings,
  and error reporting — against any installed R, offline. New-notebook menu
  offers Python or R. Settings carries a plain-language "Privacy & data flow"
  card. Related gap — large-file handling — tracked as P0-6.

### P0-3 · Provenance / reproducibility for every artifact — ✅ Done

- **Evidence.** The #1 cross-discipline pain and the true differentiator over
  generic chatbots. *"It makes it possible to produce wrong results faster than
  ever before"* (neuroscience); *"there's no clear way to audit what was done …
  the same input doesn't always lead to the same output"* (life sciences).
- **Requirement.** Every figure/table/notebook/report binds to: the code that
  generated it, the environment, input files, the agent conversation, and run
  logs. Records are stable and versioned (`provenance.jsonl`).
- **Acceptance.** For any artifact, one click reveals its generating code +
  environment + inputs + originating conversation turn; re-running reproduces it.
- **Status.** ✅ Every agent write appends a version record to
  `.openscience/provenance.jsonl` (code, tool, model, session, timestamp, and
  captured environment — Python version, OS/arch, app build). The History panel
  reveals per-version data + a link back to the originating conversation; a
  per-version **Reproduce** action drafts (never auto-sends) a prompt that re-runs
  the recorded code and reports whether the file matches. Package capture too:
  each record captures `pip freeze` (once per app run) into a content-addressed
  lockfile `.openscience/env/<hash>.txt`; the record carries `{count, hash}`, the
  History panel shows an "N packages" chip, and the Reproduce prompt points at
  the lockfile to reinstall matching versions.

### P0-4 · Reviewer agent — traceable claims, not "no hallucinations" — 🟡 Partial

- **Evidence.** Users distrust "zero hallucination" claims but buy **verifiable**.
  Fabricated/misused citations are epidemic: benchmark hallucination rates 14–95%;
  psychology citation fabrication 6–60%. Physicists: *"if you … summarize [a
  citation] wrong, that's in some ways more insidious."*
- **Requirement.** A reviewer performing **citation audit**, **untraceable-number
  flagging**, and **figure ↔ code consistency checks** — surfaced as structured,
  dismissible findings, never as a guarantee of correctness.
- **Acceptance.** The reviewer flags at least: (a) a citation it cannot resolve,
  (b) a number with no traceable source, (c) a figure whose underlying code
  changed. Copy never promises "no errors."
- **Status.** 🟡 The bundled `traceability-review` skill runs all three checks
  (Crossref/arXiv/PubMed resolution, unsourced-number flagging, figure↔code
  staleness via `provenance.jsonl`) and emits the structured review contract;
  reviewer cards tag each finding with its check type and are dismissible. **PDF
  manuscripts** are now supported: a bundled `pdf_extract.py` (multi-backend —
  PyMuPDF/pypdf/PyPDF2/pdfminer, graceful when none is installed) deterministically
  pulls the text plus citation identifiers (DOI/arXiv/PMID) and quantitative
  claims (p-values, percentages, N) so the reviewer audits real identifiers
  rather than ones recalled from memory; the skill wires it as the first step for
  a PDF. Verified against a real generated PDF (extracts text + all three
  identifier types + claim kinds) — 7 tests. Gap: robustness for models weaker at
  tool use. **Note:** this reviewer checks *traceability*, not *domain
  correctness* — that gap is P0-5.

### P0-5 · Domain-correctness gates ("runs" ≠ "right") — 🟡 Partial · NEW

- **Evidence.** *The single most consistent finding of the multi-discipline
  research, and the largest gap in this document.* Every field's top pain is code
  that **executes cleanly but is scientifically wrong**:
  - Physics/astro — units & dimensional errors: *"It loves to say one quantity is
    'similar' to another without establishing equality."*
  - Earth/geo — CRS/projection is the #1 bug class: *"treating latitude and
    longitude as simple floating-point numbers without CRS awareness is the
    source of most geospatial bugs"*; *"code that runs without error but produces
    scientifically incorrect results."*
  - Biology — *"off-by-one … treating 0-based coordinates as 1-based, and strand
    orientation confusion"*; *"silent horror bugs … tests pass while the code is
    incorrect."*
  - Chemistry/materials — invalid molecules/stoichiometry/valence (5-bond
    carbons); *"in science, you can't have that 1%."*
  - Social science — wrong test selection + sycophantic misreading: *"guessing
    what I wanted to hear, interpreting basic regression results incorrectly but
    provocatively."*
- **Requirement.** A **pluggable domain-validator layer** — one rule set per
  field — that runs before/after execution and intercepts that field's classic
  error classes. Findings are structured and dismissible (same contract as
  P0-4); it **never** promises correctness. Complements two cross-cutting
  disciplines: (a) *tool-calling over recall* — domain objects (SMILES, POSCAR,
  coordinates, package/function names) round-trip through the real library and
  are rejected if invalid, never emitted from model memory; (b) the social-science
  **execute-don't-interpret** boundary (see P1-6).
- **Acceptance.** At least **3** discipline gates ship and each catches one real
  case: a unit/dimension mismatch (physics), an unaligned CRS / lat-as-bare-float
  (earth), and a 0/1-based coordinate or strand error (biology).
- **Status.** 🟡 The deterministic, pluggable gate shipped as the bundled
  `domain-check` skill (`runtime/skills/core/domain-check/domain_check.py`,
  stdlib-only, one `check_<field>` rule set per discipline). It analyses the
  code the agent actually wrote — AST for Python/notebooks, regex for R — never
  model recall, and emits the same structured `review` contract as P0-4
  (findings carry a per-discipline `tag`, so new fields need no UI change). All
  three acceptance gates ship and each catches its real case (19 validator
  tests): **physics · units** (dimensional mismatch `t_seconds + d_meters`;
  trig on a degree-valued angle), **earth · crs** (Euclidean distance on
  lat/lon; geopandas geometric op with no CRS set), **biology · coords/strand**
  (BED off-by-one — 0-based half-open, so length is `end - start`, no `+1`;
  strand-unaware sequence extraction), a fourth discipline **chem · valence**
  (a SMILES literal — assigned to a `smiles`/`smi` variable or passed to
  `MolFromSmiles` — that cannot be a real molecule. **Library round-trip now
  shipped**: when RDKit is installed it is the authoritative judge
  (`Chem.MolFromSmiles` sanitizes the parse), catching far more than the
  five-bond carbon — bad ring closures, impossible aromaticity, over-valent
  N/O/S — and clearing molecules a heuristic would wrongly flag; without RDKit
  it degrades to the stdlib bond-counter (carbon >4 / over-bonded halogen,
  bails on bracket atoms). **Verified end-to-end with real RDKit**: it flags
  5-bond nitrogen and an unclosed ring the static path misses, and clears
  caffeine/aspirin), and a fifth **social science** — **social ·
  multiple-comparisons** (a significance test in a loop or ≥3 times with no
  FDR/Bonferroni correction — the named silent p-hacking risk) and **social ·
  categorical** (a numeric reduction `.mean()`/`.std()` on a nominal code like
  `gender`/`region`, treating a label as interval; a `groupby` key is correctly
  not flagged). Rules favour precision (unrecognized units / no discipline
  signal / bracket-atom SMILES / a single test / a groupby key stay silent); 37
  validator tests. Gap: POSCAR→pymatgen validity round-trip; broader per-field
  rule depth.

### P0-6 · Large files: reference, don't load — ✅ Done · was inside P0-2/P2-1

- **Evidence.** Same failure mode in every field: files far exceed any context
  window — human FASTQ ~90 GB / BAM ~160 GB; multi-GB/TB HDF5/FITS sim snapshots;
  20 GB+ NetCDF/GRIB rasters OOM; VASP `OUTCAR` read raw hallucinates. Notebook
  base64 plots *"eat up large chunks of the context window."* Materials case: raw
  approach consumed 20M+ tokens and **failed**; memory-pointer approach used 1234
  tokens and **succeeded** (>16,000× difference).
- **Requirement.** A unified out-of-core capability: read header/schema, sample,
  and parse large logs with deterministic extractors returning structured numbers
  — reference data via memory-pointers rather than stuffing files into context.
  Covers FITS/HDF5/ROOT, NetCDF/GRIB, BAM/CRAM/FASTQ, VASP logs, `.dta`.
- **Acceptance.** An analysis over a file larger than the context window completes
  by introspection/sampling, with no attempt to load the whole file into the
  model.
- **Status.** ✅ The memory-pointer contract now ships as the bundled
  `large-file` skill (`runtime/skills/core/large-file/large_file_probe.py`,
  stdlib-first): a probe that returns a compact JSON pointer — schema / shape /
  approx row count / head+tail sample / extracted log numbers — in bounded
  memory, so the agent references data instead of loading it. Coverage: tables
  (CSV/TSV, streamed row count), NDJSON, Parquet (metadata only), HDF5 (dataset
  tree), FITS (memmapped headers), NetCDF, and text/logs with deterministic
  numeric extraction for VASP `OUTCAR`/`OSZICAR` (final `free energy TOTEN`,
  `energy(sigma->0)`, convergence). **Verified on this host**: a 13.5 MB CSV →
  788 B pointer, a real 1.6 MB Parquet → 447 B, a 16 MB HDF5 → 456 B (each
  ~18,000–37,000× smaller than the file, no whole-file load). Now also
  **genomics + remaining physical-science formats**: **FASTQ** (`.fastq`/`.fq`,
  incl. `.fastq.gz`), **FASTA**, and **VCF** (incl. `.vcf.gz`) are STDLIB and
  gzip-aware — a 90 GB FASTQ is counted by streaming (read count, read-length
  min/max/mean over a bounded scan, sample ids — never full sequences), VCF
  reports variant count + sample names + contigs; **BAM/CRAM** (pysam header),
  **GRIB** (cfgrib/pygrib), and **ROOT** (uproot) introspect via their library
  or degrade to an install hint. **Verified on this host**: a 500k-read
  `.fastq.gz` → 462 B pointer, streamed in constant memory; a 3,000-variant VCF
  → samples + contigs parsed. 18 probe tests. **UI wiring shipped**: the "too
  large to preview" card now offers **Inspect without loading** — a Rust
  `probe_large_file` command (sandbox-resolved path, detected Python, enriched
  PATH) runs the bundled probe and the pane renders the pointer as a compact
  fact sheet (format, size, rows/reads/variants, read-length, schema chips,
  sample ids, "not loaded" note), so a user — not just the agent — introspects
  an over-window file in one click. **This closes P0-6** (acceptance: an
  analysis over a file larger than the context window completes by
  introspection/sampling, no whole-file load).

### P0-7 · Safety-defaults compliance + audit debt — 🟡 Partial · NEW (2026-07-05 audit)

- **Evidence.** A four-track architecture audit (layering/boundaries, Rust
  backend, frontend structure, safety defaults) on 2026-07-05. Overall verdict:
  the skeleton is solid — the SDK boundary is real (zero raw HTTP in the app),
  package deps are clean, zero `any`/`ts-ignore` under strict mode, 274
  behavioral tests, exemplary pure domain parsers, and uniform Rust path
  sandboxing (`resolve_under`). But the AGENTS.md non-negotiable safety
  defaults are not met, and two serious Rust defects exist. Note: this
  contradicts P2-3's "approval mode ✅" — the permission *UI* ships and works,
  but under shipped defaults it only fires for external-directory and
  doom-loop, not for command execution.
- **Requirement.** Close the gap between the promised safety defaults and what
  the shipped binary actually does; fix the two critical Rust defects; then pay
  down the structural debt.
- **Acceptance.** Each checkbox below is independently verifiable (a fresh
  install prompts for approval on a shell command; a URL containing `&` opens
  correctly on Windows; a `while True: pass` cell can be reset without
  restarting the app).
- **Status.** 🟡 Partial — approval modes shipped 2026-07-05; sidecar auth +
  preview-server token shipped 2026-07-06. Severity-ranked backlog:

  **Critical — safety defaults (AGENTS.md non-negotiable):**
  - [x] **Approval mode is not configured anywhere.** ~~The bundled OpenCode
    1.17.13 binary's embedded default is `{"*":"allow"}`, so bash / file edits /
    dependency installs run unprompted.~~ **Fixed (2026-07-05):** a Codex-style
    two-mode switch in the composer — **Approve for me** (default; deletion /
    installs / remote / privilege commands and webfetch prompt first, via ask
    rules seeded into the app-private config before sidecar start) and **Full
    access** (`"permission": {}` = OpenCode builtin defaults, an explicit user
    choice that survives restarts). Verified against the running bundled
    binary: rules land in the build agent's resolved ruleset after the builtin
    `*: allow` (last-match-wins), and a 22-case simulation using OpenCode's
    verbatim wildcard/evaluate algorithm behaves as designed.
  - [x] **Sidecar runs with `--cors "*"` and no server auth.** ~~Any local
    webpage can scan loopback ports, drive agent turns, and `GET /global/config`
    to read stored API keys.~~ **Fixed (2026-07-06):** the sidecar now requires
    OpenCode's built-in Basic auth via a per-run CSPRNG password
    (`OPENCODE_SERVER_PASSWORD`, in-memory only, never on disk); the SDK sends
    the `Authorization` header on every call and keeps the reliable EventSource
    SSE path via `?auth_token=`. `--cors "*"` removed (verified in the 1.17.13
    source: it was an exact-match literal, never a wildcard — the real exposure
    was the built-in allowlist trusting all localhost origins, which auth now
    gates). Verified against the running bundled binary: no/wrong password →
    401 on `/global/config`, `/session`, `/event`; correct password → 200;
    `?auth_token=` streams SSE. The preview server likewise requires a per-run
    CSPRNG token as the URL's first path segment (relative subresources in
    HTML previews inherit it; sandboxed iframes need no cookies) and no longer
    sends `Access-Control-Allow-Origin: *` (previews render in iframe/img,
    never cross-origin fetch).
  - [x] **Workspace confinement doesn't bind bash**: file tools prompt via
    `external_directory`, but bash (default `allow`, real `$HOME`) escapes
    freely. Covered by the permission fix above (in "Approve for me" mode;
    "Full access" is an explicit user opt-out).
  - [ ] **API keys are plaintext on disk** — provider keys, connector keys
    (MP/FRED), and the Jupyter token all land in `opencode.json` (not only the
    mode-600 `auth.json` P2-3 describes). The keychain revert (P2-3) was a
    deliberate call for signed-release reasons; revisit for signed releases.
    **Both interim minimums are now met (2026-07-06):** the `/global/config`
    surface requires auth (see the CORS/auth fix above), and the config is no
    longer world-readable — the app-private runtime root is chmod 700 and
    `opencode.jsonc` 600 on every start and after every Rust-side write
    (verified: the sidecar's own PATCH rewrite preserves the 600 mode).
    (Verified clean: no keys in provenance/logs/localStorage/git.)

  **Critical — Rust defects:**
  - [x] **Windows command injection** in `open_url`/`os_open`. ~~`cmd /C
    start "" <arg>` lets `cmd` re-parse `&`/`^`/`|`, so an agent-emitted link
    like `https://x.com/?a=1&calc` executes `calc`; also breaks any legit URL
    containing `&`.~~ **Fixed (2026-07-06):** both now go through the `opener`
    crate — verified in its source to call `ShellExecuteW` on Windows (no
    shell re-parsing), `open` on macOS, `xdg-open` on Linux — and it reaps the
    helper process (the old spawn-and-forget leaked a zombie per open). The
    http(s)-only scheme gate stays (tested); `opener` cross-compiles for
    `x86_64-pc-windows-msvc` (full Windows build remains CI's job, P1-4).
  - [x] **Kernel deadlock.** ~~`kernel_execute` holds the global kernel-map
    mutex across an unbounded blocking `read_line`; a `while True: pass` cell
    wedges every kernel command including `kernel_reset` — only an app restart
    recovers.~~ **Fixed (2026-07-06):** per-kernel locks — the map mutex is
    held only for lookup/insert/remove, each kernel carries an `io` lock (per
    cell) and an independent `child` lock (kill/reap), so reset always
    proceeds; killed kernels are `wait()`ed (no zombies — also closes that
    Moderate item for kernels). `kernel_reset` can now target exactly one
    notebook's kernel, and the notebook UI shows an always-visible **Stop**
    on the running cell that restarts that kernel and marks the cell
    "Interrupted". Verified by a test that hangs a REAL Python kernel on
    `while True: pass`: reset returns promptly, the blocked cell errors out,
    the next run respawns.

  **Moderate — robustness:**
  - [x] ~~Sidecar restart logic is copy-pasted with no lifecycle lock:
    concurrent calls can double-spawn and orphan a child.~~ Fixed 2026-07-06:
    one `restart_sidecar()` — the kill→spawn runs while holding the child
    mutex (the lifecycle lock), used by all four config-changing commands.
  - [ ] No liveness supervision: a crashed sidecar/Jupyter stays "running"
    (`runtime.rs:286`, `jupyter.rs:250` ignore the `Terminated` event); OpenCode
    orphans on force-quit (Jupyter has pid-file cleanup, the sidecar doesn't).
    ~~Killed kernels are never `wait()`ed → zombies~~ — fixed 2026-07-06 with
    the kernel-deadlock rework (every kill reaps).
  - [ ] Blocking work on async workers: dialog calls park tokio workers
    (`runtime.rs:393`, `artifact_file.rs:397,485`); `record_provenance` holds
    its mutex across `pip freeze` and re-parses the whole JSONL per write
    (`provenance.rs:225,268-283`).
  - [x] ~~Windows Jupyter token is guessable (`pid + nanos`)~~ — fixed
    2026-07-06 (shared CSPRNG `random_hex`). ~~`detect_tools` probes without
    `enriched_path()`, so Finder-launched apps misreport Python/R/uv as
    missing~~ — fixed 2026-07-06 (probes search the same enriched PATH the
    kernel and agent use; tested).

  **Cleanup — structure (not urgent):**
  - [ ] Split `lib/runtime.ts` (1,014 lines, ~6 concerns): extract the pure
    fold/history reducers and connection/retry; stop hardcoding `OpenScience/`
    in `tidyToolTitle` (`runtime.ts:835`).
  - [ ] Extract ProvidersCard/McpCard from `SettingsPage.tsx` (903 lines, 20
    `useState`, zero tests) following the existing ClusterCard pattern.
  - [ ] Hot-path rerenders: no-selector `useRuntimeStore()` in `Sidebar.tsx:22`,
    `SettingsPage.tsx:51`, `SkillsPage.tsx:13` rerenders per SSE token — use
    selectors.
  - [ ] Delete dead entities: 10 empty `features/*` dirs,
    `lib/{api,events,store,theme}/`, 5 empty `components/*` dirs, README-only
    `packages/ui`; remove the unused `xlsx` CDN-tarball dep
    (`package.json:45` — code uses exceljs).
  - [ ] Schema duplication: `ProvenanceRecord` + MIME registries are
    hand-mirrored TS↔Rust with no schema-version field — add a version field +
    a cross-language round-trip fixture test.
  - [ ] Bundle: three.js is statically imported (~600 KB in the initial bundle
    via `MeshView.tsx:3`) — lazy-load it; `debug_log.rs` has no rotation.

---

## P1 — Strong differentiators (win vs. the criticism)

### P1-1 · Multi-discipline from day one (don't be "life-sciences only") — 🟡 Partial

- **Evidence.** A top criticism: too biology-centric — one user found **zero**
  non-bio connectors. Community demand is broad and self-organizing: physicists,
  chemists, geoscientists, and social scientists are all **building their own
  Skills/MCPs** to fill AI's gaps (K-Dense's 140 skills, Materials Project's
  official MCP, `astro_mcp`, GIS Copilot, Crawfurd's economics skills) — proof the
  pain is real and no one has yet unified them into one reproducible workbench.
- **Requirement.** Architect for a **multi-discipline plugin marketplace**
  (MCP/Skills); adding a field requires no core code change. Ship depth for a few
  fields at a time; make extensibility visible so non-bio users see a path in.
- **Acceptance.** At least one non-bio example project ships alongside the bio
  demo; a new field's connector needs no core change.
- **Status.** 🟡 Skills + MCP management shipped and pluggable; non-bio showcase
  shipped (`examples/climate-trends/`, real NASA GISTEMP v4, bundled, one-click).
  Non-bio depth now spans all five targeted disciplines via connectors
  (P1-2), domain viewers (P1-3), and correctness gates (P0-5: physics/earth/
  biology/chemistry). Gap: deeper per-field coverage (astronomy catalogs, a
  social-science correctness gate) continues under P1-2 / P1-3 / P1-6.

### P1-2 · Domain connectors (databases + literature) — 🟡 Partial

- **Evidence.** Connectors are a genuine highlight but *"strong for life sciences,
  weak elsewhere."* Agents hallucinate dataset names and mismatch coverage when
  no grounded catalog exists: *"failed to autonomously locate authoritative
  datasets, instead hallucinating dataset names."* The biggest whitespace is
  discipline-specific databases outside biology.
- **Requirement.** Curated one-click MCP connectors, plus a documented
  bring-your-own path. Provide **executable access paths / catalog metadata** (not
  just keyword search) so the agent stops inventing datasets. Coverage targets by
  discipline:

  | Discipline | Connectors | Status |
  |---|---|---|
  | Literature (all) | arXiv, PubMed, Crossref, Semantic Scholar; OpenAlex | ✅ shipped (paper-search-mcp) |
  | Biology | PubMed, trials, variants (biomcp); PDB/UniProt/ChEMBL/ClinVar | 🟡 partial |
  | Physics/astro | Space weather (`spaceweather-mcp` — NOAA SWPC/NASA DONKI/USGS) ✅ shipped; NASA ADS, SIMBAD, VizieR, MAST/IRSA, Gaia, SDSS/DESI, GWOSC/LIGO next | 🟡 partial |
  | Chemistry/materials | Materials Project (`mcp-materials-project`) ✅ shipped; PubChem, ChEMBL, ICSD, COD, NIST next | 🟡 partial |
  | Earth/climate | Open-Meteo weather/climate (`mcp-weather-server`) ✅ + USGS water (`usgs-mcp`) ✅ shipped; NASA Earthdata, Copernicus/Sentinel, CDS/ERA5, NOAA CDO, GEE, ESGF/CMIP6 next | 🟡 partial |
  | Social science | FRED (`fred-mcp`) ✅ shipped; IPUMS API, ICPSR, OSF, GSS, World Bank next | 🟡 partial |

- **Acceptance.** From chat, query literature (PubMed/arXiv/Crossref) auditable by
  the reviewer, plus **at least one non-bio domain database per targeted
  discipline**; the BYO-MCP path is documented and works.
- **Status.** 🟡 Literature + bio + **five non-bio** connectors ship with
  one-click Enable (isolated env via bundled uv) + `docs/CONNECT_YOUR_TOOLS.md`,
  now spanning **all five targeted disciplines** — the acceptance's "≥1 non-bio
  domain database per targeted discipline" is met: **Materials Project**
  (`mcp-materials-project`, materials), **FRED** (`fred-mcp`, economics),
  **Space weather** (`spaceweather-mcp` — NOAA SWPC/NASA DONKI/USGS, physics),
  **Open-Meteo weather/climate** (`mcp-weather-server`, earth), and **USGS water**
  (`usgs-mcp`, earth). The catalog carries a discipline chip, a per-connector
  free-API-key field (passed via the MCP `environment`, never into
  provenance/logs), and console-script *or* `-m module` launch (resolved next to
  the managed interpreter, cross-platform). **Every connector is verified by a
  real MCP `initialize`/`tools/list` stdio handshake in the bundled-uv env
  before shipping** (spaceweather → 15 tools, open-meteo → 8, usgs → 10; the
  three no-key ones need no credentials at all) — the discipline that caught two
  false friends earlier (`astro-mcp` is Airflow, not astronomy; earlier
  usgs/open-meteo doubts were an inadequate check, now disproven by the real
  handshake). We integrate existing open-source servers, not reimplement them.
  Gap: the classic astronomy catalogs (NASA ADS, SIMBAD, Gaia, MAST) have no
  pip-installable stdio MCP yet — GitHub-only, would need vendoring; and more
  chem/social DBs (see the table).

### P1-3 · Scientific renderers (native viewers) — 🟡 Partial

- **Evidence.** Community explicitly *"likes the visualization."* Chatbots
  demonstrably **cannot depict** domain objects (C&EN caffeine test: five-bond
  carbons; wrong formulas), so native viewers are a real differentiator.
- **Requirement.** Native, in-app renderers, publication-grade by default (see
  P1-5). Priority by discipline:

  | Viewer | Discipline | Status |
  |---|---|---|
  | PDF / tables / matplotlib / plotly | all | ✅ shipped |
  | Office (docx/xlsx/pptx), markdown-as-paper, 3D mesh (stl/obj/ply/gltf/glb) | all | ✅ shipped |
  | 3D molecule/crystal (3Dmol: cif/pdb/mol/xyz/… + SMILES) | chem/bio | ✅ shipped |
  | Genome tracks (BED/bedGraph/GFF3/GTF/VCF) | biology | ✅ shipped |
  | Band structure / DOS + phase diagrams | materials | ✅ DOS (DOSCAR) + band structure (EIGENVAL) + binary phase diagram (`.phase`) all shipped |
  | FITS sky map (WCS) / spectra / corner plots | physics/astro | 🟡 image + spectrum shipped |
  | Climate anomaly maps (Cartopy: correct transform/projection, diverging colormap) | earth | 🟡 shipped (`.anom` map viewer) |
  | Qualitative-coding two-way traceback (code/theme ↔ source span, no invented quotes) | social science | 🟡 shipped (`.qcode` viewer) |

- **Acceptance.** PDF, tables, and matplotlib/plotly render natively without
  export; **at least one domain renderer per targeted discipline** ships.
- **Status.** 🟡 Base previews + **four** domain viewers shipped, offline from
  the file alone: interactive 3D structures (3Dmol), native genome tracks, a
  native **FITS astronomy viewer** (`lib/fits.ts` + `FitsView.tsx` — a
  dependency-free FITS reader rendering a 2-D image HDU to a canvas with a
  scientific colormap + linear/log/asinh stretch + colorbar + WCS hover readout,
  or a 1-D spectrum as a line chart), and a native **materials DOS viewer**
  (`lib/dos.ts` + `DosView.tsx` — parses VASP DOSCAR total DOS; spin-up above the
  axis and spin-down mirrored below, Fermi level marked, E−E_F alignment toggle,
  app chart palette). A previewer registry that is now filename-aware
  (`previewKindForName`) recognizes extensionless scientific files like DOSCAR.
  a native materials **DOS viewer** (DOSCAR), and a native **qualitative-coding
  traceback** viewer (`lib/qcode.ts` + `QCodeView.tsx`) for social science — a
  `.qcode` JSON of sources + codebook + span annotations, rendered as the source
  text with highlighted coded spans and a two-way code↔span link; every
  highlight is sliced straight from the source (`source.slice(start,end)`), so a
  code can never surface an invented quote (the decisive integrity property,
  pairs with P1-6), with out-of-range/unknown-code annotations flagged. Verified
  against real astropy FITS, hand-crafted DOSCAR, and a coding fixture (parser +
  component tests each). Plus a native **climate-anomaly map** (`lib/anomaly.ts`
  + `AnomalyMapView.tsx`) for earth science — parses a gridded `.anom` field
  (long CSV `lat,lon,value` or a labeled grid) and renders it on an
  equirectangular (plate carrée) projection with a zero-centered diverging
  colormap (blue↔white↔red), a graticule with °N/°S/°E/°W labels, a colorbar,
  and a lat/lon/value hover readout — the correct-transform + diverging-colormap
  the discipline expects. **All four target disciplines now have a native domain
  viewer**, and materials has the full **band-structure + DOS** pair
  (`lib/bands.ts` + `BandView.tsx` parses VASP EIGENVAL and plots every band
  across the k-point path, spin-up/down in two colors), and a **binary
  phase-diagram** viewer (`lib/phase.ts` + `PhaseView.tsx` — parses a `.phase`
  JSON of entries, computes the lower convex hull to mark stable vs metastable
  phases with their energy above hull, and plots formation energy vs composition
  with the hull tie-lines) — the materials **DOS + band + phase** trio is now
  complete. Gap: FITS corner plots; ternary phase diagrams; richer basemaps
  (coastlines) for the anomaly map.

### P1-4 · Cross-platform installer incl. Windows — 🟡 Partial

- **Evidence.** Competitor's official entry lists only Mac/Linux; HN noted Linux
  friction. Shipping Windows/macOS/Linux reads as consumer-grade.
- **Requirement.** One-click installers for macOS **and** Windows (Linux next);
  first launch works without CLI knowledge.
- **Acceptance.** A non-technical user installs and reaches a working first
  session on both macOS and Windows via a signed installer.
- **Status.** 🟡 macOS installer shipped; sidecars bundled. Windows CI pipeline in
  place (matrix produces the NSIS `.exe` and the `.msi`; both sidecar fetch scripts emit the
  Windows binaries) and cross-platform paths audited (fixed a Windows-only
  orphaned-jupyter cleanup gap). Gap (host-bound): producing + code-signing the
  Windows installer and verifying a real first-run need a Windows machine/CI.

### P1-5 · Interaction & visualization craft (the app must feel premium) — 🟡 Partial

- **Evidence.** The recurring "old wine, new bottle / just Jupyter + a chatbot"
  criticism is really about **undifferentiated UX**. Polish separates a workbench
  from a wrapper.
- **Requirement.** (1) **Beautiful charts by default** — one coherent design
  system: consistent, accessible categorical/sequential palette working in light
  **and** dark; readable axes/legends/tooltips; no default library chrome; wide
  content scrolls in its own container. (2) **High-quality interactions** —
  streaming output; live tool-call refresh; smooth artifact open/version-switch;
  keyboard-first command palette; no jank/layout shift; virtualized lists; lazy
  figures; instant, reliable first-run and file-open.
- **Acceptance.** (a) A generated figure and a native dashboard tile share the
  palette and render in light+dark. (b) Core flows (open artifact, switch version,
  run cell, approve plan) have no visible jank. (c) The command palette reaches
  every primary action.
- **Status.** 🟡 One documented chart design system — a validated
  categorical/sequential/status palette as single source of truth in three synced
  places (`@ai4s/shared` chartPalette, `index.css --series-*`,
  `openscience.mplstyle` applied by the `publication-figures` skill) — so agent
  matplotlib and native UI read as one system in light+dark. Command palette
  reaches every primary action; live streaming text + file-path tool rows;
  per-session panes + scroll memory; slimmed one-line session header. **Native
  categorical chart surface shipped:** any CSV/table preview now has a Table ↔
  Chart toggle (`lib/tableChart.ts` + `TableChart.tsx`) — it auto-detects numeric
  columns (tolerating `%`, thousands separators, NA), picks a sensible default
  (categorical X → grouped bar, numeric X → line), and renders line/bar/scatter
  with the SAME `--series-*` palette the agent's matplotlib figures use, in
  light+dark, with X/Y column pickers and a legend. So a generated figure and
  this native chart tile share one palette (acceptance (a)). Gap: broader
  interaction polish (virtualized lists, lazy figures).

### P1-6 · Social-science analysis integrity — 🟡 Partial · NEW

- **Evidence.** Social science's decisive risk is **sycophantic
  misinterpretation** and silent p-hacking, plus poor reproduction of proprietary
  stats software. Pepinsky's rule: *"Use agentic AI for tasks that involve
  following rules. Do not use agentic AI for tasks that generate answers,
  arguments, or interpretations."* Documented: ChatGPT mixing SPSS with other
  languages, *"Zero out of three answers provided usable syntax-code"*; identical
  prompts yield divergent outputs, *"exacerbating the replication crisis."*
- **Requirement.** (a) An **execute-don't-interpret** boundary: run analyses and
  surface raw output, but withhold or clearly flag causal / "provocative"
  interpretation. (b) **Preregistration-aware** checks: compare the executed
  pipeline against a registered analysis plan and flag deviations (guards
  HARKing). (c) Verified Stata (.dta)/SPSS (.sav)/R execution with fixed seeds and
  per-numeric-claim traceability (script + line + output).
- **Acceptance.** The workbench runs a regression and surfaces coefficients/SEs
  without volunteering causal claims; a deviation from a stated analysis plan is
  flagged; a `.dta`→R round-trip reproduces the same estimates.
- **Status.** 🟡 Shipped as the bundled `stats-integrity` skill
  (`runtime/skills/core/stats-integrity/stats_integrity_check.py`, stdlib-only,
  same `review` contract as P0-4/P0-5 via a new `integrity` check + per-finding
  `tag`). (a) **execute-don't-interpret** — the skill instructs surface-estimates,
  no volunteered causal claims, and a deterministic **stats · interpretation**
  check flags causal/provocative language over an association in a report. (b)
  **prereg-aware** — a **stats · prereg** check parses regression formulas in the
  code and flags predictors/interactions absent from a `preregistration.*` /
  `analysis_plan.*` plan (HARKing guard). (c) **reproducible/verified execution**
  — a **stats · seed** check flags randomised analysis with no fixed seed, and
  the skill documents the `.dta`/`.sav`→R (`foreign`/`haven`) round-trip;
  **verified on this host** that pandas→`.dta`→R OLS reproduces identical
  estimates (β=0.600870, SE=0.075000 both sides). 13 validator tests; CLI catches
  all three risks on a realistic workspace. Gaps: a first-class in-app
  preregistration artifact + automatic pipeline↔plan diff on every run;
  packaged Stata/SPSS reader UI; deeper wrong-test-selection detection.

---

## P2 — Important, later (address remaining pain and objections)

### P2-1 · Notebook interactivity **and** larger-project handling — ✅ Done

- **Evidence.** Users want Jupyter-style interactivity *and* IDE-grade handling of
  bigger projects. Recurring complaint: notebooks often need a full from-scratch
  rerun; agents miss kernel state.
- **Requirement.** Conversation-first runnable notebooks without the
  "rerun-everything" trap (persistent kernel, per-cell reruns, agent edits picked
  up via reload); a path for multi-file projects.
- **Acceptance.** Editing/agent-editing one cell does not force a full rerun;
  variables persist across cells and turns.
- **Status.** ✅ Persistent kernel + per-cell run + reload + session↔notebook
  chips; one kernel per notebook with cwd = the notebook's folder (relative paths
  resolve from any page, no state bleed between notebooks). Multi-file handling
  shipped: a native workspace **Files** explorer browses the whole project tree
  and opens ANY file in the native viewers. (Large-file streaming → P0-6.)

### P2-2 · HPC / SSH / Slurm / Modal compute management — 🟡 Partial

- **Evidence.** Interest in HPC login nodes and Slurm batch submission; the
  local-server + browser-UI shape is the way into restricted clusters. Researchers
  want agents to speak sbatch natively; data-to-compute (agent goes to the data)
  keeps large/sensitive data in place.
- **Requirement.** Manage environments across laptop/Linux box/HPC login node;
  write/submit/manage Slurm batch scripts over SSH; optional Modal runner.
- **Acceptance.** From the app, generate a Slurm batch script, submit over SSH,
  and track job status.
- **Status.** 🟡 SSH + Slurm core shipped: Settings "Cluster (HPC)" card (pick a
  host from `~/.ssh/config` or type `user@host`, probe SSH + Slurm, live job queue
  with cancel — via the user's own keys, nothing installed on the cluster); the
  `hpc-slurm` skill writes a batch script (provenance-tracked), submits over SSH,
  tracks via squeue/sacct, and fetches results. **Modal runner shipped** (same
  drive-the-user's-own-creds shape): a Rust `modal_status` command detects the
  user's `modal` CLI + token (`~/.modal.toml` / `MODAL_TOKEN_ID`), a Settings
  "Cloud compute (Modal)" card shows readiness with a fix hint, and the bundled
  `modal-run` skill writes a Modal function into the workspace, runs it with the
  user's token (pinned image + fixed seed for reproducibility, cost-aware), and
  captures results as artifacts. Gap: multi-environment management; a live Modal
  run needs the user's own account (detection verified; the app never handles
  Modal tokens).

### P2-3 · Privacy posture, stated plainly — ✅ Done

- **Evidence.** Users ask whether handing whole-genome/clinical data to a
  commercial company is safe; the strong requirement is that unpublished/PHI data
  never leaves the institution.
- **Requirement.** A clear in-product statement of what stays local vs. what a
  model provider sees; keys in OS keychain/credential manager; nothing sensitive
  in provenance/logs/exports (a non-negotiable safety default).
- **Acceptance.** A user can read, in the app, exactly what leaves the machine for
  their provider; audit confirms keys/data never enter provenance, logs, exports.
- **Status.** ✅ Workspace sandbox + approval mode + plain-language data-flow card;
  credentials never enter provenance/logs/exports and live in an app-private
  `auth.json` (mode 600, owned by OpenCode). An OS-keychain-at-rest variant was
  built and verified but reverted: on unsigned/self-built copies a signature
  change makes macOS prompt for the login-keychain password every launch — worse
  first-run UX for a marginal at-rest gain. Kept simple per "如无必要,勿增实体".
  (Revisit for signed releases.)

### P2-4 · Beta stability & guardrails — 🟡 Partial

- **Evidence.** Early competitor reports: "can't open project files," first-try
  crashes, Linux download issues. Also fear of AI review noise leaking outward.
- **Requirement.** Robust first-run and file-open paths; restrict autonomous
  behavior to verifiable tasks with human-in-the-loop; don't push auto-generated
  review noise outward.
- **Acceptance.** Open/close/reopen a project reliably; the agent asks approval on
  destructive/outward-facing actions; reviewer output stays in-app.
- **Status.** 🟡 Approval mode + sandbox shipped; the agent's interactive requests
  (question pick-an-option + permission prompts) render as answerable cards via
  OpenCode's directory-scoped API (previously hung the session). Fixed a real
  exit-cleanup bug: on macOS Cmd+Q the app exits via `RunEvent::Exit` (not
  `ExitRequested`), so the sidecar/kernel/Jupyter used to orphan on every quit;
  cleanup now runs on both events. **File-open hardening:** the preview size cap
  was ineffective — `read_artifact` read the *entire* file into memory before
  checking the 25 MB cap, so a multi-GB file could OOM/freeze the app during the
  read. Fixed to stat the file first (`metadata().len()`) and reject early, so an
  oversized file never loads; the UI now shows a helpful "too large to preview"
  card with an Open-externally action and a pointer to the large-file probe
  (Rust cap-helper test + 2 component tests). Gap: a broader first-run
  self-check/recovery pass.

---

## Priority summary

| # | Requirement | Tier | Status |
|---|---|---|---|
| P0-1 | Full workflow end to end (not chat) | P0 | ✅ Done — starters + real-data example |
| P0-2 | Local data + local compute | P0 | ✅ Done — local Python **and** R + data-flow card |
| P0-3 | Artifact provenance / reproducibility | P0 | ✅ Done — versioned records + env/package lockfile + Reproduce |
| P0-4 | Reviewer: traceable claims (3 checks) | P0 | 🟡 Partial — 3 checks + PDF-manuscript extractor shipped; weak-model robustness pending |
| **P0-5** | **Domain-correctness gates ("runs" ≠ "right")** | **P0** | 🟡 **Partial — 5 gates ship (physics/earth/biology/chemistry/social science), deterministic + pluggable; chemistry now uses real RDKit round-trip when installed; only POSCAR→pymatgen round-trip pending** |
| P0-6 | Large files: reference, don't load | P0 | ✅ Done — memory-pointer probe (table/parquet/hdf5/fits/netcdf/log + genomics FASTQ/FASTA/VCF/BAM, GRIB, ROOT) + one-click "Inspect without loading" in the too-large-preview card |
| **P0-7** | **Safety-defaults compliance + audit debt** | **P0** | 🟡 **Partial — ALL critical items addressed (approval modes, sidecar/preview auth, kernel deadlock, Windows injection, owner-only key files); keychain-at-rest deferred to signed releases (P2-3); moderate/cleanup backlog remains** |
| P1-1 | Multi-discipline from day one | P1 | 🟡 Partial — pluggable + climate example; non-bio depth pending |
| P1-2 | Domain + literature connectors | P1 | 🟡 Partial — literature/bio + non-bio across ALL 5 disciplines (materials, economics, physics space-weather, earth Open-Meteo + USGS) shipped, each MCP-handshake verified; astronomy catalogs (no PyPI MCP) + more chem/social DBs pending |
| P1-3 | Scientific renderers | P1 | 🟡 Partial — base + 3D structure + genome + FITS + DOS + band + phase + qualitative-coding + anomaly map (all 4 disciplines; materials trio complete); ternary/coastlines next |
| P1-4 | Windows + macOS installers | P1 | 🟡 Partial — macOS done; Windows CI ready (signing/verify host-bound) |
| P1-5 | Interaction & visualization craft | P1 | 🟡 Partial — chart system + palette + command palette + native table→chart surface shipped |
| **P1-6** | **Social-science analysis integrity** | **P1** | 🟡 **Partial — stats-integrity skill: interpretation/prereg/seed checks + verified .dta→R round-trip** |
| P2-1 | Notebook + larger-project handling | P2 | ✅ Done — notebook + workspace Files explorer |
| P2-2 | HPC / SSH / Slurm / Modal | P2 | 🟡 Partial — SSH+Slurm + Modal (detection + skill) shipped; multi-env mgmt pending |
| P2-3 | Plain-language privacy posture | P2 | ✅ Done — disclosure + creds in mode-600 file |
| P2-4 | Beta stability & guardrails | P2 | 🟡 Partial — prompts + exit-cleanup + large-file-preview OOM guard fixed; broader first-run pass pending |

**What's done vs. what's next.** The shared 80% (the moat) is largely ✅: workflow
runtime, local compute, provenance, notebooks, privacy. The next frontier is the
discipline-specific 20% and the one cross-cutting gap this revision adds:

1. **P0-5 domain-correctness gates** — the deterministic, pluggable layer now
   ships with five gates (physics/earth/biology/chemistry/social science); next
   is the remaining library round-trip (POSCAR→pymatgen validity — SMILES→RDKit
   now ships).
2. **P1-2 / P1-3 non-bio connectors + viewers** — connectors now span all five
   targeted disciplines (materials, economics, physics space-weather, earth
   Open-Meteo/USGS); next is astronomy catalogs (no PyPI MCP yet) and richer
   viewers.
3. **Deepen the shipped gates** — P0-5 (library round-trip + social science),
   P1-6 (in-app prereg artifact + Stata/SPSS UI). **P0-6 is now ✅ Done** — the
   probe covers genomics/GRIB/ROOT and the UI exposes it as one-click "Inspect
   without loading".

## What to say (and not say)

- **Say:** reproducible, traceable, verifiable, local-first, multi-discipline,
  model-agnostic, cross-platform (incl. Windows), beautiful & polished.
- **Don't say:** "open-source Claude Science," "zero hallucination," "replaces
  your specialized tools." We aggregate tools into one workbench; we don't
  replace them.
