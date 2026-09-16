// What the status bar's right-hand segments report, borrowed from Orca's
// (`CaffeinateStatusSegment`, `ResourceUsageStatusSegment`, `PortsStatusSegment`).
//
// The common rule, and the reason these are worth having: everything reported
// here is scoped to THIS APP'S OWN PROCESS TREE. A workbench spawns a lot —
// an agent runtime, shells, Python kernels, a browser sidecar, whatever those
// start in turn — and the question a status bar answers is "what is my work
// costing, and what has it opened", not "what is this machine doing". A
// machine-wide figure would be someone else's number in your window.
use std::collections::{HashMap, HashSet};
use std::process::{Child, Stdio};
use std::sync::Mutex;

use serde::Serialize;

/// One process in this app's tree.
#[derive(Debug, Clone, PartialEq)]
pub struct ProcessRow {
    pub pid: u32,
    pub ppid: u32,
    /// Resident set size in kilobytes, as `ps` reports it.
    pub rss_kb: u64,
    /// Percent of one core, as `ps` reports it.
    pub cpu: f64,
    pub command: String,
}

/// Parse `ps -Ao pid=,ppid=,rss=,pcpu=,comm=` output.
///
/// Hand-parsed rather than via a crate: the columns are fixed, the command can
/// contain spaces (so it is the remainder of the line, never split), and a
/// dependency that shells out to the same `ps` would buy nothing.
pub fn parse_ps(output: &str) -> Vec<ProcessRow> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parts.next()?.parse().ok()?;
            let ppid = parts.next()?.parse().ok()?;
            let rss_kb = parts.next()?.parse().ok()?;
            let cpu = parts.next()?.parse().ok()?;
            // The rest of the line, spaces and all.
            let consumed = line
                .split_whitespace()
                .take(4)
                .fold(0, |at, field| line[at..].find(field).map(|i| at + i + field.len()).unwrap_or(at));
            let command = line[consumed..].trim().to_string();
            Some(ProcessRow { pid, ppid, rss_kb, cpu, command })
        })
        .collect()
}

/// Every descendant of `root`, plus `root` itself.
///
/// Walks children rather than parents: a shell's own children (a build, a dev
/// server) are exactly the processes the workbench is responsible for, and they
/// are what makes the difference between a quiet window and a hot laptop.
pub fn tree_of(rows: &[ProcessRow], root: u32) -> Vec<&ProcessRow> {
    let mut children: HashMap<u32, Vec<&ProcessRow>> = HashMap::new();
    for row in rows {
        children.entry(row.ppid).or_default().push(row);
    }
    let mut out: Vec<&ProcessRow> = rows.iter().filter(|r| r.pid == root).collect();
    let mut frontier = vec![root];
    let mut seen: HashSet<u32> = [root].into_iter().collect();
    while let Some(pid) = frontier.pop() {
        for child in children.get(&pid).into_iter().flatten() {
            // A pid cycle cannot happen on a healthy system, but a reused pid
            // between the read and the walk could; `seen` makes it terminate.
            if seen.insert(child.pid) {
                out.push(child);
                frontier.push(child.pid);
            }
        }
    }
    out
}

/// One thing the user opened, and what it is costing.
///
/// Borrowed from Orca's resource popover, which lists a row per session rather
/// than one total: a workbench at 12 GB tells you it is heavy, and a row per
/// terminal tells you WHICH pane to go and look at. Without the breakdown the
/// number is a complaint you cannot act on.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceGroup {
    /// "terminal" | "kernel" | "app" — what the renderer should call it.
    pub kind: String,
    /// The terminal's pane id, or the kernel's notebook path. Empty for `app`.
    pub id: String,
    /// The process's own name, for a row that has nothing better to show.
    pub label: String,
    pub memory_bytes: u64,
    pub cpu_percent: f64,
    pub process_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceUsage {
    /// Resident memory of this app and everything it started, in bytes.
    pub memory_bytes: u64,
    /// How many processes that is.
    pub process_count: usize,
    pub cpu_percent: f64,
    /// Heaviest first, so the row worth acting on is the first one read.
    pub groups: Vec<ResourceGroup>,
}

/// Split the app's process tree into the things the user actually opened.
///
/// `owners` maps a pid to (kind, id). Everything under an owner's pid belongs
/// to it — a shell's build, a kernel's subprocess — and whatever is left is the
/// app itself.
pub fn group_usage(
    rows: &[ProcessRow],
    root: u32,
    owners: &HashMap<u32, (String, String)>,
) -> Vec<ResourceGroup> {
    let mut groups = Vec::new();
    let mut claimed: HashSet<u32> = HashSet::new();
    for (pid, (kind, id)) in owners {
        let tree = tree_of(rows, *pid);
        if tree.is_empty() {
            continue;
        }
        for row in &tree {
            claimed.insert(row.pid);
        }
        groups.push(ResourceGroup {
            kind: kind.clone(),
            id: id.clone(),
            // The DEEPEST child's name, not the shell's: a terminal running a
            // build should read as the build, which is what is costing.
            label: heaviest(&tree).command.clone(),
            memory_bytes: tree.iter().map(|r| r.rss_kb * 1024).sum(),
            cpu_percent: tree.iter().map(|r| r.cpu).sum(),
            process_count: tree.len(),
        });
    }
    // Everything not owned by a terminal or a kernel is the app itself: the
    // window, the agent runtime, the sidecars.
    let rest: Vec<&ProcessRow> = tree_of(rows, root)
        .into_iter()
        .filter(|r| !claimed.contains(&r.pid))
        .collect();
    if !rest.is_empty() {
        groups.push(ResourceGroup {
            kind: "app".into(),
            id: String::new(),
            label: String::new(),
            memory_bytes: rest.iter().map(|r| r.rss_kb * 1024).sum(),
            cpu_percent: rest.iter().map(|r| r.cpu).sum(),
            process_count: rest.len(),
        });
    }
    groups.sort_by(|a, b| b.memory_bytes.cmp(&a.memory_bytes));
    groups
}

/// The process in a group using the most memory — the one worth naming.
fn heaviest<'a>(tree: &[&'a ProcessRow]) -> &'a ProcessRow {
    tree.iter().copied().max_by_key(|r| r.rss_kb).expect("a group is never empty")
}

/// What this app and its children are currently using, and what each part of it
/// is.
///
/// `spawn_blocking`, not the async runtime: this shells out to `ps`, and a
/// blocking wait on an async worker thread holds a slot every other command
/// queues behind — including the keystrokes going to a terminal.
#[tauri::command]
pub async fn system_resources(
    terminals: tauri::State<'_, crate::terminal::TerminalState>,
    kernels: tauri::State<'_, crate::kernel::KernelState>,
) -> Result<ResourceUsage, String> {
    // The pids are read from the app's own state, on this thread; only the
    // process table walk moves off it.
    let mut owners: HashMap<u32, (String, String)> = HashMap::new();
    for (id, pid) in crate::terminal::pids(&terminals) {
        owners.insert(pid, ("terminal".to_string(), id));
    }
    for (key, pid) in crate::kernel::pids(&kernels) {
        owners.insert(pid, ("kernel".to_string(), key));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let rows = read_processes()?;
        let tree = tree_of(&rows, std::process::id());
        Ok(ResourceUsage {
            memory_bytes: tree.iter().map(|r| r.rss_kb * 1024).sum(),
            process_count: tree.len(),
            cpu_percent: tree.iter().map(|r| r.cpu).sum(),
            groups: group_usage(&rows, std::process::id(), &owners),
        })
    })
    .await
    .map_err(|e| format!("could not read the process list: {e}"))?
}

fn read_processes() -> Result<Vec<ProcessRow>, String> {
    let out = crate::runtime::quiet_command("ps")
        .args(["-Ao", "pid=,ppid=,rss=,pcpu=,comm="])
        .output()
        .map_err(|e| format!("could not read the process list: {e}"))?;
    Ok(parse_ps(&String::from_utf8_lossy(&out.stdout)))
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListeningPort {
    pub port: u16,
    pub pid: u32,
    pub command: String,
    /// True when the socket is bound to a public interface rather than to
    /// loopback — the difference between "my dev server" and "the network can
    /// reach this".
    pub public: bool,
}

/// Parse `lsof -nP -iTCP -sTCP:LISTEN -F pcn` output.
///
/// The `-F` machine format is one field per line, prefixed by its letter, and
/// grouped: a `p` line starts a process, `c` names it, and each following `n`
/// is one socket of that process. Parsing the human table instead would mean
/// guessing at column widths.
pub fn parse_lsof(output: &str, own: &HashSet<u32>) -> Vec<ListeningPort> {
    let mut ports = Vec::new();
    let mut pid = 0u32;
    let mut command = String::new();
    for line in output.lines() {
        let (tag, rest) = line.split_at(line.char_indices().nth(1).map_or(line.len(), |(i, _)| i));
        match tag {
            "p" => pid = rest.parse().unwrap_or(0),
            "c" => command = rest.to_string(),
            "n" => {
                if !own.contains(&pid) {
                    continue;
                }
                let Some((host, port)) = rest.rsplit_once(':') else { continue };
                let Ok(port) = port.parse::<u16>() else { continue };
                let public = !(host.starts_with("127.") || host == "[::1]" || host == "localhost");
                // One entry per port: a server listening on both stacks reports
                // the same port twice, which reads as two servers.
                if !ports.iter().any(|p: &ListeningPort| p.port == port) {
                    ports.push(ListeningPort { port, pid, command: command.clone(), public });
                }
            }
            _ => {}
        }
    }
    ports.sort_by_key(|p| p.port);
    ports
}

/// TCP ports this app's own processes are listening on.
///
/// `spawn_blocking` for the same reason as `system_resources`, and more so:
/// `lsof` can take seconds on a busy machine, and holding an async worker for
/// that long makes the whole app feel wedged.
#[tauri::command]
pub async fn listening_ports() -> Result<Vec<ListeningPort>, String> {
    tauri::async_runtime::spawn_blocking(read_listening_ports)
        .await
        .map_err(|e| format!("could not list ports: {e}"))?
}

fn read_listening_ports() -> Result<Vec<ListeningPort>, String> {
    let rows = read_processes()?;
    let own: HashSet<u32> = tree_of(&rows, std::process::id())
        .iter()
        .map(|r| r.pid)
        .collect();
    let out = crate::runtime::quiet_command("lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"])
        // lsof complains loudly about directories it cannot stat; the ports it
        // did find are still in stdout.
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("could not list ports: {e}"))?;
    Ok(parse_lsof(&String::from_utf8_lossy(&out.stdout), &own))
}

/// The `caffeinate` process holding the machine awake, if any.
#[derive(Default)]
pub struct AwakeState(pub Mutex<Option<Child>>);

/// Hold the machine awake, or let it sleep again.
///
/// Borrowed from Orca's `MacosSystemSleepAssertion`, including its arguments:
/// `-i` prevents idle sleep and `-s` prevents system sleep on AC power, which
/// is what "an agent is working, don't sleep" actually requires. Asking twice
/// is a no-op rather than a second process.
#[tauri::command(async)]
pub fn awake_hold(state: tauri::State<'_, AwakeState>, on: bool) -> Result<bool, String> {
    let mut held = state.0.lock().map_err(|_| "awake state poisoned")?;
    if on {
        if held.is_some() {
            return Ok(true);
        }
        if !cfg!(target_os = "macos") {
            return Err("keeping the machine awake needs macOS".into());
        }
        let child = crate::runtime::quiet_command("/usr/bin/caffeinate")
            .args(["-i", "-s"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("could not start caffeinate: {e}"))?;
        *held = Some(child);
        return Ok(true);
    }
    release(&mut held);
    Ok(false)
}

#[tauri::command]
pub fn awake_active(state: tauri::State<'_, AwakeState>) -> bool {
    state.0.lock().map(|held| held.is_some()).unwrap_or(false)
}

fn release(held: &mut Option<Child>) {
    if let Some(mut child) = held.take() {
        let _ = child.kill();
        // Killed children must be reaped or they linger as zombies — the same
        // rule the kernel processes follow.
        let _ = child.wait();
    }
}

/// Let the machine sleep again — the app is quitting.
pub fn shutdown(state: &AwakeState) {
    if let Ok(mut held) = state.0.lock() {
        release(&mut held);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_process_table_including_commands_with_spaces() {
        let rows = parse_ps(" 501   1  4096  12.5 /Applications/Open Science.app/Contents/MacOS/x\n 502 501  2048 0.0 zsh\n");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].pid, 501);
        assert_eq!(rows[0].rss_kb, 4096);
        assert_eq!(rows[0].cpu, 12.5);
        assert_eq!(rows[0].command, "/Applications/Open Science.app/Contents/MacOS/x");
        assert_eq!(rows[1].command, "zsh");
    }

    #[test]
    fn ignores_lines_that_are_not_processes() {
        // The header, when a `ps` variant prints one despite the `=` suffixes.
        assert!(parse_ps("  PID  PPID   RSS  %CPU COMMAND\n").is_empty());
    }

    fn row(pid: u32, ppid: u32, rss_kb: u64) -> ProcessRow {
        ProcessRow { pid, ppid, rss_kb, cpu: 0.0, command: format!("p{pid}") }
    }

    #[test]
    fn a_tree_is_the_app_and_everything_it_started() {
        let rows = vec![row(1, 0, 1), row(10, 1, 100), row(11, 10, 10), row(12, 11, 5), row(99, 1, 999)];
        let tree = tree_of(&rows, 10);
        let pids: Vec<u32> = tree.iter().map(|r| r.pid).collect();
        // The grandchild counts — a shell's build is the workbench's cost too —
        // and a sibling of the app does not.
        assert_eq!(pids, vec![10, 11, 12]);
        assert!(!pids.contains(&99));
    }

    #[test]
    fn a_reused_pid_cannot_wedge_the_walk() {
        // A child claiming its own parent as a child: terminates rather than
        // looping for ever.
        let rows = vec![row(10, 1, 1), row(11, 10, 1), row(10, 11, 1)];
        assert_eq!(tree_of(&rows, 10).len(), 3);
    }

    #[test]
    fn attributes_a_subtree_to_the_thing_that_opened_it() {
        // 10 = the app, 20 = a terminal's shell running a 2 GB build,
        // 30 = a notebook kernel, and the window itself is what is left.
        let rows = vec![
            row(10, 1, 200_000),
            row(20, 10, 4_000),
            row(21, 20, 2_000_000),
            row(30, 10, 500_000),
        ];
        let owners = HashMap::from([
            (20, ("terminal".to_string(), "p7".to_string())),
            (30, ("kernel".to_string(), "python:/ws/a.ipynb".to_string())),
        ]);
        let groups = group_usage(&rows, 10, &owners);

        // Heaviest first: the row worth acting on is the first one read.
        assert_eq!(groups[0].kind, "terminal");
        assert_eq!(groups[0].id, "p7");
        assert_eq!(groups[0].memory_bytes, (4_000 + 2_000_000) * 1024);
        // Named after the heaviest process in it, not the shell — a terminal
        // running a build should read as the build.
        assert_eq!(groups[0].label, "p21");
        assert_eq!(groups[1].kind, "kernel");
        // What is left over is the app: its own window and the agent runtime,
        // never double-counted with the rows above.
        let app = groups.iter().find(|g| g.kind == "app").unwrap();
        assert_eq!(app.memory_bytes, 200_000 * 1024);
        assert_eq!(groups.iter().map(|g| g.memory_bytes).sum::<u64>(), 2_704_000 * 1024);
    }

    #[test]
    fn an_owner_that_has_already_exited_is_not_a_row() {
        // A terminal closed between the pid read and the process scan.
        let rows = vec![row(10, 1, 100)];
        let owners = HashMap::from([(20, ("terminal".to_string(), "gone".to_string()))]);
        let groups = group_usage(&rows, 10, &owners);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].kind, "app");
    }

    #[test]
    fn reads_the_ports_this_app_opened() {
        let out = "p900\ncjupyter\nn127.0.0.1:8888\np901\ncnode\n";
        let own = HashSet::from([900]);
        let ports = parse_lsof(out, &own);
        assert_eq!(ports.len(), 1);
        assert_eq!(ports[0], ListeningPort {
            port: 8888,
            pid: 900,
            command: "jupyter".into(),
            public: false,
        });
    }

    #[test]
    fn leaves_other_programs_ports_alone() {
        // Somebody else's Postgres is not this workbench's business.
        let out = "p42\ncpostgres\nn*:5432\n";
        assert!(parse_lsof(out, &HashSet::from([900])).is_empty());
    }

    #[test]
    fn says_which_ports_the_network_can_reach() {
        let out = "p900\ncvite\nn127.0.0.1:5173\np900\ncvite\nn*:4000\n";
        let ports = parse_lsof(out, &HashSet::from([900]));
        assert_eq!(ports.iter().map(|p| (p.port, p.public)).collect::<Vec<_>>(), vec![(4000, true), (5173, false)]);
    }

    #[test]
    fn one_entry_per_port_however_many_stacks_it_binds() {
        // A server on both IPv4 and IPv6 is one server.
        let out = "p900\ncnode\nn127.0.0.1:3000\np900\ncnode\nn[::1]:3000\n";
        assert_eq!(parse_lsof(out, &HashSet::from([900])).len(), 1);
    }
}
