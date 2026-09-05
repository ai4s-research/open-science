# apps/desktop/src-tauri

The Rust side of the Tauri app.

Responsibilities:

- Native commands exposed to the frontend (filesystem within the workspace, OS keychain
  access for API keys, etc.).
- Spawning and supervising sidecars (the OpenCode runtime; later the Jupyter Kernel Gateway).
- Packaging configuration — targets: `dmg` / `app` (macOS), `nsis` + `msi`
  (Windows; NSIS is the default download, the MSI is for IT-managed deployment).
  Installer text and the uninstaller's sidecar cleanup live in `nsis/`.
- Auto-update wiring (Tauri updater, GitHub Releases + signed `latest.json`) — later.

Keep this thin: system capabilities only, no heavy computation. Heavy work goes to
`runtime/manager` and sidecars.

To be added when build tooling is scaffolded: `Cargo.toml`, `tauri.conf.json`, `src/main.rs`.
