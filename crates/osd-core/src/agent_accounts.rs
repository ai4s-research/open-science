//! The accounts a coding agent can run as: Claude Code and Codex.
//!
//! Each account is a config folder of its own, the folder the agent reads its
//! login from (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). Signing in once in that folder
//! and starting the agent with it set is running as that account. This is what
//! Orca does (`src/main/claude-accounts`, MIT) and what magpie does for its
//! subscription accounts; the agent's own default folder (`~/.claude`,
//! `~/.codex`) stays the default account and is never changed.
//!
//! What the folders share with the default one is an ALLOWLIST: conversation
//! history, skills, commands, plugins and instructions. Everything else stays
//! in the account's folder. Orca shares by blocklist instead; with a blocklist a
//! file a future version adds to hold credentials would be shared by default,
//! and the second account would quietly run as the first. A missing shared item
//! is visible; a crossed account is not.
//!
//! Layout: `<data>/agent-accounts/<kind>/<id>/account.json` (what this app knows
//! about it) and `<data>/agent-accounts/<kind>/<id>/home/` (the agent's folder).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    Codex,
}

impl AgentKind {
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw {
            "claude" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            other => Err(format!("{other} has no accounts")),
        }
    }

    fn dir_name(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    /// The variable naming the folder the agent reads its login from.
    pub fn home_var(self) -> &'static str {
        match self {
            Self::Claude => "CLAUDE_CONFIG_DIR",
            Self::Codex => "CODEX_HOME",
        }
    }

    /// The agent's own command, for signing in and reading who is signed in.
    pub fn binary(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    /// Variables that choose a login by themselves and would override the
    /// account's folder: an account run with one of these set is not that account.
    pub fn auth_vars(self) -> &'static [&'static str] {
        match self {
            Self::Claude => &[
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_AUTH_TOKEN",
                "CLAUDE_CODE_OAUTH_TOKEN",
                "AWS_BEARER_TOKEN_BEDROCK",
            ],
            Self::Codex => &["OPENAI_API_KEY", "CODEX_API_KEY"],
        }
    }

    /// The default account's folder: the variable when the user set it, else
    /// the agent's own default.
    pub fn default_home(self) -> Result<PathBuf, String> {
        if let Some(dir) = std::env::var_os(self.home_var()).filter(|d| !d.is_empty()) {
            return Ok(PathBuf::from(dir));
        }
        let home = crate::env::home()?;
        Ok(home.join(match self {
            Self::Claude => ".claude",
            Self::Codex => ".codex",
        }))
    }

    /// Folders linked to the default account's. History first: conversations
    /// are the user's, not the account's, so every account sees all of them.
    fn shared_dirs(self) -> &'static [&'static str] {
        match self {
            Self::Claude => &["projects", "skills", "agents", "commands", "plugins", "output-styles"],
            Self::Codex => &["sessions", "skills", "prompts", "memories"],
        }
    }

    /// Of `shared_dirs`, the ones created in the default folder when missing,
    /// so an account's first conversation still lands in the shared history.
    fn history_dirs(self) -> &'static [&'static str] {
        match self {
            Self::Claude => &["projects"],
            Self::Codex => &["sessions"],
        }
    }

    /// Files linked to the default account's. Only files the agent appends to
    /// or never writes: a file saved by rename-replace would turn the link into
    /// a private copy.
    fn shared_files(self) -> &'static [&'static str] {
        match self {
            Self::Claude => &[],
            Self::Codex => &["AGENTS.md", "history.jsonl"],
        }
    }

    /// Settings copied from the default account at every start. The agent
    /// rewrites these whole, so a link would not survive; the default account's
    /// copy is the one the user edits.
    fn copied_files(self) -> &'static [&'static str] {
        match self {
            Self::Claude => &["settings.json"],
            Self::Codex => &["config.toml"],
        }
    }
}

/// What this app knows about an account it added.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub kind: AgentKind,
    #[serde(flatten)]
    pub identity: Identity,
    pub added_at_ms: i64,
}

/// Who a folder is signed in as, as the agent reports it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// Organisation (Claude) or ChatGPT workspace (Codex). One email can belong
    /// to several, and each is an account of its own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
}

impl Identity {
    /// Same account: same email in the same organisation. Two identities with
    /// no email cannot be told apart, so they are not called the same.
    pub fn same_account(&self, other: &Identity) -> bool {
        match (&self.email, &other.email) {
            (Some(a), Some(b)) => a.eq_ignore_ascii_case(b) && self.org_id == other.org_id,
            _ => false,
        }
    }
}

fn root(data_dir: &Path, kind: AgentKind) -> PathBuf {
    data_dir.join("agent-accounts").join(kind.dir_name())
}

/// An id is ours only if it is a plain name: it becomes a path component.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn account_dir(data_dir: &Path, kind: AgentKind, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err(format!("not an account id: {id}"));
    }
    Ok(root(data_dir, kind).join(id))
}

/// The folder the agent runs in for this account.
pub fn home_dir(data_dir: &Path, kind: AgentKind, id: &str) -> Result<PathBuf, String> {
    Ok(account_dir(data_dir, kind, id)?.join("home"))
}

/// The accounts added, oldest first. A folder without a readable record (a
/// sign-in that never finished) is not an account.
pub fn list(data_dir: &Path, kind: AgentKind) -> Vec<Account> {
    let Ok(entries) = std::fs::read_dir(root(data_dir, kind)) else {
        return Vec::new();
    };
    let mut accounts: Vec<Account> = entries
        .flatten()
        .filter_map(|e| std::fs::read(e.path().join("account.json")).ok())
        .filter_map(|raw| serde_json::from_slice::<Account>(&raw).ok())
        .filter(|a| a.kind == kind && valid_id(&a.id))
        .collect();
    accounts.sort_by_key(|a| a.added_at_ms);
    accounts
}

pub fn find(data_dir: &Path, kind: AgentKind, id: &str) -> Result<Account, String> {
    list(data_dir, kind)
        .into_iter()
        .find(|a| a.id == id)
        .ok_or_else(|| "This account was removed. Pick another one for this conversation.".to_string())
}

/// A new, empty account folder, ready for its sign-in. Random rather than
/// numbered: Claude Code names the macOS keychain entry after the folder's path,
/// so a reused path could find a removed account's login.
pub fn create(data_dir: &Path, kind: AgentKind) -> Result<(String, PathBuf), String> {
    let id = format!("acct-{}", crate::runtime::random_hex(5));
    let home = home_dir(data_dir, kind, &id)?;
    std::fs::create_dir_all(&home).map_err(|e| format!("could not create {}: {e}", home.display()))?;
    prepare(kind, &home)?;
    Ok((id, home))
}

pub fn save(data_dir: &Path, account: &Account) -> Result<(), String> {
    let path = account_dir(data_dir, account.kind, &account.id)?.join("account.json");
    let json = serde_json::to_vec_pretty(account).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// Delete the account's folder. The links in it are removed, not followed:
/// `remove_dir_all` never descends through a symlink, so the shared history
/// and skills they point at are untouched.
pub fn remove(data_dir: &Path, kind: AgentKind, id: &str) -> Result<(), String> {
    let dir = account_dir(data_dir, kind, id)?;
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("could not remove {}: {e}", dir.display())),
    }
}

/// Link the shared items into an account's folder and copy the settings in.
/// Run when the account is made and again at every start, so an item the
/// default account gained since is picked up. Never replaces anything of the
/// account's own: an existing file or non-empty folder is left as it is.
pub fn prepare(kind: AgentKind, home: &Path) -> Result<(), String> {
    let default = kind.default_home()?;
    prepare_from(kind, &default, home)
}

fn prepare_from(kind: AgentKind, default: &Path, home: &Path) -> Result<(), String> {
    std::fs::create_dir_all(home).map_err(|e| e.to_string())?;
    for name in kind.shared_dirs() {
        let source = default.join(name);
        if !source.exists() && kind.history_dirs().contains(name) {
            let _ = std::fs::create_dir_all(&source);
        }
        if source.is_dir() {
            link(&source, &home.join(name), true);
        }
    }
    for name in kind.shared_files() {
        let source = default.join(name);
        if source.is_file() {
            link(&source, &home.join(name), false);
        }
    }
    for name in kind.copied_files() {
        let source = default.join(name);
        if source.is_file() {
            let _ = std::fs::copy(&source, home.join(name));
        }
    }
    // Claude Code's own instructions: an import of the default's file rather
    // than a link, as Orca does, so Claude Code saving its memory file cannot
    // break the connection.
    if kind == AgentKind::Claude {
        let own = home.join("CLAUDE.md");
        let shared = default.join("CLAUDE.md");
        if !own.exists() && shared.is_file() {
            let _ = std::fs::write(&own, format!("@{}\n", shared.display()));
        }
    }
    Ok(())
}

/// Point `target` at `source`, unless something of the account's own is there.
fn link(source: &Path, target: &Path, is_dir: bool) {
    if let Ok(meta) = std::fs::symlink_metadata(target) {
        if meta.file_type().is_symlink() {
            return; // already linked, here or by the user elsewhere
        }
        let empty_dir = meta.is_dir() && std::fs::read_dir(target).map(|mut d| d.next().is_none()).unwrap_or(false);
        if !empty_dir {
            return;
        }
        let _ = std::fs::remove_dir(target);
    }
    let _ = make_link(source, target, is_dir);
}

#[cfg(unix)]
fn make_link(source: &Path, target: &Path, _is_dir: bool) -> std::io::Result<()> {
    std::os::unix::fs::symlink(source, target)
}

/// A symlink on Windows needs Developer Mode or elevation. A folder falls back
/// to a junction, which does not; a file is left unshared rather than copied,
/// since a copy would drift.
#[cfg(windows)]
fn make_link(source: &Path, target: &Path, is_dir: bool) -> std::io::Result<()> {
    if is_dir {
        if std::os::windows::fs::symlink_dir(source, target).is_ok() {
            return Ok(());
        }
        let status = crate::runtime::quiet_command("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(target)
            .arg(source)
            .status()?;
        if status.success() {
            Ok(())
        } else {
            Err(std::io::Error::other("mklink /J failed"))
        }
    } else {
        std::os::windows::fs::symlink_file(source, target)
    }
}

/// Variables to set, and variables to take out, to run an agent as an account.
pub type LaunchEnv = (Vec<(String, String)>, Vec<&'static str>);

/// The environment that runs the agent as this account: its folder set, and
/// every variable that would pick another login taken out.
pub fn launch_env(kind: AgentKind, home: &Path) -> LaunchEnv {
    (
        vec![(kind.home_var().to_string(), home.display().to_string())],
        kind.auth_vars().to_vec(),
    )
}

/// Claude Code's macOS keychain entry for a config folder: "Claude
/// Code-credentials" plus the first 8 hex digits of the folder path's SHA-256
/// (Claude Code 2.1+, the naming Orca's keychain.ts matches).
pub fn claude_keychain_service(home: &Path) -> String {
    let digest = Sha256::digest(home.display().to_string().as_bytes());
    let hex: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
    format!("Claude Code-credentials-{hex}")
}

/// Who `claude auth status --json` says is signed in, or None when no one is.
pub fn parse_claude_status(raw: &str) -> Option<Identity> {
    let v: Value = serde_json::from_str(raw.trim()).ok()?;
    if v.get("loggedIn").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let text = |k: &str| v.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
    Some(Identity {
        email: text("email"),
        org_id: text("orgId"),
        org_name: text("orgName"),
        plan: text("subscriptionType"),
    })
}

/// Who a Codex folder is signed in as, read from its `auth.json`: the ID token's
/// claims carry the email, the ChatGPT plan and workspace. None when the folder
/// has no ChatGPT sign-in (an API key, or credentials kept in the keyring).
pub fn codex_identity(home: &Path) -> Option<Identity> {
    let raw = std::fs::read(home.join("auth.json")).ok()?;
    parse_codex_auth(&raw)
}

pub fn parse_codex_auth(raw: &[u8]) -> Option<Identity> {
    let v: Value = serde_json::from_slice(raw).ok()?;
    let token = v.pointer("/tokens/id_token").and_then(Value::as_str)?;
    let payload = token.split('.').nth(1)?;
    use base64::Engine;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let claims: Value = serde_json::from_slice(&bytes).ok()?;
    let auth = claims.get("https://api.openai.com/auth");
    let text = |v: Option<&Value>| v.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
    Some(Identity {
        email: text(claims.get("email")),
        org_id: text(auth.and_then(|a| a.get("chatgpt_account_id"))),
        org_name: None,
        plan: text(auth.and_then(|a| a.get("chatgpt_plan_type"))),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("osd-accounts-{}", crate::runtime::random_hex(6)));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn shares_the_allowlist_and_nothing_else() {
        let base = temp();
        let default = base.join("default");
        std::fs::create_dir_all(default.join("skills/one")).unwrap();
        std::fs::create_dir_all(default.join("statsig")).unwrap();
        std::fs::write(default.join(".credentials.json"), "{}").unwrap();
        std::fs::write(default.join("settings.json"), "{\"model\":\"opus\"}").unwrap();
        std::fs::write(default.join("CLAUDE.md"), "be brief").unwrap();
        let home = base.join("acct/home");

        prepare_from(AgentKind::Claude, &default, &home).unwrap();

        assert!(std::fs::symlink_metadata(home.join("skills")).unwrap().file_type().is_symlink());
        // History is created in the default folder so it is shared from the start.
        assert!(default.join("projects").is_dir());
        assert!(std::fs::symlink_metadata(home.join("projects")).unwrap().file_type().is_symlink());
        // Not on the list: not shared, credentials above all.
        assert!(!home.join(".credentials.json").exists());
        assert!(!home.join("statsig").exists());
        assert_eq!(std::fs::read_to_string(home.join("settings.json")).unwrap(), "{\"model\":\"opus\"}");
        assert_eq!(
            std::fs::read_to_string(home.join("CLAUDE.md")).unwrap(),
            format!("@{}\n", default.join("CLAUDE.md").display())
        );
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn keeps_what_the_account_has_of_its_own() {
        let base = temp();
        let default = base.join("default");
        std::fs::create_dir_all(default.join("skills")).unwrap();
        let home = base.join("acct/home");
        std::fs::create_dir_all(home.join("skills")).unwrap();
        std::fs::write(home.join("skills/mine.md"), "x").unwrap();

        prepare_from(AgentKind::Claude, &default, &home).unwrap();

        assert!(!std::fs::symlink_metadata(home.join("skills")).unwrap().file_type().is_symlink());
        assert!(home.join("skills/mine.md").is_file());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn removing_an_account_leaves_the_shared_history() {
        let base = temp();
        let data = base.join("data");
        let default = base.join("default");
        std::fs::create_dir_all(default.join("projects/p")).unwrap();
        std::fs::write(default.join("projects/p/s.jsonl"), "{}").unwrap();
        let id = "acct-test";
        let home = home_dir(&data, AgentKind::Claude, id).unwrap();
        prepare_from(AgentKind::Claude, &default, &home).unwrap();
        assert!(home.join("projects/p/s.jsonl").is_file());

        remove(&data, AgentKind::Claude, id).unwrap();

        assert!(!home.exists());
        assert!(default.join("projects/p/s.jsonl").is_file());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn an_id_is_never_a_path() {
        let data = PathBuf::from("/data");
        assert!(home_dir(&data, AgentKind::Claude, "../x").is_err());
        assert!(home_dir(&data, AgentKind::Claude, "a/b").is_err());
        assert!(home_dir(&data, AgentKind::Claude, "").is_err());
    }

    #[test]
    fn lists_only_finished_accounts_oldest_first() {
        let data = temp();
        for (id, at) in [("acct-b", 2), ("acct-a", 1)] {
            std::fs::create_dir_all(home_dir(&data, AgentKind::Codex, id).unwrap()).unwrap();
            let account = Account { id: id.into(), kind: AgentKind::Codex, identity: Identity::default(), added_at_ms: at };
            save(&data, &account).unwrap();
        }
        std::fs::create_dir_all(home_dir(&data, AgentKind::Codex, "acct-pending").unwrap()).unwrap();

        let ids: Vec<String> = list(&data, AgentKind::Codex).into_iter().map(|a| a.id).collect();

        assert_eq!(ids, ["acct-a", "acct-b"]);
        std::fs::remove_dir_all(&data).unwrap();
    }

    #[test]
    fn reads_who_claude_says_is_signed_in() {
        let raw = r#"{"loggedIn":true,"authMethod":"claude.ai","email":"a@x.org","orgId":"o1","orgName":"X","subscriptionType":"max"}"#;
        let id = parse_claude_status(raw).unwrap();
        assert_eq!(id.email.as_deref(), Some("a@x.org"));
        assert_eq!(id.plan.as_deref(), Some("max"));
        assert!(parse_claude_status(r#"{"loggedIn":false,"authMethod":"none"}"#).is_none());
    }

    #[test]
    fn reads_who_codex_is_signed_in_as() {
        use base64::Engine;
        let claims = r#"{"email":"b@y.org","https://api.openai.com/auth":{"chatgpt_plan_type":"plus","chatgpt_account_id":"w1"}}"#;
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims);
        let auth = format!(r#"{{"tokens":{{"id_token":"h.{payload}.s"}}}}"#);
        let id = parse_codex_auth(auth.as_bytes()).unwrap();
        assert_eq!(id.email.as_deref(), Some("b@y.org"));
        assert_eq!(id.plan.as_deref(), Some("plus"));
        assert_eq!(id.org_id.as_deref(), Some("w1"));
    }

    #[test]
    fn one_email_in_two_organisations_is_two_accounts() {
        let a = Identity { email: Some("a@x.org".into()), org_id: Some("o1".into()), ..Default::default() };
        let b = Identity { email: Some("A@x.org".into()), org_id: Some("o1".into()), ..Default::default() };
        let c = Identity { email: Some("a@x.org".into()), org_id: Some("o2".into()), ..Default::default() };
        assert!(a.same_account(&b));
        assert!(!a.same_account(&c));
        assert!(!Identity::default().same_account(&Identity::default()));
    }

    #[test]
    fn names_the_keychain_entry_after_the_folder() {
        let service = claude_keychain_service(Path::new("/Users/me/.claude-work"));
        assert!(service.starts_with("Claude Code-credentials-"));
        assert_eq!(service.len(), "Claude Code-credentials-".len() + 8);
    }
}
