// Screens, and the sessions and terminals in them.
//
// `osd screen ls` is how an agent finds what else is running here: every
// Screen's panes with what each one is, where it works and the id the other
// commands take. The token sees the desktop window's Screens; an account sees
// its own.
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::args::Args;
use crate::client::Client;

/// One pane, as `osd screen ls` reports it.
#[derive(Debug, PartialEq)]
pub enum Pane {
    Session { pane: String, id: String, title: Option<String>, directory: Option<String> },
    /// `shell` is the id `osd term` takes, when it is knowable from here: a
    /// desktop pane's shell is named after the pane, a browser's is not.
    Terminal { pane: String, shell: Option<String>, name: Option<String>, cwd: Option<String>, agent: Option<String> },
    Other { pane: String, kind: String },
}

pub struct Screen {
    pub id: String,
    pub name: String,
    pub panes: Vec<Pane>,
}

fn leaves<'a>(node: &'a Value, out: &mut Vec<&'a Value>) {
    match node["kind"].as_str() {
        Some("leaf") => out.push(node),
        Some("split") => {
            for child in node["children"].as_array().into_iter().flatten() {
                leaves(child, out);
            }
        }
        _ => {}
    }
}

fn agent_name(kind: &str) -> String {
    match kind {
        "claude" => "Claude Code".into(),
        "codex" => "Codex".into(),
        other => other.into(),
    }
}

/// The Screens of a saved layout, with sessions named from `sessions` (the
/// `/v1/sessions` list). `desktop`: the layout is the desktop window's, whose
/// shells carry their pane's id.
pub fn screens_of(layout: &Value, sessions: &Value, desktop: bool) -> Vec<Screen> {
    let session = |id: &str| sessions.as_array().into_iter().flatten().find(|s| s["id"].as_str() == Some(id));
    let text = |v: &Value| v.as_str().filter(|s| !s.trim().is_empty()).map(str::to_string);
    let mut out = Vec::new();
    for (i, g) in layout["groups"].as_array().into_iter().flatten().enumerate() {
        let mut ls = Vec::new();
        leaves(&g["tree"], &mut ls);
        let panes: Vec<Pane> = ls
            .into_iter()
            .map(|l| {
                let pane = l["id"].as_str().unwrap_or("?").to_string();
                let c = &l["content"];
                match c["kind"].as_str() {
                    Some("terminal") => Pane::Terminal {
                        shell: desktop.then(|| pane.clone()),
                        pane,
                        name: text(&c["name"]),
                        cwd: text(&c["cwd"]),
                        agent: c["agent"]["kind"].as_str().map(agent_name),
                    },
                    Some(kind) => Pane::Other { pane, kind: kind.to_string() },
                    None if l["artifact"].is_object() => Pane::Other { pane, kind: "artifact".into() },
                    None => match l["sessionId"].as_str() {
                        Some(id) => {
                            let s = session(id);
                            Pane::Session {
                                pane,
                                id: id.to_string(),
                                title: s.and_then(|s| text(&s["title"])),
                                directory: s.and_then(|s| text(&s["directory"])),
                            }
                        }
                        None => Pane::Other { pane, kind: "draft".into() },
                    },
                }
            })
            .collect();
        // Unnamed, a Screen is called what its first pane holds — as in the app.
        let first = panes.iter().find_map(|p| match p {
            Pane::Session { title, .. } => title.clone(),
            Pane::Terminal { name, agent, .. } => name.clone().or_else(|| agent.clone()).or_else(|| Some("Terminal".into())),
            Pane::Other { kind, .. } if kind != "draft" && kind != "artifact" => Some(kind.clone()),
            Pane::Other { .. } => None,
        });
        let name = text(&g["name"]).or(first).unwrap_or_else(|| format!("Screen {}", i + 1));
        out.push(Screen { id: g["id"].as_str().unwrap_or("?").to_string(), name, panes });
    }
    out
}

fn pane_json(p: &Pane) -> Value {
    match p {
        Pane::Session { pane, id, title, directory } => {
            json!({ "pane": pane, "kind": "session", "session": id, "title": title, "directory": directory })
        }
        Pane::Terminal { pane, shell, name, cwd, agent } => {
            json!({ "pane": pane, "kind": "terminal", "shell": shell, "name": name, "cwd": cwd, "agent": agent })
        }
        Pane::Other { pane, kind } => json!({ "pane": pane, "kind": kind }),
    }
}

/// The layout this caller works in: an account's own, else the desktop window's.
fn layout_for(client: &Client) -> Result<(Value, bool), String> {
    let me = client.get("/v1/whoami")?;
    if me["user"].is_string() {
        return Ok((client.get("/v1/me/layout")?, false));
    }
    Ok((client.get("/v1/layout/desktop")?["layout"].clone(), true))
}

pub fn screen_ls(args: &Args) -> Result<(), String> {
    let client = Client::connect(args)?;
    let (layout, desktop) = layout_for(&client)?;
    let sessions = client.get("/v1/sessions")?;
    let screens = screens_of(&layout, &sessions, desktop);
    if args.has("json") {
        let v: Vec<Value> = screens
            .iter()
            .map(|s| json!({ "id": s.id, "name": s.name, "panes": s.panes.iter().map(pane_json).collect::<Vec<_>>() }))
            .collect();
        println!("{}", serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?);
        return Ok(());
    }
    if screens.is_empty() {
        println!("No Screens.");
        return Ok(());
    }
    for s in &screens {
        println!("{}  {}", s.id, s.name);
        if s.panes.is_empty() {
            println!("    (empty)");
        }
        for p in &s.panes {
            match p {
                Pane::Session { id, title, directory, .. } => {
                    println!("    session   {id}  {}", title.as_deref().unwrap_or("(untitled)"));
                    if let Some(d) = directory {
                        println!("              {d}");
                    }
                }
                Pane::Terminal { shell, name, cwd, agent, .. } => {
                    let what = agent.clone().or_else(|| name.clone()).unwrap_or_else(|| "shell".into());
                    let id = shell.as_deref().unwrap_or("(a browser's own shell)");
                    println!("    terminal  {id}  {what}");
                    if let Some(c) = cwd {
                        println!("              {c}");
                    }
                }
                Pane::Other { kind, .. } => println!("    {kind}"),
            }
        }
    }
    Ok(())
}

/// The folder new sessions and terminals go in, and that files the Screen
/// under a project: `--project NAME`, `--directory DIR`, else the gateway's.
fn folder(client: &Client, args: &Args) -> Result<Option<String>, String> {
    if let Some(name) = args.value("project") {
        return crate::commands::project_dir(client, &name).map(Some);
    }
    Ok(args.value("directory"))
}

fn new_session_in(client: &Client, dir: &Option<String>) -> Result<Value, String> {
    let mut body = json!({});
    if let Some(d) = dir {
        body["directory"] = json!(d);
    }
    client.post("/v1/sessions", body)
}

/// `osd screen new [ID…] [--sessions N] [--terminals N] [--name N] [--project P | --directory D]`
pub fn screen_new(args: &Args) -> Result<(), String> {
    let client = Client::connect(args)?;
    let mut dir = folder(&client, args)?;
    let mut panes: Vec<Value> = args.positional.iter().map(|id| json!({ "session": id })).collect();
    // Existing conversations file the Screen under their project.
    if dir.is_none() && !args.positional.is_empty() {
        let all = client.get("/v1/sessions")?;
        dir = all.as_array().into_iter().flatten().find(|s| s["id"] == args.positional[0].as_str()).and_then(|s| s["directory"].as_str().map(str::to_string));
    }
    for _ in 0..count(args, "sessions", 0)? {
        let s = new_session_in(&client, &dir)?;
        if dir.is_none() {
            dir = s["directory"].as_str().map(str::to_string);
        }
        panes.push(json!({ "session": s["id"] }));
    }
    for _ in 0..count(args, "terminals", 0)? {
        panes.push(json!({ "terminal": { "cwd": dir, "command": args.value("run") } }));
    }
    if panes.is_empty() {
        return Err("nothing to put on it: osd screen new [SESSION_ID…] [--sessions N] [--terminals N]".into());
    }
    let mut body = json!({ "panes": panes });
    if let Some(name) = args.value("name") {
        body["name"] = json!(name);
    }
    if let Some(d) = &dir {
        body["directory"] = json!(d);
    }
    let made = client.post("/v1/screens", body)?;
    if args.has("json") {
        println!("{}", serde_json::to_string_pretty(&json!({ "screen": made["id"], "panes": made["panes"], "contents": panes })).map_err(|e| e.to_string())?);
        return Ok(());
    }
    println!("Screen {}", made["id"].as_str().unwrap_or("?"));
    for (id, p) in made["panes"].as_array().into_iter().flatten().zip(&panes) {
        match p["session"].as_str() {
            Some(s) => println!("    session   {s}"),
            None => println!("    terminal  {}", id.as_str().unwrap_or("?")),
        }
    }
    Ok(())
}

/// The pane the caller is in: its conversation (`OSD_ORIGIN_SESSION`, set on
/// an agent's commands) or its terminal (`OSD_PANE`, set in the app's shells).
/// Returns the Screen, the pane and the folder it works in.
pub fn find_me(screens: &[Screen], session: Option<&str>, pane: Option<&str>) -> Option<(String, String, Option<String>)> {
    for s in screens {
        for p in &s.panes {
            let hit = match p {
                Pane::Session { pane: id, id: ses, directory, .. } if session == Some(ses.as_str()) => Some((id, directory)),
                Pane::Terminal { pane: id, cwd, .. } if pane == Some(id.as_str()) => Some((id, cwd)),
                _ => None,
            };
            if let Some((id, dir)) = hit {
                return Some((s.id.clone(), id.clone(), dir.clone()));
            }
        }
    }
    None
}

/// `osd screen add <SCREEN> | --here [SESSION_ID | --new | --terminal] [--project P | --directory D]`
pub fn screen_add(args: &Args) -> Result<(), String> {
    let client = Client::connect(args)?;
    let here = args.has("here");
    let (screen, beside, my_dir, first) = if here {
        let (layout, desktop) = layout_for(&client)?;
        let screens = screens_of(&layout, &client.get("/v1/sessions")?, desktop);
        let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let (screen, pane, dir) = find_me(&screens, env("OSD_ORIGIN_SESSION").as_deref(), env("OSD_PANE").as_deref())
            .ok_or("--here: you are not on any Screen (no pane shows your conversation or terminal)")?;
        (screen, Some(pane), dir, 0)
    } else {
        (args.at(0, "screen id (or --here)")?, None, None, 1)
    };
    // New conversations and terminals start where the caller works.
    let dir = folder(&client, args)?.or(my_dir);
    let pane = if args.has("terminal") {
        json!({ "terminal": { "cwd": dir, "command": args.value("run") } })
    } else if args.has("new") {
        json!({ "session": new_session_in(&client, &dir)?["id"] })
    } else {
        json!({ "session": args.at(first, "session id (or --new, or --terminal)")? })
    };
    let mut body = pane.clone();
    if let Some(b) = &beside {
        body["beside"] = json!(b);
    }
    let added = client.post(&format!("/v1/screens/{screen}/panes"), body)?;
    match pane["session"].as_str() {
        Some(s) => println!("session   {s}"),
        None => println!("terminal  {}", added["pane"].as_str().unwrap_or("?")),
    }
    Ok(())
}

/// `osd screen show <SCREEN>`: bring it up in the desktop window.
pub fn screen_show(args: &Args) -> Result<(), String> {
    let client = Client::connect(args)?;
    let screen = args.at(0, "screen id")?;
    client.post(&format!("/v1/screens/{screen}/show"), json!({}))?;
    Ok(())
}

/// `osd screen close <SCREEN>`
pub fn screen_close(args: &Args) -> Result<(), String> {
    let client = Client::connect(args)?;
    let screen = args.at(0, "screen id")?;
    client.delete(&format!("/v1/screens/{screen}"))?;
    Ok(())
}

// ---- terminals --------------------------------------------------------------

fn read(client: &Client, id: &str, turns: usize, lines: usize) -> Result<Value, String> {
    client.get(&format!("/v1/terminals/{id}/read?turns={turns}&lines={lines}"))
}

fn count(args: &Args, name: &str, default: usize) -> Result<usize, String> {
    args.value(name)
        .map(|v| v.parse::<usize>().map_err(|_| format!("invalid --{name} {v:?}")))
        .transpose()
        .map(|v| v.unwrap_or(default))
}

fn print_read(r: &Value) {
    if r["kind"] == "shell" {
        println!("{}", r["text"].as_str().unwrap_or(""));
        return;
    }
    let agent = match r["agent"].as_str() {
        Some("claude") => "Claude Code",
        Some("codex") => "Codex",
        Some(other) => other,
        None => "agent",
    };
    let state = if r["busy"].as_bool() == Some(true) { "working" } else { "idle" };
    println!("{agent} · {state} · {}\n", r["cwd"].as_str().unwrap_or(""));
    for e in r["entries"].as_array().into_iter().flatten() {
        let text = e["text"].as_str().unwrap_or("");
        match e["role"].as_str() {
            Some("tool") => println!("  → {text}"),
            Some(role) => println!("--- {role}\n{text}\n"),
            None => {}
        }
    }
}

pub fn term_read(args: &Args) -> Result<(), String> {
    let client = Client::connect(args)?;
    let id = args.at(0, "terminal id")?;
    let r = read(&client, &id, count(args, "turns", 1)?, count(args, "lines", 40)?)?;
    if args.has("json") {
        println!("{}", serde_json::to_string_pretty(&r).map_err(|e| e.to_string())?);
        return Ok(());
    }
    print_read(&r);
    Ok(())
}

/// What the agent answered to `sent`: its words after the LAST time `sent`
/// appears as a user message, once its turn is over. None while there is no
/// such message yet, or it is still working.
pub fn reply_to(r: &Value, sent: &str) -> Option<String> {
    if r["busy"].as_bool() != Some(false) {
        return None;
    }
    let squash = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let want = squash(sent);
    let entries = r["entries"].as_array()?;
    let at = entries
        .iter()
        .rposition(|e| e["role"] == "user" && squash(e["text"].as_str().unwrap_or("")).contains(&want))?;
    let words: Vec<&str> = entries[at + 1..]
        .iter()
        .filter(|e| e["role"] == "assistant")
        .filter_map(|e| e["text"].as_str())
        .collect();
    (!words.is_empty()).then(|| words.join("\n\n"))
}

pub fn term_send(args: &Args) -> Result<(), String> {
    let client = Client::connect(args)?;
    let id = args.at(0, "terminal id")?;
    let text = args.rest(1);
    if text.trim().is_empty() {
        return Err("nothing to send: osd term send <id> <text…>".into());
    }
    let wait = args.has("wait");
    if wait && read(&client, &id, 1, 1)?["kind"] != "agent" {
        return Err("--wait needs Claude Code or Codex running in that terminal; this one is a plain shell".into());
    }
    // A newline typed into a terminal is Enter, so a message of several lines
    // goes in as one paste (bracketed): the agent receives it whole, a shell
    // does not run it line by line. Enter is its own write a moment later —
    // tested against both agents' TUIs.
    let data = if text.contains('\n') { format!("\u{1b}[200~{text}\u{1b}[201~") } else { text.clone() };
    client.post(&format!("/v1/terminals/{id}/input"), json!({ "data": data }))?;
    if !args.has("no-enter") {
        std::thread::sleep(Duration::from_millis(300));
        client.post(&format!("/v1/terminals/{id}/input"), json!({ "data": "\r" }))?;
    }
    if !wait {
        return Ok(());
    }
    let timeout = count(args, "timeout", 600)? as u64;
    let deadline = Instant::now() + Duration::from_secs(timeout);
    let mut interval = Duration::from_secs(1);
    loop {
        // An agent queues a message sent mid-turn, so the answer may come after
        // the turn already running: wait for the agent to be idle with an
        // answer AFTER this message.
        let r = read(&client, &id, 50, 1)?;
        if let Some(answer) = reply_to(&r, &text) {
            println!("{answer}");
            return Ok(());
        }
        if Instant::now() > deadline {
            return Err(format!(
                "no reply within {timeout}s — it may still be working; read it later with `osd term read {id}`"
            ));
        }
        std::thread::sleep(interval);
        interval = (interval + Duration::from_millis(500)).min(Duration::from_secs(5));
    }
}

/// The bytes a key sends, as xterm sends them (normal cursor mode). A single
/// character stands for itself, so a numbered menu can be answered with `1`.
pub fn key_bytes(name: &str) -> Option<String> {
    let bytes = match name.to_ascii_lowercase().as_str() {
        "up" => "\u{1b}[A",
        "down" => "\u{1b}[B",
        "right" => "\u{1b}[C",
        "left" => "\u{1b}[D",
        "enter" | "return" => "\r",
        "esc" | "escape" => "\u{1b}",
        "tab" => "\t",
        "shift-tab" => "\u{1b}[Z",
        "space" => " ",
        "backspace" => "\u{7f}",
        "ctrl-c" => "\u{3}",
        "ctrl-d" => "\u{4}",
        _ if name.chars().count() == 1 => name,
        _ => return None,
    };
    Some(bytes.to_string())
}

/// `osd term key <id> <key…>`: press keys, one at a time — what a menu, a
/// confirmation or a dialog in a terminal program needs and typed text is not.
pub fn term_key(args: &Args) -> Result<(), String> {
    let client = Client::connect(args)?;
    let id = args.at(0, "terminal id")?;
    let names = args.rest(1);
    let names: Vec<&str> = names.split_whitespace().collect();
    if names.is_empty() {
        return Err("no keys: osd term key <id> <key…> (up down left right enter esc tab shift-tab space backspace ctrl-c ctrl-d, or one character)".into());
    }
    // Check every name first: half a key sequence pressed is worse than none.
    let keys = names
        .iter()
        .map(|n| key_bytes(n).ok_or_else(|| format!("unknown key: {n}")))
        .collect::<Result<Vec<_>, _>>()?;
    for (i, key) in keys.iter().enumerate() {
        // Apart, so a program reads each as a key press, not a paste.
        if i > 0 {
            std::thread::sleep(Duration::from_millis(150));
        }
        client.post(&format!("/v1/terminals/{id}/input"), json!({ "data": key }))?;
    }
    Ok(())
}

#[cfg(test)]
mod key_tests {
    use super::key_bytes;

    #[test]
    fn keys_send_what_xterm_sends() {
        assert_eq!(key_bytes("Down").as_deref(), Some("\u{1b}[B"));
        assert_eq!(key_bytes("enter").as_deref(), Some("\r"));
        assert_eq!(key_bytes("esc").as_deref(), Some("\u{1b}"));
        assert_eq!(key_bytes("1").as_deref(), Some("1"));
        assert_eq!(key_bytes("pagedown"), None);
    }
}

// ---- audit ----------------------------------------------------------------------

/// `osd audit`: who did what through the gateway, newest first.
pub fn audit(args: &Args) -> Result<(), String> {
    let client = Client::connect(args)?;
    let mut q = Vec::new();
    for (flag, key) in [("account", "actor"), ("session", "target"), ("action", "action"), ("since", "since"), ("until", "until")] {
        if let Some(v) = args.value(flag) {
            q.push(format!("{key}={}", urlencode(&v)));
        }
    }
    q.push(format!("limit={}", count(args, "limit", 50)?));
    let list = client.get(&format!("/v1/audit?{}", q.join("&")))?;
    if args.has("json") {
        println!("{}", serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?);
        return Ok(());
    }
    let rows = list.as_array().cloned().unwrap_or_default();
    if rows.is_empty() {
        println!("Nothing recorded.");
    }
    for e in rows.iter().rev() {
        let s = |k: &str| e[k].as_str().unwrap_or("");
        let when = s("time").replace('T', " ").trim_end_matches('Z').to_string();
        let via = e["via"].as_str().map(|v| format!(" (agent in {v})")).unwrap_or_default();
        let failed = match e["status"].as_u64() {
            Some(code) if !(200..300).contains(&code) => format!("  [{code}]"),
            _ => String::new(),
        };
        println!("{when}Z  {}{via}  {}  {}{failed}", s("actor"), s("action"), s("target"));
        if let Some(d) = e["detail"].as_str().filter(|d| !d.is_empty()) {
            println!("    {}", d.replace('\n', "\n    "));
        }
    }
    Ok(())
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b':' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panes_are_listed_in_order_with_what_each_one_is() {
        let layout = json!({ "groups": [
            { "id": "g1", "name": "", "tree": { "kind": "split", "dir": "row", "sizes": [0.5, 0.5], "children": [
                { "kind": "leaf", "id": "p1", "sessionId": "ses_a" },
                { "kind": "leaf", "id": "p2", "sessionId": null,
                  "content": { "kind": "terminal", "cwd": "/repo", "agent": { "kind": "claude", "sessionId": "x", "running": true } } }
            ]}},
            { "id": "g2", "name": "Files", "tree": { "kind": "leaf", "id": "p3", "sessionId": null, "content": { "kind": "files" } } },
            { "id": "g3", "name": "Home", "tree": null }
        ]});
        let sessions = json!([{ "id": "ses_a", "title": "Fit", "directory": "/w/s1" }]);
        let s = screens_of(&layout, &sessions, true);
        assert_eq!(s.len(), 3);
        assert_eq!(s[0].name, "Fit", "named after its first pane");
        assert_eq!(s[1].name, "Files");
        assert_eq!(
            s[0].panes,
            vec![
                Pane::Session { pane: "p1".into(), id: "ses_a".into(), title: Some("Fit".into()), directory: Some("/w/s1".into()) },
                Pane::Terminal { pane: "p2".into(), shell: Some("p2".into()), name: None, cwd: Some("/repo".into()), agent: Some("Claude Code".into()) },
            ]
        );
        assert_eq!(s[1].panes, vec![Pane::Other { pane: "p3".into(), kind: "files".into() }]);
        assert!(s[2].panes.is_empty());

        // An account's layout: its shells are named by its browser, not here.
        let mine = screens_of(&layout, &sessions, false);
        assert!(matches!(&mine[0].panes[1], Pane::Terminal { shell: None, .. }));
    }

    #[test]
    fn here_is_the_pane_showing_my_conversation_or_my_terminal() {
        let layout = json!({ "groups": [{ "id": "g1", "name": "", "tree": { "kind": "split", "dir": "row", "sizes": [0.5, 0.5], "children": [
            { "kind": "leaf", "id": "p1", "sessionId": "ses_a" },
            { "kind": "leaf", "id": "p2", "sessionId": null, "content": { "kind": "terminal", "cwd": "/repo" } } ]}}]});
        let s = screens_of(&layout, &json!([{ "id": "ses_a", "directory": "/w/s1" }]), true);
        assert_eq!(find_me(&s, Some("ses_a"), None), Some(("g1".into(), "p1".into(), Some("/w/s1".into()))));
        assert_eq!(find_me(&s, None, Some("p2")), Some(("g1".into(), "p2".into(), Some("/repo".into()))));
        assert_eq!(find_me(&s, Some("ses_x"), Some("p9")), None);
    }

    #[test]
    fn a_reply_is_what_came_after_the_message_once_the_turn_is_over() {
        let r = |busy: bool, entries: Value| json!({ "kind": "agent", "busy": busy, "entries": entries });
        let asked = json!([
            { "role": "user", "text": "earlier" },
            { "role": "assistant", "text": "old answer" },
            { "role": "user", "text": "check   the\nbuild" },
            { "role": "tool", "text": "Bash: make" },
            { "role": "assistant", "text": "It passes." },
        ]);
        assert_eq!(reply_to(&r(false, asked.clone()), "check the build"), Some("It passes.".into()));
        assert_eq!(reply_to(&r(true, asked), "check the build"), None, "still working");
        // Sent but not answered yet (queued behind another turn, or just landed).
        let pending = json!([{ "role": "user", "text": "earlier" }, { "role": "assistant", "text": "old answer" }]);
        assert_eq!(reply_to(&r(false, pending), "check the build"), None);
    }
}
