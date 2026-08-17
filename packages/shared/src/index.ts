// Stable domain types for AI4S Workbench.
// Imported by the desktop app now, and by the SDK / runtime in later slices.

export type RuntimeStatus = "connecting" | "ready" | "error" | "offline";
export type ModelStatus = "connected" | "disconnected" | "error";

export interface Project {
  id: string;
  name: string;
  sessions: Session[];
}

export type SessionGroup = "Examples" | "Today" | "Active" | "Earlier";

export interface Session {
  id: string;
  projectId: string;
  title: string;
  group: SessionGroup;
  /** Optional right-aligned count badge, e.g. running agents. */
  badge?: number;
  /** Status dot color hint. */
  status?: "idle" | "running" | "done" | "warn";
  blocks: ThreadBlock[];
  inspector?: Inspector;
}

// ---- Thread blocks (center pane) ----

export type ThreadBlock =
  | UserMessageBlock
  | AgentMessageBlock
  | ReasoningBlock
  | StepSummaryBlock
  | ToolCallBlock
  | ReviewerBlock
  | DataTableBlock
  | FigureBlock
  | ArtifactBlock
  | RunningJobsBlock
  | CompactionBlock
  | StatusLineBlock;

/** The runtime summarized the older turns to stay inside the model's context
 *  window and carried on in the same conversation. Rendered as one quiet line
 *  the reader can expand — the conversation stays visually continuous, and the
 *  compaction is still auditable (#62). */
export interface CompactionBlock {
  kind: "compaction";
  /** True when the runtime did it on its own; false when the user asked. */
  auto: boolean;
  /** True when it happened because the context had already overflowed, rather
   *  than pre-emptively at the threshold. */
  overflow?: boolean;
  /** Epoch ms, when known. */
  at?: number;
}

export interface UserMessageBlock {
  kind: "user";
  text: string;
  /** OpenCode message id, when known — the handle for editing this message
   *  (revert + resend). Absent on synthetic echoes (shell/command) and until
   *  the server confirms a freshly-sent message. No id ⇒ not editable. */
  messageID?: string;
}

export interface AgentMessageBlock {
  kind: "agent";
  /** Markdown; inline `code` tokens are rendered as blue mono. */
  markdown: string;
  /** OpenCode message id this text belongs to — the handle `usage` and the
   *  timings are stamped against as the turn reports them. */
  messageID?: string;
  /** Epoch ms the assistant message started / finished. `completed` is absent
   *  while the turn is still streaming. */
  created?: number;
  completed?: number;
  /** What the turn cost in tokens. Absent until the runtime reports it, and
   *  always absent for ACP sessions — ACP v1 has no usage channel. */
  usage?: MessageUsage;
}

/** Token accounting for one assistant turn, as OpenCode reports it.
 *
 *  `input + cacheRead + cacheWrite + output + reasoning` is what the model
 *  actually held for this turn, so the newest assistant message answers "how
 *  full is the context right now" — see `contextUsed()`. */
export interface MessageUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  /** USD for this turn, as reported by the runtime (0 for local models). */
  cost: number;
}

/** Tokens the model held for the turn `u` describes — the whole prompt it was
 *  sent (fresh input plus whatever came from cache) plus everything it
 *  produced. Measured against the model's `contextLimit` this is the share of
 *  the context window in use. */
export function contextUsed(u: MessageUsage): number {
  return u.input + u.cacheRead + u.cacheWrite + u.output + u.reasoning;
}

/** The model's reasoning ("thinking") for a step — rendered dimmed and
 *  collapsible, distinct from the final answer (an AgentMessageBlock). */
export interface ReasoningBlock {
  kind: "reasoning";
  /** Accumulated thinking text (plain, whitespace-preserved). */
  text: string;
}

export interface StepSummaryBlock {
  kind: "step-summary";
  summary: string;
  steps: number;
  details?: string[];
}

export type ToolCallStatus =
  | "pending"
  | "running"
  | "waiting-approval"
  | "success"
  | "warning"
  | "failed";

/** Closed vocabulary emitted by `toolPresentation()` (apps/desktop/src/lib/runtime.ts)
 *  — never derived from LLM/tool output, so each value maps to a per-key
 *  translation (`session:tool.verb.<Verb>`), not raw text. */
export type ToolVerb = "Ran" | "Created" | "Edited" | "Read" | "Searched" | "Listed" | "Fetched";

export interface ToolCallBlock {
  kind: "tool-call";
  /** What to recognize the step by: a de-noised command, a file path, a
   *  pattern — never the raw `cd … && …` line (that lives in `command`). */
  title: string;
  status: ToolCallStatus;
  /** Right-aligned meta, e.g. "142 lines of output" or "16m 2s". */
  meta?: string;
  /** Display verb rendered before the title ("Ran", "Created", "Edited"…). */
  verb?: ToolVerb;
  /** OpenCode tool name ("bash", "write", …) — picks the detail renderer. */
  tool?: string;
  /** Full command line as executed (bash) — shown in the expanded detail. */
  command?: string;
  filePath?: string;
  /** Written file content (write tools), for the inline detail view. */
  content?: string;
  /** Unified diff (edit tools), for the inline detail view. */
  diff?: string;
  /** Live stdout tail while the tool is running (already \r-folded + capped). */
  partialOutput?: string;
  /** Final output, for the expanded detail view. */
  output?: string;
  /** Epoch ms — drive the elapsed timer (running) and duration meta (done). */
  startedAt?: number;
  endedAt?: number;
  /** Output of a user-typed "!" command — its detail view opens by default. */
  outputSummary?: string;
  /** Subagent session spawned by this task tool — lets the UI show its live activity. */
  childSessionId?: string;
}

export type FindingLevel = "warn" | "ok" | "error";

/**
 * Which check produced a finding: P0-4's three traceability audits, `domain`
 * for P0-5's domain-correctness gates, and `integrity` for P1-6's
 * analysis-integrity gate. `domain`/`integrity` findings carry their own `tag`
 * (e.g. "physics · units", "stats · prereg") so new checks need no UI change.
 */
export type ReviewCheck = "citation" | "number" | "figure" | "domain" | "integrity";

export interface ReviewFinding {
  level: FindingLevel;
  title: string;
  /** Monospace evidence body. */
  evidence?: string;
  check?: ReviewCheck;
  /** Freeform label shown on the card, overriding the check name (used by
   *  domain-correctness findings, e.g. "earth · crs"). */
  tag?: string;
}

export interface ReviewerBlock {
  kind: "reviewer";
  findings: ReviewFinding[];
  note?: string;
}

export interface DataTableBlock {
  kind: "table";
  columns: string[];
  /** Cells rendered with mono where they look code-like. */
  rows: string[][];
  caption?: string;
}

export interface FigureBlock {
  kind: "figure";
  title: string;
  /** Image URL / data URI; a placeholder this slice. */
  src: string;
  caption?: string;
  /** Reviewer/user pins dropped on the figure. */
  annotations?: FigureAnnotation[];
}

export interface FigureAnnotation {
  index: number;
  note: string;
  /** Percent position of the pin within the image. */
  x: number;
  y: number;
}

/** File the agent produced, surfaced as a traceable artifact in the thread. */
export type ArtifactKind =
  | "figure"
  | "script"
  | "report"
  | "table"
  | "notebook"
  | "model"
  | "data";

export interface ArtifactBlock {
  kind: "artifact";
  /** Workspace-relative path the tool wrote. */
  path: string;
  filename: string;
  artifact: ArtifactKind;
  /** Tool that produced it, e.g. "write" / "edit". */
  tool: string;
  /** Text content when the producing tool carried it (write/edit); absent for binary. */
  content?: string;
  language?: string;
  /** Explicit host presentation requested by the agent. Ordinary write/edit
   *  artifacts omit this and keep the compact file card. */
  presentation?: {
    mode: "inline" | "panel";
    /** Optional user-facing title supplied to the presentation tool. */
    title?: string;
    /** Tool-call identity; a repeated panel request for the same path replaces
     *  the leaf content and forces the native preview to reload from disk. */
    requestId?: string;
  };
}

export interface RunningJob {
  label: string;
  elapsed: string;
}

export interface RunningJobsBlock {
  kind: "running-jobs";
  title: string; // e.g. "REMOTE · 8"
  jobs: RunningJob[];
}

export interface StatusLineBlock {
  kind: "status-line";
  text: string; // e.g. "8 running · 16m 2s"
  tone?: "running" | "done" | "review" | "error";
  divider?: boolean;
}

// ---- Inspector (right pane) ----

export type Inspector =
  | ArtifactInspector
  | NotebookInspector
  | PdfInspector
  | FilePreviewInspector
  | NotebookFileInspector;

/** Folder tree a root-relative file path resolves in: the active session
 *  workspace (default) or the base folder all session workspaces live under. */
export type FileRoot = "workspace" | "base";

/** A real .ipynb in the workspace, opened in the runnable notebook editor. */
export interface NotebookFileInspector {
  variant: "notebook-file";
  /** Root-relative path of the notebook. */
  path: string;
  /** Folder tree `path` resolves in (default "workspace"). */
  root?: FileRoot;
}

/** A workspace file surfaced for preview — the agent wrote it OR code produced it.
 *  Rendered by type: HTML → live iframe, PDF → pdf.js, image → <img>, text → code. */
export interface FilePreviewInspector {
  variant: "file";
  path: string;
  filename: string;
  artifact: ArtifactKind;
  language?: string;
  /** Inline text content when known (write/edit tools); else loaded from disk. */
  content?: string;
  /** Folder tree `path` resolves in (default "workspace"). */
  root?: FileRoot;
}

export interface ArtifactVersion {
  label: string; // "v1", "v2"
  /** Per-version overrides; fall back to the inspector-level fields when absent. */
  code?: string;
  executionLog?: string;
  messages?: string[];
  environment?: string;
  reviewPassed?: boolean;
}

export type ArtifactTab =
  | "Code"
  | "Execution Log"
  | "Messages"
  | "Environment"
  | "Review";

export type ArtifactType =
  | "figure"
  | "report"
  | "table"
  | "script"
  | "notebook"
  | "pdf";

export interface ArtifactInspector {
  variant: "artifact";
  title: string;
  /** Name used when downloading the script (defaults to `title`). */
  filename?: string;
  versions: ArtifactVersion[];
  activeVersion: string;
  reviewPassed?: boolean;
  inputs: string[];
  /** Source shown in the Code tab. */
  code: string;
  language: string;
  /** First line number to show. */
  codeStartLine?: number;
  executionLog?: string;
  environment?: string;
  messages?: string[];
}

export interface NotebookCell {
  index: number;
  language: string;
  code: string;
  output?: string;
  /** Base64 PNG from a display_data/execute_result output (e.g. a matplotlib figure). */
  image?: string;
}

export interface NotebookInspector {
  variant: "notebook";
  name: string;
  live: boolean;
  kernelLabel: string;
  kernelNote: string;
  cells: NotebookCell[];
}

export interface PdfInspector {
  variant: "pdf";
  title: string; // "review.pdf"
  /** HTML facsimile document sections rendered as a paper this slice. */
  doc: PdfDoc;
}

export interface PdfDoc {
  title: string;
  subtitle?: string;
  summaryTable?: DataTableBlock;
  figure?: FigureBlock;
  sections: PdfSection[];
}

export interface PdfSection {
  heading: string;
  body: string;
}

// ---- Provenance / citations ----

/** One recorded write of an artifact — a line in `.openscience/provenance.jsonl`.
 *  Every agent write appends one, so any artifact can reveal its generating
 *  code, environment, and originating conversation, per version. */
export interface ProvenanceRecord {
  /** Workspace-relative artifact path with `/` separators. */
  path: string;
  /** 1-based version, assigned on append. */
  version: number;
  /** Seconds since the epoch. */
  ts: number;
  /** Tool that produced this version, e.g. "write". */
  tool: string;
  sessionId?: string;
  /** Model configured when the version was recorded. */
  model?: string;
  /** Text the tool wrote (capped); absent for binary or indirect writes. */
  content?: string;
  /** Unified diff of an incremental edit, when the full content wasn't captured
   *  (edits carry a diff, not the whole file). Shown as the version's lineage. */
  diff?: string;
  log?: string;
  /** Runtime environment captured when the version was recorded. */
  env?: ProvenanceEnv;
  /** The run that produced this version, when it came from executing code
   *  (not an authored write). Links the file to its reproducibility recipe. */
  runId?: string;
}

/** The environment a version was produced in — enough to reproduce. */
export interface ProvenanceEnv {
  /** Local Python version, e.g. "3.12.4". */
  python?: string;
  /** OS and architecture, e.g. "macos-aarch64". */
  platform: string;
  /** Open Science app version that recorded it. */
  app: string;
  /** Installed Python packages (pip freeze), content-addressed to a lockfile. */
  packages?: PackageSnapshot;
  /** Hardware the code executed on (CPU/GPU/accelerator). */
  hardware?: HardwareInfo;
}

/** The silicon a run executed on — the part of reproducibility software can't
 *  capture. Every field is best-effort ("record what we can"). */
export interface HardwareInfo {
  /** CPU brand string, e.g. "Apple M2 Pro" or "Intel Core i7-9750H". */
  cpu?: string;
  /** Logical CPU count. */
  cores?: number;
  /** Total physical memory in GB (rounded). */
  memGb?: number;
  /** GPU model(s), e.g. ["NVIDIA A100-SXM4-40GB"]; empty when none detected. */
  gpu?: string[];
  /** Compute accelerator available: "cuda" | "mps" | "cpu". */
  accelerator?: string;
}

/**
 * One experiment/analysis execution — the reproducibility recipe. Unlike a
 * `ProvenanceRecord` (an authored file's text), a run captures WHAT ran, WHERE
 * (env + hardware), and WHAT it produced, so a result can be regenerated and
 * compared. Stored append-only in `.openscience/runs.jsonl`.
 */
export interface RunRecord {
  /** Short content+time id, e.g. "run_ab12cd34". */
  runId: string;
  /** Seconds since the epoch (run start). */
  ts: number;
  sessionId?: string;
  /** Model configured when the run was recorded. */
  model?: string;
  /** The exact command that ran, e.g. "python train.py --lr 3e-4". */
  command: string;
  /** The compute surface the run targeted. Absent means "local". Remote
   *  surfaces (hpc/modal/ssh) are recorded honestly but their outputs live off-box. */
  surface?: "local" | "hpc" | "modal" | "jupyter" | "ssh";
  /** Remote runs only: the cluster host / Modal app the run executed on. */
  host?: string;
  /** Remote runs only: the scheduler job id / Modal call id, for traceability. */
  jobId?: string;
  /** Remote runs only: human-readable remote hardware (e.g. "1x A100, CUDA 12.2")
   *  — the silicon the app can't probe from the laptop. */
  remoteHardware?: string;
  /** Terminal outcome of the command. */
  status: "ok" | "failed";
  /** Wall-clock duration in ms, when start/end timing was available. */
  wallMs?: number;
  /** Code version: entry scripts named on the command line, each hashed, so a
   *  later edit to the script is detectable when reproducing. May be absent
   *  (the store omits empty arrays). */
  code?: RunArtifact[];
  /** Files created or modified during the run's time window — its outputs.
   *  May be absent (the store omits empty arrays). */
  outputs?: RunArtifact[];
  /** Captured stdout/stderr, content-addressed to `.openscience/logs/<hash>.txt`. */
  logHash?: string;
  /** Runtime environment (software + hardware) the run executed in. */
  env?: ProvenanceEnv;
}

/** A file referenced by a run — its code input or produced output. */
export interface RunArtifact {
  /** Workspace-relative path with `/` separators. */
  path: string;
  /** Short content hash; absent when the file was too large to hash. */
  hash?: string;
  /** Size in bytes. */
  size: number;
}

export interface PackageSnapshot {
  /** Number of installed packages captured. */
  count: number;
  /** Short content hash; the lockfile is `.openscience/env/<hash>.txt`. */
  hash: string;
}

export interface Citation {
  id: string; // DOI / PMID / arXiv id
  title: string;
  year?: number;
  source?: string;
}

// ---- Chart design system (P1-5) ----
// One validated palette, the single source of truth for BOTH native app charts
// (SVG stat tiles, mini-bars) and agent-generated figures (matplotlib, via the
// bundled `openscience.mplstyle` which carries the same hexes). Validated with
// the dataviz skill against the app's real surfaces — light #ffffff, dark
// #1e1d24 — for the lightness band, chroma floor, CVD separation, and contrast.
// Categorical hues are assigned in this fixed order, never cycled.

export type ChartTheme = "light" | "dark";

export interface ChartPalette {
  /** Categorical series hues, in fixed assignment order (identity encoding). */
  categorical: string[];
  /** Single-hue sequential ramp, light→dark (magnitude encoding). */
  sequential: string[];
  /** Reserved state colors — never reused as a series hue. */
  status: { good: string; warning: string; serious: string; critical: string };
}

/** Light-mode palette (chart surface #ffffff). */
export const CHART_PALETTE_LIGHT: ChartPalette = {
  categorical: ["#2a78d6", "#1baf7a", "#eda100", "#008300", "#4a3aa7", "#e34948", "#e87ba4", "#eb6834"],
  sequential: ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#104281"],
  status: { good: "#0ca30c", warning: "#c98a2b", serious: "#ec835a", critical: "#d03b3b" },
};

/** Dark-mode palette — the same hues stepped for the dark surface (#1e1d24). */
export const CHART_PALETTE_DARK: ChartPalette = {
  categorical: ["#3987e5", "#199e70", "#c98500", "#008300", "#9085e9", "#e66767", "#d55181", "#d95926"],
  sequential: ["#104281", "#184f95", "#256abf", "#3987e5", "#6da7ec", "#9ec5f4", "#cde2fb"],
  status: { good: "#0ca30c", warning: "#d7a24a", serious: "#ec835a", critical: "#d03b3b" },
};

export function chartPalette(theme: ChartTheme): ChartPalette {
  return theme === "dark" ? CHART_PALETTE_DARK : CHART_PALETTE_LIGHT;
}

/** Categorical hue for series `i`, assigned in fixed order (wraps only past 8). */
export function seriesColor(i: number, theme: ChartTheme): string {
  const c = chartPalette(theme).categorical;
  return c[((i % c.length) + c.length) % c.length];
}
