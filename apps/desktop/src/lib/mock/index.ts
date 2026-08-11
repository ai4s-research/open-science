import type { Project, Session } from "@ai4s/shared";
import {
  ariCurve,
  biorxivShot,
  citationScatter,
  subfieldBars,
  umapAtlas,
  umapBySite,
} from "./figures";

// ---- Session 1: figure canvas + artifact inspector (reference shot 1) ----

const figureSession: Session = {
  id: "figure-canvas",
  projectId: "cross-species",
  title: "Cross-species atlas figure",
  group: "Examples",
  status: "done",
  blocks: [
    {
      kind: "agent",
      markdown:
        "Rendered `atlas_fig1a.png` from the shared 138-species embedding. Callouts and inset boxes are driven by `fig4_atlas_callouts.csv`.",
    },
    {
      kind: "figure",
      title: "atlas_fig1a.png",
      src: umapAtlas,
      caption: "138 species · 5,672 cell types · one shared embedding",
      annotations: [{ index: 1, note: "these labels are hard to see", x: 72, y: 64 }],
    },
  ],
  inspector: {
    variant: "artifact",
    title: "atlas_fig1a.png",
    filename: "make_atlas_fig.py",
    versions: [
      {
        label: "v1",
        reviewPassed: false,
        code: `apply_nature_style()
centroids = pd.read_csv("fig4_atlas_centroids_m138.csv")
callouts  = pd.read_csv("fig4_atlas_callouts.csv")

HERO = {"neuron": "#5b9bd5", "muscle": "#bcbd22", "immune": "#2ca02c"}
# v1: hero palette only — insets and Arial styling not added yet`,
        executionLog:
          "$ python make_atlas_fig.py\n[ok] loaded 5,672 centroids\n[ok] wrote atlas_fig1a.png (v1)  1.0 MB  1600x1050\nfinished in 7.1s",
      },
      { label: "v2", reviewPassed: true },
    ],
    activeVersion: "v2",
    reviewPassed: true,
    inputs: ["fig4_atlas_callouts.csv", "fig4_atlas_centroids_m138.csv"],
    language: "python",
    codeStartLine: 54,
    code: `apply_nature_style()
mpl.rcParams['savefig.bbox'] = None
mpl.rcParams['font.sans-serif'] = ['Arial']
mpl.rcParams['font.family'] = 'sans-serif'

centroids = pd.read_csv("fig4_atlas_centroids_m138.csv")
boxes_df  = pd.read_csv("fig4_atlas_inset_boxes.csv")
callouts  = pd.read_csv("fig4_atlas_callouts.csv")

HERO = {"neuron": "#5b9bd5", "muscle": "#bcbd22", "immune": "#2ca02c",
        "ciliated": "#17becf", "germline": "#e377c2", "progenitor": "#ff7f0e"}

INSET_NAMES = {'a': 'ciliated cells', 'b': 'striated muscle', 'c': 'immune'}

for _, row in boxes_df.iterrows():
    tag = row.tag; fam = row.family; x0, y0, w, h = row.x0, row.y0, row.w, row.h
    target = centroids[(centroids.umap_x >= x0) & (centroids.family == fam)]
    inset_info[tag] = dict(fam=fam, xlim=(x0, x0 + w), ylim=(y0, y0 + h))`,
    executionLog: "$ python make_atlas_fig.py\n[ok] loaded 5,672 centroids\n[ok] wrote atlas_fig1a.png (v2)  1.2 MB  1600x1050\nfinished in 8.4s",
    environment: "python 3.11 · matplotlib 3.9 · pandas 2.2 · numpy 2.0\nkernel: figure-pipeline (local)",
    messages: [
      "generate the cross-species atlas figure with the hero palette",
      "add ciliated / striated-muscle / immune insets",
    ],
  },
};

// ---- Session 2: hyperparameter screen + notebook inspector (reference shot 2) ----

const sweepRows: string[][] = [];
let arm = 1;
for (const d of [10, 20, 30, 50]) {
  for (const L of [1, 2]) {
    sweepRows.push([
      String(arm),
      String(d),
      String(L),
      `d=${d} L=${L} · scVI COVID-PBMC (${arm}/8)`,
    ]);
    arm++;
  }
}

const sweepSession: Session = {
  id: "scvi-sweep",
  projectId: "cross-species",
  title: "SCVI Hyperparameter Screen",
  group: "Examples",
  status: "running",
  badge: 8,
  blocks: [
    {
      kind: "agent",
      markdown:
        "Dispatching the 8-arm scVI sweep to `lab_cluster A100s` — `n_latent ∈ {10, 20, 30, 50}` × `n_layers ∈ {1, 2}`, 40k cells × 2,000 HVGs, `batch_key=\"sample_id\"`, 50 epochs, seed 0.",
    },
    {
      kind: "table",
      columns: ["arm", "n_latent", "n_layers", "label"],
      rows: sweepRows,
    },
    {
      kind: "figure",
      title: "covid_pbmc_overview.png",
      src: umapBySite,
      caption: "Stephenson 2021 COVID PBMC — 40k cells, 2,000 batch-aware HVGs, no integration",
    },
    {
      kind: "running-jobs",
      title: "REMOTE · 8",
      jobs: [
        { label: "lab_cluster · d=10 L=1 · scVI COVID", elapsed: "16m 2s" },
        { label: "lab_cluster · d=10 L=2 · scVI COVID", elapsed: "15m 42s" },
        { label: "lab_cluster · d=20 L=1 · scVI COVID", elapsed: "15m 19s" },
        { label: "lab_cluster · d=20 L=2 · scVI COVID", elapsed: "14m 58s" },
        { label: "lab_cluster · d=30 L=1 · scVI COVID", elapsed: "14m 36s" },
        { label: "lab_cluster · d=30 L=2 · scVI COVID", elapsed: "14m 16s" },
      ],
    },
    { kind: "status-line", text: "8 running · 16m 2s", tone: "running" },
  ],
  inspector: {
    variant: "notebook",
    name: "liver-pipeline",
    live: true,
    kernelLabel: "Python — liver-pipeline kernel",
    kernelNote:
      "Connected to the agent's live kernel — variables and state are shared. Type an expression and press Enter.",
    cells: [
      {
        index: 28,
        language: "python",
        code: `import pandas as pd
pd.set_option('mode.string_storage', 'python')
import numpy as np, scanpy as sc, anndata as ad, scipy.sparse as sp

a = sc.read_h5ad("covid_pbmc_40k_hvg.h5ad")
print("loaded:", a.shape, "uns keys:", list(a.uns.keys()))

# minimal, version-portable object: counts + obs + var only
keep_obs = ["sample_id", "donor_id", "Site", "initial_clustering",
            "author_cell_type", "disease", "Status",
            "Status_on_day_collection_summary", "cell_type"]
keep_obs = [c for c in keep_obs if c in a.obs.columns]
obs = a.obs[keep_obs].copy()
clean = ad.AnnData(X=sp.csr_matrix(a.layers["counts"]), obs=obs, var=var)
clean.write_h5ad("covid_pbmc_40k_hvg.h5ad")`,
        output: "wrote covid_pbmc_40k_hvg.h5ad",
      },
    ],
  },
};

// ---- Session 3: literature review + reviewer + PDF inspector (reference shot 3) ----

const litSession: Session = {
  id: "lit-review",
  projectId: "cross-species",
  title: "Cross-species scRNA-seq Integration",
  group: "Examples",
  status: "warn",
  blocks: [
    {
      kind: "user",
      text: "Write a literature review on cross-species single-cell RNA-seq integration. Pull the primary methods papers and recent benchmarks. Output the report as a LaTeX doc and a compiled PDF.",
    },
    {
      kind: "step-summary",
      summary: "Ran 4 searches, loaded 2 skills, managed environments, +2 more",
      steps: 10,
      details: [
        "literature-review skill loaded",
        "citation-reviewer skill loaded",
        "PubMed / bioRxiv / OpenAlex / CELLxGENE searches",
        "environment: latex-report (local)",
      ],
    },
    {
      kind: "agent",
      markdown:
        "Dispatching five parallel literature-retrieval tracks — PubMed primary methods, bioRxiv preprints, OpenAlex citation counts, CELLxGENE multi-species atlas inventory, and orthology-free embedding methods.",
    },
    {
      kind: "tool-call",
      title: "Dispatching PubMed bioRxiv OpenAlex CELLxGENE sub-agents",
      status: "success",
      meta: "142 lines of output",
    },
    {
      kind: "reviewer",
      note: "The agent reads these findings and self-corrects in its next message.",
      findings: [
        {
          level: "warn",
          title: "PMID 31178118 assigned to both LIGER and Seurat v3 integration in the plan",
          evidence:
            'In the generate_plan PubMed delegation step the agent writes "LIGER (31178118), Seurat v3 integration (31178118)" — the same PMID for two distinct primary methods papers. The OpenAlex step assigns them different DOIs (Seurat v3 10.1016/j.cell.2019.05.031, LIGER 10.1016/j.cell.2019.05.006), so the plan is internally inconsistent and at least one PMID is wrong. No msg tool_result rows trace to any in-window lookup.',
        },
      ],
    },
    {
      kind: "agent",
      markdown:
        "Acknowledged — the plan listed PMID 31178118 for both; the PubMed sub-agent caught the swap and the saved CSV carries the corrected pair (LIGER 31178122, Seurat v3 31178118).",
    },
    { kind: "status-line", text: "all 5 agents done · Reviewing", tone: "review" },
  ],
  inspector: {
    variant: "pdf",
    title: "review.pdf",
    doc: {
      title: "Cross-species single-cell RNA-seq integration",
      subtitle:
        "from one-to-one orthologs to protein-language-model embeddings",
      summaryTable: {
        kind: "table",
        columns: ["Papers", "Years", "Methods", "Species pairs", "Top-cited", "Most recent"],
        rows: [
          ["24", "2018–2025", "15", "6 benchmarked", "Seurat v3 (16,935 cit.)", "TranscriptFormer (2025)"],
        ],
      },
      figure: {
        kind: "figure",
        title: "Figure 1",
        src: citationScatter,
        caption:
          "Fifteen integration methods (2018–2024) coloured by orthology strategy; OpenAlex citation counts on log scale.",
      },
      sections: [
        {
          heading: "1  Problem statement",
          body: "Comparative single-cell transcriptomics asks whether a cell type in one species has a homolog in another, and how its expression program has been conserved or rewired. The technical obstacle is that any two species' transcriptomes live in different gene coordinate systems.",
        },
        {
          heading: "2  Ortholog-subsetting methods",
          body: "Seurat v3 finds canonical-correlation vectors over the shared-ortholog matrices, then anchors mutual nearest neighbours. LIGER factorises each dataset, sharing a common W across species and isolating species-specific signal. Harmony operates post-PCA, iteratively soft-clustering and shifting centroids to maximise batch diversity within clusters.",
        },
      ],
    },
  },
};

// ---- Session 4: browser control — live web harvest into a reproducible dataset ----

const preprintsCsv = `doi,posted,subfield,title,authors
10.1101/2026.07.18.601234,2026-07-20,Systems,Thalamocortical loops shape cortical state transitions,"Okafor, Lindqvist, Zhao"
10.1101/2026.07.18.601210,2026-07-20,Cellular,Astrocyte calcium waves gate synaptic pruning in vivo,"Berg, Nakamura, Ruiz"
10.1101/2026.07.17.600998,2026-07-19,Circuits,A midbrain circuit for approach-avoidance decisions,"Haddad, Iversen"
10.1101/2026.07.17.600881,2026-07-19,Computation,Predictive coding emerges in recurrent spiking networks,"Sato, O'Neill, Krause"
10.1101/2026.07.16.600742,2026-07-18,Developmental,Timed neurogenesis sets interneuron ratios in cortex,"Meyer, Abadi"`;

const browserSession: Session = {
  id: "browser-harvest",
  projectId: "cross-species",
  title: "Live web harvest — new preprints",
  group: "Examples",
  status: "done",
  blocks: [
    {
      kind: "user",
      text: "Every Monday I skim new bioRxiv neuroscience preprints. Pull this week's, tag them by subfield, and give me a chart plus a CSV I can sort.",
    },
    {
      kind: "step-summary",
      summary: "Drove open-science-browser through bioRxiv, extracted 60 preprints, wrote a CSV",
      steps: 9,
      details: [
        "open-science-browser MCP · your Chrome profile (headed)",
        "biorxiv.org/collection/neuroscience",
        "paged 'Load more' ×3 — results are client-rendered",
        "environment: web-harvest (local)",
      ],
    },
    {
      kind: "agent",
      markdown:
        "bioRxiv's collection page renders results client-side and offers no clean feed, so I'm driving your Chrome through `open-science-browser` instead of fetching HTML. I snapshot the accessibility tree, page to the end, then read titles, authors, and subject tags straight off the DOM.",
    },
    {
      kind: "tool-call",
      tool: "open-science-browser",
      verb: "Fetched",
      title: "navigate → biorxiv.org/collection/neuroscience",
      status: "success",
      meta: "200 · 1.8s",
    },
    {
      kind: "tool-call",
      tool: "open-science-browser",
      verb: "Fetched",
      title: "snapshot → accessibility tree",
      status: "success",
      meta: "42 nodes",
      output:
        "region 'Search results' @e7\n  list @e9\n    listitem @e10  link 'Thalamocortical loops…' @e11\n    listitem @e14  link 'Astrocyte calcium waves…' @e15\n  button 'Load more' @e41",
    },
    {
      kind: "tool-call",
      tool: "open-science-browser",
      verb: "Ran",
      title: "click @e41 'Load more' · pages 2–4",
      status: "success",
      meta: "60 rows",
    },
    {
      kind: "tool-call",
      tool: "open-science-browser",
      verb: "Fetched",
      title: "eval → extract {title, authors, subject, doi}",
      status: "success",
      meta: "60 objects",
      content:
        '[{"title":"Thalamocortical loops shape cortical state transitions",\n  "subject":"Systems","doi":"10.1101/2026.07.18.601234"},\n { "title":"Astrocyte calcium waves gate synaptic pruning in vivo",\n  "subject":"Cellular","doi":"10.1101/2026.07.18.601210"}, … 58 more]',
    },
    {
      kind: "figure",
      title: "biorxiv_neuro.png",
      src: biorxivShot,
      caption: "open-science-browser · your Chrome profile · headed — the page as the agent read it",
    },
    {
      kind: "table",
      columns: ["Subfield", "New this week", "Most-discussed preprint"],
      rows: [
        ["Systems", "14", "Thalamocortical loops shape cortical state transitions"],
        ["Cellular", "11", "Astrocyte calcium waves gate synaptic pruning in vivo"],
        ["Circuits", "9", "A midbrain circuit for approach–avoidance decisions"],
        ["Cognitive", "8", "Replay compresses during offline consolidation"],
        ["Computation", "7", "Predictive coding emerges in recurrent spiking networks"],
        ["Developmental", "5", "Timed neurogenesis sets interneuron ratios in cortex"],
        ["Molecular", "4", "A presynaptic sensor tunes release probability"],
        ["Disease", "2", "Tau seeding maps onto connectome hubs"],
      ],
    },
    {
      kind: "figure",
      title: "subfield_mix.png",
      src: subfieldBars,
      caption: "60 new neuroscience preprints, tagged by subject — Systems and Cellular lead this week",
    },
    {
      kind: "tool-call",
      tool: "write",
      verb: "Created",
      title: "preprints_2026-07-20.csv",
      status: "success",
      meta: "60 rows",
      content: preprintsCsv,
    },
    { kind: "status-line", text: "60 preprints · 8 subfields · CSV + chart written", tone: "done" },
  ],
  inspector: {
    variant: "artifact",
    title: "chart_subfields.py",
    filename: "chart_subfields.py",
    versions: [{ label: "v1", reviewPassed: true }],
    activeVersion: "v1",
    reviewPassed: true,
    inputs: ["preprints_2026-07-20.csv"],
    language: "python",
    code: `import pandas as pd
import matplotlib.pyplot as plt
plt.style.use("openscience.mplstyle")  # bundled palette

df = pd.read_csv("preprints_2026-07-20.csv", parse_dates=["posted"])
counts = df["subfield"].value_counts().sort_values(ascending=False)

fig, ax = plt.subplots(figsize=(6.5, 3.6))
counts.plot.bar(ax=ax, color=plt.rcParams["axes.prop_cycle"].by_key()["color"])
ax.set_ylabel("new this week"); ax.set_xlabel("")
ax.set_title("New neuroscience preprints by subfield · this week")
fig.tight_layout()
fig.savefig("subfield_mix.png", dpi=200)`,
    executionLog:
      "$ python chart_subfields.py\n[ok] read 60 rows from preprints_2026-07-20.csv\n[ok] 8 subfields\n[ok] wrote subfield_mix.png  148 KB  1300x720\nfinished in 1.9s",
    environment:
      "python 3.11 · pandas 2.2 · matplotlib 3.9\nopen-science-browser · agent-browser (Chrome 126, your profile, headed)\nkernel: web-harvest (local)",
    messages: [
      "pull this week's neuroscience preprints, tag them by subfield",
      "make the subfield bar chart and save the CSV",
    ],
  },
};

// ---- Session 5: reproduce a published benchmark on GPU (provenance + review) ----

const reproSession: Session = {
  id: "repro-scvi",
  projectId: "cross-species",
  title: "Reproduce scVI benchmark (A100)",
  group: "Examples",
  status: "done",
  blocks: [
    {
      kind: "user",
      text: "Reproduce the scVI integration benchmark from the methods paper on our A100 and tell me whether the ARI matches within tolerance.",
    },
    {
      kind: "step-summary",
      summary: "Pinned the environment, trained scVI on 1× A100, scored ARI against the paper",
      steps: 12,
      details: [
        "uv sync --frozen · lockfile pinned",
        "seed fixed to 0 — the original run left it unset",
        "1× NVIDIA A100-SXM4-40GB · CUDA 12.2",
        "environment: scvi-repro (remote)",
      ],
    },
    {
      kind: "agent",
      markdown:
        "Cloning the benchmark, pinning the exact package set with `uv sync --frozen`, and launching training on the A100. I fix `scvi.settings.seed = 0` up front — the published script leaves it unset, which is the most likely source of any drift — and record the full environment and hardware to provenance so the run can be regenerated.",
    },
    {
      kind: "tool-call",
      tool: "bash",
      verb: "Ran",
      title: "uv sync --frozen",
      status: "success",
      meta: "3.2s",
      command: "uv sync --frozen",
      output: "Resolved 214 packages · installed 0 (lockfile satisfied)\nscvi-tools 1.1.2 · torch 2.3.1+cu122 · scanpy 1.10.2",
    },
    {
      kind: "tool-call",
      tool: "bash",
      verb: "Ran",
      title: "python train_scvi.py --seed 0 --epochs 50",
      status: "success",
      meta: "22m 14s",
      command:
        'python train_scvi.py --data covid_pbmc_40k_hvg.h5ad --batch-key sample_id --seed 0 --epochs 50',
      output:
        "Epoch 50/50 | elbo -812.4 | 1x A100-SXM4-40GB\n[ok] latent written (40,213 x 30)\n[ok] ARI vs author labels = 0.790\n[ok] wrote scvi_benchmark_ari.png",
    },
    {
      kind: "figure",
      title: "scvi_benchmark_ari.png",
      src: ariCurve,
      caption: "ARI vs. epoch · 1× A100 · seed 0 — dashed line is the published 0.80",
    },
    {
      kind: "reviewer",
      note: "The reproducibility gate ran before the result was accepted.",
      findings: [
        {
          level: "ok",
          check: "integrity",
          tag: "stats · repro",
          title: "Seed pinned before training; original benchmark left it unset",
          evidence:
            "train_scvi.py sets scvi.settings.seed = 0 and torch.use_deterministic_algorithms(True). The published script has no seed call, so its ARI varies run-to-run — the 0.010 gap is within that unseeded spread.",
        },
        {
          level: "warn",
          check: "number",
          title: "scvi-tools 1.1.2 vs the paper's 1.0.4",
          evidence:
            "Exact 1.0.4 wheels are no longer on PyPI for CUDA 12.2. Pinned the nearest reproducible build (1.1.2); changelog lists no training-path changes affecting the ELBO. Flagged so the version delta is on the record.",
        },
      ],
    },
    {
      kind: "agent",
      markdown:
        "Reproduced. Final **ARI 0.790** vs. published **0.80** (Δ 0.010, inside the ±0.02 tolerance). The gap traces to the pinned seed. Full environment, hardware, and the exact command are recorded to `.openscience/runs.jsonl` — one click regenerates it.",
    },
    { kind: "status-line", text: "reproduced · ARI 0.790 (Δ 0.010) · within tolerance", tone: "done" },
  ],
  inspector: {
    variant: "artifact",
    title: "train_scvi.py",
    filename: "train_scvi.py",
    versions: [{ label: "v1", reviewPassed: true }],
    activeVersion: "v1",
    reviewPassed: true,
    inputs: ["covid_pbmc_40k_hvg.h5ad"],
    language: "python",
    code: `import scvi, scanpy as sc, torch
from sklearn.metrics import adjusted_rand_score

scvi.settings.seed = 0                       # original left this unset
torch.use_deterministic_algorithms(True)

adata = sc.read_h5ad("covid_pbmc_40k_hvg.h5ad")
scvi.model.SCVI.setup_anndata(adata, batch_key="sample_id")
model = scvi.model.SCVI(adata, n_latent=30, n_layers=2)
model.train(max_epochs=50, accelerator="gpu", devices=1)

adata.obsm["X_scVI"] = model.get_latent_representation()
sc.pp.neighbors(adata, use_rep="X_scVI"); sc.tl.leiden(adata)
ari = adjusted_rand_score(adata.obs["author_cell_type"], adata.obs["leiden"])
print(f"ARI vs author labels = {ari:.3f}")   # -> 0.790`,
    executionLog:
      "$ python train_scvi.py --seed 0 --epochs 50\nGPU: 1x NVIDIA A100-SXM4-40GB (CUDA 12.2)\nEpoch 50/50 | elbo -812.4\n[ok] ARI vs author labels = 0.790\n[ok] wrote scvi_benchmark_ari.png\nrun_a100_scvi · 22m 14s",
    environment:
      "python 3.11 · scvi-tools 1.1.2 · scanpy 1.10.2 · torch 2.3.1 (CUDA 12.2)\nhardware: 1× NVIDIA A100-SXM4-40GB · 32 vCPU · 216 GB\nrun: run_a100_scvi · seed 0 · 22m 14s",
    messages: [
      "reproduce the scVI benchmark on our A100",
      "does the ARI match the paper within tolerance?",
    ],
  },
};

// ---- Session 6: multi-agent literature survey compiled to a PDF ----

const surveySession: Session = {
  id: "protein-lm-survey",
  projectId: "cross-species",
  title: "Research landscape — protein LMs",
  group: "Examples",
  status: "done",
  blocks: [
    {
      kind: "user",
      text: "Survey protein language models for function prediction. Fan out the search across sources, sanity-check the citations, and compile a short PDF.",
    },
    {
      kind: "step-summary",
      summary: "Ran 5 parallel search agents, loaded 3 skills, deduped, checked citations, compiled the PDF",
      steps: 14,
      details: [
        "literature-survey + citation-reviewer skills loaded",
        "PubMed / arXiv / OpenAlex / bioRxiv / benchmarks",
        "24 papers after dedup across 5 tracks",
        "environment: latex-report (local)",
      ],
    },
    {
      kind: "agent",
      markdown:
        "Dispatching five parallel retrieval tracks — PubMed/UniProt primary methods, arXiv preprints, OpenAlex citation counts, bioRxiv, and benchmark leaderboards (CAFA-5, ProteinGym) — then merging, de-duplicating by DOI, and auditing every citation before it goes in the report.",
    },
    {
      kind: "tool-call",
      tool: "task",
      verb: "Ran",
      title: "5 sub-agents · PubMed arXiv OpenAlex bioRxiv benchmarks",
      status: "success",
      meta: "318 lines",
    },
    {
      kind: "reviewer",
      note: "The citation gate ran before anything was written into the report.",
      findings: [
        {
          level: "ok",
          check: "citation",
          title: "All 24 DOIs resolve; 2 arXiv preprints matched to published venues",
          evidence:
            "OpenAlex resolved 24/24 DOIs. arXiv:2206.13517 → Nat. Methods 2023 (10.1038/s41592-023-01886-z); arXiv:2304.02311 → ICML 2023. Citation counts refreshed from OpenAlex on retrieval.",
        },
      ],
    },
    {
      kind: "agent",
      markdown:
        "Report compiled. Six model families span 2019–2025; ESM-1b remains the most-cited, with structure-aware adapters (ESM-3, SaProt) the recent frontier. Benchmarks converge on CAFA-5 and ProteinGym. Draft is in the PDF on the right.",
    },
    { kind: "status-line", text: "5 agents done · 24 papers · report.pdf compiled", tone: "done" },
  ],
  inspector: {
    variant: "pdf",
    title: "report.pdf",
    doc: {
      title: "Protein language models for function prediction",
      subtitle: "from ESM to structure-aware adapters",
      summaryTable: {
        kind: "table",
        columns: ["Papers", "Years", "Model families", "Benchmarks", "Top-cited", "Most recent"],
        rows: [
          ["24", "2019–2025", "6", "CAFA-5 · ProteinGym", "ESM-1b (7,842 cit.)", "ESM-3 (2024)"],
        ],
      },
      figure: {
        kind: "figure",
        title: "Figure 1",
        src: citationScatter,
        caption:
          "Twenty-four methods (2019–2025) coloured by model family; OpenAlex citation counts on a log scale.",
      },
      sections: [
        {
          heading: "1  Problem statement",
          body: "Predicting a protein's function from sequence alone remains open where homology is weak. Protein language models learn residue-level representations from hundreds of millions of unlabelled sequences, then transfer to function prediction with light supervision — sidestepping the alignment step that homology methods depend on.",
        },
        {
          heading: "2  Sequence-only models",
          body: "ESM-1b and ESM-2 train masked language models over UniRef and expose per-residue embeddings that linear probes turn into GO-term predictions. ProtTrans confirms the recipe transfers across architectures. Gains track scale, but plateau where function depends on structure rather than sequence context.",
        },
        {
          heading: "3  Structure-aware models",
          body: "SaProt folds a discrete structural alphabet into the token stream, and ESM-3 co-models sequence, structure, and function in one generative backbone. On ProteinGym and CAFA-5 these narrow the gap to alignment methods on remote homologs while keeping single-sequence inference.",
        },
      ],
    },
  },
};

export const mockProject: Project = {
  id: "cross-species",
  name: "Cross-species scRNA-seq",
  sessions: [figureSession, browserSession, reproSession, surveySession, sweepSession, litSession],
};

export const mockProjects: Project[] = [mockProject];

export function findSession(sessionId: string): Session | undefined {
  return mockProject.sessions.find((s) => s.id === sessionId);
}

export const defaultSessionId = litSession.id;
