; Installer strings, wired up via bundle > windows > nsis > customLanguageFiles.
;
; A custom language file REPLACES the bundler's built-in set rather than adding
; to it, so every string it ships has to be here. All of these are Tauri's
; defaults verbatim except the three marked below.
LangString addOrReinstall ${LANG_ENGLISH} "Add/Reinstall components"
LangString alreadyInstalled ${LANG_ENGLISH} "Already Installed"
LangString alreadyInstalledLong ${LANG_ENGLISH} "${PRODUCTNAME} ${VERSION} is already installed. Select the operation you want to perform and click Next to continue."
LangString appRunning ${LANG_ENGLISH} "{{product_name}} is running! Please close it first then try again."
LangString appRunningOkKill ${LANG_ENGLISH} "{{product_name}} is running!$\nClick OK to kill it"
LangString chooseMaintenanceOption ${LANG_ENGLISH} "Choose the maintenance option to perform."
LangString choowHowToInstall ${LANG_ENGLISH} "Choose how you want to install ${PRODUCTNAME}."
LangString createDesktop ${LANG_ENGLISH} "Create desktop shortcut"
LangString failedToKillApp ${LANG_ENGLISH} "Failed to kill {{product_name}}. Please close it first then try again"
LangString installingWebview2 ${LANG_ENGLISH} "Installing WebView2..."
LangString newerVersionInstalled ${LANG_ENGLISH} "A newer version of ${PRODUCTNAME} is already installed! It is not recommended that you install an older version. If you really want to install this older version, it's better to uninstall the current version first. Select the operation you want to perform and click Next to continue."
LangString older ${LANG_ENGLISH} "older"
LangString olderOrUnknownVersionInstalled ${LANG_ENGLISH} "An $R4 version of ${PRODUCTNAME} is installed on your system. It's recommended that you uninstall the current version before installing. Select the operation you want to perform and click Next to continue."
LangString silentDowngrades ${LANG_ENGLISH} "Downgrades are disabled for this installer, can't proceed with the silent installer, please use the graphical interface installer instead.$\n"
LangString uninstallApp ${LANG_ENGLISH} "Uninstall ${PRODUCTNAME}"
LangString unknown ${LANG_ENGLISH} "unknown"
LangString webview2AbortError ${LANG_ENGLISH} "Failed to install WebView2! The app can't run without it. Try restarting the installer."
LangString webview2DownloadError ${LANG_ENGLISH} "Error: Downloading WebView2 Failed - $0"
LangString webview2DownloadSuccess ${LANG_ENGLISH} "WebView2 bootstrapper downloaded successfully"
LangString webview2Downloading ${LANG_ENGLISH} "Downloading WebView2 bootstrapper..."
LangString webview2InstallError ${LANG_ENGLISH} "Error: Installing WebView2 failed with exit code $1"
LangString webview2InstallSuccess ${LANG_ENGLISH} "WebView2 installed successfully"

; --- Changed from Tauri's defaults -------------------------------------------

; Default: "Delete the application data". That names nothing, and the box is
; ticked on a screen most people click through — while it erases
; %APPDATA%\com.ai4s.workbench, which holds every session, every run record and
; the SQLite index. Say what is actually lost, in the user's own terms.
LangString deleteAppData ${LANG_ENGLISH} "Also delete my sessions, run history and settings (cannot be undone)"

; Default: "Unable to uninstall!" — a dead end that sent users to the issue
; tracker (#113) with nowhere to go. Both ways out fit in one sentence.
LangString unableToUninstall ${LANG_ENGLISH} "Could not remove the existing version. Close ${PRODUCTNAME} if it is still running and try again, or go back and choose 'Install over it' — upgrading in place is safe and keeps your data."

; Defaults: "Uninstall before installing" / "Do not uninstall". On an upgrade
; these read as a coin toss, and the wrong side of it is where the data loss
; and the uninstall failures live. Name the safe one as the safe one.
LangString uninstallBeforeInstalling ${LANG_ENGLISH} "Remove the old version first (only if an upgrade has failed)"
LangString dontUninstall ${LANG_ENGLISH} "Install over it, keeping my data (recommended)"
LangString dontUninstallDowngrade ${LANG_ENGLISH} "Install over it, keeping my data (downgrading without uninstall is disabled for this installer)"
