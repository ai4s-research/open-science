//! Start a catalog agent on an API key OpenCode already holds.
//!
//! Someone who set up DeepSeek in the app should not have to paste the same key
//! into DeepSeek Harness. The key goes to the agent as the environment variable
//! it reads, at launch, and only when the agent has no key of its own. Nothing
//! is written into the agent's files.
//!
//! API keys only. An OAuth login is never handed over: two programs refreshing
//! one refresh token sign each other out.

use std::path::{Path, PathBuf};

use crate::env::Env;

struct Handoff {
    /// Catalog id (`lib/cliAgents.ts`).
    agent_id: &'static str,
    /// OpenCode provider id the key is stored under.
    provider: &'static str,
    /// Variable the agent reads its key from.
    var: &'static str,
    /// Whether the agent already has a key that the variable would override.
    has_own_key: fn(cwd: &Path) -> bool,
}

const HANDOFFS: &[Handoff] = &[Handoff {
    agent_id: "cli-dsh",
    provider: "deepseek",
    var: "DEEPSEEK_API_KEY",
    has_own_key: dsh_has_own_key,
}];

/// The variable and key to start `agent_id` with, if it should get one.
pub fn launch_key(env: &Env, agent_id: &str, cwd: &Path) -> Option<(&'static str, String)> {
    let handoff = HANDOFFS.iter().find(|h| h.agent_id == agent_id)?;
    let already_set = std::env::var_os(handoff.var).is_some_and(|v| !v.is_empty());
    if already_set || (handoff.has_own_key)(cwd) {
        return None;
    }
    let config = crate::runtime::effective_config_file(env)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default();
    let db = crate::runtime::xdg_data_home(env).ok()?.join("opencode").join("opencode.db");
    opencode_key(&config, &db, handoff.provider).map(|key| (handoff.var, key))
}

/// The provider's API key: the one Settings writes into the config, else the
/// one OpenCode keeps in its credential table.
fn opencode_key(config: &str, db: &Path, provider: &str) -> Option<String> {
    let from_config = crate::opencode_config::read_config(config)
        .and_then(|v| v["provider"][provider]["options"]["apiKey"].as_str().map(str::to_string))
        // `{env:…}` and `{file:…}` are OpenCode substitutions, not keys.
        .filter(|k| !k.is_empty() && !k.starts_with('{'));
    from_config.or_else(|| key_in_db(db, provider))
}

fn key_in_db(db: &Path, provider: &str) -> Option<String> {
    use rusqlite::{Connection, OpenFlags};
    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let mut stmt = conn
        .prepare(
            "select value from credential where integration_id = ?1 \
             order by active desc, time_updated desc",
        )
        .ok()?;
    let values: Vec<String> = stmt
        .query_map([provider], |row| row.get::<_, String>(0))
        .ok()?
        .flatten()
        .collect();
    values.iter().find_map(|text| {
        let value: serde_json::Value = serde_json::from_str(text).ok()?;
        let key = value["key"].as_str().filter(|k| !k.is_empty())?;
        (value["type"] == "key").then(|| key.to_string())
    })
}

/// dsh looks for its key in this order: its own store, the launch environment,
/// `<cwd>/.env`, `<harness home>/.env`. The store outranks the variable, so it
/// needs no check here. A `.env` key ranks below it and would be overridden.
fn dsh_has_own_key(cwd: &Path) -> bool {
    let home = std::env::var_os("DSH_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| crate::env::home().ok().map(|h| h.join(".dsh")));
    [Some(cwd.join(".env")), home.map(|h| h.join(".env"))]
        .into_iter()
        .flatten()
        .any(|path| std::fs::read_to_string(path).is_ok_and(|text| dotenv_sets(&text, "DEEPSEEK_API_KEY")))
}

fn dotenv_sets(text: &str, var: &str) -> bool {
    text.lines().any(|line| {
        let line = line.trim();
        let line = line.strip_prefix("export ").unwrap_or(line);
        line.strip_prefix(var)
            .and_then(|rest| rest.trim_start().strip_prefix('='))
            .is_some_and(|value| !value.trim().trim_matches(['"', '\'']).is_empty())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db(tag: &str, rows: &[(&str, i64, &str)]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("osd-agent-keys-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("opencode.db");
        let _ = std::fs::remove_file(&path);
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "create table credential (id text primary key, integration_id text, label text not null, \
             value text not null, connector_id text, method_id text, active integer, \
             time_created integer not null, time_updated integer not null)",
        )
        .unwrap();
        for (i, (provider, active, value)) in rows.iter().enumerate() {
            conn.execute(
                "insert into credential values (?1, ?2, 'x', ?3, null, null, ?4, 0, ?5)",
                rusqlite::params![format!("c{i}"), provider, value, active, i as i64],
            )
            .unwrap();
        }
        path
    }

    #[test]
    fn the_settings_key_comes_first_then_the_credential_table() {
        let db = temp_db("order", &[("deepseek", 1, r#"{"type":"key","key":"sk-from-db"}"#)]);
        let config = r#"{ // jsonc
          "provider": {"deepseek": {"options": {"baseURL": "https://api.deepseek.com", "apiKey": "sk-from-config"}}}}"#;
        assert_eq!(opencode_key(config, &db, "deepseek").as_deref(), Some("sk-from-config"));
        assert_eq!(opencode_key("{}", &db, "deepseek").as_deref(), Some("sk-from-db"));
        assert_eq!(opencode_key("{}", &db, "anthropic"), None);
    }

    #[test]
    fn a_substitution_or_an_oauth_login_is_not_a_key() {
        let db = temp_db(
            "oauth",
            &[("deepseek", 1, r#"{"type":"oauth","refresh":"r","access":"a","expires":1}"#)],
        );
        let config = r#"{"provider":{"deepseek":{"options":{"apiKey":"{env:DEEPSEEK_API_KEY}"}}}}"#;
        assert_eq!(opencode_key(config, &db, "deepseek"), None);
    }

    #[test]
    fn the_active_credential_wins_over_a_newer_inactive_one() {
        let db = temp_db(
            "active",
            &[
                ("deepseek", 1, r#"{"type":"key","key":"sk-active"}"#),
                ("deepseek", 0, r#"{"type":"key","key":"sk-newer-inactive"}"#),
            ],
        );
        assert_eq!(key_in_db(&db, "deepseek").as_deref(), Some("sk-active"));
    }

    #[test]
    fn a_dotenv_line_counts_only_when_it_sets_a_value() {
        assert!(dotenv_sets("DEEPSEEK_API_KEY=sk-1\n", "DEEPSEEK_API_KEY"));
        assert!(dotenv_sets("# mine\nexport DEEPSEEK_API_KEY = \"sk-1\"\n", "DEEPSEEK_API_KEY"));
        assert!(!dotenv_sets("DEEPSEEK_API_KEY=\n", "DEEPSEEK_API_KEY"));
        assert!(!dotenv_sets("# DEEPSEEK_API_KEY=sk-1\n", "DEEPSEEK_API_KEY"));
        assert!(!dotenv_sets("DEEPSEEK_API_KEY_OLD=sk-1\n", "DEEPSEEK_API_KEY"));
    }

    #[test]
    fn a_project_dotenv_key_means_dsh_keeps_its_own() {
        let dir = std::env::temp_dir().join(format!("osd-agent-keys-dotenv-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".env"), "DEEPSEEK_API_KEY=sk-project\n").unwrap();
        assert!(dsh_has_own_key(&dir));
        std::fs::remove_dir_all(&dir).ok();
    }
}
