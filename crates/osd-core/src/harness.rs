// Agent harness: the "how to run" scaffold (AGENTS.md, KNOWLEDGE.md, knowledge/,
// notes/) seeded into every NEW dated session folder so the agent starts with its
// operating rules instead of an empty directory. Bundled as a Tauri resource
// (`runtime/harness/` → `harness/`) so it ships in the one-click installer.
use std::path::Path;

use crate::env::Env;
use crate::examples::copy_missing;

/// Seed the agent harness into a freshly created dated workspace `dir`.
///
/// Non-clobbering (never overwrites a file the user already edited) so it is safe
/// to call whenever a dated folder is created. A missing/unbundled harness is a
/// soft failure logged to stderr — a new session must still open.
pub fn seed_harness(env: &Env, dir: &Path) {
    let Some(src) = env.resource("harness").filter(|p| p.is_dir()) else {
        eprintln!("harness not bundled in this build");
        return;
    };
    if let Err(e) = copy_missing(&src, dir) {
        eprintln!("harness seed failed: {e}");
    }
}
