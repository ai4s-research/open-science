/**
 * Running one conversation-sync pass (#124).
 *
 * The policy lives in `sessionSync.ts` and is tested there; this is the part
 * that touches the world — the runtime CLI through Tauri, the mirror folder,
 * and the stored bookkeeping. Desktop only: it needs a folder on this machine
 * and a local runtime to import into, neither of which the web client has.
 */

import { isTauri } from "./tauri";
import {
  emptySyncState,
  filesToImport,
  incomingSessionCount,
  noteExported,
  noteSynced,
  pruneSyncState,
  sessionsToExport,
  type SyncMirrorFile,
  type SyncSession,
  type SyncState,
} from "./sessionSync";

export const SYNC_DIR_KEY = "ai4s.sync.dir.v1";
const SYNC_STATE_KEY = "ai4s.sync.state.v1";
const SYNC_LAST_KEY = "ai4s.sync.last.v1";

/** The chosen mirror folder, or null when sync is off (the default). */
export function syncDir(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(SYNC_DIR_KEY) || null;
}

export function setSyncDir(dir: string | null): void {
  if (typeof window === "undefined") return;
  if (dir) window.localStorage.setItem(SYNC_DIR_KEY, dir);
  else window.localStorage.removeItem(SYNC_DIR_KEY);
}

function loadState(): SyncState {
  if (typeof window === "undefined") return emptySyncState();
  try {
    const raw = window.localStorage.getItem(SYNC_STATE_KEY);
    if (!raw) return emptySyncState();
    const parsed = JSON.parse(raw) as Partial<SyncState>;
    // A state written by an older or corrupted build must not stop sync; the
    // worst an empty one costs is one redundant pass, and import is idempotent.
    return {
      exported: parsed.exported ?? {},
      synced: parsed.synced ?? {},
      hash: parsed.hash ?? {},
    };
  } catch {
    return emptySyncState();
  }
}

function saveState(state: SyncState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SYNC_STATE_KEY, JSON.stringify(state));
  } catch {
    // A full quota costs a redundant pass next time, not correctness.
  }
}

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke: call } = await import("@tauri-apps/api/core");
  return call<T>(cmd, args);
}

interface ExportOutcome {
  path: string;
  hash: string;
  /** False when the conversation had not changed and the file was left alone. */
  written: boolean;
}

export interface SyncResult {
  imported: number;
  /** Conversations actually written to the mirror. An unchanged one is not
   *  counted, because it was not rewritten — see the hash in `sessionSync`. */
  exported: number;
  /** Conversations this machine did not have before the pass. */
  arrived: number;
  /** One line per failure. A pass reports what it could not do and keeps the
   *  rest — one unreadable file must not stop every other conversation. */
  errors: string[];
}

/** The outcome of the most recent pass, for the Settings card. Background
 *  passes are silent by design, so without this a user who turned sync on has
 *  no way to tell whether it is working — and a folder that has gone away would
 *  fail every pass unnoticed. */
export interface LastSync {
  at: number;
  imported: number;
  exported: number;
  error?: string;
}

export function lastSync(): LastSync | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SYNC_LAST_KEY);
    return raw ? (JSON.parse(raw) as LastSync) : null;
  } catch {
    return null;
  }
}

function noteLastSync(result: SyncResult): void {
  if (typeof window === "undefined") return;
  try {
    const entry: LastSync = {
      at: Date.now(),
      imported: result.imported,
      exported: result.exported,
      ...(result.errors.length > 0 ? { error: result.errors[0] } : {}),
    };
    window.localStorage.setItem(SYNC_LAST_KEY, JSON.stringify(entry));
  } catch {
    // Losing the readout costs the user a status line, not their data.
  }
}

/** Is the chosen folder usable? Answered once when the setting is saved. */
export async function checkSyncDir(dir: string): Promise<void> {
  await invoke<void>("sync_check_dir", { dir });
}

/**
 * One pass: pull in what the other machines wrote, then mirror out what this
 * one changed.
 *
 * Import runs FIRST so a session edited on both machines converges before we
 * write it back — the runtime unions by message id, so importing then exporting
 * publishes the merged conversation rather than overwriting the other side's
 * half with ours.
 */
export async function runSync(sessions: SyncSession[]): Promise<SyncResult | null> {
  const dir = syncDir();
  if (!isTauri || !dir) return null;

  const result: SyncResult = { imported: 0, exported: 0, arrived: 0, errors: [] };
  let state = loadState();

  let files: SyncMirrorFile[];
  try {
    files = await invoke<SyncMirrorFile[]>("sync_list_mirror", { dir });
  } catch (err) {
    const failed = { ...result, errors: [message(err)] };
    noteLastSync(failed);
    return failed;
  }
  result.arrived = incomingSessionCount(files, sessions);

  for (const file of filesToImport(files, state)) {
    try {
      await invoke<void>("sync_import_session", { dir, sessionId: file.session_id });
      state = noteSynced(state, file);
      result.imported += 1;
    } catch (err) {
      result.errors.push(message(err));
    }
  }

  const wroteIds = new Set<string>();
  for (const id of sessionsToExport(sessions, state)) {
    try {
      // The previous fingerprint is what lets an unchanged conversation skip
      // the write. Importing bumps a session's `updated` even when nothing
      // changed, so without it the two machines would rewrite this file at each
      // other indefinitely.
      const outcome = await invoke<ExportOutcome>("sync_export_session", {
        sessionId: id,
        dir,
        previousHash: state.hash[id] ?? null,
      });
      state = noteExported(state, id, sessions.find((s) => s.id === id)?.updated, outcome.hash);
      if (outcome.written) {
        wroteIds.add(id);
        result.exported += 1;
      }
    } catch (err) {
      result.errors.push(message(err));
    }
  }

  // Re-read once so the files we just wrote are recorded at their real mtime.
  // Without this the next pass sees timestamps it has never imported and pulls
  // our own exports straight back in — harmless, because import is idempotent,
  // but it is a process spawn per session per pass.
  //
  // ONLY the ones written in this pass. Marking every session this machine has
  // ever exported would mark a file whose import failed moments ago — the error
  // is reported, the file is recorded as reconciled, and that update is then
  // never retried. It would also swallow anything the other machine wrote
  // between the two listings.
  if (wroteIds.size > 0) {
    try {
      files = await invoke<SyncMirrorFile[]>("sync_list_mirror", { dir });
      for (const file of files) {
        if (wroteIds.has(file.session_id)) state = noteSynced(state, file);
      }
    } catch (err) {
      result.errors.push(message(err));
    }
  }

  saveState(pruneSyncState(state, sessions, files));
  noteLastSync(result);
  return result;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
