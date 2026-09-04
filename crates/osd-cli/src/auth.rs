// `osd auth` — provider credentials, written where the agent runtime reads them.
//
// This is the ONE command that never goes through the gateway. An API key must
// not cross the network (AGENTS.md), and the gateway enforces that by refusing
// every config write and redacting every config read — so on a headless box the
// key is set HERE, on the machine that will use it, and stays there. The other
// way in is the environment: the sidecar inherits this process's environment, so
// `ANTHROPIC_API_KEY=… osd server` works with nothing written to disk at all,
// which is what a container or a systemd unit wants.
use osd_core::runtime;

use crate::args::Args;

pub fn run(args: &Args) -> Result<(), String> {
    match args.sub.as_str() {
        "set" | "login" => set(args),
        "ls" | "list" => list(args),
        "" => Err("usage: osd auth set <provider> --key <api-key> [--model <provider/model>]".into()),
        other => Err(format!("unknown command `osd auth {other}`")),
    }
}

/// Model ids from a comma-separated `--models`, blanks dropped.
fn model_ids(raw: Option<String>) -> Vec<String> {
    raw.unwrap_or_default()
        .split(',')
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .collect()
}

fn set(args: &Args) -> Result<(), String> {
    let provider = args.at(0, "provider")?;
    // Reading the key from the environment keeps it out of the shell history,
    // which is where a pasted `--key` would otherwise live forever.
    let key = match args.value("key") {
        Some(k) => k,
        None => std::env::var("OSD_API_KEY").map_err(|_| {
            "no key: pass --key <api-key>, or set OSD_API_KEY to keep it out of your \
             shell history"
                .to_string()
        })?,
    };
    if key.trim().is_empty() {
        return Err("the API key is empty".into());
    }
    let env = crate::env(args)?;
    let model = args.value("model").unwrap_or_default();
    let base_url = args.value("base-url");
    let models = model_ids(args.value("models"));
    runtime::configure_opencode(
        &env,
        provider.clone(),
        key,
        model,
        base_url.clone(),
        args.value("npm"),
        &models,
    )?;
    println!("Saved the {provider} key for this machine.");
    // A base URL with no model list is the one combination that writes an entry
    // OpenCode may drop on the floor: an id it has no catalog entry for needs
    // `models` to load at all, and saying nothing here is how a headless box
    // ends up with a provider that was "saved" and never appears (#119).
    if base_url.is_some() && models.is_empty() {
        println!(
            "If `{provider}` is your own endpoint rather than a known provider, add \
             --models <id,id> — without it the runtime has no models to offer and \
             ignores the entry."
        );
    }
    // The agent runtime reads its config at startup, and this process is not
    // the one running it. Saying so beats the user concluding the key was
    // ignored when the next turn still fails.
    if osd_core::gateway::read_persisted(&env).port.is_some() {
        println!("A server is running here — restart it for the key to take effect.");
    }
    if args.value("model").is_none() {
        println!("Pick a default model with --model <provider/model>, or per turn with `osd session send --model`.");
    }
    Ok(())
}

fn list(args: &Args) -> Result<(), String> {
    let env = crate::env(args)?;
    let providers = runtime::configured_providers(&env)?;
    if providers.is_empty() {
        println!("No providers configured. Set one with `osd auth set <provider> --key <api-key>`,");
        println!("or export its API key before starting the server — the runtime inherits it.");
        return Ok(());
    }
    // Names only. The keys themselves are never printed, by anything, ever.
    for p in providers {
        println!("{p}");
    }
    Ok(())
}
