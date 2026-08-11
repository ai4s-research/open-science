// Detects which scientific/runtime tools are available to the app: first on the
// user's own PATH, then — for the ones the app ships or provisions itself (the
// bundled uv sidecar, the managed Jupyter env) — the app's own copy. Probing the
// host alone reported "not found" for tools the app had already installed and
// was actively using (#68). This surfaces the truth to the UI honestly.
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

#[derive(Serialize)]
pub struct ToolStatus {
    name: String,
    found: bool,
    version: Option<String>,
    /// True when the tool is the app's own (bundled uv / managed Jupyter env)
    /// rather than something on the user's PATH, so the UI can label it instead
    /// of telling the user to install what the app already ships.
    managed: bool,
}

fn probe(name: &str, bin: &str, version_arg: &str) -> ToolStatus {
    // Search the SAME enriched PATH the kernel and the agent's shell run
    // under — a GUI-launched app has a minimal PATH, and probing with it
    // misreported the user's anaconda/homebrew tools as missing.
    let path = Some(crate::runtime::enriched_path());
    probe_with_path(name, bin, version_arg, path.as_deref())
}

/// First line of a `--version` run, when it succeeded. Some tools print to
/// stderr (node, Rscript), hence the fallback.
fn version_line(out: &std::process::Output) -> Option<String> {
    let text = if !out.stdout.is_empty() { &out.stdout } else { &out.stderr };
    String::from_utf8_lossy(text)
        .lines()
        .next()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn probe_with_path(name: &str, bin: &str, version_arg: &str, path: Option<&str>) -> ToolStatus {
    let mut cmd = crate::runtime::quiet_command(bin);
    cmd.arg(version_arg);
    if let Some(p) = path {
        cmd.env("PATH", p);
    }
    let out = cmd.output();
    match out {
        // `--version` must succeed — the Windows Store python alias runs,
        // prints an install hint, and exits non-zero; output alone is not
        // evidence the tool is installed.
        Ok(o) if o.status.success() => ToolStatus {
            name: name.to_string(),
            found: true,
            version: version_line(&o),
            managed: false,
        },
        _ => ToolStatus { name: name.to_string(), found: false, version: None, managed: false },
    }
}

/// An app-owned binary at a known absolute path: the bundled uv sidecar or a
/// binary in the managed Jupyter env. Existence alone counts as found — that is
/// exactly what `jupyter_status().installed` reports for the same env, and the
/// two must never contradict each other. The version is a bonus.
fn probe_managed(name: &str, bin: &Path, version_arg: &str) -> Option<ToolStatus> {
    if !bin.exists() {
        return None;
    }
    let version = crate::runtime::quiet_command(bin)
        .arg(version_arg)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| version_line(&o));
    Some(ToolStatus { name: name.to_string(), found: true, version, managed: true })
}

/// Fall back to the app's own copy when the host probe found nothing. The
/// user's install always wins: it is what OpenCode's shell tool runs, and
/// relabelling it "app-managed" would be a lie.
fn or_managed(host: ToolStatus, managed: Option<PathBuf>, version_arg: &str) -> ToolStatus {
    if host.found {
        return host;
    }
    match managed {
        Some(bin) => probe_managed(&host.name, &bin, version_arg).unwrap_or(host),
        None => host,
    }
}

/// Host Jupyter, preferring `jupyter-lab` for its clean version string and
/// falling back to `jupyter` so an install without JupyterLab still counts.
fn jupyter_host_probe() -> ToolStatus {
    let lab = probe("Jupyter", "jupyter-lab", "--version");
    if lab.found { lab } else { probe("Jupyter", "jupyter", "--version") }
}

/// Report availability of the tools relevant to a research workflow. `async`:
/// the serial process probes take seconds on Windows and ran on the UI thread
/// at startup — a big part of the "app is sluggish right after opening" bug.
/// The app-owned fallbacks only spawn when the host probe came up empty, so the
/// common case costs no extra process.
#[tauri::command(async)]
pub fn detect_tools(app: AppHandle) -> Vec<ToolStatus> {
    let python = {
        let p3 = probe("Python", "python3", "--version");
        if p3.found { p3 } else { probe("Python", "python", "--version") }
    };
    vec![
        // The managed Jupyter env carries its own Python — the one the app's
        // notebook Run button already defaults to (kernel::python_bin).
        or_managed(python, crate::jupyter::env_python(&app), "--version"),
        probe("R", "Rscript", "--version"),
        probe("Node.js", "node", "--version"),
        // uv ships with the app (tauri externalBin) and is the uv every
        // provisioning flow actually runs — never report it missing.
        or_managed(probe("uv", "uv", "--version"), crate::runtime::sidecar_bin("uv"), "--version"),
        // The managed env powers Open JupyterLab, the notebook kernel and the
        // agent's jupyter-mcp-server; it lives under app data, off any PATH.
        // `jupyter-lab` on both sides, not `jupyter`: it prints a bare version
        // ("4.4.1") where `jupyter --version` leads with "Selected Jupyter core
        // packages..." — and it is the exact binary jupyter_status() calls
        // installed, so the two views of the managed env cannot disagree.
        or_managed(
            jupyter_host_probe(),
            crate::jupyter::env_bin(&app, "jupyter-lab").ok(),
            "--version",
        ),
        probe("Git", "git", "--version"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    fn temp_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("os-tools-{tag}-{}", std::process::id()))
    }

    // A Finder-launched app has a minimal PATH, so probing with the plain
    // environment misreported the user's anaconda/homebrew tools as missing —
    // detection must search the SAME enriched PATH the kernel and agent use.
    #[cfg(unix)]
    #[test]
    fn probe_searches_the_given_path() {
        let dir = temp_dir("path");
        script(&dir, "mytool", "echo mytool 9.9");

        let found = probe_with_path("MyTool", "mytool", "--version", dir.to_str());
        assert!(found.found, "tool on the provided PATH must be found");
        assert_eq!(found.version.as_deref(), Some("mytool 9.9"));
        assert!(!found.managed, "a tool on the user's PATH is not app-managed");

        let missing = probe_with_path("MyTool", "mytool", "--version", Some("/nonexistent-dir"));
        assert!(!missing.found, "tool off the provided PATH must not be found");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // The Windows Store `python.exe` alias prints an install hint and exits
    // non-zero — output alone must not count as "found".
    #[cfg(unix)]
    #[test]
    fn probe_rejects_a_tool_that_fails_version() {
        let dir = temp_dir("fake");
        script(&dir, "faketool", "echo 'not really installed' >&2\nexit 9");

        let status = probe_with_path("FakeTool", "faketool", "--version", dir.to_str());
        assert!(!status.found, "a tool that exits non-zero on --version must not be found");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // #68: the app-managed Jupyter (and the bundled uv) live off PATH, so the
    // host probe cannot see them and the page claimed "not found" for a Jupyter
    // the user was successfully running.
    #[cfg(unix)]
    #[test]
    fn falls_back_to_the_app_managed_binary() {
        let dir = temp_dir("managed");
        let bin = script(&dir, "jupyter", "echo jupyter 4.4.1");

        let host_missing =
            probe_with_path("Jupyter", "jupyter", "--version", Some("/nonexistent-dir"));
        let status = or_managed(host_missing, Some(bin), "--version");
        assert!(status.found, "an app-managed binary must be reported as found");
        assert!(status.managed, "it must be labelled app-managed, not the user's own");
        assert_eq!(status.version.as_deref(), Some("jupyter 4.4.1"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    // A binary that exists but cannot report a version is still installed:
    // jupyter_status().installed goes by existence alone, and the two views of
    // the same env must not contradict each other.
    #[cfg(unix)]
    #[test]
    fn managed_binary_without_a_version_is_still_found() {
        let dir = temp_dir("managed-noversion");
        let bin = script(&dir, "jupyter", "exit 1");

        let status = probe_managed("Jupyter", &bin, "--version").expect("exists ⇒ found");
        assert!(status.found && status.managed);
        assert_eq!(status.version, None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // The user's own install wins: it is what OpenCode's shell tool runs, so
    // relabelling it "app-managed" would misreport the environment.
    #[cfg(unix)]
    #[test]
    fn a_host_hit_wins_over_the_app_managed_copy() {
        let dir = temp_dir("host-wins");
        script(&dir, "uv", "echo uv 0.9.0");
        let managed = script(&temp_dir("host-wins-managed"), "uv", "echo uv 0.1.0");

        let host = probe_with_path("uv", "uv", "--version", dir.to_str());
        let status = or_managed(host, Some(managed.clone()), "--version");
        assert!(status.found && !status.managed);
        assert_eq!(status.version.as_deref(), Some("uv 0.9.0"));

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(managed.parent().unwrap());
    }

    // No host tool and no app copy stays an honest "not found".
    #[cfg(unix)]
    #[test]
    fn nothing_installed_stays_not_found() {
        let host = probe_with_path("R", "Rscript", "--version", Some("/nonexistent-dir"));
        let status = or_managed(host, Some(PathBuf::from("/nonexistent-dir/Rscript")), "--version");
        assert!(!status.found && !status.managed && status.version.is_none());
    }
}
