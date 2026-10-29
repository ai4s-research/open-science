// osd — Open Science Desktop from a terminal.
//
// Two halves that share one core: `osd server` IS the workbench (workspace,
// agent runtime, web client, gateway) with no window, and everything else is a
// client of that gateway — or of the desktop app's, when one is running here.
mod args;
mod assets;
mod account;
mod auth;
mod client;
mod commands;
mod screens;
mod server;
mod settings;

use args::Args;

const USAGE: &str = "\
osd — Open Science Desktop without a window

  osd server [options]              serve the workbench (web UI + API) here
  osd login --gateway U --token T   remember a gateway to talk to
  osd status                        which gateway, which workspace, which access

  osd session ls
  osd session new [--project NAME | --directory DIR] [--title T]
  osd session send <id> <prompt…> [--model provider/model] [--agent A] [--wait]
  osd session show <id> [--last N]  the conversation, or its last N turns
  osd session status <id>           working or idle
  osd session wait <id>             until its current turn ends (whoever started
                                    it), then its answer
  osd session find <words…>         the conversations that mention them
  osd session rename <id> <title…>
  osd session archive|unarchive <id>
  osd session move <id> --project NAME
  osd session abort <id>
  osd session rm <id>

  osd screen ls                     every Screen and what is in it: sessions,
                                    terminals (and the agent in each), with
                                    the ids the other commands take
  osd screen new [SESSION_ID…] [--sessions N] [--terminals N [--run CMD]]
                 [--name NAME] [--project NAME | --directory DIR]
                                    a new Screen, split evenly among its panes
                                    (--sessions starts new conversations;
                                    --run is typed into each new terminal)
  osd screen add <SCREEN> [SESSION_ID | --new | --terminal [--run CMD]]
                                    one more pane, beside the others
  osd screen add --here [SESSION_ID | --new | --terminal [--run CMD]]
                                    one more pane, right of the one you are in
  osd screen show <SCREEN>          bring it up in the desktop window
  osd screen close <SCREEN>         close it (the conversations are kept)
  osd term read <id> [--turns N] [--lines N]
                                    what a terminal is doing: the agent's own
                                    conversation (Claude Code, Codex), or a
                                    shell's recent output
  osd term send <id> <text…> [--wait] [--no-enter] [--timeout S]
                                    type into it (Enter included); --wait
                                    returns the agent's reply
  osd term key <id> <key…>          press keys, for menus and dialogs: up down
                                    left right enter esc tab shift-tab space
                                    backspace ctrl-c ctrl-d, or one character

  osd audit [--account NAME] [--session ID] [--action A] [--since 2026-10-01]
            [--until DATE] [--limit N]
                                    who did what through the gateway (the
                                    desktop's owner only): messages, deletions,
                                    terminal input, sign-ins

  osd project ls
  osd project new <name>

  osd run ls
  osd run log <hash>

  osd fs ls [path]                  browse the workspace
  osd fs get <path> [--output F]    read one file
  osd fs put <file> [--session ID | --directory DIR] [--name N]
                                    put a file into a session's folder

  osd settings [--json]             the desktop's settings and their values
  osd settings set KEY=VALUE… --reason R [--no-wait]
                                    ask the user to change them: one request,
                                    approved in the Open Science window
  osd settings status <id>          the user's decision on a request

  osd model                         the default model every turn uses
  osd model ls                      what this machine can actually serve
  osd model set <provider/model>

  osd permission ls [--session ID]  what an agent is waiting to be allowed
  osd permission allow|once|deny <id> [--session ID]
  osd question ls [--session ID]    what an agent asked and is waiting on
  osd question answer <id> <answer…> one per question: an option or your words
  osd question reject <id>          let it go on without an answer
  osd approval                      whether the agent has to ask at all
  osd approval set full|approve     `full` never asks — for unattended machines

  osd auth set <provider> --key K [--model provider/model] [--base-url URL]
                          [--models id,id] [--npm PKG]
                                    provider credentials, LOCAL to this machine
                                    (--models is REQUIRED for your own endpoint:
                                    an id the runtime has no catalog entry for
                                    only loads when it lists its models)
  osd auth ls

  osd account ls                    who can sign in to the web client
  OSD_PASSWORD=… osd account add <name>   add one, or set a new password
  osd account rm <name>

Server options
  --port N          bind this exact port (default 4098, then any free port)
  --lan             also accept connections from the network (default: loopback)
  --token T         use this token instead of the stored/generated one
  --mode MODE       full (default) or read-only
  --workspace DIR   open on this folder
  --resources DIR   where the bundled skills/plugins live (default: next to osd)
  --state-dir DIR   keep this instance's state (sessions, sidecar, workspace
                    record) under DIR (also: OSD_STATE_DIR)

Common options
  --gateway URL     the gateway to talk to (else OSD_GATEWAY, the stored login,
                    or a gateway already running on this machine)
  --token TOKEN     its access token (else OSD_TOKEN, or the stored login)
  --json            print the API's own reply, for scripts
";

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let args = match Args::parse(argv) {
        Ok(a) => a,
        Err(e) => fail(&e),
    };
    if args.command.is_empty() || args.command == "help" || args.has("help") {
        print!("{USAGE}");
        return;
    }
    let result = match args.command.as_str() {
        "server" | "serve" => server::run(&args),
        "auth" => auth::run(&args),
        "account" => account::run(&args),
        // Internal: the desktop app's terminal host (osd-core termd.rs), which
        // the app starts on its own. Not in USAGE.
        "termd" => termd(&args),
        "version" | "--version" => {
            println!("osd {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        _ => commands::run(&args),
    };
    if let Err(e) = result {
        fail(&e);
    }
}

/// Where `osd` keeps its data and finds its bundled resources. Shared by the
/// server and by `osd auth`, which both work on this machine's own files.
pub fn env(args: &Args) -> Result<osd_core::Env, String> {
    osd_core::Env::headless(
        args.value("resources").map(std::path::PathBuf::from),
        args.value("state-dir").map(std::path::PathBuf::from),
        env!("CARGO_PKG_VERSION").to_string(),
    )
}

fn fail(message: &str) -> ! {
    eprintln!("osd: {message}");
    std::process::exit(1);
}

/// The terminal host. Its own session first, so nothing aimed at the app's
/// terminal or process group (a hangup, a Ctrl-C) reaches the shells it holds.
fn termd(args: &Args) -> Result<(), String> {
    let dir = args.value("dir").ok_or("termd needs --dir")?;
    #[cfg(unix)]
    unsafe {
        libc::setsid();
    }
    osd_core::termd::serve(std::path::Path::new(&dir))
}
