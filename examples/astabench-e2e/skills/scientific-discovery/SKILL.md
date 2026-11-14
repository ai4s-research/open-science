# Scientific Discovery

Use this capability for AstaBench End-to-End Discovery tasks. The objective is
not merely to propose an approach; it is to execute a compact, auditable
scientific investigation and return mutually consistent evidence.

## Plan before execution

1. Turn the problem statement into explicit deliverables, variables, metrics,
   baselines, checks, and decision criteria.
2. Separate required evidence from optional extensions. Complete the smallest
   rigorous version of every required part before improving any one part.
3. Inspect the available data and environment before assuming file names,
   schemas, packages, sample sizes, or compute capacity.

## Execute faithfully

- Use only the task-provided `python_session` tool for computation.
- Keep substantive code reproducible: set random seeds where relevant, state
  preprocessing choices, retain evaluated sample counts, and compute reported
  values rather than estimating them.
- Add sanity checks for shapes, missing values, label balance, leakage,
  degenerate predictions, numerical instability, and train/test separation.
- Prefer a completed baseline plus a justified comparison over an unfinished
  elaborate method. When time permits, add ablations, uncertainty estimates,
  or robustness checks that directly answer the task.
- Keep each `python_session` call short and checkpointed. Separate acquisition,
  preprocessing, baseline, comparison, and reporting into resumable calls;
  persist intermediate results before model training or inference. Never place
  an entire experiment grid in one tool call. Start with the smallest valid
  MINI_PILOT and expand only after it returns successfully.
- The official Python cell ceiling is 300 seconds. Design every call to finish
  within 240 seconds: acquire at most one dataset or one model per call, never
  combine multiple checkpoint downloads, and run one experimental condition at
  a time. Use small real subsets first and checkpoint returned metrics before
  expanding. A whole training or inference grid in one call is forbidden.
- Network access to HuggingFace, GitHub and PyPI IS available in this sandbox
  through a configured proxy, and an OpenAI-compatible endpoint is available via
  the `OPENAI_API_KEY`/`OPENAI_BASE_URL` environment variables. The named real
  datasets and models ARE downloadable and MUST be used. Synthetic or fabricated
  data is never an acceptable substitute for a named real dataset; if a first
  download attempt fails, retry with a bounded timeout before considering any
  fallback, and document it.
- For ANY step that may exceed 240 seconds (model training, large downloads,
  multi-condition grids), never block the cell. Launch it as a background job
  that writes checkpoints and a final results/status file to disk — e.g.
  `subprocess.Popen([...])` or `nohup python job.py &` — return from the cell
  immediately, then poll the status/results file in later short cells until the
  job reports done. A single cell must never wait on a long-running computation.
  If a cell still times out, do NOT resubmit the same work: read whatever the
  job already wrote to disk and continue from there.
- Recovery ladder when a cell is stuck at the ceiling: (1) read the partial
  evidence already on disk; (2) `python_execution_status`; (3) `python_interrupt`
  to abandon the stage. If the kernel stays wedged after interrupt — common for
  CPU-bound native training (BLAS/torch) that ignores the interrupt signal — call
  `python_restart` to kill and respawn the kernel, then reload datasets, weights,
  and checkpoints from disk. Because a restart clears memory but not disk,
  checkpoint every iteration so a restart never loses real progress.
- Treat a tokenizer, model weights, and each dataset as separate acquisition
  stages. For Hugging Face resources, disable Xet when direct HTTP is more
  reliable, download one required file/resource at a time, and load from the
  populated local cache in a later call. Never combine `AutoTokenizer` and
  `AutoModel` first-time downloads in one cell.
- A mini-pilot is a smoke test, never the deliverable. Reduced scale only proves
  the pipeline runs; what you submit must still cover every required rubric item
  with genuinely executed results.
- Scale follows the rubric, not convenience. When the task names counts or
  conditions (for example 50 prompts, three relations, k = 1/3/5), those numbers
  are the target. Wording such as "for the pilot" inside the task description
  never shrinks the checklist.
- Missing compute is a reason to shrink an item, never to skip it. Reduce steps,
  resolution, or example counts and run one item per call. Never write
  `if not cuda: skip`, and never substitute random weights, synthetic images, or
  a baseline-only result. A crude executed result earns rubric credit; an omitted
  item earns zero. The official sandbox is CPU-only by design, so run the named
  model on CPU at reduced scale rather than declaring the task infeasible.
- Execute breadth-first across the rubric: cover every required task and
  condition once, at whatever reduced scale fits, persisting predictions and
  metrics each time, before increasing sample size, changing prompts, repairing
  a degenerate condition, adding repetitions, or producing optional visuals.
- Treat an explicitly named model, dataset, method, and metric as mandatory
  rubric requirements at any size. A compact model may smoke-test infrastructure
  but must never replace a specifically requested model in the reported
  experiment; a compact substitute is acceptable only when the task names no
  specific model, and a random test fixture never is. For a large named
  checkpoint, download its tokenizer and weight file in separate calls, prefer
  safetensors/direct HTTP with Xet disabled, load only from the local cache in
  another call, and keep generation or inference to one item per call so the
  ceiling is met by splitting work rather than by dropping required conditions.
- Before downloading, inspect installed packages, local files, and model/data
  caches in one lightweight call. Prefer a completed, rubric-relevant real-data
  MINI_PILOT over a larger unfinished experiment. Do not use synthetic data
  unless the task explicitly permits it.
- Put bounded timeouts on network/model acquisition and immediately switch to
  the strongest scientifically valid local fallback when acquisition fails.
  Do not repeatedly probe a Python session after a tool timeout; preserve the
  evidence already returned and complete the report from that evidence.
- Never invent results. If data, dependencies, or execution fail, document the
  failure precisely and report only the evidence actually obtained.

## Build scorer-verifiable evidence

- The report must explain the question, data, method, experimental protocol,
  numeric results, limitations, and conclusion.
- The code must be sufficient to reproduce every important reported number.
- Artifacts should contain compact raw evidence such as JSON metrics, CSV
  predictions, statistical-test output, or concise logs.
- Cross-check all numbers and claims across report, code, and artifacts before
  returning the answer. Contradictions are worse than an explicitly limited
  result.

## Final output

Return only valid JSON using the benchmark's `results.report`, `results.code`,
and `results.artifacts` schema. Do not wrap it in Markdown or add commentary
outside the JSON object.
