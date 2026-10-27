// Signing Claude Code and Codex in as more than one account, and starting them
// as one (`osd_core::agent_accounts` keeps the folders).
//
// The sign-in is the agent's own: `claude auth login` or `codex login`, run in
// the new account's folder. This app never sees a password or a token; it
// relays what the command prints (the sign-in link, a prompt for a code) and
// reads back who ended up signed in. Starting an agent as an account checks
// that again, so a folder whose login expired or changed fails loudly instead
// of running as someone else.
use std::collections::HashMap;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use osd_core::agent_accounts::{self, Account, AgentKind, Identity};
use tauri::{AppHandle, Emitter, Manager};

const LINE_EVENT: &str = "agent-login:line";
const DONE_EVENT: &str = "agent-login:done";

/// Long enough to open the link in another browser and sign in there.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const STATUS_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginLine {
    login_id: String,
    line: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginDone {
    login_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    account: Option<Account>,
    /// `duplicate-default`, `duplicate`, `not-signed-in` or `failed`; the UI
    /// words it.
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'static str>,
    /// The email of a duplicate, or the agent's own last words on a failure.
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

struct Login {
    kind: AgentKind,
    child: Child,
    stdin: Option<ChildStdin>,
}

#[derive(Default)]
pub struct AccountsState {
    logins: Mutex<HashMap<String, Login>>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountsView {
    /// Who the agent's own folder is signed in as; None when no one is or it
    /// could not be read.
    default: Option<Identity>,
    accounts: Vec<Account>,
}

fn data_dir(app: &AppHandle) -> PathBuf {
    crate::env_of(app).data_dir().to_path_buf()
}

/// The agent's command with the user's PATH and the app's proxy, as a terminal
/// would run it.
fn agent_command(app: &AppHandle, kind: AgentKind, home: Option<&Path>) -> std::process::Command {
    let mut cmd = crate::runtime::quiet_command(kind.binary());
    cmd.env("PATH", crate::runtime::enriched_path());
    for (k, v) in crate::runtime::sidecar_proxy_env(app) {
        cmd.env(k, v);
    }
    if let Some(home) = home {
        let (set, unset) = agent_accounts::launch_env(kind, home);
        for (k, v) in set {
            cmd.env(k, v);
        }
        for k in unset {
            cmd.env_remove(k);
        }
    }
    cmd
}

/// Run a short command and return its stdout, killing it if it hangs.
fn output_within(mut cmd: std::process::Command, limit: Duration) -> Result<String, String> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let reader = std::thread::spawn(move || {
        let mut out = String::new();
        let _ = stdout.read_to_string(&mut out);
        out
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < limit => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("the agent did not answer".into());
            }
        }
    }
    Ok(reader.join().unwrap_or_default())
}

/// Who a folder is signed in as. `home` None is the agent's own default.
fn identity(app: &AppHandle, kind: AgentKind, home: Option<&Path>) -> Option<Identity> {
    match kind {
        AgentKind::Claude => {
            let mut cmd = agent_command(app, kind, home);
            cmd.args(["auth", "status", "--json"]);
            agent_accounts::parse_claude_status(&output_within(cmd, STATUS_TIMEOUT).ok()?)
        }
        AgentKind::Codex => {
            let folder = match home {
                Some(h) => h.to_path_buf(),
                None => kind.default_home().ok()?,
            };
            agent_accounts::codex_identity(&folder)
        }
    }
}

#[tauri::command]
pub async fn agent_accounts(app: AppHandle, kind: String) -> Result<AccountsView, String> {
    let kind = AgentKind::parse(&kind)?;
    tauri::async_runtime::spawn_blocking(move || AccountsView {
        default: identity(&app, kind, None),
        accounts: agent_accounts::list(&data_dir(&app), kind),
    })
    .await
    .map_err(|e| e.to_string())
}

/// Start signing a new account in. Returns the login's id; what the command
/// prints arrives as `agent-login:line` and the outcome as `agent-login:done`.
#[tauri::command]
pub fn agent_account_login(app: AppHandle, kind: String) -> Result<String, String> {
    let kind = AgentKind::parse(&kind)?;
    let data = data_dir(&app);
    let (id, home) = agent_accounts::create(&data, kind)?;
    let mut cmd = agent_command(&app, kind, Some(&home));
    match kind {
        // One way through, the same for every account: the user opens the
        // printed link (a private window for a second account) and pastes
        // back the code it shows, hence stdin stays open. Claude Code would
        // otherwise open the default browser itself, where the account
        // already signed in would answer.
        AgentKind::Claude => {
            #[cfg(unix)]
            cmd.env("BROWSER", "true");
            cmd.args(["auth", "login", "--claudeai"])
        }
        AgentKind::Codex => cmd.args(["login"]),
    };
    let mut child = match cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            let _ = agent_accounts::remove(&data, kind, &id);
            return Err(format!("could not start {}: {e}", kind.binary()));
        }
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdin = child.stdin.take();
    app.state::<AccountsState>()
        .logins
        .lock()
        .unwrap()
        .insert(id.clone(), Login { kind, child, stdin });

    let last_said = Arc::new(Mutex::new(String::new()));
    for stream in [stdout.map(|s| Box::new(s) as Box<dyn Read + Send>), stderr.map(|s| Box::new(s) as Box<dyn Read + Send>)]
        .into_iter()
        .flatten()
    {
        let app = app.clone();
        let login_id = id.clone();
        let last_said = last_said.clone();
        std::thread::spawn(move || relay_lines(&app, &login_id, stream, &last_said));
    }

    let app2 = app.clone();
    let login_id = id.clone();
    std::thread::spawn(move || finish_login(app2, login_id, kind, home, last_said));
    Ok(id)
}

/// Relay output by line, and by prompt: "Paste code here if prompted >" has no
/// newline and is exactly the line that matters.
fn relay_lines(app: &AppHandle, login_id: &str, stream: Box<dyn Read + Send>, last_said: &Mutex<String>) {
    let mut reader = BufReader::new(stream);
    let mut buf = Vec::new();
    let mut byte = [0u8; 1];
    let emit = |buf: &mut Vec<u8>| {
        let line = String::from_utf8_lossy(buf).trim().to_string();
        buf.clear();
        if !line.is_empty() {
            // The last thing it said that is not a prompt or a link: on a
            // failure, that is the reason ("Invalid code", an OAuth error).
            if !line.ends_with('>') && !line.contains("https://") {
                *last_said.lock().unwrap() = line.clone();
            }
            let _ = app.emit(LINE_EVENT, LoginLine { login_id: login_id.to_string(), line });
        }
    };
    loop {
        match reader.read(&mut byte) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                buf.push(byte[0]);
                if byte[0] == b'\n' || (byte[0] == b'>' && reader.buffer().is_empty()) {
                    emit(&mut buf);
                }
            }
        }
    }
    emit(&mut buf);
}

/// Wait for the sign-in command, then keep the account only if someone new is
/// signed in.
fn finish_login(app: AppHandle, login_id: String, kind: AgentKind, home: PathBuf, last_said: Arc<Mutex<String>>) {
    let started = Instant::now();
    let ended = loop {
        let state = app.state::<AccountsState>();
        let mut logins = state.logins.lock().unwrap();
        let Some(login) = logins.get_mut(&login_id) else {
            break false; // cancelled: the canceller cleans up
        };
        match login.child.try_wait() {
            Ok(Some(_)) => {
                logins.remove(&login_id);
                break true;
            }
            Ok(None) if started.elapsed() < LOGIN_TIMEOUT => {}
            _ => {
                if let Some(mut login) = logins.remove(&login_id) {
                    let _ = login.child.kill();
                    let _ = login.child.wait();
                }
                break true;
            }
        }
        drop(logins);
        std::thread::sleep(Duration::from_millis(200));
    };
    if !ended {
        return;
    }
    let data = data_dir(&app);
    let outcome: Result<Account, (&'static str, Option<String>)> = match identity(&app, kind, Some(&home)) {
        None => {
            let said = last_said.lock().unwrap().clone();
            Err(("not-signed-in", (!said.is_empty()).then_some(said)))
        }
        Some(who) => {
            let others = agent_accounts::list(&data, kind);
            let default = identity(&app, kind, None);
            if default.as_ref().is_some_and(|d| d.same_account(&who)) {
                Err(("duplicate-default", who.email.clone()))
            } else if others.iter().any(|a| a.identity.same_account(&who)) {
                Err(("duplicate", who.email.clone()))
            } else {
                let account = Account { id: login_id.clone(), kind, identity: who, added_at_ms: now_ms() };
                agent_accounts::save(&data, &account).map(|()| account).map_err(|e| ("failed", Some(e)))
            }
        }
    };
    let done = match outcome {
        Ok(account) => LoginDone { login_id, account: Some(account), error: None, detail: None },
        Err((error, detail)) => {
            discard(&app, kind, &login_id);
            LoginDone { login_id, account: None, error: Some(error), detail }
        }
    };
    let _ = app.emit(DONE_EVENT, done);
}

/// Type into the sign-in command: the code a browser showed.
#[tauri::command]
pub fn agent_account_login_input(app: AppHandle, login_id: String, text: String) -> Result<(), String> {
    let state = app.state::<AccountsState>();
    let mut logins = state.logins.lock().unwrap();
    let stdin = logins
        .get_mut(&login_id)
        .and_then(|l| l.stdin.as_mut())
        .ok_or("this sign-in has ended")?;
    stdin
        .write_all(format!("{}\n", text.trim()).as_bytes())
        .and_then(|()| stdin.flush())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agent_account_login_cancel(app: AppHandle, login_id: String) -> Result<(), String> {
    let removed = app.state::<AccountsState>().logins.lock().unwrap().remove(&login_id);
    if let Some(mut login) = removed {
        let _ = login.child.kill();
        let _ = login.child.wait();
        discard(&app, login.kind, &login_id);
    }
    Ok(())
}

#[tauri::command]
pub fn agent_account_remove(app: AppHandle, kind: String, id: String) -> Result<(), String> {
    let kind = AgentKind::parse(&kind)?;
    discard(&app, kind, &id);
    Ok(())
}

/// Delete an account's folder and, on macOS, Claude Code's keychain entry for
/// it: the login lives there, not in the folder.
fn discard(app: &AppHandle, kind: AgentKind, id: &str) {
    let data = data_dir(app);
    #[cfg(target_os = "macos")]
    if kind == AgentKind::Claude {
        if let Ok(home) = agent_accounts::home_dir(&data, kind, id) {
            let _ = crate::runtime::quiet_command("security")
                .args(["delete-generic-password", "-s", &agent_accounts::claude_keychain_service(&home)])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
    let _ = agent_accounts::remove(&data, kind, id);
}

/// The environment that starts an agent as this account, after checking the
/// folder is still signed in as the account it was added as. Called before
/// every start: a login that expired, or was replaced in a terminal, must not
/// quietly run the conversation as someone else.
pub fn launch_env(app: &AppHandle, kind: AgentKind, id: &str) -> Result<agent_accounts::LaunchEnv, String> {
    let data = data_dir(app);
    let account = agent_accounts::find(&data, kind, id)?;
    let home = agent_accounts::home_dir(&data, kind, id)?;
    agent_accounts::prepare(kind, &home)?;
    let label = account.identity.email.clone().unwrap_or_else(|| id.to_string());
    match identity(app, kind, Some(&home)) {
        Some(now) if now.same_account(&account.identity) => {}
        // No email to compare (a Codex login kept in the keyring): signed in is
        // the most that can be checked.
        Some(_) if account.identity.email.is_none() => {}
        Some(now) => {
            return Err(format!(
                "The account {label} is now signed in as {}. Remove it in Settings → Agents and add it again.",
                now.email.unwrap_or_default()
            ))
        }
        None => {
            return Err(format!(
                "{label} is signed out. Sign it in again in Settings → Agents, or pick another account."
            ))
        }
    }
    Ok(agent_accounts::launch_env(kind, &home))
}

/// The folder an account runs in, for a terminal resuming its conversation.
#[tauri::command]
pub fn agent_account_home(app: AppHandle, kind: String, id: String) -> Result<String, String> {
    let kind = AgentKind::parse(&kind)?;
    let data = data_dir(&app);
    agent_accounts::find(&data, kind, &id)?;
    Ok(agent_accounts::home_dir(&data, kind, &id)?.display().to_string())
}

/// Kill every sign-in still waiting when the app exits.
pub fn shutdown(app: &AppHandle) {
    let logins: Vec<(String, Login)> = app.state::<AccountsState>().logins.lock().unwrap().drain().collect();
    for (id, mut login) in logins {
        let _ = login.child.kill();
        let _ = login.child.wait();
        discard(app, login.kind, &id);
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
