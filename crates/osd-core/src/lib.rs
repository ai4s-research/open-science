// Open Science Desktop — the server core.
//
// Everything here runs with or without a window: workspace layout, the bundled
// OpenCode sidecar, the opencode profile and config, projects, run provenance,
// and the HTTP gateway that re-exposes all of it (plus the real web client) to
// LAN / CLI clients.
//
// The one rule that keeps this crate honest: **it must never depend on Tauri.**
// A Tauri app cannot start where there is no display — tao calls `gtk::init()`
// on Linux — so anything that lives here is reachable from `osd server` on a
// headless machine, and anything that does not, is not.
pub mod artifact_file;
pub mod browser_mcp_proxy;
pub mod debug_log;
pub mod env;
pub mod examples;
pub mod gateway;
pub mod git_snapshot;
pub mod harness;
pub mod model_probe;
pub mod opencode_config;
pub mod project;
pub mod provenance;
pub mod runs;
pub mod runs_index;
pub mod runtime;
pub mod session_sync;

pub use env::Env;
