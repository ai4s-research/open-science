//! A copy of the OpenCode 1 history, taken before OpenCode 2 first opens it.
//!
//! OpenCode 2 converts `opencode.db` in place on first start and drops tables
//! OpenCode 1 needs, so after an upgrade the only way back to an OpenCode 1
//! build is the file as it was. Measured on a v1 profile, the conversion
//! changes nothing else: `auth.json`, `snapshot/` and `storage/` stay
//! byte-identical. Our own start-up edits the config file, so that is copied
//! too.
//!
//! One copy, `runtime/backup/opencode-1/`, laid out like `runtime/` so a
//! restore is a copy back (see `RESTORE.txt` inside). Every destructive step of
//! OpenCode 2's conversion runs after it creates `session_v2`, so a database
//! without that table is untouched OpenCode 1 history and the newest copy of
//! it is always the one to keep.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use rusqlite::{backup::Backup, backup::StepResult, Connection, OpenFlags};

const BACKUP_DIR: &str = "backup/opencode-1";
const DB: &str = "xdg-data/opencode/opencode.db";
const CONFIGS: &[&str] = &[
    "xdg-config/opencode/opencode.json",
    "xdg-config/opencode/opencode.jsonc",
];

/// Copy the OpenCode 1 history under `root` (the runtime root) if OpenCode 2
/// has not converted it yet and it changed since the last copy. Returns the
/// backup folder when a copy was made. An error means no complete copy exists
/// and OpenCode 2 must not be started.
pub fn back_up_opencode_1(root: &Path) -> Result<Option<PathBuf>, String> {
    let db = root.join(DB);
    if !db.is_file() || !is_opencode_1(&db)? {
        return Ok(None);
    }
    let dst = root.join(BACKUP_DIR);
    if copy_is_current(&db, &dst.join(DB)) {
        return Ok(None);
    }
    let partial = dst.with_extension("partial");
    let _ = std::fs::remove_dir_all(&partial);
    let made = write_copy(root, &db, &partial);
    if let Err(e) = made {
        let _ = std::fs::remove_dir_all(&partial);
        return Err(e);
    }
    // The new copy is complete and checked; only now give up the old one.
    if dst.exists() {
        std::fs::remove_dir_all(&dst).map_err(|e| format!("{}: {e}", dst.display()))?;
    }
    std::fs::rename(&partial, &dst).map_err(|e| format!("{}: {e}", dst.display()))?;
    Ok(Some(dst))
}

/// Opened read-only, so closing it cannot checkpoint the WAL and make the
/// database look written after the copy. Read-write only when a WAL without
/// its index leaves no other way to read it.
fn open_source(db: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .and_then(|c| c.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(())).map(|_| c))
        .or_else(|_| Connection::open(db))
        .map_err(|e| format!("{}: {e}", db.display()))
}

/// OpenCode 1 history: a `session` table and no `session_v2`.
fn is_opencode_1(db: &Path) -> Result<bool, String> {
    let c = open_source(db)?;
    let has = |name: &str| -> Result<bool, String> {
        c.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [name],
            |r| r.get::<_, i64>(0),
        )
        .map(|n| n > 0)
        .map_err(|e| format!("{}: {e}", db.display()))
    };
    Ok(has("session")? && !has("session_v2")?)
}

/// The last copy holds everything: the database has not been written since.
fn copy_is_current(db: &Path, copy: &Path) -> bool {
    let modified = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    let Some(copied) = modified(copy) else {
        return false;
    };
    let wal = PathBuf::from(format!("{}-wal", db.display()));
    [modified(db), modified(&wal)]
        .into_iter()
        .flatten()
        .all(|t: SystemTime| t <= copied)
}

fn write_copy(root: &Path, db: &Path, out: &Path) -> Result<(), String> {
    let out_db = out.join(DB);
    std::fs::create_dir_all(out_db.parent().unwrap()).map_err(|e| e.to_string())?;
    let src = open_source(db)?;
    {
        let mut dst = Connection::open(&out_db).map_err(|e| format!("{}: {e}", out_db.display()))?;
        // All pages in one step: one consistent read of the source, WAL included.
        let backup = Backup::new(&src, &mut dst).map_err(|e| e.to_string())?;
        loop {
            match backup.step(-1).map_err(|e| format!("copying {}: {e}", db.display()))? {
                StepResult::Done => break,
                _ => std::thread::sleep(std::time::Duration::from_millis(100)),
            }
        }
        drop(backup);
        // A single self-contained file: the copy inherits WAL mode, which would
        // leave -wal/-shm beside it for a restore to carry along. OpenCode turns
        // WAL back on when it opens the file.
        dst.pragma_update(None, "journal_mode", "DELETE").map_err(|e| e.to_string())?;
    }
    let count = |c: &Connection| c.query_row("SELECT count(*) FROM session", [], |r| r.get::<_, i64>(0));
    let copied = Connection::open_with_flags(&out_db, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .and_then(|c| count(&c))
        .map_err(|e| format!("checking {}: {e}", out_db.display()))?;
    let source = count(&src).map_err(|e| e.to_string())?;
    if copied != source {
        return Err(format!("the copy has {copied} sessions, the original {source}"));
    }
    for rel in CONFIGS {
        let from = root.join(rel);
        if from.is_file() {
            let to = out.join(rel);
            std::fs::create_dir_all(to.parent().unwrap()).map_err(|e| e.to_string())?;
            std::fs::copy(&from, &to).map_err(|e| format!("{}: {e}", from.display()))?;
        }
    }
    std::fs::write(out.join("RESTORE.txt"), restore_note(root)).map_err(|e| e.to_string())
}

fn restore_note(root: &Path) -> String {
    let data = root.join("xdg-data").join("opencode");
    format!(
        "Open Science copied your conversation history here before OpenCode 2 first opened it.\n\
         OpenCode 2 converts the history in place, and OpenCode 1 cannot fully use the result.\n\
         \n\
         To go back to an Open Science version built on OpenCode 1:\n\
         1. Quit Open Science.\n\
         2. Delete opencode.db, opencode.db-wal and opencode.db-shm in\n   {}\n\
         3. Copy the xdg-data and xdg-config folders from this folder into\n   {}\n   replacing the files there.\n\
         4. Install the older Open Science and open it.\n\
         \n\
         Conversations made after this copy are not in it.\n",
        data.display(),
        root.display()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh folder, removed when dropped.
    struct TempDir(PathBuf);
    impl TempDir {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn tempdir() -> TempDir {
        let dir = std::env::temp_dir().join(format!("osd-history-backup-{}", crate::runtime::random_hex(6)));
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    /// A v1-shaped profile in WAL mode, with rows still in the WAL.
    fn v1_profile(root: &Path, sessions: i64) -> Connection {
        let db = root.join(DB);
        std::fs::create_dir_all(db.parent().unwrap()).unwrap();
        let c = Connection::open(&db).unwrap();
        c.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
             CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT);",
        )
        .unwrap();
        for i in 0..sessions {
            c.execute("INSERT INTO session VALUES (?1, 'x')", [format!("ses_{i}")]).unwrap();
        }
        let cfg = root.join(CONFIGS[0]);
        std::fs::create_dir_all(cfg.parent().unwrap()).unwrap();
        std::fs::write(cfg, r#"{"plugin":["file:///old/origin.ts"]}"#).unwrap();
        c
    }

    fn sessions_in(db: &Path) -> i64 {
        Connection::open(db).unwrap().query_row("SELECT count(*) FROM session", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn copies_opencode_1_history_with_its_wal_and_the_config() {
        let dir = tempdir();
        let _open = v1_profile(dir.path(), 3);
        let out = back_up_opencode_1(dir.path()).unwrap().expect("a copy");
        // Rows that only lived in the WAL made it into the single-file copy.
        assert_eq!(sessions_in(&out.join(DB)), 3);
        for suffix in ["-wal", "-shm"] {
            assert!(!out.join(format!("{DB}{suffix}")).exists(), "{suffix} beside the copy");
        }
        assert_eq!(
            std::fs::read_to_string(out.join(CONFIGS[0])).unwrap(),
            r#"{"plugin":["file:///old/origin.ts"]}"#
        );
        assert!(std::fs::read_to_string(out.join("RESTORE.txt")).unwrap().contains("opencode.db-wal"));
        assert!(!dir.path().join("backup/opencode-1.partial").exists());
    }

    #[test]
    fn leaves_converted_and_missing_history_alone() {
        let dir = tempdir();
        assert_eq!(back_up_opencode_1(dir.path()).unwrap(), None);
        let c = v1_profile(dir.path(), 1);
        c.execute_batch("CREATE TABLE session_v2 (id TEXT PRIMARY KEY);").unwrap();
        assert_eq!(back_up_opencode_1(dir.path()).unwrap(), None);
        assert!(!dir.path().join("backup").exists());
    }

    #[test]
    fn copies_again_only_after_the_history_changed() {
        // The files an app killed mid-run leaves: rows still in the WAL, which
        // the first connection to close folds back into the database.
        let live = tempdir();
        let open = v1_profile(live.path(), 2);
        let dir = tempdir();
        for suffix in ["", "-wal", "-shm"] {
            let rel = format!("{DB}{suffix}");
            std::fs::create_dir_all(dir.path().join(&rel).parent().unwrap()).unwrap();
            std::fs::copy(live.path().join(&rel), dir.path().join(&rel)).unwrap();
        }
        drop(open);
        std::fs::create_dir_all(dir.path().join(CONFIGS[0]).parent().unwrap()).unwrap();
        let out = back_up_opencode_1(dir.path()).unwrap().expect("a copy");
        assert_eq!(sessions_in(&out.join(DB)), 2);
        assert!(dir.path().join(format!("{DB}-wal")).exists(), "the copy left the WAL as it found it");
        // An OpenCode 2 that keeps failing to start must not copy on every respawn.
        assert_eq!(back_up_opencode_1(dir.path()).unwrap(), None);
        assert_eq!(back_up_opencode_1(dir.path()).unwrap(), None);
        // History written afterwards (an older build used again) is copied anew,
        // replacing the stale copy.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let c = Connection::open(dir.path().join(DB)).unwrap();
        c.execute("INSERT INTO session VALUES ('ses_new', 'y')", []).unwrap();
        drop(c);
        let out = back_up_opencode_1(dir.path()).unwrap().expect("a fresh copy");
        assert_eq!(sessions_in(&out.join(DB)), 3);
        assert_eq!(back_up_opencode_1(dir.path()).unwrap(), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_copy_keeps_the_previous_one_and_reports() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir();
        drop(v1_profile(dir.path(), 2));
        let out = back_up_opencode_1(dir.path()).unwrap().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let c = Connection::open(dir.path().join(DB)).unwrap();
        c.execute("INSERT INTO session VALUES ('ses_new', 'y')", []).unwrap();
        drop(c);
        // Nowhere to write the new copy, as on a full disk.
        let backups = dir.path().join("backup");
        std::fs::set_permissions(&backups, std::fs::Permissions::from_mode(0o500)).unwrap();
        let result = back_up_opencode_1(dir.path());
        std::fs::set_permissions(&backups, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(result.is_err());
        assert_eq!(sessions_in(&out.join(DB)), 2);
    }
}
