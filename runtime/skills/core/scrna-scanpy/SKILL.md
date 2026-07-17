---
name: scrna-scanpy
description: Use when the user asks to analyze single-cell RNA-seq (scRNA-seq) data, or mentions Scanpy, Seurat, AnnData, h5ad, Cell Ranger, scRNA clustering, UMAP, t-SNE on single-cell data, or cell-type annotation. Detects input format (h5ad, 10X Cell Ranger output, CSV count matrix), runs QC → normalization → feature selection → dimensionality reduction → clustering → marker genes → visualization, and produces a provenance-tracked report with UMAP, marker table, and QC plots.
---

# Single-cell RNA-seq analysis (Scanpy)

Run a complete scRNA-seq pipeline from raw data to publication-ready UMAP,
cluster markers, and QC diagnostics. The pipeline is **generated as Python
code** — you write the script, the agent runs it, and every output is
provenance-tracked.

## 1 · Detect input data

Probe the workspace for scRNA-seq inputs:

1. **h5ad file** (`.h5ad`): AnnData object, ready for Scanpy.
2. **10X Cell Ranger output** (`filtered_feature_bc_matrix/` with `matrix.mtx`,
   `barcodes.tsv`, `features.tsv`): read with `sc.read_10x_mtx()`.
3. **CSV/TSV count matrix** (genes × cells): read with `sc.read_csv()`.

Always use the `large-file` skill to probe data files first:

```bash
python "$XDG_CONFIG_HOME/opencode/skills/large-file/large_file_probe.py" DATA_FILE
```

For h5ad files, the probe returns: cell count, gene count, available
annotations (`.obs` columns), and layer names.

## 2 · Generate the pipeline script

Generate `scrna_pipeline.py` with these steps:

### 2a · Load data
```python
import scanpy as sc
import pandas as pd
import numpy as np

# Detect input format
adata = sc.read_h5ad("input.h5ad")
# OR: adata = sc.read_10x_mtx("filtered_feature_bc_matrix/")
# OR: adata = sc.read_csv("counts.csv").T  # transpose: genes × cells → cells × genes
```

### 2b · QC filtering
```python
# Mitochondrial gene percentage
adata.var["mt"] = adata.var_names.str.startswith("MT-")
sc.pp.calculate_qc_metrics(adata, qc_vars=["mt"], percent_top=None, log1p=False, inplace=True)

# QC plots
sc.pl.violin(adata, ["n_genes_by_counts", "total_counts", "pct_counts_mt"],
             jitter=0.4, multi_panel=True)

# Filter
sc.pp.filter_cells(adata, min_genes=200)
sc.pp.filter_genes(adata, min_cells=3)
adata = adata[adata.obs.pct_counts_mt < 20, :]  # adjust threshold per tissue
```

### 2c · Normalization + feature selection
```python
sc.pp.normalize_total(adata, target_sum=1e4)
sc.pp.log1p(adata)

# Highly variable genes
sc.pp.highly_variable_genes(adata, min_mean=0.0125, max_mean=3, min_disp=0.5)
sc.pl.highly_variable_genes(adata)
adata = adata[:, adata.var.highly_variable]
```

### 2d · Scaling + PCA
```python
sc.pp.scale(adata, max_value=10)
sc.tl.pca(adata, svd_solver="arpack")
sc.pl.pca_variance_ratio(adata, log=True)  # choose n_pcs from the elbow
```

### 2e · Neighborhood + clustering + UMAP
```python
sc.pp.neighbors(adata, n_neighbors=10, n_pcs=30)  # adjust n_pcs from elbow
sc.tl.leiden(adata, resolution=0.5)  # adjust resolution for expected cluster count
sc.tl.umap(adata)
sc.pl.umap(adata, color=["leiden"])
```

### 2f · Marker genes
```python
sc.tl.rank_genes_groups(adata, "leiden", method="wilcoxon")
sc.pl.rank_genes_groups(adata, n_genes=20, sharey=False)

# Export marker table
result = adata.uns["rank_genes_groups"]
markers = pd.DataFrame({
    group: result["names"][group][:100]
    for group in result["names"].dtype.names
})
markers.to_csv("marker_genes.csv", index=False)
```

### 2g · Save outputs
```python
adata.write("processed.h5ad")
```

## 3 · Run domain-check

After generating the script, run the domain-correctness gate:

```bash
python "$XDG_CONFIG_HOME/opencode/skills/domain-check/domain_check.py" scrna_pipeline.py
```

Common findings to fix:
- **biology · normalization**: `scale()` before `normalize()` — always normalize
  first, then log-transform, then scale.
- **biology · normalization**: Using raw counts for PCA without normalization.

## 4 · Execute the pipeline

```bash
python scrna_pipeline.py
```

If the data is large (>100k cells), consider running on a remote machine via
the `remote-compute` skill.

## 5 · Record provenance

```bash
python "$XDG_CONFIG_HOME/opencode/skills/remote-compute/record_run.py" \
  --surface local --command "python scrna_pipeline.py" \
  --status ok --host "$(hostname)" \
  --hardware "$(nproc) CPU cores, $(free -h | awk '/Mem:/{print $2}') RAM" \
  --code scrna_pipeline.py \
  --output processed.h5ad --output marker_genes.csv --output umap.png \
  --env-file env.txt \
  --session-id "$(cat .openscience/session.txt 2>/dev/null)"
```

## 6 · Summarize

Report:
- Number of cells after filtering (and % removed).
- Number of clusters found.
- Top 5 marker genes per cluster (table).
- UMAP plot colored by cluster.
- QC violin plots (n_genes, total_counts, pct_mt).
- Any warnings from `domain-check`.
- Link to the processed h5ad and marker gene CSV.
