//! Cross-device conversation sync, one JSON file per session (#124).
//!
//! Conversations live in the runtime's SQLite store under the app data dir, not
//! in the workspace, so a cloud-synced workspace carries files and no history.
//! Syncing that store as a file is not the answer: it is SQLite in WAL mode, and
//! file-level sync between two machines overwrites rather than merges it — the
//! failure mode is a lost database.
//!
//! The unit of syncing is therefore ONE SESSION, not one database. Each session
//! is mirrored to `<dir>/<session-id>.json`; a cloud drive is good at
//! synchronising many independent files and bad at synchronising one hot
//! database, and a conflict becomes a single conversation rather than all of
//! them.
//!
//! This module is deliberately thin. It shells out to the bundled runtime's own
//! `export`/`import`, because the format belongs to the runtime and any version
//! of it we re-implemented here would be a second, drifting definition. Three
//! properties of those commands were measured against the pinned 1.18.18 before
//! this was built, and the design rests on all three:
//!
//!   * `import` PRESERVES the session id — it does not create a copy.
//!   * Importing the same export twice leaves the store identical — idempotent.
//!   * Importing a divergent export UNIONS by message id, so two machines that
//!     each added different messages to one session end up with both.
//!
//! A running sidecar picks up an import immediately, with no restart, and
//! SQLite's own locking covers the concurrent access (the corruption risk is
//! file-level sync bypassing that locking, which is exactly what this avoids).

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::env::Env;
use crate::runtime::{
    enriched_path, quiet_command, runtime_root, sidecar_bin, xdg_config_home, xdg_data_home,
};

/// One mirrored session on disk.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MirrorFile {
    /// Session id, taken from the file name.
    pub session_id: String,
    /// Absolute path, so the caller need not rebuild it.
    pub path: String,
    /// Last-modified time in epoch ms — what "newer than ours" is decided on.
    pub modified: u64,
    pub size: u64,
}

/// Session ids are runtime-generated and go onto a command line; anything else
/// is refused rather than escaped. Also what keeps a mirror directory from
/// turning a stray file name into an argument.
fn valid_session_id(id: &str) -> bool {
    id.starts_with("ses_")
        && id.len() <= 128
        && id[4..].chars().all(|c| c.is_ascii_alphanumeric())
        && id.len() > 4
}

/// The store the CLI must be pointed at: exactly the dirs `runtime::start`
/// hands the sidecar. A CLI given different ones would read an EMPTY store and
/// exit successfully, so sync would mirror nothing and report that it worked.
/// Separated from the command so it can be asserted without a bundled binary.
fn cli_dirs(env: &Env) -> Result<[(&'static str, PathBuf); 4], String> {
    let root = runtime_root(env)?;
    Ok([
        ("XDG_CONFIG_HOME", xdg_config_home(env)?),
        ("XDG_DATA_HOME", xdg_data_home(env)?),
        ("XDG_CACHE_HOME", root.join("xdg-cache")),
        ("XDG_STATE_HOME", root.join("xdg-state")),
    ])
}

/// The bundled runtime CLI, pointed at the same store the sidecar uses.
fn runtime_cli(env: &Env) -> Result<Command, String> {
    let bin = sidecar_bin("opencode")
        .ok_or_else(|| "bundled OpenCode binary not found next to the executable".to_string())?;
    let mut cmd = quiet_command(bin);
    for (key, dir) in cli_dirs(env)? {
        cmd.env(key, dir);
    }
    cmd.env("HOME", std::env::var("HOME").unwrap_or_default())
        .env("PATH", enriched_path());
    Ok(cmd)
}

/// Write `bytes` to `path` without ever leaving a half-written file there.
/// Load-bearing on a cloud drive: the sync client uploads whatever it finds the
/// moment it changes, and a truncated export would propagate to every other
/// machine before the write finished.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("json.part");
    std::fs::write(&tmp, bytes).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("rename into {}: {e}", path.display()))
}

/// What one mirror-out attempt did.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ExportOutcome {
    pub path: String,
    /// Fingerprint of the conversation, ignoring volatile session metadata.
    /// Hand it back as `previous_hash` next time to skip an unchanged write.
    pub hash: String,
    /// False when the mirror already held this conversation and was left alone.
    pub written: bool,
}

/// Fingerprint of a conversation, deliberately blind to `info.time.updated`.
///
/// This is what stops two machines from syncing each other forever. Importing a
/// session bumps its `updated` even when the import changed NOTHING — measured
/// against 1.18.18 — and `updated` is what tells us a session is worth
/// mirroring. Left alone, machine A imports, its clock moves, it re-exports,
/// which moves the file, which makes B import, which moves B's clock… A diff of
/// two exports either side of a no-op import shows exactly one differing field,
/// `info.time.updated`, so excluding it makes "did this conversation actually
/// change?" answerable.
///
/// FNV-1a rather than a hash crate: the value is only ever compared with one we
/// wrote ourselves, and a dependency for that would be a poor trade. A hash that
/// changed between builds would cost one redundant write, not correctness.
fn conversation_hash(export: &[u8]) -> String {
    let normalized = match serde_json::from_slice::<serde_json::Value>(export) {
        Ok(mut value) => {
            if let Some(time) = value.pointer_mut("/info/time").and_then(|t| t.as_object_mut()) {
                time.remove("updated");
            }
            serde_json::to_vec(&value).unwrap_or_else(|_| export.to_vec())
        }
        // Not JSON we understand: fingerprint the bytes as they are. A mirror
        // that rewrites every pass is better than one that never rewrites.
        Err(_) => export.to_vec(),
    };
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in &normalized {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{hash:016x}")
}

/// Mirror one session out to `<dir>/<session-id>.json`.
///
/// `previous_hash` is what this machine last wrote for this session. When the
/// conversation still fingerprints the same, the file is left untouched —
/// rewriting it would change its timestamp, and every other machine's cloud
/// client would download and re-import a conversation that had not moved.
pub fn export_session(
    env: &Env,
    session_id: &str,
    dir: &Path,
    previous_hash: Option<&str>,
) -> Result<ExportOutcome, String> {
    if !valid_session_id(session_id) {
        return Err(format!("not a session id: {session_id}"));
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let out = runtime_cli(env)?
        .args(["export", session_id])
        .output()
        .map_err(|e| format!("run opencode export: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "opencode export {session_id}: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    // An empty export would replace a good mirror with nothing, and the next
    // machine would import the emptiness. Treat it as a failure, not a session.
    if out.stdout.iter().all(u8::is_ascii_whitespace) {
        return Err(format!("opencode export {session_id} produced nothing"));
    }
    let path = dir.join(format!("{session_id}.json"));
    let hash = conversation_hash(&out.stdout);
    let unchanged = previous_hash == Some(hash.as_str()) && path.is_file();
    if !unchanged {
        write_atomic(&path, &out.stdout)?;
    }
    Ok(ExportOutcome {
        path: path.to_string_lossy().to_string(),
        hash,
        written: !unchanged,
    })
}

/// Import one mirrored session. Safe to call on a file already imported: the
/// runtime keeps the session id and unions by message id.
///
/// Takes the mirror directory and a session id rather than a path, so the file
/// name is built here from an id that has been validated. Nothing outside the
/// chosen folder is reachable through this, whatever the caller passes.
pub fn import_session(env: &Env, dir: &Path, session_id: &str) -> Result<(), String> {
    if !valid_session_id(session_id) {
        return Err(format!("not a session id: {session_id}"));
    }
    let file = &dir.join(format!("{session_id}.json"));
    if !file.is_file() {
        return Err(format!("no such file: {}", file.display()));
    }
    let out = runtime_cli(env)?
        .arg("import")
        .arg(file)
        .output()
        .map_err(|e| format!("run opencode import: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "opencode import {}: {}",
            file.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

/// What the mirror directory holds right now. A missing directory is an empty
/// list, not an error — the other machine may simply not have synced yet, and a
/// cloud client creates the folder late.
pub fn list_mirror(dir: &Path) -> Result<Vec<MirrorFile>, String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("read {}: {e}", dir.display())),
    };
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue; // skips our own *.json.part, and anything else in there
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !valid_session_id(stem) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        files.push(MirrorFile {
            session_id: stem.to_string(),
            path: path.to_string_lossy().to_string(),
            modified,
            size: meta.len(),
        });
    }
    files.sort_by(|a, b| a.session_id.cmp(&b.session_id));
    Ok(files)
}

/// Is `dir` usable as a mirror? Checked before the setting is accepted, so the
/// failure is reported once in Settings rather than on every sync afterwards.
pub fn check_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let probe = dir.join(".osd-sync-write-test");
    std::fs::write(&probe, b"ok").map_err(|e| format!("write to {}: {e}", dir.display()))?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

/// Where the mirror lives by default when the user has not chosen: a folder
/// beside the workspace, so pointing the workspace at a cloud drive is enough.
pub fn default_dir(workspace: &Path) -> PathBuf {
    workspace.join("openscience-sync")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_runtime_session_ids_reach_the_command_line() {
        assert!(valid_session_id("ses_005bf676bffeQzLIIBFZeNp7G9"));
        for bad in [
            "ses_",                       // prefix alone
            "sess_abc",                   // wrong prefix
            "ses_abc-def",                // punctuation
            "ses_abc def",                // a second argument in disguise
            "ses_../../etc/passwd",       // traversal
            "../ses_abc",                 // traversal before the prefix
            "ses_abc;rm -rf /",           // shell metacharacters
        ] {
            assert!(!valid_session_id(bad), "should be refused: {bad}");
        }
    }

    #[test]
    fn the_cli_reads_the_same_store_as_the_sidecar() {
        // These four are written out by hand here and in `runtime::start`. If
        // they ever disagree, export finds an empty store and exits zero — sync
        // would mirror nothing and report success, the worst way for this to
        // fail. Asserted without the bundled binary on purpose: gating on
        // `runtime_cli` would make this pass vacuously wherever the sidecar has
        // not been fetched, which is most CI jobs.
        let Ok(env) = crate::env::Env::headless(None, "test".into()) else {
            return;
        };
        let root = runtime_root(&env).unwrap();
        let dirs = cli_dirs(&env).unwrap();
        assert_eq!(
            dirs,
            [
                ("XDG_CONFIG_HOME", root.join("xdg-config")),
                ("XDG_DATA_HOME", root.join("xdg-data")),
                ("XDG_CACHE_HOME", root.join("xdg-cache")),
                ("XDG_STATE_HOME", root.join("xdg-state")),
            ]
        );
        // And the store really is under the app's data dir, not somewhere else.
        assert!(root.starts_with(env.data_dir()));
    }

    #[test]
    fn import_refuses_anything_that_is_not_a_session_id() {
        // The id becomes a file name inside the chosen folder, so a traversal
        // here would reach outside it. Refused before the path is built.
        let dir = std::env::temp_dir();
        let env = crate::env::Env::headless(None, "test".into());
        if let Ok(env) = env {
            for bad in ["../../etc/passwd", "ses_a/../../x", "not-an-id"] {
                assert!(import_session(&env, &dir, bad).is_err(), "should refuse {bad}");
            }
        }
    }

    #[test]
    fn a_missing_mirror_directory_is_empty_not_an_error() {
        let dir = std::env::temp_dir().join("osd-sync-missing-xyz");
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(list_mirror(&dir).unwrap().len(), 0);
    }

    #[test]
    fn the_mirror_lists_only_well_formed_session_files() {
        let dir = std::env::temp_dir().join(format!("osd-sync-list-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for name in [
            "ses_005bf676bffeQzLIIBFZeNp7G9.json", // ours
            "ses_0d53d110dffeAwy5FU1JI6PpPk.json", // ours
            "ses_half.json.part",                  // a write in progress
            "notes.json",                          // someone else's file
            "ses_bad-id.json",                     // not a session id
            "README.md",
        ] {
            std::fs::write(dir.join(name), b"{}").unwrap();
        }
        let found: Vec<String> = list_mirror(&dir)
            .unwrap()
            .into_iter()
            .map(|f| f.session_id)
            .collect();
        assert_eq!(
            found,
            vec![
                "ses_005bf676bffeQzLIIBFZeNp7G9".to_string(),
                "ses_0d53d110dffeAwy5FU1JI6PpPk".to_string()
            ]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_atomic_write_leaves_no_partial_file_behind() {
        let dir = std::env::temp_dir().join(format!("osd-sync-atomic-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ses_abc.json");
        write_atomic(&path, b"{\"info\":{}}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"info\":{}}");
        assert!(!dir.join("ses_abc.json.part").exists());
        // A second write replaces rather than appends.
        write_atomic(&path, b"{}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_no_op_import_must_not_look_like_a_changed_conversation() {
        // The exact pair of exports observed either side of a no-op import
        // against 1.18.18: identical but for info.time.updated. If these
        // fingerprint differently, two machines resync each other forever.
        let before = br#"{"info":{"id":"ses_a","time":{"created":1,"updated":1788146636226}},"messages":[{"id":"m1"}]}"#;
        let after = br#"{"info":{"id":"ses_a","time":{"created":1,"updated":1788146722548}},"messages":[{"id":"m1"}]}"#;
        assert_eq!(conversation_hash(before), conversation_hash(after));
    }

    #[test]
    fn a_real_change_does_fingerprint_differently() {
        let one = br#"{"info":{"id":"ses_a","time":{"updated":1}},"messages":[{"id":"m1"}]}"#;
        let two = br#"{"info":{"id":"ses_a","time":{"updated":1}},"messages":[{"id":"m1"},{"id":"m2"}]}"#;
        assert_ne!(conversation_hash(one), conversation_hash(two));
    }

    #[test]
    fn a_non_json_export_still_fingerprints_rather_than_panicking() {
        assert_ne!(conversation_hash(b"not json"), conversation_hash(b"also not json"));
    }

    #[test]
    fn the_default_mirror_sits_beside_the_workspace() {
        assert_eq!(
            default_dir(Path::new("/tmp/ws")),
            PathBuf::from("/tmp/ws/openscience-sync")
        );
    }
}
