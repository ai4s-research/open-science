/**
 * Deciding what to mirror out and what to pull in (#124).
 *
 * Conversations live in the runtime's store on each machine, not in the
 * workspace, so a cloud-synced workspace carries files and no history. Syncing
 * the store itself is not the answer — it is one hot SQLite database, and
 * file-level sync overwrites rather than merges it. So the unit here is ONE
 * SESSION: each becomes `<dir>/<session-id>.json`, which a cloud drive can
 * actually synchronise, and a conflict costs one conversation instead of all.
 *
 * The runtime's own import was measured before this was designed: it preserves
 * the session id, it is idempotent, and it UNIONS by message id. The last one
 * is what makes this safe without a merge algorithm of our own — two machines
 * that each added messages to the same session converge on both, so nothing
 * here has to decide whose copy wins. These functions only decide what is worth
 * the work, which is why they are this small.
 */

/** A session as the app already knows it. */
export interface SyncSession {
  id: string;
  /** Epoch ms of the last change, from the runtime. */
  updated?: number;
}

/** A mirrored file, as `sync_list_mirror` reports it. */
export interface SyncMirrorFile {
  session_id: string;
  path: string;
  /** Epoch ms. */
  modified: number;
  size: number;
}

/**
 * What this machine has already reconciled, persisted so a restart does not
 * redo every session.
 *
 * `exported` is keyed on the session's own `updated`, `synced` on the mirror
 * file's `modified` — two different clocks, deliberately. A file's timestamp
 * comes from whichever machine wrote it (and from the cloud client when it
 * lands here), so it cannot be compared against a session's; keeping them apart
 * is what stops one machine's clock skew from suppressing the other's work.
 */
export interface SyncState {
  /** `updated` of the session the last time we mirrored it out. */
  exported: Record<string, number>;
  /** `modified` of the mirror file the last time we reconciled with it. */
  synced: Record<string, number>;
  /** Fingerprint of the conversation this machine last wrote, so an export that
   *  turns out to be identical leaves the file — and therefore every other
   *  machine — alone. Importing bumps a session's `updated` even when it
   *  changed nothing, so without this two machines resync each other forever. */
  hash: Record<string, string>;
}

export const emptySyncState = (): SyncState => ({ exported: {}, synced: {}, hash: {} });

/** Sessions whose latest change is not in the mirror yet. A session with no
 *  `updated` is mirrored once and then left alone: rewriting a file that has
 *  not changed makes every other machine's cloud client re-download it. */
export function sessionsToExport(sessions: SyncSession[], state: SyncState): string[] {
  return sessions
    .filter((session) => {
      const done = state.exported[session.id];
      if (done === undefined) return true;
      return session.updated !== undefined && session.updated > done;
    })
    .map((session) => session.id);
}

/** Files this machine has not reconciled at their current timestamp. Files we
 *  wrote ourselves are marked synced without importing (see `noteSynced`), so
 *  this does not have to tell them apart. */
export function filesToImport(files: SyncMirrorFile[], state: SyncState): SyncMirrorFile[] {
  return files.filter((file) => state.synced[file.session_id] !== file.modified);
}

/** Record that a session has been mirrored out at this `updated`. */
export function noteExported(
  state: SyncState,
  id: string,
  updated: number | undefined,
  hash?: string,
): SyncState {
  return {
    ...state,
    exported: { ...state.exported, [id]: updated ?? Date.now() },
    hash: hash === undefined ? state.hash : { ...state.hash, [id]: hash },
  };
}

/** Record that this machine is level with a mirror file — after importing it,
 *  and also after writing it, which is what keeps a machine from importing its
 *  own export back on the next pass. */
export function noteSynced(state: SyncState, file: SyncMirrorFile): SyncState {
  return { ...state, synced: { ...state.synced, [file.session_id]: file.modified } };
}

/** Sessions present only in the mirror — what this machine gains. Reported
 *  instead of a file count, which would over-report: on a settled pair of
 *  machines most files are already here. */
export function incomingSessionCount(files: SyncMirrorFile[], sessions: SyncSession[]): number {
  const here = new Set(sessions.map((s) => s.id));
  return files.filter((f) => !here.has(f.session_id)).length;
}

/** Drop bookkeeping for sessions and files that no longer exist, so the state
 *  cannot grow without bound on a machine that deletes conversations. */
export function pruneSyncState(
  state: SyncState,
  sessions: SyncSession[],
  files: SyncMirrorFile[],
): SyncState {
  const liveSessions = new Set(sessions.map((s) => s.id));
  const liveFiles = new Set(files.map((f) => f.session_id));
  const keep = <V,>(source: Record<string, V>, live: Set<string>): Record<string, V> =>
    Object.fromEntries(Object.entries(source).filter(([id]) => live.has(id)));
  return {
    exported: keep(state.exported, liveSessions),
    synced: keep(state.synced, liveFiles),
    hash: keep(state.hash, liveSessions),
  };
}
