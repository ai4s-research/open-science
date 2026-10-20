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

/// The folder a mirrored session should be filed in on THIS machine.
///
/// `opencode import` files the session in the importing process's working
/// directory — it does NOT keep the folder the export recorded. Measured
/// against the pinned 1.18.18: an export whose `info.directory` named one
/// folder, imported from another, came back recorded in the second. So the
/// working directory is not an incidental detail of how the command is spawned;
/// it IS the destination, and inheriting whatever the app was launched with
/// would file every synced conversation wherever the launcher happened to be —
/// `/` for a Finder-launched .app. A conversation filed apart from the files it
/// names is the state that makes it report "file not found" for its own
/// notebook, in a folder that still holds it.
///
/// Chosen, then, rather than inherited: the folder the conversation recorded
/// when this machine has it — the cloud-synced workspace of #123, where both
/// machines see the same path, which is the case this feature exists for — and
/// otherwise the base folder, which always exists and is where session folders
/// live.
///
/// The recorded folder is a path out of a file in a cloud-synced directory, so
/// it is held to the same rule every other caller-supplied session directory in
/// this codebase is (`gateway::session_dir`, `fs_base`): inside the base
/// workspace, or a registered project's own folder. Anything else falls back
/// rather than being honoured — a mirror file must not be able to name the
/// folder an imported conversation, and the agent that later runs in it, works
/// in.
fn import_dir(env: &Env, file: &Path) -> Result<PathBuf, String> {
    let base = crate::runtime::base_workspace_dir(env)?;
    let recorded = std::fs::read_to_string(file)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|v| v["info"]["directory"].as_str().map(PathBuf::from))
        .and_then(|d| d.canonicalize().ok())
        .filter(|d| {
            d.is_dir()
                && (base.canonicalize().map(|b| d.starts_with(b)).unwrap_or(false)
                    || crate::project::is_registered_project_path(env, d))
        });
    Ok(recorded.unwrap_or(base))
}

/// The import, built but not run — separated from `import_session` for the same
/// reason `cli_dirs` is separated from `runtime_cli`: the working directory IS
/// the destination folder (see `import_dir`), and a destination that can only be
/// observed by running a bundled binary is a destination nothing asserts.
fn import_command(env: &Env, file: &Path) -> Result<Command, String> {
    let mut cmd = runtime_cli(env)?;
    cmd.current_dir(import_dir(env, file)?).arg("import").arg(file);
    Ok(cmd)
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
    let out = import_command(env, file)?
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

/// What moving a session into a project did.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveOutcome {
    /// The folder the conversation now lives in: the project's.
    pub directory: String,
    /// The link to the session's own folder now in the project folder — when
    /// it had one with something in it.
    pub link: Option<String>,
}

/// The session's own folder — the dated one the app made for it under
/// `sessions/` — when `dir` is that and it holds anything besides its `.git`.
/// A project's folder is shared by all its sessions, and an empty folder has
/// nothing to keep track of; neither is indexed.
fn own_folder(env: &Env, dir: &Path) -> Option<PathBuf> {
    let dir = dir.canonicalize().ok()?;
    let sessions = crate::runtime::sessions_dir(env).ok()?.canonicalize().ok()?;
    if dir.parent() != Some(sessions.as_path()) {
        return None;
    }
    let has_work = std::fs::read_dir(&dir)
        .ok()?
        .filter_map(Result::ok)
        .any(|e| e.file_name() != ".git");
    has_work.then_some(dir)
}

/// Move a conversation into a project, for real: from then on it lives in the
/// project's folder, and the agent works there.
///
/// The runtime's own "move session" refuses to cross repositories, and every
/// session folder and project here is its own repository — so it can never do
/// this. `import` can: it files an EXISTING session in the importing process's
/// working directory, keeping its id and messages (see `import_dir`; measured
/// again against the pinned 1.18.32 across two repositories: same id, same
/// messages, new directory and project). So: export, then import from inside
/// the project.
///
/// The files do NOT move or get copied. The session's own folder stays where
/// it is, and the project folder gains ONE entry: a link to it, named after
/// the session (see `project::link_folder`). That is how the user finds the
/// session's files in the project, and how the agent still reaches what its
/// earlier turns made. Linked BEFORE the import and unlinked again if the
/// import fails, so a failure leaves no half move behind.
///
/// The project is named by id, never by a raw path, like every other project
/// command: a caller cannot point a conversation at an arbitrary folder.
pub fn move_session_to_project(env: &Env, session_id: &str, project_id: &str) -> Result<MoveOutcome, String> {
    if !valid_session_id(session_id) {
        return Err(format!("not a session id: {session_id}"));
    }
    let project = crate::project::project_folder(env, project_id)?
        .canonicalize()
        .map_err(|e| format!("project folder: {e}"))?;

    let out = runtime_cli(env)?
        .args(["export", session_id])
        .output()
        .map_err(|e| format!("run opencode export: {e}"))?;
    if !out.status.success() || out.stdout.iter().all(u8::is_ascii_whitespace) {
        return Err(format!(
            "opencode export {session_id}: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let info = serde_json::from_slice::<serde_json::Value>(&out.stdout)
        .map(|v| v["info"].clone())
        .unwrap_or_default();
    let recorded = info["directory"].as_str().map(PathBuf::from);
    if recorded.as_deref().and_then(|d| d.canonicalize().ok()).as_deref() == Some(project.as_path()) {
        return Ok(MoveOutcome { directory: project.to_string_lossy().to_string(), link: None });
    }

    let linked = match recorded.as_deref().and_then(|d| own_folder(env, d)) {
        Some(folder) => {
            let title = info["title"].as_str().unwrap_or_default();
            Some(crate::project::link_folder(env, project_id, &folder, session_id, title)?)
        }
        None => None,
    };

    // The export is the user's conversation: kept in the app's own folder, and
    // only for as long as the import needs it.
    let file = runtime_root(env)?.join(format!("move-{session_id}.json"));
    let imported = std::fs::write(&file, &out.stdout)
        .map_err(|e| format!("write {}: {e}", file.display()))
        .and_then(|_| {
            let res = runtime_cli(env)?
                .current_dir(&project)
                .arg("import")
                .arg(&file)
                .output()
                .map_err(|e| format!("run opencode import: {e}"))?;
            if res.status.success() {
                Ok(())
            } else {
                Err(format!("opencode import: {}", String::from_utf8_lossy(&res.stderr).trim()))
            }
        });
    let _ = std::fs::remove_file(&file);
    if let Err(e) = imported {
        if let Some(l) = &linked {
            let _ = crate::project::unlink_folder(env, project_id, &l.path);
        }
        return Err(e);
    }
    Ok(MoveOutcome {
        directory: project.to_string_lossy().to_string(),
        link: linked.map(|l| l.link),
    })
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

    /// A throwaway base workspace with one project and one dated session folder.
    fn move_fixture(tag: &str) -> (PathBuf, crate::env::Env, crate::project::ProjectInfo, PathBuf) {
        let root = std::env::temp_dir().join(format!("os-move-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let base = root.join("base");
        std::fs::create_dir_all(&base).unwrap();
        std::fs::create_dir_all(root.join("runtime")).unwrap();
        let env = crate::env::Env::new(root.clone(), root.join("res"), None, "0.0.0".into());
        crate::runtime::set_workspace_base(&env, base.to_string_lossy().to_string()).unwrap();
        let project = crate::project::create_project(&env, "Target").unwrap();
        let dated = crate::runtime::sessions_dir(&env).unwrap().join("2026-10-18-0900");
        std::fs::create_dir_all(dated.join(".git")).unwrap();
        std::fs::create_dir_all(dated.join("figures")).unwrap();
        std::fs::write(dated.join(".git").join("HEAD"), "ref: refs/heads/main").unwrap();
        std::fs::write(dated.join("analysis.ipynb"), "{}").unwrap();
        std::fs::write(dated.join("figures").join("fig1.png"), "png").unwrap();
        (root, env, project, dated)
    }

    #[test]
    fn only_a_sessions_own_folder_with_work_in_it_is_indexed() {
        let (root, env, project, dated) = move_fixture("own");
        assert_eq!(own_folder(&env, &dated), Some(dated.canonicalize().unwrap()));
        // A project's folder is every one of its sessions' — leaving takes nothing.
        assert_eq!(own_folder(&env, Path::new(&project.path)), None);
        // Nor the sessions folder itself, its parent, or something inside a session folder.
        let sessions = crate::runtime::sessions_dir(&env).unwrap();
        assert_eq!(own_folder(&env, &sessions), None);
        assert_eq!(own_folder(&env, sessions.parent().unwrap()), None);
        assert_eq!(own_folder(&env, &dated.join("figures")), None);
        // A session folder holding nothing but its repository has nothing to keep.
        let empty = sessions.join("2026-10-18-1000");
        std::fs::create_dir_all(empty.join(".git")).unwrap();
        assert_eq!(own_folder(&env, &empty), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn linking_adds_one_entry_to_the_project_folder_and_unlinking_removes_only_it() {
        let (root, env, project, dated) = move_fixture("index");
        let project_dir = PathBuf::from(&project.path);
        let entry = crate::project::link_folder(&env, &project.id, &dated, "ses_a", "Spike sorting: v2").unwrap();
        // One entry, named after the session, pointing at the folder where it is.
        let link = PathBuf::from(&entry.link);
        assert_eq!(link, project_dir.canonicalize().unwrap().join("Spike sorting v2"));
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert!(link.join("figures").join("fig1.png").is_file());
        // Linking it again does not add a second one.
        crate::project::link_folder(&env, &project.id, &dated, "ses_a", "Spike sorting: v2").unwrap();
        let listed = crate::project::list_projects(&env).unwrap();
        assert_eq!(listed.iter().find(|p| p.id == project.id).unwrap().linked.len(), 1);

        crate::project::unlink_folder(&env, &project.id, &entry.path).unwrap();
        assert!(std::fs::symlink_metadata(&link).is_err());
        assert!(dated.join("analysis.ipynb").is_file());
        assert!(crate::project::list_projects(&env).unwrap().iter().find(|p| p.id == project.id).unwrap().linked.is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn deleting_the_link_in_the_folder_unlinks_it_and_a_real_folder_is_never_removed() {
        let (root, env, project, dated) = move_fixture("finder");
        let entry = crate::project::link_folder(&env, &project.id, &dated, "ses_a", "probe").unwrap();
        // The user deletes the link in Finder: the project no longer lists it.
        std::fs::remove_file(&entry.link).unwrap();
        assert!(crate::project::list_projects(&env).unwrap().iter().find(|p| p.id == project.id).unwrap().linked.is_empty());

        // Something real now sits where the link was: unlinking must refuse to
        // touch it rather than delete the user's folder.
        std::fs::create_dir_all(PathBuf::from(&entry.link).join("mine")).unwrap();
        assert!(crate::project::unlink_folder(&env, &project.id, &entry.path).is_err());
        assert!(PathBuf::from(&entry.link).join("mine").is_dir());
        let _ = std::fs::remove_dir_all(root);
    }

    /// The whole move against the real runtime CLI: the conversation keeps its
    /// id and ends up filed in the project, and the project folder gains exactly
    /// one entry — a link to the session's folder, which stays where it was.
    /// Needs the bundled binary next to the test executable; skipped (not
    /// passed vacuously) without it.
    #[test]
    fn moving_a_session_files_it_in_the_project_and_links_its_folder() {
        if sidecar_bin("opencode").is_none() {
            eprintln!("skipped: no bundled opencode next to the test binary");
            return;
        }
        let (root, env, project, dated) = move_fixture("e2e");
        let id = "ses_0123456789abcdefMoveProbe01";
        let seed = root.join("seed.json");
        let info = serde_json::json!({
            "id": id, "slug": "move-probe", "projectID": "global",
            "directory": dated.to_string_lossy(), "path": "", "title": "move probe",
            "version": "1.18.32", "time": { "created": 1, "updated": 1 },
        });
        std::fs::write(&seed, serde_json::json!({ "info": info, "messages": [] }).to_string()).unwrap();
        let seeded = runtime_cli(&env).unwrap().current_dir(&dated).arg("import").arg(&seed).output().unwrap();
        assert!(seeded.status.success(), "{}", String::from_utf8_lossy(&seeded.stderr));

        let project_dir = PathBuf::from(&project.path).canonicalize().unwrap();
        let before: Vec<_> = std::fs::read_dir(&project_dir).unwrap().map(|e| e.unwrap().file_name()).collect();

        let moved = move_session_to_project(&env, id, &project.id).unwrap();
        assert_eq!(PathBuf::from(&moved.directory), project_dir);
        let link = PathBuf::from(moved.link.expect("its own folder is linked"));
        assert_eq!(link, project_dir.join("move probe"));
        assert_eq!(link.canonicalize().unwrap(), dated.canonicalize().unwrap());

        // Exactly one new entry in the project folder; the files are where they were.
        let mut after: Vec<_> = std::fs::read_dir(&project_dir).unwrap().map(|e| e.unwrap().file_name()).collect();
        after.retain(|n| !before.contains(n));
        assert_eq!(after, vec![std::ffi::OsString::from("move probe")]);
        assert!(dated.join("figures").join("fig1.png").is_file());
        // And the index says so, under the session's title.
        let listed = crate::project::list_projects(&env).unwrap();
        let entry = &listed.iter().find(|p| p.id == project.id).unwrap().linked;
        assert_eq!(entry.len(), 1);
        assert_eq!((entry[0].session_id.as_str(), entry[0].title.as_str()), (id, "move probe"));

        // What the runtime itself now says about the session.
        let out = runtime_cli(&env).unwrap().args(["export", id]).output().unwrap();
        let exported: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(exported["info"]["id"], id);
        assert_eq!(
            PathBuf::from(exported["info"]["directory"].as_str().unwrap()).canonicalize().unwrap(),
            project_dir
        );
        assert!(!runtime_root(&env).unwrap().join(format!("move-{id}.json")).exists());

        // Moving it again is a no-op.
        assert_eq!(move_session_to_project(&env, id, &project.id).unwrap().link, None);
        let _ = std::fs::remove_dir_all(root);
    }

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

    /// `import` files a session in the process's working directory, not in the
    /// folder the export recorded — measured against 1.18.18. So the directory
    /// is the destination, and it must be chosen here rather than inherited from
    /// whatever launched the app (`/`, for a Finder-launched .app), which would
    /// file every synced conversation apart from the files it names.
    #[test]
    fn an_import_is_filed_in_a_folder_this_machine_actually_has() {
        let root = std::env::temp_dir().join(format!("os-import-dir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let base = root.join("base");
        std::fs::create_dir_all(&base).unwrap();
        std::fs::create_dir_all(root.join("runtime")).unwrap(); // where the record is written
        let env = crate::env::Env::new(root.clone(), root.join("res"), None, "0.0.0".into());
        crate::runtime::set_workspace_base(&env, base.to_string_lossy().to_string()).unwrap();

        let mirror = root.join("mirror");
        std::fs::create_dir_all(&mirror).unwrap();
        // The mirror file is a real `opencode export`'s JSON. Building the
        // fixture by hand with `format!` put a Windows path (backslashes) into
        // the JSON, where `\U`, `\b`, `\s`… are illegal escapes — so the export
        // parsed as nothing and every case silently fell back to the base
        // folder. Build it with serde instead, exactly like the runtime does,
        // and the escaping is right on every platform.
        let write = |name: &str, dir: &str| {
            let f = mirror.join(name);
            let text = serde_json::json!({ "info": { "directory": dir }, "messages": [] }).to_string();
            std::fs::write(&f, text).unwrap();
            f
        };

        let base_canon = base.canonicalize().unwrap();

        // The folder the other machine recorded exists here too — the shared
        // cloud workspace this feature is for. Import belongs in it.
        let shared = base.join("sessions").join("2026-08-28-2327");
        std::fs::create_dir_all(&shared).unwrap();
        let here = write("here.json", &shared.to_string_lossy());
        assert_eq!(
            import_dir(&env, &here).unwrap(),
            shared.canonicalize().unwrap()
        );

        // It does not exist here (a different machine's layout): fall back to
        // the base folder, never to whatever the app was launched with.
        let gone = write("gone.json", "/nowhere/this/machine/has");
        assert_eq!(import_dir(&env, &gone).unwrap().canonicalize().unwrap(), base_canon);

        // It exists but is OUTSIDE the workspace. A mirror file arrives over a
        // cloud drive, and the folder it names becomes the folder the imported
        // conversation — and the agent that later runs in it — works in. Same
        // rule as every other caller-supplied session directory here.
        let outside = root.join("outside-the-workspace");
        std::fs::create_dir_all(&outside).unwrap();
        let escape = write("escape.json", &outside.to_string_lossy());
        assert_eq!(import_dir(&env, &escape).unwrap().canonicalize().unwrap(), base_canon);

        // A mirror file that is not readable as an export still imports, into
        // the base folder, rather than failing or inheriting a directory.
        let junk = mirror.join("junk.json");
        std::fs::write(&junk, "not json").unwrap();
        assert_eq!(
            import_dir(&env, &junk).unwrap().canonicalize().unwrap(),
            base.canonicalize().unwrap()
        );

        // And the command actually carries it. Asserting `import_dir` alone
        // would still pass with the call site unwired, which is the whole
        // defect: the destination was correct in principle and inherited in
        // practice. Needs the bundled binary only because `runtime_cli` locates
        // it — skip rather than assert nothing when it is absent.
        if sidecar_bin("opencode").is_some() {
            let cmd = import_command(&env, &here).unwrap();
            assert_eq!(cmd.get_current_dir(), Some(shared.canonicalize().unwrap().as_path()));
        }

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn the_cli_reads_the_same_store_as_the_sidecar() {
        // These four are written out by hand here and in `runtime::start`. If
        // they ever disagree, export finds an empty store and exits zero — sync
        // would mirror nothing and report success, the worst way for this to
        // fail. Asserted without the bundled binary on purpose: gating on
        // `runtime_cli` would make this pass vacuously wherever the sidecar has
        // not been fetched, which is most CI jobs.
        let Ok(env) = crate::env::Env::headless(None, None, "test".into()) else {
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
        let env = crate::env::Env::headless(None, None, "test".into());
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
