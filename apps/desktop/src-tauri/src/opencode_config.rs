// Pure merge of provider credentials/model into OpenCode config JSON.
// Used by the runtime command, which writes it into an app-private config dir.
use serde_json::{json, Value};

/// Approval modes for agent tool use (the composer's Codex-style switch).
/// OpenCode flattens every ruleset into one list and evaluates it with
/// `findLast`, appending the user config's rules after its builtin ones — so a
/// rule written here always wins over the builtin it overlaps, and rules that
/// overlap nothing simply add to the list.
///
/// The builtin ruleset is `"*": "allow"` for tools, but `external_directory`
/// carries its own `"*": "ask"` sub-map that only pre-allows the worktree and
/// OpenCode's private `<tmpdir>/opencode` scratch dir. That sub-map is why an
/// `ask`-only config still prompts: every path outside the workspace — a
/// literal `/tmp/x.py` included — hits it. Each mode below therefore has to
/// say what it wants for `external_directory` explicitly.
pub const MODE_APPROVE: &str = "approve";
pub const MODE_FULL: &str = "full";

const LEGACY_BROWSER_MCP_ID: &str = "browser-control";
const BROWSER_MCP_ID: &str = "open-science-browser";
const BROWSER_NAMESPACE: &str = "open-science-desktop";
const BROWSER_IDLE_TIMEOUT_MS: &str = "600000";

/// Command tokens the "approve" mode gates behind a prompt, per the AGENTS.md
/// safety defaults: deletion, privilege/system changes, dependency installs,
/// and remote/outward connections. Each token yields two glob rules:
/// `"T *"` (command starts with it; also matches bare `T` — OpenCode turns a
/// trailing " *" into an optional group) and `"* T *"` (embedded in a compound
/// command like `cd x && rm -rf y`; the leading space avoids matching words
/// that merely end in the token).
const DANGEROUS_BASH: &[&str] = &[
    // deletion
    "rm", "rmdir", "shred", "git clean",
    // privilege / system state
    "sudo", "su", "chmod", "chown", "kill", "pkill", "killall", "launchctl",
    "systemctl", "crontab", "osascript", "diskutil", "dd",
    // dependency installs
    "pip install", "pip3 install", "uv add", "uv pip install", "npm install",
    "npm i", "pnpm add", "pnpm install", "yarn add", "conda install",
    "mamba install", "brew install", "cargo install", "gem install",
    "apt install", "apt-get install",
    // remote / outward
    "ssh", "scp", "sftp", "rsync", "curl", "wget", "nc", "git push", "modal",
    "sbatch",
];

/// Add `path` and the other spellings it can legitimately arrive as. macOS
/// reports the per-user temp dir under `/var`, which is a symlink to
/// `/private/var`, so a canonicalized path shows up with that prefix instead;
/// `/tmp` has the same pair. Forward-slashed so the config stays portable.
fn push_temp_root(roots: &mut Vec<String>, path: &str) {
    let normalized = path.replace('\\', "/");
    let root = normalized.trim_end_matches('/');
    if root.is_empty() || roots.iter().any(|r| r == root) {
        return;
    }
    roots.push(root.to_string());
    if let Some(rest) = root.strip_prefix("/var/") {
        push_temp_root(roots, &format!("/private/var/{rest}"));
    } else if root == "/tmp" {
        push_temp_root(roots, "/private/tmp");
    }
}

/// Temp roots the agent may use without a prompt: the OS temp dir, plus the
/// literal `/tmp` that agents reach for on Unix even when `TMPDIR` points
/// elsewhere.
fn temp_roots() -> Vec<String> {
    let mut roots = Vec::new();
    push_temp_root(&mut roots, &std::env::temp_dir().to_string_lossy());
    if cfg!(unix) {
        push_temp_root(&mut roots, "/tmp");
    }
    roots
}

/// `external_directory` allow rules for the temp roots. OpenCode asks with the
/// target's parent directory joined to `*`, so `<root>/*` covers a file sitting
/// directly in the root and `<root>/**` covers anything nested below it.
fn temp_dir_rules() -> serde_json::Map<String, Value> {
    let mut rules = serde_json::Map::new();
    for root in temp_roots() {
        rules.insert(format!("{root}/*"), json!("allow"));
        rules.insert(format!("{root}/**"), json!("allow"));
    }
    rules
}

/// Permission key covering every browser tool. OpenCode names an MCP tool
/// `<server>_<tool>` (each non-`[A-Za-z0-9_-]` character replaced by `_`), and
/// wraps every MCP call in the same `ask` the builtin tools use — with the key
/// matched as a glob, so one pattern covers the whole surface.
fn browser_tools_key() -> String {
    format!("{BROWSER_MCP_ID}_agent_browser_*")
}

fn approve_permission() -> Value {
    let mut bash = serde_json::Map::new();
    for t in DANGEROUS_BASH {
        bash.insert(format!("{t} *"), json!("ask"));
        bash.insert(format!("* {t} *"), json!("ask"));
    }
    let mut permission = json!({
        "bash": Value::Object(bash),
        "webfetch": "ask",
        // Scratch space is not a "dangerous command" — the only thing this mode
        // promises to gate — so the builtin ask on temp paths is pure noise.
        // Everything else outside the workspace still inherits that ask.
        "external_directory": Value::Object(temp_dir_rules()),
    });
    // Driving a browser is an outward connection like `webfetch`, and it was the
    // only one this mode let through silently: MCP tools match OpenCode's
    // builtin `"*": "allow"` and never prompted. That made the cheap tool the
    // one that interrupts and the expensive one the one that does not — exactly
    // backwards. `always: ["*"]` on OpenCode's side means "allow always" saves a
    // rule for the project, so this is one prompt, not one per browser step.
    permission
        .as_object_mut()
        .unwrap()
        .insert(browser_tools_key(), json!("ask"));
    permission
}

/// Set the approval mode in OpenCode config JSON. "approve" installs the ask
/// rules and pre-allows the temp roots; "full" clears every ask this app adds
/// AND overrides the builtin `external_directory` ask, so no path prompts
/// either — the mode means no approvals at all. The key's presence marks that
/// the user made a choice, so startup seeding never overrides it. Other keys
/// are preserved.
pub fn set_permission_mode(existing: &str, mode: &str) -> Result<String, String> {
    let permission = match mode {
        MODE_APPROVE => approve_permission(),
        MODE_FULL => json!({ "external_directory": { "*": "allow" } }),
        other => return Err(format!("unknown approval mode \"{other}\"")),
    };
    let mut root: Value = if existing.trim().is_empty() {
        json!({})
    } else {
        parse_config(existing).map_err(|e| format!("invalid existing config: {e}"))?
    };
    if !root.is_object() {
        root = json!({});
    }
    root.as_object_mut()
        .unwrap()
        .insert("permission".to_string(), permission);
    serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
}

/// Back-fill the `external_directory` rules on a config written before this
/// app set any. Without them OpenCode's builtin `{"*": "ask"}` stays in force
/// and the agent prompts for every path outside the workspace — `/tmp`
/// included — which neither mode intends. Returns None when the key is already
/// there (whatever it holds, including a user's own edit) or when no mode has
/// been chosen yet, so the seeding path stays in charge of first run.
/// Additive: only the missing key is inserted, and re-running changes nothing.
pub fn migrate_external_directory(existing: &str) -> Option<String> {
    let mode = permission_mode_of(existing)?;
    let mut root: Value = read_config(existing)?;
    let permission = root.get_mut("permission")?.as_object_mut()?;
    if permission.contains_key("external_directory") {
        return None;
    }
    let rules = match mode {
        MODE_FULL => json!({ "*": "allow" }),
        _ => Value::Object(temp_dir_rules()),
    };
    permission.insert("external_directory".to_string(), rules);
    serde_json::to_string_pretty(&root).ok()
}

/// Back-fill the browser ask rule for installs that chose "approve" before it
/// existed — a chosen mode is never re-seeded, so without this they would keep
/// driving a browser with no prompt. Approve mode only: "full" means no
/// approvals at all. Returns None once the key is present, whatever it holds,
/// so a user who edits it to "allow" keeps that.
pub fn migrate_browser_permission(existing: &str) -> Option<String> {
    if permission_mode_of(existing)? != MODE_APPROVE {
        return None;
    }
    let mut root: Value = read_config(existing)?;
    let permission = root.get_mut("permission")?.as_object_mut()?;
    let key = browser_tools_key();
    if permission.contains_key(&key) {
        return None;
    }
    permission.insert(key, json!("ask"));
    serde_json::to_string_pretty(&root).ok()
}

/// Seed the "approve" default on first run (no `permission` key yet).
/// Returns None when the user already chose a mode — never overrides it.
pub fn seed_default_permission(existing: &str) -> Option<String> {
    if permission_mode_of(existing).is_some() {
        return None;
    }
    set_permission_mode(existing, MODE_APPROVE).ok()
}

/// Migrate the browser integration. The old id collides with a common
/// user-installed Chrome-extension skill, which can make the agent load
/// instructions for the wrong transport. Preserve the server config, prefer
/// the new entry if both exist, enforce the app-owned lifecycle environment,
/// and hide that incompatible skill while the connector is configured.
pub fn migrate_browser_integration(existing: &str) -> Option<String> {
    let mut root: Value = read_config(existing)?;
    let obj = root.as_object_mut()?;
    let mcp = obj.get_mut("mcp")?.as_object_mut()?;
    let mut changed = false;
    if let Some(legacy) = mcp.remove(LEGACY_BROWSER_MCP_ID) {
        mcp.entry(BROWSER_MCP_ID.to_string()).or_insert(legacy);
        changed = true;
    }
    if !mcp.contains_key(BROWSER_MCP_ID) {
        return None;
    }
    if let Some(server) = mcp.get_mut(BROWSER_MCP_ID).and_then(Value::as_object_mut) {
        let environment = server.entry("environment").or_insert_with(|| json!({}));
        if !environment.is_object() {
            *environment = json!({});
            changed = true;
        }
        let environment = environment.as_object_mut().unwrap();
        for (key, value) in [
            ("AGENT_BROWSER_NAMESPACE", BROWSER_NAMESPACE),
            ("AGENT_BROWSER_IDLE_TIMEOUT_MS", BROWSER_IDLE_TIMEOUT_MS),
        ] {
            if environment.get(key) != Some(&json!(value)) {
                environment.insert(key.to_string(), json!(value));
                changed = true;
            }
        }
    }

    // OpenCode also discovers ~/.claude/skills. A popular, unrelated
    // Chrome-extension skill uses the legacy id, so hide that skill only while
    // this connector is configured. The official bundled skill remains visible
    // as `open-science-browser`.
    let permission = obj.entry("permission").or_insert_with(|| json!({}));
    if let Some(permissions) = permission.as_object_mut() {
        let skill = permissions.entry("skill").or_insert_with(|| json!({}));
        match skill {
            Value::Object(rules) => {
                if rules.get(LEGACY_BROWSER_MCP_ID) != Some(&json!("deny")) {
                    rules.insert(LEGACY_BROWSER_MCP_ID.to_string(), json!("deny"));
                    changed = true;
                }
            }
            Value::String(default) if default != "deny" => {
                let default = default.clone();
                let mut rules = serde_json::Map::new();
                rules.insert("*".to_string(), json!(default));
                rules.insert(LEGACY_BROWSER_MCP_ID.to_string(), json!("deny"));
                *skill = Value::Object(rules);
                changed = true;
            }
            _ => {}
        }
    }
    if changed {
        serde_json::to_string_pretty(&root).ok()
    } else {
        None
    }
}

/// Route an existing browser connector through this desktop executable's MCP
/// ownership proxy. Preserve the selected upstream tool profiles while
/// replacing either an old direct command or a stale install path.
pub fn ensure_browser_mcp_proxy(
    existing: &str,
    proxy_bin: &str,
    agent_browser_bin: &str,
) -> Option<String> {
    let mut root: Value = read_config(existing)?;
    let server = root
        .get_mut("mcp")?
        .get_mut(BROWSER_MCP_ID)?
        .as_object_mut()?;
    let tools = server
        .get("command")
        .and_then(Value::as_array)
        .and_then(|command| {
            command
                .windows(2)
                .find(|pair| pair[0].as_str() == Some("--tools"))
                .and_then(|pair| pair[1].as_str())
        })
        .unwrap_or("core");
    let desired = json!([
        proxy_bin,
        crate::browser_mcp_proxy::PROXY_FLAG,
        agent_browser_bin,
        "mcp",
        "--tools",
        tools
    ]);
    if server.get("command") == Some(&desired) {
        return None;
    }
    server.insert("command".to_string(), desired);
    serde_json::to_string_pretty(&root).ok()
}

/// True only for an existing app connector that predates its private
/// namespace. Startup uses this to close the old default daemon exactly once.
pub fn browser_uses_legacy_namespace(existing: &str) -> bool {
    let Ok(root) = parse_config(existing) else {
        return false;
    };
    let Some(mcp) = root.get("mcp").and_then(Value::as_object) else {
        return false;
    };
    let Some(server) = mcp
        .get(BROWSER_MCP_ID)
        .or_else(|| mcp.get(LEGACY_BROWSER_MCP_ID))
        .and_then(Value::as_object)
    else {
        return false;
    };
    server
        .get("environment")
        .and_then(Value::as_object)
        .and_then(|env| env.get("AGENT_BROWSER_NAMESPACE"))
        .and_then(Value::as_str)
        != Some(BROWSER_NAMESPACE)
}

/// The approval mode a config encodes: None when the `permission` key was
/// never written (first run — the caller seeds the "approve" default).
pub fn permission_mode_of(existing: &str) -> Option<&'static str> {
    let root: Value = read_config(existing)?;
    let permission = root.get("permission")?;
    if permission.get("bash").is_some_and(|b| b.is_object()) {
        Some(MODE_APPROVE)
    } else {
        Some(MODE_FULL)
    }
}

/// Merge provider credentials/model into existing OpenCode config JSON.
/// Empty fields are left untouched; existing unrelated keys are preserved.
pub fn merge_config(
    existing: &str,
    provider: &str,
    api_key: &str,
    model: &str,
    base_url: Option<&str>,
) -> Result<String, String> {
    let mut root: Value = if existing.trim().is_empty() {
        json!({})
    } else {
        parse_config(existing).map_err(|e| format!("invalid existing config: {e}"))?
    };
    if !root.is_object() {
        root = json!({});
    }
    let obj = root.as_object_mut().unwrap();

    if !model.is_empty() {
        obj.insert("model".to_string(), json!(model));
    }

    if !provider.is_empty() {
        let providers = obj.entry("provider").or_insert_with(|| json!({}));
        if !providers.is_object() {
            *providers = json!({});
        }
        let pobj = providers.as_object_mut().unwrap();
        let entry = pobj.entry(provider).or_insert_with(|| json!({}));
        if !entry.is_object() {
            *entry = json!({});
        }
        let options = entry
            .as_object_mut()
            .unwrap()
            .entry("options")
            .or_insert_with(|| json!({}));
        if !options.is_object() {
            *options = json!({});
        }
        let oobj = options.as_object_mut().unwrap();
        if !api_key.is_empty() {
            oobj.insert("apiKey".to_string(), json!(api_key));
        }
        if let Some(b) = base_url {
            if !b.is_empty() {
                oobj.insert("baseURL".to_string(), json!(b));
            }
        }
    }

    serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
}

/// Point the config's `plugin` array at the deployed goal plugin, replacing
/// any stale entry from a previous install location (our entries are
/// recognized by the `goal-plugin.server.js` file name). Returns None when the
/// config already lists exactly this path — no rewrite, no sidecar churn.
/// User-added plugin entries are preserved untouched.
fn ensure_named_plugin(existing: &str, plugin_path: &str, filename: &str) -> Option<String> {
    let mut root: Value = if existing.trim().is_empty() {
        json!({})
    } else {
        read_config(existing)?
    };
    if !root.is_object() {
        root = json!({});
    }
    let obj = root.as_object_mut().unwrap();
    let plugins = obj.entry("plugin").or_insert_with(|| json!([]));
    if !plugins.is_array() {
        *plugins = json!([]);
    }
    let arr = plugins.as_array_mut().unwrap();
    let ours = |v: &Value| v.as_str().is_some_and(|s| s.ends_with(filename));
    if arr.iter().any(|v| v.as_str() == Some(plugin_path)) && arr.iter().filter(|v| ours(v)).count() == 1 {
        return None; // already exactly right
    }
    arr.retain(|v| !ours(v));
    arr.push(json!(plugin_path));
    serde_json::to_string_pretty(&root).ok()
}

pub fn ensure_goal_plugin(existing: &str, plugin_path: &str) -> Option<String> {
    ensure_named_plugin(existing, plugin_path, "goal-plugin.server.js")
}

pub fn ensure_browser_guard_plugin(existing: &str, plugin_path: &str) -> Option<String> {
    ensure_named_plugin(existing, plugin_path, "browser-guard.ts")
}

/// Project memory: OpenCode resolves a relative `instructions` entry against
/// the session's working directory, so this one entry gives every project its
/// own memory file without any per-project config.
pub const PROJECT_MEMORY_FILE: &str = "AGENTS.md";

/// Copy one JSON string literal, starting at the opening quote, byte for byte.
/// Returns the index just past the closing quote. Comment and trailing-comma
/// removal must never look inside a string — this config is full of URLs, and
/// `"https://opencode.ai/config.json"` contains a `//` that is not a comment.
fn copy_string_literal(src: &[u8], mut i: usize, out: &mut Vec<u8>) -> usize {
    out.push(src[i]);
    i += 1;
    while i < src.len() {
        let byte = src[i];
        out.push(byte);
        i += 1;
        if byte == b'\\' {
            if i < src.len() {
                out.push(src[i]);
                i += 1;
            }
        } else if byte == b'"' {
            break;
        }
    }
    i
}

/// Reduce JSONC to JSON: drop `//` and `/* */` comments and commas that only
/// precede a closing brace or bracket. Byte-wise, and every byte outside a
/// comment is copied unchanged, so multi-byte UTF-8 passes through intact.
fn strip_jsonc(input: &str) -> String {
    let src = input.as_bytes();
    let mut uncommented: Vec<u8> = Vec::with_capacity(src.len());
    let mut i = 0;
    while i < src.len() {
        match src[i] {
            b'"' => i = copy_string_literal(src, i, &mut uncommented),
            b'/' if src.get(i + 1) == Some(&b'/') => {
                while i < src.len() && src[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if src.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i + 1 < src.len() && !(src[i] == b'*' && src[i + 1] == b'/') {
                    i += 1;
                }
                i = src.len().min(i + 2);
            }
            byte => {
                uncommented.push(byte);
                i += 1;
            }
        }
    }

    let mut out: Vec<u8> = Vec::with_capacity(uncommented.len());
    let mut i = 0;
    while i < uncommented.len() {
        if uncommented[i] == b'"' {
            i = copy_string_literal(&uncommented, i, &mut out);
            continue;
        }
        if uncommented[i] == b',' {
            let mut j = i + 1;
            while j < uncommented.len() && uncommented[j].is_ascii_whitespace() {
                j += 1;
            }
            if matches!(uncommented.get(j), Some(b'}') | Some(b']')) {
                i += 1;
                continue;
            }
        }
        out.push(uncommented[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| input.to_string())
}

/// Parse the runtime config into an object. Three outcomes, and they must stay
/// distinct: an empty file is a fresh profile, a readable file is itself, and a
/// file we cannot read is one that must not be touched.
///
/// The file is read by whichever name exists, `opencode.json` or the
/// `opencode.jsonc` the server may rewrite it as, so JSONC is tolerated on the
/// way in and normalized on the way out. What remains unreadable after that is
/// reported, never treated as empty: every caller writes the value back, so
/// substituting `{}` would replace the user's provider keys, MCP servers and
/// approval mode with a stub — and OpenCode, which parses JSONC itself, would
/// keep loading the file we just destroyed.
fn parse_config(existing: &str) -> Result<Value, String> {
    // A UTF-8 BOM is an encoding marker, not content, and serde_json rejects a
    // document that starts with one ("expected value at line 1 column 1").
    // Windows puts it there by default — PowerShell's `Set-Content -Encoding
    // UTF8` and Notepad both do, verified on a Windows 11 box — so a user who
    // opens this file to look at it can make the app unable to read it again.
    let existing = existing.strip_prefix('\u{feff}').unwrap_or(existing);
    if existing.trim().is_empty() {
        return Ok(json!({}));
    }
    let parsed = serde_json::from_str::<Value>(existing)
        .or_else(|_| serde_json::from_str::<Value>(&strip_jsonc(existing)));
    match parsed {
        Ok(value) if value.is_object() => Ok(value),
        Ok(_) => Err("config is not a JSON object".to_string()),
        Err(error) => Err(error.to_string()),
    }
}

/// `parse_config` for the callers that answer with `None`. The failure is
/// logged rather than swallowed: leaving the config alone is the safe choice,
/// but a config the app can no longer edit stops every later repair silently —
/// including the plugin registration the browser lease depends on (#116).
fn read_config(existing: &str) -> Option<Value> {
    match parse_config(existing) {
        Ok(value) => Some(value),
        Err(error) => {
            eprintln!(
                "opencode config is unreadable and was left untouched: {error} \
                 — no app setting can be applied until it parses"
            );
            None
        }
    }
}


/// Turn OpenCode's automatic context compaction on the first time we see a
/// config without a `compaction` block. Without it a long conversation ends in
/// "Input exceeds context window" (#62); with it the runtime summarizes the
/// older turns and carries on in the same session. Set explicitly rather than
/// relying on the runtime default, and never overridden once the key exists —
/// a user who turned it off keeps it off. Returns None when nothing to do.
pub fn seed_compaction(existing: &str) -> Option<String> {
    let mut root = read_config(existing)?;
    let obj = root.as_object_mut().unwrap();
    if obj.contains_key("compaction") {
        return None;
    }
    obj.insert("compaction".to_string(), json!({ "auto": true }));
    serde_json::to_string_pretty(&root).ok()
}

/// Whether the memory layers are applied to conversations: true when BOTH the
/// global memory file and the per-project entry are listed in `instructions`.
pub fn memory_enabled(existing: &str, global_path: &str) -> bool {
    let Some(root) = read_config(existing) else {
        return false;
    };
    let Some(arr) = root.get("instructions").and_then(|v| v.as_array()) else {
        return false;
    };
    let has = |want: &str| arr.iter().any(|v| v.as_str() == Some(want));
    has(global_path) && has(PROJECT_MEMORY_FILE)
}

/// Add (or remove) the memory instruction entries, leaving any instruction the
/// user added themselves untouched. Returns None when the config already says
/// what we want — no write, no sidecar restart.
pub fn set_memory_enabled(existing: &str, global_path: &str, enabled: bool) -> Option<String> {
    if memory_enabled(existing, global_path) == enabled {
        return None;
    }
    let mut root = read_config(existing)?;
    let obj = root.as_object_mut().unwrap();
    let list = obj.entry("instructions").or_insert_with(|| json!([]));
    if !list.is_array() {
        *list = json!([]);
    }
    let arr = list.as_array_mut().unwrap();
    // Drop any stale copy first: the global path moves with the profile dir,
    // so an old absolute path must not linger and load someone else's memory.
    arr.retain(|v| {
        let s = v.as_str().unwrap_or_default();
        s != PROJECT_MEMORY_FILE && !s.ends_with("/MEMORY.md") && !s.ends_with("\\MEMORY.md")
    });
    if enabled {
        arr.push(json!(global_path));
        arr.push(json!(PROJECT_MEMORY_FILE));
    }
    if arr.is_empty() {
        obj.remove("instructions");
    }
    serde_json::to_string_pretty(&root).ok()
}

/// One string field of `agent.<name>`, for every agent that sets it. Agents with
/// no override are absent — they follow the global default.
fn agent_field(existing: &str, field: &str) -> Vec<(String, String)> {
    let Some(root) = read_config(existing) else {
        return Vec::new();
    };
    let Some(agents) = root.get("agent").and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    let mut out: Vec<(String, String)> = agents
        .iter()
        .filter_map(|(name, cfg)| {
            let value = cfg.get(field)?.as_str()?;
            Some((name.clone(), value.to_string()))
        })
        .collect();
    out.sort();
    out
}

/// Write one string field of `agent.<name>` (`None` clears it). Only the key we
/// own is touched, and the agent wrapper is removed only once it empties, so an
/// agent config the user wrote themselves survives.
fn set_agent_field(existing: &str, agent: &str, field: &str, value: Option<&str>) -> String {
    let Some(mut root) = read_config(existing) else {
        return existing.to_string();
    };
    let obj = root.as_object_mut().unwrap();
    let agents = obj.entry("agent").or_insert_with(|| json!({}));
    if !agents.is_object() {
        *agents = json!({});
    }
    let aobj = agents.as_object_mut().unwrap();
    match value {
        Some(v) if !v.is_empty() => {
            let entry = aobj.entry(agent).or_insert_with(|| json!({}));
            if !entry.is_object() {
                *entry = json!({});
            }
            entry
                .as_object_mut()
                .unwrap()
                .insert(field.to_string(), json!(v));
        }
        _ => {
            if let Some(entry) = aobj.get_mut(agent).and_then(|v| v.as_object_mut()) {
                entry.remove(field);
                if entry.is_empty() {
                    aobj.remove(agent);
                }
            }
        }
    }
    if aobj.is_empty() {
        obj.remove("agent");
    }
    serde_json::to_string_pretty(&root).unwrap_or_else(|_| existing.to_string())
}

/// Which model each agent runs, from `agent.<name>.model`. Agents with no
/// override are absent — they follow the global default model.
pub fn agent_models(existing: &str) -> Vec<(String, String)> {
    agent_field(existing, "model")
}

/// Pin one agent to its own model (`None` clears the override so it follows the
/// default again). Lets a reviewer subagent run a fast model while the main
/// agent reasons on a strong one (#63).
pub fn set_agent_model(existing: &str, agent: &str, model: Option<&str>) -> String {
    set_agent_field(existing, agent, "model", model)
}

/// Which reasoning-effort variant each agent runs at, from `agent.<name>.variant`
/// — the same vocabulary the composer's per-turn effort slider uses ("low",
/// "high", …), named per model. Agents with no override run the model default.
pub fn agent_variants(existing: &str) -> Vec<(String, String)> {
    agent_field(existing, "variant")
}

/// Pin one agent to a reasoning-effort variant (`None` clears it). The composer's
/// effort slider only reaches the turn the user sends; subagents get their effort
/// from here (#71), so a reviewer can think hard while a titler stays cheap.
pub fn set_agent_variant(existing: &str, agent: &str, variant: Option<&str>) -> String {
    set_agent_field(existing, agent, "variant", variant)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A config the app cannot read must survive untouched. Before this, the
    /// lenient parse behind `seed_compaction` turned an unparseable file into
    /// `{}` and wrote it back, so one launch replaced the user's provider keys,
    /// MCP servers, approval mode and model with a three-key stub (#116).
    #[test]
    fn an_unreadable_config_is_never_overwritten() {
        // Not JSONC — genuinely broken, and it must stay exactly as it is.
        let broken = r#"{"model": "openai/gpt-5.6", "provider": {"openai": "#;
        assert!(seed_compaction(broken).is_none());
        assert!(set_memory_enabled(broken, "/m/MEMORY.md", true).is_none());
        assert!(ensure_goal_plugin(broken, "/g/goal-plugin.server.js").is_none());
        assert!(ensure_browser_guard_plugin(broken, "/g/browser-guard.ts").is_none());
        assert!(migrate_external_directory(broken).is_none());
        assert!(migrate_browser_integration(broken).is_none());
        assert!(ensure_browser_mcp_proxy(broken, "/p", "/a").is_none());
        assert_eq!(set_agent_model(broken, "build", Some("openai/x")), broken);
        assert!(agent_models(broken).is_empty());
        assert!(set_permission_mode(broken, MODE_APPROVE).is_err());
        // An empty file is a fresh profile, not an unreadable one.
        assert!(seed_compaction("").is_some());
    }

    /// The file is read under whichever name exists, and OpenCode may rewrite
    /// it as `opencode.jsonc`. JSONC therefore has to survive the round trip
    /// instead of stopping every repair the app makes on startup.
    #[test]
    fn jsonc_config_is_read_and_normalized() {
        let jsonc = r#"// runtime profile
{
  "$schema": "https://opencode.ai/config.json", // not a comment
  "model": "openai/gpt-5.6",
  /* block */
  "provider": {"openai": {"options": {"apiKey": "sk-SECRET"}}},
  "mcp": {"open-science-browser": {"enabled": true}},
  "plugin": ["/app/goal-plugin.server.js",],
}"#;
        let out = ensure_browser_guard_plugin(jsonc, "/g/browser-guard.ts")
            .expect("a JSONC config must still be repairable");
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            v["plugin"],
            json!(["/app/goal-plugin.server.js", "/g/browser-guard.ts"])
        );
        // Everything else survives, including the `//` inside a string value.
        assert_eq!(v["$schema"], json!("https://opencode.ai/config.json"));
        assert_eq!(v["provider"]["openai"]["options"]["apiKey"], json!("sk-SECRET"));
        assert_eq!(v["mcp"]["open-science-browser"]["enabled"], json!(true));
        assert_eq!(v["model"], json!("openai/gpt-5.6"));
    }

    #[test]
    fn strip_jsonc_leaves_string_contents_alone() {
        // Escaped quotes must not end the literal early, or the `//` and the
        // trailing comma inside these values would be eaten as syntax.
        let input = r#"{"a": "http://x/y", "b": "sees \" then // and /* */", "c": [1,],}"#;
        let v: Value = serde_json::from_str(&strip_jsonc(input)).unwrap();
        assert_eq!(v["a"], json!("http://x/y"));
        assert_eq!(v["b"], json!("sees \" then // and /* */"));
        assert_eq!(v["c"], json!([1]));
    }

    /// These are the exact bytes PowerShell's `Set-Content -Encoding UTF8`
    /// produced on a Windows 11 machine: a UTF-8 BOM, CRLF line endings, and a
    /// trailing newline. Notepad writes the same BOM. serde_json rejects a
    /// document that starts with one, so without this the app would go
    /// permanently read-only on its own config the first time a user opened it
    /// in an editor to check the `plugin` list — while investigating #116.
    #[test]
    fn a_windows_written_config_is_still_readable() {
        let windows_bytes: &[u8] = &[
            0xef, 0xbb, 0xbf, // UTF-8 BOM
            b'{', b'"', b'm', b'o', b'd', b'e', b'l', b'"', b':', b' ', b'"', b'x', b'"', b',',
            b'\r', b'\n', b' ', b'"', b'p', b'l', b'u', b'g', b'i', b'n', b'"', b':', b' ', b'[',
            b']', b'}', b'\r', b'\n',
        ];
        let text = std::str::from_utf8(windows_bytes).unwrap();
        assert!(
            serde_json::from_str::<Value>(text).is_err(),
            "precondition: a BOM is what breaks the plain parse"
        );
        let out = ensure_browser_guard_plugin(text, "/g/browser-guard.ts")
            .expect("a config written by a Windows editor must stay editable");
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["plugin"], json!(["/g/browser-guard.ts"]));
        assert_eq!(v["model"], json!("x"));
        // A file holding nothing but a BOM is a fresh profile, not a broken one.
        assert!(seed_compaction("\u{feff}").is_some());
    }

    /// CRLF must not change how comments end or how a trailing comma is seen.
    #[test]
    fn strip_jsonc_handles_crlf_line_endings() {
        let input = "{\r\n  \"a\": 1, // note\r\n  \"b\": [2,],\r\n}";
        let v: Value = serde_json::from_str(&strip_jsonc(input)).unwrap();
        assert_eq!(v["a"], json!(1));
        assert_eq!(v["b"], json!([2]));
    }

    #[test]
    fn strip_jsonc_preserves_multibyte_values() {
        let input = "{\"note\": \"中文 — dash\"} // 尾注";
        let v: Value = serde_json::from_str(&strip_jsonc(input)).unwrap();
        assert_eq!(v["note"], json!("中文 — dash"));
    }

    #[test]
    fn migrates_legacy_browser_mcp_id_and_adds_owned_lifecycle() {
        let start = r#"{
          "model": "provider/model",
          "mcp": {
            "browser-control": {"type":"local","command":["agent-browser","mcp"]},
            "jupyter": {"type":"local","command":["jupyter-mcp"]}
          }
        }"#;
        let out = migrate_browser_integration(start).expect("legacy id is present");
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v["mcp"].get("browser-control").is_none());
        assert_eq!(
            v["mcp"]["open-science-browser"],
            json!({
                "type":"local",
                "command":["agent-browser","mcp"],
                "environment": {
                    "AGENT_BROWSER_NAMESPACE": "open-science-desktop",
                    "AGENT_BROWSER_IDLE_TIMEOUT_MS": "600000"
                }
            })
        );
        assert_eq!(
            v["mcp"]["jupyter"],
            json!({"type":"local","command":["jupyter-mcp"]})
        );
        assert_eq!(v["model"], json!("provider/model"));
        assert_eq!(v["permission"]["skill"]["browser-control"], "deny");
        assert!(migrate_browser_integration(&out).is_none());
    }

    #[test]
    fn browser_mcp_migration_keeps_an_existing_new_entry() {
        let start = r#"{"mcp":{"browser-control":{"old":true},"open-science-browser":{"new":true}}}"#;
        let out = migrate_browser_integration(start).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v["mcp"].get("browser-control").is_none());
        assert_eq!(v["mcp"]["open-science-browser"]["new"], json!(true));
        assert_eq!(
            v["mcp"]["open-science-browser"]["environment"]["AGENT_BROWSER_NAMESPACE"],
            "open-science-desktop"
        );
    }

    #[test]
    fn browser_integration_hides_the_incompatible_user_skill() {
        let start = r#"{
          "mcp":{"open-science-browser":{"enabled":true}},
          "permission":{"skill":{"*":"allow","browser-control":"allow"}}
        }"#;
        let out = migrate_browser_integration(start).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["permission"]["skill"]["*"], "allow");
        assert_eq!(v["permission"]["skill"]["browser-control"], "deny");
        assert!(migrate_browser_integration(&out).is_none());
    }

    #[test]
    fn browser_integration_leaves_user_skill_alone_without_the_connector() {
        let start = r#"{"permission":{"skill":{"browser-control":"allow"}}}"#;
        assert!(migrate_browser_integration(start).is_none());
    }

    #[test]
    fn existing_browser_config_is_upgraded_once_and_detects_legacy_namespace() {
        let start = r#"{"mcp":{"open-science-browser":{"environment":{"AGENT_BROWSER_PROFILE":"Default"}}}}"#;
        assert!(browser_uses_legacy_namespace(start));
        let out = migrate_browser_integration(start).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let env = &v["mcp"]["open-science-browser"]["environment"];
        assert_eq!(env["AGENT_BROWSER_PROFILE"], "Default");
        assert_eq!(env["AGENT_BROWSER_NAMESPACE"], "open-science-desktop");
        assert_eq!(env["AGENT_BROWSER_IDLE_TIMEOUT_MS"], "600000");
        assert!(!browser_uses_legacy_namespace(&out));
        assert!(migrate_browser_integration(&out).is_none());
    }

    #[test]
    fn browser_connector_is_routed_through_the_ownership_proxy_once() {
        let start = r#"{
          "model":"provider/model",
          "mcp":{"open-science-browser":{
            "type":"local",
            "command":["/old/agent-browser","mcp","--tools","core,tabs"]
          }}
        }"#;
        let out = ensure_browser_mcp_proxy(start, "/app/desktop", "/app/agent-browser").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            v["mcp"]["open-science-browser"]["command"],
            json!([
                "/app/desktop",
                "--browser-mcp",
                "/app/agent-browser",
                "mcp",
                "--tools",
                "core,tabs"
            ])
        );
        assert_eq!(v["model"], "provider/model");
        assert!(ensure_browser_mcp_proxy(&out, "/app/desktop", "/app/agent-browser").is_none());
    }

    #[test]
    fn seeds_auto_compaction_once_and_respects_the_user_turning_it_off() {
        let seeded = seed_compaction("{}").expect("seeds into an empty config");
        let v: Value = serde_json::from_str(&seeded).unwrap();
        assert_eq!(v["compaction"]["auto"], json!(true));
        // Already present — including a deliberate off — is left alone.
        assert!(seed_compaction(&seeded).is_none());
        assert!(seed_compaction(r#"{"compaction":{"auto":false}}"#).is_none());
    }

    #[test]
    fn memory_entries_go_in_and_come_back_out_without_touching_the_user_list() {
        let start = r#"{"instructions":["docs/style.md"]}"#;
        let on = set_memory_enabled(start, "/profile/MEMORY.md", true).unwrap();
        let v: Value = serde_json::from_str(&on).unwrap();
        assert_eq!(
            v["instructions"],
            json!(["docs/style.md", "/profile/MEMORY.md", "AGENTS.md"])
        );
        assert!(memory_enabled(&on, "/profile/MEMORY.md"));
        // Idempotent: no rewrite (and so no sidecar restart) when already on.
        assert!(set_memory_enabled(&on, "/profile/MEMORY.md", true).is_none());

        let off = set_memory_enabled(&on, "/profile/MEMORY.md", false).unwrap();
        let v: Value = serde_json::from_str(&off).unwrap();
        assert_eq!(v["instructions"], json!(["docs/style.md"]));
        assert!(!memory_enabled(&off, "/profile/MEMORY.md"));
    }

    #[test]
    fn a_moved_profile_replaces_the_stale_global_memory_path() {
        let old = set_memory_enabled("{}", "/old/MEMORY.md", true).unwrap();
        let new = set_memory_enabled(&old, "/new/MEMORY.md", true).unwrap();
        let v: Value = serde_json::from_str(&new).unwrap();
        assert_eq!(v["instructions"], json!(["/new/MEMORY.md", "AGENTS.md"]));
    }

    #[test]
    fn dropping_instructions_entirely_removes_the_empty_key() {
        let on = set_memory_enabled("{}", "/p/MEMORY.md", true).unwrap();
        let off = set_memory_enabled(&on, "/p/MEMORY.md", false).unwrap();
        let v: Value = serde_json::from_str(&off).unwrap();
        assert!(v.get("instructions").is_none());
    }

    #[test]
    fn per_agent_models_are_set_read_and_cleared() {
        let out = set_agent_model("{}", "general", Some("anthropic/claude-haiku-4-5"));
        assert_eq!(
            agent_models(&out),
            vec![("general".to_string(), "anthropic/claude-haiku-4-5".to_string())]
        );
        let cleared = set_agent_model(&out, "general", None);
        assert!(agent_models(&cleared).is_empty());
        // The whole `agent` map goes away rather than lingering empty.
        let v: Value = serde_json::from_str(&cleared).unwrap();
        assert!(v.get("agent").is_none());
    }

    #[test]
    fn clearing_a_model_keeps_the_rest_of_that_agents_config() {
        let start = r#"{"agent":{"plan":{"model":"a/b","temperature":0.2}}}"#;
        let cleared = set_agent_model(start, "plan", None);
        let v: Value = serde_json::from_str(&cleared).unwrap();
        assert_eq!(v["agent"]["plan"], json!({ "temperature": 0.2 }));
    }

    #[test]
    fn per_agent_variants_are_set_read_and_cleared() {
        let out = set_agent_variant("{}", "reviewer", Some("high"));
        assert_eq!(
            agent_variants(&out),
            vec![("reviewer".to_string(), "high".to_string())]
        );
        let cleared = set_agent_variant(&out, "reviewer", None);
        assert!(agent_variants(&cleared).is_empty());
        let v: Value = serde_json::from_str(&cleared).unwrap();
        assert!(v.get("agent").is_none());
    }

    #[test]
    fn model_and_variant_are_independent_on_the_same_agent() {
        // Both live under one agent entry, and clearing either leaves the other
        // — the Settings row writes them with two separate calls.
        let with_model = set_agent_model("{}", "reviewer", Some("anthropic/claude-haiku-4-5"));
        let both = set_agent_variant(&with_model, "reviewer", Some("low"));
        let v: Value = serde_json::from_str(&both).unwrap();
        assert_eq!(
            v["agent"]["reviewer"],
            json!({ "model": "anthropic/claude-haiku-4-5", "variant": "low" })
        );
        let no_model = set_agent_model(&both, "reviewer", None);
        assert_eq!(
            agent_variants(&no_model),
            vec![("reviewer".to_string(), "low".to_string())]
        );
        assert!(agent_models(&no_model).is_empty());
        // Dropping the last key we own takes the wrapper with it.
        let neither = set_agent_variant(&no_model, "reviewer", None);
        let v: Value = serde_json::from_str(&neither).unwrap();
        assert!(v.get("agent").is_none());
    }

    #[test]
    fn writes_provider_key_model_into_empty_config() {
        let out = merge_config("", "anthropic", "sk-test", "anthropic/claude-sonnet-4-5", None).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["model"], "anthropic/claude-sonnet-4-5");
        assert_eq!(v["provider"]["anthropic"]["options"]["apiKey"], "sk-test");
    }

    #[test]
    fn preserves_existing_unrelated_config() {
        let existing = r#"{"theme":"dark","provider":{"openai":{"options":{"apiKey":"old"}}}}"#;
        let out = merge_config(existing, "anthropic", "sk-new", "", None).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["theme"], "dark");
        assert_eq!(v["provider"]["openai"]["options"]["apiKey"], "old");
        assert_eq!(v["provider"]["anthropic"]["options"]["apiKey"], "sk-new");
    }

    #[test]
    fn sets_base_url_when_provided() {
        let out = merge_config("", "openai", "k", "openai/gpt-4o", Some("https://x/v1")).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["provider"]["openai"]["options"]["baseURL"], "https://x/v1");
    }

    #[test]
    fn approve_mode_writes_ask_rules_for_dangerous_bash() {
        let out = set_permission_mode("", MODE_APPROVE).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let bash = v["permission"]["bash"].as_object().unwrap();
        // Prefix form gates a command that starts with the token (also bare,
        // via OpenCode's trailing-" *" optionalization)…
        assert_eq!(bash["rm *"], "ask");
        assert_eq!(bash["pip install *"], "ask");
        assert_eq!(bash["git push *"], "ask");
        // …and the embedded form catches it inside a compound command
        // ("cd x && rm -rf y").
        assert_eq!(bash["* rm *"], "ask");
        assert_eq!(bash["* ssh *"], "ask");
        // No blanket rule of our own: everything else falls through to the
        // builtin "*": "allow" (rules are last-match-wins, ours come last).
        assert!(!bash.contains_key("*"));
        assert_eq!(v["permission"]["webfetch"], "ask");
        // An outward connection through the browser is gated like webfetch;
        // without this rule MCP tools match the builtin "*": "allow" and the
        // expensive path is the silent one.
        assert_eq!(v["permission"]["open-science-browser_agent_browser_*"], "ask");
    }

    #[test]
    fn browser_ask_is_backfilled_for_approve_mode_only() {
        // Approve-mode config written before the browser rule existed.
        let stale = r#"{"permission":{"bash":{"rm *":"ask"},"webfetch":"ask"}}"#;
        let out = migrate_browser_permission(stale).expect("approve config is back-filled");
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["permission"]["open-science-browser_agent_browser_*"], "ask");
        // Idempotent, and a user who relaxed the rule keeps their choice.
        assert!(migrate_browser_permission(&out).is_none());
        let relaxed = r#"{"permission":{"bash":{"rm *":"ask"},
            "open-science-browser_agent_browser_*":"allow"}}"#;
        assert!(migrate_browser_permission(relaxed).is_none());
        // Full mode means no approvals at all — nothing to back-fill there.
        let full = set_permission_mode("", MODE_FULL).unwrap();
        assert!(migrate_browser_permission(&full).is_none());
        // First run has no mode yet; seeding owns that path.
        assert!(migrate_browser_permission("{}").is_none());
    }

    #[test]
    fn full_mode_drops_our_asks_and_overrides_the_builtin_path_ask() {
        let approved = set_permission_mode("", MODE_APPROVE).unwrap();
        let out = set_permission_mode(&approved, MODE_FULL).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        // Every ask this app adds is gone…
        assert_eq!(v["permission"], json!({ "external_directory": { "*": "allow" } }));
        assert!(v["permission"].get("bash").is_none());
        assert!(v["permission"].get("webfetch").is_none());
        // …and the one remaining rule exists to beat OpenCode's builtin
        // `external_directory: {"*": "ask"}`, which an empty object would
        // leave in force and which is what made "full" still prompt on
        // every path outside the workspace.
        assert_eq!(v["permission"]["external_directory"]["*"], "allow");
        // The key's presence still marks "user chose this", so startup never
        // re-seeds approve mode over it.
        assert_eq!(permission_mode_of(&out), Some(MODE_FULL));
    }

    #[test]
    fn approve_mode_preallows_temp_roots_only() {
        let out = set_permission_mode("", MODE_APPROVE).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let ext = v["permission"]["external_directory"].as_object().unwrap();
        // Both spellings for each root: OpenCode asks with the target's parent
        // joined to "*", so a file directly in the root needs "<root>/*" and
        // anything nested needs "<root>/**".
        for root in temp_roots() {
            assert_eq!(ext[&format!("{root}/*")], "allow");
            assert_eq!(ext[&format!("{root}/**")], "allow");
        }
        // No blanket allow: everything else outside the workspace still
        // inherits the builtin ask, which is the point of this mode.
        assert!(!ext.contains_key("*"));
        assert!(!ext.is_empty());
    }

    #[test]
    fn migrate_external_directory_backfills_each_mode_once() {
        // An approve-mode config written before this app set any path rules.
        let stale = r#"{"permission":{"bash":{"rm *":"ask"},"webfetch":"ask"}}"#;
        let out = migrate_external_directory(stale).expect("approve config is back-filled");
        let v: Value = serde_json::from_str(&out).unwrap();
        let ext = v["permission"]["external_directory"].as_object().unwrap();
        assert!(!ext.contains_key("*"), "approve keeps the builtin ask for other paths");
        assert!(!ext.is_empty());
        // Existing rules survive, and a second pass is a no-op.
        assert_eq!(v["permission"]["bash"]["rm *"], "ask");
        assert_eq!(v["permission"]["webfetch"], "ask");
        assert!(migrate_external_directory(&out).is_none());

        // The old full-mode marker was a bare {} — it gets the blanket allow.
        let out = migrate_external_directory(r#"{"permission":{}}"#).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["permission"]["external_directory"]["*"], "allow");

        // Never touches a config that has no mode yet (first run seeds it), and
        // never overwrites rules already present — including a user's own.
        assert!(migrate_external_directory("{}").is_none());
        assert!(
            migrate_external_directory(r#"{"permission":{"external_directory":{"*":"deny"}}}"#)
                .is_none()
        );
    }

    #[test]
    fn temp_roots_are_deduped_and_cover_the_private_aliases() {
        let mut roots = Vec::new();
        push_temp_root(&mut roots, "/var/folders/ab/T/");
        push_temp_root(&mut roots, "/tmp");
        // A trailing slash is trimmed, and re-adding the same root is a no-op.
        push_temp_root(&mut roots, "/tmp/");
        assert_eq!(
            roots,
            vec!["/var/folders/ab/T", "/private/var/folders/ab/T", "/tmp", "/private/tmp"]
        );
    }

    #[test]
    fn set_permission_mode_preserves_unrelated_keys() {
        let existing = r#"{"model":"anthropic/claude","provider":{"openai":{"options":{"apiKey":"k"}}}}"#;
        let out = set_permission_mode(existing, MODE_APPROVE).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["model"], "anthropic/claude");
        assert_eq!(v["provider"]["openai"]["options"]["apiKey"], "k");
    }

    #[test]
    fn set_permission_mode_rejects_unknown_mode() {
        assert!(set_permission_mode("", "off").is_err());
    }

    #[test]
    fn ensure_goal_plugin_adds_entry_to_empty_config() {
        let out = ensure_goal_plugin("", "/app/goal-plugin.server.js").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["plugin"], json!(["/app/goal-plugin.server.js"]));
    }

    #[test]
    fn ensure_goal_plugin_replaces_stale_path_and_keeps_others() {
        let existing = r#"{"plugin":["my-other-plugin","/old/place/goal-plugin.server.js"],"model":"m"}"#;
        let out = ensure_goal_plugin(existing, "/new/goal-plugin.server.js").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["plugin"], json!(["my-other-plugin", "/new/goal-plugin.server.js"]));
        assert_eq!(v["model"], "m"); // unrelated keys preserved
    }

    #[test]
    fn ensure_goal_plugin_is_idempotent() {
        let existing = r#"{"plugin":["/app/goal-plugin.server.js"]}"#;
        assert!(ensure_goal_plugin(existing, "/app/goal-plugin.server.js").is_none());
    }


    #[test]
    fn ensure_browser_guard_plugin_replaces_only_its_own_stale_path() {
        let existing = r#"{"plugin":["/app/goal-plugin.server.js","/old/browser-guard.ts"]}"#;
        let out = ensure_browser_guard_plugin(existing, "/new/browser-guard.ts").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            v["plugin"],
            json!(["/app/goal-plugin.server.js", "/new/browser-guard.ts"])
        );
        assert!(ensure_browser_guard_plugin(&out, "/new/browser-guard.ts").is_none());
    }

    #[test]
    fn seeds_approve_default_only_when_never_configured() {
        // First run: no permission key → seed the safe default.
        let seeded = seed_default_permission("").unwrap();
        let v: Value = serde_json::from_str(&seeded).unwrap();
        assert_eq!(v["permission"]["bash"]["rm *"], "ask");
        // Explicit user choice (either mode) is never overridden.
        assert!(seed_default_permission(&seeded).is_none());
        let full = set_permission_mode(&seeded, MODE_FULL).unwrap();
        assert!(seed_default_permission(&full).is_none());
        // Other keys survive seeding.
        let seeded2 = seed_default_permission(r#"{"model":"m"}"#).unwrap();
        let v2: Value = serde_json::from_str(&seeded2).unwrap();
        assert_eq!(v2["model"], "m");
    }

    #[test]
    fn permission_mode_of_detects_each_state() {
        // Never configured (first run) — the caller must seed the default.
        assert_eq!(permission_mode_of(""), None);
        assert_eq!(permission_mode_of(r#"{"model":"m"}"#), None);
        let approved = set_permission_mode("", MODE_APPROVE).unwrap();
        assert_eq!(permission_mode_of(&approved), Some(MODE_APPROVE));
        let full = set_permission_mode(&approved, MODE_FULL).unwrap();
        assert_eq!(permission_mode_of(&full), Some(MODE_FULL));
    }
}

