// Interactive SSH sign-in for compute hosts (#73).
//
// Institutional clusters routinely ask for a password, a one-time code, or both
// on EVERY new connection. `BatchMode=yes` (compute.rs) can never answer that,
// so those machines are unusable today — not slower, unusable. Answering a
// prompt per connection would be no better: one agent run makes dozens of ssh
// calls, which would mean dozens of one-time codes.
//
// So the app does what the user would otherwise hand-configure: it opens ONE
// authenticated master connection per host over a real PTY, relays whatever the
// server asks to a dialog, and every later ssh — the app's own probes and the
// agent's `ssh`/`rsync`/`sbatch` alike — rides that master through a shared
// ControlPath and is never prompted at all. One sign-in per working session.
//
// Two deliberate non-features:
//   * Prompts are never classified. Duo, PAM, RSA and campus OTP flows word
//     themselves differently ("Password:", "Passcode or option (1-3):",
//     "Enter PIN+TOKENCODE:"); the dialog shows the server's own text and
//     relays the answer, so a flow nobody here has seen still works.
//   * Nothing is persisted. A one-time code is single-use by definition, and
//     the master's lifetime makes one prompt per working session enough.
//     Secrets go into the PTY — never a process argument, so they cannot reach
//     provenance, run records, logs or the conversation.
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver};
use std::sync::Mutex;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle, Emitter, Manager};

/// How long the shared connection outlives its last use. A working session, so
/// a day's work needs one sign-in — but not indefinite: an authenticated tunnel
/// left open forever is a credential of its own.
const CONTROL_PERSIST: &str = "8h";

/// Longest a sign-in may take before we give up on it. Generous on purpose: a
/// push-notification second factor waits on a human reaching for their phone.
const CONNECT_TIMEOUT_SECS: u64 = 180;

/// Event the UI listens on; payload is the full session list (a handful of
/// hosts, changing only on real transitions — no need for deltas).
const STATE_EVENT: &str = "ssh:state";

/// OpenSSH connection sharing is a unix-socket feature; Windows' bundled
/// OpenSSH does not implement ControlMaster/ControlPath at all. Rather than ship
/// a sign-in that authenticates once and then prompts again for every command,
/// the feature reports itself unavailable there (see the card's explanation).
pub fn multiplexing_supported() -> bool {
    cfg!(unix)
}

/// Directory holding the control sockets.
///
/// Deliberately NOT the app data dir: a ControlPath is a unix socket, and macOS
/// caps socket paths at 104 bytes — "~/Library/Application Support/
/// com.ai4s.workbench/runtime/ssh/" plus ssh's own 40-character `%C` hash
/// overruns that, and the failure mode is a cryptic bind error at connect time.
///
/// The candidates below are tried longest-name-first and all live in the
/// per-user temp dir, which the OS already keeps private (0700, and on macOS
/// per-user) — that matters, because a world-writable last resort would let a
/// local user pre-create the directory and sit between our clients and the
/// master. A live connection socket has no business outliving a reboot anyway.
pub fn control_dir() -> PathBuf {
    let tag = user_tag();
    let tmp = std::env::temp_dir();
    // macOS's per-user temp dir is ~47 characters on its own, so the readable
    // name does not always fit; the short one always does.
    for name in [format!("os-ssh-{tag}"), "os-ssh".to_string(), "oss".to_string()] {
        let candidate = tmp.join(name);
        if socket_path_fits(&candidate) {
            return candidate;
        }
    }
    PathBuf::from(format!("/tmp/os-ssh-{tag}"))
}

/// Whether the socket directory is ours alone. The path is derivable, so on a
/// shared machine a directory someone else owns (or that is group/world
/// writable) could put another user between our clients and the master —
/// refuse rather than sign in through it. `reference` is a path known to belong
/// to this user (their home directory).
#[cfg(unix)]
fn dir_is_private(dir: &Path, reference: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    use std::os::unix::fs::PermissionsExt;
    let (Ok(d), Ok(r)) = (std::fs::metadata(dir), std::fs::metadata(reference)) else {
        return false;
    };
    d.is_dir() && d.uid() == r.uid() && d.permissions().mode() & 0o077 == 0
}

/// Per-user suffix so two accounts on one machine never share a socket dir.
/// A short hash of the home directory rather than a uid: no libc dependency for
/// one number, and it stays 8 characters however long the account name is.
fn user_tag() -> String {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325; // FNV-1a
    for b in home.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    format!("{:08x}", (hash >> 32) as u32)
}

/// Whether a control socket under `dir` stays inside the platform's socket-path
/// limit (104 bytes on macOS, the tightest mainstream cap).
///
/// The budget is not just the 40-character `%C` hash: while claiming the socket,
/// ssh binds `<path>.<16 random characters>` first and renames it into place, so
/// the real requirement is 17 bytes longer than the final name. Measured, not
/// assumed — the end-to-end test failed with
/// `unix_listener: path ".../<hash>.8ekIBJ1L27i2WFP6" too long` until this
/// accounted for it, which on macOS is the difference between every sign-in
/// working and every sign-in failing at bind time.
const SOCKET_HASH_LEN: usize = 40;
const SOCKET_TEMP_SUFFIX_LEN: usize = 20; // ".<16 chars>", with room to spare
pub fn socket_path_fits(dir: &Path) -> bool {
    dir.as_os_str().len() + 1 + SOCKET_HASH_LEN + SOCKET_TEMP_SUFFIX_LEN <= 104
}

/// The `ControlPath` value: ssh's own `%C` token (a hash of local host, remote
/// host, port and user), so master and clients always agree on the path without
/// the app enumerating hosts — which matters because saved machines are
/// per-workspace while this config is global.
fn control_path_pattern(dir: &Path) -> String {
    format!("{}/%C", dir.to_string_lossy())
}

/// The app-managed ssh config every app-initiated and agent-initiated ssh runs
/// with (`-F`). The user's own config is included FIRST on purpose: ssh keeps
/// the first value it obtains for an option, so anything the user configured for
/// their cluster — a jump host, a different ControlPath, an identity file — wins,
/// and our block only fills the gap. Sharing still works either way: master and
/// clients read this same file, so they agree on whichever path won.
pub fn managed_config(control_dir: &Path, user_config: Option<&Path>) -> String {
    let mut out = String::new();
    out.push_str("# Managed by Open Science Desktop — regenerated on every start.\n");
    out.push_str("# Edit ~/.ssh/config instead: it is included below and wins.\n\n");
    if let Some(user) = user_config {
        out.push_str(&format!("Include \"{}\"\n\n", user.to_string_lossy()));
    }
    out.push_str("# Fall back to the app's shared connection, so one interactive\n");
    out.push_str("# sign-in covers every later command on that host.\n");
    out.push_str("Host *\n");
    out.push_str("  ControlMaster no\n");
    out.push_str(&format!("  ControlPath {}\n", control_path_pattern(control_dir)));
    out
}

/// Write the managed config (and create its 0700 socket dir), returning its
/// path. Called on startup and before every connect, so an app upgrade or a
/// changed temp dir cannot leave a stale file behind.
pub fn ensure_config(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::runtime::runtime_root(app)?.join("ssh");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    crate::runtime::tighten_private(&dir);
    let sockets = control_dir();
    std::fs::create_dir_all(&sockets).map_err(|e| e.to_string())?;
    crate::runtime::tighten_private(&sockets);
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    #[cfg(unix)]
    if !dir_is_private(&sockets, &home) {
        return Err(format!(
            "{} is not private to you — remove it and try again",
            sockets.display()
        ));
    }
    let user = Some(home.join(".ssh").join("config")).filter(|p| p.is_file());
    let path = dir.join("config");
    let body = managed_config(&sockets, user.as_deref());
    if std::fs::read_to_string(&path).ok().as_deref() != Some(body.as_str()) {
        std::fs::write(&path, &body).map_err(|e| e.to_string())?;
    }
    crate::runtime::tighten_private(&path);
    Ok(path)
}

/// The managed config path, or None when there is nothing for it to do — callers
/// fall back to plain ssh, which is exactly the behaviour that predates this
/// module, rather than losing remote compute over a config problem.
///
/// None on Windows: the only thing this config adds is connection sharing, which
/// Windows' OpenSSH does not implement, and its `ControlMaster`/`ControlPath`
/// lines would then be pure risk — handed via `-F` to every app- and
/// agent-initiated `ssh`, `scp` and `sbatch` on the platform (`compute.rs`, and
/// `OPENSCIENCE_SSH_CONFIG` in `runtime.rs`). Nothing there gains anything, and
/// an ssh that rejects the options would take all of remote compute down with it.
pub fn config_path(app: &AppHandle) -> Option<PathBuf> {
    if !multiplexing_supported() {
        return None;
    }
    ensure_config(app).ok()
}

// ---- Live sessions ----

/// What the UI shows for one host. `prompt` is the server's own question,
/// verbatim; `notice` carries the non-secret lines around it (banners, "success"
/// messages) so a multi-step flow reads like the terminal would.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub host: String,
    /// "connecting" | "prompt" | "connected" | "failed"
    pub status: String,
    pub prompt: Option<String>,
    pub notice: Option<String>,
    pub error: Option<String>,
}

struct Session {
    status: String,
    prompt: Option<String>,
    notice: Option<String>,
    error: Option<String>,
    writer: Option<Box<dyn Write + Send>>,
    child: Option<Box<dyn portable_pty::Child + Send + Sync>>,
}

impl Session {
    fn info(&self, host: &str) -> SessionInfo {
        SessionInfo {
            host: host.to_string(),
            status: self.status.clone(),
            prompt: self.prompt.clone(),
            notice: self.notice.clone(),
            error: self.error.clone(),
        }
    }
}

#[derive(Default)]
pub struct SshState {
    sessions: Mutex<HashMap<String, Session>>,
}

fn snapshot(state: &SshState) -> Vec<SessionInfo> {
    let map = state.sessions.lock().unwrap();
    let mut out: Vec<SessionInfo> = map.iter().map(|(h, s)| s.info(h)).collect();
    out.sort_by(|a, b| a.host.cmp(&b.host));
    out
}

fn publish(app: &AppHandle) {
    let list = snapshot(&app.state::<SshState>());
    let _ = app.emit(STATE_EVENT, list);
}

fn set_status(app: &AppHandle, host: &str, status: &str, error: Option<String>) {
    {
        let state = app.state::<SshState>();
        let mut map = state.sessions.lock().unwrap();
        if let Some(s) = map.get_mut(host) {
            s.status = status.to_string();
            if status != "prompt" {
                s.prompt = None;
            }
            if error.is_some() {
                s.error = error;
            }
        }
    }
    publish(app);
}

/// Strip ANSI escapes and carriage returns so prompt detection sees plain text
/// (login banners and some PAM modules colour their output).
fn plain(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // CSI / OSC sequence: drop through its terminator.
            if chars.peek() == Some(&'[') {
                chars.next();
                while let Some(&n) = chars.peek() {
                    chars.next();
                    if n.is_ascii_alphabetic() {
                        break;
                    }
                }
            } else {
                chars.next();
            }
            continue;
        }
        if c != '\r' {
            out.push(c);
        }
    }
    out
}

/// The question the far end is waiting on, if any: the trailing unterminated
/// line of everything received so far, when it reads like a request for input.
///
/// Deliberately shape-based rather than a list of known prompts — a campus
/// second factor can word itself any way it likes, and the alternative is
/// silently failing on the flows nobody anticipated.
pub fn pending_prompt(text: &str) -> Option<String> {
    let text = plain(text);
    let tail = text.rsplit('\n').next()?.trim_end_matches(' ');
    let trimmed = tail.trim();
    if trimmed.is_empty() || trimmed.len() > 300 {
        return None;
    }
    let asks = trimmed.ends_with(':') || trimmed.ends_with('?') || trimmed.ends_with('>');
    if asks {
        Some(trimmed.to_string())
    } else {
        None
    }
}

/// Everything before the pending prompt, as context for the dialog: banners and
/// progress lines the server printed ("Success. Logging you in…", "Duo push
/// sent"). Bounded to the last few lines — a 40-line motd is not context.
fn notice_from(text: &str) -> Option<String> {
    let text = plain(text);
    let mut lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    // The last line is the prompt itself when one is pending.
    if pending_prompt(&text).is_some() {
        lines.pop();
    }
    let tail: Vec<&str> = lines.into_iter().rev().take(3).rev().collect();
    if tail.is_empty() {
        None
    } else {
        Some(tail.join("\n"))
    }
}

/// A PTY-hosted child plus the stream of everything it writes.
struct Pty {
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    output: Receiver<String>,
}

/// Spawn `program args…` on a pseudo-terminal. A PTY (not a pipe) is the point:
/// ssh reads authentication answers from the terminal, and refuses to read them
/// from stdin.
fn spawn_pty(program: &str, args: &[String]) -> Result<Pty, String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("could not open a terminal for ssh: {e}"))?;
    let mut cmd = CommandBuilder::new(program);
    for a in args {
        cmd.arg(a);
    }
    // ssh must not reach for a graphical askpass helper — the dialog IS the
    // askpass here, and a helper would swallow the prompt.
    cmd.env_remove("SSH_ASKPASS");
    cmd.env_remove("DISPLAY");
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("could not start ssh: {e}"))?;
    drop(pair.slave);
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("could not write to ssh: {e}"))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("could not read from ssh: {e}"))?;
    let (tx, output) = channel();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(String::from_utf8_lossy(&buf[..n]).to_string()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    Ok(Pty {
        writer,
        child,
        output,
    })
}

/// Arguments for the master connection. `-M` claims the shared channel, and the
/// ControlPath comes from the managed config so clients resolve the same socket.
/// StrictHostKeyChecking stays on: interactive sign-in must not become the place
/// where an unknown host key is accepted on the user's behalf.
fn master_args(config: &Path, host: &str) -> Vec<String> {
    vec![
        "-F".into(),
        config.to_string_lossy().to_string(),
        "-M".into(),
        "-N".into(),
        "-o".into(),
        "BatchMode=no".into(),
        "-o".into(),
        "StrictHostKeyChecking=yes".into(),
        "-o".into(),
        format!("ControlPersist={CONTROL_PERSIST}"),
        "-o".into(),
        "ConnectTimeout=20".into(),
        "-o".into(),
        "NumberOfPasswordPrompts=3".into(),
        "--".into(),
        host.into(),
    ]
}

/// Whether the shared channel for `host` is live. This — not our own bookkeeping
/// — is the truth: the master may have been established by an earlier app run,
/// or have expired while the app was asleep.
pub fn is_shared(app: &AppHandle, host: &str) -> bool {
    if !multiplexing_supported() {
        return false;
    }
    let Some(config) = config_path(app) else {
        return false;
    };
    std::process::Command::new("ssh")
        .args([
            "-F",
            &config.to_string_lossy(),
            "-O",
            "check",
            "--",
            host,
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Open (or adopt) the shared connection for `host`. Returns immediately: the
/// sign-in runs in the background and reports itself through `ssh:state`
/// events, because a second factor can take a minute of human time.
#[tauri::command]
pub fn ssh_connect(app: AppHandle, host: String) -> Result<(), String> {
    if !crate::compute::is_safe_host(&host) {
        return Err("invalid host".into());
    }
    if !multiplexing_supported() {
        return Err("connection sharing is not available on this platform".into());
    }
    // Claim the host under the lock, BEFORE any of the slow work below. A guard
    // that only ran ahead of the insert left a window as wide as `is_shared` plus
    // `openpty` plus `fork`, and two calls land inside it routinely: the UI fires
    // one for the agent's `ssh_connect` tool on the same `tool.updated` the
    // Settings card's own Connect can arrive with. Two masters then race for one
    // ControlPath — the loser continues WITHOUT sharing, so the sign-in the user
    // completes need not be the connection later commands look for — and the
    // second insert dropped the first's `Child`, which on unix does not kill it.
    {
        let state = app.state::<SshState>();
        let mut map = state.sessions.lock().unwrap();
        if let Some(s) = map.get(&host) {
            // Already signing in — a second click must not start a second ssh.
            if s.status == "connecting" || s.status == "prompt" {
                return Ok(());
            }
        }
        map.insert(
            host.clone(),
            Session {
                status: "connecting".into(),
                prompt: None,
                notice: None,
                error: None,
                writer: None,
                child: None,
            },
        );
    }
    publish(&app);
    // From here the claim must never outlive the attempt: a host left sitting in
    // "connecting" would make every later connect return early, and the sign-in
    // would be unreachable until the app restarts.
    if is_shared(&app, &host) {
        set_status(&app, &host, "connected", None);
        return Ok(());
    }
    let started = ensure_config(&app).and_then(|config| spawn_pty("ssh", &master_args(&config, &host)));
    let Pty {
        writer,
        child,
        output,
    } = match started {
        Ok(pty) => pty,
        Err(e) => {
            set_status(&app, &host, "failed", Some(e.clone()));
            return Err(e);
        }
    };
    {
        let state = app.state::<SshState>();
        let mut map = state.sessions.lock().unwrap();
        match map.get_mut(&host) {
            // Still our claim: hand it the writer, so an answer reaches THIS ssh.
            Some(s) => {
                s.writer = Some(writer);
                s.child = Some(child);
            }
            // Disconnected while we were spawning. Don't resurrect the session,
            // and don't leave its process behind.
            None => {
                let mut child = child;
                let _ = child.kill();
                return Ok(());
            }
        }
    }
    publish(&app);
    watch_master(app, host, output);
    Ok(())
}

/// Follow one master: relay its questions to the UI, notice when the shared
/// channel comes up, and report a failure with the server's own last words.
fn watch_master(app: AppHandle, host: String, output: Receiver<String>) {
    // Reader: accumulate output and surface any pending question.
    {
        let app = app.clone();
        let host = host.clone();
        std::thread::spawn(move || {
            let mut seen = String::new();
            while let Ok(chunk) = output.recv() {
                seen.push_str(&chunk);
                // Keep the buffer bounded — a chatty motd must not grow forever.
                // Cut on a char boundary: `split_off` PANICS mid-character, and
                // login banners are full of non-ASCII (box drawing, accents),
                // which would kill this thread and with it the prompt relay.
                if seen.len() > 8192 {
                    let want = seen.len() - 4096;
                    let cut = (want..=seen.len())
                        .find(|i| seen.is_char_boundary(*i))
                        .unwrap_or(seen.len());
                    seen = seen.split_off(cut);
                }
                let prompt = pending_prompt(&seen);
                let notice = notice_from(&seen);
                let state = app.state::<SshState>();
                let mut changed = false;
                {
                    let mut map = state.sessions.lock().unwrap();
                    if let Some(s) = map.get_mut(&host) {
                        if s.status == "connected" {
                            continue;
                        }
                        if s.prompt != prompt || s.notice != notice {
                            s.prompt = prompt.clone();
                            s.notice = notice;
                            s.status = if prompt.is_some() { "prompt".into() } else { s.status.clone() };
                            changed = true;
                        }
                    }
                }
                if changed {
                    publish(&app);
                }
            }
            // The PTY closed: ssh exited. Either the channel is up (the master
            // backgrounded itself) or the sign-in failed — the poller decides,
            // so only record the last words for its error message.
            let state = app.state::<SshState>();
            let mut map = state.sessions.lock().unwrap();
            if let Some(s) = map.get_mut(&host) {
                if s.error.is_none() {
                    s.error = notice_from(&seen);
                }
            }
        });
    }
    // Poller: `-O check` is the only honest answer to "is it up?".
    std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(CONNECT_TIMEOUT_SECS);
        loop {
            if is_shared(&app, &host) {
                set_status(&app, &host, "connected", None);
                return;
            }
            let dead = {
                let state = app.state::<SshState>();
                let mut map = state.sessions.lock().unwrap();
                match map.get_mut(&host) {
                    None => return, // disconnected while we waited
                    Some(s) => match s.child.as_mut() {
                        Some(c) => c.try_wait().ok().flatten().is_some(),
                        None => false,
                    },
                }
            };
            if dead {
                // One last check: ssh exits after handing the channel over.
                if is_shared(&app, &host) {
                    set_status(&app, &host, "connected", None);
                } else {
                    let msg = {
                        let state = app.state::<SshState>();
                        let map = state.sessions.lock().unwrap();
                        map.get(&host).and_then(|s| s.error.clone())
                    };
                    set_status(&app, &host, "failed", Some(msg.unwrap_or_else(|| "sign-in failed".into())));
                }
                return;
            }
            if std::time::Instant::now() >= deadline {
                set_status(&app, &host, "failed", Some("sign-in timed out".into()));
                let _ = ssh_disconnect_inner(&app, &host);
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(600));
        }
    });
}

/// Answer the pending question. The secret is written straight into the PTY and
/// dropped: it is never an argument, never logged, never stored.
#[tauri::command]
pub fn ssh_answer(app: AppHandle, host: String, secret: String) -> Result<(), String> {
    {
        let state = app.state::<SshState>();
        let mut map = state.sessions.lock().unwrap();
        let session = map.get_mut(&host).ok_or("no sign-in is in progress")?;
        let writer = session.writer.as_mut().ok_or("no sign-in is in progress")?;
        writer
            .write_all(format!("{secret}\r").as_bytes())
            .map_err(|e| format!("could not send the answer to ssh: {e}"))?;
        writer.flush().map_err(|e| e.to_string())?;
        // The question is answered; the next one (if any) arrives as output.
        session.prompt = None;
        session.status = "connecting".into();
    }
    publish(&app);
    Ok(())
}

fn ssh_disconnect_inner(app: &AppHandle, host: &str) -> Result<(), String> {
    if let Some(config) = config_path(app) {
        let _ = std::process::Command::new("ssh")
            .args(["-F", &config.to_string_lossy(), "-O", "exit", "--", host])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    let state = app.state::<SshState>();
    let mut map = state.sessions.lock().unwrap();
    if let Some(mut s) = map.remove(host) {
        if let Some(c) = s.child.as_mut() {
            let _ = c.kill();
        }
    }
    Ok(())
}

/// Close the shared connection: the next command on that host asks for a new
/// sign-in. Also the cancel path for a dialog the user dismisses.
#[tauri::command]
pub fn ssh_disconnect(app: AppHandle, host: String) -> Result<(), String> {
    ssh_disconnect_inner(&app, &host)?;
    publish(&app);
    Ok(())
}

/// Every host the app is signed in to (or trying to). Includes hosts whose
/// channel was established by an earlier app run, since `-O check` is the truth.
#[tauri::command]
pub fn ssh_sessions(app: AppHandle) -> Vec<SessionInfo> {
    snapshot(&app.state::<SshState>())
}

/// Whether this platform can share one authenticated connection at all.
#[tauri::command]
pub fn ssh_sharing_supported() -> bool {
    multiplexing_supported()
}

/// Drop every shared connection. Called on app exit: an authenticated tunnel
/// that outlives the app is a credential the user did not agree to leave behind.
pub fn shutdown(app: &AppHandle) {
    let hosts: Vec<String> = {
        let state = app.state::<SshState>();
        let map = state.sessions.lock().unwrap();
        map.keys().cloned().collect()
    };
    for host in hosts {
        let _ = ssh_disconnect_inner(app, &host);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_config_lets_the_users_own_config_win() {
        let cfg = managed_config(Path::new("/tmp/os-ssh-1"), Some(Path::new("/home/a/.ssh/config")));
        let include = cfg.find("Include").expect("includes the user's config");
        let ours = cfg.find("Host *").expect("declares the fallback block");
        // ssh keeps the FIRST value it obtains, so the user's config must be
        // read before our fallback or we would silently override their setup.
        assert!(include < ours, "the user's config must be included first");
        assert!(cfg.contains("ControlPath /tmp/os-ssh-1/%C"));
        assert!(cfg.contains("ControlMaster no"));
    }

    #[test]
    fn managed_config_without_a_user_config_still_shares() {
        let cfg = managed_config(Path::new("/tmp/os-ssh-1"), None);
        assert!(!cfg.contains("Include"));
        assert!(cfg.contains("ControlPath /tmp/os-ssh-1/%C"));
    }

    #[test]
    fn socket_paths_are_checked_against_the_platform_limit() {
        assert!(socket_path_fits(Path::new("/tmp/os-ssh-501")));
        // The budget must include ssh's temporary bind name: a 60-character
        // directory leaves room for the final "<dir>/<40-char hash>" and still
        // overruns while binding "<hash>.<16 chars>". The end-to-end test really
        // did fail there ("too long for Unix domain socket"), which on macOS is
        // every sign-in.
        let tight = PathBuf::from(format!("/tmp/{}", "x".repeat(55)));
        assert_eq!(tight.as_os_str().len(), 60);
        assert!(tight.as_os_str().len() + 1 + SOCKET_HASH_LEN < 104, "the final name fits");
        assert!(!socket_path_fits(&tight), "but not the name ssh binds first");
        // The real reason this check exists: the app data dir on macOS plus
        // ssh's 40-character hash overruns the 104-byte socket limit. So does
        // macOS's own per-user temp dir once a readable name is appended —
        // measured at 105 bytes on a real machine, which is why control_dir()
        // falls back to shorter names rather than trusting the first candidate.
        let deep = Path::new(
            "/Users/somebody/Library/Application Support/com.ai4s.workbench/runtime/ssh/sockets",
        );
        assert!(!socket_path_fits(deep));
        assert!(socket_path_fits(&control_dir()), "the chosen dir must always fit");
    }

    /// The socket dir path is derivable, so on a shared machine it must be
    /// refused unless it is ours alone — otherwise another user could sit
    /// between our clients and the authenticated master.
    #[cfg(unix)]
    #[test]
    fn a_socket_dir_someone_else_could_write_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::temp_dir().join(format!("os-ssh-test-{}", std::process::id()));
        let dir = base.join("sockets");
        std::fs::create_dir_all(&dir).unwrap();

        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(dir_is_private(&dir, &base), "owner-only is accepted");

        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(!dir_is_private(&dir, &base), "world-writable is refused");

        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o750)).unwrap();
        assert!(!dir_is_private(&dir, &base), "group-readable is refused");

        assert!(!dir_is_private(&base.join("missing"), &base));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn recognizes_the_question_a_server_is_waiting_on() {
        // The shapes real clusters use, none of them hard-coded in the matcher.
        assert_eq!(pending_prompt("Password: ").as_deref(), Some("Password:"));
        assert_eq!(
            pending_prompt("(asq@login) Passcode or option (1-3): ").as_deref(),
            Some("(asq@login) Passcode or option (1-3):")
        );
        assert_eq!(
            pending_prompt("Enter PIN+TOKENCODE: ").as_deref(),
            Some("Enter PIN+TOKENCODE:")
        );
        assert_eq!(
            pending_prompt("banner\nDuo two-factor login\n\nPasscode: ").as_deref(),
            Some("Passcode:")
        );
        // ANSI-coloured prompts are still prompts.
        assert_eq!(
            pending_prompt("\u{1b}[1;32mVerification code:\u{1b}[0m ").as_deref(),
            Some("Verification code:")
        );
    }

    #[test]
    fn ordinary_output_is_not_mistaken_for_a_question() {
        // A finished line (the shell wrote \n) is never a pending question.
        assert_eq!(pending_prompt("Success. Logging you in...\n"), None);
        assert_eq!(pending_prompt("Permission denied (publickey).\n"), None);
        assert_eq!(pending_prompt(""), None);
        assert_eq!(pending_prompt("   "), None);
        // A pasted paragraph ending in a colon is not a prompt worth asking for.
        assert_eq!(pending_prompt(&format!("{}:", "x".repeat(400))), None);
    }

    #[test]
    fn notice_carries_the_lines_around_the_question() {
        let text = "Duo two-factor login for asq\n\nEnter a passcode or select one of the following options:\n\n 1. Duo Push\n\nPasscode or option (1-3): ";
        let notice = notice_from(text).expect("has context");
        assert!(notice.contains("1. Duo Push"));
        assert!(!notice.contains("Passcode or option"), "the prompt is not repeated in the notice");
    }

    /// Read a session's output until it asks something (or time runs out).
    #[cfg(unix)]
    fn read_until_prompt(pty: &mut Pty, seen: &mut String, secs: u64) -> Option<String> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(secs);
        while std::time::Instant::now() < deadline {
            if let Some(p) = pending_prompt(seen) {
                return Some(p);
            }
            match pty.output.recv_timeout(std::time::Duration::from_millis(300)) {
                Ok(chunk) => seen.push_str(&chunk),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => break, // the child exited
            }
        }
        pending_prompt(seen)
    }

    /// The prompt relay against REAL OpenSSH, with no server and no network.
    ///
    /// `ssh-add` reads a key's passphrase the same way `ssh` reads a password or
    /// a one-time code: from the terminal, never from stdin. So an encrypted key
    /// handed to a throwaway agent reproduces the exact interaction a 2FA cluster
    /// puts us through — a real OpenSSH binary, its real prompt text, on our pty.
    /// Hermetic: its own key, its own agent, its own socket, all torn down after.
    ///
    /// The wrong-answer half is the load-bearing one: OpenSSH only rejects a
    /// passphrase it actually received, so "Bad passphrase" proves our write
    /// reached its terminal rather than being swallowed.
    #[cfg(unix)]
    #[test]
    fn real_openssh_prompts_are_relayed_and_answered() {
        let dir = std::env::temp_dir().join(format!("os-ssh-real-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let key = dir.join("id_test");
        let sock = dir.join("agent.sock");

        let keygen = std::process::Command::new("ssh-keygen")
            .args([
                "-q", "-t", "ed25519",
                "-f", &key.to_string_lossy(),
                "-N", "correct-horse-battery",
                "-C", "openscience-prompt-relay-test",
            ])
            .status();
        let Ok(status) = keygen else {
            eprintln!("skipping: ssh-keygen is unavailable");
            return;
        };
        assert!(status.success(), "ssh-keygen failed");
        let agent = std::process::Command::new("ssh-agent")
            .args(["-a", &sock.to_string_lossy()])
            .output();
        let Ok(agent) = agent else {
            eprintln!("skipping: ssh-agent is unavailable");
            return;
        };
        assert!(agent.status.success(), "ssh-agent failed to start");

        // ssh-add through a shell only to place SSH_AUTH_SOCK — the prompt still
        // comes from ssh-add itself, on the pty we opened.
        let add = |answer: &str| -> String {
            let mut pty = spawn_pty(
                "/bin/sh",
                &[
                    "-c".to_string(),
                    format!(
                        "SSH_AUTH_SOCK={} ssh-add {} 2>&1",
                        sock.to_string_lossy(),
                        key.to_string_lossy()
                    ),
                ],
            )
            .expect("spawns ssh-add on a pty");
            let mut seen = String::new();
            let prompt = read_until_prompt(&mut pty, &mut seen, 20)
                .unwrap_or_else(|| panic!("ssh-add asked nothing; it said: {seen:?}"));
            println!("real OpenSSH asked: {prompt:?}");
            assert!(
                prompt.to_lowercase().contains("passphrase") && prompt.ends_with(':'),
                "relayed verbatim: {prompt:?}"
            );
            pty.writer.write_all(format!("{answer}\r").as_bytes()).unwrap();
            pty.writer.flush().unwrap();
            // A rejected passphrase makes ssh-add re-prompt rather than exit, so
            // stop at OpenSSH's verdict instead of waiting out the deadline.
            let verdict = |text: &str| {
                let t = text.to_lowercase();
                t.contains("bad passphrase")
                    || t.contains("incorrect passphrase")
                    || t.contains("identity added")
            };
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
            while std::time::Instant::now() < deadline && !verdict(&seen) {
                match pty.output.recv_timeout(std::time::Duration::from_millis(300)) {
                    Ok(chunk) => seen.push_str(&chunk),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        if pty.child.try_wait().ok().flatten().is_some() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = pty.child.kill();
            plain(&seen)
        };

        // A wrong answer is REJECTED — which can only happen if it arrived.
        let refused = add("definitely-not-it");
        assert!(
            refused.to_lowercase().contains("bad passphrase")
                || refused.to_lowercase().contains("incorrect passphrase"),
            "OpenSSH rejected the answer it received: {refused:?}"
        );

        // The right answer is accepted, and the key really lands in the agent.
        let accepted = add("correct-horse-battery");
        assert!(
            accepted.to_lowercase().contains("identity added"),
            "OpenSSH accepted the relayed passphrase: {accepted:?}"
        );
        let listed = std::process::Command::new("ssh-add")
            .arg("-l")
            .env("SSH_AUTH_SOCK", &sock)
            .output()
            .expect("lists agent identities");
        assert!(
            String::from_utf8_lossy(&listed.stdout).contains("openscience-prompt-relay-test"),
            "the unlocked key is in the agent: {:?}",
            String::from_utf8_lossy(&listed.stdout)
        );

        let stdout = String::from_utf8_lossy(&agent.stdout);
        let agent_pid = stdout
            .split("SSH_AGENT_PID=")
            .nth(1)
            .and_then(|s| s.split(';').next())
            .unwrap_or("");
        let _ = std::process::Command::new("ssh-agent")
            .args(["-k"])
            .env("SSH_AUTH_SOCK", &sock)
            .env("SSH_AGENT_PID", agent_pid)
            .output();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// End to end against a real sshd, with no network, no root and no cluster:
    /// an OpenSSH server spoken to over a pipe (`sshd -i`, the inetd mode) with
    /// its own host key and its own authorized_keys, and an ENCRYPTED client key
    /// so the real ssh client must ask for a secret before it can authenticate.
    ///
    /// That reproduces every step a two-factor cluster puts the app through:
    ///   1. the master connection asks something on its terminal,
    ///   2. our code relays it and writes the answer back,
    ///   3. the master comes up — `ssh -O check`, exactly what `is_shared` runs,
    ///   4. a second client with NO credentials of its own still gets past
    ///      authentication, which is only possible through the shared channel.
    ///
    /// Step 4 is the property the whole feature rests on: it is why the agent's
    /// own `ssh`/`scp`/`sbatch` need no password after one sign-in.
    #[cfg(unix)]
    #[test]
    fn a_real_sshd_is_signed_in_to_once_and_then_shared() {
        let sshd = ["/usr/sbin/sshd", "/usr/lib/ssh/sshd", "/usr/sbin/openssh-sshd"]
            .iter()
            .map(Path::new)
            .find(|p| p.is_file());
        let Some(sshd) = sshd else {
            eprintln!("skipping: no sshd binary on this system");
            return;
        };
        let dir = std::env::temp_dir().join(format!("os-sshd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Sockets must stay inside the platform's path limit (see control_dir),
        // and be per-run: ssh derives the path from host/port/user, so two runs
        // would otherwise meet on the same socket.
        let sockets = PathBuf::from(format!("/tmp/osst{}", std::process::id()));
        std::fs::create_dir_all(&sockets).unwrap();

        let keygen = |path: &Path, pass: &str| {
            std::process::Command::new("ssh-keygen")
                .args([
                    "-q", "-t", "ed25519",
                    "-f", &path.to_string_lossy(),
                    "-N", pass,
                    "-C", "openscience-e2e",
                ])
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        };
        let host_key = dir.join("hostkey");
        let client_key = dir.join("client");
        const PASSPHRASE: &str = "unlock-me-please";
        if !keygen(&host_key, "") || !keygen(&client_key, PASSPHRASE) {
            eprintln!("skipping: ssh-keygen is unavailable");
            return;
        }
        std::fs::copy(dir.join("client.pub"), dir.join("authorized_keys")).unwrap();
        let sshd_config = dir.join("sshd_config");
        std::fs::write(
            &sshd_config,
            format!(
                "HostKey {}\nAuthorizedKeysFile {}\nStrictModes no\nUsePAM no\n\
                 PasswordAuthentication no\nKbdInteractiveAuthentication no\n\
                 PubkeyAuthentication yes\nPidFile none\nLogLevel ERROR\n",
                host_key.display(),
                dir.join("authorized_keys").display(),
            ),
        )
        .unwrap();

        let config = dir.join("config");
        std::fs::write(&config, managed_config(&sockets, None)).unwrap();
        let cfg = config.to_string_lossy().to_string();
        // -E: the server's own log, so its verdict (including a refusal to run
        // unprivileged) is readable instead of being lost on a shared stderr.
        let sshd_log = dir.join("sshd.log");
        let proxy = format!(
            "ProxyCommand={} -i -f {} -E {}",
            sshd.display(),
            sshd_config.display(),
            sshd_log.display()
        );
        let known = dir.join("known_hosts");
        // The current user: an unprivileged sshd can only ever authenticate the
        // account it runs as, and ssh authenticates as whoever the host string
        // names.
        let host = "localhost".to_string();
        let common = |extra: Vec<&str>| -> Vec<String> {
            let mut v: Vec<String> = vec![
                "-o".into(), proxy.clone(),
                "-o".into(), "StrictHostKeyChecking=no".into(),
                "-o".into(), format!("UserKnownHostsFile={}", known.display()),
                "-o".into(), "IdentitiesOnly=yes".into(),
            ];
            v.extend(extra.into_iter().map(str::to_string));
            v
        };

        // Pre-flight: some systems refuse a non-root sshd outright. That is an
        // environment limit, not a regression, so skip rather than fail.
        let preflight = std::process::Command::new("ssh")
            .args(common(vec![
                "-F", &cfg,
                "-o", "BatchMode=yes",
                "-o", "ConnectTimeout=8",
                "-i", &client_key.to_string_lossy(),
                "--", &host, "true",
            ]))
            .output()
            .expect("runs ssh");
        let pre = format!(
            "{}{}",
            String::from_utf8_lossy(&preflight.stderr),
            std::fs::read_to_string(&sshd_log).unwrap_or_default()
        )
        .to_lowercase();
        if pre.contains("must be run as root") || pre.contains("no such file") {
            eprintln!("skipping: this system will not run sshd unprivileged: {pre}");
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }

        // 1-3. Sign in: the master asks for the key's passphrase on its terminal,
        //      our code answers, and the shared channel comes up.
        let mut args = common(vec!["-v"]);
        args.extend(master_args(&config, &host));
        args.insert(0, "-i".into());
        args.insert(1, client_key.to_string_lossy().to_string());
        let mut pty = spawn_pty("ssh", &args).expect("spawns the master on a pty");
        let mut seen = String::new();
        let prompt = read_until_prompt(&mut pty, &mut seen, 25)
            .unwrap_or_else(|| panic!("the master asked nothing; it said: {seen:?}"));
        println!("the server's own words: {prompt:?}");
        assert!(prompt.to_lowercase().contains("passphrase"), "relayed: {prompt:?}");
        pty.writer
            .write_all(format!("{PASSPHRASE}\r").as_bytes())
            .unwrap();
        pty.writer.flush().unwrap();

        // ssh's own narration is the evidence, and it does not depend on catching
        // a socket file that may live for milliseconds: "Authenticated" proves the
        // relayed secret was accepted by a real server, and the mux listener path
        // proves client and master agree on the path our managed config computes.
        let mut authenticated = false;
        let listener_deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while std::time::Instant::now() < listener_deadline {
            if seen.contains("Authenticated to") && seen.contains("mux listener") {
                authenticated = true;
                break;
            }
            match pty.output.recv_timeout(std::time::Duration::from_millis(200)) {
                Ok(chunk) => seen.push_str(&chunk),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => break,
            }
        }
        assert!(
            authenticated,
            "the relayed answer authenticated and claimed the shared channel; ssh said: {seen:?}"
        );
        let listener = seen
            .split("mux listener [")
            .nth(1)
            .and_then(|rest| rest.split(']').next())
            .expect("ssh names the socket it listens on")
            .to_string();
        assert!(
            listener.starts_with(&sockets.to_string_lossy().to_string()),
            "the shared socket sits where the managed config says: {listener:?}"
        );

        let check = || {
            std::process::Command::new("ssh")
                .args(common(vec!["-F", &cfg, "-O", "check", "--", &host]))
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        };
        let server_gave_up = || {
            let log = std::fs::read_to_string(&sshd_log).unwrap_or_default().to_lowercase();
            log.contains("audit") || log.contains("session")
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        let mut up = false;
        while std::time::Instant::now() < deadline && !up {
            up = check();
            // No point waiting out the deadline once the server has said it
            // cannot keep the connection (the unprivileged-sshd case).
            if !up && server_gave_up() {
                break;
            }
            if let Ok(chunk) = pty.output.recv_timeout(std::time::Duration::from_millis(200)) {
                seen.push_str(&chunk);
            }
        }
        if !up {
            // An unprivileged sshd cannot create a login/audit session on macOS
            // (`bsm_audit_session_setup: setaudit_addr failed`), so it hangs up
            // right after authenticating and no master can persist. That is this
            // rig's limit, not the feature's: the sign-in above already ran end
            // to end against a real server. On Linux the rest runs for real.
            let log = std::fs::read_to_string(&sshd_log).unwrap_or_default().to_lowercase();
            let hung_up = log.contains("audit")
                || log.contains("session")
                || seen.to_lowercase().contains("closed by remote host");
            if !hung_up {
                eprintln!("sshd log said: {log}");
            }
            assert!(
                hung_up,
                "the master should either come up or say why it went away: {seen:?}"
            );
            eprintln!(
                "note: this platform's unprivileged sshd hangs up after auth, so \
                 reuse and teardown are not exercised here (see the assertion above)"
            );
            let _ = pty.child.kill();
            let _ = std::fs::remove_dir_all(&dir);
            let _ = std::fs::remove_dir_all(&sockets);
            return;
        }

        // 4. A client with NO key and NO interaction still gets past
        //    authentication — only the master can be carrying it.
        let ride = std::process::Command::new("ssh")
            .args(common(vec![
                "-F", &cfg,
                "-o", "BatchMode=yes",
                "-o", "IdentityFile=/dev/null",
                "-o", "ConnectTimeout=8",
                "--", &host, "echo shared-ok",
            ]))
            .output()
            .expect("runs a second ssh");
        let out = String::from_utf8_lossy(&ride.stdout).to_string();
        let err = String::from_utf8_lossy(&ride.stderr).to_string();
        assert!(
            !err.to_lowercase().contains("permission denied"),
            "a credential-less client is not asked to authenticate: {err:?}"
        );
        assert!(
            out.contains("shared-ok"),
            "the second client ran through the shared channel: out={out:?} err={err:?}"
        );

        // Closing it really closes it — the app's Sign out and its exit teardown.
        let exit = std::process::Command::new("ssh")
            .args(common(vec!["-F", &cfg, "-O", "exit", "--", &host]))
            .output()
            .expect("closes the master");
        assert!(exit.status.success(), "the master closes on request");
        assert!(!check(), "and is really gone afterwards");

        let _ = pty.child.kill();
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&sockets);
    }

    /// The same shape as the hermetic test above, but against a host you already
    /// have — useful to confirm a specific cluster's wording.
    /// Ignored by default. Against a host you can already ssh to:
    ///
    /// ```text
    /// OS_SSH_TEST_HOST=myhost cargo test --lib shared_connection -- --ignored --nocapture
    /// ```
    ///
    /// Against a host that authenticates interactively, give the answers in the
    /// order the server asks for them — this is the two-factor case, end to end.
    /// `scripts/dev/2fa-sshd/Dockerfile` builds exactly such a host (a password
    /// and a one-time code through PAM) and carries the full command:
    ///
    /// ```text
    /// OS_SSH_TEST_HOST=tester@localhost OS_SSH_TEST_PORT=2222 \
    ///   OS_SSH_TEST_ANSWERS='my-password;123456' \
    ///   cargo test --lib shared_connection -- --ignored --nocapture
    /// ```
    #[cfg(unix)]
    #[test]
    #[ignore = "needs a host you can already log in to — see the doc comment"]
    fn shared_connection_is_established_and_reused_without_prompting() {
        let Ok(host) = std::env::var("OS_SSH_TEST_HOST") else {
            panic!("set OS_SSH_TEST_HOST to a host you can already ssh to");
        };
        let dir = std::env::temp_dir().join(format!("os-share-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // Sockets go somewhere short — see control_dir and socket_path_fits.
        let sockets = PathBuf::from(format!("/tmp/oss-t{}", std::process::id()));
        std::fs::create_dir_all(&sockets).unwrap();
        let config = dir.join("config");
        std::fs::write(&config, managed_config(&sockets, None)).unwrap();
        let cfg = config.to_string_lossy().to_string();

        // Answers for an interactive host, in the order it asks for them.
        let answers: Vec<String> = std::env::var("OS_SSH_TEST_ANSWERS")
            .map(|v| v.split(';').map(str::to_string).collect())
            .unwrap_or_default();
        let port = std::env::var("OS_SSH_TEST_PORT").ok();
        let known = dir.join("known_hosts");
        // Command-line options are first-wins, and these come before the ones
        // master_args sets, so a test host's key can be accepted.
        let mut prefix: Vec<String> = vec![
            "-o".into(), "StrictHostKeyChecking=no".into(),
            "-o".into(), format!("UserKnownHostsFile={}", known.display()),
        ];
        if let Some(p) = &port {
            prefix.push("-p".into());
            prefix.push(p.clone());
        }
        let with_prefix = |rest: Vec<String>| -> Vec<String> {
            let mut v = prefix.clone();
            v.extend(rest);
            v
        };
        let check = || {
            std::process::Command::new("ssh")
                .args(with_prefix(
                    ["-F", &cfg, "-O", "check", "--", &host]
                        .iter()
                        .map(|s| s.to_string())
                        .collect(),
                ))
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        };
        assert!(!check(), "no shared connection to {host} yet");

        let mut pty = spawn_pty("ssh", &with_prefix(master_args(&config, &host)))
            .expect("spawns the master");
        let mut seen = String::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(90);
        let mut up = false;
        let mut next = 0usize;
        let mut answered: Option<String> = None;
        while std::time::Instant::now() < deadline && !up {
            up = check();
            if let Ok(chunk) = pty.output.recv_timeout(std::time::Duration::from_millis(300)) {
                seen.push_str(&chunk);
                // Whatever the host asks here is verbatim what the dialog shows,
                // and answering it exercises the same relay the dialog uses.
                if let Some(p) = pending_prompt(&seen) {
                    if answered.as_deref() != Some(p.as_str()) {
                        println!("step {}: {host} asked {p:?}", next + 1);
                        if next < answers.len() {
                            pty.writer
                                .write_all(format!("{}\r", answers[next]).as_bytes())
                                .unwrap();
                            pty.writer.flush().unwrap();
                            next += 1;
                            answered = Some(p);
                        }
                    }
                }
            }
        }
        if !answers.is_empty() {
            assert_eq!(
                next,
                answers.len(),
                "every scripted answer was asked for and sent; ssh said: {seen:?}"
            );
        }
        assert!(up, "the shared connection came up; ssh said: {seen:?}");
        println!("shared connection to {host} is live");

        // The property everything rests on: a client with NO credentials of its
        // own, and no way to ask for any, still gets through — the master is
        // carrying it. This is why the agent's ssh/scp/sbatch need no password
        // after one sign-in.
        let ride = std::process::Command::new("ssh")
            .args(with_prefix(
                [
                    "-F", &cfg,
                    "-o", "BatchMode=yes",
                    "-o", "IdentityFile=/dev/null",
                    "-o", "IdentitiesOnly=yes",
                    "-o", "KbdInteractiveAuthentication=no",
                    "-o", "ConnectTimeout=10",
                    "--", &host, "echo shared-ok",
                ]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            ))
            .output()
            .expect("runs a second ssh");
        let out = String::from_utf8_lossy(&ride.stdout).to_string();
        let err = String::from_utf8_lossy(&ride.stderr).to_string();
        assert!(
            !err.to_lowercase().contains("permission denied")
                && !err.to_lowercase().contains("no supported authentication"),
            "the credential-less client was never asked to authenticate: {err:?}"
        );
        // Either the command ran, or the far side answered it at the application
        // layer — a git host greets you, declines a shell, or rejects the command
        // as invalid. All of those come AFTER authentication, which is the point.
        let reached = out.contains("shared-ok")
            || ["successfully authenticated", "does not provide shell access", "invalid command"]
                .iter()
                .any(|m| err.to_lowercase().contains(m));
        assert!(
            reached,
            "the credential-less client reached the far side: out={out:?} err={err:?}"
        );
        println!("a client with no credentials rode it: out={out:?} err={err:?}");

        let exit = std::process::Command::new("ssh")
            .args(with_prefix(
                ["-F", &cfg, "-O", "exit", "--", &host]
                    .iter()
                    .map(|s| s.to_string())
                    .collect(),
            ))
            .output()
            .expect("closes the master");
        assert!(exit.status.success(), "the master closes on request");
        assert!(!check(), "and is really gone afterwards");
        println!("signing out closed it");

        let _ = pty.child.kill();
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&sockets);
    }

    // The mechanics that cannot be unit-tested through pure functions: a real
    // PTY child that asks a question, is answered, and proceeds. Driven with a
    // scripted stand-in rather than a live sshd.
    #[cfg(unix)]
    #[test]
    fn a_pty_child_can_be_prompted_and_answered() {
        let mut pty = spawn_pty(
            "/bin/sh",
            &[
                "-c".to_string(),
                "printf 'Password: '; read a; printf '\\ngot:%s\\n' \"$a\"".to_string(),
            ],
        )
        .expect("spawns a pty child");

        let mut seen = String::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while pending_prompt(&seen).is_none() && std::time::Instant::now() < deadline {
            if let Ok(chunk) = pty.output.recv_timeout(std::time::Duration::from_millis(500)) {
                seen.push_str(&chunk);
            }
        }
        assert_eq!(pending_prompt(&seen).as_deref(), Some("Password:"));

        pty.writer.write_all(b"hunter2\r").unwrap();
        pty.writer.flush().unwrap();
        while !seen.contains("got:hunter2") && std::time::Instant::now() < deadline {
            if let Ok(chunk) = pty.output.recv_timeout(std::time::Duration::from_millis(500)) {
                seen.push_str(&chunk);
            }
        }
        assert!(seen.contains("got:hunter2"), "the answer reached the child: {seen:?}");
        let _ = pty.child.kill();
    }
}
