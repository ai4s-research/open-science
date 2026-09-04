// osd — Open Science Desktop from a terminal.
//
// Two halves that share one core: `osd server` IS the workbench (workspace,
// agent runtime, web client, gateway) with no window, and everything else is a
// client of that gateway — or of the desktop app's, when one is running here.
mod args;
mod assets;
mod auth;
mod client;
mod commands;
mod server;

use args::Args;

const USAGE: &str = "\
osd — Open Science Desktop without a window

  osd server [options]              serve the workbench (web UI + API) here
  osd login --gateway U --token T   remember a gateway to talk to
  osd status                        which gateway, which workspace, which access

  osd session ls
  osd session new [--project NAME | --directory DIR] [--title T]
  osd session send <id> <prompt…> [--model provider/model] [--agent A] [--wait]
  osd session show <id>
  osd session abort <id>
  osd session rm <id>

  osd project ls
  osd project new <name>

  osd run ls
  osd run log <hash>

  osd fs ls [path]                  browse the workspace
  osd fs get <path> [--output F]    read one file

  osd model                         the default model every turn uses
  osd model ls                      what this machine can actually serve
  osd model set <provider/model>

  osd permission ls                 what the agent is waiting to be allowed
  osd permission allow|once|deny <id>
  osd approval                      whether the agent has to ask at all
  osd approval set full|approve     `full` never asks — for unattended machines

  osd auth set <provider> --key K [--model provider/model] [--base-url URL]
                          [--models id,id] [--npm PKG]
                                    provider credentials, LOCAL to this machine
                                    (--models is REQUIRED for your own endpoint:
                                    an id the runtime has no catalog entry for
                                    only loads when it lists its models)
  osd auth ls

Server options
  --port N          bind this exact port (default 4098, then any free port)
  --lan             also accept connections from the network (default: loopback)
  --token T         use this token instead of the stored/generated one
  --mode MODE       full (default) or read-only
  --workspace DIR   open on this folder
  --resources DIR   where the bundled skills/plugins live (default: next to osd)

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
        env!("CARGO_PKG_VERSION").to_string(),
    )
}

fn fail(message: &str) -> ! {
    eprintln!("osd: {message}");
    std::process::exit(1);
}
