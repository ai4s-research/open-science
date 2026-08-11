// Remote compute over SSH. The app talks to the user's machines with the
// system `ssh` binary and the user's own SSH config/keys — no credentials of
// our own, no agent installed remotely. Rust side: pick a host, probe it for
// capabilities (cores, memory, disk, GPUs, optional Slurm), and list/cancel
// the user's queued Slurm jobs. Submission itself is agent-driven via the
// bundled `remote-compute` skill; saved machines live in
// <workspace>/.openscience/compute.json (see compute_machines below).
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;

use crate::runtime::{base_workspace_dir, workspace_dir};

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct HpcJob {
    pub id: String,
    pub state: String,
    pub time: String,
    pub partition: String,
    pub name: String,
}

/// One GPU as `nvidia-smi --query-gpu=... --format=csv,noheader,nounits` prints
/// it (memory in MiB, utilization in %).
#[derive(Clone, serde::Serialize)]
pub struct GpuInfo {
    pub name: String,
    pub mem_total_mib: u64,
    pub mem_used_mib: u64,
    pub util_pct: u32,
}

/// One SSH probe of a machine: reachability + static identity + a live usage
/// snapshot, all from a single round-trip. Absent fields = the tool wasn't
/// present (a minimal CPU box has no `nvidia-smi`, an old `free` has no
/// "available" column, etc.).
#[derive(Clone, serde::Serialize, Default)]
pub struct ComputeProbe {
    pub reachable: bool,
    pub message: Option<String>,
    /// The host answered, but it wants credentials this app cannot supply
    /// non-interactively — a password, a one-time code, or both (#73). The card
    /// offers a sign-in instead of showing an ssh error the user cannot act on.
    pub needs_sign_in: bool,
    pub os: Option<String>,
    pub cores: Option<u32>,
    pub load1: Option<f32>,
    pub mem_total_bytes: Option<u64>,
    pub mem_avail_bytes: Option<u64>,
    pub disk_total_bytes: Option<u64>,
    pub disk_free_bytes: Option<u64>,
    pub gpus: Vec<GpuInfo>,
    pub slurm: Option<String>,
}

/// Parse the token-labeled probe output (see PROBE_SCRIPT). Each recognized
/// line is `TOKEN value`; unknown lines (shell banners, stray output) are
/// ignored so a chatty login shell can't corrupt the result. Sets everything
/// except `reachable`/`message` (the command decides those from the ssh exit).
fn parse_probe(stdout: &str) -> ComputeProbe {
    let mut p = ComputeProbe::default();
    for line in stdout.lines() {
        let line = line.trim();
        let Some((tag, rest)) = line.split_once(' ') else { continue };
        let rest = rest.trim();
        match tag {
            "OS" => p.os = Some(rest.to_string()),
            "CORES" => p.cores = rest.parse().ok(),
            "LOAD" => p.load1 = rest.parse().ok(),
            "MEMTOTAL" => p.mem_total_bytes = rest.parse().ok(),
            "MEMAVAIL" => p.mem_avail_bytes = rest.parse().ok(),
            "DISKTOTAL" => p.disk_total_bytes = rest.parse().ok(),
            "DISKFREE" => p.disk_free_bytes = rest.parse().ok(),
            "SLURM" => p.slurm = Some(rest.to_string()),
            "GPU" => {
                let f: Vec<&str> = rest.split(',').map(|s| s.trim()).collect();
                if f.len() == 4 {
                    p.gpus.push(GpuInfo {
                        name: f[0].to_string(),
                        mem_total_mib: f[1].parse().unwrap_or(0),
                        mem_used_mib: f[2].parse().unwrap_or(0),
                        util_pct: f[3].parse().unwrap_or(0),
                    });
                }
            }
            _ => {}
        }
    }
    p
}

/// `user@host` or `host` made only of safe characters. Rejects anything that
/// could smuggle an ssh option (leading `-`) or shell metacharacters.
pub(crate) fn is_safe_host(host: &str) -> bool {
    let rest = host.split_once('@').map(|(u, h)| {
        (!u.is_empty() && u.chars().all(is_host_char)).then_some(h)
    });
    let host_part = match rest {
        Some(Some(h)) => h,
        Some(None) => return false,
        None => host,
    };
    !host_part.is_empty()
        && !host_part.starts_with('-')
        && host_part.chars().all(is_host_char)
}

fn is_host_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+')
}

/// A Slurm job id as squeue %i prints it: `123`, array forms `123_4` /
/// `123_[0-15]` / `123_[0-15%4]`, het-job forms `123+0`.
fn is_safe_job_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '_' | '[' | ']' | '-' | '+' | ',' | '%'))
}

/// Host aliases from an ssh config, in file order, wildcard patterns skipped.
fn parse_ssh_hosts(text: &str) -> Vec<String> {
    let mut hosts = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let mut words = line.split_whitespace();
        if !words.next().is_some_and(|w| w.eq_ignore_ascii_case("host")) {
            continue;
        }
        for alias in words {
            if alias.starts_with('#') {
                break; // rest of the line is a comment
            }
            if alias.contains(['*', '?', '!']) {
                continue;
            }
            // Never suggest an alias the connect path would reject.
            if !is_safe_host(alias) {
                continue;
            }
            let alias = alias.to_string();
            if !hosts.contains(&alias) {
                hosts.push(alias);
            }
        }
    }
    hosts
}

/// Host aliases from the user's `~/.ssh/config` (candidates for the picker —
/// the UI also accepts a free-form `user@host`).
#[tauri::command]
pub fn list_ssh_hosts(app: AppHandle) -> Result<Vec<String>, String> {
    let path = app.path().home_dir().map_err(|e| e.to_string())?.join(".ssh").join("config");
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(parse_ssh_hosts(&text)),
        Err(_) => Ok(Vec::new()), // no ssh config is a normal state
    }
}

/// Run one non-interactive command on the host via the system ssh, with the
/// user's own keys/config. Returns (exit code, stdout, stderr).
async fn run_ssh(app: &AppHandle, host: &str, command: &str) -> Result<(i32, String, String), String> {
    if !is_safe_host(host) {
        return Err("invalid host".into());
    }
    // Run through the app-managed config so this call rides an existing shared
    // connection when the user has signed in (#73). BatchMode stays on: riding a
    // master needs no authentication, and without one this behaves exactly as it
    // did before — key-based hosts are untouched.
    let mut args: Vec<String> = Vec::new();
    if let Some(config) = crate::ssh_session::config_path(app) {
        args.push("-F".into());
        args.push(config.to_string_lossy().to_string());
    }
    for a in [
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=8",
        // Never trust an unknown host key on the app's behalf (safety
        // default: remote connections need the user's approval) — the
        // user verifies the fingerprint once in their own terminal.
        "-o", "StrictHostKeyChecking=yes",
        "--",
    ] {
        args.push(a.into());
    }
    args.push(host.into());
    args.push(command.into());
    let out = app
        .shell()
        .command("ssh")
        .args(args)
        .output()
        .await
        .map_err(|e| format!("ssh failed to run: {e}"))?;
    Ok((
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).to_string(),
        String::from_utf8_lossy(&out.stderr).to_string(),
    ))
}

/// Parse `squeue -h -o '%i|%T|%M|%P|%j'` output (name last — it may contain
/// separators; the tail is swallowed into it).
fn parse_squeue(stdout: &str) -> Vec<HpcJob> {
    stdout
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            let mut f = line.splitn(5, '|');
            Some(HpcJob {
                id: f.next()?.trim().to_string(),
                state: f.next()?.trim().to_string(),
                time: f.next()?.trim().to_string(),
                partition: f.next()?.trim().to_string(),
                name: f.next()?.trim().to_string(),
            })
        })
        .collect()
}

/// Static capability snapshot cached in compute.json — the ONLY thing the agent
/// reads to pick a machine. Never holds time-varying usage.
#[derive(Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct Caps {
    pub cores: Option<u32>,
    pub mem_total_bytes: Option<u64>,
    #[serde(default)]
    pub gpus: Vec<String>,
    pub slurm: Option<String>,
}

/// A saved remote machine. `caps` is absent until the first successful probe.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Machine {
    pub host: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub caps: Option<Caps>,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct MachinesFile {
    #[serde(default)]
    machines: Vec<Machine>,
}

/// Parse compute.json; malformed content yields an empty list rather than an
/// error (a hand-broken file must not brick the settings page).
fn parse_machines(json: &str) -> Vec<Machine> {
    serde_json::from_str::<MachinesFile>(json).map(|f| f.machines).unwrap_or_default()
}

/// Import a legacy `{"host":"…"}` hpc.json as a single machine (no caps yet).
fn legacy_to_machines(hpc_json: &str) -> Vec<Machine> {
    serde_json::from_str::<serde_json::Value>(hpc_json)
        .ok()
        .and_then(|v| v.get("host").and_then(|h| h.as_str()).map(str::to_string))
        .map(|host| vec![Machine { host, label: None, caps: None }])
        .unwrap_or_default()
}

/// Insert or update a machine by host (dedupe). Updates the label in place;
/// preserves any existing caps.
fn upsert_machine(list: &mut Vec<Machine>, host: &str, label: Option<String>) {
    if let Some(m) = list.iter_mut().find(|m| m.host == host) {
        if label.is_some() {
            m.label = label;
        }
    } else {
        list.push(Machine { host: host.to_string(), label, caps: None });
    }
}

/// The static slice of a probe worth caching for agent machine-selection.
fn caps_from_probe(p: &ComputeProbe) -> Caps {
    Caps {
        cores: p.cores,
        mem_total_bytes: p.mem_total_bytes,
        gpus: p.gpus.iter().map(|g| g.name.clone()).collect(),
        slurm: p.slurm.clone(),
    }
}

/// New machine-list config; supersedes the single-host hpc.json.
const COMPUTE_FILE: &str = "compute.json";

fn compute_path(app: &AppHandle) -> Result<PathBuf, String> {
    // Base workspace, NOT the per-session dated folder: a remote machine is a
    // user-level resource shared across every session. Stored once here; the
    // agent reaches it from its session folder via `../.openscience/compute.json`
    // (the seeded harness points at it), so no per-session copies are kept.
    Ok(base_workspace_dir(app)?.join(".openscience").join(COMPUTE_FILE))
}

/// One SSH round-trip: static identity + a live usage snapshot, one token per
/// line, tolerant of missing tools (Linux remote assumed).
// ONE physical line (statements separated by `;`), NOT multi-line: a newline
// embedded in the single ssh argument is marshalled inconsistently by the
// Windows process/`ssh.exe` argument layer, so keep it flat. `;` and newline
// are equivalent sh separators, and the remote still emits newline-separated
// OUTPUT (one token per line), which is what `parse_probe` reads.
const PROBE_SCRIPT: &str = "echo \"OS $(uname -sr)\"; \
echo \"CORES $(nproc 2>/dev/null)\"; \
cut -d' ' -f1 /proc/loadavg 2>/dev/null | sed 's/^/LOAD /'; \
free -b 2>/dev/null | awk '/^Mem:/{print \"MEMTOTAL\",$2; print \"MEMAVAIL\",$7}'; \
df -PB1 \"$HOME\" 2>/dev/null | awk 'NR==2{print \"DISKTOTAL\",$2; print \"DISKFREE\",$4}'; \
command -v sbatch >/dev/null 2>&1 && echo \"SLURM $(sbatch --version 2>/dev/null | head -1)\"; \
command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=name,memory.total,memory.used,utilization.gpu --format=csv,noheader,nounits | sed 's/^/GPU /'";

fn load_machines(app: &AppHandle) -> Result<Vec<Machine>, String> {
    let path = compute_path(app)?;
    if let Ok(text) = std::fs::read_to_string(&path) {
        return Ok(parse_machines(&text));
    }
    // Migrate a legacy base-workspace hpc.json exactly once, then remove it.
    let legacy = base_workspace_dir(app)?.join(".openscience").join("hpc.json");
    if let Ok(text) = std::fs::read_to_string(&legacy) {
        let machines = legacy_to_machines(&text);
        save_machines(app, &machines)?;
        let _ = std::fs::remove_file(&legacy);
        return Ok(machines);
    }
    Ok(Vec::new())
}

/// Copy the canonical (base-workspace) machine list into the ACTIVE session
/// workspace's `.openscience/compute.json` so the agent reads it IN-workspace —
/// no `../` (which the agent mis-resolves) and no out-of-workspace permission
/// prompt. Derived, never user-edited; best-effort. When base has no config,
/// clears any stale local copy so removals propagate. No-op when the active
/// workspace IS the base (the canonical file is already there).
pub(crate) fn materialize_active(app: &AppHandle) {
    let (Ok(base), Ok(active)) = (base_workspace_dir(app), workspace_dir(app)) else {
        return;
    };
    if base == active {
        return;
    }
    write_materialized(
        &base.join(".openscience").join(COMPUTE_FILE),
        &active.join(".openscience"),
    );
}

/// Mirror `src` (the canonical compute.json) into `dst_dir` as compute.json:
/// copy its contents when present, else remove any stale local copy so machine
/// removals propagate. Best-effort.
fn write_materialized(src: &std::path::Path, dst_dir: &std::path::Path) {
    let dst = dst_dir.join(COMPUTE_FILE);
    match std::fs::read_to_string(src) {
        Ok(body) => {
            if std::fs::create_dir_all(dst_dir).is_ok() {
                let _ = std::fs::write(&dst, body);
            }
        }
        Err(_) => {
            let _ = std::fs::remove_file(&dst);
        }
    }
}

fn save_machines(app: &AppHandle, machines: &[Machine]) -> Result<(), String> {
    let path = compute_path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string(&MachinesFile { machines: machines.to_vec() })
        .map_err(|e| e.to_string())?;
    // Write to a sibling temp file then rename, so a probe writeback racing a
    // concurrent write (or a remove) can't corrupt or truncate compute.json.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &body).map_err(|e| e.to_string())?;
    // rename replaces atomically on both Unix and Windows (MoveFileEx). On
    // Windows it can transiently fail if an AV/indexer holds the target open —
    // fall back to a direct write so persisting a machine never hard-fails.
    if std::fs::rename(&tmp, &path).is_err() {
        let res = std::fs::write(&path, &body).map_err(|e| e.to_string());
        let _ = std::fs::remove_file(&tmp);
        return res;
    }
    Ok(())
}

#[tauri::command]
pub fn compute_machines(app: AppHandle) -> Result<Vec<Machine>, String> {
    load_machines(&app)
}

#[tauri::command]
pub fn add_compute_machine(app: AppHandle, host: String, label: Option<String>) -> Result<(), String> {
    if !is_safe_host(&host) {
        return Err("invalid host".into());
    }
    let mut machines = load_machines(&app)?;
    upsert_machine(&mut machines, &host, label);
    save_machines(&app, &machines)?;
    materialize_active(&app);
    Ok(())
}

#[tauri::command]
pub fn remove_compute_machine(app: AppHandle, host: String) -> Result<(), String> {
    let mut machines = load_machines(&app)?;
    machines.retain(|m| m.host != host);
    save_machines(&app, &machines)?;
    materialize_active(&app);
    Ok(())
}

/// Whether an ssh failure means "this host wants credentials interactively"
/// rather than something the user must fix elsewhere. `BatchMode=yes` turns
/// every interactive method into one of these refusals, so the distinction is
/// what tells the card to offer a sign-in (#73) instead of an error the user can
/// do nothing about. Host-key and network failures deliberately do NOT match:
/// signing in would not help, and the existing guidance is better.
pub(crate) fn wants_interactive_auth(stderr: &str) -> bool {
    if stderr.contains("Host key verification failed") {
        return false;
    }
    let s = stderr.to_ascii_lowercase();
    s.contains("permission denied")
        || s.contains("no supported authentication methods")
        || s.contains("authentication failed")
        // OpenSSH's own words when BatchMode refuses a method that would have
        // prompted (password, keyboard-interactive, 2FA).
        || s.contains("batchmode")
        || s.contains("keyboard-interactive")
        || s.contains("password authentication")
}

/// Probe a host and, when reachable, write its static caps back into
/// compute.json (only if the host is already saved — probing during add is fine
/// because add runs first). Live usage in the return value is never cached.
#[tauri::command]
pub async fn compute_probe(app: AppHandle, host: String) -> Result<ComputeProbe, String> {
    let (code, stdout, stderr) = run_ssh(&app, &host, PROBE_SCRIPT).await?;
    if code == 255 {
        let mut detail = stderr.lines().last().unwrap_or("connection failed").trim().to_string();
        if stderr.contains("Host key verification failed") {
            detail = format!(
                "host key not verified — run `ssh {host}` once in your terminal to check \
                 and accept its fingerprint, then retry"
            );
        }
        let needs_sign_in = wants_interactive_auth(&stderr);
        if needs_sign_in {
            detail = "this machine asks for a password or a one-time code".into();
        }
        return Ok(ComputeProbe {
            reachable: false,
            message: Some(detail),
            needs_sign_in,
            ..Default::default()
        });
    }
    let mut probe = parse_probe(&stdout);
    probe.reachable = true;
    // Cache the static caps for agent selection (best-effort).
    if let Ok(mut machines) = load_machines(&app) {
        if let Some(m) = machines.iter_mut().find(|m| m.host == host) {
            m.caps = Some(caps_from_probe(&probe));
            let _ = save_machines(&app, &machines);
        }
    }
    materialize_active(&app); // refresh the active session's local copy
    Ok(probe)
}

/// A Slurm host's queue (only meaningful when the machine has Slurm).
#[tauri::command]
pub async fn compute_jobs(app: AppHandle, host: String) -> Result<Vec<HpcJob>, String> {
    let (code, stdout, stderr) =
        run_ssh(&app, &host, "squeue -u \"$USER\" -h -o '%i|%T|%M|%P|%j'").await?;
    if code != 0 {
        return Err(stderr.lines().last().unwrap_or("squeue failed").trim().to_string());
    }
    Ok(parse_squeue(&stdout))
}

#[tauri::command]
pub async fn compute_cancel(app: AppHandle, host: String, job_id: String) -> Result<(), String> {
    if !is_safe_job_id(&job_id) {
        return Err("invalid job id".into());
    }
    let (code, _, stderr) = run_ssh(&app, &host, &format!("scancel '{job_id}'")).await?;
    if code != 0 {
        return Err(stderr.lines().last().unwrap_or("scancel failed").trim().to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{is_safe_host, is_safe_job_id, parse_squeue, parse_ssh_hosts, wants_interactive_auth};

    #[test]
    fn tells_a_sign_in_requirement_apart_from_failures_signing_in_cannot_fix() {
        // What BatchMode leaves behind on a cluster that wanted a password, a
        // one-time code, or keyboard-interactive: the sign-in dialog helps.
        assert!(wants_interactive_auth("asq@login: Permission denied (publickey,keyboard-interactive).\n"));
        assert!(wants_interactive_auth("Permission denied, please try again.\n"));
        assert!(wants_interactive_auth(
            "login: no supported authentication methods available (server sent: password)\n"
        ));
        // Not an auth problem — signing in would not help, and the existing
        // fingerprint guidance is the useful message.
        assert!(!wants_interactive_auth(
            "Host key verification failed.\nsomething about keyboard-interactive\n"
        ));
        assert!(!wants_interactive_auth("ssh: connect to host x port 22: Operation timed out\n"));
        assert!(!wants_interactive_auth("ssh: Could not resolve hostname x\n"));
        assert!(!wants_interactive_auth(""));
    }

    #[test]
    fn parses_hosts_and_skips_wildcards() {
        let cfg = "
Host *
    ServerAliveInterval 60

Host login  # HPC login node
Host cluster-a cluster-b
    HostName a.example.org
host lowercase
Host bad-* good.host
Host gpu+login \"quoted alias\"
";
        // Aliases the connect path would reject (is_safe_host) are not suggested.
        assert_eq!(
            parse_ssh_hosts(cfg),
            vec!["login", "cluster-a", "cluster-b", "lowercase", "good.host", "gpu+login"]
        );
    }

    #[test]
    fn dedupes_repeated_aliases() {
        assert_eq!(parse_ssh_hosts("Host a\nHost a b"), vec!["a", "b"]);
    }

    #[test]
    fn accepts_real_hosts_rejects_injection() {
        assert!(is_safe_host("login.hpc.edu"));
        assert!(is_safe_host("alice@10.0.0.7"));
        assert!(is_safe_host("cluster-a_1"));
        assert!(is_safe_host("gpu+login"));
        assert!(!is_safe_host(""));
        assert!(!is_safe_host("-oProxyCommand=evil"));
        assert!(!is_safe_host("alice@-evil"));
        assert!(!is_safe_host("host; rm -rf /"));
        assert!(!is_safe_host("host cmd"));
        assert!(!is_safe_host("@host"));
        assert!(!is_safe_host("a@b@c"));
    }

    #[test]
    fn job_id_validation() {
        assert!(is_safe_job_id("12345"));
        assert!(is_safe_job_id("123_4"));
        assert!(is_safe_job_id("123_[0-15]")); // pending array, as squeue prints it
        assert!(is_safe_job_id("123_[0-15%4]")); // array with throttle
        assert!(is_safe_job_id("123+0")); // heterogeneous job component
        assert!(!is_safe_job_id(""));
        assert!(!is_safe_job_id("123 456"));
        assert!(!is_safe_job_id("123;true"));
        assert!(!is_safe_job_id("123'true"));
    }

    #[test]
    fn parses_squeue_lines_name_last() {
        let jobs = parse_squeue("42|RUNNING|1:23|gpu|fit model|stage 2\n43|PENDING|0:00|cpu|sim\n\n");
        assert_eq!(jobs.len(), 2);
        assert_eq!(jobs[0].id, "42");
        assert_eq!(jobs[0].state, "RUNNING");
        assert_eq!(jobs[0].partition, "gpu");
        assert_eq!(jobs[0].name, "fit model|stage 2");
        assert_eq!(jobs[1].state, "PENDING");
    }

    #[test]
    fn parses_probe_all_tokens_and_ignores_noise() {
        let out = "\
Welcome to Ubuntu 22.04 — banner line, ignore me
OS Linux 6.5.0-14-generic
CORES 16
LOAD 1.23
MEMTOTAL 67516000000
MEMAVAIL 51000000000
DISKTOTAL 2000000000000
DISKFREE 1200000000000
SLURM slurm 23.11.4
GPU NVIDIA GeForce RTX 3090, 24576, 8100, 40
GPU NVIDIA GeForce RTX 3090, 24576, 512, 0
random junk with no leading token space? nope
";
        let p = super::parse_probe(out);
        assert_eq!(p.os.as_deref(), Some("Linux 6.5.0-14-generic"));
        assert_eq!(p.cores, Some(16));
        assert_eq!(p.load1, Some(1.23));
        assert_eq!(p.mem_total_bytes, Some(67_516_000_000));
        assert_eq!(p.mem_avail_bytes, Some(51_000_000_000));
        assert_eq!(p.disk_total_bytes, Some(2_000_000_000_000));
        assert_eq!(p.disk_free_bytes, Some(1_200_000_000_000));
        assert_eq!(p.slurm.as_deref(), Some("slurm 23.11.4"));
        assert_eq!(p.gpus.len(), 2);
        assert_eq!(p.gpus[0].name, "NVIDIA GeForce RTX 3090");
        assert_eq!(p.gpus[0].mem_total_mib, 24576);
        assert_eq!(p.gpus[0].mem_used_mib, 8100);
        assert_eq!(p.gpus[0].util_pct, 40);
        // reachable/message are set by the command, not the parser.
        assert!(!p.reachable);
    }

    #[test]
    fn materialize_copies_then_clears() {
        use std::fs;
        let root = std::env::temp_dir().join(format!("os-materialize-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let base_os = root.join("base-openscience");
        let sess_os = root.join("session-openscience");
        fs::create_dir_all(&base_os).unwrap();
        let src = base_os.join("compute.json");
        fs::write(&src, r#"{"machines":[{"host":"h","label":null,"caps":null}]}"#).unwrap();

        // Present source → local copy written with identical contents.
        super::write_materialized(&src, &sess_os);
        let dst = sess_os.join("compute.json");
        assert_eq!(fs::read_to_string(&dst).unwrap(), fs::read_to_string(&src).unwrap());

        // Source removed (all machines deleted) → stale local copy cleared.
        fs::remove_file(&src).unwrap();
        super::write_materialized(&src, &sess_os);
        assert!(!dst.exists(), "stale local copy must be removed when base has none");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn probe_script_is_single_line() {
        // Must stay one physical line — an embedded newline in the single ssh
        // argument is marshalled inconsistently on Windows. `;` separates
        // statements instead; the remote still emits newline-separated output.
        assert!(!super::PROBE_SCRIPT.contains('\n'), "PROBE_SCRIPT must be one line");
        assert!(super::PROBE_SCRIPT.contains("nvidia-smi"), "probe must still query GPUs");
    }

    #[test]
    fn parses_probe_missing_tools_degrade() {
        // A minimal CPU box: no SLURM, no GPU, no /proc/loadavg line emitted.
        let p = super::parse_probe("OS Linux 5.10\nCORES 8\nMEMTOTAL 33000000000\n");
        assert_eq!(p.cores, Some(8));
        assert!(p.slurm.is_none());
        assert!(p.gpus.is_empty());
        assert!(p.load1.is_none());
    }

    #[test]
    fn parses_machines_with_caps() {
        let json = r#"{"machines":[{"host":"home-3090","label":"8x3090",
            "caps":{"cores":16,"mem_total_bytes":67516000000,
                    "gpus":["RTX 3090","RTX 3090"],"slurm":null}}]}"#;
        let m = super::parse_machines(json);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].host, "home-3090");
        assert_eq!(m[0].label.as_deref(), Some("8x3090"));
        assert_eq!(m[0].caps.as_ref().unwrap().gpus.len(), 2);
    }

    #[test]
    fn parse_machines_tolerates_garbage() {
        assert!(super::parse_machines("not json").is_empty());
        assert!(super::parse_machines("{}").is_empty());
    }

    #[test]
    fn migrates_legacy_single_host() {
        let m = super::legacy_to_machines(r#"{"host":"login-a"}"#);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].host, "login-a");
        assert!(m[0].caps.is_none());
        // A legacy file with no host → nothing to migrate.
        assert!(super::legacy_to_machines("{}").is_empty());
    }

    #[test]
    fn upsert_dedupes_by_host() {
        let mut list = vec![];
        super::upsert_machine(&mut list, "a", Some("A".into()));
        super::upsert_machine(&mut list, "a", Some("A2".into())); // same host
        super::upsert_machine(&mut list, "b", None);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].label.as_deref(), Some("A2")); // label updated in place
    }
}
