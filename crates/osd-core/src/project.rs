// Projects: a named workspace folder under `<base>/projects`, marked by
// `<folder>/.openscience/project.json`. The folder IS the workspace — sessions
// group under a project by their `directory`, so no registry or database exists
// to drift out of sync. Legacy root-level projects remain readable in place.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use crate::env::Env;
use crate::runtime::{
    base_workspace_dir, projects_dir, random_hex, PROJECTS_DIR_NAME, SESSIONS_DIR_NAME,
};

#[derive(Serialize, Deserialize, Clone)]
pub struct ProjectMeta {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
    pub version: u32,
    /// For an IMPORTED project: the external repo/folder this project points at.
    /// The project's stub folder under the base dir holds only this metadata; the
    /// user's own repo is never written to. Absent for app-created projects,
    /// whose workspace IS their base-dir folder.
    #[serde(rename = "sourcePath", default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    /// For a COPY-imported project: the folder it was copied from (provenance only).
    /// Unlike `source_path` this does NOT redirect the workspace — the workspace IS
    /// the local copy under the base dir — but it marks the project as imported (the
    /// sidebar badge) and tells delete to remove the whole copy, not just the marker.
    #[serde(rename = "importedFrom", default, skip_serializing_if = "Option::is_none")]
    pub imported_from: Option<String>,
    /// Pinned projects always show in the sidebar (the rest show only the most
    /// recent few). Absent = not pinned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
}

/// What the frontend consumes: the metadata plus the folder it lives in.
#[derive(Serialize)]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
    /// Absolute workspace folder (canonical, matches session `directory`). For a
    /// in-place import this is the external repo; for a copy-import and every
    /// app-created project it is the project's own base-dir folder.
    pub path: String,
    /// True when this project was brought in from elsewhere (a copy-import, or a
    /// in-place import) — drives the sidebar "imported" badge.
    pub imported: bool,
    /// Where an imported project was brought in from (shown as a hint). Absent for
    /// app-created projects.
    #[serde(rename = "importedFrom", skip_serializing_if = "Option::is_none")]
    pub imported_from: Option<String>,
    /// How an imported project is stored. Absent for app-created projects.
    #[serde(rename = "importMode", skip_serializing_if = "Option::is_none")]
    pub import_mode: Option<String>,
    /// Whether this project is pinned to the sidebar.
    pub pinned: bool,
}

fn meta_file(dir: &Path) -> PathBuf {
    dir.join(".openscience").join("project.json")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A corrupt or missing project.json makes the folder a plain workspace again
/// — never an error the UI has to handle.
fn read_meta(dir: &Path) -> Option<ProjectMeta> {
    let text = std::fs::read_to_string(meta_file(dir)).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_meta(dir: &Path, meta: &ProjectMeta) -> Result<(), String> {
    let file = meta_file(dir);
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    std::fs::write(&file, json).map_err(|e| e.to_string())
}

/// Project name → folder name: one path segment, no whitespace (the agent runs
/// unquoted shell commands against workspace paths), no path-unsafe characters.
/// Unicode (e.g. CJK project names) passes through untouched.
fn folder_slug(name: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c if c.is_whitespace() => '-',
            c => c,
        })
        .collect();
    let collapsed = cleaned
        .split('-')
        .filter(|s| !s.is_empty() && !s.chars().all(|c| c == '.'))
        .collect::<Vec<_>>()
        .join("-");
    let trimmed = collapsed.trim_matches('.').to_string();
    if trimmed.is_empty() {
        "project".into()
    } else {
        trimmed
    }
}

fn info_of(meta: ProjectMeta, dir: &Path) -> ProjectInfo {
    // An in-place import's workspace is its external source; a copy-import and
    // every app-created project operate in their own base-dir folder.
    let imported = meta.source_path.is_some() || meta.imported_from.is_some();
    let target = meta
        .source_path
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| dir.to_path_buf());
    let canon = target.canonicalize().unwrap_or(target);
    let import_mode = if meta.source_path.is_some() {
        Some("in-place".into())
    } else if meta.imported_from.is_some() {
        Some("copy".into())
    } else {
        None
    };
    let imported_from = meta.imported_from.or(meta.source_path);
    ProjectInfo {
        id: meta.id,
        name: meta.name,
        description: meta.description,
        created_at: meta.created_at,
        // Native form, never the `\\?\` verbatim path `canonicalize()` returns on
        // Windows: this string is matched against the `directory` OpenCode reports
        // for a session, and the verbatim prefix could never match (#76).
        path: crate::artifact_file::native_path(&canon),
        imported,
        imported_from,
        import_mode,
        pinned: meta.pinned.unwrap_or(false),
    }
}

/// Create the folder + metadata under `base`. Split from the command so the
/// filesystem logic is unit-testable without an AppHandle.
fn create_in(base: &Path, name: &str) -> Result<(PathBuf, ProjectMeta), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("project name is empty".into());
    }
    let slug = folder_slug(name);
    let mut dir = base.join(&slug);
    for n in 2..100 {
        if !dir.exists() {
            break;
        }
        dir = base.join(format!("{slug}-{n}"));
    }
    if dir.exists() {
        return Err(format!("a folder named \"{slug}\" already exists"));
    }
    let meta = ProjectMeta {
        id: random_hex(8),
        name: name.to_string(),
        description: None,
        created_at: now_ms(),
        version: 1,
        source_path: None,
        imported_from: None,
        pinned: None,
    };
    write_meta(&dir, &meta)?;
    Ok((dir, meta))
}

/// Create a project: a fresh folder under `<base>/projects` with project metadata,
/// the agent harness, and an initial git snapshot — the same scaffold a dated
/// session workspace gets. Does NOT switch the active workspace; the frontend
/// decides when to move into it.
pub fn create_project(env: &Env, name: &str) -> Result<ProjectInfo, String> {
    let (dir, meta) = create_in(&projects_dir(env)?, name)?;
    crate::harness::seed_harness(env, &dir);
    crate::git_snapshot::commit_best_effort(&dir, "Initialize project");
    Ok(info_of(meta, &dir))
}

/// Recursively copy `src` into `dst` (created if missing) as a FAITHFUL clone:
/// every file (permission bits preserved by `fs::copy`), the full directory tree,
/// `.git` and its history, and every symlink — nothing is dropped. Importing a
/// project must relocate a *working* copy the sandboxed sidecar can reach, not a
/// curated subset; the user's history and environment are theirs to keep.
///
/// Symlinks are recreated as links (the link itself is copied, its target is NOT
/// followed): an internal relative link keeps working in the copy, copying does
/// not recurse into a link's target so there are no cycles, and we never read
/// through a link into a TCC-protected dir at copy time. A link that pointed
/// *outside* the folder still points outside after the copy — that residual
/// (like any external relative path) is what the AGENTS.md provenance note is for.
fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let ft = entry.file_type()?;
        if ft.is_symlink() {
            symlink_any(&std::fs::read_link(&from)?, &to)?;
        } else if ft.is_dir() {
            copy_tree(&from, &to)?;
            // Mirror the source dir's permissions AFTER populating it: create_dir_all
            // used the default umask, which would silently widen a private 0700 dir to
            // 0755. Set it last so a read-only source dir doesn't block its own copy.
            if let Ok(m) = std::fs::metadata(&from) {
                let _ = std::fs::set_permissions(&to, m.permissions());
            }
        } else if ft.is_file() {
            std::fs::copy(&from, &to)?; // preserves permission bits
        }
        // Non-regular entries (FIFO, socket, device node) are skipped: fs::copy would
        // error on a socket and block forever on a reader-less FIFO, aborting the
        // whole import over one stray entry (e.g. a dev server's leftover .sock).
    }
    Ok(())
}

/// Create a symlink at `link` pointing at `target`, without following it.
#[cfg(unix)]
fn symlink_any(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

/// Windows symlink creation needs privilege and dir/file are distinct calls;
/// best-effort so a repo with links still imports (rare on the macOS-focused
/// path this fixes). A failure leaves the link absent rather than aborting.
#[cfg(windows)]
fn symlink_any(target: &Path, link: &Path) -> std::io::Result<()> {
    // Decide dir-vs-file by resolving a RELATIVE target against the link's own
    // parent, not the process CWD (which would misclassify e.g. `docs -> ..\shared`).
    let probe = if target.is_absolute() {
        target.to_path_buf()
    } else {
        link.parent().unwrap_or_else(|| Path::new(".")).join(target)
    };
    let res = if probe.is_dir() {
        std::os::windows::fs::symlink_dir(target, link)
    } else {
        std::os::windows::fs::symlink_file(target, link)
    };
    let _ = res; // best-effort: a link we couldn't create is left absent
    Ok(())
}

/// `remove_dir_all`, but first restore owner-write on every directory in the tree.
/// A faithful copy can contain read-only (e.g. 0500) directories, and on Unix you
/// cannot unlink entries from a directory without write permission on it — so a
/// plain remove_dir_all would fail with EACCES and orphan the (possibly multi-GB)
/// copy. Used by delete and by import's rollback path.
fn force_remove_dir_all(dir: &Path) -> std::io::Result<()> {
    restore_write_recursive(dir);
    std::fs::remove_dir_all(dir)
}

fn restore_write_recursive(dir: &Path) {
    let Ok(meta) = std::fs::symlink_metadata(dir) else { return };
    if !meta.is_dir() {
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = meta.permissions();
        perms.set_mode(perms.mode() | 0o700); // owner rwx so we can read + unlink
        let _ = std::fs::set_permissions(dir, perms);
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            // Recurse into real subdirs only; never follow a symlink out of the tree.
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                restore_write_recursive(&e.path());
            }
        }
    }
}

/// Import an existing repo/folder as a project.
///
/// `mode = "copy"` makes a faithful managed copy under `projects/`. It is an
/// explicit storage/isolation option; it is not the permission model for macOS.
///
/// `mode = "in-place"` stores only a pointer under `projects/` and works directly
/// on the original folder. It avoids duplication, and the agent edits the original
/// files. Distributed macOS builds sign the app and nested sidecars under one
/// Developer ID so TCC can attribute the folder-picker grant consistently.
pub fn import_project(
    env: &Env,
    path: String,
    mode: Option<String>,
) -> Result<ProjectInfo, String> {
    let base = base_workspace_dir(env)?;
    let project_root = projects_dir(env)?;
    let source = PathBuf::from(path.trim());
    if path.trim().is_empty() || !source.is_dir() {
        return Err("the selected folder does not exist".into());
    }
    // Canonicalize strictly: the overlap guard below compares against a canonical
    // base, so a non-canonical source (from a failed resolve) could slip past both
    // starts_with checks and let copy_tree recurse the base into itself.
    let source = source
        .canonicalize()
        .map_err(|e| format!("could not resolve the selected folder: {e}"))?;
    // Guard: overlap with the base dir is never a plain import. A folder INSIDE
    // the workspace is adopted (below); a folder CONTAINING it would copy the
    // workspace into itself and recurse, so it is refused outright.
    if let Ok(base_canon) = base.canonicalize() {
        if base_canon.starts_with(&source) && source != base_canon {
            return Err("cannot import a folder that contains the app's workspace".into());
        }
        // A folder INSIDE the workspace is adopted, not copied or pointed at.
        // Removing a project deletes only its `project.json` and keeps every
        // file, so a removed project leaves exactly this: a real workspace with
        // no metadata. Refusing it (as this used to) stranded the folder — "New
        // project" makes a DIFFERENT folder, so there was no way back in.
        if source.starts_with(&base_canon) {
            return adopt_in_base(&base_canon, &source);
        }
    }
    let name = source
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "imported".into());
    match mode.as_deref().unwrap_or("in-place") {
        "copy" => {
            // Reserve the folder, then populate it. ANY failure after the folder
            // exists rolls it back, so a broken import never strands a partial
            // (possibly multi-GB) tree or half-written project.
            let (dir, meta) = create_in(&project_root, &name)?;
            match populate_import(&source, &dir, meta) {
                Ok(info) => Ok(info),
                Err(e) => {
                    let _ = force_remove_dir_all(&dir);
                    Err(e)
                }
            }
        }
        "in-place" => {
            // Only this lightweight stub is app-owned. The workspace path
            // resolves to `source`, so subsequent agent operations happen there.
            let (dir, mut meta) = create_in(&project_root, &name)?;
            meta.source_path = Some(source.to_string_lossy().to_string());
            if let Err(e) = write_meta(&dir, &meta) {
                let _ = force_remove_dir_all(&dir);
                return Err(e);
            }
            // A user repo snapshots to the app's shadow ref; a plain folder is
            // marked so the app never silently turns it into a git repository.
            crate::git_snapshot::mark_imported(&source);
            Ok(info_of(meta, &dir))
        }
        _ => Err("invalid import mode; expected \"copy\" or \"in-place\"".into()),
    }
}

/// Fill a reserved project folder `dir` with a faithful copy of `source` and make
/// it an app-managed project. Split out so `import_project` can roll `dir` back on
/// any error here.
fn populate_import(
    source: &Path,
    dir: &Path,
    mut meta: ProjectMeta,
) -> Result<ProjectInfo, String> {
    copy_tree(source, dir).map_err(|e| format!("could not copy the folder: {e}"))?;
    // The source may have carried its own `.openscience/` (if it was ever app-
    // managed): drop it wholesale so a stale identity, a foreign project.json, or a
    // legacy `.no-snapshots` opt-out — which would silently disable versioning for
    // the fresh copy — cannot leak in. write_meta then re-creates ours.
    let _ = force_remove_dir_all(&dir.join(".openscience"));
    meta.imported_from = Some(source.to_string_lossy().to_string());
    write_meta(dir, &meta)?;
    // An imported project is the user's EXISTING work, so — unlike "New project",
    // which scaffolds an empty folder — the app never seeds its harness into it
    // (no KNOWLEDGE.md/notes/README injected) and never rewrites its files. The full
    // provenance/caveats go to an app-owned `.openscience/IMPORTED_FROM.md`; AGENTS.md
    // (the file agents read) gets just ONE marked pointer line — appended only if not
    // already present — so an agent that hits a reference to a path OUTSIDE the copy
    // can trace it back to the source instead of failing on "not found". An existing
    // AGENTS.md is otherwise left exactly as written; the user's ORIGINAL folder is
    // untouched. For a copied git repo that one line shows as a working-tree change
    // (accepted: the recovery hint beats a pristine `git status` on a copy), while
    // `mark_imported` keeps `.openscience/` out of git and snapshots go to the
    // dedicated per-branch ref, never the user's branch.
    record_import_provenance(dir, source);
    if dir.join(".git").exists() {
        crate::git_snapshot::mark_imported(dir);
    }
    crate::git_snapshot::commit_best_effort(dir, "Import project");
    Ok(info_of(meta, dir))
}

/// Marks the single provenance line the app appends to a copy's AGENTS.md, so the
/// append can be made idempotent (never duplicated on a re-run).
const IMPORT_PROVENANCE_MARKER: &str = "<!-- open-science-desktop:imported -->";

/// Record where the copy came from. The FULL details (source path, external-ref and
/// stale-environment caveats) go to an app-owned `.openscience/IMPORTED_FROM.md`, so
/// they never bloat the user's own file. AGENTS.md — the file agents actually read —
/// gets just ONE clearly-marked line pointing at that detail file, so an agent that
/// hits a reference to a path outside the copy can follow it back to the source. The
/// line is appended only if the marker isn't already present (idempotent), and an
/// existing AGENTS.md is otherwise left exactly as written. Best-effort throughout;
/// the user's ORIGINAL folder is never touched — only the copy.
fn record_import_provenance(dir: &Path, source: &Path) {
    use std::io::Write;
    // 1) Full details in the app-owned file (overwritten fresh each import).
    let detail = format!(
        "# Import provenance\n\n\
         This project was imported by copying the folder below into the app workspace:\n\n\
             {}\n\n\
         The original folder is unchanged. Two things to know when working here:\n\n\
         - **External references.** If any code or config references paths *outside* this \
         folder (relative paths like `../data`, absolute paths, or symlinks that pointed \
         elsewhere), the originals live under the source location above — they were not \
         copied in, and this sandbox cannot read the user's `~/Documents`/`~/Desktop` \
         directly.\n\
         - **Copied environments.** Virtual environments and dependency dirs (`.venv`, \
         `node_modules`, tool caches) were copied verbatim and may contain absolute paths \
         baked in at the original location (venv script shebangs, `activate`, editable \
         installs). If an interpreter, CLI tool, or import fails, recreate the environment \
         from the lockfiles that were copied in (`uv venv` / `uv sync`, `npm ci`, etc.) \
         rather than trusting the copied one.\n",
        source.display()
    );
    let detail_path = dir.join(".openscience").join("IMPORTED_FROM.md");
    if let Some(parent) = detail_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&detail_path, detail);

    // 2) One concise, idempotent pointer line in AGENTS.md (where agents look).
    let agents = dir.join("AGENTS.md");
    if std::fs::read_to_string(&agents).unwrap_or_default().contains(IMPORT_PROVENANCE_MARKER) {
        return; // already recorded — never append twice
    }
    let line = format!(
        "\n{IMPORT_PROVENANCE_MARKER}\n> Imported into this workspace by copying from \
         `{}` — see `.openscience/IMPORTED_FROM.md` for the original location and caveats.\n",
        source.display()
    );
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&agents) {
        let _ = f.write_all(line.as_bytes());
    }
}

/// Register a folder that already lives inside the app's workspace as a
/// project, in place. Used when the user picks such a folder in the importer —
/// the honest reading of that gesture is "make this a project", and for a
/// previously-removed project it is the only way back.
///
/// Idempotent: a folder that still carries metadata is already listed, so its
/// existing entry is returned untouched rather than being re-created with a new id.
fn adopt_in_base(base: &Path, source: &Path) -> Result<ProjectInfo, String> {
    // The containers are not workspaces; adopting one would swallow every
    // project or session inside it.
    if source == base
        || source == base.join(PROJECTS_DIR_NAME)
        || source == base.join(SESSIONS_DIR_NAME)
    {
        return Err("this folder holds your projects; pick one of the folders inside it".into());
    }
    if let Some(meta) = read_meta(source) {
        return Ok(info_of(meta, source));
    }
    let name = source
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "project".into());
    // No `source_path` / `imported_from`: the folder IS the workspace, exactly
    // like a project the app created itself. That also keeps Remove
    // non-destructive for it — it drops the marker and leaves the files.
    let meta = ProjectMeta {
        id: random_hex(8),
        name,
        description: None,
        created_at: now_ms(),
        version: 1,
        source_path: None,
        imported_from: None,
        pinned: None,
    };
    write_meta(source, &meta)?;
    Ok(info_of(meta, source))
}

/// New projects live under `<base>/projects`. Root-level project folders from
/// older versions remain readable without being moved, so their stored absolute
/// session paths stay valid.
fn project_parent_dirs(base: &Path) -> [PathBuf; 2] {
    [base.join(PROJECTS_DIR_NAME), base.to_path_buf()]
}

fn project_dirs(base: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for parent in project_parent_dirs(base) {
        if let Ok(entries) = std::fs::read_dir(parent) {
            for entry in entries.flatten() {
                let dir = entry.path();
                if dir.is_dir() && read_meta(&dir).is_some() {
                    dirs.push(dir);
                }
            }
        }
    }
    dirs
}

pub fn project_workspace_dirs(base: &Path) -> Vec<PathBuf> {
    project_dirs(base)
        .into_iter()
        .filter_map(|dir| {
            let meta = read_meta(&dir)?;
            let target = meta.source_path.map(PathBuf::from).unwrap_or(dir);
            Some(target.canonicalize().unwrap_or(target))
        })
        .collect()
}

/// Every structured or legacy project, sorted by name for a stable sidebar.
pub fn list_projects(env: &Env) -> Result<Vec<ProjectInfo>, String> {
    let base = base_workspace_dir(env)?;
    let mut out: Vec<ProjectInfo> = Vec::new();
    for dir in project_dirs(&base) {
        if let Some(meta) = read_meta(&dir) {
            // An in-place project's external source may have been moved or
            // deleted. Drop the dead entry instead of listing an unusable item.
            if let Some(src) = meta.source_path.as_ref() {
                if !Path::new(src).is_dir() {
                    continue;
                }
            }
            out.push(info_of(meta, &dir));
        }
    }
    out.sort_by_key(|p| p.name.to_lowercase());
    Ok(out)
}

/// The base-dir folder holding the metadata for project `id` (its stub, for an
/// imported project — NOT the external source, which never carries a project.json).
fn project_dir_by_id(base: &Path, id: &str) -> Option<PathBuf> {
    project_dirs(base).into_iter().find_map(|dir| {
        match read_meta(&dir) {
            Some(meta) if meta.id == id => Some(dir),
            _ => None,
        }
    })
}

/// Gateway file access normally stays under the base directory. An explicitly
/// registered in-place project is the one safe exception: accept its exact
/// canonical workspace root, never an arbitrary external path.
pub fn is_registered_project_path(env: &Env, path: &Path) -> bool {
    let Ok(base) = base_workspace_dir(env) else {
        return false;
    };
    project_dirs(&base).into_iter().any(|dir| {
        let Some(meta) = read_meta(&dir) else {
            return false;
        };
        let target = meta.source_path.map(PathBuf::from).unwrap_or(dir);
        target.canonicalize().map(|p| p == path).unwrap_or(false)
    })
}

/// Rename the project's display name only — keyed by project id, since an
/// imported project's metadata lives in its base-dir stub, not at its (external)
/// workspace path. The folder never moves, so session `directory` grouping stays
/// intact.
pub fn rename_project(env: &Env, id: &str, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("project name is empty".into());
    }
    let base = base_workspace_dir(env)?;
    let dir = project_dir_by_id(&base, id).ok_or("project not found")?;
    let mut meta = read_meta(&dir).ok_or("not a project folder")?;
    meta.name = name.to_string();
    write_meta(&dir, &meta)
}

fn set_pinned_in(base: &Path, id: &str, pinned: bool) -> Result<(), String> {
    let dir = project_dir_by_id(base, id).ok_or("project not found")?;
    let mut meta = read_meta(&dir).ok_or("not a project folder")?;
    meta.pinned = if pinned { Some(true) } else { None };
    write_meta(&dir, &meta)
}

/// Pin/unpin a project (pinned projects always show in the sidebar).
pub fn set_project_pinned(env: &Env, id: &str, pinned: bool) -> Result<(), String> {
    set_pinned_in(&base_workspace_dir(env)?, id, pinned)
}

/// Remove a project from the app's index.
/// - Imported project (copy-import or in-place stub): the base-dir folder is
///   app-owned — a full copy for a copy-import, a bare stub for an in-place
///   import — so remove it entirely. The user's ORIGINAL source folder is never
///   touched (a copy-import left it untouched at import time; a legacy stub only
///   ever pointed at it).
/// - App-created project: the folder holds workspace files the user made here →
///   remove only the `.openscience/project.json` marker, demoting it to a plain
///   folder. Nothing else on disk is deleted.
fn delete_in(base: &Path, id: &str) -> Result<(), String> {
    let dir = project_dir_by_id(base, id).ok_or("project not found")?;
    let meta = read_meta(&dir).ok_or("not a project folder")?;
    // Guard: only ever touch paths under the app's base dir.
    let base_canon = base.canonicalize().unwrap_or_else(|_| base.to_path_buf());
    if dir.canonicalize().map(|d| !d.starts_with(&base_canon)).unwrap_or(true) {
        return Err("refusing to delete a project outside the base dir".into());
    }
    if meta.source_path.is_some() || meta.imported_from.is_some() {
        force_remove_dir_all(&dir).map_err(|e| e.to_string())
    } else {
        let marker = meta_file(&dir);
        if marker.exists() {
            std::fs::remove_file(&marker).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

pub fn delete_project(env: &Env, id: &str) -> Result<(), String> {
    delete_in(&base_workspace_dir(env)?, id)
}

/// The folder a project id names: an app-created project's own folder, or an
/// imported project's external source. The frontend passes only the id, never a
/// raw path, so "open this project's folder" can never become an
/// arbitrary-path open.
pub fn project_folder(env: &Env, id: &str) -> Result<PathBuf, String> {
    let base = base_workspace_dir(env)?;
    let dir = project_dir_by_id(&base, id).ok_or("project not found")?;
    let meta = read_meta(&dir).ok_or("not a project folder")?;
    Ok(meta.source_path.map(PathBuf::from).unwrap_or(dir))
}

#[cfg(test)]
mod tests {
    use super::{create_in, folder_slug, info_of, read_meta};
    use std::fs;

    // Sessions group under a project by comparing the project's reported path
    // with the session's directory, and a session's directory is the workspace
    // the app switched to. So the whole feature rests on one invariant: for the
    // same folder, `list_projects` and a workspace switch must produce the SAME
    // string. #69 reported sessions never grouping — this pins the invariant
    // down (both sides canonicalize, so it holds on every platform) and fails
    // loudly if either side's normalization ever drifts apart.
    #[test]
    fn a_projects_reported_path_is_what_a_workspace_switch_resolves() {
        let base = std::env::temp_dir().join(format!("os-project-invariant-{}", super::random_hex(8)));
        fs::create_dir_all(base.join("projects")).unwrap();
        // A CJK name, as in the report: the slug keeps it verbatim.
        let (dir, meta) = create_in(&base.join("projects"), "毕设").unwrap();
        assert_eq!(dir, base.join("projects").join("毕设"));

        // What list_projects hands the sidebar.
        let reported = info_of(meta, &dir).path;
        // What set_workspace persists, and workspace_dir reads back, for the
        // folder the sidebar's "+" hands it (`startDraftInWorkspace(p.path)`) —
        // it canonicalizes, and the layout call returns the dir unchanged.
        // Both sides are normalized to the native form (`native_path` strips
        // the `\\?\` verbatim prefix on Windows), the same string OpenCode
        // reports as a session's directory.
        let switched = super::super::artifact_file::native_path(&dir.canonicalize().unwrap());

        assert_eq!(reported, switched, "a session started in a project must map back to it");

        let _ = fs::remove_dir_all(&base);
    }

    mod adopting_a_folder_already_in_the_workspace {
        use super::super::{adopt_in_base, delete_in, project_dirs, read_meta, PROJECTS_DIR_NAME};
        use std::fs;

        /// A scratch base dir with the app's layout.
        fn base() -> std::path::PathBuf {
            let dir = std::env::temp_dir().join(format!("ai4s-adopt-{}", super::super::random_hex(8)));
            fs::create_dir_all(dir.join(PROJECTS_DIR_NAME)).unwrap();
            fs::create_dir_all(dir.join("sessions")).unwrap();
            dir
        }

        #[test]
        fn a_removed_project_can_be_added_back() {
            // The exact reported state: Remove deletes only project.json and
            // keeps every file, so the folder vanishes from the list with no way
            // back — import refused it and "New project" makes a DIFFERENT folder.
            let base = base();
            let (dir, meta) = super::super::create_in(&base, "仙侠克苏鲁").unwrap();
            fs::write(dir.join("notes.md"), "work").unwrap();
            delete_in(&base, &meta.id).unwrap();
            assert!(read_meta(&dir).is_none(), "Remove drops the marker");
            assert!(dir.join("notes.md").exists(), "…but keeps the files");
            assert!(project_dirs(&base).is_empty(), "so it is no longer listed");

            let info = adopt_in_base(&base, &dir).unwrap();

            assert_eq!(info.name, "仙侠克苏鲁");
            assert_eq!(project_dirs(&base).len(), 1, "back in the list");
            assert!(dir.join("notes.md").exists(), "files untouched");
            // Adopted in place: the folder IS the workspace, not a pointer.
            assert_eq!(read_meta(&dir).unwrap().source_path, None);
            assert!(!info.imported, "not an import — it was always ours");
        }

        #[test]
        fn adopting_twice_keeps_the_same_project() {
            let base = base();
            let dir = base.join("已有的项目");
            fs::create_dir_all(&dir).unwrap();

            let first = adopt_in_base(&base, &dir).unwrap();
            let second = adopt_in_base(&base, &dir).unwrap();

            assert_eq!(first.id, second.id, "no duplicate entry, no new id");
            assert_eq!(project_dirs(&base).len(), 1);
        }

        #[test]
        fn the_containers_themselves_are_never_adopted() {
            // Adopting one of these would swallow every project or session in it.
            let base = base();
            for candidate in [base.clone(), base.join(PROJECTS_DIR_NAME), base.join("sessions")] {
                assert!(adopt_in_base(&base, &candidate).is_err(), "{candidate:?}");
            }
            assert!(project_dirs(&base).is_empty());
        }

        #[test]
        fn a_folder_under_projects_is_adopted_too() {
            let base = base();
            let dir = base.join(PROJECTS_DIR_NAME).join("orphan");
            fs::create_dir_all(&dir).unwrap();

            let info = adopt_in_base(&base, &dir).unwrap();

            assert_eq!(info.name, "orphan");
            assert_eq!(project_dirs(&base).len(), 1);
        }
    }

    #[test]
    fn slug_is_one_safe_path_segment() {
        assert_eq!(folder_slug("BCI Trends 2026"), "BCI-Trends-2026");
        assert_eq!(folder_slug("  a/b\\c:d  "), "a-b-c-d");
        assert_eq!(folder_slug("脑机接口趋势"), "脑机接口趋势");
        assert_eq!(folder_slug("..."), "project");
        assert_eq!(folder_slug(""), "project");
        assert_eq!(folder_slug("../etc"), "etc"); // no traversal segments survive
    }

    #[test]
    fn create_writes_meta_and_dedupes_folder_names() {
        let base = std::env::temp_dir().join(format!("os-project-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();

        let (dir1, meta1) = create_in(&base, "My Study").unwrap();
        assert_eq!(dir1, base.join("My-Study"));
        assert_eq!(meta1.name, "My Study");
        let read = read_meta(&dir1).unwrap();
        assert_eq!(read.id, meta1.id);
        assert_eq!(read.version, 1);

        // Same name again → a distinct folder, its own identity.
        let (dir2, meta2) = create_in(&base, "My Study").unwrap();
        assert_eq!(dir2, base.join("My-Study-2"));
        assert_ne!(meta2.id, meta1.id);

        assert!(create_in(&base, "   ").is_err());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn imported_project_points_at_its_external_source_without_writing_into_it() {
        use super::{info_of, write_meta};
        let base = std::env::temp_dir().join(format!("os-project-import-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        // An external repo/folder the user brings in (canonicalizable on disk).
        let ext = base.join("external-repo");
        fs::create_dir_all(&ext).unwrap();

        // A stub under base holds only the pointer metadata.
        let (stub, mut meta) = create_in(&base, "external-repo").unwrap();
        meta.source_path = Some(ext.to_string_lossy().to_string());
        write_meta(&stub, &meta).unwrap();

        // The pointer round-trips from disk…
        let reloaded = read_meta(&stub).unwrap();
        assert_eq!(reloaded.source_path.as_deref(), Some(ext.to_string_lossy().as_ref()));

        // …and info_of resolves the workspace to the EXTERNAL source, flagged imported.
        let info = info_of(reloaded, &stub);
        assert!(info.imported);
        assert_eq!(info.import_mode.as_deref(), Some("in-place"));
        // The reported path is the native form (no `\\?\` prefix on Windows),
        // like every path the app hands to OpenCode — see native_path (#76).
        assert_eq!(info.path, super::super::artifact_file::native_path(&ext.canonicalize().unwrap()));

        // Nothing was written into the user's repo (metadata lives in the stub).
        assert!(!ext.join(".openscience").join("project.json").exists());

        // An app-created project (no source) is not imported and lives in its folder.
        let (own, own_meta) = create_in(&base, "My Study").unwrap();
        let own_info = info_of(read_meta(&own).unwrap(), &own);
        assert!(!own_info.imported);
        assert_eq!(own_info.import_mode, None);
        assert_eq!(own_info.path, super::super::artifact_file::native_path(&own.canonicalize().unwrap()));
        let _ = own_meta;

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn rename_resolves_the_stub_by_id_even_for_an_import() {
        use super::{project_dir_by_id, write_meta};
        let base = std::env::temp_dir().join(format!("os-project-rename-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let ext = base.join("my-repo-src");
        fs::create_dir_all(&ext).unwrap();

        // An imported project: stub under base, pointer to the external source.
        let (stub, mut meta) = create_in(&base, "my-repo").unwrap();
        meta.source_path = Some(ext.to_string_lossy().to_string());
        write_meta(&stub, &meta).unwrap();

        // Resolved by id → the STUB (where meta lives), never the external source.
        assert_eq!(project_dir_by_id(&base, &meta.id).as_deref(), Some(stub.as_path()));
        assert!(project_dir_by_id(&base, "nope").is_none());

        // Renaming rewrites the stub's meta; the user's repo is never written to.
        let mut m = read_meta(&stub).unwrap();
        m.name = "Renamed".into();
        write_meta(&stub, &m).unwrap();
        assert_eq!(read_meta(&stub).unwrap().name, "Renamed");
        assert!(!ext.join(".openscience").join("project.json").exists());

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn project_lookup_reads_structured_and_legacy_locations() {
        use super::project_dir_by_id;
        let base =
            std::env::temp_dir().join(format!("os-project-layout-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("projects")).unwrap();

        let (structured, structured_meta) =
            create_in(&base.join("projects"), "Structured").unwrap();
        let (legacy, legacy_meta) = create_in(&base, "Legacy").unwrap();

        assert_eq!(
            project_dir_by_id(&base, &structured_meta.id).as_deref(),
            Some(structured.as_path())
        );
        assert_eq!(
            project_dir_by_id(&base, &legacy_meta.id).as_deref(),
            Some(legacy.as_path())
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn delete_removes_the_index_but_keeps_files() {
        use super::{delete_in, set_pinned_in, write_meta};
        let base = std::env::temp_dir().join(format!("os-project-del-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();

        // App-created project with real workspace files.
        let (own, own_meta) = create_in(&base, "My Study").unwrap();
        fs::write(own.join("train.py"), "print(1)\n").unwrap();
        // Deleting removes only the project marker; the folder + files remain.
        delete_in(&base, &own_meta.id).unwrap();
        assert!(read_meta(&own).is_none()); // no longer a project
        assert!(own.join("train.py").exists()); // user's files untouched
        assert!(own.is_dir());

        // Imported project: stub under base points at an external repo.
        let ext = base.join("ext-repo");
        fs::create_dir_all(&ext).unwrap();
        fs::write(ext.join("keep.txt"), "user data\n").unwrap();
        let (stub, mut meta) = create_in(&base, "ext-repo-proj").unwrap();
        meta.source_path = Some(ext.to_string_lossy().to_string());
        write_meta(&stub, &meta).unwrap();
        // Pin then delete: the stub is removed; the external repo is untouched.
        set_pinned_in(&base, &meta.id, true).unwrap();
        assert!(read_meta(&stub).unwrap().pinned.unwrap_or(false));
        delete_in(&base, &meta.id).unwrap();
        assert!(!stub.exists()); // stub index gone
        assert!(ext.join("keep.txt").exists()); // external repo untouched

        // Copy-imported project (imported_from set): the base-dir folder is an
        // app-owned copy → delete removes the whole tree, not just the marker, so
        // multi-GB imports don't orphan on disk.
        let (copy, mut cmeta) = create_in(&base, "copied-proj").unwrap();
        fs::write(copy.join("big.bin"), "lots of data\n").unwrap();
        // A read-only (0500) subdir, as a faithful copy can contain, must NOT block
        // deletion (plain remove_dir_all would EACCES and orphan the copy).
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::create_dir_all(copy.join("ro")).unwrap();
            fs::write(copy.join("ro").join("f"), "x").unwrap();
            fs::set_permissions(copy.join("ro"), fs::Permissions::from_mode(0o500)).unwrap();
        }
        cmeta.imported_from = Some("/somewhere/original".into());
        write_meta(&copy, &cmeta).unwrap();
        delete_in(&base, &cmeta.id).unwrap();
        assert!(!copy.exists()); // the entire copy is removed, read-only dir and all

        // Deleting an unknown id errors, not panics.
        assert!(delete_in(&base, "nope").is_err());

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn import_faithfully_copies_files_git_history_and_symlinks() {
        use super::copy_tree;
        let base = std::env::temp_dir().join(format!("os-project-copy-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let src = base.join("src-repo");
        fs::create_dir_all(src.join("data")).unwrap();
        fs::create_dir_all(src.join(".git")).unwrap();
        fs::write(src.join("train.py"), "print(1)\n").unwrap();
        fs::write(src.join("data").join("x.csv"), "a,b\n1,2\n").unwrap();
        fs::write(src.join(".git").join("config"), "[core]\n").unwrap();
        // An INTERNAL relative symlink — must be preserved as a link so it keeps
        // resolving inside the copy.
        #[cfg(unix)]
        std::os::unix::fs::symlink("data/x.csv", src.join("latest.csv")).unwrap();
        // A private 0700 dir — its restricted permissions must survive the copy.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::create_dir_all(src.join("private")).unwrap();
            fs::write(src.join("private").join("k"), "secret\n").unwrap();
            fs::set_permissions(src.join("private"), fs::Permissions::from_mode(0o700)).unwrap();
        }
        // A unix socket (non-regular file) — must be skipped, not abort the copy.
        #[cfg(unix)]
        let _sock = std::os::unix::net::UnixListener::bind(src.join("dev.sock")).unwrap();

        let dst = base.join("dst");
        copy_tree(&src, &dst).unwrap();

        // Files and nested dirs come across…
        assert_eq!(fs::read_to_string(dst.join("train.py")).unwrap(), "print(1)\n");
        assert!(dst.join("data").join("x.csv").is_file());
        // …and so does the full git history — nothing is dropped.
        assert_eq!(fs::read_to_string(dst.join(".git").join("config")).unwrap(), "[core]\n");
        // The symlink is recreated as a link (not followed/expanded).
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let meta = fs::symlink_metadata(dst.join("latest.csv")).unwrap();
            assert!(meta.file_type().is_symlink());
            assert_eq!(fs::read_link(dst.join("latest.csv")).unwrap(), std::path::Path::new("data/x.csv"));
            // Private dir keeps 0700 (not widened to 0755 by the default umask).
            let mode = fs::metadata(dst.join("private")).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700);
            assert!(dst.join("private").join("k").is_file());
            // The socket was skipped, and its presence did not abort the copy.
            assert!(!dst.join("dev.sock").exists());
        }

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn provenance_preserves_agents_md_and_is_idempotent() {
        use super::{record_import_provenance, IMPORT_PROVENANCE_MARKER};
        let base = std::env::temp_dir().join(format!("os-project-prov-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let dir = base.join("copy");
        fs::create_dir_all(&dir).unwrap();
        // The imported project brought its OWN AGENTS.md.
        fs::write(dir.join("AGENTS.md"), "# My rules\nBe careful.\n").unwrap();
        let source = std::path::Path::new("/Users/x/Documents/proj");

        record_import_provenance(&dir, source);

        let agents = fs::read_to_string(dir.join("AGENTS.md")).unwrap();
        // The user's own content is preserved, and only ONE marked pointer line added.
        assert!(agents.starts_with("# My rules\nBe careful.\n"));
        assert!(agents.contains(".openscience/IMPORTED_FROM.md"));
        assert_eq!(agents.matches(IMPORT_PROVENANCE_MARKER).count(), 1);
        // Full details live in the app-owned file, with the source path.
        let detail = fs::read_to_string(dir.join(".openscience").join("IMPORTED_FROM.md")).unwrap();
        assert!(detail.contains("/Users/x/Documents/proj"));

        // Re-running must NOT append a second time.
        record_import_provenance(&dir, source);
        let agents2 = fs::read_to_string(dir.join("AGENTS.md")).unwrap();
        assert_eq!(agents2.matches(IMPORT_PROVENANCE_MARKER).count(), 1);

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn corrupt_meta_reads_as_no_project() {
        let base = std::env::temp_dir().join(format!("os-project-bad-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let dir = base.join("broken");
        fs::create_dir_all(dir.join(".openscience")).unwrap();
        fs::write(dir.join(".openscience").join("project.json"), "{not json").unwrap();
        assert!(read_meta(&dir).is_none());
        let _ = fs::remove_dir_all(&base);
    }
}
