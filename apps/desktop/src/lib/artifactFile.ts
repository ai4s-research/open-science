// Read/open workspace files for artifact previews (desktop only). In a plain
// browser these return null / no-op so the app still runs in `pnpm dev`.
// Paths are root-relative; `root` picks the tree ("workspace" = the active
// session folder, default; "base" = the folder all session workspaces live under).
import type { FileRoot } from "@ai4s/shared";
import { isTauri } from "./tauri";
import { isGatewayWeb, gatewayToken, gatewayOrigin } from "./webMode";

export type { FileRoot };

export interface ArtifactFile {
  path: string;
  mime: string;
  /** "utf8" for text, "base64" for binary. */
  encoding: "utf8" | "base64";
  data: string;
  size: number;
}

/** Read a root-relative file. Returns null outside the desktop app or on error paths. */
export async function readArtifact(path: string, root?: FileRoot): Promise<ArtifactFile | null> {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ArtifactFile>("read_artifact", { path, root });
}

/** Local-server URL a workspace file is previewable at (desktop only). The tiny
 *  Rust file server gives the webview a real http://127.0.0.1 URL with correct
 *  MIME, so native viewers (PDF, images, HTML) render it directly. */
export async function previewUrl(path: string, root?: FileRoot, dir?: string): Promise<string | null> {
  if (isGatewayWeb) {
    const t = gatewayToken();
    return (
      `${gatewayOrigin()}/v1/fs/read?path=${encodeURIComponent(path)}` +
      `${root ? `&root=${root}` : ""}${dir ? `&dir=${encodeURIComponent(dir)}` : ""}` +
      `${t ? `&token=${encodeURIComponent(t)}` : ""}`
    );
  }
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
  const inflight = resolvedPaths.get(path);
  if (inflight) return inflight;
  const lookup = (async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string | null>("resolve_artifact", { path });
  })();
  resolvedPaths.set(path, lookup);
  // A failed lookup must not be remembered as an answer — drop it so the next
  // mention can try again.
  lookup.catch(() => resolvedPaths.delete(path));
  return lookup;
}

/**
 * Resolutions are stable for a given workspace, and switching to a pane mounts
 * every one of its messages at once — so an uncached call per file mention meant
 * N identical IPC round-trips, each one a directory walk over the workspace
 * (#92). Misses are cached too: "this file does not exist" is exactly the answer
 * that costs a full walk to produce.
 */
const resolvedPaths = new Map<string, Promise<string | null>>();

/** Forget every resolution — they are only valid for one workspace folder. */
export function clearResolvedPaths(): void {
  resolvedPaths.clear();
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

export interface DirEntry {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  /** Seconds since the epoch. */
  modified: number;
}

/** List one directory under the root (non-recursive; "" = the root). Desktop only. */
export async function listDir(rel: string, root?: FileRoot, dir?: string): Promise<DirEntry[]> {
  if (isGatewayWeb) {
    const t = gatewayToken();
    const url =
      `${gatewayOrigin()}/v1/fs/list?path=${encodeURIComponent(rel)}` +
      `${root ? `&root=${root}` : ""}${dir ? `&dir=${encodeURIComponent(dir)}` : ""}`;
    try {
      const r = await fetch(url, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
      return r.ok ? ((await r.json()) as DirEntry[]) : [];
    } catch {
      return [];
    }
  }
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
