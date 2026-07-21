// Read/open workspace files for artifact previews (desktop only). In a plain
// browser these return null / no-op so the app still runs in `pnpm dev`.
// Paths are root-relative; `root` picks the tree ("workspace" = the active
// session folder, default; "base" = the folder all session workspaces live under).
import type { FileRoot, ArtifactFile, DirEntry } from "@ai4s/shared";
import { isTauri } from "./tauri";

// `FileRoot`, `ArtifactFile`, and `DirEntry` live in `@ai4s/shared` so the SDK
// runtime seam (`WorkspaceOps`) can reference the same shape. Re-exported here
// to keep the existing `import { ArtifactFile } from "@/lib/artifactFile"`
// callsites working unchanged.
export type { FileRoot, ArtifactFile, DirEntry };

/** Read a root-relative file. Returns null outside the desktop app or on error paths. */
export async function readArtifact(path: string, root?: FileRoot): Promise<ArtifactFile | null> {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ArtifactFile>("read_artifact", { path, root });
}

/** Local-server URL a workspace file is previewable at (desktop only). The tiny
 *  Rust file server gives the webview a real http://127.0.0.1 URL with correct
 *  MIME, so native viewers (PDF, images, HTML) render it directly. */
export async function previewUrl(path: string, root?: FileRoot): Promise<string | null> {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("preview_url", { path, root });
}

/** Resolve a file mentioned in an agent message to a real workspace-relative
 *  path. Agent prose may name a file without its directory ("index.html" for
 *  "canvas-project/index.html"); the backend finds it by basename. Returns
 *  null when no such file exists; echoes the path back in browser dev. */
export async function resolveArtifactPath(path: string): Promise<string | null> {
  if (!isTauri) return path;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("resolve_artifact", { path });
}

/** Open a root-relative file in the OS default application (desktop only). */
export async function openArtifactExternally(path: string, root?: FileRoot): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_path", { path, root });
}

/** Reveal a root-relative file/dir in the OS file manager (Finder / Explorer /
 *  Linux file manager). Desktop only; no-op in the browser. */
export async function revealArtifact(path: string, root?: FileRoot): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("reveal_path", { path, root });
}

/** The absolute filesystem path of a root-relative file/dir (for "Copy path").
 *  Null in the browser. */
export async function absoluteArtifactPath(path: string, root?: FileRoot): Promise<string | null> {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("absolute_path", { path, root });
}

/** Introspect a file too big to preview WITHOUT loading it: runs the bundled
 *  large-file probe and returns its compact memory pointer (schema / shape /
 *  sample / key numbers). Returns null outside the desktop app; throws the
 *  probe's error message on failure. */
export async function probeLargeFile(path: string, root?: FileRoot): Promise<LargeFilePointer | null> {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  const json = await invoke<string>("probe_large_file", { path, root });
  return JSON.parse(json) as LargeFilePointer;
}

/** The probe's JSON pointer. Fields vary by format; these are the common ones
 *  the panel renders (all optional — unknown formats still show size + note). */
export interface LargeFilePointer {
  format?: string;
  size?: string;
  size_bytes?: number;
  note?: string;
  error?: string;
  hint?: string;
  // tables
  columns?: { name: string; dtype: string }[];
  n_columns?: number;
  approx_rows?: number;
  sample_head?: string[][];
  // genomics
  approx_reads?: number;
  approx_sequences?: number;
  approx_variants?: number;
  read_length?: { min: number; max: number; mean: number };
  samples?: string[];
  sample_ids?: string[];
  gzipped?: boolean;
  // hdf5 / fits / netcdf / parquet
  datasets?: { path: string; shape: number[]; dtype: string }[];
  num_rows?: number;
  [k: string]: unknown;
}

export interface NotebookEntry {
  path: string;
  /** Seconds since the epoch (newest first from the backend). */
  modified: number;
}

/** All .ipynb files under the root, newest first (desktop only). `root: "base"`
 *  spans every session folder. */
export async function listNotebooks(root?: FileRoot): Promise<NotebookEntry[]> {
  if (!isTauri) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<NotebookEntry[]>("list_notebooks", { root });
}

/** List one directory under the root (non-recursive; "" = the root). Desktop only. */
export async function listDir(rel: string, root?: FileRoot): Promise<DirEntry[]> {
  if (!isTauri) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<DirEntry[]>("list_dir", { rel, root });
}

/** Write text to a root-relative path (desktop only; throws in browser). */
export async function writeWorkspaceFile(
  path: string,
  content: string,
  root?: FileRoot,
): Promise<void> {
  if (!isTauri) throw new Error("not running in the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("write_workspace_file", { path, content, root });
}

/** Build a `data:` URL from a read artifact for <img>/<iframe>/pdf.js. */
export function toDataUrl(f: ArtifactFile): string {
  if (f.encoding === "base64") return `data:${f.mime};base64,${f.data}`;
  return `data:${f.mime};charset=utf-8,${encodeURIComponent(f.data)}`;
}

/** Decode a base64 artifact into raw bytes for binary renderers (docx/xlsx/pptx). */
export function base64ToBytes(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
