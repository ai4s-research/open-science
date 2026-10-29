// `osd settings`: read the desktop's settings, and ask the user to change them.
//
// The window answers both. A change is never made from here: it becomes a
// request the user approves in the window, all of it or some of it, after
// reading the reason. This holds for a person at a shell as much as for an
// agent — the window is where the owner is.
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use crate::args::Args;
use crate::client::Client;

/// `osd settings [--json]`: every setting, grouped by its section.
pub fn ls(args: &Args) -> Result<(), String> {
    let client = Client::connect(args)?;
    let v = client.get("/v1/settings")?;
    if args.has("json") {
        println!("{}", serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?);
        return Ok(());
    }
    let mut section = "";
    for s in v["settings"].as_array().into_iter().flatten() {
        let here = s["section"].as_str().unwrap_or("");
        if here != section {
            section = here;
            println!("{section}");
        }
        let key = s["key"].as_str().unwrap_or("?");
        let value = shown(&s["value"]);
        let choices = s["options"].as_array().map(|o| {
            let o: Vec<String> = o.iter().map(shown).collect();
            format!(" ({})", o.join(" | "))
        });
        println!("  {key:<26} {value:<10} {}{}", s["label"].as_str().unwrap_or(""), choices.unwrap_or_default());
    }
    println!("\nChange with: osd settings set KEY=VALUE [KEY=VALUE…] --reason \"why\"");
    Ok(())
}

fn shown(v: &Value) -> String {
    match v {
        Value::Bool(true) => "on".into(),
        Value::Bool(false) => "off".into(),
        Value::String(s) if s.is_empty() => "(empty)".into(),
        Value::String(s) => s.clone(),
        Value::Null => "(unset)".into(),
        other => other.to_string(),
    }
}

/// `KEY=VALUE` pairs, as typed. The window knows each setting's type and
/// reads the value as that.
pub fn changes(pairs: &[String]) -> Result<Map<String, Value>, String> {
    let mut out = Map::new();
    for p in pairs {
        let (k, v) = p
            .split_once('=')
            .filter(|(k, _)| !k.trim().is_empty())
            .ok_or_else(|| format!("{p:?} is not KEY=VALUE"))?;
        out.insert(k.trim().to_string(), json!(v.trim()));
    }
    if out.is_empty() {
        return Err("nothing to change: osd settings set KEY=VALUE [KEY=VALUE…] --reason \"why\"".into());
    }
    Ok(out)
}

/// `osd settings set KEY=VALUE… --reason R [--no-wait]`
pub fn set(args: &Args) -> Result<(), String> {
    request(args, changes(&args.positional)?)
}

/// Ask for `changes`, then (unless --no-wait) wait for the user's decision.
pub fn request(args: &Args, changes: Map<String, Value>) -> Result<(), String> {
    // The gateway asks for the reason (after checking there is a window to
    // ask), so a headless machine answers "no window" rather than "say why".
    let reason = args.value("reason").unwrap_or_default();
    let client = Client::connect(args)?;
    let made = client.post("/v1/settings/requests", json!({ "changes": changes, "reason": reason }))?;
    let id = made["id"].as_str().ok_or("the gateway gave no request id")?.to_string();
    if args.has("no-wait") {
        println!("Asked the user ({id}). Their decision: osd settings status {id}");
        return Ok(());
    }
    println!("Waiting for the user to decide in the Open Science window…");
    let decided = wait(args, &id)?;
    report(&decided)
}

/// `osd settings status <id>`
pub fn status(args: &Args) -> Result<(), String> {
    let id = args.at(0, "request id")?;
    let client = Client::connect(args)?;
    report(&client.get(&format!("/v1/settings/requests/{id}"))?)
}

/// Poll until the request is no longer pending. Turning a setting on can
/// restart the gateway (LAN), so a failed poll reconnects for a while.
fn wait(args: &Args, id: &str) -> Result<Value, String> {
    let mut client = Client::connect(args)?;
    let mut unreachable_since: Option<Instant> = None;
    loop {
        match client.get(&format!("/v1/settings/requests/{id}")) {
            Ok(v) if v["status"] != "pending" => return Ok(v),
            Ok(_) => unreachable_since = None,
            Err(e) => {
                let since = *unreachable_since.get_or_insert_with(Instant::now);
                if since.elapsed() > Duration::from_secs(30) {
                    return Err(e);
                }
                if let Ok(c) = Client::connect(args) {
                    client = c;
                }
            }
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

fn report(v: &Value) -> Result<(), String> {
    let list = |k: &str| -> Vec<String> {
        v[k].as_array().into_iter().flatten().filter_map(|x| x.as_str().map(str::to_string)).collect()
    };
    match v["status"].as_str().unwrap_or("") {
        "pending" => {
            println!("Still waiting for the user.");
            Ok(())
        }
        "approved" => {
            let (applied, declined) = (list("applied"), list("declined"));
            println!("Approved: {}", applied.join(", "));
            if !declined.is_empty() {
                println!("Declined: {}", declined.join(", "));
            }
            for (k, e) in v["failed"].as_object().into_iter().flatten() {
                println!("Failed: {k}: {}", e.as_str().unwrap_or(""));
            }
            Ok(())
        }
        "denied" => Err("the user declined. Do not ask again unless they bring it up.".into()),
        "expired" => Err("the user did not decide within 15 minutes; the request lapsed".into()),
        "superseded" => Err("a newer request from this conversation replaced this one".into()),
        "invalid" => Err(v["error"].as_str().unwrap_or("the window refused the request").to_string()),
        other => Err(format!("unexpected answer {other:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairs_are_key_equals_value() {
        let c = changes(&["remote.terminal=on".into(), " theme = dark ".into()]).unwrap();
        assert_eq!(c["remote.terminal"], "on");
        assert_eq!(c["theme"], "dark");
        assert!(changes(&["terminal".into()]).is_err());
        assert!(changes(&["=on".into()]).is_err());
        assert!(changes(&[]).is_err());
    }

    #[test]
    fn a_decision_reads_as_what_happened() {
        assert!(report(&json!({ "status": "approved", "applied": ["a"], "declined": ["b"] })).is_ok());
        assert!(report(&json!({ "status": "denied" })).is_err());
        assert!(report(&json!({ "status": "expired" })).is_err());
    }
}
