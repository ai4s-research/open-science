//! Which of these commands can this machine actually run?
//!
//! The UI owns the catalog of agents it knows how to drive; this answers the one
//! question the UI cannot — whether the binary is on PATH. Borrowed in shape
//! from Orca's agent detection (`tui-agent-config.ts`, MIT), which treats an
//! agent as "a command that may or may not be installed" rather than as an
//! integration to be written per vendor.

use std::path::{Path, PathBuf};

/// Executable suffixes to try on Windows, in PATHEXT order. Empty on Unix,
/// where the executable bit is the test instead.
#[cfg(windows)]
const WINDOWS_SUFFIXES: [&str; 4] = [".exe", ".cmd", ".bat", ".com"];

fn is_executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return std::fs::metadata(path)
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false);
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Resolve one command against a PATH-like string, as a shell would.
pub fn find_on_path(command: &str, path_var: Option<&str>) -> Option<PathBuf> {
    // A command carrying a separator is a path, not a PATH lookup — the shell
    // treats `./my-agent` and `agent` differently, and so must this.
    if command.contains('/') || command.contains('\\') {
        let direct = PathBuf::from(command);
        return is_executable(&direct).then_some(direct);
    }
    for dir in std::env::split_paths(path_var.unwrap_or_default()) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let candidate = dir.join(command);
        if is_executable(&candidate) {
            return Some(candidate);
        }
        #[cfg(windows)]
        for suffix in WINDOWS_SUFFIXES {
            let with_suffix = dir.join(format!("{command}{suffix}"));
            if is_executable(&with_suffix) {
                return Some(with_suffix);
            }
        }
    }
    None
}

/// The program to hand a process spawn for a user-configured command name.
///
/// `std::process::Command` does not expand `PATHEXT` on Windows: asked for
/// `npx` it looks for `npx.exe` and never tries the `npx.cmd` npm actually
/// installs. A row this module had just reported as installed could therefore
/// still fail to start — the picker answering "yes" and the supervisor
/// answering "not found" to the same string (#172). Resolving here gives both
/// questions one answer from one set of rules, on the same PATH a child gets.
///
/// A name that is not on `path_var` comes back unchanged, so the spawn fails
/// with the platform's own error and the caller keeps its existing wording.
pub fn resolve_program(command: &str, path_var: Option<&str>) -> PathBuf {
    find_on_path(command, path_var).unwrap_or_else(|| PathBuf::from(command))
}

/// The subset of `commands` this machine can run, in the order given.
///
/// A missing command is simply absent from the answer — "not installed" is an
/// ordinary state here, not a failure.
///
/// PATH is a parameter rather than read here so a test can describe a machine
/// without mutating the process environment out from under its neighbours.
pub fn detect_commands(commands: &[String], path_var: Option<&str>) -> Vec<String> {
    commands
        .iter()
        .filter(|command| find_on_path(command, path_var).is_some())
        .cloned()
        .collect()
}

/// `detect_commands` against this process's own PATH.
/// Installed means runnable by what the app starts: looked up on the same PATH
/// its child processes get, so a command found here is one that will start.
pub fn detect_installed(commands: &[String]) -> Vec<String> {
    detect_commands(commands, Some(&crate::runtime::enriched_path()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[cfg(unix)]
    fn write_executable(dir: &Path, name: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        fs::write(&path, b"#!/bin/sh\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("osd-which-{tag}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    #[cfg(unix)]
    fn finds_an_executable_and_ignores_a_plain_file() {
        let dir = temp_dir("exec");
        write_executable(&dir, "agent-installed");
        // Same directory, same name shape, but not runnable.
        fs::write(dir.join("agent-readme"), b"not a program").unwrap();
        let path_var = dir.to_string_lossy().to_string();

        assert!(find_on_path("agent-installed", Some(&path_var)).is_some());
        assert!(find_on_path("agent-readme", Some(&path_var)).is_none());
        assert!(find_on_path("agent-absent", Some(&path_var)).is_none());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    #[cfg(unix)]
    fn reports_only_what_is_installed_keeping_the_callers_order() {
        let dir = temp_dir("subset");
        write_executable(&dir, "codex");
        write_executable(&dir, "claude");
        let path_var = dir.to_string_lossy().to_string();

        let asked = ["claude", "gemini", "codex"].map(String::from);
        assert_eq!(detect_commands(&asked, Some(&path_var)), vec!["claude", "codex"]);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_empty_path_finds_nothing_rather_than_erroring() {
        assert!(find_on_path("claude", Some("")).is_none());
        assert!(find_on_path("claude", None).is_none());
    }

    #[cfg(windows)]
    fn write_shim(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, b"@echo off\r\n").unwrap();
        path
    }

    /// The answer a spawn needs is a FILE, not the name that was typed: on
    /// Windows the two differ for every npm-installed agent (#172), and handing
    /// `Command::new` the bare name is what made a detected agent unstoppable.
    #[test]
    fn resolves_a_known_command_to_a_file_and_leaves_an_unknown_one_alone() {
        let dir = temp_dir("resolve");
        #[cfg(unix)]
        let installed = write_executable(&dir, "agent-installed");
        #[cfg(windows)]
        let installed = write_shim(&dir, "agent-installed.cmd");
        let path_var = dir.to_string_lossy().to_string();

        assert_eq!(resolve_program("agent-installed", Some(&path_var)), installed);
        assert_ne!(
            resolve_program("agent-installed", Some(&path_var)),
            PathBuf::from("agent-installed")
        );
        // Not installed stays the raw name, so the caller's own error wording
        // ("… is not installed, or not on your shell's PATH") still fires.
        assert_eq!(
            resolve_program("agent-absent", Some(&path_var)),
            PathBuf::from("agent-absent")
        );
        fs::remove_dir_all(&dir).ok();
    }

    /// The regression this exists for: `npx` is `npx.cmd` on Windows, and
    /// `Command::new("npx")` never looks for it. Flipping `resolve_program`
    /// back to `PathBuf::from(command)` fails this test.
    #[test]
    #[cfg(windows)]
    fn a_cmd_shim_resolves_to_the_file_a_spawn_can_start() {
        let dir = temp_dir("cmdshim");
        let shim = write_shim(&dir, "npx.cmd");
        let path_var = dir.to_string_lossy().to_string();

        assert_eq!(resolve_program("npx", Some(&path_var)), shim);
        assert_ne!(resolve_program("npx", Some(&path_var)), PathBuf::from("npx"));
        fs::remove_dir_all(&dir).ok();
    }

    /// On Unix the executable bit is the test, so a plain file must not become
    /// a program just because it is named like one.
    #[test]
    #[cfg(unix)]
    fn a_plain_file_is_never_resolved_into_a_program() {
        let dir = temp_dir("plain");
        fs::write(dir.join("agent-readme"), b"not a program").unwrap();
        let path_var = dir.to_string_lossy().to_string();

        assert_eq!(
            resolve_program("agent-readme", Some(&path_var)),
            PathBuf::from("agent-readme")
        );
        fs::remove_dir_all(&dir).ok();
    }
}
