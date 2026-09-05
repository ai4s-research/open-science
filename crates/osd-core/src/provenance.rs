// Artifact provenance (P0-3): every agent write of a workspace file appends a
// version record to <workspace>/.openscience/provenance.jsonl — append-only,
// one JSON object per line, so any artifact can reveal its generating code,
// environment, and originating conversation, per version.
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::env::Env;
use crate::runtime::workspace_dir;

const STORE_DIR: &str = ".openscience";
const STORE_FILE: &str = "provenance.jsonl";
/// Per-record content cap: keeps the store bounded; larger writes are truncated.
const CONTENT_CAP: usize = 100_000;

/// Serializes appends so two tool events can't interleave lines or race versions.
#[derive(Default)]
pub struct ProvenanceState(pub Mutex<()>);

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvenanceRecord {
    /// Workspace-relative artifact path with `/` separators.
    pub path: String,
    /// 1-based version, assigned on append.
    pub version: u32,
    /// Seconds since the epoch (the frontend formats it).
    pub ts: u64,
    /// Tool that produced this version, e.g. "write".
    pub tool: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Text the tool wrote (capped); absent for binary or indirect writes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// Unified diff of an incremental edit (capped); the lineage of a change
    /// when the full file text wasn't in the event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log: Option<String>,
    /// Runtime environment captured when the version was recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<EnvInfo>,
    /// The run that produced this version, when it came from executing code
    /// (not an authored write). Links the file to its reproducibility recipe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

/// The environment a version was produced in — enough to reproduce: which
/// Python, which OS/arch, which app build, and which installed packages.
/// Captured once per app run (cheap).
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvInfo {
    /// Local Python version, e.g. "3.12.4" (the interpreter agent code runs on).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub python: Option<String>,
    /// OS and architecture, e.g. "macos-aarch64".
    pub platform: String,
    /// Open Science app version that recorded this.
    pub app: String,
    /// Installed Python packages (pip freeze), content-addressed to a lockfile.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub packages: Option<PackageSnapshot>,
    /// Hardware the code executed on — the part software can't otherwise pin.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hardware: Option<HardwareInfo>,
}

/// The silicon a run executed on. Every field is best-effort ("record what we
/// can"): a probe that isn't installed or fails just leaves its field absent.
/// Captured once per app run (cheap; hardware doesn't change mid-session).
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cores: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mem_gb: Option<u32>,
    /// GPU model(s); empty when none detected.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub gpu: Vec<String>,
    /// Available accelerator: "cuda" | "mps" | "cpu".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accelerator: Option<String>,
}

/// A snapshot of the installed Python packages at record time. The full
/// `name==version` list is stored once, content-addressed, at
/// `.openscience/env/<hash>.txt`; records carry only the count + hash so the
/// store stays small and identical environments dedupe to one lockfile.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageSnapshot {
    /// Number of installed packages captured.
    pub count: u32,
    /// Short content hash; the lockfile is `.openscience/env/<hash>.txt`.
    pub hash: String,
}

const ENV_DIR: &str = "env";

/// Memoize a per-interpreter shell probe: the first call for a given interpreter
/// path spawns a process (seconds); later records reusing the same interpreter
/// hit the cache, so a per-write spawn never slows agent edits. Keyed by
/// interpreter path so a venv run and the app default don't share a result.
fn cached_probe(
    cache: &Mutex<HashMap<String, Option<String>>>,
    interpreter: &str,
    compute: impl FnOnce() -> Option<String>,
) -> Option<String> {
    if let Ok(m) = cache.lock() {
        if let Some(v) = m.get(interpreter) {
            return v.clone();
        }
    }
    let v = compute();
    if let Ok(mut m) = cache.lock() {
        m.insert(interpreter.to_string(), v.clone());
    }
    v
}

/// Capture `pip freeze` for a specific interpreter (the venv/interpreter the run
/// actually used, not always the app default). Returns the raw `name==version`
/// list. Cached per interpreter path.
fn pip_freeze(interpreter: &str) -> Option<String> {
    static CACHE: std::sync::OnceLock<Mutex<HashMap<String, Option<String>>>> = std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(Mutex::default);
    cached_probe(cache, interpreter, || {
        let out = crate::runtime::quiet_command(interpreter)
            .args(["-m", "pip", "freeze"])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    })
}

/// Detect hardware once per app run by shelling out to the OS's own tools —
/// `nvidia-smi` for NVIDIA GPUs, `sysctl`/`/proc` for CPU/RAM. Best-effort:
/// any probe that isn't present just leaves its field empty.
pub fn hardware_info() -> HardwareInfo {
    static CACHE: std::sync::OnceLock<HardwareInfo> = std::sync::OnceLock::new();
    CACHE.get_or_init(probe_hardware).clone()
}

fn probe_hardware() -> HardwareInfo {
    let cores = std::thread::available_parallelism().ok().map(|n| n.get() as u32);
    let (cpu, mem_gb) = probe_cpu_mem();
    let gpu = probe_nvidia_gpus();
    let accelerator = if !gpu.is_empty() {
        Some("cuda".to_string())
    } else if std::env::consts::OS == "macos" && std::env::consts::ARCH == "aarch64" {
        Some("mps".to_string()) // Apple Silicon: Metal Performance Shaders
    } else {
        Some("cpu".to_string())
    };
    HardwareInfo { cpu, cores, mem_gb, gpu, accelerator }
}

/// CPU brand + total RAM (GB). macOS via `sysctl`, Linux via `/proc`.
fn probe_cpu_mem() -> (Option<String>, Option<u32>) {
    if std::env::consts::OS == "macos" {
        let sysctl = |key: &str| {
            crate::runtime::quiet_command("sysctl")
                .args(["-n", key])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        };
        let cpu = sysctl("machdep.cpu.brand_string").filter(|s| !s.is_empty());
        let mem_gb = sysctl("hw.memsize")
            .and_then(|s| s.parse::<u64>().ok())
            .map(|b| (b / 1_073_741_824) as u32);
        (cpu, mem_gb)
    } else if std::env::consts::OS == "linux" {
        let cpu = std::fs::read_to_string("/proc/cpuinfo").ok().and_then(|t| {
            t.lines()
                .find(|l| l.starts_with("model name"))
                .and_then(|l| l.split(':').nth(1))
                .map(|s| s.trim().to_string())
        });
        let mem_gb = std::fs::read_to_string("/proc/meminfo").ok().and_then(|t| {
            t.lines()
                .find(|l| l.starts_with("MemTotal"))
                .and_then(|l| l.split_whitespace().nth(1))
                .and_then(|kb| kb.parse::<u64>().ok())
                .map(|kb| (kb / 1_048_576) as u32) // kB -> GB
        });
        (cpu, mem_gb)
    } else {
        (None, None)
    }
}

/// NVIDIA GPU model names via `nvidia-smi`; empty if the tool is absent.
fn probe_nvidia_gpus() -> Vec<String> {
    crate::runtime::quiet_command("nvidia-smi")
        .args(["--query-gpu=name", "--format=csv,noheader"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// A short, deterministic content hash for lockfile addressing. DefaultHasher
/// uses fixed keys, so the same freeze maps to the same file across runs.
pub fn content_hash(text: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// Write `freeze` to a content-addressed lockfile (once) and return its snapshot.
fn write_lockfile(root: &Path, freeze: &str) -> Result<PackageSnapshot, String> {
    let count = freeze.lines().filter(|l| !l.trim().is_empty()).count() as u32;
    let hash = content_hash(freeze);
    let dir = root.join(STORE_DIR).join(ENV_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{hash}.txt"));
    if !path.exists() {
        std::fs::write(&path, freeze).map_err(|e| e.to_string())?;
    }
    Ok(PackageSnapshot { count, hash })
}

/// Detect a specific interpreter's Python version (`<interp> --version`).
/// Cached per interpreter path, so repeated records don't re-spawn.
fn python_version(interpreter: &str) -> Option<String> {
    static CACHE: std::sync::OnceLock<Mutex<HashMap<String, Option<String>>>> = std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(Mutex::default);
    cached_probe(cache, interpreter, || {
        let out = crate::runtime::quiet_command(interpreter).arg("--version").output().ok()?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let text = if text.is_empty() {
            String::from_utf8_lossy(&out.stderr).trim().to_string() // Python 2 printed -V to stderr
        } else {
            text
        };
        Some(text.strip_prefix("Python ").unwrap_or(&text).to_string())
    })
}

/// Capture the runtime environment for a record. When `command` names an
/// explicit Python interpreter by path (a project venv, e.g.
/// `.venv/bin/python train.py` or `C:\proj\.venv\Scripts\python.exe -c …`), the
/// env snapshot is taken from THAT interpreter — its version and its packages —
/// so a venv run's provenance isn't silently stamped with the app default
/// Python. If the command names an explicit interpreter that is MISSING on disk
/// (the run failed to launch), no Python env is attributed — falling back to the
/// app default there would be semantically misleading (see issue #23). A bare
/// `python` (or a non-run write, `command == None`) falls back to the app
/// default interpreter.
/// `default_python` is the interpreter to attribute when the command names none
/// — a parameter rather than a lookup because resolving it is the desktop's job
/// (it owns the kernel and the user's chosen interpreter); a headless run that
/// cannot resolve one attributes no Python env, which is honest.
pub fn capture_env(
    root: &Path,
    app_version: String,
    command: Option<&str>,
    default_python: Option<String>,
) -> EnvInfo {
    let interpreter = match command.and_then(|c| interpreter_from_command(c, root)) {
        // An explicit path-form interpreter that exists — snapshot THIS one.
        Some(RunInterpreter::Explicit(p)) => Some(p.to_string_lossy().into_owned()),
        // An explicit interpreter was named but is missing: the run could not
        // have used the app default, so attribute no Python env (not the default).
        Some(RunInterpreter::Missing) => None,
        // No explicit interpreter (bare `python`, non-Python, or a write): the
        // app default is the right, non-misleading fallback.
        None => default_python,
    };

    let (python, packages) = match interpreter {
        // Package capture is best-effort: no pip / write failure just omits it.
        Some(interp) => (
            python_version(&interp),
            pip_freeze(&interp).and_then(|f| write_lockfile(root, &f).ok()),
        ),
        None => (None, None),
    };
    EnvInfo {
        python,
        platform: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
        app: app_version,
        packages,
        hardware: Some(hardware_info()),
    }
}

/// The Python interpreter a run used, derived from its command's head.
enum RunInterpreter {
    /// An explicit path-form interpreter that exists on disk — snapshot this one.
    Explicit(PathBuf),
    /// An explicit path-form interpreter was named but does not exist, so the run
    /// could not have used the app default Python.
    Missing,
}

/// Classify the Python interpreter named at a command's head — e.g.
/// `C:\proj\.venv\Scripts\python.exe` or `/proj/.venv/bin/python`. Returns:
/// - `None` — no explicit path-form `python*` head (bare `python`, resolved via
///   PATH, or a non-Python command): the caller uses the app default.
/// - `Some(Explicit(path))` — a path-form `python*` that resolves to a real file.
/// - `Some(Missing)` — a path-form `python*` head that does not exist on disk.
///
/// Extraction is best-effort and only inspects each segment's head token.
fn interpreter_from_command(command: &str, root: &Path) -> Option<RunInterpreter> {
    for raw in command
        .split('\n')
        .flat_map(|s| s.split("&&"))
        .flat_map(|s| s.split(';'))
        .flat_map(|s| s.split('|'))
    {
        let head = strip_seg_prefixes(raw);
        let token = first_token(&head);
        if token.is_empty() {
            continue;
        }
        let base = token.rsplit(['/', '\\']).next().unwrap_or(&token);
        let stem = base
            .strip_suffix(".exe")
            .or_else(|| base.strip_suffix(".EXE"))
            .unwrap_or(base);
        let is_path_form = token.contains('/') || token.contains('\\');
        if is_path_form && stem.starts_with("python") {
            let p = Path::new(&token);
            let resolved = if p.is_absolute() { p.to_path_buf() } else { root.join(p) };
            return Some(if resolved.is_file() {
                RunInterpreter::Explicit(resolved)
            } else {
                RunInterpreter::Missing
            });
        }
    }
    None
}

/// Strip leading `VAR=val` env assignments and a PowerShell `&` call operator
/// from a command segment, exposing the operative command (`cd` hops are already
/// split off as their own segments). Mirrors the frontend's `stripPrefixes`.
fn strip_seg_prefixes(seg: &str) -> String {
    let mut s = seg.trim();
    loop {
        // PowerShell call operator: `& C:\proj\.venv\Scripts\python.exe`.
        if let Some(rest) = s.strip_prefix('&') {
            let rest = rest.trim_start();
            if rest.len() != s.len() {
                s = rest;
                continue;
            }
        }
        if let Some(rest) = strip_env_assignment(s) {
            s = rest;
            continue;
        }
        break;
    }
    s.trim().to_string()
}

/// If `s` starts with a `VAR=value` env assignment followed by more command,
/// return the remainder after it; else None. (Quoted values with spaces aren't
/// handled — that just falls back to the default interpreter.)
fn strip_env_assignment(s: &str) -> Option<&str> {
    let bytes = s.as_bytes();
    let mut i = 0;
    if bytes.first().is_none_or(|b| !(b.is_ascii_alphabetic() || *b == b'_')) {
        return None;
    }
    while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
        i += 1;
    }
    if i >= bytes.len() || bytes[i] != b'=' {
        return None;
    }
    let mut j = i + 1;
    while j < bytes.len() && !bytes[j].is_ascii_whitespace() {
        j += 1;
    }
    if j >= bytes.len() {
        return None; // no command follows — not a prefix
    }
    Some(s[j..].trim_start())
}

/// The first shell token of a segment, honoring a leading quoted path (so a
/// Windows path with spaces, `"C:\Program Files\Py\python.exe"`, stays intact).
fn first_token(s: &str) -> String {
    let s = s.trim_start();
    for quote in ['"', '\''] {
        if let Some(after) = s.strip_prefix(quote) {
            if let Some(end) = after.find(quote) {
                return after[..end].to_string();
            }
        }
    }
    s.split_whitespace().next().unwrap_or("").to_string()
}

/// Normalize an artifact path (absolute or relative, from tool input) to a
/// workspace-relative `/`-separated key. Paths escaping the workspace are rejected.
fn normalize_rel(root: &Path, path: &str) -> Result<String, String> {
    let p = Path::new(path);
    let rel: PathBuf = if p.is_absolute() {
        let stripped = match (p.canonicalize(), root.canonicalize()) {
            // Prefer canonical forms (resolves /var vs /private/var on macOS)…
            (Ok(full), Ok(root_c)) => full.strip_prefix(&root_c).map(Path::to_path_buf),
            // …but the file may not exist yet — fall back to a lexical strip.
            _ => p.strip_prefix(root).map(Path::to_path_buf),
        };
        stripped.map_err(|_| "path is outside the workspace".to_string())?
    } else {
        p.to_path_buf()
    };
    if rel.as_os_str().is_empty()
        || rel.components().any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("path must stay inside the workspace".into());
    }
    Ok(rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/"))
}

fn store_file(root: &Path) -> PathBuf {
    root.join(STORE_DIR).join(STORE_FILE)
}

/// All records in the store. Unparseable lines are skipped, never fatal — the
/// store must survive a corrupt line without losing the rest of the history.
fn read_all(file: &Path) -> Vec<ProvenanceRecord> {
    let Ok(text) = std::fs::read_to_string(file) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

fn cap_content(mut c: String) -> String {
    if c.len() > CONTENT_CAP {
        let mut end = CONTENT_CAP;
        while !c.is_char_boundary(end) {
            end -= 1;
        }
        c.truncate(end);
        c.push_str("\n… [truncated]");
    }
    c
}

/// Append one version record for `path`, assigning the next version number.
#[allow(clippy::too_many_arguments)]
pub fn append_record(
    root: &Path,
    path: &str,
    tool: &str,
    session_id: Option<String>,
    model: Option<String>,
    content: Option<String>,
    diff: Option<String>,
    log: Option<String>,
    env: Option<EnvInfo>,
    run_id: Option<String>,
) -> Result<ProvenanceRecord, String> {
    let rel = normalize_rel(root, path)?;
    let file = store_file(root);
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("provenance dir failed: {e}"))?;
    }
    let version = read_all(&file)
        .iter()
        .filter(|r| r.path == rel)
        .map(|r| r.version)
        .max()
        .unwrap_or(0)
        + 1;
    let record = ProvenanceRecord {
        path: rel,
        version,
        ts: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        tool: tool.to_string(),
        session_id,
        model,
        content: content.map(cap_content),
        diff: diff.map(cap_content),
        log,
        env,
        run_id,
    };
    let line = serde_json::to_string(&record).map_err(|e| e.to_string())?;
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
        .map_err(|e| format!("provenance open failed: {e}"))?;
    writeln!(f, "{line}").map_err(|e| format!("provenance write failed: {e}"))?;
    Ok(record)
}

/// Append a `run`-produced version record for each of `paths` in ONE pass:
/// reads the store once to compute per-path next versions, then writes all
/// lines together. Used by runs.rs to link a run's outputs — a single read +
/// write instead of one full store re-read per output, and the caller holds the
/// same `ProvenanceState` lock as `record_provenance` so the two never race the
/// version-then-append on `provenance.jsonl`.
pub fn link_run_outputs(
    root: &Path,
    paths: &[String],
    session_id: Option<String>,
    model: Option<String>,
    log: Option<String>,
    env: Option<EnvInfo>,
    run_id: String,
) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let file = store_file(root);
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("provenance dir failed: {e}"))?;
    }
    // Read once; compute the current max version per path.
    let mut max_ver: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    for r in read_all(&file) {
        let e = max_ver.entry(r.path).or_insert(0);
        *e = (*e).max(r.version);
    }
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let mut buf = String::new();
    for p in paths {
        let rel = normalize_rel(root, p)?;
        let v = max_ver.entry(rel.clone()).or_insert(0);
        *v += 1;
        let record = ProvenanceRecord {
            path: rel,
            version: *v,
            ts,
            tool: "run".to_string(),
            session_id: session_id.clone(),
            model: model.clone(),
            content: None,
            diff: None,
            log: log.clone(),
            env: env.clone(),
            run_id: Some(run_id.clone()),
        };
        buf.push_str(&serde_json::to_string(&record).map_err(|e| e.to_string())?);
        buf.push('\n');
    }
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
        .map_err(|e| format!("provenance open failed: {e}"))?;
    f.write_all(buf.as_bytes()).map_err(|e| format!("provenance write failed: {e}"))?;
    Ok(())
}

/// All recorded versions of one artifact, oldest first.
pub fn versions_for(root: &Path, path: &str) -> Result<Vec<ProvenanceRecord>, String> {
    let rel = normalize_rel(root, path)?;
    let mut v: Vec<ProvenanceRecord> = read_all(&store_file(root))
        .into_iter()
        .filter(|r| r.path == rel)
        .collect();
    v.sort_by_key(|r| r.version);
    Ok(v)
}

/// Every recorded version of one workspace file.
pub fn list_provenance(env: &Env, path: &str) -> Result<Vec<ProvenanceRecord>, String> {
    versions_for(&workspace_dir(env)?, path)
}

/// Read a content-addressed package lockfile (`.openscience/env/<hash>.txt`).
/// `hash` is validated to hex so it cannot escape the env directory.
pub fn read_env_lockfile(env: &Env, hash: &str) -> Result<String, String> {
    if hash.is_empty() || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("invalid lockfile id".into());
    }
    let path = workspace_dir(env)?
        .join(STORE_DIR)
        .join(ENV_DIR)
        .join(format!("{hash}.txt"));
    std::fs::read_to_string(&path).map_err(|e| format!("lockfile unavailable: {e}"))
}

#[cfg(test)]
mod tests {
    use super::{append_record, cap_content, normalize_rel, versions_for, CONTENT_CAP};

    fn temp_root(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ai4s-prov-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn versions_increment_per_path_and_round_trip() {
        let root = temp_root("versions");
        let r1 = append_record(&root, "fig/plot.py", "write", Some("ses_1".into()), Some("m".into()), Some("print(1)".into()), None, None, None, None).unwrap();
        // A file produced by a run carries its run_id (link to the recipe).
        let r2 = append_record(&root, "fig/plot.py", "run", Some("ses_1".into()), None, None, None, None, None, Some("run_abc".into())).unwrap();
        // An edit records its diff for lineage (no full content).
        let e = append_record(&root, "fig/plot.py", "edit", None, None, None, Some("@@ -1 +1 @@\n-print(1)\n+print(2)".into()), None, None, None).unwrap();
        assert_eq!(e.version, 3);
        assert!(e.content.is_none());
        assert_eq!(e.diff.as_deref(), Some("@@ -1 +1 @@\n-print(1)\n+print(2)"));
        let other = append_record(
            &root,
            "report.md",
            "write",
            None,
            None,
            None,
            None,
            Some("wrote report.md".into()),
            Some(super::EnvInfo {
                python: Some("3.12.4".into()),
                platform: "macos-aarch64".into(),
                app: "0.1.0".into(),
                packages: Some(super::PackageSnapshot { count: 2, hash: "abc123".into() }),
                hardware: None,
            }),
            None,
        )
        .unwrap();
        assert_eq!((r1.version, r2.version, other.version), (1, 2, 1));

        let v = versions_for(&root, "fig/plot.py").unwrap();
        assert_eq!(v.len(), 3);
        assert_eq!(v[0].content.as_deref(), Some("print(1)"));
        assert_eq!(v[0].run_id, None); // an authored write has no run
        assert_eq!(v[2].diff.as_deref(), Some("@@ -1 +1 @@\n-print(1)\n+print(2)"));
        assert_eq!(v[1].tool, "run");
        assert_eq!(v[1].run_id.as_deref(), Some("run_abc")); // round-trips
        assert_eq!(v[1].session_id.as_deref(), Some("ses_1"));
        assert!(v[1].ts > 0);
        // env round-trips (and its absence stays absent).
        assert!(v[0].env.is_none());
        let report = versions_for(&root, "report.md").unwrap();
        let env = report[0].env.as_ref().expect("env recorded");
        assert_eq!(env.python.as_deref(), Some("3.12.4"));
        assert_eq!(env.platform, "macos-aarch64");
        assert_eq!(env.app, "0.1.0");
        let pkgs = env.packages.as_ref().expect("packages recorded");
        assert_eq!((pkgs.count, pkgs.hash.as_str()), (2, "abc123"));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn lockfile_is_content_addressed_and_deduped() {
        use super::{content_hash, write_lockfile};
        let root = temp_root("lockfile");
        let freeze = "numpy==2.0.1\npandas==2.2.2\n\nscipy==1.14.0\n";
        let s1 = write_lockfile(&root, freeze).unwrap();
        // Blank lines are not counted as packages.
        assert_eq!(s1.count, 3);
        assert_eq!(s1.hash, content_hash(freeze)); // deterministic addressing
        let lock = root.join(".openscience/env").join(format!("{}.txt", s1.hash));
        assert_eq!(std::fs::read_to_string(&lock).unwrap(), freeze);

        // Same environment -> same hash, no duplicate file rewrite.
        let s2 = write_lockfile(&root, freeze).unwrap();
        assert_eq!(s2.hash, s1.hash);
        // A different environment -> a different lockfile.
        let s3 = write_lockfile(&root, "numpy==2.0.1\n").unwrap();
        assert_ne!(s3.hash, s1.hash);
        assert_eq!(s3.count, 1);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn absolute_paths_normalize_and_escapes_are_rejected() {
        let root = temp_root("norm");
        // Absolute path under the workspace → same key as the relative form.
        let abs = root.join("a/b.txt");
        append_record(&root, abs.to_str().unwrap(), "write", None, None, None, None, None, None, None).unwrap();
        let v = versions_for(&root, "a/b.txt").unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].path, "a/b.txt");

        assert!(normalize_rel(&root, "../outside.txt").is_err());
        assert!(normalize_rel(&root, "/etc/hosts").is_err());
        assert!(normalize_rel(&root, "").is_err());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn corrupt_lines_are_skipped_and_content_is_capped() {
        let root = temp_root("corrupt");
        append_record(&root, "x.py", "write", None, None, None, None, None, None, None).unwrap();
        // A corrupt line must not lose the rest of the history.
        use std::io::Write;
        let file = root.join(".openscience/provenance.jsonl");
        let mut f = std::fs::OpenOptions::new().append(true).open(&file).unwrap();
        writeln!(f, "not json").unwrap();
        append_record(&root, "x.py", "write", None, None, None, None, None, None, None).unwrap();
        let v = versions_for(&root, "x.py").unwrap();
        assert_eq!(v.iter().map(|r| r.version).collect::<Vec<_>>(), vec![1, 2]);

        let big = "é".repeat(CONTENT_CAP); // multi-byte: cap must respect char boundaries
        let capped = cap_content(big);
        assert!(capped.len() <= CONTENT_CAP + 20);
        assert!(capped.ends_with("[truncated]"));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn extracts_an_explicit_venv_interpreter_from_a_command() {
        use super::{interpreter_from_command, RunInterpreter};
        let root = temp_root("interp");
        // A venv-style interpreter that actually exists on disk (relative to root).
        let venv = root.join(".venv/bin");
        std::fs::create_dir_all(&venv).unwrap();
        let py = venv.join("python");
        std::fs::write(&py, "#!/bin/sh\n").unwrap();

        // Every explicit path-form spelling resolves to the same existing file.
        let explicit = |cmd: &str| match interpreter_from_command(cmd, &root) {
            Some(RunInterpreter::Explicit(p)) => p,
            other => panic!("expected Explicit for {cmd:?}, got {}", label(&other)),
        };
        assert_eq!(explicit(".venv/bin/python train.py"), py); // relative to workspace
        assert_eq!(explicit("./.venv/bin/python train.py"), py); // `./` prefix
        assert_eq!(explicit("CUDA_VISIBLE_DEVICES=0 .venv/bin/python train.py"), py); // env prefix
        assert_eq!(explicit("& \".venv/bin/python\" -c \"print(1)\""), py); // PowerShell `&`, quoted
        assert_eq!(explicit(&format!("{} -c 'x'", py.to_string_lossy())), py); // absolute path

        // A bare `python` is PATH-resolved, not an explicit path — fall back to default.
        assert!(matches!(interpreter_from_command("python train.py", &root), None));
        // A non-Python path-form command is not treated as an interpreter.
        assert!(matches!(interpreter_from_command("./scripts/run.sh", &root), None));
        // An explicit interpreter that does NOT exist is reported Missing, so the
        // caller attributes no Python env rather than the misleading default (#23).
        assert!(matches!(
            interpreter_from_command(".venv/bin/python3.99 train.py", &root),
            Some(RunInterpreter::Missing),
        ));

        let _ = std::fs::remove_dir_all(root);
    }

    fn label(r: &Option<super::RunInterpreter>) -> &'static str {
        match r {
            None => "None",
            Some(super::RunInterpreter::Explicit(_)) => "Explicit",
            Some(super::RunInterpreter::Missing) => "Missing",
        }
    }

    // Proves the env snapshot shells out to the EXACT interpreter path it is
    // given (not a global default): a fake interpreter answers with a distinct
    // version and freeze, and that is what comes back. Unix-only (shebang+chmod).
    #[cfg(unix)]
    #[test]
    fn env_snapshot_runs_the_exact_interpreter_it_is_given() {
        use super::{pip_freeze, python_version};
        use std::os::unix::fs::PermissionsExt;
        let root = temp_root("interp-exec");
        let bin = root.join("python");
        std::fs::write(
            &bin,
            "#!/bin/sh\ncase \"$*\" in\n  '--version') echo 'Python 9.9.9-venvtest' ;;\n  *pip*freeze*) printf 'venvpkg==1.2.3\\n' ;;\nesac\n",
        )
        .unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let interp = bin.to_string_lossy();

        // The version and packages come from THIS interpreter, verbatim.
        assert_eq!(python_version(&interp).as_deref(), Some("9.9.9-venvtest"));
        assert_eq!(pip_freeze(&interp).as_deref(), Some("venvpkg==1.2.3"));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn segment_prefix_and_token_helpers() {
        use super::{first_token, strip_seg_prefixes};
        assert_eq!(strip_seg_prefixes("CUDA_VISIBLE_DEVICES=0 python x.py"), "python x.py");
        assert_eq!(strip_seg_prefixes("A=1 B=2 python x.py"), "python x.py");
        assert_eq!(strip_seg_prefixes("& C:\\p\\python.exe -c y"), "C:\\p\\python.exe -c y");
        // A trailing `VAR=val` with no following command is NOT stripped.
        assert_eq!(strip_seg_prefixes("FOO=bar"), "FOO=bar");
        // First token honors a leading quoted path with spaces.
        assert_eq!(first_token("\"C:\\Program Files\\Py\\python.exe\" train.py"), "C:\\Program Files\\Py\\python.exe");
        assert_eq!(first_token("python train.py"), "python");
    }
}
