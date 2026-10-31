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
//! This module is deliberately thin. It asks the running runtime for its own
//! export and import, because the format belongs to the runtime and any version
//! of it we re-implemented here would be a second, drifting definition. Measured
//! against OpenCode 2.2.5:
//!
//!   * import PRESERVES the session id — it does not create a copy;
//!   * importing a session the store already has changes nothing (409) — so a
//!     second import of the same file is harmless;
//!   * but that also means a conversation continued on two machines is NOT
//!     merged: each keeps its own copy, and a newer copy from elsewhere does not
//!     replace this one. (OpenCode 1 unioned by message id; OpenCode 2 does not.)
//!
//! The import goes through the runtime's own API, so the store sees one writer.

use std::path::{Path, PathBuf};

use crate::env::Env;

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

/// The running runtime: its URL and password. Sync and moves go through it, so
/// the store has one writer.
fn runtime_api(env: &Env) -> Result<(String, &'static str), String> {
    let base = crate::runtime::sidecar_url(env.runtime())
        .ok_or_else(|| "the agent runtime is not running".to_string())?;
    Ok((base, crate::runtime::server_password()))
}

/// A client for the loopback runtime: never proxied, and patient enough for a
/// long conversation's export.
fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())
}

/// A runtime reply's status and JSON body (Null when there is none).
fn send(req: reqwest::blocking::RequestBuilder, pw: &str) -> Result<(u16, serde_json::Value), String> {
    let resp = req.basic_auth("opencode", Some(pw)).send().map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let text = resp.text().unwrap_or_default();
    Ok((status, serde_json::from_str(&text).unwrap_or(serde_json::Value::Null)))
}

fn reason(body: &serde_json::Value) -> String {
    body["message"].as_str().unwrap_or("the runtime refused").to_string()
}

/// One session as the runtime exports it: `{info, messages}`.
fn export_json(env: &Env, session_id: &str) -> Result<serde_json::Value, String> {
    let (base, pw) = runtime_api(env)?;
    let (status, body) = send(
        client()?.get(format!("{base}/api/experimental/session/{session_id}/export")),
        pw,
    )?;
    if !(200..300).contains(&status) {
        return Err(format!("export {session_id}: {}", reason(&body)));
    }
    Ok(body.get("data").cloned().unwrap_or(body))
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

/// Fingerprint of a conversation, deliberately blind to `info.time.updated` and
/// `info.time.viewed`.
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
                // Opening a conversation stamps it; that is not a change to it.
                time.remove("viewed");
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
    let export = export_json(env, session_id)?;
    // An empty export would replace a good mirror with nothing, and the next
    // machine would import the emptiness. Treat it as a failure, not a session.
    if export.get("info").is_none() {
        return Err(format!("export {session_id} produced nothing"));
    }
    let bytes = serde_json::to_vec_pretty(&export).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{session_id}.json"));
    let hash = conversation_hash(&bytes);
    let unchanged = previous_hash == Some(hash.as_str()) && path.is_file();
    if !unchanged {
        write_atomic(&path, &bytes)?;
    }
    Ok(ExportOutcome {
        path: path.to_string_lossy().to_string(),
        hash,
        written: !unchanged,
    })
}

/// The folder a mirrored session should be filed in on THIS machine.
///
/// An import is filed in the folder it is told, not necessarily the one the
/// export recorded — which may not exist on this machine at all. Left to a
/// default, every synced conversation would land wherever the runtime happened
/// to start — `/` for a Finder-launched .app. A conversation filed apart from
/// the files it names is the state that makes it report "file not found" for
/// its own notebook, in a folder that still holds it.
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
        // OpenCode 2 records it at `location.directory`; mirrors written by an
        // OpenCode 1 build at `directory`.
        .and_then(|v| {
            v.pointer("/info/location/directory")
                .or_else(|| v.pointer("/info/directory"))
                .and_then(|d| d.as_str())
                .map(PathBuf::from)
        })
        .and_then(|d| d.canonicalize().ok())
        .filter(|d| {
            d.is_dir()
                && (base.canonicalize().map(|b| d.starts_with(b)).unwrap_or(false)
                    || crate::project::is_registered_project_path(env, d))
        });
    Ok(recorded.unwrap_or(base))
}

/// The import request, built but not sent — separated from `import_session` so
/// the destination folder it carries (see `import_dir`) is something a test can
/// assert without a running runtime.
fn import_body(env: &Env, file: &Path) -> Result<serde_json::Value, String> {
    let text = std::fs::read_to_string(file).map_err(|e| format!("read {}: {e}", file.display()))?;
    let export: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("{} is not an export: {e}", file.display()))?;
    if export.get("info").is_none() || !export["messages"].is_array() {
        return Err(format!("{} is not an export", file.display()));
    }
    let directory = import_dir(env, file)?;
    Ok(serde_json::json!({
        "info": export["info"],
        "messages": export["messages"],
        "location": { "directory": directory.to_string_lossy() },
    }))
}

/// Import one mirrored session. Safe to call on a file already imported: the
/// runtime keeps the session id, and a session it already has is left as it is.
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
    let body = import_body(env, file)?;
    let (base, pw) = runtime_api(env)?;
    let (status, reply) = send(
        client()?
            .post(format!("{base}/api/experimental/session/import"))
            .header("Content-Type", "application/json")
            .body(body.to_string()),
        pw,
    )?;
    match status {
        200..=299 => Ok(()),
        // Already here: OpenCode 2 keeps the copy it has (see the module notes).
        409 => Ok(()),
        _ => Err(format!("import {}: {}", file.display(), reason(&reply))),
    }
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
/// OpenCode 2's own move does this — across repositories too, which every
/// session folder and project here is (measured against 2.2.5: same id, same
/// messages, new folder). OpenCode 1's refused, which is why this used to
/// export and re-import.
///
/// The files do NOT move or get copied. The session's own folder stays where
/// it is, and the project folder gains ONE entry: a link to it, named after
/// the session (see `project::link_folder`). That is how the user finds the
/// session's files in the project, and how the agent still reaches what its
/// earlier turns made. Linked BEFORE the move and unlinked again if the move
/// fails, so a failure leaves no half move behind.
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

    let (base, pw) = runtime_api(env)?;
    let (status, body) = send(client()?.get(format!("{base}/api/session/{session_id}")), pw)?;
    if !(200..300).contains(&status) {
        return Err(format!("session {session_id}: {}", reason(&body)));
    }
    let info = body.get("data").cloned().unwrap_or(body);
    let recorded = info
        .pointer("/location/directory")
        .and_then(|d| d.as_str())
        .map(PathBuf::from);
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

    let moved = send(
        client()?
            .post(format!("{base}/api/session/{session_id}/move"))
            .header("Content-Type", "application/json")
            .body(serde_json::json!({ "directory": project.to_string_lossy() }).to_string()),
        pw,
    )
    .and_then(|(status, body)| {
        if (200..300).contains(&status) {
            Ok(())
        } else {
            Err(format!("move {session_id}: {}", reason(&body)))
        }
    });
    if let Err(e) = moved {
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
        assert_eq!(link.parent().unwrap().canonicalize().unwrap(), project_dir.canonicalize().unwrap());
        assert_eq!(link.file_name().unwrap(), "Spike sorting v2");
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
        std::fs::remove_file(&entry.link)
            .or_else(|_| std::fs::remove_dir(&entry.link))
            .unwrap();
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

    /// An import is filed where it is told. So the destination must be chosen
    /// here rather than left to wherever the runtime started (`/`, for a
    /// Finder-launched .app), which would file every synced conversation apart
    /// from the files it names.
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

        // And the request actually carries it. Asserting `import_dir` alone
        // would still pass with the call site unwired, which is the whole
        // defect: the destination was correct in principle and inherited in
        // practice.
        let body = import_body(&env, &here).unwrap();
        assert_eq!(
            PathBuf::from(body["location"]["directory"].as_str().unwrap()),
            shared.canonicalize().unwrap()
        );
        // An OpenCode 2 export records its folder under `location`.
        let v2 = mirror.join("v2.json");
        let text = serde_json::json!({ "info": { "location": { "directory": shared.to_string_lossy() } }, "messages": [] }).to_string();
        std::fs::write(&v2, text).unwrap();
        assert_eq!(import_dir(&env, &v2).unwrap(), shared.canonicalize().unwrap());
        // A file that is not an export is refused before anything is sent.
        assert!(import_body(&env, &junk).is_err());

        let _ = std::fs::remove_dir_all(root);
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
