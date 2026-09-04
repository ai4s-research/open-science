// Read/open files the agent produced in the workspace, for artifact previews.
// Strictly sandboxed to the workspace root: a path that escapes it is rejected.
use std::path::{Path, PathBuf};
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
        "html" | "htm" => ("text/html", true),
        "svg" => ("image/svg+xml", true),
        "csv" => ("text/csv", true),
        "tsv" => ("text/tab-separated-values", true),
        "md" => ("text/markdown", true),
        "tex" => ("text/x-tex", true),
        "json" => ("application/json", true),
        "ipynb" => ("application/x-ipynb+json", true),
        "yaml" | "yml" => ("text/yaml", true),
        "js" | "ts" | "sh" | "toml" | "log" => ("text/plain", true),
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

/// Resolve `rel` under `root`, rejecting any path that escapes it.
pub fn resolve_under(root: &Path, rel: &str) -> Result<PathBuf, String> {
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
/// (default) or the base folder every session workspace is created under.
/// Pages declare their scope explicitly — no fallback guessing between the
/// two, so an identical relative path can never resolve ambiguously.
pub fn scope_root(env: &Env, root: Option<&str>) -> Result<PathBuf, String> {
    match root.unwrap_or("workspace") {
        "workspace" => workspace_dir(env),
        "base" => crate::runtime::base_workspace_dir(env),
        other => Err(format!("unknown root scope: {other}")),
    }
}

// Bounds for the basename search so a huge workspace can't stall a resolve call.
const SEARCH_MAX_ENTRIES: usize = 10_000;
const SEARCH_MAX_DEPTH: usize = 8;

/// Locate `rel` under `root`: the literal path when it exists, otherwise the
/// workspace file with the same basename (newest mtime when several match).
/// Agent messages often name a file without its directory ("index.html" for
/// "canvas-project/index.html"), so a bare name must still resolve.
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
    let name = Path::new(rel).file_name()?.to_os_string();
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
            } else if ft.is_file() && fname == name {
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
}

/// List one directory under the chosen root (non-recursive) for the file
/// explorer. `rel` is a root-relative dir path ("" = the root itself). Hidden
/// entries and heavy build dirs are skipped; directories sort first, then by name.
pub fn list_dir(env: &Env, rel: String, root: Option<String>) -> Result<Vec<DirEntry>, String> {
    dir_entries(&scope_root(env, root.as_deref())?, &rel)
}

pub fn dir_entries(root: &Path, rel: &str) -> Result<Vec<DirEntry>, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
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
        let meta = entry.metadata().ok();
        let modified = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let Ok(rel_path) = entry.path().strip_prefix(&root).map(|p| {
            p.components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/")
        }) else {
            continue;
        };
        out.push(DirEntry {
            path: rel_path,
            name,
            is_dir: ft.is_dir(),
            size: if ft.is_file() { meta.as_ref().map(|m| m.len()).unwrap_or(0) } else { 0 },
            modified,
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
pub fn write_workspace_file(
    env: &Env,
    path: String,
    content: String,
    root: Option<String>,
) -> Result<(), String> {
    let scope = scope_root(env, root.as_deref())?;
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
pub fn attach_paths(ws: &Path, srcs: impl IntoIterator<Item = PathBuf>) -> Result<Vec<String>, String> {
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
            added.push(rel);
            continue;
        }
        let name = src.file_name().ok_or("path has no file name")?.to_string_lossy().to_string();
        let dst = unique_name(ws, &name);
        std::fs::copy(&src, ws.join(&dst)).map_err(|e| format!("copy failed: {e}"))?;
        added.push(dst);
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
    let base = Path::new(&filename)
        .file_name()
        .ok_or("invalid file name")?
        .to_string_lossy()
        .to_string();
    let ws = workspace_dir(env)?;
    let name = unique_name(&ws, &base);
    std::fs::write(ws.join(&name), content).map_err(|e| format!("write failed: {e}"))?;
    crate::git_snapshot::request_snapshot(&ws);
    Ok(name)
}

/// Attach explicit local file paths to the workspace. Used by drag-and-drop,
/// which hands us OS paths — the native-picker path is `add_files_to_workspace`.
/// See `attach_paths` for the in-place-vs-copy rule; dragging a workspace file
/// back into the composer references it in place instead of duplicating it.
pub fn add_paths_to_workspace(env: &Env, paths: Vec<String>) -> Result<Vec<String>, String> {
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
    let base = Path::new(&filename)
        .file_name()
        .ok_or("invalid file name")?
        .to_string_lossy()
        .to_string();
    let bytes = base64_decode(&base64)?;
    let ws = workspace_dir(env)?;
    let name = unique_name(&ws, &base);
    std::fs::write(ws.join(&name), bytes).map_err(|e| format!("write failed: {e}"))?;
    crate::git_snapshot::request_snapshot(&ws);
    Ok(name)
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
        exceeds_preview_cap, locate_under, mime_for, strip_windows_verbatim, unique_name,
        workspace_relative,
    };
    use std::path::{Path, PathBuf};

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

        assert_eq!(added, vec!["results/foo/deep.csv", "outside.csv", "taken-1.csv"]);
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
