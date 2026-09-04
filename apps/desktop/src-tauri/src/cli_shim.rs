// `osd` on the user's PATH, without the user doing anything.
//
// The installer carries `osd` beside the app binary, so a fresh install already
// has the terminal client — it is just not reachable by name. Making it
// reachable happens on launch, not on a button: an install that leaves you a
// line to paste into your shell profile has not installed anything.
//
// Two things shape how it is done. First, what gets written is a WRAPPER, never
// a symlink: `osd` resolves its sidecars and bundled resources next to its own
// executable, and macOS does not resolve a symlink for `current_exe()` —
// measured, a symlinked `osd` dies with "bundled OpenCode binary not found".
// Second, the directory is chosen to avoid touching the user's files at all
// where possible: a directory of theirs that is ALREADY on PATH and writable
// takes it with no further change. Only when there is none does this fall back
// to `~/.local/bin` plus one guarded block in the login profile (Unix) or one
// read-modify-write of the per-user PATH (Windows) — never an admin prompt,
// never `setx` (which truncates a PATH over 1024 characters).
use std::path::{Path, PathBuf};

use serde::Serialize;

/// Marks a wrapper as ours, so a re-install overwrites our own file and never
/// somebody else's `osd`.
const SIGNATURE: &str = "Open Science Desktop CLI wrapper";

/// Delimits the block appended to a shell profile, so it is found again and
/// written exactly once.
const PROFILE_MARKER: &str = "# Open Science Desktop: put the osd command on PATH";

/// How `osd` became reachable.
#[derive(Serialize, PartialEq, Debug, Clone, Copy)]
#[serde(rename_all = "kebab-case")]
pub enum PathRoute {
    /// The directory was already on PATH — nothing else was touched.
    AlreadyOnPath,
    /// A block was appended to the user's login profile.
    ShellProfile,
    /// The per-user PATH was extended (Windows). Never constructed elsewhere,
    /// and the enum is shared, so the unused-variant warning is silenced there
    /// rather than letting non-Windows builds carry a warning.
    #[cfg_attr(not(windows), allow(dead_code))]
    UserEnvironment,
    /// The wrapper is in place but nothing has put its directory on PATH yet.
    Unreachable,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliShimStatus {
    /// The bundled `osd` beside this executable — None in a dev run, or any
    /// build that does not carry it.
    binary: Option<String>,
    /// The wrapper's path, whether or not it is there yet.
    shim: String,
    /// A wrapper of ours is in place AND points at this app's `osd`.
    installed: bool,
    /// Something else already has that name, so installing would overwrite it.
    occupied: bool,
    route: PathRoute,
    /// The profile file that was extended, when that is how PATH was arranged.
    profile: Option<String>,
    /// Shown only when nothing automatic worked: the line to add by hand.
    path_hint: Option<String>,
}

fn home() -> Result<PathBuf, String> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .map(PathBuf::from)
        .ok_or_else(|| "no home directory".to_string())
}

fn shim_name() -> &'static str {
    if cfg!(windows) {
        "osd.cmd"
    } else {
        "osd"
    }
}

/// The PATH a NEW TERMINAL would have.
///
/// Not this process's PATH: a GUI app launched from Finder inherits launchd's
/// minimal `/usr/bin:/bin:/usr/sbin:/sbin`, so asking it whether `~/bin` is on
/// PATH answers a different question than the one that matters — measured on
/// this machine, the login shell has `~/bin` and the app would never have seen
/// it, and would have edited a profile that needed no editing. So the login
/// shell is asked directly, once per process (a heavy profile makes this slow,
/// and nothing here changes while the app runs).
#[cfg(not(windows))]
fn login_shell_path() -> Vec<PathBuf> {
    static CACHE: std::sync::OnceLock<Vec<PathBuf>> = std::sync::OnceLock::new();
    CACHE
        .get_or_init(|| {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
            let printed = osd_core::runtime::quiet_command(&shell)
                .args(["-l", "-c", "printf %s \"$PATH\""])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|p| !p.is_empty());
            match printed {
                Some(path) => std::env::split_paths(&path).collect(),
                // A login shell that will not run leaves this process's PATH as
                // the only evidence available.
                None => process_path(),
            }
        })
        .clone()
}

#[cfg(windows)]
fn login_shell_path() -> Vec<PathBuf> {
    process_path()
}

fn process_path() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default()
}

/// The two directories a user's own commands conventionally live in. Only these
/// are ever considered: the login PATH is also full of tool-owned directories —
/// `~/.cargo/bin`, `~/.nvm/…`, editor plugin bins — and this machine's PATH puts
/// `~/.cargo/bin` first, so "the first writable directory under $HOME on PATH"
/// would have dropped our wrapper into rustup's.
const USER_BIN_DIRS: [&str; 2] = [".local/bin", "bin"];

/// Where the wrapper goes, given the PATH a terminal will have.
///
/// A conventional user bin directory that a terminal ALREADY searches takes it
/// with nothing else touched — the quiet case, and the common one. Otherwise
/// `~/.local/bin`, whose directory PATH then has to be arranged for.
fn choose_shim_dir(path: &[PathBuf], home: &Path) -> PathBuf {
    let candidates: Vec<PathBuf> = USER_BIN_DIRS
        .iter()
        .map(|rel| rel.split('/').fold(home.to_path_buf(), |p, part| p.join(part)))
        .collect();
    candidates
        .iter()
        .find(|dir| path.iter().any(|entry| entry == *dir) && dir.is_dir() && writable(dir))
        .cloned()
        .unwrap_or_else(|| candidates[0].clone())
}

fn shim_dir() -> Result<PathBuf, String> {
    Ok(choose_shim_dir(&login_shell_path(), &home()?))
}

/// Would a new terminal find something in `dir`? Compared as paths, so a
/// trailing separator or a different spelling of the same directory counts.
fn reachable(path: &[PathBuf], dir: &Path) -> bool {
    path.iter().any(|entry| entry == dir)
}

/// Can this process create a file in `dir`? Asked by trying, because permission
/// bits do not answer it (ACLs, read-only mounts, macOS TCC).
fn writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".osd-write-probe-{}", std::process::id()));
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// The bundled `osd`, when this build carries it. Tauri strips the target
/// triple when it bundles an `externalBin`, so it sits under the plain name
/// next to the app binary — the same place `osd` looks for `opencode`.
fn bundled_osd() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let name = if cfg!(windows) { "osd.exe" } else { "osd" };
    let path = exe.parent()?.join(name);
    path.is_file().then_some(path)
}

/// Is this a copy that will not be there tomorrow? A first-time user opens the
/// DMG and launches the app straight off the mounted image; a wrapper written
/// then would point into `/Volumes/…` and break the moment the image is
/// ejected — silently, because the file it names is simply gone.
fn runs_from_removable_image(binary: &Path) -> bool {
    cfg!(target_os = "macos") && binary.starts_with("/Volumes/")
}

/// A wrapper that execs `binary`, in the shell the platform runs.
fn wrapper_script(binary: &Path) -> String {
    let path = binary.display();
    // Uninstalling the app cannot reach this file: on macOS it is a drag to the
    // trash, and on the other platforms the uninstaller runs as a different user
    // than the one whose PATH this is. So the wrapper notices that the app is
    // gone and removes ITSELF the next time anyone types `osd`, rather than
    // leaving a command that fails with a puzzling "no such file".
    if cfg!(windows) {
        format!(
            "@echo off\r\n\
             rem {SIGNATURE}. A wrapper, not a symlink: osd finds its sidecars\r\n\
             rem and bundled resources next to the real executable.\r\n\
             if not exist \"{path}\" (\r\n\
             echo Open Science Desktop is no longer installed; removing this leftover osd command. 1>&2\r\n\
             del \"%~f0\" >nul 2>&1\r\n\
             exit /b 127\r\n\
             )\r\n\
             \"{path}\" %*\r\n"
        )
    } else {
        format!(
            "#!/bin/sh\n\
             # {SIGNATURE}. A wrapper, not a symlink: osd finds its sidecars and\n\
             # bundled resources next to the real executable, and macOS does not\n\
             # resolve a symlink for current_exe().\n\
             if [ ! -x \"{path}\" ]; then\n\
             \techo \"Open Science Desktop is no longer installed; removing this leftover osd command.\" >&2\n\
             \trm -f -- \"$0\"\n\
             \texit 127\n\
             fi\n\
             exec \"{path}\" \"$@\"\n"
        )
    }
}

/// The line that adds `dir` to PATH by hand — the last resort, shown only when
/// everything automatic failed.
fn path_hint(dir: &Path) -> String {
    format!("export PATH=\"{}:$PATH\"", dir.display())
}

/// The login profile to extend, for the shell the user actually runs. A file
/// that does not exist yet is still the right answer: creating `~/.zprofile` on
/// a machine whose shell is zsh is what zsh itself would read next login.
/// The files that have to carry the PATH line for the shell the user runs.
///
/// Two of them, not one: a LOGIN shell reads `.zprofile`/`.bash_profile`, an
/// interactive one reads `.zshrc`/`.bashrc`, and which you get depends on how
/// the terminal was started. macOS terminals log in, tmux panes and many
/// editors' terminals do not — writing only the login file left `osd` missing
/// in exactly the windows a developer lives in. Both get the same guarded
/// block, and both are idempotent, so writing both costs nothing.
fn profiles_for(home: &Path, shell: &str) -> Vec<PathBuf> {
    let names: &[&str] = if shell.ends_with("zsh") {
        &[".zprofile", ".zshrc"]
    } else if shell.ends_with("bash") {
        &[".bash_profile", ".bashrc"]
    } else {
        // An unknown shell still reads ~/.profile in the POSIX case.
        &[".profile"]
    };
    names.iter().map(|n| home.join(n)).collect()
}

fn login_profiles() -> Result<Vec<PathBuf>, String> {
    Ok(profiles_for(
        &home()?,
        &std::env::var("SHELL").unwrap_or_default(),
    ))
}

/// Append the PATH line to every profile that shell reads, once each. Returns
/// the files, so the settings card can name exactly what was touched.
fn extend_login_profiles(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let profiles = login_profiles()?;
    let mut written = Vec::new();
    for profile in profiles {
        match extend_profile_file(&profile, dir) {
            Ok(()) => written.push(profile),
            // One unwritable file must not cost the user the other one.
            Err(e) => eprintln!("could not extend {}: {e}", profile.display()),
        }
    }
    if written.is_empty() {
        return Err("no shell profile could be written".into());
    }
    Ok(written)
}

/// The write itself, against a named file: no environment, so a test can drive
/// it without touching process-wide state that the rest of the suite shares.
fn extend_profile_file(profile: &Path, dir: &Path) -> Result<(), String> {
    let existing = std::fs::read_to_string(profile).unwrap_or_default();
    // Already ours: leave the file alone. This runs on every launch.
    if existing.contains(PROFILE_MARKER) {
        return Ok(());
    }
    let mut out = existing;
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(&format!(
        "\n{PROFILE_MARKER}\nexport PATH=\"{}:$PATH\"\n",
        dir.display()
    ));
    std::fs::write(profile, out).map_err(|e| e.to_string())
}

/// Put `dir` on the per-user PATH (Windows). .NET's setter writes the registry
/// AND broadcasts WM_SETTINGCHANGE, which is what makes a newly opened terminal
/// see it; `setx` would truncate a long PATH instead.
#[cfg(windows)]
fn extend_user_environment(dir: &Path) -> Result<(), String> {
    let script = format!(
        "$dir = '{}'; \
         $current = [Environment]::GetEnvironmentVariable('PATH','User'); \
         if (($current -split ';') -notcontains $dir) {{ \
           $next = if ([string]::IsNullOrEmpty($current)) {{ $dir }} else {{ \"$current;$dir\" }}; \
           [Environment]::SetEnvironmentVariable('PATH', $next, 'User') \
         }}",
        dir.display()
    );
    let status = osd_core::runtime::quiet_command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        // The variable just changed, so the cached "is it there" answer is stale.
        if let Some(cache) = USER_ENV_CACHE.get() {
            if let Ok(mut c) = cache.lock() {
                c.clear();
            }
        }
        Ok(())
    } else {
        Err(format!("powershell exited with {status}"))
    }
}

/// Is `dir` on the per-user PATH as stored, whether or not this process has it?
/// The app was launched before the variable was extended, so its own PATH is not
/// the authority on Windows.
///
/// Cached, because the answer costs a PowerShell process and is asked on every
/// launch AND on every render of the settings card. Nothing outside this app
/// changes it while we run, and the one thing that does — the write above —
/// clears it.
#[cfg(windows)]
static USER_ENV_CACHE: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<PathBuf, bool>>,
> = std::sync::OnceLock::new();

#[cfg(windows)]
fn in_user_environment(dir: &Path) -> bool {
    let cache = USER_ENV_CACHE.get_or_init(Default::default);
    if let Some(hit) = cache.lock().ok().and_then(|c| c.get(dir).copied()) {
        return hit;
    }
    let answer = query_user_environment(dir);
    if let Ok(mut c) = cache.lock() {
        c.insert(dir.to_path_buf(), answer);
    }
    answer
}

#[cfg(windows)]
fn query_user_environment(dir: &Path) -> bool {
    let script = format!(
        "$dir = '{}'; \
         $current = [Environment]::GetEnvironmentVariable('PATH','User'); \
         if (($current -split ';') -contains $dir) {{ exit 0 }} else {{ exit 1 }}",
        dir.display()
    );
    osd_core::runtime::quiet_command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn status_for(binary: Option<PathBuf>, shim: &Path, route: PathRoute, profile: Option<PathBuf>) -> CliShimStatus {
    let existing = std::fs::read_to_string(shim).ok();
    let ours = existing.as_deref().is_some_and(|t| t.contains(SIGNATURE));
    let installed = match (&existing, &binary) {
        (Some(text), Some(bin)) => ours && text.contains(&bin.display().to_string()),
        _ => false,
    };
    let dir = shim.parent().unwrap_or(shim);
    CliShimStatus {
        binary: binary.map(|b| b.display().to_string()),
        shim: shim.display().to_string(),
        installed,
        occupied: existing.is_some() && !ours,
        route,
        profile: profile.map(|p| p.display().to_string()),
        path_hint: (route == PathRoute::Unreachable).then(|| path_hint(dir)),
    }
}

/// Which route PATH takes for `dir`, arranging it when it is not arranged yet.
fn ensure_reachable(dir: &Path) -> (PathRoute, Option<PathBuf>) {
    if reachable(&login_shell_path(), dir) {
        return (PathRoute::AlreadyOnPath, None);
    }
    #[cfg(windows)]
    {
        if in_user_environment(dir) {
            return (PathRoute::UserEnvironment, None);
        }
        return match extend_user_environment(dir) {
            Ok(()) => (PathRoute::UserEnvironment, None),
            Err(e) => {
                eprintln!("could not extend the user PATH: {e}");
                (PathRoute::Unreachable, None)
            }
        };
    }
    #[cfg(not(windows))]
    match extend_login_profiles(dir) {
        Ok(profiles) => (PathRoute::ShellProfile, profiles.into_iter().next()),
        Err(e) => {
            eprintln!("could not extend the login profile: {e}");
            (PathRoute::Unreachable, None)
        }
    }
}

/// Install the wrapper and make sure its directory is on PATH. The one place
/// that writes anything; both the launch hook and the settings button call it.
fn install() -> Result<CliShimStatus, String> {
    let binary = bundled_osd().ok_or("this build does not carry the osd command")?;
    if runs_from_removable_image(&binary) {
        return Err("this copy is running from the disk image — drag Open Science into \
                    Applications, open it from there, and the command installs itself"
            .into());
    }
    let dir = shim_dir()?;
    let shim = dir.join(shim_name());
    // Never overwrite a file that is not ours — a user with their own `osd`
    // gets told, not clobbered.
    if let Ok(text) = std::fs::read_to_string(&shim) {
        if !text.contains(SIGNATURE) {
            return Err(format!("{} already exists and is not ours", shim.display()));
        }
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let script = wrapper_script(&binary);
    // Only write when the content differs, so a launch that changes nothing
    // does not touch the file's timestamp.
    if std::fs::read_to_string(&shim).ok().as_deref() != Some(script.as_str()) {
        std::fs::write(&shim, &script).map_err(|e| e.to_string())?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }
    let (route, profile) = ensure_reachable(&dir);
    Ok(status_for(Some(binary), &shim, route, profile))
}

/// Called once per launch, off the main thread: after installing the app, `osd`
/// works in a new terminal without the user having asked for it. Idempotent,
/// and silent about everything except a genuine failure.
pub fn install_on_launch() {
    std::thread::spawn(|| match install() {
        Ok(status) => {
            if status.route == PathRoute::Unreachable {
                eprintln!("osd installed at {} but not on PATH", status.shim);
            }
        }
        // A dev build carries no `osd`; that is not worth a line in the log.
        Err(e) if e.starts_with("this build") => {}
        Err(e) => eprintln!("could not install the osd command: {e}"),
    });
}

/// Where the command is, how it is reachable, and what was touched to make it
/// so. Reads only — the launch hook and the button do the writing.
#[tauri::command]
pub fn cli_shim_status() -> Result<CliShimStatus, String> {
    let dir = shim_dir()?;
    let shim = dir.join(shim_name());
    let route = if reachable(&login_shell_path(), &dir) {
        PathRoute::AlreadyOnPath
    } else {
        #[cfg(windows)]
        {
            if in_user_environment(&dir) {
                PathRoute::UserEnvironment
            } else {
                PathRoute::Unreachable
            }
        }
        #[cfg(not(windows))]
        {
            let arranged = login_profiles()
                .unwrap_or_default()
                .iter()
                .any(|p| {
                    std::fs::read_to_string(p)
                        .is_ok_and(|t| t.contains(PROFILE_MARKER))
                });
            if arranged {
                PathRoute::ShellProfile
            } else {
                PathRoute::Unreachable
            }
        }
    };
    let profile = match route {
        PathRoute::ShellProfile => login_profiles().ok().and_then(|p| p.into_iter().next()),
        _ => None,
    };
    Ok(status_for(bundled_osd(), &shim, route, profile))
}

/// Repair or redo the install by hand — for a copy of the app that moved, or a
/// launch whose automatic attempt failed.
#[tauri::command]
pub fn install_cli_shim() -> Result<CliShimStatus, String> {
    install()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// None of these tests touch HOME, SHELL or PATH. An earlier version did,
    /// and process-wide environment changes broke unrelated tests running in
    /// parallel (the R kernel bridge could not find its interpreter) — so every
    /// function that decides something takes what it needs as an argument.
    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cli-shim-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_wrapper_execs_the_real_binary_and_never_symlinks_it() {
        let script = wrapper_script(Path::new("/Applications/Open Science.app/Contents/MacOS/osd"));
        assert!(script.contains("/Applications/Open Science.app/Contents/MacOS/osd"));
        assert!(script.contains(SIGNATURE), "a re-install must recognise its own file");
        if cfg!(windows) {
            assert!(script.starts_with("@echo off"), "{script}");
            assert!(script.contains("%*"), "arguments must reach osd: {script}");
        } else {
            assert!(script.starts_with("#!/bin/sh"), "{script}");
            assert!(script.contains("exec \""), "{script}");
            assert!(script.contains("\"$@\""), "arguments must reach osd: {script}");
        }
    }

    #[test]
    fn a_conventional_user_bin_already_on_the_terminals_path_is_used_as_is() {
        let home = tmp("home");
        let bin = home.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let terminal_path = vec![bin.clone(), PathBuf::from("/usr/bin")];

        assert_eq!(
            choose_shim_dir(&terminal_path, &home),
            bin,
            "a user bin directory a terminal already searches wins"
        );
        assert!(reachable(&terminal_path, &bin), "and nothing has to be arranged");
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn local_bin_is_preferred_over_bin_when_a_terminal_searches_both() {
        let home = tmp("both");
        let local = home.join(".local/bin");
        let plain = home.join("bin");
        std::fs::create_dir_all(&local).unwrap();
        std::fs::create_dir_all(&plain).unwrap();
        assert_eq!(
            choose_shim_dir(&[plain, local.clone()], &home),
            local,
            "one answer, whatever order PATH happens to list them in"
        );
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn a_tool_owned_directory_on_path_is_never_used_however_writable_it_is() {
        // Measured on a real machine: `~/.cargo/bin` is the FIRST writable
        // directory under $HOME on the login PATH. A wrapper of ours belongs in
        // neither rustup's directory nor nvm's.
        let home = tmp("tooling");
        for rel in [".cargo/bin", ".nvm/versions/node/v24/bin"] {
            std::fs::create_dir_all(home.join(rel)).unwrap();
        }
        let path = vec![home.join(".cargo/bin"), home.join(".nvm/versions/node/v24/bin")];
        assert_eq!(
            choose_shim_dir(&path, &home),
            home.join(".local").join("bin"),
            "an unrelated tool's bin directory is not ours to write into"
        );
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn a_directory_that_does_not_exist_yet_is_not_mistaken_for_one_that_does() {
        let home = tmp("missing-dir");
        // `~/bin` is on PATH but was never created: fall back rather than
        // assume PATH describes the filesystem.
        assert_eq!(
            choose_shim_dir(&[home.join("bin")], &home),
            home.join(".local").join("bin")
        );
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn the_profile_block_is_written_once_and_keeps_what_was_there() {
        let home = tmp("profile");
        let profile = home.join(".zprofile");
        std::fs::write(&profile, "export EDITOR=vim").unwrap();
        let dir = home.join(".local/bin");

        extend_profile_file(&profile, &dir).unwrap();
        let after_first = std::fs::read_to_string(&profile).unwrap();
        assert!(
            after_first.starts_with("export EDITOR=vim\n"),
            "a file with no trailing newline must not get the block glued to its last line: {after_first}"
        );
        assert!(after_first.contains(&dir.display().to_string()), "{after_first}");

        // Every later launch calls this again and must change nothing.
        extend_profile_file(&profile, &dir).unwrap();
        extend_profile_file(&profile, &dir).unwrap();
        assert_eq!(std::fs::read_to_string(&profile).unwrap(), after_first);
        assert_eq!(
            after_first.matches(PROFILE_MARKER).count(),
            1,
            "one block, however many launches"
        );
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn a_wrapper_whose_app_is_gone_says_so_and_removes_itself() {
        // Uninstalling cannot reach a per-user file in $HOME, so the leftover
        // command has to clean up the first time it is used. Run as a real
        // script rather than asserted as text: `rm -f -- "$0"` while the shell
        // is reading the file is the part worth proving.
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp("gone");
        let missing = dir.join("Open Science.app/Contents/MacOS/osd");
        let shim = dir.join("osd");
        std::fs::write(&shim, wrapper_script(&missing)).unwrap();
        std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).unwrap();

        let out = std::process::Command::new("sh").arg(&shim).arg("status").output().unwrap();
        assert_eq!(out.status.code(), Some(127), "a missing app is not a success");
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(stderr.contains("no longer installed"), "{stderr}");
        assert!(!shim.exists(), "the leftover command must delete itself");

        // And with the app present it still just runs it, arguments intact.
        let real = dir.join("real-osd");
        std::fs::write(&real, "#!/bin/sh\necho \"ran with: $*\"\n").unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(&shim, wrapper_script(&real)).unwrap();
        std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).unwrap();
        let out = std::process::Command::new("sh")
            .arg(&shim)
            .args(["session", "send", "an argument with spaces"])
            .output()
            .unwrap();
        assert!(out.status.success());
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            "ran with: session send an argument with spaces"
        );
        assert!(shim.exists(), "a working wrapper must not delete itself");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn both_the_login_file_and_the_interactive_one_get_the_path_line() {
        // A tmux pane or an editor terminal runs zsh WITHOUT logging in, so it
        // reads .zshrc and never .zprofile. Writing only the login file left
        // `osd` missing in exactly those windows.
        let home = Path::new("/home/u");
        assert_eq!(
            profiles_for(home, "/bin/zsh"),
            vec![home.join(".zprofile"), home.join(".zshrc")]
        );
        assert_eq!(
            profiles_for(home, "/bin/bash"),
            vec![home.join(".bash_profile"), home.join(".bashrc")]
        );
        assert_eq!(profiles_for(home, "/usr/local/bin/fish"), vec![home.join(".profile")]);
    }

    #[test]
    fn every_profile_gets_the_block_exactly_once() {
        let home = tmp("profiles");
        let dir = home.join(".local/bin");
        let files = profiles_for(&home, "/bin/zsh");
        std::fs::write(&files[1], "alias ll='ls -la'").unwrap();

        for file in &files {
            extend_profile_file(file, &dir).unwrap();
            extend_profile_file(file, &dir).unwrap();
        }
        for file in &files {
            let text = std::fs::read_to_string(file).unwrap();
            assert_eq!(text.matches(PROFILE_MARKER).count(), 1, "{file:?}: {text}");
            assert!(text.contains(&dir.display().to_string()));
        }
        assert!(
            std::fs::read_to_string(&files[1]).unwrap().starts_with("alias ll='ls -la'\n"),
            "an existing rc file keeps what it had"
        );
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn status_tells_ours_from_a_stranger_and_from_a_stale_wrapper() {
        let dir = tmp("status");
        let shim = dir.join(shim_name());
        let binary = dir.join("app/osd");

        let s = status_for(Some(binary.clone()), &shim, PathRoute::AlreadyOnPath, None);
        assert!(!s.installed && !s.occupied, "nothing there yet");

        std::fs::write(&shim, "#!/bin/sh\necho not ours\n").unwrap();
        let s = status_for(Some(binary.clone()), &shim, PathRoute::AlreadyOnPath, None);
        assert!(s.occupied && !s.installed);

        // Ours, but naming an app that has moved: not installed, so the button
        // offers to point it here again.
        std::fs::write(&shim, wrapper_script(Path::new("/old/path/osd"))).unwrap();
        let s = status_for(Some(binary.clone()), &shim, PathRoute::AlreadyOnPath, None);
        assert!(!s.occupied && !s.installed);

        std::fs::write(&shim, wrapper_script(&binary)).unwrap();
        let s = status_for(Some(binary), &shim, PathRoute::AlreadyOnPath, None);
        assert!(s.installed && !s.occupied);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_an_unreachable_install_offers_a_line_to_paste() {
        let dir = tmp("hint");
        let shim = dir.join(shim_name());
        let arranged = status_for(None, &shim, PathRoute::ShellProfile, Some(dir.join(".zprofile")));
        assert!(arranged.path_hint.is_none(), "PATH is handled — do not ask the user to");
        let stuck = status_for(None, &shim, PathRoute::Unreachable, None);
        let hint = stuck.path_hint.expect("a stuck install must say what to do");
        assert!(hint.contains(&dir.display().to_string()), "{hint}");
        assert!(!hint.to_lowercase().contains("setx"), "setx truncates a long PATH: {hint}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_copy_running_from_the_disk_image_is_refused() {
        // Its wrapper would name a path that disappears on eject, leaving `osd`
        // installed and missing at the same time.
        if cfg!(target_os = "macos") {
            assert!(runs_from_removable_image(Path::new(
                "/Volumes/Open Science/Open Science.app/Contents/MacOS/osd"
            )));
        }
        assert!(!runs_from_removable_image(Path::new(
            "/Applications/Open Science.app/Contents/MacOS/osd"
        )));
    }
}
