import { describe, expect, it } from "vitest";
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
} from "./sessionSync";

const file = (id: string, modified: number): SyncMirrorFile => ({
  session_id: id,
  path: `/mirror/${id}.json`,
  modified,
  size: 10,
});

describe("sessionsToExport", () => {
  it("mirrors everything the first time", () => {
    const sessions: SyncSession[] = [{ id: "ses_a", updated: 5 }, { id: "ses_b", updated: 7 }];
    expect(sessionsToExport(sessions, emptySyncState())).toEqual(["ses_a", "ses_b"]);
  });

  it("leaves an unchanged session alone — a rewritten file is a re-download everywhere", () => {
    let state = emptySyncState();
    state = noteExported(state, "ses_a", 5);
    expect(sessionsToExport([{ id: "ses_a", updated: 5 }], state)).toEqual([]);
  });

  it("mirrors again once the conversation moves on", () => {
    let state = emptySyncState();
    state = noteExported(state, "ses_a", 5);
    expect(sessionsToExport([{ id: "ses_a", updated: 6 }], state)).toEqual(["ses_a"]);
  });

  it("exports a session with no timestamp once, not on every pass", () => {
    let state = emptySyncState();
    expect(sessionsToExport([{ id: "ses_a" }], state)).toEqual(["ses_a"]);
    state = noteExported(state, "ses_a", undefined);
    expect(sessionsToExport([{ id: "ses_a" }], state)).toEqual([]);
  });
});

describe("filesToImport", () => {
  it("pulls in a file never seen before", () => {
    expect(filesToImport([file("ses_a", 100)], emptySyncState())).toHaveLength(1);
  });

  it("does not re-import a file at the same timestamp", () => {
    const state = noteSynced(emptySyncState(), file("ses_a", 100));
    expect(filesToImport([file("ses_a", 100)], state)).toEqual([]);
  });

  it("pulls it in again once the other machine has written to it", () => {
    const state = noteSynced(emptySyncState(), file("ses_a", 100));
    expect(filesToImport([file("ses_a", 140)], state)).toHaveLength(1);
  });

  it("does not import back what this machine just wrote", () => {
    // The export path marks the file synced, so the very next pass — which sees
    // a file whose mtime it has never imported — leaves it alone.
    let state = emptySyncState();
    state = noteExported(state, "ses_a", 5);
    state = noteSynced(state, file("ses_a", 100));
    expect(filesToImport([file("ses_a", 100)], state)).toEqual([]);
  });
});

describe("the fingerprint that stops two machines resyncing each other", () => {
  // Importing a session bumps its `updated` even when the import changed
  // nothing (measured against the pinned runtime). `updated` is what marks a
  // session for export, so without a content fingerprint each machine would
  // rewrite the mirror file at the other one indefinitely.
  it("still queues the session — the timestamp really did move", () => {
    let state = emptySyncState();
    state = noteExported(state, "ses_a", 5, "abc");
    // A no-op import bumped it from 5 to 9.
    expect(sessionsToExport([{ id: "ses_a", updated: 9 }], state)).toEqual(["ses_a"]);
  });

  it("carries the last fingerprint so the export can be skipped", () => {
    let state = emptySyncState();
    state = noteExported(state, "ses_a", 5, "abc");
    expect(state.hash["ses_a"]).toBe("abc");
    // The export returns the same fingerprint: nothing was written, and the
    // session is recorded at its new timestamp so it stops being queued.
    state = noteExported(state, "ses_a", 9, "abc");
    expect(sessionsToExport([{ id: "ses_a", updated: 9 }], state)).toEqual([]);
  });

  it("keeps a fingerprint when an export does not report one", () => {
    let state = noteExported(emptySyncState(), "ses_a", 5, "abc");
    state = noteExported(state, "ses_a", 9);
    expect(state.hash["ses_a"]).toBe("abc");
  });
});

describe("incomingSessionCount", () => {
  it("counts only conversations this machine does not have", () => {
    const files = [file("ses_a", 1), file("ses_b", 1), file("ses_c", 1)];
    expect(incomingSessionCount(files, [{ id: "ses_a" }])).toBe(2);
  });

  it("is zero once the two machines agree", () => {
    const files = [file("ses_a", 1)];
    expect(incomingSessionCount(files, [{ id: "ses_a" }])).toBe(0);
  });
});

describe("pruneSyncState", () => {
  it("forgets sessions and files that are gone, so the state cannot grow forever", () => {
    let state = emptySyncState();
    state = noteExported(state, "ses_a", 5);
    state = noteExported(state, "ses_gone", 5);
    state = noteSynced(state, file("ses_a", 100));
    state = noteSynced(state, file("ses_removed", 100));

    const pruned = pruneSyncState(state, [{ id: "ses_a", updated: 5 }], [file("ses_a", 100)]);
    expect(Object.keys(pruned.exported)).toEqual(["ses_a"]);
    expect(Object.keys(pruned.synced)).toEqual(["ses_a"]);
  });

  it("keeps a file whose session this machine has not imported yet", () => {
    // Present in the mirror, absent locally: that is precisely the file this
    // machine still needs, and pruning its bookkeeping would be wrong.
    const state = noteSynced(emptySyncState(), file("ses_new", 100));
    const pruned = pruneSyncState(state, [], [file("ses_new", 100)]);
    expect(pruned.synced).toEqual({ ses_new: 100 });
  });
});
