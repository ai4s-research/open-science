// Settings, read and changed through the desktop window.
//
// The window owns the settings — it holds the switches, the stores and the
// functions the Settings page calls — so `osd settings` asks it. A read is
// answered at once. A change is a request the user approves in the window: an
// agent may ask for several settings in one go, with its reason, and the user
// sees each one and decides. Nothing here changes a setting itself.
//
// A request lives until the window answers it or it expires. A new request
// from the same conversation replaces its unanswered one, so an agent cannot
// stack up prompts.
use std::collections::HashMap;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// How long a change waits for the user before it lapses.
pub const CHANGE_TTL: Duration = Duration::from_secs(15 * 60);
/// How long a read waits for the window.
pub const READ_TIMEOUT: Duration = Duration::from_secs(5);

struct Entry {
    created: Instant,
    /// The conversation that asked, if an agent did.
    origin: Option<String>,
    change: bool,
    answer: Option<Value>,
}

#[derive(Default)]
struct Store {
    entries: Mutex<HashMap<String, Entry>>,
    answered: Condvar,
}

fn store() -> &'static Store {
    static STORE: OnceLock<Store> = OnceLock::new();
    STORE.get_or_init(Store::default)
}

/// Open a request and return its id. A change from a conversation supersedes
/// that conversation's unanswered change, whose id is returned second.
pub fn open(change: bool, origin: Option<String>) -> (String, Option<String>) {
    let id = format!("set_{}", crate::runtime::random_hex(8));
    let mut entries = store().entries.lock().unwrap();
    entries.retain(|_, e| e.created.elapsed() < CHANGE_TTL + Duration::from_secs(60));
    let superseded = if change && origin.is_some() {
        let old = entries
            .iter()
            .find(|(_, e)| e.change && e.answer.is_none() && e.origin == origin)
            .map(|(k, _)| k.clone());
        if let Some(k) = &old {
            if let Some(e) = entries.get_mut(k) {
                e.answer = Some(json!({ "status": "superseded" }));
            }
        }
        old
    } else {
        None
    };
    entries.insert(id.clone(), Entry { created: Instant::now(), origin, change, answer: None });
    store().answered.notify_all();
    (id, superseded)
}

/// The window's answer. False when there is no such request, or it was
/// already answered (superseded, expired).
pub fn answer(id: &str, answer: Value) -> bool {
    let mut entries = store().entries.lock().unwrap();
    match entries.get_mut(id) {
        Some(e) if e.answer.is_none() && e.created.elapsed() < CHANGE_TTL => {
            e.answer = Some(answer);
            store().answered.notify_all();
            true
        }
        _ => false,
    }
}

/// Where a request stands: its answer, `pending`, or `expired`.
pub fn status(id: &str) -> Option<Value> {
    let entries = store().entries.lock().unwrap();
    let e = entries.get(id)?;
    Some(match &e.answer {
        Some(a) => a.clone(),
        None if e.created.elapsed() >= CHANGE_TTL => json!({ "status": "expired" }),
        None => json!({ "status": "pending" }),
    })
}

/// Wait up to `timeout` for an answer (a read).
pub fn wait(id: &str, timeout: Duration) -> Option<Value> {
    let deadline = Instant::now() + timeout;
    let mut entries = store().entries.lock().unwrap();
    loop {
        if let Some(a) = entries.get(id).and_then(|e| e.answer.clone()) {
            entries.remove(id);
            return Some(a);
        }
        let left = deadline.checked_duration_since(Instant::now())?;
        entries = store().answered.wait_timeout(entries, left).unwrap().0;
    }
}

/// Drop a request nobody will answer (the window was not there to hear it).
pub fn forget(id: &str) {
    store().entries.lock().unwrap().remove(id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_change_waits_for_its_answer_and_is_answered_once() {
        let (id, _) = open(true, Some("ses_a".into()));
        assert_eq!(status(&id).unwrap()["status"], "pending");
        assert!(answer(&id, json!({ "status": "approved", "applied": ["remote.terminal"] })));
        assert_eq!(status(&id).unwrap()["status"], "approved");
        assert!(!answer(&id, json!({ "status": "denied" })), "an answer stands");
        assert!(status("set_nope").is_none());
    }

    #[test]
    fn a_new_change_from_the_same_conversation_supersedes_the_old() {
        let (first, _) = open(true, Some("ses_b".into()));
        let (other, _) = open(true, Some("ses_c".into()));
        let (second, superseded) = open(true, Some("ses_b".into()));
        assert_eq!(superseded.as_deref(), Some(first.as_str()));
        assert_eq!(status(&first).unwrap()["status"], "superseded");
        assert_eq!(status(&second).unwrap()["status"], "pending");
        assert_eq!(status(&other).unwrap()["status"], "pending", "another conversation's stands");
    }

    #[test]
    fn a_read_returns_when_answered_or_times_out() {
        let (id, _) = open(false, None);
        let reader = std::thread::spawn({
            let id = id.clone();
            move || wait(&id, Duration::from_secs(2))
        });
        std::thread::sleep(Duration::from_millis(50));
        answer(&id, json!({ "settings": [] }));
        assert_eq!(reader.join().unwrap(), Some(json!({ "settings": [] })));
        let (late, _) = open(false, None);
        assert_eq!(wait(&late, Duration::from_millis(50)), None);
    }
}
