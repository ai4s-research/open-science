// Computer use, desktop-side glue. The agent never comes through here: it calls
// the `computer` tool, which drives the native provider directly. What is left
// for the app is the part a tool cannot do — reporting whether macOS has granted
// the permissions this needs, and taking the user to where they are granted.
//
// The two permissions do NOT live in the same place, and that is measured, not
// assumed:
//
//   Accessibility  → `Open Science Computer Use.app`, the separate helper. macOS
//                    judges it against that bundle's own identity, so the
//                    workbench never asks for the right to read every window.
//   Screen Recording → THIS app. macOS attributes screen capture to the
//                    responsible process — the app that started the chain — so
//                    granting it to the helper alone changes nothing.
use tauri::AppHandle;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUseStatus {
    /// A provider for this platform is present and usable.
    available: bool,
    platform: String,
    /// macOS only; None elsewhere, where there is no helper app.
    helper_app_path: Option<String>,
    /// "granted" | "not-granted" | "unsupported".
    accessibility: String,
    screenshots: String,
    /// Why computer use is unavailable, when it is. None when it works.
    reason: Option<String>,
}

/// Whether computer use can run here, and — on macOS — whether the permissions
/// it needs have been granted.
#[tauri::command]
pub async fn computer_use_status(app: AppHandle) -> Result<ComputerUseStatus, String> {
    platform_impl::status(app).await
}

/// Open the helper's own setup window, where the user grants the permissions.
/// `permission` is "accessibility" or "screenshots" to jump straight to one.
#[tauri::command]
pub fn open_computer_use_permissions(
    app: AppHandle,
    permission: Option<String>,
) -> Result<(), String> {
    platform_impl::open_permissions(app, permission)
}

#[cfg(target_os = "macos")]
mod platform_impl {
    use super::ComputerUseStatus;
    use crate::env_of;
    use osd_core::runtime::computer_use_provider_dir;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
    use tauri::AppHandle;

    const HELPER_APP_NAME: &str = "Open Science Computer Use.app";

    /// How long to wait for the helper to write its answer. It is a GUI app
    /// launch, so the first one after an update can be slow; past this the
    /// honest report is that we do not know.
    const STATUS_TIMEOUT: Duration = Duration::from_secs(10);

    /// The helper answers for Accessibility only. Its Screen Recording answer is
    /// deliberately ignored — see `status`.
    #[derive(serde::Deserialize)]
    struct HelperPermissions {
        #[serde(default)]
        accessibility: Option<String>,
    }

    fn helper_app(app: &AppHandle) -> Option<PathBuf> {
        let path = computer_use_provider_dir(&env_of(app))?.join(HELPER_APP_NAME);
        path.is_dir().then_some(path)
    }

    pub async fn status(app: AppHandle) -> Result<ComputerUseStatus, String> {
        let platform = std::env::consts::OS.to_string();
        let Some(helper) = helper_app(&app) else {
            return Ok(ComputerUseStatus {
                available: false,
                platform,
                helper_app_path: None,
                accessibility: "not-granted".into(),
                screenshots: "not-granted".into(),
                reason: Some(format!("{HELPER_APP_NAME} is not bundled with this build")),
            });
        };
        let permissions = read_helper_permissions(&helper).await?;
        let accessibility = permissions.accessibility.unwrap_or_else(|| "not-granted".into());
        let granted = accessibility == "granted";
        Ok(ComputerUseStatus {
            available: granted,
            platform,
            helper_app_path: Some(helper.to_string_lossy().to_string()),
            accessibility,
            // NOT the helper's answer. The two permissions are attributed
            // differently, and the difference is not something either side can
            // paper over: Accessibility is judged against the helper's own
            // bundle, while Screen Recording is judged against the RESPONSIBLE
            // process — the app that started the chain, which is this one.
            // Measured: with the helper granted and this app not, screenshots
            // fail; granting this app is what makes them work.
            screenshots: screen_recording_state(),
            // Screen Recording is optional: without it the accessibility tree
            // still reads and only screenshots fail. Accessibility is not.
            reason: (!granted)
                .then(|| "Accessibility permission has not been granted to the helper".to_string()),
        })
    }

    /// Whether THIS app may capture the screen, asked without prompting.
    fn screen_recording_state() -> String {
        if unsafe { CGPreflightScreenCaptureAccess() } {
            "granted".into()
        } else {
            "not-granted".into()
        }
    }

    // CoreGraphics' two TCC entry points for screen capture. `CGPreflight…`
    // reports the current answer and never prompts; `CGRequest…` shows the
    // system prompt the first time and is a no-op once the user has decided.
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    pub fn open_permissions(app: AppHandle, permission: Option<String>) -> Result<(), String> {
        // Screen Recording belongs to this app, not to the helper, so the
        // helper's setup window would send the user to toggle the wrong row.
        if permission.as_deref() == Some("screenshots") {
            return request_screen_recording();
        }
        let helper =
            helper_app(&app).ok_or_else(|| format!("{HELPER_APP_NAME} is not bundled with this build"))?;
        let mut args: Vec<String> =
            vec!["-n".into(), helper.to_string_lossy().to_string(), "--args".into()];
        match permission.as_deref() {
            // Accessibility is the only permission this window can actually
            // arrange, so the general "open setup" button opens it too rather
            // than a two-step flow whose second step is wrong.
            Some("accessibility") | None => {
                args.push("--permission".into());
                args.push("accessibility".into());
            }
            Some(other) => return Err(format!("unknown permission \"{other}\"")),
        }
        crate::runtime::quiet_command("/usr/bin/open")
            .args(args)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("could not open the computer-use setup window: {e}"))
    }

    /// Ask macOS for screen capture on this app's behalf.
    ///
    /// The prompt appears only while the user has not decided yet; once they
    /// have, `CGRequest…` returns the standing answer silently, and the only
    /// way to change it is the Settings pane — so open that when the answer is
    /// still no.
    fn request_screen_recording() -> Result<(), String> {
        if unsafe { CGPreflightScreenCaptureAccess() } {
            return Ok(());
        }
        if unsafe { CGRequestScreenCaptureAccess() } {
            return Ok(());
        }
        crate::runtime::quiet_command("/usr/bin/open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("could not open Screen Recording settings: {e}"))
    }

    /// Ask the helper what macOS currently grants it.
    ///
    /// It has to be launched as an APP, not exec'd as a binary: TCC answers for
    /// the bundle identity that asks, and exec'ing the executable directly would
    /// let this app's own context answer instead — reporting the wrong thing.
    async fn read_helper_permissions(helper: &Path) -> Result<HelperPermissions, String> {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let dir = std::env::temp_dir()
            .join(format!("osd-computer-use-permissions-{}-{unique}", std::process::id()));
        std::fs::create_dir_all(&dir).map_err(|e| format!("could not check permissions: {e}"))?;
        let status_path = dir.join("status.json");
        let _cleanup = TempDirGuard(dir);

        let launched = crate::runtime::quiet_command("/usr/bin/open")
            .args([
                "-n".as_ref(),
                helper.as_os_str(),
                "--args".as_ref(),
                "--permission-status-file".as_ref(),
                status_path.as_os_str(),
            ])
            .status()
            .map_err(|e| format!("could not check permissions: {e}"))?;
        if !launched.success() {
            return Err("could not check permissions: the helper would not launch".into());
        }

        let deadline = Instant::now() + STATUS_TIMEOUT;
        while Instant::now() < deadline {
            if let Ok(text) = std::fs::read_to_string(&status_path) {
                return serde_json::from_str(&text)
                    .map_err(|e| format!("could not read the permission report: {e}"));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Err("timed out checking computer-use permissions".into())
    }

    /// Removes the one-shot status directory whichever way the read returns.
    struct TempDirGuard(PathBuf);

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform_impl {
    use super::ComputerUseStatus;
    use crate::env_of;
    use osd_core::runtime::computer_use_provider_dir;
    use tauri::AppHandle;

    /// Linux and Windows have no per-app grant for this: the desktop
    /// accessibility service answers any process in the user's own session. So
    /// availability is only a question of whether the provider script shipped.
    pub async fn status(app: AppHandle) -> Result<ComputerUseStatus, String> {
        let name = if cfg!(windows) { "runtime.ps1" } else { "runtime.py" };
        let available = computer_use_provider_dir(&env_of(&app))
            .map(|dir| dir.join(name).is_file())
            .unwrap_or(false);
        Ok(ComputerUseStatus {
            available,
            platform: std::env::consts::OS.to_string(),
            helper_app_path: None,
            accessibility: "unsupported".into(),
            screenshots: "unsupported".into(),
            reason: (!available)
                .then(|| "this build does not carry the computer-use provider".to_string()),
        })
    }

    pub fn open_permissions(_app: AppHandle, _permission: Option<String>) -> Result<(), String> {
        Err("computer use needs no permission setup on this platform".into())
    }
}
