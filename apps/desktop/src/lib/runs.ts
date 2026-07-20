// Run provenance: turn the agent's experiment executions (bash) into run
// records in `.openscience/runs.jsonl`. Unlike file provenance (which records
// an authored file's text), a *run* is the reproducibility recipe — the
// command, code version, environment, hardware, inputs, and outputs of an
// execution. Pure derivation lives here; the Tauri bridge is separate so this
// can be unit-tested without a desktop shell.
import type { RunArtifact, RunRecord } from "@ai4s/shared";
import type { ToolUpdatedEvent } from "@ai4s/sdk";
import { isTauri, logDebug } from "./tauri";

/** The compute surface a run targeted. Only "local" runs produce workspace
 *  files we can hash; remote surfaces are recorded honestly with their command
 *  and the submitting machine's env, but their outputs live elsewhere. */
export type RunSurface = "local" | "hpc" | "modal" | "jupyter" | "ssh";

export interface RunInput {
  /** The exact command the agent ran, e.g. "python train.py --lr 3e-4". */
  command: string;
  /** Captured stdout/stderr, when the event carried it. */
  log?: string;
  /** Epoch ms the command started / finished (used to attribute outputs). */
  startedAt?: number;
  endedAt?: number;
  /** Terminal outcome of the command. */
  status: "ok" | "failed";
  /** The compute surface the command targeted. */
  surface: RunSurface;
}

/** Local interpreter/build executables we record, matched against a segment's
 *  executable *basename* (see `headExecutable`). A conservative allowlist:
 *  recording only what we confidently recognize keeps `runs.jsonl` meaningful
 *  and low-noise (reads/housekeeping are not runs). */
const INTERPRETER =
  /^(python[0-9.]*|Rscript|julia|matlab|octave|make|snakemake|nextflow|torchrun|mpirun|accelerate|dvc|luigi)$/;

/** The executable basename at the head of a command segment. Unwraps the first
 *  shell token (honoring quotes), drops any directory prefix (`/` or `\`) and a
 *  Windows `.exe`/`.cmd`/`.bat` extension — so a path- or venv-form interpreter
 *  (`C:\proj\.venv\Scripts\python.exe`, `"C:\Program Files\Py\python.exe"`,
 *  `/proj/.venv/bin/python`, `./.venv/bin/python`) all reduce to `python`, not
 *  just a bare `python`. The leading PowerShell `&` call operator is already
 *  removed by `stripPrefixes`. */
function headExecutable(segment: string): string {
  const m = segment.match(/^"([^"]*)"|^'([^']*)'|^(\S+)/);
  const token = m ? (m[1] ?? m[2] ?? m[3] ?? "") : "";
  const base = token.split(/[\\/]/).pop() ?? token;
  return base.replace(/\.(exe|cmd|bat)$/i, "");
}

/** Whether a single (prefix-stripped) segment is a local interpreter/build run:
 *  a recognized interpreter basename, or a shell script invoked directly
 *  (`./run.sh`, `/path/run.sh`) or via `bash`/`sh`. */
function isLocalExecution(segment: string): boolean {
  const exe = headExecutable(segment);
  if (INTERPRETER.test(exe)) return true;
  if (exe.endsWith(".sh")) return true; // ./run.sh, /path/run.sh, run.sh
  // `bash script.sh` / `sh path/to/run.sh` — only when the FIRST argument is a
  // `.sh` script, so `bash -c "echo foo.sh"` (a marker word in an arg) is not a
  // run. Basename-only, so an interpreter path in the arg still counts.
  if (exe === "bash" || exe === "sh") {
    const arg = segment.trim().split(/\s+/)[1] ?? "";
    return (arg.split(/[\\/]/).pop() ?? "").endsWith(".sh");
  }
  return false;
}

// Remote/batch markers, anchored at a segment head (NOT matched inside quoted
// args, so `git commit -m "…sbatch…"` is not mistaken for a run).
const HPC_HEAD = /^(sbatch|srun|salloc|sacct)\b/;
const MODAL_HEAD = /^modal\s+(run|deploy|serve)\b/;
const JUPYTER_HEAD = /^papermill\b|^jupyter\s+.*\bnbconvert\b/;

/** Strip leading `VAR=val` env assignments, `cd X &&/;` hops, and transparent
 *  launch wrappers from a command segment, exposing the operative command (e.g.
 *  `CUDA_VISIBLE_DEVICES=0 cd x && nohup python …` → `python …`). This feeds
 *  detection only — the ORIGINAL command (wrappers and all) is what gets
 *  recorded, so nothing the user typed is lost. */
function stripPrefixes(segment: string): string {
  let c = segment.trim();
  const cd = /^cd\s+(?:"[^"]*"|'[^']*'|[^\s&;]+)\s*(?:&&|;)\s*/;
  const env = /^\w+=(?:"[^"]*"|'[^']*'|\S*)\s+/;
  const call = /^&\s+/; // PowerShell call operator: `& C:\proj\.venv\Scripts\python.exe`
  // Transparent wrappers that prefix — but don't change — the command that
  // actually runs (`nohup python …`, `timeout 30 python …`, `stdbuf -oL julia
  // …`). Stripping them lets the real interpreter head show through. Wrappers
  // that take their own argument (`timeout <dur>`, `stdbuf <-flags>`) consume it
  // too, so the head lands on the operative command.
  const wrap = /^(?:nohup|time|timeout\s+\S+|stdbuf(?:\s+-\S+)+)\s+/;
  let changed = true;
  while (changed) {
    changed = false;
    if (cd.test(c)) {
      c = c.replace(cd, "").trim();
      changed = true;
    }
    if (env.test(c)) {
      c = c.replace(env, "").trim();
      changed = true;
    }
    if (call.test(c)) {
      c = c.replace(call, "").trim();
      changed = true;
    }
    if (wrap.test(c)) {
      c = c.replace(wrap, "").trim();
      changed = true;
    }
  }
  return c;
}

/** The operative command heads of each `&&`/`;`/`|`-separated segment, with env
 *  and cd prefixes stripped and a leading `ssh <host>` unwrapped to the remote
 *  command. Markers are matched against these, never inside quoted arguments. */
function commandSegments(command: string): string[] {
  return command
    .split(/&&|;|\||\n/)
    .map((seg) => {
      let s = stripPrefixes(seg);
      // `ssh host "sbatch job.sh"` → the remote command is what runs.
      const ssh = s.match(/^ssh\s+\S+\s+(.+)$/);
      if (ssh) s = ssh[1].trim().replace(/^['"]|['"]$/g, "");
      return s;
    })
    .filter(Boolean);
}

/** The compute surface a command targets — remote surfaces are still runs
 *  (recorded honestly), just without locally-captured outputs. */
export function surfaceForCommand(command: string): RunSurface {
  const segs = commandSegments(command);
  if (segs.some((s) => HPC_HEAD.test(s))) return "hpc";
  if (segs.some((s) => MODAL_HEAD.test(s))) return "modal";
  if (segs.some((s) => JUPYTER_HEAD.test(s))) return "jupyter";
  return "local";
}

export function looksLikeExecution(command: string): boolean {
  // A recognized local interpreter/build head in any segment, OR a remote/batch
  // marker at a segment head.
  return commandSegments(command).some(isLocalExecution) || surfaceForCommand(command) !== "local";
}

/**
 * Derive a run record input from a completed tool call, or `null` when the
 * event is not a recordable experiment execution (non-bash, still running,
 * no command, or a read-only/housekeeping command).
 */
export function runInputFromEvent(event: ToolUpdatedEvent): RunInput | null {
  if ((event.tool ?? "").toLowerCase() !== "bash") return null;
  if (event.status !== "success" && event.status !== "failed") return null;
  const command = typeof event.input?.command === "string" ? event.input.command.trim() : "";
  if (!command) return null;
  // Remote runs (HPC/Modal) execute off-box — their env, hardware, and outputs
  // live on the cluster/cloud, invisible here. Recording them from the laptop
  // would stamp the wrong environment, so the remote-compute / modal-run skills
  // record them instead (into .openscience/remote-runs.jsonl) with real remote
  // facts. The passive capture handles local runs only.
  if (surfaceForCommand(command) !== "local") return null;
  if (!looksLikeExecution(command)) return null;
  return {
    command,
    log: event.output,
    startedAt: event.startedAt,
    endedAt: event.endedAt,
    status: event.status === "success" ? "ok" : "failed",
    surface: "local",
  };
}

/** The prompt the Reproduce action drafts for a run — prefilled, reviewed, and
 *  user-sent (human in the loop, never auto-run). Unlike reproducing a file,
 *  this re-runs the recorded COMMAND in the recorded environment and compares
 *  the regenerated OUTPUTS — real reproducibility, not re-authoring source. */
export function reproduceRunPrompt(r: RunRecord): string {
  const env = r.env;
  const hw = env?.hardware;
  const parts: string[] = [];
  if (env) {
    const bits = [
      env.python && `Python ${env.python}`,
      env.platform,
      hw?.gpu?.length ? hw.gpu.join(", ") : hw?.accelerator,
      hw?.cpu,
    ].filter(Boolean);
    if (bits.length) parts.push(`It ran on ${bits.join(" · ")}.`);
    if (env.packages)
      parts.push(
        `The environment had ${env.packages.count} installed Python packages, pinned in \`.openscience/env/${env.packages.hash}.txt\` — install matching versions from that lockfile if the result differs.`,
      );
  }
  const code = fileList(r.code ?? []);
  if (code) parts.push(`The code version is pinned by hash: ${code} — check it hasn't changed since.`);
  const remote = r.surface === "hpc" || r.surface === "modal" || r.surface === "ssh";
  if (remote)
    parts.push(
      `This ran on ${
        r.surface === "hpc" ? "an HPC cluster" : r.surface === "modal" ? "Modal" : "a remote machine over SSH"
      }, so its outputs live off this machine and weren't captured locally.`,
    );
  const outputs = fileList(r.outputs ?? []);
  const compare = outputs
    ? `re-run it, then compare the regenerated outputs (${outputs}) against the recorded run and report whether they match — and what changed if not.`
    : remote
      ? `re-submit it and report whether it reproduces, fetching the remote outputs to compare.`
      : `re-run it and report whether it reproduces (no output files were captured for this run).`;
  return (
    `Reproduce run \`${r.runId}\`, which executed:\n\n    ${r.command}\n\n` +
    `${parts.join(" ")}${parts.length ? " " : ""}Recreate that environment, ${compare}`
  );
}

/** "a, b, c (+N more)" for a capped list of run files, or "" when empty. */
function fileList(files: RunArtifact[], cap = 6): string {
  if (files.length === 0) return "";
  const shown = files.slice(0, cap).map((f) => `\`${f.path}\``);
  const more = files.length > cap ? ` (+${files.length - cap} more)` : "";
  return shown.join(", ") + more;
}

/** Append a run record (desktop only). Recording must never break the chat flow. */
export async function recordRun(
  input: RunInput,
  sessionId: string | undefined,
  model: string | null,
  variant: string | null = null,
): Promise<void> {
  if (!isTauri) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("record_run", {
      command: input.command,
      log: input.log ?? null,
      startedAt: input.startedAt ?? null,
      endedAt: input.endedAt ?? null,
      status: input.status,
      surface: input.surface,
      sessionId: sessionId ?? null,
      model: model ?? null,
      variant: variant ?? null,
    });
    void logDebug(`run ✓ ${input.command.slice(0, 60)}`);
  } catch (e) {
    void logDebug(`run FAILED for ${input.command.slice(0, 60)}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** All recorded runs, newest first ([] in browser dev). */
export async function listRuns(): Promise<RunRecord[]> {
  if (!isTauri) return [];
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<RunRecord[]>("list_runs", {});
  } catch {
    return [];
  }
}

/** A keyset-paginated, faceted query over the runs index. */
export interface RunQuery {
  search?: string;
  status?: string;
  surface?: string;
  sessionId?: string;
  /** Time filter: only runs at or after this epoch-seconds instant. */
  sinceTs?: number;
  /** Keyset cursor from a previous page's `next`. */
  beforeTs?: number;
  beforeRowid?: number;
  limit?: number;
}

export interface RunFacet {
  value: string;
  count: number;
}

export interface RunPage {
  rows: RunRecord[];
  /** Total matching the full filter (for the header count). */
  total: number;
  facets: { status: RunFacet[]; surface: RunFacet[] };
  /** Cursor for the next (older) page; absent at the end. */
  next?: { ts: number; rowid: number };
}

const EMPTY_PAGE: RunPage = { rows: [], total: 0, facets: { status: [], surface: [] } };

/** Query the runs index (indexed, paginated, faceted). Empty page in browser dev. */
export async function queryRuns(query: RunQuery): Promise<RunPage> {
  if (!isTauri) return EMPTY_PAGE;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<RunPage>("query_runs_cmd", { query });
  } catch {
    return EMPTY_PAGE;
  }
}

/** A run's captured stdout/stderr by its log hash (null if unreadable). */
export async function readRunLog(hash: string): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string>("read_run_log", { hash });
  } catch {
    return null;
  }
}
