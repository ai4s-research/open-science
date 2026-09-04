---
name: domain-check
description: Use whenever you write or run scientific analysis code (physics, earth/geo, biology, chemistry, social science, or bioprocess/fermentation) in this workspace — before executing it and again after generating results. Runs a deterministic domain-correctness gate that catches code which runs but is scientifically wrong (unit/dimension mismatch, Euclidean distance on lat/lon without a CRS, 0-based/1-based coordinate and strand errors, impossible SMILES valence, uncorrected multiple comparisons, averaging a categorical code, unconstrained kinetic-parameter fits, kLa computed from raw DO instead of the driving force, arithmetic mean of raw CFU counts, ANOVA/Tukey with no assumption check, a curvature DOE design fit with a first-order model). Surfaces structured findings; never claims the code is correct.
---

# Domain-correctness gate

Across every field the top complaint is code that **executes cleanly but is
scientifically wrong**. This gate intercepts that field's classic error classes
**deterministically** — by analysing the code you actually wrote, not by
recalling rules. It verifies specific error classes; it never proves correctness.

Run it as a normal step of any analysis — it is fast, offline, and stdlib-only.

## When to run

- **Before executing** analysis code you generated (catch the bug before it
  produces a plausible-but-wrong number).
- **After generating results**, as a final gate before you report figures or
  numbers to the user.
- Whenever the user asks to check, validate, or audit an analysis for
  correctness.

## How to run

The gate ships beside this SKILL.md. Run it on the code files in play (or with
no arguments to scan the workspace):

```bash
python "$XDG_CONFIG_HOME/opencode/skills/domain-check/domain_check.py" <file.py|notebook.ipynb|analysis.R ...>
```

It prints exactly one ` ```review ` fenced JSON block on stdout.

## What it catches (one rule set per discipline)

- **physics · units** — adding/subtracting/comparing quantities of different
  dimensions (e.g. `t_seconds + d_meters`); trig on a degree-valued angle.
- **earth · crs** — Euclidean/Pythagorean distance on latitude/longitude
  (`sqrt((lat1-lat2)**2 + (lon1-lon2)**2)`); a geopandas geometric op with no
  CRS ever set.
- **biology · coords / strand** — off-by-one on BED intervals (0-based
  half-open, so length is `end - start`, never `+1`); a sequence sliced from a
  stranded feature file (GFF/GTF/BED) with no reverse-complement for the `-`
  strand.
- **chem · valence** — a SMILES string literal (assigned to a `smiles`/`smi`
  variable, or passed to `MolFromSmiles`/`MolFromSmarts`) that cannot be a real
  molecule. **If RDKit is installed it is used as the authoritative judge** —
  `Chem.MolFromSmiles` sanitizes the parse, so it catches far more than a
  five-bond carbon (bad ring closures, impossible aromaticity, over-valent
  N/O/S) and, being authoritative, clears molecules a heuristic would
  wrongly flag. Without RDKit it falls back to a stdlib bond-counter (carbon
  >4, over-bonded halogen; bails on bracket atoms for precision).
- **social · multiple-comparisons** — a significance test (`ttest_ind`,
  `pearsonr`, `f_oneway`, `chi2_contingency`, …) run inside a loop or ≥3 times
  with no `multipletests`/FDR/Bonferroni correction anywhere — the inflated
  family-wise false-positive rate that silent p-hacking produces.
- **social · categorical** — a numeric reduction (`.mean()`/`.median()`/`.std()`
  …) taken directly on a nominal category code (`gender`, `race`, `region`,
  `condition`, …), treating an unordered label as an interval quantity. A
  `groupby('gender')` key is correct usage and is not flagged.
- **bioprocess · unconstrained-kinetics** — `curve_fit` fitting a local model
  function whose parameters are classic non-negative kinetic constants
  (Monod/Haldane `mu_max`/`Ks`/`Ki`, Pirt/yield `Yxs`/`Yps`, Luedeking-Piret
  `alpha`/`beta`, …) with no `bounds=`, letting a noisy or sparse fit converge
  to a physically impossible negative value. Names that belong to any curve at
  all (`alpha`, `beta`, `kd`, `ka`) count only beside an unambiguous one or in
  a file that otherwise reads as a fermentation, so a plain power law, whose
  exponent is routinely negative, is left alone.
- **bioprocess · kla-driving-force** — in a file that computes `kLa`, taking
  `log()` of the raw dissolved-oxygen reading instead of the `(C* - C)`
  driving force the dynamic gassing-out method requires (`dC/dt = kLa(C*-C)`,
  so the regression is on `ln(C* - C)`, not `ln(C)`).
- **bioprocess · cfu-log-scale** — a numeric reduction (`.mean()`/`.std()`/…)
  taken directly on a raw CFU (colony-forming-unit) plate count. Microbial
  counts are approximately log-normal; the convention is to average
  `log10(CFU)`, not the raw count. A variable already named as the log
  quantity (`log_cfu`) or a `.mean()` taken after `np.log10(...)` is not
  flagged.
- **bioprocess · anova-assumptions** — `f_oneway`/`anova_lm`/
  `pairwise_tukeyhsd`/`tukey_hsd` run in a file with no normality
  (`shapiro`/`normaltest`/`anderson`) or variance-homogeneity
  (`levene`/`bartlett`/`fligner`) check anywhere in it — the two assumptions
  the test's stated false-positive rate depends on. Scoped to files that read
  as a fermentation (`biomass`, `bioreactor`, `CFU`, `fed-batch`, …): the
  statistics generalize, but a finding tagged `bioprocess` on a three-arm
  survey does not.
- **bioprocess · rsm-first-order-fit** — a Box-Behnken/central-composite
  design (`bbdesign`/`ccdesign`/`box_behnken`/`central_composite` in the
  file) fit through a `statsmodels` formula with no quadratic (`I(x**2)`) or
  interaction (`x1:x2`) term — the design was built to estimate curvature, so
  a first-order model wastes it and cannot locate an interior optimum.

Rules favour precision: an unrecognized unit, arithmetic with no discipline
signal, a SMILES using bracket atoms (which carry their own valence/charge), a
single significance test, or a categorical used only as a groupby key is left
silent rather than flagged.

## Reporting findings

Copy the ` ```review ` block the tool prints as the **last thing** in your
message — the app renders it as dismissible reviewer cards. Do not paraphrase
the findings into prose and drop the block; the structured block is the
contract. If the gate found nothing, say so plainly and keep the block (its
`note` states that no findings is not a guarantee of correctness).

Never tell the user the code is "correct" or "error-free" — the gate checks
known error classes only.

## Adding a discipline

Add a `check_<field>(ctx)` function in `domain_check.py` and append it to
`VALIDATORS`. No other change is needed — the review contract and the app's
rendering are discipline-agnostic (each finding carries its own `tag`).
