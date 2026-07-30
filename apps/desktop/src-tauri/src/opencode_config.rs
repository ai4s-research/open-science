// Pure merge of provider credentials/model into OpenCode config JSON.
// Used by the runtime command, which writes it into an app-private config dir.
use serde_json::{json, Value};

/// Approval modes for agent tool use (the composer's Codex-style switch).
/// OpenCode evaluates permission rules last-match-wins with user config rules
/// appended after its builtin `"*": "allow"` — so "approve" only needs `ask`
/// rules and everything unmatched still runs without a prompt.
pub const MODE_APPROVE: &str = "approve";
pub const MODE_FULL: &str = "full";

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

fn approve_permission() -> Value {
    let mut bash = serde_json::Map::new();
    for t in DANGEROUS_BASH {
        bash.insert(format!("{t} *"), json!("ask"));
        bash.insert(format!("* {t} *"), json!("ask"));
    }
    json!({ "bash": Value::Object(bash), "webfetch": "ask" })
}

/// Set the approval mode in OpenCode config JSON. "approve" installs the ask
/// rules; "full" writes `"permission": {}` — zero rules (builtin defaults),
/// with the key's presence marking that the user made a choice (so startup
/// seeding never overrides it). Other keys are preserved.
pub fn set_permission_mode(existing: &str, mode: &str) -> Result<String, String> {
    let permission = match mode {
        MODE_APPROVE => approve_permission(),
        MODE_FULL => json!({}),
        other => return Err(format!("unknown approval mode \"{other}\"")),
    };
    let mut root: Value = if existing.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(existing).map_err(|e| format!("invalid existing config: {e}"))?
    };
    if !root.is_object() {
        root = json!({});
    }
    root.as_object_mut()
        .unwrap()
        .insert("permission".to_string(), permission);
    serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
}

/// Seed the "approve" default on first run (no `permission` key yet).
/// Returns None when the user already chose a mode — never overrides it.
pub fn seed_default_permission(existing: &str) -> Option<String> {
    if permission_mode_of(existing).is_some() {
        return None;
    }
    set_permission_mode(existing, MODE_APPROVE).ok()
}

/// The approval mode a config encodes: None when the `permission` key was
/// never written (first run — the caller seeds the "approve" default).
pub fn permission_mode_of(existing: &str) -> Option<&'static str> {
    let root: Value = serde_json::from_str(existing).ok()?;
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
        serde_json::from_str(existing).map_err(|e| format!("invalid existing config: {e}"))?
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
pub fn ensure_goal_plugin(existing: &str, plugin_path: &str) -> Option<String> {
    let mut root: Value = if existing.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(existing).ok()?
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
    let ours = |v: &Value| {
        v.as_str()
            .is_some_and(|s| s.ends_with("goal-plugin.server.js"))
    };
    if arr.iter().any(|v| v.as_str() == Some(plugin_path)) && arr.iter().filter(|v| ours(v)).count() == 1 {
        return None; // already exactly right
    }
    arr.retain(|v| !ours(v));
    arr.push(json!(plugin_path));
    serde_json::to_string_pretty(&root).ok()
}

/// Project memory: OpenCode resolves a relative `instructions` entry against
/// the session's working directory, so this one entry gives every project its
/// own memory file without any per-project config.
pub const PROJECT_MEMORY_FILE: &str = "AGENTS.md";

fn as_object(existing: &str) -> Value {
    let mut root: Value = if existing.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(existing).unwrap_or_else(|_| json!({}))
    };
    if !root.is_object() {
        root = json!({});
    }
    root
}

/// Turn OpenCode's automatic context compaction on the first time we see a
/// config without a `compaction` block. Without it a long conversation ends in
/// "Input exceeds context window" (#62); with it the runtime summarizes the
/// older turns and carries on in the same session. Set explicitly rather than
/// relying on the runtime default, and never overridden once the key exists —
/// a user who turned it off keeps it off. Returns None when nothing to do.
pub fn seed_compaction(existing: &str) -> Option<String> {
    let mut root = as_object(existing);
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
    let root = as_object(existing);
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
    let mut root = as_object(existing);
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

/// Which model each agent runs, from `agent.<name>.model`. Agents with no
/// override are absent — they follow the global default model.
pub fn agent_models(existing: &str) -> Vec<(String, String)> {
    let root = as_object(existing);
    let Some(agents) = root.get("agent").and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    let mut out: Vec<(String, String)> = agents
        .iter()
        .filter_map(|(name, cfg)| {
            let model = cfg.get("model")?.as_str()?;
            Some((name.clone(), model.to_string()))
        })
        .collect();
    out.sort();
    out
}

/// Pin one agent to its own model (`None` clears the override so it follows the
/// default again). Lets a reviewer subagent run a fast model while the main
/// agent reasons on a strong one (#63).
pub fn set_agent_model(existing: &str, agent: &str, model: Option<&str>) -> String {
    let mut root = as_object(existing);
    let obj = root.as_object_mut().unwrap();
    let agents = obj.entry("agent").or_insert_with(|| json!({}));
    if !agents.is_object() {
        *agents = json!({});
    }
    let aobj = agents.as_object_mut().unwrap();
    match model {
        Some(m) if !m.is_empty() => {
            let entry = aobj.entry(agent).or_insert_with(|| json!({}));
            if !entry.is_object() {
                *entry = json!({});
            }
            entry
                .as_object_mut()
                .unwrap()
                .insert("model".to_string(), json!(m));
        }
        _ => {
            // Clearing the model must not delete an agent config the user
            // wrote — only the key we own, and the wrapper only if it empties.
            if let Some(entry) = aobj.get_mut(agent).and_then(|v| v.as_object_mut()) {
                entry.remove("model");
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

#[cfg(test)]
mod tests {
    use super::*;

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
    }

    #[test]
    fn full_mode_writes_empty_permission_marker() {
        let approved = set_permission_mode("", MODE_APPROVE).unwrap();
        let out = set_permission_mode(&approved, MODE_FULL).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        // {} = zero rules = OpenCode builtin defaults; the key's presence
        // marks "user chose this" so startup never re-seeds approve mode.
        assert_eq!(v["permission"], json!({}));
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
