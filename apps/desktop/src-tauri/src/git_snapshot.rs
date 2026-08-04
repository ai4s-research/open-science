use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::AppHandle;

use crate::runtime::quiet_command;

/// Serializes every snapshot commit process-wide. The frontend (on
/// `session.idle`) and several Rust record paths can all try to commit the same
/// workspace at once; without this they race on `.git/index.lock` and silently
/// drop snapshots. Workspaces are used one at a time, so a single global lock is
/// enough and each commit is quick.
fn git_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

const AUTHOR_NAME: &str = "Open Science Desktop";
const AUTHOR_EMAIL: &str = "open-science-desktop@local";

/// Snapshots commit to dedicated refs OUTSIDE `refs/heads/*`, never to any
/// branch — one chain PER user branch, keyed as `<prefix>/<branch>` (following
/// the `refs/wip/<branch>` convention of git-wip). `git log` / `git branch` /
/// `git status` never show them; we only add objects and move these refs, never
/// touching the user's branches, HEAD, working tree, or staging area. Inspect a
/// branch's history with `git log refs/openscience/snapshots/<branch>`.
const SNAPSHOT_REF_PREFIX: &str = "refs/openscience/snapshots";

/// The well-known SHA-1 of git's empty tree — used to skip the very first
/// snapshot of an empty workspace (nothing to record yet).
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// A dedicated index file (under `.git`) so staging for a snapshot never touches
/// the user's real index (`.git/index`) — their staged work is left intact.
/// Kept between snapshots so git's stat cache keeps `add -A` fast on large trees.
const SNAPSHOT_INDEX: &str = "openscience-index";

/// Files at or above this size are kept out of snapshots. Git stores every
/// version whole (binaries never delta or compress) and never reclaims the
/// space, and this app commits on *every* run — so the worst case is one large
/// file that changes each run: its history cost is roughly `runs * threshold`.
/// At 20 MB that caps the worst case near 2 GB per 100 runs, while still
/// versioning the outputs users actually want (plots, notebooks, typical CSVs,
/// small models — nearly all < 20 MB). Datasets, checkpoints, and media, which
/// belong in external storage anyway, are excluded. The guard is size-based,
/// not extension-based, so a small `.mp4` is kept and a huge `.csv` is not.
const MAX_BLOB_BYTES: u64 = 20 * 1024 * 1024;

/// The per-file guard above is blind to the other fatal bloat pattern: a dataset
/// of *thousands of small files* (copied-in images, audio clips, per-sample
/// `.json`/`.npy`), each under `MAX_BLOB_BYTES` yet enormous in aggregate. So we
/// also drop any single directory whose freshly-staged contents sum to at least
/// this much. Grouping is by immediate parent directory, so a bulky `data/`
/// never drags down a sibling source tree; a normal code directory (a few MB of
/// text) never trips it, while a copied dataset does. Format-agnostic, and a
/// companion to the media-extension ignores which handle the thin-spread case.
const MAX_DIR_BYTES: u64 = 50 * 1024 * 1024;

/// Default ignore rules planted when WE create a snapshot repo. A `.gitignore`
/// the user already placed in the workspace is left untouched.
///
/// Principle: this is a provenance tool, so we only exclude paths with *no*
/// reproducibility value (OS junk, editor scratch, dependency/env dirs, caches,
/// tooling debug logs) plus secrets that must never be committed. Research
/// outputs — data, figures, notebooks, models, code — are deliberately NOT
/// ignored; anything genuinely too big is caught by the >= 100 MB size guard,
/// which is format-agnostic (a small `.mp4` is kept, a huge `.csv` is not).
const DEFAULT_GITIGNORE: &str = "\
# Managed by Open Science Desktop.
# Excludes paths with no provenance value plus secrets that must never be
# committed. Research outputs, data, notebooks, and code are intentionally kept;
# files >= 100 MB are dropped by the snapshot size guard, not by this list.

# --- Secrets / credentials (API keys live in the OS keychain, never in git) ---
.env
.env.*
!.env.example
!.env.sample
!.env.template
*.pem
*.key
*.p12
*.pfx
id_rsa
id_dsa
id_ecdsa
id_ed25519
.netrc
credentials.json
secrets.json
service-account*.json
.aws/
.gcloud/

# --- macOS ---
.DS_Store
.DS_Store?
._*
.AppleDouble
.LSOverride
.Spotlight-V100
.Trashes

# --- Windows ---
Thumbs.db
ehthumbs.db
ehthumbs_vista.db
Desktop.ini
$RECYCLE.BIN/

# --- Linux ---
.fuse_hidden*
.Trash-*
.nfs*

# --- Editors / IDEs ---
.vscode/
.idea/
*.swp
*.swo
*.swn
.*.swp
*~
*.sublime-workspace

# --- Python ---
__pycache__/
*.py[cod]
*$py.class
.Python
.venv/
venv/
env/
ENV/
.eggs/
*.egg-info/
.pytest_cache/
.mypy_cache/
.dmypy.json
.pyre/
.pytype/
.ruff_cache/
.tox/
.nox/
.coverage
.coverage.*
htmlcov/
.hypothesis/
cython_debug/
.ipynb_checkpoints/

# --- Conda ---
.conda/

# --- R ---
.Rhistory
.RData
.Rproj.user/
.Ruserdata

# --- Node / JS ---
node_modules/
.npm/
.yarn/
.pnpm-store/
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*

# --- Temp / caches ---
*.tmp
*.temp
*.bak
.cache/
tmp/
.tmp/

# --- Bulk binary media (images / audio / video) ---
# These arrive in the thousands (a copied image or audio dataset) and each file
# is usually well under the 20 MB per-file size guard, so that guard can't stop
# them — thousands of small binaries would bloat history fatally, and git can
# neither delta nor compress them. They are also almost always either raw data
# or a regenerable render, not source. Text/vector figures (.svg) and documents
# (.pdf) are kept — they are small, versionable, and usually authored output.
# Notebook plots are embedded in the versioned .ipynb already. Delete a line
# below if that medium is your primary data and you want it in snapshots.
# Video
*.mp4
*.m4v
*.mov
*.avi
*.mkv
*.webm
*.wmv
*.flv
*.mpg
*.mpeg
*.ogv
*.3gp
# Images (raster)
*.jpg
*.jpeg
*.png
*.gif
*.bmp
*.tif
*.tiff
*.webp
*.heic
*.heif
*.ico
*.psd
*.raw
*.cr2
*.nef
*.arw
*.dng
# Audio
*.wav
*.flac
*.aac
*.m4a
*.mp3
*.ogg
*.oga
*.wma
*.aiff
*.aif
";

fn git(root: &Path) -> std::process::Command {
    let mut cmd = quiet_command("git");
    cmd.current_dir(root)
        .env("GIT_AUTHOR_NAME", AUTHOR_NAME)
        .env("GIT_AUTHOR_EMAIL", AUTHOR_EMAIL)
        .env("GIT_COMMITTER_NAME", AUTHOR_NAME)
        .env("GIT_COMMITTER_EMAIL", AUTHOR_EMAIL);
    cmd
}

pub fn git_available() -> bool {
    quiet_command("git")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn run(root: &Path, args: &[&str]) -> Result<(), String> {
    let out = git(root)
        .args(args)
        .output()
        .map_err(|e| format!("git {} failed to start: {e}", args.join(" ")))?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(format!(
        "git {} failed{}",
        args.join(" "),
        if stderr.is_empty() {
            String::new()
        } else {
            format!(": {stderr}")
        },
    ))
}

/// `git`, but pointed at the dedicated snapshot index so staging never touches
/// the user's real `.git/index`. All index-mutating snapshot steps (`add`,
/// `ls-files`, `update-index`, `write-tree`) go through this.
fn git_indexed(root: &Path, index: &Path) -> std::process::Command {
    let mut cmd = git(root);
    cmd.env("GIT_INDEX_FILE", index);
    cmd
}

/// `run`, but against the dedicated snapshot index.
fn run_indexed(root: &Path, index: &Path, args: &[&str]) -> Result<(), String> {
    let out = git_indexed(root, index)
        .args(args)
        .output()
        .map_err(|e| format!("git {} failed to start: {e}", args.join(" ")))?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(format!(
        "git {} failed{}",
        args.join(" "),
        if stderr.is_empty() {
            String::new()
        } else {
            format!(": {stderr}")
        },
    ))
}

/// `capture`, but against the dedicated snapshot index.
fn capture_indexed(root: &Path, index: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = git_indexed(root, index)
        .args(args)
        .output()
        .map_err(|e| format!("git {} failed to start: {e}", args.join(" ")))?;
    if out.status.success() {
        return Ok(out.stdout);
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(format!(
        "git {} failed{}",
        args.join(" "),
        if stderr.is_empty() {
            String::new()
        } else {
            format!(": {stderr}")
        },
    ))
}

/// The checked-out branch name, or `None` on a detached HEAD. Works on an unborn
/// branch (fresh `git init` before the first commit) — `HEAD` still symbolically
/// points at `refs/heads/<name>`.
fn current_branch(root: &Path) -> Option<String> {
    let out = git(root)
        .args(["symbolic-ref", "--quiet", "--short", "HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// Percent-encode `/` (and `%` first, to stay reversible) so a branch name
/// becomes a single flat ref component. This prevents a git directory/file ref
/// conflict when two branches share a prefix (e.g. `feature` and `feature/x`
/// would otherwise want both a `.../feature` ref AND a `.../feature/` dir).
fn encode_ref_component(name: &str) -> String {
    name.replace('%', "%25").replace('/', "%2F")
}

/// The snapshot ref for the workspace's current branch (one chain per branch).
/// A detached HEAD snapshots into a shared `_detached` bucket.
fn snapshot_ref(root: &Path) -> String {
    match current_branch(root) {
        Some(branch) => format!("{SNAPSHOT_REF_PREFIX}/{}", encode_ref_component(&branch)),
        None => format!("{SNAPSHOT_REF_PREFIX}/_detached"),
    }
}

/// Resolve `rev` to a commit/tree SHA, or `None` if it does not exist (an unborn
/// HEAD, or a ref not yet created). Never errors on a missing ref.
fn rev_parse(root: &Path, rev: &str) -> Option<String> {
    let out = git(root)
        .args(["rev-parse", "--verify", "--quiet", rev])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if sha.is_empty() {
        None
    } else {
        Some(sha)
    }
}

/// Like `run`, but returns captured stdout bytes on success.
fn capture(root: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = git(root)
        .args(args)
        .output()
        .map_err(|e| format!("git {} failed to start: {e}", args.join(" ")))?;
    if out.status.success() {
        return Ok(out.stdout);
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(format!(
        "git {} failed{}",
        args.join(" "),
        if stderr.is_empty() {
            String::new()
        } else {
            format!(": {stderr}")
        },
    ))
}

/// After staging into the snapshot index, drop any file at/over `MAX_BLOB_BYTES`
/// back out (keeping it on disk) so it never enters history. `update-index
/// --force-remove` deletes the index entry regardless of HEAD, so it works on
/// the dedicated index and an unborn branch alike; the file stays on disk and is
/// simply re-added and re-dropped on the next snapshot.
fn unstage_oversized(root: &Path, index: &Path) -> Result<(), String> {
    let stdout = capture_indexed(root, index, &["ls-files", "-z"])?;
    let mut skipped: Vec<String> = Vec::new();
    for name in stdout.split(|b| *b == 0) {
        if name.is_empty() {
            continue;
        }
        let rel = String::from_utf8_lossy(name).into_owned();
        if let Ok(meta) = std::fs::metadata(root.join(&rel)) {
            if meta.is_file() && meta.len() >= MAX_BLOB_BYTES {
                skipped.push(rel);
            }
        }
    }
    if skipped.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = vec!["update-index", "--force-remove", "--"];
    args.extend(skipped.iter().map(|s| s.as_str()));
    run_indexed(root, index, &args)?;
    eprintln!(
        "workspace snapshot: skipped {} file(s) >= {} MB: {}",
        skipped.len(),
        MAX_BLOB_BYTES / (1024 * 1024),
        skipped.join(", ")
    );
    Ok(())
}

/// Drop any directory whose staged files sum to >= `MAX_DIR_BYTES` back out of
/// the snapshot index (files stay on disk). Catches bulk data dumps — thousands
/// of small files that individually slip past `unstage_oversized`. Grouped by
/// immediate parent directory so one bulky folder can't take a sibling with it;
/// root-level files (no parent dir) are left alone since we would never drop the
/// whole workspace.
fn unstage_bulk_dirs(root: &Path, index: &Path) -> Result<(), String> {
    use std::collections::BTreeMap;
    let stdout = capture_indexed(root, index, &["ls-files", "-z"])?;
    let mut by_dir: BTreeMap<String, u64> = BTreeMap::new();
    let mut files_by_dir: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for name in stdout.split(|b| *b == 0) {
        if name.is_empty() {
            continue;
        }
        let rel = String::from_utf8_lossy(name).into_owned();
        // git always emits forward slashes here. No slash => file at repo root.
        let Some(idx) = rel.rfind('/') else { continue };
        let dir = rel[..idx].to_string();
        let size = std::fs::metadata(root.join(&rel))
            .map(|m| if m.is_file() { m.len() } else { 0 })
            .unwrap_or(0);
        *by_dir.entry(dir.clone()).or_insert(0) += size;
        files_by_dir.entry(dir).or_default().push(rel);
    }
    let bulky: Vec<(String, u64)> = by_dir
        .into_iter()
        .filter(|(_, bytes)| *bytes >= MAX_DIR_BYTES)
        .collect();
    if bulky.is_empty() {
        return Ok(());
    }
    // Remove the bulky dirs' files from the index by explicit path — a pathspec
    // (`dir/`) has no meaning to update-index, which works on tracked entries.
    for (dir, _) in &bulky {
        if let Some(files) = files_by_dir.get(dir) {
            let mut args: Vec<&str> = vec!["update-index", "--force-remove", "--"];
            args.extend(files.iter().map(|s| s.as_str()));
            run_indexed(root, index, &args)?;
        }
    }
    let summary = bulky
        .iter()
        .map(|(d, b)| format!("{d}/ ({} MB)", b / (1024 * 1024)))
        .collect::<Vec<_>>()
        .join(", ");
    eprintln!(
        "workspace snapshot: skipped {} bulk director{} (>= {} MB staged): {}",
        bulky.len(),
        if bulky.len() == 1 { "y" } else { "ies" },
        MAX_DIR_BYTES / (1024 * 1024),
        summary
    );
    Ok(())
}

/// Written inside `.git` the first time WE create a snapshot repo. Its presence
/// is how we recognize an app-managed repo that is safe to `add -A`/commit into;
/// we never touch a git repository the user brought into the workspace himself.
fn snapshot_marker(root: &Path) -> PathBuf {
    root.join(".git").join(".openscience-snapshots")
}

/// Written under a workspace's `.openscience/` to opt it out of app-managed
/// snapshots entirely — used for IMPORTED workspaces (a repo/folder the user
/// brought in) so the app never `git init`s or commits into it, even when the
/// folder isn't a git repo yet.
const NO_SNAPSHOT_MARKER: &str = ".no-snapshots";

fn no_snapshot_marker(root: &Path) -> PathBuf {
    root.join(".openscience").join(NO_SNAPSHOT_MARKER)
}

/// Prepare an IMPORTED (user-brought) workspace. Snapshots go to a dedicated ref
/// and never to the user's branches, so a real git repo IS snapshotted — we just
/// keep the app's `.openscience/` dir out of the user's `git status` via a local
/// `.git/info/exclude` (never their tracked `.gitignore`). A plain folder instead
/// gets an explicit opt-out marker so a later snapshot never `git init`s it (we
/// won't create a repo in a folder that isn't already one). Best-effort.
pub fn mark_imported(root: &Path) {
    if root.join(".git").is_dir() {
        exclude_locally(root, ".openscience/");
    } else {
        let osdir = root.join(".openscience");
        let _ = std::fs::create_dir_all(&osdir);
        let _ = std::fs::write(no_snapshot_marker(root), b"imported\n");
    }
}

/// Append a pattern to `.git/info/exclude` (a local, untracked ignore that does
/// not modify the user's committed `.gitignore`) unless already present.
fn exclude_locally(root: &Path, pattern: &str) {
    let exclude = root.join(".git").join("info").join("exclude");
    let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
    if existing.lines().any(|l| l.trim() == pattern) {
        return;
    }
    if let Some(parent) = exclude.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut content = existing;
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(pattern);
    content.push('\n');
    let _ = std::fs::write(&exclude, content);
}

/// Ensure a repo exists that we can store snapshots in. Returns `Ok(false)` only
/// for a workspace explicitly opted out (an imported plain folder). Because
/// snapshots go to a dedicated ref and a dedicated index — never a branch, HEAD,
/// or the user's index — it is safe to snapshot into a repo the user brought in,
/// so a pre-existing `.git` is accepted as-is (we never `git init` over it or
/// plant a `.gitignore` in it). A plain folder we manage is initialized.
fn ensure_snapshot_repo(root: &Path) -> Result<bool, String> {
    if !git_available() {
        return Err("git is not available".into());
    }
    // An imported plain folder opted out of snapshots entirely — never init it.
    if no_snapshot_marker(root).exists() {
        return Ok(false);
    }
    if root.join(".git").exists() {
        // App-created or user-brought — both are safe for a shadow-ref snapshot.
        return Ok(true);
    }
    run(root, &["init"])?;
    std::fs::write(snapshot_marker(root), b"1")
        .map_err(|e| format!("could not mark snapshot repo: {e}"))?;
    // Plant sensible ignores for our fresh repo, but never clobber a
    // .gitignore the workspace already contains.
    let gitignore = root.join(".gitignore");
    if !gitignore.exists() {
        std::fs::write(&gitignore, DEFAULT_GITIGNORE)
            .map_err(|e| format!("could not write .gitignore: {e}"))?;
    }
    Ok(true)
}

/// Normalize a workspace path for git: forward slashes to backslashes, and
/// strip any Windows `\\?\` verbatim prefix (drive or UNC form). A no-op on
/// Unix and on already-clean paths.
fn normalize_ws(root: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let s = root.to_string_lossy().replace('/', "\\");
        let s = if let Some(rest) = s.strip_prefix("\\\\?\\UNC\\") {
            format!("\\\\{rest}")
        } else if let Some(rest) = s.strip_prefix("\\\\?\\") {
            rest.to_string()
        } else {
            s
        };
        return PathBuf::from(s);
    }
    #[cfg(not(windows))]
    {
        root.to_path_buf()
    }
}

/// Record a snapshot of the workspace onto `SNAPSHOT_REF` without touching the
/// user's branches, HEAD, working tree, or index. Stages the working tree into a
/// dedicated index, drops oversized/bulk paths, writes a tree, and commits it as
/// a child of the previous snapshot via plumbing (`commit-tree` + `update-ref`).
/// Returns `Ok(true)` when a new snapshot was recorded, `Ok(false)` when there
/// was nothing to record or the workspace opted out.
pub fn commit(root: &Path, message: &str) -> Result<bool, String> {
    let _lock = git_lock().lock().map_err(|_| "git snapshot lock poisoned".to_string())?;
    // Windows: workspace paths arriving from the webview can carry a `\\?\`
    // verbatim prefix with forward slashes (e.g. `\\?\C:/Users/...`). Git's
    // mingw layer then fails to create its lock files with "Invalid argument"
    // (CreateFile rejects forward slashes inside `\\?\` extended-length
    // paths). Normalize to a plain backslash path before any git call.
    let root = &normalize_ws(root);
    if !ensure_snapshot_repo(&root)? {
        return Ok(false);
    }
    let index = root.join(".git").join(SNAPSHOT_INDEX);
    let sref = snapshot_ref(root);

    // Stage the whole working tree into the DEDICATED index (never the user's).
    run_indexed(root, &index, &["add", "-A", "--", "."])?;
    unstage_oversized(root, &index)?;
    unstage_bulk_dirs(root, &index)?;
    let tree = String::from_utf8_lossy(&capture_indexed(root, &index, &["write-tree"])?)
        .trim()
        .to_string();

    // Parent: continue this branch's snapshot chain if it exists; otherwise root
    // the first snapshot on the branch's current tip (HEAD) so the history reads
    // continuously with the user's real commits and diffs are meaningful; on an
    // unborn branch there is no parent. HEAD is only READ here, never moved.
    let parent = rev_parse(root, &sref).or_else(|| rev_parse(root, "HEAD"));

    // Nothing to record if the tree is unchanged from the parent (or is the
    // empty tree on a brand-new, empty workspace).
    let unchanged = match &parent {
        Some(p) => rev_parse(root, &format!("{p}^{{tree}}")).as_deref() == Some(tree.as_str()),
        None => tree == EMPTY_TREE,
    };
    if unchanged {
        return Ok(false);
    }

    // Build the commit object off the parent and advance the per-branch ref.
    // No branch, HEAD, or working-tree update happens anywhere here.
    let mut args: Vec<String> = vec!["commit-tree".into(), tree, "-m".into(), message.into()];
    if let Some(p) = &parent {
        args.push("-p".into());
        args.push(p.clone());
    }
    let argrefs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let commit_sha = String::from_utf8_lossy(&capture(root, &argrefs)?)
        .trim()
        .to_string();
    run(root, &["update-ref", &sref, &commit_sha])?;
    Ok(true)
}

pub fn commit_best_effort(root: &Path, message: &str) {
    if let Err(e) = commit(root, message) {
        eprintln!("workspace git snapshot skipped: {e}");
    }
}

// ---------------------------------------------------------------------------
// Debounced background snapshotter
//
// Committing inline on every file add ran git (a subprocess) on the UI thread
// and produced one commit per file — a directory added file-by-file became
// dozens of commits in seconds and froze the window (issue #32). Instead,
// callers and the workspace watcher *request* a snapshot; a single background
// thread coalesces requests and commits at most once per quiet window, off the
// main thread.
// ---------------------------------------------------------------------------

/// Trailing quiet window: commit this long after the LAST change so a burst of
/// writes coalesces into one snapshot. Comfortably longer than the ~1 s spacing
/// seen when an agent adds a directory file-by-file, so those collapse to one.
const SNAPSHOT_DEBOUNCE: Duration = Duration::from_secs(3);

/// Starvation cap: while changes keep arriving, commit at least this often so a
/// long-running writer (a detached job appending logs) still leaves periodic
/// snapshots instead of none until it stops.
const SNAPSHOT_MAX_WAIT: Duration = Duration::from_secs(30);

/// A root with a pending snapshot: when its first and most-recent requests came.
#[derive(Clone, Copy)]
struct PendingSnapshot {
    first: Instant,
    last: Instant,
}

/// Whether a pending snapshot is due: the quiet window elapsed since the last
/// request (debounce), or the max wait elapsed since the first (starvation cap).
/// Pure, so the timing policy is unit-testable without threads or real sleeps.
fn snapshot_due(since_last: Duration, since_first: Duration) -> bool {
    since_last >= SNAPSHOT_DEBOUNCE || since_first >= SNAPSHOT_MAX_WAIT
}

fn snapshot_tx() -> &'static Sender<PathBuf> {
    static TX: OnceLock<Sender<PathBuf>> = OnceLock::new();
    TX.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<PathBuf>();
        if let Err(e) = std::thread::Builder::new()
            .name("git-snapshot".into())
            .spawn(move || snapshot_loop(rx))
        {
            eprintln!("workspace snapshot: could not start snapshot thread: {e}");
        }
        tx
    })
}

/// Request a debounced snapshot of `root`. Returns immediately; the commit runs
/// on the background snapshot thread after the quiet window. Safe to call from
/// the UI thread and from the filesystem-watcher callback.
pub fn request_snapshot(root: &Path) {
    let _ = snapshot_tx().send(root.to_path_buf());
}

fn snapshot_loop(rx: Receiver<PathBuf>) {
    let mut pending: HashMap<PathBuf, PendingSnapshot> = HashMap::new();
    loop {
        // Wait until the nearest deadline, or indefinitely when nothing pends.
        let timeout = pending
            .values()
            .map(|p| {
                let by_debounce = SNAPSHOT_DEBOUNCE.saturating_sub(p.last.elapsed());
                let by_max = SNAPSHOT_MAX_WAIT.saturating_sub(p.first.elapsed());
                by_debounce.min(by_max)
            })
            .min()
            .unwrap_or(Duration::from_secs(3600));
        match rx.recv_timeout(timeout) {
            Ok(root) => {
                let now = Instant::now();
                pending
                    .entry(root)
                    .and_modify(|p| p.last = now)
                    .or_insert(PendingSnapshot { first: now, last: now });
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        let due: Vec<PathBuf> = pending
            .iter()
            .filter(|(_, p)| snapshot_due(p.last.elapsed(), p.first.elapsed()))
            .map(|(root, _)| root.clone())
            .collect();
        for root in due {
            pending.remove(&root);
            commit_best_effort(&root, "Snapshot workspace changes");
        }
    }
}

// ---------------------------------------------------------------------------
// Workspace filesystem watcher
//
// Explicit call sites (file adds, session-idle) cannot see every change — a
// user editing a file in an external editor, or a process the agent detached
// that writes output after the turn ended, bypasses all of them. So we also
// watch the active workspace and enqueue a debounced snapshot on any change,
// ignoring writes under `.git/` (our own commits) to avoid a feedback loop.
// ---------------------------------------------------------------------------

#[allow(clippy::type_complexity)]
fn workspace_watcher() -> &'static Mutex<Option<(RecommendedWatcher, PathBuf)>> {
    static W: OnceLock<Mutex<Option<(RecommendedWatcher, PathBuf)>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(None))
}

/// Watch `root` recursively and enqueue debounced snapshots on change, replacing
/// any previous watch. Best-effort: a watcher that fails to start just means
/// snapshots fall back to the explicit call sites. Call on startup and whenever
/// the active workspace changes.
pub fn watch_workspace(root: &Path) {
    let Ok(mut slot) = workspace_watcher().lock() else {
        return;
    };
    if slot.as_ref().is_some_and(|(_, cur)| cur == root) {
        return; // already watching this root
    }
    let cb_root = root.to_path_buf();
    let handler = move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        // Access (read/open) events never change content — ignore them.
        if matches!(event.kind, EventKind::Access(_)) {
            return;
        }
        // Ignore our own git writes; committing must not retrigger a snapshot.
        let under_git = event
            .paths
            .iter()
            .any(|p| p.components().any(|c| c.as_os_str() == ".git"));
        if under_git {
            return;
        }
        request_snapshot(&cb_root);
    };
    let mut watcher = match notify::recommended_watcher(handler) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("workspace watcher: could not create: {e}");
            return;
        }
    };
    if let Err(e) = watcher.watch(root, RecursiveMode::Recursive) {
        eprintln!("workspace watcher: could not watch {}: {e}", root.display());
        return;
    }
    // Hold the watcher alive in the slot; dropping the old one stops its watch.
    *slot = Some((watcher, root.to_path_buf()));
}

#[tauri::command(async)]
pub fn commit_workspace_snapshot(app: AppHandle, message: String) -> Result<bool, String> {
    let root = crate::runtime::workspace_dir(&app)?;
    commit(&root, &message)
}

#[cfg(test)]
mod tests {
    use super::{
        commit, current_branch, git_available, rev_parse, snapshot_due, snapshot_ref,
        SNAPSHOT_DEBOUNCE, SNAPSHOT_MAX_WAIT,
    };
    use std::fs;
    use std::time::Duration;

    /// Files recorded in the current branch's latest snapshot (its ref's tree).
    fn snapshot_files(root: &std::path::Path) -> String {
        let sref = snapshot_ref(root);
        let out = super::capture(root, &["ls-tree", "-r", "--name-only", &sref]).unwrap();
        String::from_utf8_lossy(&out).into_owned()
    }

    #[test]
    fn snapshot_due_debounces_bursts_but_caps_at_max_wait() {
        // Still within the quiet window since the last change → hold (coalesce).
        assert!(!snapshot_due(Duration::from_millis(500), Duration::from_secs(2)));
        // Quiet window elapsed since the last change → fire (debounce).
        assert!(snapshot_due(SNAPSHOT_DEBOUNCE, Duration::from_secs(5)));
        // Changes still arriving, but the max wait elapsed → fire (no starvation).
        assert!(snapshot_due(Duration::from_millis(100), SNAPSHOT_MAX_WAIT));
    }

    #[test]
    fn commit_initializes_repo_and_skips_clean_tree() {
        if !git_available() {
            eprintln!("git unavailable; skipping git snapshot test");
            return;
        }
        let root = std::env::temp_dir().join(format!("os-git-snapshot-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("AGENTS.md"), "rules\n").unwrap();

        assert_eq!(commit(&root, "Initialize workspace").unwrap(), true);
        assert!(root.join(".git").is_dir());
        // The snapshot lives on the dedicated per-branch ref, and NO branch
        // commit was made (HEAD is still unborn) — snapshots never touch a branch.
        assert!(rev_parse(&root, &snapshot_ref(&root)).is_some());
        assert!(rev_parse(&root, "HEAD").is_none());
        assert_eq!(commit(&root, "No changes").unwrap(), false);

        fs::write(root.join("AGENTS.md"), "rules\nmore\n").unwrap();
        assert_eq!(commit(&root, "Update workspace").unwrap(), true);
        assert!(snapshot_files(&root).contains("AGENTS.md"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn commit_skips_oversized_files_but_keeps_them_on_disk() {
        if !git_available() {
            eprintln!("git unavailable; skipping git snapshot test");
            return;
        }
        let root = std::env::temp_dir().join(format!("os-git-big-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("small.txt"), "keep me\n").unwrap();
        fs::write(root.join("big.bin"), vec![0u8; super::MAX_BLOB_BYTES as usize]).unwrap();

        // The small file is snapshotted; the oversized one is not.
        assert_eq!(commit(&root, "Initialize workspace").unwrap(), true);
        let tracked = snapshot_files(&root);
        assert!(tracked.contains("small.txt"));
        assert!(!tracked.contains("big.bin"));
        // But the big file is left untouched on disk.
        assert!(root.join("big.bin").is_file());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn commit_skips_bulk_directory_of_small_files() {
        if !git_available() {
            eprintln!("git unavailable; skipping git snapshot test");
            return;
        }
        let root = std::env::temp_dir().join(format!("os-git-bulk-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("dataset")).unwrap();
        // A source file at root that must survive.
        fs::write(root.join("train.py"), "print('hi')\n").unwrap();
        // Four 15 MB files: each is under the 20 MB per-file guard, but together
        // the directory is 60 MB, over the 50 MB directory guard.
        let chunk = vec![0u8; 15 * 1024 * 1024];
        for i in 0..4 {
            fs::write(root.join("dataset").join(format!("sample_{i}.dat")), &chunk).unwrap();
        }

        assert_eq!(commit(&root, "Initialize workspace").unwrap(), true);
        let tracked = snapshot_files(&root);
        assert!(tracked.contains("train.py"));
        assert!(!tracked.contains("dataset/"));
        // Files are only dropped from the snapshot, never removed from disk.
        assert!(root.join("dataset").join("sample_0.dat").is_file());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn commit_writes_default_gitignore_on_fresh_repo() {
        if !git_available() {
            eprintln!("git unavailable; skipping git snapshot test");
            return;
        }
        let root = std::env::temp_dir().join(format!("os-git-ignore-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("AGENTS.md"), "rules\n").unwrap();

        assert_eq!(commit(&root, "Initialize workspace").unwrap(), true);
        let gitignore = fs::read_to_string(root.join(".gitignore")).unwrap();
        assert!(gitignore.contains("node_modules/"));
        assert!(gitignore.contains(".env"));
        assert!(gitignore.contains("*.mp4"));
        assert!(gitignore.contains("*.png"));
        assert!(gitignore.contains("*.wav"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn snapshots_a_user_repo_without_touching_their_branch_or_index() {
        if !git_available() {
            eprintln!("git unavailable; skipping git snapshot test");
            return;
        }
        let root = std::env::temp_dir().join(format!("os-git-foreign-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        // A repo the user brought in, with their own committed history…
        super::run(&root, &["init"]).unwrap();
        fs::write(root.join("data.txt"), "user work\n").unwrap();
        super::run(&root, &["add", "data.txt"]).unwrap();
        super::run(&root, &["commit", "-m", "user commit"]).unwrap();
        let head_before = rev_parse(&root, "HEAD").unwrap();
        // …and a staged-but-uncommitted change sitting in their index.
        fs::write(root.join("staged.txt"), "in progress\n").unwrap();
        super::run(&root, &["add", "staged.txt"]).unwrap();

        // We DO snapshot it now — to the dedicated per-branch ref, not their branch.
        assert_eq!(commit(&root, "snapshot").unwrap(), true);
        assert!(rev_parse(&root, &snapshot_ref(&root)).is_some());
        assert!(snapshot_files(&root).contains("data.txt"));

        // Their branch/HEAD is byte-for-byte unchanged…
        assert_eq!(rev_parse(&root, "HEAD").unwrap(), head_before);
        // …and their staged work is left exactly as it was (still staged).
        let staged = super::capture(&root, &["diff", "--cached", "--name-only"]).unwrap();
        assert!(String::from_utf8_lossy(&staged).contains("staged.txt"));
        // We planted no marker in a repo we did not create.
        assert!(!super::snapshot_marker(&root).exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn imported_plain_folder_is_never_initialized_or_committed() {
        if !git_available() {
            eprintln!("git unavailable; skipping git snapshot test");
            return;
        }
        let root = std::env::temp_dir().join(format!("os-git-imported-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("notes.md"), "brought-in work\n").unwrap();

        // Importing a plain (non-repo) folder opts it out of snapshots.
        super::mark_imported(&root);
        assert!(super::no_snapshot_marker(&root).exists());

        // A later commit must NOT `git init` it and must NOT commit.
        assert_eq!(commit(&root, "should be skipped").unwrap(), false);
        assert!(!root.join(".git").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn importing_a_repo_keeps_it_pristine_and_excludes_the_provenance_dir() {
        if !git_available() {
            eprintln!("git unavailable; skipping git snapshot test");
            return;
        }
        let root = std::env::temp_dir().join(format!("os-git-imported-repo-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        super::run(&root, &["init"]).unwrap();
        fs::write(root.join("paper.md"), "user content\n").unwrap();

        super::mark_imported(&root);
        // A real repo isn't given the opt-out marker but gets a LOCAL exclude for
        // .openscience/ so our provenance dir never shows in the user's status.
        assert!(!super::no_snapshot_marker(&root).exists());
        let exclude = fs::read_to_string(root.join(".git/info/exclude")).unwrap();
        assert!(exclude.lines().any(|l| l.trim() == ".openscience/"));

        // It IS snapshotted (to the dedicated per-branch ref), while the user's
        // branch stays untouched (HEAD unborn — we never committed to a branch).
        assert_eq!(commit(&root, "snapshot").unwrap(), true);
        assert!(rev_parse(&root, &snapshot_ref(&root)).is_some());
        assert!(rev_parse(&root, "HEAD").is_none());
        assert!(snapshot_files(&root).contains("paper.md"));

        // mark_imported stays idempotent (no duplicate exclude line).
        super::mark_imported(&root);
        let count = fs::read_to_string(root.join(".git/info/exclude"))
            .unwrap()
            .lines()
            .filter(|l| l.trim() == ".openscience/")
            .count();
        assert_eq!(count, 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn snapshots_are_tracked_per_branch() {
        if !git_available() {
            eprintln!("git unavailable; skipping git snapshot test");
            return;
        }
        let root = std::env::temp_dir().join(format!("os-git-perbranch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        super::run(&root, &["init"]).unwrap();
        // A base commit, then a working change so there is something to snapshot.
        fs::write(root.join("a.txt"), "base\n").unwrap();
        super::run(&root, &["add", "a.txt"]).unwrap();
        super::run(&root, &["commit", "-m", "base"]).unwrap();
        fs::write(root.join("a.txt"), "base + wip\n").unwrap();

        assert_eq!(commit(&root, "snap on base branch").unwrap(), true);
        let base_ref = snapshot_ref(&root);
        assert!(rev_parse(&root, &base_ref).is_some());

        // Switch to a slashy branch — its snapshots go to a SEPARATE, encoded ref
        // (no directory/file ref conflict with the base branch's ref).
        super::run(&root, &["checkout", "-q", "-b", "feature/x"]).unwrap();
        let feat_ref = snapshot_ref(&root);
        assert!(feat_ref.ends_with("/feature%2Fx"));
        assert_ne!(base_ref, feat_ref);
        assert!(rev_parse(&root, &feat_ref).is_none()); // nothing snapped here yet

        fs::write(root.join("b.txt"), "feature work\n").unwrap();
        assert_eq!(commit(&root, "snap on feature branch").unwrap(), true);
        // Both chains exist and are distinct; the base branch's ref is untouched.
        assert!(rev_parse(&root, &feat_ref).is_some());
        assert_ne!(rev_parse(&root, &base_ref), rev_parse(&root, &feat_ref));
        assert_eq!(current_branch(&root).as_deref(), Some("feature/x"));
        let _ = fs::remove_dir_all(&root);
    }
}
