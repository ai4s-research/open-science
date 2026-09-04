// Supervising ACP agent children (#14, client direction).
//
// `AcpRuntime` (packages/sdk) speaks the Agent Client Protocol over an injected
// LINE transport and deliberately never spawns anything: the webview has no
// `child_process`, and the gateway web client — a phone — has no local process
// at all. So the child lives here, beside the OpenCode sidecar, and its stdio is
// relayed to the frontend as Tauri events.
//
// Safety (AGENTS.md): starting an agent IS command execution, so nothing here
// ever starts one on its own. A child appears only when the user has configured
// that command in Settings and asked for it, it runs in the active workspace
// folder and nowhere else, and every child is killed when the app exits — an
// agent process outliving the window would keep model access the user thinks
// they closed.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

/// One line of agent stdout, relayed to the frontend. The payload carries the
/// agent id because several agents can be configured and running at once.
const LINE_EVENT: &str = "acp:line";
/// The child ended — the frontend fails every pending request rather than
/// waiting forever on an answer that can never come.
const EXIT_EVENT: &str = "acp:exit";

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpLine {
    pub agent_id: String,
    pub line: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpExit {
    pub agent_id: String,
    /// Why it ended, in the child's own words when it left any — an auth
    /// failure or "command not found" is the whole diagnostic value.
    pub reason: String,
}

struct Agent {
    child: Child,
    stdin: ChildStdin,
    logged_stdin: bool,
}

#[derive(Default)]
pub struct AcpState {
    agents: Mutex<HashMap<String, Agent>>,
}

impl AcpState {
    /// Wait until a registered child exits and remove exactly that entry.
    ///
    /// Returning `None` means another path stopped and removed the child.
    fn wait_for_exit(&self, agent_id: &str) -> Option<String> {
        loop {
            {
                let mut agents = self.agents.lock().unwrap();
                let status = match agents.get_mut(agent_id) {
                    None => return None,
                    Some(agent) => match agent.child.try_wait() {
                        Ok(Some(status)) => Some(match status.code() {
                            Some(code) => format!("code {code}"),
                            None => "a signal".to_string(),
                        }),
                        Ok(None) => None,
                        Err(_) => Some("an unknown status".to_string()),
                    },
                };
                if let Some(how) = status {
                    agents.remove(agent_id);
                    return Some(how);
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
    }
}

fn exit_reason(command: &str, how: &str, detail: &str) -> String {
    if detail.is_empty() {
        format!("{command} exited ({how})")
    } else {
        let tail: String = detail
            .chars()
            .rev()
            .take(500)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        format!("{command} exited ({how}): {tail}")
    }
}

/// Split whatever whole lines `buffer` now holds, leaving any trailing partial
/// line behind.
///
/// A read boundary lands mid-message routinely, and handing half a JSON object
/// to the peer would drop the message it belongs to — the frontend's transport
/// contract is whole lines.
pub(crate) fn take_lines(buffer: &mut String) -> Vec<String> {
    let mut out = Vec::new();
    while let Some(at) = buffer.find('\n') {
        let line: String = buffer.drain(..=at).collect();
        out.push(line.trim_end_matches(['\n', '\r']).to_string());
    }
    out
}

/// Start `command args…` as an ACP agent in the active workspace folder.
///
/// Idempotent per `agent_id`: a second call while one is running is a no-op, so
/// a double click cannot leave an orphan child holding a model session.
#[tauri::command]
pub fn acp_start(
    app: AppHandle,
    agent_id: String,
    command: String,
    args: Vec<String>,
) -> Result<(), String> {
    if command.trim().is_empty() {
        return Err("an ACP agent needs a command to run".into());
    }
    {
        let state = app.state::<AcpState>();
        let mut agents = state.agents.lock().unwrap();
        if let Some(existing) = agents.get_mut(&agent_id) {
            // Still alive? Then this call has nothing to do. A child that has
            // exited is cleared so the next start really starts one.
            match existing.child.try_wait() {
                Ok(None) => return Ok(()),
                _ => {
                    agents.remove(&agent_id);
                }
            }
        }
    }
    let cwd = crate::runtime::workspace_dir(&app)?;
    // quiet_command: an ACP agent is a console-subsystem binary, and a console
    // window opening beside the app for it is noise the user never asked for.
    let mut child = crate::runtime::quiet_command(&command)
        .args(&args)
        .current_dir(&cwd)
        // GUI-launched apps get a minimal PATH; an ACP agent is usually a node
        // or cargo binary the user installed, so give it the real one.
        .env("PATH", crate::runtime::enriched_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start {command}: {e}"))?;

    let stdout = child.stdout.take().ok_or("the agent has no stdout")?;
    let stderr = child.stderr.take().ok_or("the agent has no stderr")?;
    let stdin = child.stdin.take().ok_or("the agent has no stdin")?;
    let pid = child.id();

    // Reader: relay whole lines. stdout is the protocol; nothing is interpreted
    // here, which is the point — the wire format belongs to the SDK.
    {
        let app = app.clone();
        let id = agent_id.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut buffer = String::new();
            let mut saw_output = false;
            loop {
                let mut chunk = Vec::new();
                match reader.read_until(b'\n', &mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        buffer.push_str(&String::from_utf8_lossy(&chunk));
                        for line in take_lines(&mut buffer) {
                            if line.is_empty() {
                                continue;
                            }
                            if !saw_output {
                                crate::debug_log::append(
                                    &app,
                                    &format!(
                                        "[acp] first stdout line pid={pid} bytes={}",
                                        line.len()
                                    ),
                                );
                                saw_output = true;
                            }
                            let _ = app.emit(
                                LINE_EVENT,
                                AcpLine {
                                    agent_id: id.clone(),
                                    line,
                                },
                            );
                        }
                    }
                }
            }
        });
    }
    // stderr is NOT protocol — agents log to it freely — so it is kept only as
    // the reason the child ended, which is where it is actually diagnostic.
    let last_error = std::sync::Arc::new(Mutex::new(String::new()));
    {
        let sink = last_error.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut held = sink.lock().unwrap();
                held.push_str(&line);
                held.push('\n');
                // Keep the tail only: a chatty agent must not grow this forever.
                if held.len() > 2000 {
                    let cut = held.len() - 1000;
                    let at = (cut..=held.len())
                        .find(|i| held.is_char_boundary(*i))
                        .unwrap_or(held.len());
                    *held = held.split_off(at);
                }
            }
        });
    }
    // Publish the child before its waiter starts. A process can exit immediately;
    // starting the waiter first would let it observe a missing map entry and leave
    // the frontend waiting for a response that can never arrive.
    app.state::<AcpState>().agents.lock().unwrap().insert(
        agent_id.clone(),
        Agent {
            child,
            stdin,
            logged_stdin: false,
        },
    );
    crate::debug_log::append(&app, &format!("[acp] child started pid={pid}"));

    // Waiter: one exit event, so the frontend can fail pending requests instead
    // of hanging on a process that is gone.
    {
        let app = app.clone();
        let id = agent_id.clone();
        let command = command.clone();
        std::thread::spawn(move || {
            let Some(how) = app.state::<AcpState>().wait_for_exit(&id) else {
                return;
            };
            let detail = last_error.lock().unwrap().trim().to_string();
            crate::debug_log::append(&app, &format!("[acp] child exited pid={pid} status={how}"));
            let reason = exit_reason(&command, &how, &detail);
            let _ = app.emit(
                EXIT_EVENT,
                AcpExit {
                    agent_id: id,
                    reason,
                },
            );
        });
    }
    Ok(())
}

/// Write one already-framed line to the agent's stdin.
#[tauri::command]
pub fn acp_send(app: AppHandle, agent_id: String, line: String) -> Result<(), String> {
    let state = app.state::<AcpState>();
    let mut agents = state.agents.lock().unwrap();
    let agent = agents
        .get_mut(&agent_id)
        .ok_or("that agent is not running")?;
    let pid = agent.child.id();
    // The frontend frames its own messages; a missing newline would merge two
    // JSON-RPC messages into one unparseable line.
    let payload = if line.ends_with('\n') {
        line
    } else {
        format!("{line}\n")
    };
    agent
        .stdin
        .write_all(payload.as_bytes())
        .map_err(|e| format!("could not write to the agent: {e}"))?;
    agent.stdin.flush().map_err(|e| e.to_string())?;
    if !agent.logged_stdin {
        crate::debug_log::append(
            &app,
            &format!("[acp] first stdin write pid={pid} bytes={}", payload.len()),
        );
        agent.logged_stdin = true;
    }
    Ok(())
}

/// Stop one agent. The next start gets a fresh process.
#[tauri::command]
pub fn acp_stop(app: AppHandle, agent_id: String) -> Result<(), String> {
    let state = app.state::<AcpState>();
    let removed = state.agents.lock().unwrap().remove(&agent_id);
    if let Some(mut agent) = removed {
        let _ = agent.child.kill();
        let _ = agent.child.wait();
    }
    Ok(())
}

/// Which agents are running right now — the truth after a webview reload, which
/// loses every JS-side handle while the children keep running.
#[tauri::command]
pub fn acp_running(app: AppHandle) -> Vec<String> {
    let state = app.state::<AcpState>();
    let mut agents = state.agents.lock().unwrap();
    let mut live = Vec::new();
    for (id, agent) in agents.iter_mut() {
        if matches!(agent.child.try_wait(), Ok(None)) {
            live.push(id.clone());
        }
    }
    live
}

/// Kill every agent. Called on app exit: an agent process that outlives the
/// window keeps model access the user believes they closed.
pub fn shutdown(app: &AppHandle) {
    let ids: Vec<String> = {
        let state = app.state::<AcpState>();
        let agents = state.agents.lock().unwrap();
        agents.keys().cloned().collect()
    };
    for id in ids {
        let _ = acp_stop(app.clone(), id);
    }
}

#[cfg(test)]
mod tests {
    use std::io::{BufReader, Read};
    use std::process::{Command, Stdio};

    use super::{exit_reason, take_lines, AcpState, Agent};

    #[test]
    fn an_immediately_exiting_registered_child_reports_its_stderr() {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--definitely-invalid-acp-test-flag")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stderr = child.stderr.take().unwrap();
        let stdin = child.stdin.take().unwrap();
        let stderr_reader = std::thread::spawn(move || {
            let mut detail = String::new();
            BufReader::new(stderr).read_to_string(&mut detail).unwrap();
            detail
        });

        let state = AcpState::default();
        state.agents.lock().unwrap().insert(
            "instant".into(),
            Agent {
                child,
                stdin,
                logged_stdin: false,
            },
        );

        let how = state.wait_for_exit("instant").unwrap();
        let detail = stderr_reader.join().unwrap();
        let reason = exit_reason("test-agent", &how, detail.trim());

        assert!(reason.starts_with("test-agent exited (code "));
        assert!(!detail.trim().is_empty());
        assert!(reason.contains(detail.trim()));
        assert!(!state.agents.lock().unwrap().contains_key("instant"));
    }

    #[test]
    fn whole_lines_are_taken_and_a_partial_one_is_kept() {
        // The read boundary lands mid-message routinely; handing half a JSON
        // object to the peer would drop the message it belongs to.
        let mut buf = String::from("{\"a\":1}\n{\"b\":2}\n{\"c\":");
        assert_eq!(take_lines(&mut buf), vec!["{\"a\":1}", "{\"b\":2}"]);
        assert_eq!(buf, "{\"c\":");
        // The rest arrives and completes it.
        buf.push_str("3}\n");
        assert_eq!(take_lines(&mut buf), vec!["{\"c\":3}"]);
        assert!(buf.is_empty());
    }

    #[test]
    fn carriage_returns_are_stripped_and_nothing_is_taken_without_a_newline() {
        let mut buf = String::from("{\"a\":1}\r\n");
        assert_eq!(take_lines(&mut buf), vec!["{\"a\":1}"]);
        let mut partial = String::from("no newline yet");
        assert!(take_lines(&mut partial).is_empty());
        assert_eq!(partial, "no newline yet");
    }
}
