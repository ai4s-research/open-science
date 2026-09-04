// Appends frontend diagnostics to <app-data>/debug.log so we can see what the
// webview experiences (connection attempts, SSE events, errors) in packaged builds.
use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::env::Env;

/// Ceiling for debug.log; when exceeded it is trimmed to roughly its last half so
/// a crash-looping sidecar (whose stderr is drained here) can't grow it without
/// bound. Generous enough to keep a useful history of a normal session.
const MAX_LOG_BYTES: u64 = 4 * 1024 * 1024;

/// Append one timestamped line to <app-data>/debug.log. Best-effort: any failure
/// (missing dir, permission) is swallowed so logging never breaks the app.
/// Shared by the frontend `log_debug` command and the sidecar drain in runtime.rs
/// so both streams land in one timeline.
pub fn append(env: &Env, message: &str) {
    let dir = env.data_dir();
    let _ = std::fs::create_dir_all(dir);
    let path = dir.join("debug.log");
    // Bound the file: over the cap, keep only the tail so history stays useful but
    // the file can't grow forever. Best-effort; a concurrent racing append is benign.
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_LOG_BYTES {
        if let Ok(bytes) = std::fs::read(&path) {
            let keep_from = bytes.len().saturating_sub((MAX_LOG_BYTES / 2) as usize);
            let _ = std::fs::write(&path, &bytes[keep_from..]);
        }
    }
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{ts} {message}");
    }
}
