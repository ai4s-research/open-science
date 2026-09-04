// `osd server` — the workbench with no window.
//
// Same core the desktop runs: the same workspace, the same OpenCode sidecar,
// the same gateway, the same web client. What is missing is only what needs a
// screen (local Jupyter kernels, native dialogs, the OS file manager), and the
// web client already hides those.
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use osd_core::gateway::{self, GatewayState};
use osd_core::runtime;

use crate::args::Args;
use crate::assets;

/// The port of a gateway that is recorded AND still answering — the desktop app,
/// usually. None when the record is empty or stale.
fn live_other_gateway(env: &osd_core::Env) -> Option<u16> {
    gateway::read_persisted(env)
        .port
        .filter(|p| gateway::port_is_answering(*p))
}

pub fn run(args: &Args) -> Result<(), String> {
    let env = crate::env(args)?;

    // A workspace named on the command line becomes the active one, exactly as
    // picking a folder in the app does — so `osd server --workspace ~/proj`
    // opens on that folder and the sidecar starts inside it.
    //
    // That record is shared with the desktop app, and there is exactly one of
    // it. Repointing it while the app is running moved the app's own workspace
    // out from under it — observed here: the app was left "open" on a temp
    // folder and its web client answered 500 for the session it was showing. So
    // a live gateway keeps its workspace, and this refuses instead.
    if let Some(dir) = args.value("workspace") {
        let path = PathBuf::from(&dir);
        let absolute = if path.is_absolute() {
            path
        } else {
            std::env::current_dir().map_err(|e| e.to_string())?.join(path)
        };
        let requested = absolute.to_string_lossy().to_string();
        if let Some(live) = live_other_gateway(&env) {
            let current = runtime::workspace_dir(&env)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            if current != requested {
                return Err(format!(
                    "another gateway is running on port {live} (the desktop app, or another \
                     `osd server`) and this machine has one active workspace, currently {current}. \
                     Repointing it would move that gateway's workspace too. Quit it first, or \
                     drive it instead: osd --gateway http://127.0.0.1:{live} …"
                ));
            }
        }
        runtime::set_workspace(&env, requested)?;
    }

    // Bind first, config second: everything below is written to disk, and a
    // refusal after that would leave the machine configured for a server that
    // never came up.
    let lan = args.has("lan") || matches!(args.value("host").as_deref(), Some("0.0.0.0"));
    let mode = match args.value("mode").as_deref() {
        None | Some("full") => "full".to_string(),
        Some("read-only") => "read-only".to_string(),
        Some(other) => return Err(format!("unknown --mode {other:?} (full or read-only)")),
    };

    // The token is stored (it has to survive a restart, and a client on this
    // machine finds it there); the binding and the access mode are this run's
    // and are NOT written over the desktop app's own settings.
    let token = gateway::ensure_token(&env, args.value("token"))?;
    let mut persisted = gateway::read_persisted(&env);
    persisted.token = token.clone();
    persisted.lan = lan;
    persisted.mode = mode.clone();
    let requested_port = args
        .value("port")
        .map(|p| p.parse::<u16>().map_err(|_| format!("invalid --port {p:?}")))
        .transpose()?;

    // The desktop app and every `osd server` on this machine share one runtime
    // root, so a second server means a second OpenCode on the same session
    // database. Measured on 1.18.18 that works — both read and write, and each
    // sees the other's sessions — but it is not a configuration anyone should
    // land in by accident, so say it plainly instead of leaving them to wonder
    // which server their CLI just talked to.
    if let Some(other) = live_other_gateway(&env).filter(|p| Some(*p) != requested_port) {
        eprintln!(
            "note: another gateway is already running on port {other} (the desktop app, or \
             another `osd server`). They share one workspace and one session database, and it \
             keeps the recorded address — reach THIS server with an explicit \
             --gateway http://127.0.0.1:<port below>."
        );
    }

    let state = GatewayState::new(Arc::new(assets::Embedded), None);

    if !env.resource_dir().is_dir() {
        eprintln!(
            "note: no bundled resources at {} — skills, the goal plugin and the agent \
             harness will be missing. Point at them with --resources.",
            env.resource_dir().display()
        );
    }

    // Watch the active folder for changes made outside this process — which,
    // headless, is nearly all of them: the agent's own writes go through
    // OpenCode's tools, not ours. Without this the workspace gets no git
    // history at all here, since the per-write snapshot is driven by the
    // desktop client (see the provenance note in the README).
    match runtime::workspace_dir(&env) {
        Ok(dir) => osd_core::git_snapshot::watch_workspace(&dir),
        Err(e) => eprintln!("note: could not watch the workspace for changes: {e}"),
    }

    // The sidecar first, so the gateway never answers a request with "runtime
    // not started" during the first seconds.
    eprintln!("Starting the agent runtime…");
    let sidecar = runtime::start_runtime(&env)?;

    // From here on the sidecar is OURS to clean up: it is a separate process, so
    // returning an error without killing it (a port already in use is the easy
    // way to hit this) would leave an OpenCode running with nothing driving it.
    let port = match gateway::start_at(&env, &state, &persisted, requested_port) {
        Ok(port) => port,
        Err(e) => {
            runtime::kill_child(env.runtime());
            return Err(e);
        }
    };
    let workspace = match runtime::workspace_dir(&env) {
        Ok(dir) => dir,
        Err(e) => {
            gateway::shutdown(&env, &state);
            runtime::kill_child(env.runtime());
            return Err(e);
        }
    };

    if assets::is_empty() {
        eprintln!("note: this build carries no web client; /v1 is served, / is not.");
    }
    println!("Open Science Desktop — headless\n");
    println!("  workspace   {}", workspace.display());
    println!("  runtime     {sidecar}");
    println!("  access      {mode}");
    println!("  url         http://{}:{port}", if lan { "0.0.0.0" } else { "127.0.0.1" });
    if lan {
        if let Some(ip) = local_ip() {
            println!("  on the LAN  http://{ip}:{port}/?token={token}");
        }
    }
    println!("  token       {token}");
    println!("\nOpen the URL with ?token=<token>, or point a CLI at it:");
    println!("  osd --gateway http://127.0.0.1:{port} --token {token} session ls");
    println!("\nCtrl-C to stop.");

    wait_for_shutdown();

    eprintln!("\nStopping…");
    gateway::shutdown(&env, &state);
    runtime::kill_child(env.runtime());
    Ok(())
}

/// Block until the process is asked to stop.
///
/// Both platforms do the same thing for the same reason: the handler sets a
/// flag and the normal shutdown path runs, so the sidecar is always killed by
/// US rather than left to whatever the OS does to a process group.
///
/// On Unix the sidecar shares this process group, so a terminal Ctrl-C reaches
/// it anyway — but a `kill` (systemd, a supervisor, `nohup`) does not.
///
/// On Windows nothing can be assumed about the child receiving the console
/// event at all: the sidecar is spawned with `CREATE_NO_WINDOW` (the desktop
/// needs that — a console-subsystem child otherwise flashes a black window per
/// spawn, #114), and a process created that way does not share this console.
/// Without the handler below, Ctrl-C would end `osd` and leave an OpenCode
/// running with the port and the session database still open.
fn wait_for_shutdown() {
    static STOP: AtomicBool = AtomicBool::new(false);

    #[cfg(unix)]
    {
        extern "C" fn on_signal(_: i32) {
            STOP.store(true, Ordering::Relaxed);
        }
        // SAFETY: the handler touches nothing but an atomic, which is
        // async-signal-safe. Installing it is the documented use of signal(2).
        unsafe {
            libc::signal(libc::SIGINT, on_signal as *const () as libc::sighandler_t);
            libc::signal(libc::SIGTERM, on_signal as *const () as libc::sighandler_t);
        }
    }

    #[cfg(windows)]
    {
        // kernel32 is linked by every MSVC target, so this needs no crate.
        extern "system" {
            fn SetConsoleCtrlHandler(
                handler: Option<unsafe extern "system" fn(u32) -> i32>,
                add: i32,
            ) -> i32;
        }
        // Returning TRUE means "handled": Windows then does NOT terminate us,
        // so the loop below gets to stop the gateway and kill the sidecar.
        // Covers Ctrl-C, Ctrl-Break and the console being closed.
        unsafe extern "system" fn on_console_event(_event: u32) -> i32 {
            STOP.store(true, Ordering::Relaxed);
            1
        }
        // SAFETY: a plain FFI call; the handler only stores to an atomic.
        unsafe {
            SetConsoleCtrlHandler(Some(on_console_event), 1);
        }
    }

    while !STOP.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// The LAN IP this machine would use to reach the internet — found without
/// sending a packet (a UDP connect just picks the route).
fn local_ip() -> Option<String> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("8.8.8.8:80").ok()?;
    s.local_addr().ok().map(|a| a.ip().to_string())
}

