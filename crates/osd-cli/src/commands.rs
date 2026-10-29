// The client subcommands: sessions, projects, runs, files, approvals.
//
// Every one of them is a thin call over `/v1` plus a readable rendering of the
// answer. `--json` prints the gateway's own reply instead, which is what a
// script should parse — the human format is free to change.
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::args::Args;
use crate::client::Client;

pub fn run(args: &Args) -> Result<(), String> {
    match (args.command.as_str(), args.sub.as_str()) {
        ("login", _) => login(args),
        ("status", _) => status(args),
        ("session", "ls") | ("session", "list") => sessions(args),
        ("session", "new") | ("session", "create") => new_session(args),
        ("session", "send") => send(args),
        ("session", "show") => show(args),
        ("session", "rm") | ("session", "delete") => rm_session(args),
        ("session", "abort") => abort(args),
        ("session", "status") => session_status(args),
        ("session", "wait") => session_wait(args),
        ("session", "rename") => session_rename(args),
        ("session", "archive") => session_archive(args, true),
        ("session", "unarchive") => session_archive(args, false),
        ("session", "move") => session_move(args),
        ("session", "find") | ("session", "search") => session_find(args),
        ("question", "ls") | ("question", "list") => questions(args),
        ("question", "answer") => question_answer(args),
        ("question", "reject") | ("question", "dismiss") => question_reject(args),
        ("fs", "put") | ("fs", "upload") => fs_put(args),
        ("screen", "ls") | ("screen", "list") => crate::screens::screen_ls(args),
        ("screen", "new") => crate::screens::screen_new(args),
        ("screen", "add") => crate::screens::screen_add(args),
        ("screen", "close") => crate::screens::screen_close(args),
        ("screen", "show") => crate::screens::screen_show(args),
        ("term", "read") => crate::screens::term_read(args),
        ("term", "send") => crate::screens::term_send(args),
        ("term", "key") => crate::screens::term_key(args),
        ("audit", _) => crate::screens::audit(args),
        ("project", "ls") | ("project", "list") => projects(args),
        ("project", "new") | ("project", "create") => new_project(args),
        ("run", "ls") | ("run", "list") => runs(args),
        ("run", "log") => run_log(args),
        ("fs", "ls") | ("fs", "list") => fs_ls(args),
        ("fs", "get") | ("fs", "read") => fs_get(args),
        ("model", "") | ("model", "show") => model_show(args),
        ("model", "ls") | ("model", "list") => model_ls(args),
        ("model", "set") => model_set(args),
        ("approval", "") | ("approval", "show") => approval_show(args),
        ("approval", "set") => approval_set(args),
        ("settings", "") | ("settings", "ls") | ("settings", "list") => crate::settings::ls(args),
        ("settings", "set") | ("settings", "request") => crate::settings::set(args),
        ("settings", "status") => crate::settings::status(args),
        ("permission", "ls") | ("permission", "list") => permissions(args),
        ("permission", "allow") => reply(args, "always"),
        ("permission", "once") => reply(args, "once"),
        ("permission", "deny") | ("permission", "reject") => reply(args, "reject"),
        (cmd, "") => Err(format!("unknown command {cmd:?} — try `osd help`")),
        (cmd, sub) => Err(format!("unknown command {cmd} {sub:?} — try `osd help`")),
    }
}

// ---- connection -------------------------------------------------------------

fn login(args: &Args) -> Result<(), String> {
    let base = args
        .value("gateway")
        .ok_or("usage: osd login --gateway <url> --token <token>")?;
    let token = args
        .value("token")
        .ok_or("usage: osd login --gateway <url> --token <token>")?;
    let path = crate::client::save_login(base.trim_end_matches('/'), &token)?;
    println!("Saved to {}", path.display());
    // Prove it works now rather than at the next command, when the user has
    // moved on and the failure looks like something else.
    let client = Client::connect(args)?;
    let who = client.get("/v1/whoami")?;
    println!(
        "Connected to {} — {} access, workspace {}",
        client.base,
        who["mode"].as_str().unwrap_or("?"),
        who["directory"].as_str().unwrap_or("?")
    );
    Ok(())
}

fn status(args: &Args) -> Result<(), String> {
    let client = Client::connect(args)?;
    let who = client.get("/v1/whoami")?;
    if args.has("json") {
        return print_json(&who);
    }
    println!("gateway   {}", client.base);
    println!("found by  {}", client.origin);
    println!("access    {}", who["mode"].as_str().unwrap_or("?"));
    println!("workspace {}", who["directory"].as_str().unwrap_or("?"));
    Ok(())
}

// ---- sessions ---------------------------------------------------------------

fn sessions(args: &Args) -> Result<(), String> {
    let client = Client::connect(args)?;
    let list = client.get("/v1/sessions")?;
    if args.has("json") {
        return print_json(&list);
    }
    let rows = list.as_array().cloned().unwrap_or_default();
    if rows.is_empty() {
        println!("No sessions yet. Create one with `osd session new`.");
        return Ok(());
    }
    for s in rows {
        println!(
            "{}  {}",
            s["id"].as_str().unwrap_or("?"),
            s["title"].as_str().unwrap_or("(untitled)")
        );
        if let Some(dir) = s["directory"].as_str() {
            println!("    {dir}");
        }
    }
    Ok(())
}

fn new_session(args: &Args) -> Result<(), String> {
    let client = Client::connect(args)?;
    let mut body = json!({});
    // A project is named the way a person would name it; the directory it maps
    // to is looked up here so the caller never has to know a path.
    if let Some(name) = args.value("project") {
        body["directory"] = json!(project_dir(&client, &name)?);
    } else if let Some(dir) = args.value("directory") {
        body["directory"] = json!(dir);
    }
    if let Some(title) = args.value("title") {
        body["title"] = json!(title);
    }
    let created = client.post("/v1/sessions", body)?;
    if args.has("json") {
        return print_json(&created);
    }
    println!("{}", created["id"].as_str().unwrap_or("(no id returned)"));
    Ok(())
}

fn send(args: &Args) -> Result<(), String> {
    let client = Client::connect(args)?;
    let session = args.at(0, "session id")?;
    let text = args.rest(1);
    if text.trim().is_empty() {
        return Err("nothing to send: osd session send <id> <prompt…>".into());
    }
    // How long the transcript was BEFORE this turn. Everything below is
    // relative to that: a reply is only this turn's if it arrived after it.
    let before = message_count(&client, &session)?;

    let mut body = json!({ "text": text });
    for (flag, key) in [("model", "model"), ("agent", "agent"), ("effort", "variant")] {
        if let Some(v) = args.value(flag) {
            body[key] = json!(v);
        }
    }
    client.post(&format!("/v1/sessions/{session}/prompt"), body)?;
    if !args.has("wait") {
        if !args.has("quiet") {
            eprintln!("Sent. The turn runs in the background — add --wait to follow it.");
        }
        return Ok(());
    }
    wait_for_reply(&client, &session, args, before)?;
    // Print what the agent said THIS turn. Printing the previous answer when
    // this turn produced nothing would hand a script the wrong result and look
    // like success.
    let messages = client.get(&format!("/v1/sessions/{session}/messages"))?;
    if args.has("json") {
        return print_json(&messages);
    }
    match last_assistant_text(&messages, before) {
        Some(text) => println!("{text}"),
        None => return Err("the turn finished without a reply".into()),
    }
    Ok(())
}

fn message_count(client: &Client, session: &str) -> Result<usize, String> {
    let status = client.get(&format!("/v1/sessions/{session}/status"))?;
    Ok(status["messages"].as_u64().unwrap_or(0) as usize)
}

/// Poll until this turn has produced its reply.
///
/// `prompt` returns as soon as the turn is ACCEPTED, so "idle" alone means
/// nothing — the session is idle in the moment before the turn starts, and idle
/// again if it dies without answering (an unavailable model does exactly that:
/// the user message is stored, no assistant message ever follows). Waiting on
/// "idle" alone would report success and print the PREVIOUS answer. So the
/// condition is: idle, and an assistant message that was not there before.
fn wait_for_reply(
    client: &Client,
    session: &str,
    args: &Args,
    before: usize,
) -> Result<(), String> {
    /// How long a turn may take to appear before we call it dead on arrival.
    /// The runtime writes the assistant message when the turn STARTS — measured
    /// at 12 ms after the user's message on a live server, not when the first
    /// token arrives — so this only has to cover model resolution and a provider
    /// handshake. Generous anyway: the cost of being wrong is calling a running
    /// turn dead, which is worse than waiting.
    const START_GRACE: Duration = Duration::from_secs(45);

    let timeout = args
        .value("timeout")
        .map(|t| t.parse::<u64>().map_err(|_| format!("invalid --timeout {t:?}")))
        .transpose()?
        .unwrap_or(3600);
    let started = Instant::now();
    let deadline = started + Duration::from_secs(timeout);
    let mut ever_worked = false;
    let mut warned_about_approval = false;
    let mut interval = Duration::from_secs(1);
    loop {
        let status = client.get(&format!("/v1/sessions/{session}/status"))?;
        let state = status["state"].as_str().unwrap_or("idle");
        let messages = status["messages"].as_u64().unwrap_or(0) as usize;
        ever_worked |= state == "working";
        if let Some(err) = status.get("lastError").filter(|e| !e.is_null()) {
            return Err(turn_failed(err));
        }
        if state == "idle" && messages > before && status["lastRole"].as_str() == Some("assistant")
        {
            return Ok(());
        }
        // Idle, the transcript still ends at OUR prompt, and long past the point
        // where a live turn would have shown itself: the runtime accepted the
        // prompt and dropped it. The `lastRole` check is what keeps a finished
        // turn from ever landing here — an answered turn ends on the assistant.
        if state == "idle"
            && !ever_worked
            && status["lastRole"].as_str() == Some("user")
            && started.elapsed() > START_GRACE
        {
            return Err(format!(
                "the turn never started. The prompt is in the transcript with no reply — \
                 usually an unavailable model or provider. Check `osd session show {session}` \
                 and the runtime log."
            ));
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "still running after {timeout}s. It keeps going — check with \
                 `osd session show {session}`, or stop it with `osd session abort {session}`."
            ));
        }
        // Approvals block a turn forever if nobody answers, so say so rather
        // than letting --wait look like a hang — ONCE, and only after the turn
        // has had a few seconds to get going. Printed every poll it would be
        // two lines of noise a second for as long as the user takes to answer,
        // and it costs a request per poll to discover something that does not
        // change.
        if !warned_about_approval && !args.has("quiet") && started.elapsed() > Duration::from_secs(5)
        {
            if let Ok(pending) = client.get("/v1/permissions") {
                if let Some(rows) = pending.as_array().filter(|a| !a.is_empty()) {
                    warned_about_approval = true;
                    // On a machine with nobody at the keyboard this is the
                    // difference between "it hung" and "it is waiting for you",
                    // so say WHAT is waiting and both ways to answer it: this
                    // terminal, or the web client (the same gateway, so a phone
                    // or a laptop elsewhere works).
                    eprintln!("Waiting for approval — the turn is blocked until it is answered:");
                    for p in rows.iter().take(3) {
                        eprintln!(
                            "  {}  {}  {}",
                            p["id"].as_str().unwrap_or("?"),
                            p["type"].as_str().unwrap_or(""),
                            p["title"].as_str().or(p["pattern"].as_str()).unwrap_or("")
                        );
                    }
                    if rows.len() > 3 {
                        eprintln!("  … and {} more (osd permission ls)", rows.len() - 3);
                    }
                    eprintln!(
                        "Answer here:  osd permission allow <id>   (or `once` / `deny`)\n\
                         Or in a browser: {} (the page asks for the token)\n\
                         Unattended machines can skip approvals entirely — see `osd approval`.",
                        client.web_url()
                    );
                }
            }
        }
        // Each poll makes the gateway re-read the session's whole transcript
        // from the sidecar, so a turn that runs for minutes should not be asked
        // every two seconds for the whole time. Start responsive, then ease off.
        std::thread::sleep(interval);
        interval = (interval + Duration::from_millis(500)).min(Duration::from_secs(5));
    }
}

fn show(args: &Args) -> Result<(), String> {
    let client = Client::connect(args)?;
    let session = args.at(0, "session id")?;
    let mut messages = client.get(&format!("/v1/sessions/{session}/messages"))?;
    // The last N turns (a turn starts at a user message): what another agent
    // usually wants, without the whole conversation filling its context.
    if let Some(n) = args.value("last") {
        let n: usize = n.parse().map_err(|_| format!("invalid --last {n:?}"))?;
        if let Some(all) = messages.as_array_mut() {
            let starts: Vec<usize> = all
                .iter()
                .enumerate()
                .filter(|(_, m)| m.get("info").unwrap_or(m)["role"].as_str() == Some("user"))
                .map(|(i, _)| i)
                .collect();
            if n > 0 && starts.len() > n {
                all.drain(..starts[starts.len() - n]);
            }
        }
    }
    if args.has("json") {
        return print_json(&messages);
    }
    for m in messages.as_array().cloned().unwrap_or_default() {
        let info = m.get("info").unwrap_or(&m);
        let role = info["role"].as_str().unwrap_or("?");
        let text = text_of(&m);
        if text.trim().is_empty() {
            continue;
        }
        println!("--- {role}\n{text}\n");
    }
    Ok(())
}

/// The folder a session works in, for the requests that are about it.
fn session_dir(client: &Client, session: &str) -> Result<String, String> {
    let all = client.get("/v1/sessions")?;
    all.as_array()
        .into_iter()
        .flatten()
        .find(|s| s["id"] == session)
        .and_then(|s| s["directory"].as_str().map(str::to_string))
        .ok_or_else(|| format!("no session {session}"))
}

fn session_status(args: &Args) -> Result<(), String> {
    let client = Client::connect(args)?;
    let session = args.at(0, "session id")?;
    let status = client.get(&format!("/v1/sessions/{session}/status"))?;
    if args.has("json") {
        return print_json(&status);
    }
    let state = status["state"].as_str().unwrap_or("idle");
    println!("{state}  ({} messages, last from the {})", status["messages"], status["lastRole"].as_str().unwrap_or("?"));
    if let Some(err) = status.get("lastError").filter(|e| !e.is_null()) {
        println!("last error: {err}");
    }
    Ok(())
}

/// Wait for a session's current turn — whoever started it — to finish, then
/// print its answer. A session already idle answers at once.
fn session_wait(args: &Args) -> Result<(), String> {
    let client = Client::connect(args)?;
    let session = args.at(0, "session id")?;
    let timeout = args
        .value("timeout")
        .map(|t| t.parse::<u64>().map_err(|_| format!("invalid --timeout {t:?}")))
        .transpose()?
        .unwrap_or(3600);
    let started = Instant::now();
    let deadline = started + Duration::from_secs(timeout);
    let mut interval = Duration::from_secs(1);
    loop {
        let status = client.get(&format!("/v1/sessions/{session}/status"))?;
        if let Some(err) = status.get("lastError").filter(|e| !e.is_null()) {
            return Err(turn_failed(err));
        }
        // A message just sent reads as idle until its turn starts: the last
        // word is still the user's. Give it the time a turn takes to start
        // (as `send --wait` does) before calling the session idle.
        let starting = status["lastRole"].as_str() == Some("user") && started.elapsed() < Duration::from_secs(45);
        if status["state"].as_str() != Some("working") && !starting {
            break;
        }
        if Instant::now() > deadline {
            return Err(format!("still working after {timeout}s"));
        }
        std::thread::sleep(interval);
        interval = (interval + Duration::from_millis(500)).min(Duration::from_secs(5));
    }
    let messages = client.get(&format!("/v1/sessions/{session}/messages"))?;
    match last_assistant_text(&messages, 0) {
        Some(text) => println!("{text}"),
        None => println!("(no answer yet)"),
    }
    Ok(())
}

fn session_rename(args: &Args) -> Result<(), String> {
    let client = Client::connect(args)?;
    let session = args.at(0, "session id")?;
    let title = args.rest(1);
    if title.trim().is_empty() {
        return Err("no title: osd session rename <id> <title…>".into());
    }
    client.patch(&format!("/v1/sessions/{session}"), json!({ "title": title }))?;
    Ok(())
}

fn session_archive(args: &Args, archived: bool) -> Result<(), String> {
    let client = Client::connect(args)?;
    let session = args.at(0, "session id")?;
    client.patch(&format!("/v1/sessions/{session}"), json!({ "archived": archived }))?;
    Ok(())
}

/// File a session under a project: its folder becomes the project's.
fn session_move(args: &Args) -> Result<(), String> {
    let client = Client::connect(args)?;
    let session = args.at(0, "session id")?;
    let name = args.value("project").ok_or("which project? osd session move <id> --project NAME")?;
    let projects = client.get("/v1/projects")?;
    let id = projects
        .as_array()
        .into_iter()
        .flatten()
        .find(|p| p["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(&name)))
        .and_then(|p| p["id"].as_str().map(str::to_string))
        .ok_or_else(|| format!("no project named {name:?} (osd project ls)"))?;
    let moved = client.post(&format!("/v1/sessions/{session}/move"), json!({ "project": id }))?;
    println!("{}", moved["directory"].as_str().unwrap_or(""));
    Ok(())
}

fn session_find(args: &Args) -> Result<(), String> {
    let client = Client::connect(args)?;
    let words = args.rest(0);
    if words.trim().is_empty() {
        return Err("find what? osd session find <words…>".into());
    }
    let limit = args.value("limit").unwrap_or_else(|| "20".into());
    let found = client.get(&format!("/v1/sessions/find?q={}&limit={}", urlencode(&words), urlencode(&limit)))?;
    if args.has("json") {
        return print_json(&found);
    }
    let rows = found.as_array().cloned().unwrap_or_default();
    if rows.is_empty() {
        println!("No conversation mentions {words:?}.");
    }
    for f in rows {
        println!("{}  {}", f["id"].as_str().unwrap_or("?"), f["title"].as_str().unwrap_or(""));
        println!("    {}", f["snippet"].as_str().unwrap_or(""));
    }
    Ok(())
}

fn rm_session(args: &Args) -> Result<(), String> {
    let client = Client::connect(args)?;
    let session = args.at(0, "session id")?;
    client.delete(&format!("/v1/sessions/{session}"))?;
    println!("Deleted {session}");
    Ok(())
}

fn abort(args: &Args) -> Result<(), String> {
    let client = Client::connect(args)?;
    let session = args.at(0, "session id")?;
    client.post(&format!("/v1/sessions/{session}/abort"), json!({}))?;
    println!("Asked {session} to stop.");
    Ok(())
}

// ---- projects ---------------------------------------------------------------

fn projects(args: &Args) -> Result<(), String> {
    let client = Client::connect(args)?;
    let list = client.get("/v1/projects")?;
    if args.has("json") {
        return print_json(&list);
    }
    let rows = list.as_array().cloned().unwrap_or_default();
    if rows.is_empty() {
        println!("No projects yet. Create one with `osd project new <name>`.");
        return Ok(());
    }
    for p in rows {
        println!("{}", p["name"].as_str().unwrap_or("?"));
        println!("    {}", p["path"].as_str().unwrap_or("?"));
    }
    Ok(())
}

fn new_project(args: &Args) -> Result<(), String> {
    let client = Client::connect(args)?;
    let name = args.rest(0);
    if name.trim().is_empty() {
        return Err("usage: osd project new <name>".into());
    }
    let created = client.post("/v1/projects", json!({ "name": name }))?;
    if args.has("json") {
        return print_json(&created);
    }
    println!("{}", created["path"].as_str().unwrap_or("(created)"));
    Ok(())
}

/// The workspace folder of the project called `name` (or with that id).
pub(crate) fn project_dir(client: &Client, name: &str) -> Result<String, String> {
    let list = client.get("/v1/projects")?;
    let rows = list.as_array().cloned().unwrap_or_default();
    let hit = rows.iter().find(|p| {
        p["id"].as_str() == Some(name)
            || p["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name))
    });
    match hit {
        Some(p) => p["path"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| format!("project {name:?} has no folder")),
        None => {
            let known: Vec<&str> = rows.iter().filter_map(|p| p["name"].as_str()).collect();
            Err(if known.is_empty() {
                format!("no project called {name:?} (there are none yet)")
            } else {
                format!("no project called {name:?}. There is: {}", known.join(", "))
            })
        }
    }
}

// ---- runs -------------------------------------------------------------------

fn runs(args: &Args) -> Result<(), String> {
    let client = Client::connect(args)?;
    let list = client.get("/v1/runs")?;
    if args.has("json") {
        return print_json(&list);
    }
    for r in list.as_array().cloned().unwrap_or_default() {
        println!(
            "{}  {}  {}",
            r["runId"].as_str().unwrap_or("?"),
            r["status"].as_str().unwrap_or("?"),
            r["command"].as_str().unwrap_or("")
        );
    }
    Ok(())
}

fn run_log(args: &Args) -> Result<(), String> {
    let client = Client::connect(args)?;
    let hash = args.at(0, "log hash")?;
    let bytes = client.get_bytes(&format!("/v1/runs/log?hash={hash}"))?;
    print!("{}", String::from_utf8_lossy(&bytes));
    Ok(())
}

// ---- files ------------------------------------------------------------------

fn fs_ls(args: &Args) -> Result<(), String> {
    let client = Client::connect(args)?;
    let path = args.positional.first().cloned().unwrap_or_default();
    let mut query = format!("/v1/fs/list?path={}", urlencode(&path));
    if let Some(dir) = args.value("directory") {
        query.push_str(&format!("&dir={}", urlencode(&dir)));
    }
    let list = client.get(&query)?;
    if args.has("json") {
        return print_json(&list);
    }
    for e in list.as_array().cloned().unwrap_or_default() {
        let name = e["name"].as_str().unwrap_or("?");
        if e["isDir"].as_bool().unwrap_or(false) {
            println!("{name}/");
        } else {
            println!("{name}  {} bytes", e["size"].as_u64().unwrap_or(0));
        }
    }
    Ok(())
}

fn fs_get(args: &Args) -> Result<(), String> {
    let client = Client::connect(args)?;
    let path = args.at(0, "path")?;
    let mut query = format!("/v1/fs/read?path={}", urlencode(&path));
    if let Some(dir) = args.value("directory") {
        query.push_str(&format!("&dir={}", urlencode(&dir)));
    }
    let bytes = client.get_bytes(&query)?;
    match args.value("output") {
        Some(out) => {
            std::fs::write(&out, &bytes).map_err(|e| format!("could not write {out}: {e}"))?;
            eprintln!("Wrote {} bytes to {out}", bytes.len());
        }
        None => {
            use std::io::Write;
            std::io::stdout().write_all(&bytes).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ---- approvals --------------------------------------------------------------

/// Did the caller name a gateway other than "whatever is on this machine"? Then
/// a machine-local answer is the wrong one, and a machine-local WRITE is worse.
fn asked_about_a_remote(args: &Args) -> bool {
    args.value("gateway").is_some() || std::env::var_os("OSD_GATEWAY").is_some()
}

fn local_only_error(command: &str) -> String {
    format!(
        "{command} changes the machine it runs on — the agent runtime's own config — and the \
         gateway deliberately refuses config writes. Run it on that machine (over SSH) instead \
         of pointing --gateway at it."
    )
}

// ---- models -----------------------------------------------------------------

/// The default model. A running gateway is the authority — it answers for the
/// server that will actually run the next turn — and with none up, this machine's
/// own config is, which is the state a box is in while being set up.
fn model_show(args: &Args) -> Result<(), String> {
    // A gateway answers for the server actually running; with none up, the
    // machine's own config is the answer — and that is exactly the moment a
    // fresh headless box is being set up.
    let model = match Client::connect(args) {
        Ok(client) => client
            .get("/global/config")?
            .get("model")
            .and_then(|m| m.as_str())
            .map(str::to_owned),
        // Only fall back for a question about THIS machine. Someone who named a
        // gateway asked about that server, and answering with local state would
        // be a different answer to a different question.
        Err(e) if asked_about_a_remote(args) => return Err(e),
        Err(_) => osd_core::runtime::get_default_model(&crate::env(args)?)?,
    };
    if args.has("json") {
        return print_json(&json!({ "model": model }));
    }
    match model {
        Some(model) => println!("{model}"),
        None => println!(
            "No default model. Set one with `osd model set <provider/model>`, or name it \
             per turn with `osd session send --model`."
        ),
    }
    Ok(())
}

/// Every model the runtime can actually serve, grouped by provider. Reads the
/// providers the gateway reports — which are the ones with credentials on the
/// server, not a catalogue of everything that exists.
fn model_ls(args: &Args) -> Result<(), String> {
    // Unlike show/set, this asks the RUNTIME what it can serve, so it needs one
    // running. Say which of the two things to do rather than "no gateway found".
    let client = Client::connect(args).map_err(|e| {
        format!(
            "{e}\nThe model list comes from the running agent runtime — start one with \
             `osd server`, or set a model without listing: `osd model set <provider/model>`."
        )
    })?;
    let providers = client.get("/config/providers")?;
    if args.has("json") {
        return print_json(&providers);
    }
    let list = providers["providers"]
        .as_array()
        .cloned()
        .or_else(|| providers.as_array().cloned())
        .unwrap_or_default();
    if list.is_empty() {
        println!("No providers are configured on this machine.");
        println!("Add one with `osd auth set <provider> --key <api-key>`.");
        return Ok(());
    }
    let current = client.get("/global/config").ok().and_then(|c| {
        c["model"].as_str().map(str::to_owned)
    });
    for p in list {
        let id = p["id"].as_str().unwrap_or("?");
        println!("{}", p["name"].as_str().unwrap_or(id));
        let mut ids: Vec<String> = match p["models"].as_object() {
            Some(map) => map.keys().cloned().collect(),
            // Some builds report models as an array of objects.
            None => p["models"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|m| m["id"].as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default(),
        };
        ids.sort();
        for model in ids {
            let full = format!("{id}/{model}");
            // Mark the default, so `ls` answers "which one am I on" too.
            let mark = if current.as_deref() == Some(full.as_str()) { " *" } else { "" };
            println!("    {full}{mark}");
        }
    }
    Ok(())
}

/// Set the default model for every later turn. Goes through the gateway, which
/// permits this one config write and no other — so it works against a remote
/// server as well as the one on this machine.
fn model_set(args: &Args) -> Result<(), String> {
    let model = args.at(0, "provider/model")?;
    if !model.contains('/') {
        return Err(format!(
            "a model is named provider/model — `{model}` has no provider. \
             `osd model ls` lists what this machine can serve."
        ));
    }
    match Client::connect(args) {
        // Through the gateway, so it also works against a remote server: this
        // is the one config write the gateway permits.
        Ok(client) => {
            client.patch("/global/config", json!({ "model": model }))?;
        }
        // A named gateway that cannot be reached is an error, never a quiet
        // write to the local machine: `osd --gateway http://box:4098 model set X`
        // must not reconfigure the laptop it was typed on.
        Err(e) if asked_about_a_remote(args) => return Err(e),
        // No server here yet — configure the machine, then start one.
        Err(_) => osd_core::runtime::set_default_model(&crate::env(args)?, model.clone())?,
    }
    println!("Default model is now {model}.");
    Ok(())
}

// ---- approvals --------------------------------------------------------------

/// What the agent has to ask permission for. Named the way the desktop names it:
/// "approve" prompts for command execution, deletion, dependency installs and
/// remote access; "full" does not prompt at all.
fn approval_show(args: &Args) -> Result<(), String> {
    if asked_about_a_remote(args) {
        return Err(local_only_error("osd approval"));
    }
    let env = crate::env(args)?;
    let mode = osd_core::runtime::get_approval_mode(&env)?;
    if args.has("json") {
        return print_json(&json!({ "mode": mode }));
    }
    match mode.as_str() {
        "full" => {
            println!("full — the agent runs commands, deletes files, installs dependencies");
            println!("and reaches the network WITHOUT asking. Nothing will block for approval.");
        }
        _ => {
            println!("approve — commands, deletions, dependency installs and remote access");
            println!("need an answer before the turn continues (`osd permission ls`).");
            println!("On a machine with nobody watching, `osd approval set full` removes the wait.");
        }
    }
    Ok(())
}

/// Switch the mode. This is a machine-local change (it rewrites the runtime's
/// own config and restarts the sidecar), so it is deliberately NOT something a
/// remote gateway client can do — the gateway refuses config writes.
/// Part of the gateway's answer when it has no desktop window to ask.
const NO_WINDOW_HINT: &str = "it is not open here";

fn approval_set(args: &Args) -> Result<(), String> {
    let requested = args.at(0, "mode")?;
    let mode = match requested.as_str() {
        "full" | "yes" | "auto" => "full",
        "approve" | "manual" | "ask" => "approve",
        other => {
            return Err(format!(
                "unknown mode {other:?} — `full` (never ask) or `approve` (ask, the default)"
            ))
        }
    };
    if asked_about_a_remote(args) {
        return Err(local_only_error("osd approval set"));
    }
    // With the desktop app open, the user decides, in its window: otherwise
    // any agent allowed to run `osd` could switch its own approvals off.
    if let Ok(client) = crate::client::Client::connect(args) {
        drop(client);
        let mut changes = serde_json::Map::new();
        changes.insert("approval.mode".into(), serde_json::json!(mode));
        match crate::settings::request(args, changes) {
            Err(e) if e.contains(NO_WINDOW_HINT) => {}
            done => return done,
        }
    }
    // No window (a headless machine): the person at its shell decides, which
    // an agent's command is not.
    if std::env::var_os("OSD_ORIGIN_SESSION").is_some() {
        return Err("an agent cannot change the approval mode. Ask the user to change it.".into());
    }
    let env = crate::env(args)?;
    osd_core::runtime::set_approval_mode(&env, mode.to_string())?;
    if mode == "full" {
        println!("Approval mode is now FULL on this machine.");
        println!("The agent will run commands, delete files, install dependencies and reach");
        println!("the network with no approval. It is still confined to the workspace.");
    } else {
        println!("Approval mode is now `approve` — the agent asks before those actions.");
    }
    if osd_core::gateway::read_persisted(&env).port.is_some() {
        println!("The runtime restarted, so a turn in flight may need re-sending.");
    }
    Ok(())
}

/// `?dir=` for a request about a session's folder (`--session ID`), else nothing.
fn dir_query(client: &Client, args: &Args) -> Result<String, String> {
    Ok(match args.value("session") {
        Some(id) => format!("?dir={}", urlencode(&session_dir(client, &id)?)),
        None => String::new(),
    })
}

fn permissions(args: &Args) -> Result<(), String> {
    let client = Client::connect(args)?;
    let list = client.get(&format!("/v1/permissions{}", dir_query(&client, args)?))?;
    if args.has("json") {
        return print_json(&list);
    }
    let rows = list.as_array().cloned().unwrap_or_default();
    if rows.is_empty() {
        println!("Nothing is waiting for approval.");
        return Ok(());
    }
    for p in rows {
        println!(
            "{}  {}\n    {}",
            p["id"].as_str().unwrap_or("?"),
            p["type"].as_str().unwrap_or(""),
            p["title"].as_str().or(p["pattern"].as_str()).unwrap_or("")
        );
    }
    Ok(())
}

fn reply(args: &Args, verdict: &str) -> Result<(), String> {
    let client = Client::connect(args)?;
    let id = args.at(0, "request id")?;
    client.post(&format!("/v1/permissions/{id}/reply{}", dir_query(&client, args)?), json!({ "reply": verdict }))?;
    println!("Answered {id}: {verdict}");
    Ok(())
}

/// Questions an agent asked and is waiting on (its `question` tool).
fn questions(args: &Args) -> Result<(), String> {
    let client = Client::connect(args)?;
    let list = client.get(&format!("/v1/questions{}", dir_query(&client, args)?))?;
    if args.has("json") {
        return print_json(&list);
    }
    let rows = list.as_array().cloned().unwrap_or_default();
    if rows.is_empty() {
        println!("No agent is waiting on a question.");
    }
    for q in rows {
        println!("{}  (session {})", q["id"].as_str().unwrap_or("?"), q["sessionID"].as_str().unwrap_or("?"));
        for (i, item) in q["questions"].as_array().into_iter().flatten().enumerate() {
            println!("  {}. {}", i + 1, item["question"].as_str().or(item["header"].as_str()).unwrap_or(""));
            for o in item["options"].as_array().into_iter().flatten() {
                let label = o["label"].as_str().unwrap_or("");
                match o["description"].as_str().filter(|d| !d.is_empty()) {
                    Some(d) => println!("     - {label}: {d}"),
                    None => println!("     - {label}"),
                }
            }
        }
    }
    Ok(())
}

/// One answer per question, in order: an option's label, or your own words.
fn question_answer(args: &Args) -> Result<(), String> {
    let client = Client::connect(args)?;
    let id = args.at(0, "question id")?;
    let answers: Vec<Vec<String>> = args.positional.iter().skip(1).map(|a| vec![a.clone()]).collect();
    if answers.is_empty() {
        return Err("no answer: osd question answer <id> <answer> [<answer for the next question>…]".into());
    }
    client.post(&format!("/v1/questions/{id}/reply{}", dir_query(&client, args)?), json!({ "answers": answers }))?;
    Ok(())
}

fn question_reject(args: &Args) -> Result<(), String> {
    let client = Client::connect(args)?;
    let id = args.at(0, "question id")?;
    client.post(&format!("/v1/questions/{id}/reject{}", dir_query(&client, args)?), json!({}))?;
    Ok(())
}

/// Put a file into a session's folder (its root), as the composer's "add
/// files" does. A name already taken gets a free one; the name used is printed.
fn fs_put(args: &Args) -> Result<(), String> {
    let client = Client::connect(args)?;
    let local = args.at(0, "file")?;
    let bytes = std::fs::read(&local).map_err(|e| format!("{local}: {e}"))?;
    let name = args.value("name").unwrap_or_else(|| {
        std::path::Path::new(&local).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    });
    let dir = match (args.value("session"), args.value("directory")) {
        (Some(id), _) => Some(session_dir(&client, &id)?),
        (None, d) => d,
    };
    let mut path = format!("/v1/fs/upload?name={}", urlencode(&name));
    if let Some(d) = dir {
        path.push_str(&format!("&dir={}", urlencode(&d)));
    }
    let put = client.post_bytes(&path, bytes)?;
    println!("{}", put["name"].as_str().unwrap_or(&name));
    Ok(())
}

// ---- rendering --------------------------------------------------------------

fn print_json(v: &Value) -> Result<(), String> {
    println!("{}", serde_json::to_string_pretty(v).map_err(|e| e.to_string())?);
    Ok(())
}

/// The text parts of one message, joined. Tool calls and reasoning are left
/// out: this is the answer, not the transcript.
fn text_of(message: &Value) -> String {
    message["parts"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter(|p| p["type"].as_str() == Some("text"))
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

/// The agent's answer among the messages added since index `after` — never an
/// earlier one, so a turn that produced nothing reads as nothing.
fn last_assistant_text(messages: &Value, after: usize) -> Option<String> {
    messages
        .as_array()?
        .get(after..)?
        .iter()
        .rev()
        .find(|m| {
            m.get("info").unwrap_or(m)["role"].as_str() == Some("assistant")
                && !text_of(m).trim().is_empty()
        })
        .map(text_of)
}

/// Percent-encode one query value. Workspace paths carry spaces and non-ASCII
/// characters routinely, and either would otherwise truncate the query.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}


/// A failed turn, said plainly: the provider's own message rather than the whole
/// error object, and the next step when the model itself is what failed (it was
/// retired or renamed), since every later turn on it fails the same way.
fn turn_failed(err: &Value) -> String {
    let message = err["data"]["message"]
        .as_str()
        .or_else(|| err["message"].as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| err.to_string());
    let text = err.to_string().to_ascii_lowercase();
    let model_gone = text.contains("model")
        && ["deprecated", "not supported", "not found", "no longer"]
            .iter()
            .any(|p| text.contains(p));
    if model_gone {
        format!(
            "the turn failed: {message}\nThat model is no longer served. Pick another with \
             `osd model ls`, then `osd model set <provider/model>` (or `--model` on this send)."
        )
    } else {
        format!("the turn failed: {message}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_turn_shows_the_providers_message() {
        let err = json!({"name": "APIError", "data": {"message": "Rate limit reached", "statusCode": 429}});
        assert_eq!(turn_failed(&err), "the turn failed: Rate limit reached");
        assert_eq!(turn_failed(&json!("boom")), "the turn failed: \"boom\"");
    }

    #[test]
    fn a_retired_model_says_how_to_pick_another() {
        // The shape OpenCode Zen returned for a retired free model (410).
        let err = json!({"name": "APIError", "data": {
            "message": "Model longcat-2.5-preview-free has been deprecated.",
            "statusCode": 410,
        }});
        let out = turn_failed(&err);
        assert!(out.starts_with("the turn failed: Model longcat-2.5-preview-free has been deprecated."));
        assert!(out.contains("osd model set"), "{out}");
        let unsupported = json!({"data": {"message": "Model ling-3.0-flash-free is not supported"}});
        assert!(turn_failed(&unsupported).contains("osd model ls"));
    }

    #[test]
    fn the_answer_is_the_last_assistant_text_not_the_last_message() {
        let messages = json!([
            { "info": { "role": "user" }, "parts": [{ "type": "text", "text": "hi" }] },
            { "info": { "role": "assistant" }, "parts": [
                { "type": "reasoning", "text": "thinking" },
                { "type": "text", "text": "first" }
            ]},
            { "info": { "role": "assistant" }, "parts": [
                { "type": "tool", "tool": "bash" },
                { "type": "text", "text": "final answer" }
            ]},
        ]);
        assert_eq!(last_assistant_text(&messages, 0).as_deref(), Some("final answer"));

        // A turn that produced only tool calls has no answer to print.
        let toolsonly = json!([
            { "info": { "role": "assistant" }, "parts": [{ "type": "tool", "tool": "bash" }] },
        ]);
        assert_eq!(last_assistant_text(&toolsonly, 0), None);
        assert_eq!(last_assistant_text(&json!([]), 0), None);
    }

    #[test]
    fn a_turn_that_answered_nothing_never_reports_the_previous_answer() {
        // An unavailable model stores the user's message and no reply. Read from
        // the start this transcript ends in an old answer; read from where THIS
        // turn began, it correctly has none — which is what --wait must say.
        let messages = json!([
            { "info": { "role": "user" }, "parts": [{ "type": "text", "text": "say hi" }] },
            { "info": { "role": "assistant" }, "parts": [{ "type": "text", "text": "Hi!" }] },
            { "info": { "role": "user" }, "parts": [{ "type": "text", "text": "again" }] },
        ]);
        assert_eq!(last_assistant_text(&messages, 0).as_deref(), Some("Hi!"));
        assert_eq!(last_assistant_text(&messages, 2), None);
    }

    #[test]
    fn query_values_survive_spaces_and_non_ascii() {
        assert_eq!(urlencode("figures/fig 1.png"), "figures/fig%201.png");
        assert_eq!(urlencode("数据.csv"), "%E6%95%B0%E6%8D%AE.csv");
        assert_eq!(urlencode("a&b=c"), "a%26b%3Dc");
    }
}
