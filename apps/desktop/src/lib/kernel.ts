// Bridge to the local Python kernel (desktop only). In a plain browser these are
// no-ops so the app still runs in `pnpm dev`; the notebook then shows a hint.
import type { FileRoot } from "@ai4s/shared";
import { isTauri } from "./tauri";

export interface ExecResult {
  ok: boolean;
  stdout: string;
  result: string | null;
  error: string | null;
}

/** Languages with a local kernel. A notebook runs one of these. */
export type KernelLanguage = "python" | "r";

/** True for cell languages that run on a local kernel (vs. markdown/raw). */
export function isCodeLanguage(lang: string): lang is KernelLanguage {
  return lang === "python" || lang === "r";
}

/**
 * Run one cell in the persistent local kernel for this notebook (Jupyter
 * semantics: one kernel per notebook, working directory = the notebook's
 * folder). `notebook` is the root-relative .ipynb path; omitting it runs in
 * the active workspace. Returns null outside the desktop app.
 */
export async function kernelExecute(
  code: string,
  language: KernelLanguage = "python",
  notebook?: string,
  root?: FileRoot,
): Promise<ExecResult | null> {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ExecResult>("kernel_execute", { code, language, notebook, root });
}

/**
 * Restart local kernel(s). With `notebook`, exactly that notebook's kernel is
 * killed (the Stop button on a hung cell — always returns promptly, even while
 * a cell is blocked mid-run); with no arguments, everything — e.g. after
 * switching workspace folder. No-op outside the desktop app.
 */
export async function kernelReset(
  language?: KernelLanguage,
  notebook?: string,
  root?: FileRoot,
): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("kernel_reset", { language, notebook, root });
}

/** Render a kernel result as the text shown under a notebook cell. */
export function formatExecResult(r: ExecResult): string {
  if (!r.ok && r.error) return r.error.trimEnd();
  const parts: string[] = [];
  if (r.stdout) parts.push(r.stdout.trimEnd());
  if (r.result !== null) parts.push(r.result);
  // Empty, not "(no output)": a cell that printed nothing shows nothing, as in
  // Jupyter. That it RAN is carried by its `[n]` execution count instead —
  // putting words in the output pane made every `import` look like it failed.
  return parts.join("\n");
}
