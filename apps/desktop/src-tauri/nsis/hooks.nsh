; NSIS installer hooks, wired up via bundle > windows > nsis > installerHooks.
;
; Why this exists: the app ships sidecars (opencode, uv, agent-browser) that run
; from $INSTDIR but are not ${MAINBINARYNAME}, so the bundler's own
; CheckIfAppIsRunning macro never sees them -- it closes the app and leaves the
; helpers holding file handles on $INSTDIR. That breaks BOTH directions:
;
;   Uninstall -- the uninstaller's Delete/RMDir fail silently, and the *next*
;   installer's reinstall page aborts with "Unable to uninstall!", since its
;   success test is `$0 <> 0 ${OrIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"`
;   and a leftover binary trips it even when the uninstaller exited 0 (#113).
;
;   Install -- `File` cannot overwrite a locked helper, so the user gets
;   "Error opening file for writing: agent-browser.exe" with Abort/Retry/Ignore.
;   Ignore is the obvious-looking choice and it silently keeps the OLD binary,
;   producing an install that is part new and part old with nothing to show for
;   it. Reported as #116, where the stale half was the browser plugin and every
;   browser call came back "trusted conversation lease was not supplied".
;
; Only processes this user owns are touched (installMode is currentUser), and a
; sidecar that is already gone is not an error. msedgewebview2.exe is
; deliberately left alone -- it is shared with every other WebView2 app.

!macro KillSidecarProcess name
  nsis_tauri_utils::FindProcessCurrentUser "${name}"
  Pop $0
  ${If} $0 = 0
    nsis_tauri_utils::KillProcessCurrentUser "${name}"
    Pop $0
    Sleep 500
  ${EndIf}
!macroend

!macro KillAllSidecars
  !insertmacro KillSidecarProcess "opencode.exe"
  !insertmacro KillSidecarProcess "agent-browser.exe"
  !insertmacro KillSidecarProcess "uv.exe"
!macroend

; Runs at the top of Section Install, before CheckIfAppIsRunning and before the
; first `File` write -- so every helper is gone by the time anything is copied.
!macro NSIS_HOOK_PREINSTALL
  !insertmacro KillAllSidecars
!macroend

; Runs at the top of Section Uninstall, before the main binary is deleted.
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro KillAllSidecars
!macroend
