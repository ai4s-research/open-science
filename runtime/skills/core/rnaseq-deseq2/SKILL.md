---
name: rnaseq-deseq2
description: Use when the user asks to analyze RNA-seq data, run differential expression, or mentions DESeq2, edgeR, limma, STAR, HISAT2, Salmon, Kallisto, featureCounts, or RNA-seq pipelines. Detects input data (FASTQ or count matrix), generates a complete analysis pipeline (alignment → quantification → DE → figures), runs it locally or on a remote cluster, and produces a provenance-tracked report with volcano plot, MA plot, and ranked gene list.
---

# RNA-seq differential expression analysis

Run a complete RNA-seq DE pipeline from raw FASTQ files or a count matrix to
publication-ready figures and a ranked gene list. The pipeline is
**generated as code** — you write the scripts, the agent runs them, and every
output is provenance-tracked.

## 1 · Detect input data

Probe the workspace for RNA-seq inputs:

1. **Count matrix** (`.csv`/`.tsv`/`.h5` with gene × sample): skip alignment,
   go directly to §4 (DESeq2).
2. **FASTQ files** (`.fastq`/`.fq`, `.gz`): full pipeline from §2.
3. **BAM files** (`.bam`): skip alignment, go to §3 (quantification).

Always use the `large-file` skill to probe data files first — never load a
FASTQ into context.

```bash
python "$XDG_CONFIG_HOME/opencode/skills/large-file/large_file_probe.py" DATA_FILE
```

## 2 · Alignment (FASTQ → BAM)

Generate a `01_align.sh` script. Choose the aligner by what is available on the
execution environment:

| Aligner | When to use | Key flags |
|---------|-------------|-----------|
| **STAR** | Default; fast, splice-aware | `--runThreadN`, `--genomeDir`, `--readFilesCommand zcat` |
| **HISAT2** | Lower memory; good for large genomes | `-p`, `--dta`, `-x`, `-U` or `-1`/`-2` |

The script must:
- Detect paired-end vs single-end from filename patterns (`_R1`/`_R2`, `_1`/`_2`).
- Use `--readFilesCommand zcat` for `.fastq.gz` files.
- Write BAM sorted by coordinate (`samtools sort`).
- Index the BAM (`samtools index`).

```bash
#!/bin/bash
set -euo pipefail

# --- Environment manifest (provenance) ---
{ python3 -V; echo "PLATFORM=$(uname -s)-$(uname -m)"; STAR --version 2>/dev/null || true; samtools --version | head -1; } > env.txt 2>&1 || true

# --- Alignment ---
STAR --runMode alignReads \
  --runThreadN 8 \
  --genomeDir "$GENOME_DIR" \
  --readFilesIn sample_R1.fastq.gz sample_R2.fastq.gz \
  --readFilesCommand zcat \
  --outSAMtype BAM SortedByCoordinate \
  --outFileNamePrefix sample_

samtools index sample_Aligned.sortedByCoord.out.bam
```

## 3 · Quantification (BAM → count matrix)

Generate a `02_quantify.sh` script:

```bash
#!/bin/bash
set -euo pipefail

featureCounts -T 8 -p --countReadPairs \
  -a "$GTF_FILE" \
  -o counts.txt \
  sample_Aligned.sortedByCoord.out.bam
```

For transcript-level quantification (Salmon/Kallisto), generate a separate
script and aggregate to gene-level with `tximport`.

## 4 · Differential expression (DESeq2)

Generate a `03_deseq2.R` script. The template must:

1. Read the count matrix and sample metadata.
2. Build a `DESeqDataSet` with the design formula.
3. Run `DESeq()`.
4. Extract results with `results()` — use `contrast` for multi-group designs.
5. Output:
   - `deseq2_results.csv` — full results table (gene, baseMean, log2FC, pvalue, padj).
   - `volcano_plot.png` — log2FC vs -log10(padj), labeled top genes.
   - `ma_plot.png` — baseMean vs log2FC.
   - `pvalue_histogram.png` — distribution of raw p-values (should be uniform
     under null with a spike near 0; a flat distribution suggests low power).

```r
library(DESeq2)
library(ggplot2)

counts <- read.csv("counts.txt", sep="\t", row.names=1, comment.char="#")
meta <- read.csv("sample_metadata.csv")

dds <- DESeqDataSetFromMatrix(
  countData = counts,
  colData = meta,
  design = ~ condition
)

dds <- DESeq(dds)
res <- results(dds, contrast = c("condition", "treatment", "control"))
res_df <- as.data.frame(res)
res_df$gene <- rownames(res_df)
write.csv(res_df, "deseq2_results.csv", row.names = FALSE)

# Volcano plot
ggplot(res_df, aes(x = log2FoldChange, y = -log10(padj))) +
  geom_point(aes(color = padj < 0.05 & abs(log2FoldChange) > 1), alpha = 0.5) +
  scale_color_manual(values = c("grey", "red")) +
  labs(title = "Volcano Plot", x = "log2 Fold Change", y = "-log10 adjusted p-value") +
  theme_minimal()
ggsave("volcano_plot.png", width = 8, height = 6)
```

## 5 · Run domain-check

After generating all scripts, run the domain-correctness gate on the R script:

```bash
python "$XDG_CONFIG_HOME/opencode/skills/domain-check/domain_check.py" 03_deseq2.R
```

Fix any findings before proceeding.

## 6 · Execute the pipeline

If the user has a remote cluster configured, use the `remote-compute` skill to
submit. Otherwise run locally:

```bash
bash 01_align.sh
bash 02_quantify.sh
Rscript 03_deseq2.R
```

## 7 · Record provenance

After execution, record every script and output file:

```bash
python "$XDG_CONFIG_HOME/opencode/skills/remote-compute/record_run.py" \
  --surface local --command "bash 01_align.sh && bash 02_quantify.sh && Rscript 03_deseq2.R" \
  --status ok --host "$(hostname)" \
  --hardware "$(nproc) CPU cores, $(free -h | awk '/Mem:/{print $2}') RAM" \
  --code 01_align.sh --code 02_quantify.sh --code 03_deseq2.R \
  --output deseq2_results.csv --output volcano_plot.png --output ma_plot.png \
  --env-file env.txt \
  --session-id "$(cat .openscience/session.txt 2>/dev/null)"
```

## 8 · Summarize

Report:
- Total genes tested, number significant (padj < 0.05, |log2FC| > 1).
- Top 10 differentially expressed genes (table).
- The volcano plot and MA plot.
- Any warnings from `domain-check`.
- Link to the full results CSV and provenance record.
