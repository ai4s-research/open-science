// Read/open files the agent produced in the workspace, for artifact previews.
// Strictly sandboxed to the workspace root: a path that escapes it is rejected.
use std::path::{Component, Path, PathBuf};
use crate::env::Env;

use crate::runtime::workspace_dir;

/// Largest file we inline into a preview. Beyond this the UI shows a "too large"
/// note (with an open-externally affordance) rather than loading it — a huge
/// file must never lock the app. Large scientific files are meant to be
/// introspected via the large-file probe, not loaded whole.
const PREVIEW_CAP_BYTES: u64 = 25 * 1024 * 1024;

pub fn exceeds_preview_cap(size: u64) -> bool {
    size > PREVIEW_CAP_BYTES
}

#[derive(serde::Serialize)]
pub struct ArtifactFile {
    path: String,
    mime: String,
    encoding: &'static str, // "utf8" | "base64"
    data: String,
    size: u64,
}

pub fn mime_for(ext: &str) -> (&'static str, bool) {
    // (mime, is_text)
    match ext.to_ascii_lowercase().as_str() {
        "pdf" => ("application/pdf", false),
        "png" => ("image/png", false),
        "jpg" | "jpeg" => ("image/jpeg", false),
        "gif" => ("image/gif", false),
        "webp" => ("image/webp", false),
        "ico" => ("image/x-icon", false),
        "woff" => ("font/woff", false),
        "woff2" => ("font/woff2", false),
        "html" | "htm" => ("text/html", true),
        "svg" => ("image/svg+xml", true),
        "csv" => ("text/csv", true),
        "tsv" => ("text/tab-separated-values", true),
        "md" => ("text/markdown", true),
        "tex" => ("text/x-tex", true),
        "json" => ("application/json", true),
        "ipynb" => ("application/x-ipynb+json", true),
        "yaml" | "yml" => ("text/yaml", true),
        // A served HTML preview loads its own stylesheets and scripts, and the
        // preview server sends `nosniff`: under it the webview refuses a
        // stylesheet that is not text/css and a script that is not a JavaScript
        // type, so the page renders bare (unstyled, no interactivity).
        "css" => ("text/css", true),
        "js" | "mjs" => ("text/javascript", true),
        "ts" | "sh" | "toml" | "log" => ("text/plain", true),
        "py" => ("text/x-python", true),
        "r" => ("text/x-r", true),
        // Molecular structure formats — all plain text, rendered in 3D by the
        // molecule viewer (3Dmol.js) which needs the raw utf8, not base64.
        "mol" | "sdf" => ("chemical/x-mdl-molfile", true),
        "mol2" => ("chemical/x-mol2", true),
        "smi" | "smiles" => ("chemical/x-daylight-smiles", true),
        "cif" | "mcif" | "mmcif" => ("chemical/x-cif", true),
        "pdb" => ("chemical/x-pdb", true),
        "pqr" => ("chemical/x-pqr", true),
        "xyz" => ("chemical/x-xyz", true),
        "cube" => ("chemical/x-cube", true),
        // Genome annotation tracks — plain text, rendered by the native track viewer.
        "bed" | "bedgraph" | "bdg" | "gff" | "gff3" | "gtf" | "vcf" => ("text/plain", true),
        // 3D mesh / CAD — read as bytes (base64) so the three.js loaders get an
        // ArrayBuffer; ASCII STL/OBJ/PLY and JSON glTF all decode fine from it.
        "stl" => ("model/stl", false),
        "obj" => ("model/obj", false),
        "ply" => ("model/ply", false),
        "gltf" => ("model/gltf+json", false),
        "glb" => ("model/gltf-binary", false),
        // FITS astronomy files — binary (base64) so the native viewer gets an
        // ArrayBuffer to parse (header cards + big-endian image/spectrum data).
        "fits" | "fit" | "fts" => ("application/fits", false),
        // Qualitative-coding traceback — JSON text, rendered by the native viewer.
        "qcode" => ("application/json", true),
        // Climate-anomaly grid — CSV/text, rendered by the native map viewer.
        "anom" => ("text/csv", true),
        // Binary phase diagram — JSON text, rendered by the native viewer.
        "phase" => ("application/json", true),
        "txt" => ("text/plain", true),
        "docx" => ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", false),
        "xlsx" => ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", false),
        "pptx" => ("application/vnd.openxmlformats-officedocument.presentationml.presentation", false),
        // Video — served over the local file server (with Range support) and
        // played inline by the webview's native <video> element.
        "mp4" | "m4v" => ("video/mp4", false),
        "webm" => ("video/webm", false),
        "mov" => ("video/quicktime", false),
        "ogv" => ("video/ogg", false),
        _ => ("application/octet-stream", false),
    }
}

/// Resolve `rel` under `root`, rejecting any path that escapes it. Under the
/// root-less "disk" scope (an empty `root`) `rel` is a full path, taken as is.
pub fn resolve_under(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if root.as_os_str().is_empty() {
        let full = Path::new(rel);
        if !full.is_absolute() {
            return Err("a disk path must be absolute".into());
        }
        return full.canonicalize().map_err(|_| "file not found".to_string());
    }
    let root = root
        .canonicalize()
        .map_err(|e| format!("root unavailable: {e}"))?;
    let joined = root.join(Path::new(rel));
    let full = joined
        .canonicalize()
        .map_err(|_| "file not found".to_string())?;
    if !full.starts_with(&root) {
        return Err("path escapes the workspace".into());
    }
    Ok(full)
}

/// The folder tree a file command operates in: the ACTIVE session workspace
/// (default), the base folder every session workspace is created under, or —
/// on the desktop only — the user's home folder or the whole disk, for a path
/// the user clicked in a conversation or a terminal. "disk" has no root folder
/// (Windows has one per drive): it is the empty path, and its paths are full
/// paths (`/tmp/a.png`, `D:/data/a.png`; see `scope_path`). Pages declare their
/// scope explicitly — no fallback guessing between them, so an identical
/// relative path can never resolve ambiguously. The gateway refuses "home" and
/// "disk" (see `fs_base`): a web client must never reach beyond the workspaces.
pub fn scope_root(env: &Env, root: Option<&str>) -> Result<PathBuf, String> {
    match root.unwrap_or("workspace") {
        "workspace" => workspace_dir(env),
        "base" => crate::runtime::base_workspace_dir(env),
        "home" => crate::env::home(),
        "disk" => Ok(PathBuf::new()),
        other => Err(format!("unknown root scope: {other}")),
    }
}

/// `full` (canonical) as a path of the scope rooted at `root` (canonical):
/// relative to it with `/` separators, or — under the root-less "disk" scope —
/// the full path itself with `/` separators. None when it is outside the root.
pub fn scope_path(root: &Path, full: &Path) -> Option<String> {
    if root.as_os_str().is_empty() {
        return Some(native_path(full).replace(std::path::MAIN_SEPARATOR, "/"));
    }
    let parts: Vec<String> = full
        .strip_prefix(root)
        .ok()?
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    Some(parts.join("/"))
}

/// A local path the user can open from a link: its scope ("home", or "disk"
/// for a full path outside home), the path in that scope (see `scope_path`),
/// and whether it is a folder.
#[derive(serde::Serialize, Debug, PartialEq)]
pub struct LocalPath {
    pub root: &'static str,
    pub rel: String,
    pub is_dir: bool,
}

/// Resolve a path as printed in a conversation or a terminal to an existing
/// file or folder: under home as "home", anywhere else as "disk". Absolute and
/// `~/…` paths are taken literally (on Windows a WSL shell's Linux paths are
/// translated, see `host_path`). A relative one is tried under `cwd`, then
/// against `anchors`: absolute paths seen in the same context (files the agent
/// read, folders it ran commands in), most recent first. An anchor that ends
/// with the path is the match; otherwise the path is tried under the anchor's
/// folder and each folder above it, short of home and of the folders nearest a
/// root (`/tmp`, `/Users/me`, `C:\Users\me`): those are too broad to search.
/// Only what exists counts, so a guess never links to the wrong file.
pub fn locate_local(home: &Path, path: &str, cwd: Option<&str>, anchors: &[String]) -> Option<LocalPath> {
    let home = home.canonicalize().ok()?;
    let local = |p: &Path| -> Option<LocalPath> {
        let full = p.canonicalize().ok()?;
        let (root, rel) = if full.starts_with(&home) {
            ("home", scope_path(&home, &full).filter(|r| !r.is_empty())?) // not home itself
        } else {
            full.parent()?; // not `/` or a drive itself
            ("disk", scope_path(Path::new(""), &full)?)
        };
        Some(LocalPath { root, rel, is_dir: full.is_dir() })
    };
    let full_path = |p: &str| -> PathBuf {
        let tilde = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\").filter(|_| cfg!(windows)));
        tilde.map(|rest| home.join(rest)).unwrap_or_else(|| host_path(p))
    };
    let raw = full_path(path);
    if raw.is_absolute() {
        return local(&raw);
    }
    if let Some(cwd) = cwd.map(Path::new).filter(|c| c.is_absolute()) {
        if let Some(found) = local(&cwd.join(&raw)) {
            return Some(found);
        }
    }
    // Against anchors only a plain relative path: no `..`, no drive prefix.
    if !raw.components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir)) {
        return None;
    }
    let suffix: PathBuf = raw.components().filter(|c| matches!(c, Component::Normal(_))).collect();
    if suffix.as_os_str().is_empty() {
        return None;
    }
    let too_broad = |d: &Path| d == home || d.components().filter(|c| matches!(c, Component::Normal(_))).count() < 3;
    let mut tried = std::collections::HashSet::new();
    for anchor in anchors {
        let anchor = full_path(anchor);
        if !anchor.is_absolute() {
            continue;
        }
        // The deepest part of it that still exists, in canonical form.
        let Some(start) = anchor.ancestors().find_map(|a| a.canonicalize().ok()) else { continue };
        if start.ends_with(&suffix) {
            if let Some(found) = local(&start) {
                return Some(found);
            }
        }
        let mut dir = if start.is_dir() { Some(start.as_path()) } else { start.parent() };
        while let Some(d) = dir {
            if too_broad(d) || !tried.insert(d.to_path_buf()) {
                break; // a folder tried before had its parents tried too
            }
            if let Some(found) = local(&d.join(&suffix)) {
                return Some(found);
            }
            dir = d.parent();
        }
    }
    None
}

/// A full path as this machine reaches it. On Windows a Linux path printed by
/// a WSL shell (`/mnt/c/a.png`, `/home/me/a.png`) is translated (see
/// `wsl_path`); any other path is itself.
fn host_path(path: &str) -> PathBuf {
    #[cfg(windows)]
    if path.starts_with('/') && !path.starts_with("//") {
        if let Some(p) = wsl_path(path, wsl_distros(), |p| Path::new(p).exists()) {
            return PathBuf::from(p);
        }
    }
    PathBuf::from(path)
}

/// Where Windows reaches a WSL Linux path: `/mnt/<drive>/…` is that drive;
/// any other is the same path in the one WSL distro (`\\wsl$\<name>`) that
/// has it — in none, or in several, it is no path, never a guess.
pub fn wsl_path(path: &str, distros: &[String], exists: impl Fn(&str) -> bool) -> Option<String> {
    let parts: Vec<&str> = path.strip_prefix('/')?.split('/').filter(|s| !s.is_empty()).collect();
    if let ["mnt", drive, rest @ ..] = parts.as_slice() {
        if drive.len() == 1 && drive.chars().all(|c| c.is_ascii_alphabetic()) {
            return Some(format!("{}:\\{}", drive.to_ascii_uppercase(), rest.join("\\")));
        }
    }
    let mut found = distros.iter().map(|d| format!("{d}\\{}", parts.join("\\"))).filter(|p| exists(p));
    let first = found.next()?;
    found.next().is_none().then_some(first)
}

/// The installed WSL distros, as `\\wsl$\<name>`; listed once per run
/// (`wsl.exe` writes UTF-16). Empty where WSL is not installed.
#[cfg(windows)]
fn wsl_distros() -> &'static [String] {
    static DISTROS: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    DISTROS.get_or_init(|| {
        let Ok(out) = crate::runtime::quiet_command("wsl.exe").args(["--list", "--quiet"]).output() else {
            return Vec::new();
        };
        if !out.status.success() {
            return Vec::new();
        }
        let units: Vec<u16> = out.stdout.chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
        String::from_utf16_lossy(&units)
            .lines()
            .map(|l| l.trim_matches(|c: char| c.is_whitespace() || c == '\0'))
            .filter(|l| !l.is_empty())
            .map(|name| format!(r"\\wsl$\{name}"))
            .collect()
    })
}

// Bounds for the basename search so a huge workspace can't stall a resolve call.
const SEARCH_MAX_ENTRIES: usize = 10_000;
const SEARCH_MAX_DEPTH: usize = 8;

/// Locate `rel` under `root`: the literal path when it exists, otherwise the
/// workspace file whose path ends with `rel` (newest mtime when several match).
/// Agent messages often name a file without its directory ("index.html" for
/// "canvas-project/index.html"), so a bare name must still resolve. Directories
/// that were written must match: "pkg/README.md" never resolves to another
/// README.md. Absolute paths and `..` are only taken literally.
/// Returns a root-relative path with `/` separators, or None.
pub fn locate_under(root: &Path, rel: &str) -> Option<String> {
    let canon_root = root.canonicalize().ok()?;
    if let Ok(p) = resolve_under(root, rel) {
        if p.is_file() {
            // `rel` may be absolute (agent prose often prints the full path);
            // relativize against the root — stripping only the leading slash
            // would yield a bogus "Users/…" path the preview server 404s on.
            let r = p.strip_prefix(&canon_root).ok()?;
            let parts: Vec<String> = r
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect();
            return Some(parts.join("/"));
        }
    }
    let mut want = Vec::new();
    for c in Path::new(rel).components() {
        match c {
            Component::Normal(s) => want.push(s.to_os_string()),
            Component::CurDir => {}
            _ => return None,
        }
    }
    let name = want.last()?.clone();
    let suffix: PathBuf = want.iter().collect();
    let root = canon_root;
    let mut best: Option<(PathBuf, std::time::SystemTime)> = None;
    let mut stack = vec![(root.clone(), 0usize)];
    let mut seen = 0usize;
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            seen += 1;
            if seen > SEARCH_MAX_ENTRIES {
                stack.clear();
                break;
            }
            let fname = entry.file_name();
            // Hidden files/dirs and dependency trees are never agent artifacts.
            let fname_str = fname.to_string_lossy();
            if fname_str.starts_with('.') || fname_str == "node_modules" || fname_str == "__pycache__" {
                continue;
            }
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() {
                if depth < SEARCH_MAX_DEPTH {
                    stack.push((entry.path(), depth + 1));
                }
            } else if ft.is_file()
                && fname == name
                && entry.path().strip_prefix(&root).is_ok_and(|r| r.ends_with(&suffix))
            {
                let mtime = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                if best.as_ref().is_none_or(|(_, t)| mtime > *t) {
                    best = Some((entry.path(), mtime));
                }
            }
        }
    }
    let (path, _) = best?;
    let rel_path = path.strip_prefix(&root).ok()?;
    let parts: Vec<String> = rel_path
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    Some(parts.join("/"))
}

/// Resolve a file mentioned in an agent message to a real workspace-relative
/// path (searching by basename when the literal path does not exist), or None.
/// `async`: a miss walks up to SEARCH_MAX_ENTRIES directory entries looking for
/// the basename, and every agent message that names a file calls this when it
/// mounts. On the UI thread that turned a workspace with tens of thousands of
/// files into seconds of "Not Responding" on every pane switch (#92) — the same
/// reason `read_artifact` below is async.
pub fn resolve_artifact(env: &Env, path: &str) -> Result<Option<String>, String> {
    Ok(locate_under(&workspace_dir(env)?, path))
}

/// Read a workspace file for preview. Text types come back as UTF-8, binary as
/// base64. `async`: previews read multi-MB files — never on the UI thread.
pub fn read_artifact(env: &Env, path: String, root: Option<String>) -> Result<ArtifactFile, String> {
    let full = resolve_under(&scope_root(env, root.as_deref())?, &path)?;
    let ext = full
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let (mime, is_text) = mime_for(&ext);
    // Check the size from metadata BEFORE reading the bytes — otherwise a
    // multi-GB file is fully loaded into memory (and can OOM the app) before the
    // cap is ever consulted. Stat first, reject early, then read.
    let size = std::fs::metadata(&full)
        .map_err(|e| format!("read failed: {e}"))?
        .len();
    if exceeds_preview_cap(size) {
        return Err(format!("file too large to preview (>{} MB)", PREVIEW_CAP_BYTES / (1024 * 1024)));
    }
    let bytes = std::fs::read(&full).map_err(|e| format!("read failed: {e}"))?;
    let (mime, encoding, data) = encode_for_preview(mime, is_text, bytes);
    Ok(ArtifactFile { path, mime: mime.to_string(), encoding, data, size })
}

/// Decide how file bytes reach the frontend: known text types as UTF-8, known
/// binary as base64. An unknown extension is sniffed instead of assumed binary —
/// valid UTF-8 with no NUL bytes previews as text (.bib, .rst, source files, …).
fn encode_for_preview(
    mime: &'static str,
    is_text: bool,
    bytes: Vec<u8>,
) -> (&'static str, &'static str, String) {
    if is_text {
        return (mime, "utf8", String::from_utf8_lossy(&bytes).into_owned());
    }
    if mime == "application/octet-stream" {
        return match String::from_utf8(bytes) {
            Ok(s) if !s.contains('\0') => ("text/plain", "utf8", s),
            Ok(s) => (mime, "base64", base64_encode(s.as_bytes())),
            Err(e) => (mime, "base64", base64_encode(e.as_bytes())),
        };
    }
    (mime, "base64", base64_encode(&bytes))
}

/// Unwrap a Windows verbatim path (`\\?\C:\x`, `\\?\UNC\srv\share`) to the plain
/// form. A pure string transform — no `cfg` inside — so the Windows shape stays
/// testable on any host; `native_path` decides when it applies. Compiled only
/// where it is reachable: on Windows, and in tests everywhere.
#[cfg(any(target_os = "windows", test))]
pub fn strip_windows_verbatim(s: &str) -> String {
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_owned()
    } else {
        s.to_owned()
    }
}

/// A path in the OS-native form every other layer speaks. On Windows
/// `canonicalize()` yields the `\\?\` verbatim form, which Explorer rejects, no
/// other component ever produces, and no comparison against a path OpenCode
/// reported can match — so it is unwrapped to the plain `C:\…`. Separators are
/// left alone (the frontend compares by a normalized key). No-op off Windows,
/// where `\` is a legal filename character and must never be rewritten.
#[cfg(target_os = "windows")]
pub fn native_path(full: &Path) -> String {
    strip_windows_verbatim(&full.to_string_lossy())
}

#[cfg(not(target_os = "windows"))]
pub fn native_path(full: &Path) -> String {
    full.to_string_lossy().into_owned()
}

/// The absolute filesystem path of a workspace file/dir, for "Copy path" — in
/// OS-native form (plain `C:\…` on Windows, not the `\\?\` verbatim path).
pub fn absolute_path(env: &Env, path: String, root: Option<String>) -> Result<String, String> {
    let full = resolve_under(&scope_root(env, root.as_deref())?, &path)?;
    Ok(native_path(&full))
}

#[derive(serde::Serialize)]
pub struct NotebookEntry {
    path: String,
    /// Seconds since the epoch, for newest-first sorting in the UI.
    modified: u64,
}

/// All .ipynb files under the chosen root (same bounds/skips as the artifact
/// search), newest first. `root: "base"` spans every session folder.
pub fn list_notebooks(env: &Env, root: Option<String>) -> Result<Vec<NotebookEntry>, String> {
    let root = scope_root(env, root.as_deref())?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let mut found = Vec::new();
    let mut stack = vec![(root.clone(), 0usize)];
    let mut seen = 0usize;
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            seen += 1;
            if seen > SEARCH_MAX_ENTRIES {
                stack.clear();
                break;
            }
            let fname = entry.file_name();
            let fname_str = fname.to_string_lossy();
            if fname_str.starts_with('.') || fname_str == "node_modules" || fname_str == "__pycache__" {
                continue;
            }
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() {
                if depth < SEARCH_MAX_DEPTH {
                    stack.push((entry.path(), depth + 1));
                }
            } else if ft.is_file() && fname_str.ends_with(".ipynb") {
                let modified = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                if let Ok(rel) = entry.path().strip_prefix(&root) {
                    let parts: Vec<String> = rel
                        .components()
                        .map(|c| c.as_os_str().to_string_lossy().into_owned())
                        .collect();
                    found.push(NotebookEntry { path: parts.join("/"), modified });
                }
            }
        }
    }
    found.sort_by_key(|b| std::cmp::Reverse(b.modified));
    Ok(found)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    /// Workspace-relative path with `/` separators.
    path: String,
    /// Base name shown in the tree.
    name: String,
    is_dir: bool,
    /// File size in bytes (0 for directories).
    size: u64,
    /// Seconds since the epoch.
    modified: u64,
    /// For a link to a folder (a project's linked session folder): where it
    /// really is — absolute, native form. Listed as the folder it points at.
    #[serde(skip_serializing_if = "Option::is_none")]
    link: Option<String>,
}

/// List one directory under the chosen root (non-recursive) for the file
/// explorer. `rel` is a root-relative dir path ("" = the root itself). Hidden
/// entries and heavy build dirs are skipped; directories sort first, then by name.
pub fn list_dir(env: &Env, rel: String, root: Option<String>) -> Result<Vec<DirEntry>, String> {
    dir_entries(&scope_root(env, root.as_deref())?, &rel)
}

/// A Windows junction reports as neither a symlink nor a plain folder to
/// `file_type`; its reparse-point attribute is what marks it.
#[cfg(windows)]
fn is_reparse_point(entry: &std::fs::DirEntry) -> bool {
    use std::os::windows::fs::MetadataExt;
    entry.metadata().map(|m| m.file_attributes() & 0x400 != 0).unwrap_or(false)
}
#[cfg(not(windows))]
fn is_reparse_point(_: &std::fs::DirEntry) -> bool {
    false
}

pub fn dir_entries(root: &Path, rel: &str) -> Result<Vec<DirEntry>, String> {
    let root = if root.as_os_str().is_empty() { PathBuf::new() } else { root.canonicalize().map_err(|e| e.to_string())? };
    let dir = resolve_under(&root, rel)?;
    if !dir.is_dir() {
        return Err("not a directory".into());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let fname = entry.file_name();
        let name = fname.to_string_lossy().into_owned();
        if name.starts_with('.') || name == "node_modules" || name == "__pycache__" {
            continue;
        }
        let Ok(ft) = entry.file_type() else { continue };
        // Follow a link for what it IS (a folder, a file); remember that it was
        // one and where it leads. A dangling link has nothing to show.
        let link = if ft.is_symlink() || is_reparse_point(&entry) {
            match entry.path().canonicalize() {
                Ok(target) => Some(native_path(&target)),
                Err(_) => continue,
            }
        } else {
            None
        };
        let meta = if link.is_some() { std::fs::metadata(entry.path()).ok() } else { entry.metadata().ok() };
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let is_file = meta.as_ref().map(|m| m.is_file()).unwrap_or(false);
        let modified = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let Some(rel_path) = scope_path(&root, &entry.path()) else { continue };
        out.push(DirEntry {
            path: rel_path,
            name,
            is_dir,
            size: if is_file { meta.as_ref().map(|m| m.len()).unwrap_or(0) } else { 0 },
            modified,
            link,
        });
    }
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

/// Write text to a root-relative path (used to save notebooks). Rejects
/// absolute paths and any `..` component; missing parent dirs are created.
/// Under the root-less disk scope the path is a full path to a file that
/// exists (a file opened from a link), not a new one.
pub fn write_workspace_file(
    env: &Env,
    path: String,
    content: String,
    root: Option<String>,
) -> Result<(), String> {
    let scope = scope_root(env, root.as_deref())?;
    if scope.as_os_str().is_empty() {
        let full = resolve_under(&scope, &path)?;
        return std::fs::write(&full, content).map_err(|e| format!("write failed: {e}"));
    }
    let rel = Path::new(&path);
    if rel.is_absolute()
        || rel
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err("path must be a plain workspace-relative path".into());
    }
    let full = scope.join(rel);
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&full, content).map_err(|e| format!("write failed: {e}"))?;
    crate::git_snapshot::request_snapshot(&scope);
    Ok(())
}

/// One attached file, and whether attaching it PUT it in the workspace.
///
/// The difference is the whole safety of discarding an attachment: a file the
/// attach copied in is the composer's own, and removing its chip can delete it;
/// a file that was already in the workspace was merely referenced, and deleting
/// it would destroy the user's data. Only the code that did the attaching can
/// tell the two apart, so it says so here rather than leaving the caller to
/// guess from a bare name.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Attached {
    pub name: String,
    pub copied: bool,
}

/// Attach local files to the workspace and return their workspace-relative
/// names. A source already inside the workspace is referenced in place; anything
/// else is copied to the workspace root under a deduplicated name (name-1.ext,
/// name-2.ext on collision). Non-files (folders, unreadable or dangling paths)
/// are skipped. Requests a git snapshot only when something was actually copied
/// in — an in-place reference adds no bytes to the workspace.
///
/// Shared by both attach paths (native picker and drag-and-drop): they differ
/// only in how they obtain the paths, and the last two bugs here were both this
/// logic having been fixed in one of them and not the other.
pub fn attach_paths(
    ws: &Path,
    srcs: impl IntoIterator<Item = PathBuf>,
) -> Result<Vec<Attached>, String> {
    // Canonicalize the workspace root once so we can tell whether a source path
    // already resolves to somewhere inside it (through symlinks / `..` / case).
    let ws_canon = ws.canonicalize().unwrap_or_else(|_| ws.to_path_buf());
    let mut added = Vec::new();
    let mut copied = false;
    for src in srcs {
        if !src.is_file() {
            continue; // attach files only, not folders
        }
        // Already inside the workspace → attach its workspace-relative path in
        // place rather than copying it to the root as a duplicate.
        if let Some(rel) = workspace_relative(&ws_canon, &src) {
            added.push(Attached { name: rel, copied: false });
            continue;
        }
        let name = src.file_name().ok_or("path has no file name")?.to_string_lossy().to_string();
        let dst = unique_name(ws, &name);
        std::fs::copy(&src, ws.join(&dst)).map_err(|e| format!("copy failed: {e}"))?;
        added.push(Attached { name: dst, copied: true });
        copied = true;
    }
    if copied {
        crate::git_snapshot::request_snapshot(ws);
    }
    Ok(added)
}

/// Write text content into the workspace under `filename` (deduplicated as
/// name-1.ext on collision). Used when a long paste becomes a file. Returns
/// the actual name written.
pub fn add_text_to_workspace(
    env: &Env,
    filename: String,
    content: String,
) -> Result<String, String> {
    write_new_file(&workspace_dir(env)?, &filename, content.as_bytes())
}

/// Attach explicit local file paths to the workspace. Used by drag-and-drop,
/// which hands us OS paths — the native-picker path is `add_files_to_workspace`.
/// See `attach_paths` for the in-place-vs-copy rule; dragging a workspace file
/// back into the composer references it in place instead of duplicating it.
pub fn add_paths_to_workspace(env: &Env, paths: Vec<String>) -> Result<Vec<Attached>, String> {
    let ws = workspace_dir(env)?;
    attach_paths(&ws, paths.into_iter().map(PathBuf::from))
}

/// Write binary content (base64-encoded) into the workspace under `filename`
/// (deduplicated as name-1.ext on collision). Used when a pasted image becomes a
/// file. Returns the actual name written.
pub fn add_binary_to_workspace(
    env: &Env,
    filename: String,
    base64: String,
) -> Result<String, String> {
    let bytes = base64_decode(&base64)?;
    write_new_file(&workspace_dir(env)?, &filename, &bytes)
}

/// Write `bytes` into the root of `dir` under the base name of `filename`
/// (deduplicated as name-1.ext on collision) and return the name written.
/// Shared by paste, long-text paste and the web client's upload, so all three
/// land the same way and the chip's discard (root-level only) can find them.
pub fn write_new_file(dir: &Path, filename: &str, bytes: &[u8]) -> Result<String, String> {
    let base = Path::new(filename)
        .file_name()
        .ok_or("invalid file name")?
        .to_string_lossy()
        .to_string();
    let name = unique_name(dir, &base);
    std::fs::write(dir.join(&name), bytes).map_err(|e| format!("write failed: {e}"))?;
    crate::git_snapshot::request_snapshot(dir);
    Ok(name)
}

/// A name the composer may ask to delete: a bare file name, which is the only
/// shape `attach_paths` ever COPIES something in under. Anything with a
/// separator or a `..` is either an in-place reference to a file that was
/// already in the workspace or an attempt to walk out of it, and neither may
/// reach `remove_file`.
fn is_discardable_name(name: &str) -> bool {
    !name.is_empty() && !name.contains('/') && !name.contains('\\') && !name.contains("..")
}

/// Delete a file the composer copied into the workspace — a pasted screenshot
/// whose chip was removed before the message was sent.
///
/// Root level only, and no path separators: everything the attach COPIES lands
/// at the workspace root under a deduplicated name, so nothing legitimate is
/// refused, while a name from a subdirectory (which can only be an in-place
/// reference to a file that was already there) can never reach the filesystem.
/// A missing file is not an error — the chip is going either way, and failing
/// the removal over an already-gone file would only strand it in the composer.
pub fn discard_workspace_file(env: &Env, name: String) -> Result<(), String> {
    discard_file_in(&workspace_dir(env)?, &name)
}

/// `discard_workspace_file` for an explicit folder — the web client's chips
/// live in the session's folder, which need not be the host's active one.
pub fn discard_file_in(dir: &Path, name: &str) -> Result<(), String> {
    if !is_discardable_name(name) {
        return Err("not a workspace file name".into());
    }
    let full = resolve_under(dir, name)?;
    match std::fs::metadata(&full) {
        Err(_) => return Ok(()),
        Ok(m) if !m.is_file() => return Err("not a file".into()),
        Ok(_) => {}
    }
    std::fs::remove_file(&full).map_err(|e| format!("delete failed: {e}"))?;
    Ok(())
}

/// If `src` resolves to a location inside `ws_canon` (an already-canonicalized
/// workspace root), returns its workspace-relative path with `/` separators;
/// otherwise `None`. Lets a dropped workspace file attach in place instead of
/// being copied to the root as a duplicate.
fn workspace_relative(ws_canon: &Path, src: &Path) -> Option<String> {
    let canon = src.canonicalize().ok()?;
    let rel = canon.strip_prefix(ws_canon).ok()?;
    Some(rel.to_string_lossy().replace('\\', "/"))
}

/// First free variant of `name` in `dir`: name.ext, name-1.ext, name-2.ext, …
fn unique_name(dir: &Path, name: &str) -> String {
    if !dir.join(name).exists() {
        return name.to_string();
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s, Some(e)),
        _ => (name, None),
    };
    for n in 1.. {
        let candidate = match ext {
            Some(e) => format!("{stem}-{n}.{e}"),
            None => format!("{stem}-{n}"),
        };
        if !dir.join(&candidate).exists() {
            return candidate;
        }
    }
    unreachable!()
}

/// Minimal std-only base64 decode (mirror of `base64_encode`). Skips whitespace,
/// stops at padding, and errors on any invalid character.
fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a' + 26) as u32),
            b'0'..=b'9' => Some((c - b'0' + 52) as u32),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut buf = 0u32;
    let mut bits = 0u32;
    for &c in input.as_bytes() {
        if c == b'=' {
            break;
        }
        if c.is_ascii_whitespace() {
            continue;
        }
        buf = (buf << 6) | val(c).ok_or("invalid base64")?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Ok(out)
}

/// Minimal std-only base64 (avoids adding a dependency).
fn base64_encode(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | (b[2] as u32);
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{
        attach_paths, base64_decode, base64_encode, dir_entries, encode_for_preview,
        is_discardable_name, Attached,
        exceeds_preview_cap, locate_local, locate_under, mime_for, strip_windows_verbatim,
        native_path, resolve_under, unique_name, workspace_relative, wsl_path, LocalPath,
    };

    /// A project's linked session folder is a link in the project folder: it
    /// lists as the folder it points at, saying where that really is.
    #[cfg(unix)]
    #[test]
    fn a_link_to_a_folder_lists_as_that_folder() {
        let root = std::env::temp_dir().join(format!("os-list-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let real = root.join("sessions").join("2026-10-18-0900");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("fig.png"), "png").unwrap();
        let project = root.join("projects").join("bci");
        std::fs::create_dir_all(&project).unwrap();
        std::os::unix::fs::symlink(&real, project.join("Spike sorting")).unwrap();
        std::os::unix::fs::symlink(root.join("nowhere"), project.join("dangling")).unwrap();

        let entries = dir_entries(&root, "projects/bci").unwrap();
        assert_eq!(entries.len(), 1, "a dangling link has nothing to show");
        assert!(entries[0].is_dir);
        assert_eq!(entries[0].name, "Spike sorting");
        assert_eq!(entries[0].link.as_deref(), Some(native_path(&real.canonicalize().unwrap()).as_str()));
        // And it opens as that folder, under the same root.
        let inside = dir_entries(&root, "projects/bci/Spike sorting").unwrap();
        assert_eq!(inside[0].name, "fig.png");
        let _ = std::fs::remove_dir_all(root);
    }
    use std::path::{Path, PathBuf};

    #[test]
    fn local_links_resolve_under_home_or_as_full_paths() {
        let home = std::env::temp_dir().join(format!("osd-local-{}", std::process::id()));
        let outside = std::env::temp_dir().join(format!("osd-local-out-{}", std::process::id()));
        std::fs::create_dir_all(home.join("repo/src")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(home.join("repo/src/main.rs"), "fn main() {}").unwrap();
        let file = |rel: &str| Some(LocalPath { root: "home", rel: rel.into(), is_dir: false });
        let abs = home.join("repo/src/main.rs");

        // Absolute, relative to the terminal's directory, and a folder.
        assert_eq!(locate_local(&home, abs.to_str().unwrap(), None, &[]), file("repo/src/main.rs"));
        let cwd = home.join("repo");
        assert_eq!(locate_local(&home, "src/main.rs", cwd.to_str(), &[]), file("repo/src/main.rs"));
        assert_eq!(
            locate_local(&home, "src", cwd.to_str(), &[]),
            Some(LocalPath { root: "home", rel: "repo/src".into(), is_dir: true })
        );
        // A relative path with no directory to resolve it against, a missing
        // file, and home itself: no link.
        assert_eq!(locate_local(&home, "src/main.rs", None, &[]), None);
        assert_eq!(locate_local(&home, "src/nope.rs", cwd.to_str(), &[]), None);
        assert_eq!(locate_local(&home, "../../nope-xyz", cwd.to_str(), &[]), None);
        assert_eq!(locate_local(&home, home.to_str().unwrap(), None, &[]), None);
        // A full path outside home opens on disk as that full path, and the
        // disk scope reads it back; `/` itself is no link.
        std::fs::write(outside.join("shot.png"), "x").unwrap();
        let shot = outside.join("shot.png").canonicalize().unwrap();
        let rel = native_path(&shot).replace(std::path::MAIN_SEPARATOR, "/");
        assert_eq!(
            locate_local(&home, shot.to_str().unwrap(), None, &[]),
            Some(LocalPath { root: "disk", rel: rel.clone(), is_dir: false })
        );
        assert_eq!(resolve_under(Path::new(""), &rel).unwrap(), shot);
        assert!(resolve_under(Path::new(""), "relative/shot.png").is_err());
        let listed = dir_entries(Path::new(""), &rel[..rel.rfind('/').unwrap()]).unwrap();
        assert_eq!(listed.iter().find(|e| e.name == "shot.png").map(|e| e.path.as_str()), Some(rel.as_str()));
        assert_eq!(locate_local(&home, "/", None, &[]), None);
        // Relative to a terminal folder outside home, and to an anchor there.
        let disk = |p: &Path| {
            let full = p.canonicalize().unwrap();
            Some(LocalPath { root: "disk", rel: native_path(&full).replace(std::path::MAIN_SEPARATOR, "/"), is_dir: full.is_dir() })
        };
        assert_eq!(locate_local(&home, "shot.png", outside.to_str(), &[]), disk(&shot));
        std::fs::create_dir_all(outside.join("proj/src")).unwrap();
        std::fs::write(outside.join("proj/src/lib.rs"), "x").unwrap();
        let anchors = vec![outside.join("proj/README.md").to_string_lossy().into_owned()];
        assert_eq!(locate_local(&home, "src/lib.rs", None, &anchors), disk(&outside.join("proj/src/lib.rs")));

        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn wsl_paths_are_found_where_windows_reaches_them() {
        let distros = vec![r"\\wsl$\Ubuntu".to_string(), r"\\wsl$\Debian".to_string()];
        // A Windows drive, mounted.
        assert_eq!(wsl_path("/mnt/c/Users/me/a.png", &distros, |_| false).as_deref(), Some(r"C:\Users\me\a.png"));
        // Any other path: in the one distro that has it; in none or in two, nothing.
        let only_ubuntu = |p: &str| p.starts_with(r"\\wsl$\Ubuntu\");
        assert_eq!(wsl_path("/home/me/a.png", &distros, only_ubuntu).as_deref(), Some(r"\\wsl$\Ubuntu\home\me\a.png"));
        assert_eq!(wsl_path("/home/me/a.png", &distros, |_| false), None);
        assert_eq!(wsl_path("/etc/hosts", &distros, |_| true), None);
        // `/mnt/wsl` is no drive; a relative path is no WSL path.
        assert_eq!(wsl_path("/mnt/wsl/x", &distros, only_ubuntu).as_deref(), Some(r"\\wsl$\Ubuntu\mnt\wsl\x"));
        assert_eq!(wsl_path("home/me", &distros, |_| true), None);
    }

    #[test]
    fn local_links_resolve_against_anchors() {
        let home = std::env::temp_dir().join(format!("osd-anchor-{}", std::process::id()));
        std::fs::create_dir_all(home.join("repo/packages/core/src")).unwrap();
        std::fs::create_dir_all(home.join("proj")).unwrap();
        std::fs::create_dir_all(home.join("other/src")).unwrap();
        std::fs::write(home.join("repo/packages/core/src/agent.ts"), "x").unwrap();
        std::fs::write(home.join("repo/README.md"), "x").unwrap();
        std::fs::write(home.join("other/src/agent.ts"), "x").unwrap();
        let file = |rel: &str| Some(LocalPath { root: "home", rel: rel.into(), is_dir: false });
        let s = |p: PathBuf| p.to_string_lossy().into_owned();
        // The agent read one file of the repo and ran a command in another project.
        let anchors = vec![s(home.join("repo/README.md")), s(home.join("other"))];

        // A repo path printed relative to the repo root, as an answer writes it.
        assert_eq!(
            locate_local(&home, "packages/core/src/agent.ts", None, &anchors),
            file("repo/packages/core/src/agent.ts")
        );
        // A bare name or a short tail: the anchor that ends with it, else the
        // most recent anchor's folders first.
        assert_eq!(locate_local(&home, "README.md", None, &anchors), file("repo/README.md"));
        assert_eq!(locate_local(&home, "src/agent.ts", None, &anchors), file("other/src/agent.ts"));
        // A name with spaces: its anchor was cut at the first space, and is
        // searched from the part of it that exists.
        std::fs::create_dir_all(home.join("Downloads")).unwrap();
        std::fs::write(home.join("Downloads/Penguin AI Adventure.png"), "x").unwrap();
        let cut = vec![s(home.join("Downloads/Penguin"))];
        assert_eq!(locate_local(&home, "Penguin AI Adventure.png", None, &cut), file("Downloads/Penguin AI Adventure.png"));
        // The cwd wins over anchors; nothing that does not exist; never `..`.
        let cwd = home.join("repo/packages/core");
        assert_eq!(locate_local(&home, "src/agent.ts", cwd.to_str(), &anchors), file("repo/packages/core/src/agent.ts"));
        assert_eq!(locate_local(&home, "packages/nope.ts", None, &anchors), None);
        assert_eq!(locate_local(&home, "../repo/README.md", None, &anchors), None);
        // Home itself is never searched: a path only an anchor's folders explain.
        std::fs::write(home.join("top.md"), "x").unwrap();
        assert_eq!(locate_local(&home, "top.md", None, &anchors), None);

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn verbatim_windows_paths_unwrap_to_the_plain_form() {
        // What `canonicalize()` hands back on Windows, and what every other layer
        // — Explorer, the sidecar's session `directory`, the UI — actually speaks.
        // Runs on every host: the transform is a pure string rewrite (#76).
        assert_eq!(
            strip_windows_verbatim(r"\\?\D:\Openscience-documents\projects\视频总结"),
            r"D:\Openscience-documents\projects\视频总结",
        );
        // A UNC share keeps its double-backslash root rather than losing it.
        assert_eq!(
            strip_windows_verbatim(r"\\?\UNC\server\share\work"),
            r"\\server\share\work",
        );
        // Already-plain paths, a POSIX path and a bare drive pass through untouched.
        for plain in [r"D:\work", r"\\server\share", "/home/u/work", r"C:\"] {
            assert_eq!(strip_windows_verbatim(plain), plain, "{plain} must not change");
        }
    }

    #[test]
    fn base64_round_trips_arbitrary_bytes() {
        // Covers each padding case (len % 3 == 0/1/2) and non-ASCII/zero bytes —
        // a pasted PNG is arbitrary binary.
        for bytes in [
            &b""[..],
            &b"f"[..],
            &b"fo"[..],
            &b"foo"[..],
            &[0u8, 255, 16, 128, 1, 2, 3][..],
            &[137, 80, 78, 71, 13, 10, 26, 10][..], // PNG magic
        ] {
            assert_eq!(base64_decode(&base64_encode(bytes)).unwrap(), bytes);
        }
        // Whitespace in the payload is ignored; a bad char errors.
        assert_eq!(base64_decode("Zm9v\nYmFy").unwrap(), b"foobar");
        assert!(base64_decode("not base64!@#").is_err());
    }

    #[test]
    fn unknown_extension_sniffs_text_vs_binary() {
        // A .bib file (unknown to mime_for) is valid UTF-8 → previews as text.
        let (mime, is_text) = mime_for("bib");
        assert!(!is_text);
        let (m, enc, data) = encode_for_preview(mime, is_text, b"@article{k, title={T}}".to_vec());
        assert_eq!((m, enc), ("text/plain", "utf8"));
        assert_eq!(data, "@article{k, title={T}}");

        // NUL bytes or invalid UTF-8 stay binary (base64).
        let (_, enc, _) = encode_for_preview(mime, is_text, vec![b'a', 0, b'b']);
        assert_eq!(enc, "base64");
        let (_, enc, _) = encode_for_preview(mime, is_text, vec![0xff, 0xfe, 0x00]);
        assert_eq!(enc, "base64");

        // Known binary types are never sniffed.
        let (mime, is_text) = mime_for("pdf");
        let (_, enc, _) = encode_for_preview(mime, is_text, b"plain ascii".to_vec());
        assert_eq!(enc, "base64");
    }

    #[test]
    fn genome_and_molecule_files_are_text() {
        for ext in ["bed", "bedgraph", "gff", "gff3", "gtf", "vcf"] {
            assert!(mime_for(ext).1, "{ext} must be a text type");
        }
    }

    #[test]
    fn preview_cap_rejects_only_oversize_files() {
        assert!(!exceeds_preview_cap(0));
        assert!(!exceeds_preview_cap(1024));
        assert!(!exceeds_preview_cap(25 * 1024 * 1024)); // exactly the cap is allowed
        assert!(exceeds_preview_cap(25 * 1024 * 1024 + 1)); // one byte over is rejected
        assert!(exceeds_preview_cap(2 * 1024 * 1024 * 1024)); // a 2 GB file never loads
    }

    #[test]
    fn list_dir_sorts_dirs_first_and_skips_hidden() {
        let root = std::env::temp_dir().join(format!("ai4s-listdir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::create_dir_all(root.join(".hidden")).unwrap();
        std::fs::write(root.join("b.txt"), "hi").unwrap();
        std::fs::write(root.join("a.csv"), "x,y").unwrap();
        std::fs::write(root.join("node_modules_marker"), "").unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();

        let entries = dir_entries(&root, "").unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        // dir first, then files alphabetically; hidden + node_modules skipped.
        assert_eq!(names, vec!["sub", "a.csv", "b.txt", "node_modules_marker"]);
        assert!(entries[0].is_dir);
        assert_eq!(entries.iter().find(|e| e.name == "a.csv").unwrap().size, 3);

        // Listing a subdirectory and rejecting escapes.
        assert!(dir_entries(&root, "sub").unwrap().is_empty());
        assert!(dir_entries(&root, "../..").is_err());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn molecule_files_are_text() {
        // The 3D molecule viewer needs utf8, not base64 (3Dmol parses the source).
        for ext in [
            "mol", "mol2", "sdf", "smi", "smiles", "cif", "mcif", "mmcif", "pdb", "pqr", "xyz", "cube",
        ] {
            assert!(mime_for(ext).1, "{ext} must be a text type");
        }
    }

    #[test]
    fn unique_name_dedupes_with_numeric_suffix() {
        let dir = std::env::temp_dir().join(format!("ai4s-unique-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        assert_eq!(unique_name(&dir, "data.csv"), "data.csv");
        std::fs::write(dir.join("data.csv"), "x").unwrap();
        assert_eq!(unique_name(&dir, "data.csv"), "data-1.csv");
        std::fs::write(dir.join("data-1.csv"), "x").unwrap();
        assert_eq!(unique_name(&dir, "data.csv"), "data-2.csv");

        // No extension, and dotfiles (no stem before the dot) keep their whole name.
        std::fs::write(dir.join("README"), "x").unwrap();
        assert_eq!(unique_name(&dir, "README"), "README-1");
        std::fs::write(dir.join(".env"), "x").unwrap();
        assert_eq!(unique_name(&dir, ".env"), ".env-1");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn workspace_relative_detects_in_place_files() {
        // A file already inside the workspace attaches by its relative path (no
        // copy); anything outside returns None so it gets copied in. Regression
        // for issue #44 — dragging a workspace file back in must not duplicate it.
        let root = std::env::temp_dir().join(format!("ai4s-wsrel-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("results/foo")).unwrap();
        std::fs::write(root.join("top.png"), "x").unwrap();
        std::fs::write(root.join("results/foo/bar.png"), "x").unwrap();
        let ws = root.canonicalize().unwrap();

        assert_eq!(workspace_relative(&ws, &root.join("top.png")).as_deref(), Some("top.png"));
        assert_eq!(
            workspace_relative(&ws, &root.join("results/foo/bar.png")).as_deref(),
            Some("results/foo/bar.png"),
        );
        // A file outside the workspace, and a non-existent path, are not in place.
        let outside = std::env::temp_dir().join(format!("ai4s-wsrel-out-{}.png", std::process::id()));
        std::fs::write(&outside, "x").unwrap();
        assert_eq!(workspace_relative(&ws, &outside), None);
        assert_eq!(workspace_relative(&ws, Path::new("/no/such/file.png")), None);

        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn only_a_bare_workspace_name_may_be_discarded() {
        // What the attach copies in: a deduplicated bare name at the root.
        assert!(is_discardable_name("pasted.png"));
        assert!(is_discardable_name("taken-1.csv"));
        // An in-place reference to a file that was already in the workspace —
        // deleting one of these would destroy the user's own data.
        assert!(!is_discardable_name("results/foo/deep.csv"));
        // And nothing that tries to leave the workspace at all.
        assert!(!is_discardable_name("../outside.csv"));
        assert!(!is_discardable_name("..\\outside.csv"));
        assert!(!is_discardable_name(""));
    }

    #[test]
    fn attach_paths_references_in_place_and_copies_from_outside() {
        // The rule both attach paths (picker and drag-and-drop) now share: a
        // workspace file keeps its relative path, an outside file is copied to
        // the root under a deduplicated name, and folders are skipped.
        let base = std::env::temp_dir().join(format!("ai4s-attach-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let ws = base.join("workspace");
        std::fs::create_dir_all(ws.join("results/foo")).unwrap();
        std::fs::create_dir_all(base.join("elsewhere")).unwrap();
        std::fs::write(ws.join("results/foo/deep.csv"), "in").unwrap();
        std::fs::write(ws.join("taken.csv"), "already here").unwrap();
        std::fs::write(base.join("elsewhere/outside.csv"), "out").unwrap();
        std::fs::write(base.join("elsewhere/taken.csv"), "collides").unwrap();

        let srcs: Vec<PathBuf> = vec![
            ws.join("results/foo/deep.csv"),    // inside → in place, no copy
            base.join("elsewhere/outside.csv"), // outside → copied to the root
            base.join("elsewhere/taken.csv"),   // outside, name collides → -1
            base.join("elsewhere"),             // a folder → skipped
            base.join("no/such.csv"),           // missing → skipped
        ];
        let added = attach_paths(&ws, srcs).unwrap();

        assert_eq!(
            added,
            vec![
                Attached { name: "results/foo/deep.csv".into(), copied: false },
                Attached { name: "outside.csv".into(), copied: true },
                Attached { name: "taken-1.csv".into(), copied: true },
            ]
        );
        // The in-place file was referenced, not duplicated at the root.
        assert!(!ws.join("deep.csv").exists());
        assert_eq!(std::fs::read_to_string(ws.join("outside.csv")).unwrap(), "out");
        assert_eq!(std::fs::read_to_string(ws.join("taken.csv")).unwrap(), "already here");
        assert_eq!(std::fs::read_to_string(ws.join("taken-1.csv")).unwrap(), "collides");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn locate_finds_literal_bare_and_missing_paths() {
        let root = std::env::temp_dir().join(format!("ai4s-locate-test-{}", std::process::id()));
        std::fs::create_dir_all(root.join("proj")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::write(root.join("root.pdf"), b"x").unwrap();
        std::fs::write(root.join("proj/index.html"), b"<h1>hi</h1>").unwrap();
        std::fs::write(root.join("node_modules/pkg/dep.html"), b"x").unwrap();

        // Literal path that exists is returned as-is.
        assert_eq!(locate_under(&root, "root.pdf").as_deref(), Some("root.pdf"));
        assert_eq!(
            locate_under(&root, "proj/index.html").as_deref(),
            Some("proj/index.html")
        );
        // A bare filename resolves to the real location in a subdirectory.
        assert_eq!(
            locate_under(&root, "index.html").as_deref(),
            Some("proj/index.html")
        );
        // An absolute path inside the workspace (agent prose often prints the
        // full path) must come back ROOT-RELATIVE — stripping only the leading
        // slash used to yield "Users/…/proj/index.html", which then 404'd in
        // the preview server.
        let abs = root.join("proj/index.html");
        assert_eq!(
            locate_under(&root, &abs.to_string_lossy()).as_deref(),
            Some("proj/index.html")
        );
        // Dependency trees are skipped; missing files and escapes resolve to None.
        assert_eq!(locate_under(&root, "dep.html"), None);
        assert_eq!(locate_under(&root, "missing.pdf"), None);
        assert_eq!(locate_under(&root, "../../etc/hosts"), None);
        // Directories that were written must match: a path from another repo
        // never lands on a same-named file here; a shorter tail still resolves.
        assert_eq!(locate_under(&root, "other/repo/index.html"), None);
        assert_eq!(locate_under(&root, "/elsewhere/index.html"), None);
        std::fs::create_dir_all(root.join("site/proj")).unwrap();
        std::fs::write(root.join("site/proj/about.html"), b"x").unwrap();
        assert_eq!(
            locate_under(&root, "proj/about.html").as_deref(),
            Some("site/proj/about.html")
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn locate_prefers_the_newest_of_duplicate_basenames() {
        let root = std::env::temp_dir().join(format!("ai4s-locate-dup-test-{}", std::process::id()));
        std::fs::create_dir_all(root.join("old")).unwrap();
        std::fs::create_dir_all(root.join("new")).unwrap();
        std::fs::write(root.join("old/report.pdf"), b"x").unwrap();
        std::fs::write(root.join("new/report.pdf"), b"y").unwrap();
        let past = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        let f = std::fs::File::options().write(true).open(root.join("old/report.pdf")).unwrap();
        f.set_modified(past).unwrap();

        assert_eq!(
            locate_under(&root, "report.pdf").as_deref(),
            Some("new/report.pdf")
        );

        let _ = std::fs::remove_dir_all(root);
    }
}
