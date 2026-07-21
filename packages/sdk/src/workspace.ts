// packages/sdk/src/workspace.ts
//
// File/workspace operations on the runtime seam. Separate from `AgentRuntime`
// (RFC runtime-evolution.md §4.2 Decision 1): a runtime MAY implement this —
// the desktop host always can (it owns the filesystem); a remote/ACP runtime
// can decline or proxy. `OpenCodeClient implements WorkspaceOps` by forwarding
// to the existing Tauri commands (no Rust changes). The interface knows only
// ONE root — the runtime's current working directory. The desktop's `base`
// concept (projects root) stays a host-app concern, NOT on this interface.

export type { DirEntry, ArtifactFile, FileRoot } from "@ai4s/shared";

import type { DirEntry, ArtifactFile } from "@ai4s/shared";

/**
 * Read/list/write/delete files in the runtime's workspace. All paths are
 * relative to the runtime's current working directory; absolute paths and
 * `..` traversal are rejected by the desktop implementation.
 *
 * Implementations should enforce the existing preview-size cap (25 MB on
 * `readFile`) and trigger the debounced git snapshot on `writeFile`/`deleteFile`.
 */
export interface WorkspaceOps {
  /** Non-recursive listing of a directory under the workspace root.
   *  `rel = ""` lists the root itself. */
  listDir(relPath: string): Promise<DirEntry[]>;

  /** Read a file. Returns `{ text }` for UTF-8 content, `{ artifact }` for
   *  binary (carrying the existing base64-encoded `ArtifactFile` shape so
   *  callers can reuse `toDataUrl`/`base64ToBytes`). Throws on files >25 MB
   *  or outside the workspace root. */
  readFile(relPath: string): Promise<{ text: string } | { artifact: ArtifactFile }>;

  /** Write text to a root-relative path. Refuses absolute paths and `..`.
   *  Binary writes are not yet supported (TODO: requires extending
   *  `write_workspace_file` Rust command to accept bytes). Triggers the
   *  debounced git snapshot. */
  writeFile(relPath: string, content: string): Promise<void>;

  /** Delete a file (not a directory). Refuses paths outside the workspace root. */
  deleteFile(relPath: string): Promise<void>;
}
