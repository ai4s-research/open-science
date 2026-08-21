// AI4S Workbench — Tauri 2 entry. Hosts the React frontend and supervises the
// bundled OpenCode sidecar (isolated config/data + dedicated port; killed on exit).
mod artifact_file;
mod browser;
mod cli_shim;
mod debug_log;
mod examples;
mod gateway;
mod git_snapshot;
mod goal;
mod compute;
mod jupyter;
mod kernel;
mod large_file;
mod modal;
mod model_probe;
mod preview_server;
mod project;
mod provenance;
mod acp;
mod runs;
mod runs_index;
mod runtime;
mod science_mcp;
mod ssh_session;
mod tools;
#[cfg(target_os = "macos")]
mod macos;
mod updates;
mod uv;

use jupyter::JupyterState;
use kernel::KernelState;
use osd_core::provenance::ProvenanceState;
use osd_core::runs::RunState;
use osd_core::Env;
use preview_server::PreviewState;
use tauri::{AppHandle, Manager};

/// The desktop's `Env`, managed once at startup. Every core call goes through
/// it, and it is a cheap clone (one `Arc`).
pub struct EnvState(pub Env);

/// The `Env` for this app handle. Panics only if called before `setup` has
/// managed it, which no command can be.
pub(crate) fn env_of(app: &AppHandle) -> Env {
    app.state::<EnvState>().0.clone()
}

/// Build the `Env` from Tauri's own path resolution, so the desktop and `osd`
/// agree on where the data and the bundled resources are.
fn build_env(app: &AppHandle) -> Result<Env, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    // Resources are resolved by Tauri (it knows the bundle layout on each
    // platform); the core only ever joins names onto this directory.
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    Ok(Env::new(
        data_dir,
        resource_dir,
        app.path().document_dir().ok(),
        app.package_info().version.to_string(),
    ))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Single instance MUST be the first plugin. A second launch (or a reinstall
        // while the app is still running) focuses the existing window instead of
        // starting a second OpenCode on the same data dir (which deadlocks the DB).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .manage(KernelState::default())
        .manage(JupyterState::default())
        .manage(PreviewState::default())
        .manage(ProvenanceState::default())
        .manage(RunState::default())
        .manage(ssh_session::SshState::default())
        .manage(acp::AcpState::default())
        .setup(|app| {
            // Every core call needs this, so nothing else may run before it.
            app.manage(EnvState(build_env(app.handle())?));
            // The gateway serves the real frontend, which only a live handle can
            // resolve — hence built here rather than at `manage` time.
            app.manage(gateway::state_for(app.handle()));
            // Watch the active workspace so changes made outside the app (an
            // external editor, a detached process) still enqueue a debounced
            // snapshot. Re-pointed on every workspace switch in set_workspace.
            if let Ok(ws) = runtime::workspace_dir(app.handle()) {
                git_snapshot::watch_workspace(&ws);
            }
            // Bring the remote-access gateway back up if the user left it enabled.
            gateway::autostart(app.handle());
            // Make `osd` work in a terminal without the user arranging anything:
            // the binary is already in this bundle, so all this does is put a
            // wrapper where PATH can find it. Off the main thread and idempotent.
            cli_shim::install_on_launch();
            Ok(())
        })
        // The transparent + vibrancy window loses tao's traffic-light inset on
        // some machines (tao only re-applies it from drawRect). Re-pin on the
        // events that cover launch, resize, and the in-app theme switch.
        .on_window_event(|_window, _event| {
            #[cfg(target_os = "macos")]
            if matches!(
                _event,
                tauri::WindowEvent::Focused(true)
                    | tauri::WindowEvent::Resized(_)
                    | tauri::WindowEvent::ThemeChanged(_)
            ) {
                macos::reapply_traffic_light_inset(_window);
            }
        })
        .invoke_handler(tauri::generate_handler![
            runtime::start_runtime,
            runtime::restart_runtime,
            runtime::runtime_started_at,
            runtime::runtime_password,
            gateway::gateway_status,
            gateway::acp_server_script,
            cli_shim::cli_shim_status,
            cli_shim::install_cli_shim,
            gateway::set_gateway_config,
            gateway::regenerate_gateway_token,
            runtime::stop_runtime,
            runtime::workspace_path,
            runtime::workspace_base,
            runtime::set_workspace_base,
            runtime::open_workspace_base,
            runtime::set_workspace,
            runtime::mark_session,
            runtime::new_dated_workspace,
            goal::goal_state,
            goal::goal_update,
            project::create_project,
            project::import_project,
            project::list_projects,
            project::rename_project,
            project::set_project_pinned,
            project::delete_project,
            project::open_project_folder,
            runtime::pick_folder,
            runtime::write_export_file,
            runtime::install_skill_markdown,
            runtime::workspace_skill_names,
            runtime::adopt_workspace_skills,
            runtime::import_opencode_login,
            runtime::runtime_failure,
            runtime::take_config_quarantine_notice,
            model_probe::probe_endpoint_models,
            model_probe::zen_models,
            runtime::provider_auth_exists,
            runtime::remove_config_entry,
            jupyter::jupyter_status,
            jupyter::setup_jupyter,
            jupyter::start_jupyter,
            runtime::configure_opencode,
            runtime::get_approval_mode,
            runtime::set_approval_mode,
            runtime::read_memory,
            runtime::write_memory,
            runtime::append_memory,
            runtime::get_memory_enabled,
            runtime::set_memory_enabled,
            runtime::get_agent_models,
            runtime::set_agent_model,
            runtime::get_agent_variants,
            runtime::set_agent_variant,
            runtime::get_proxy_setting,
            runtime::set_proxy_setting,
            runtime::get_mirror_setting,
            runtime::set_mirror_setting,
            browser::agent_browser_bin,
            browser::browser_mcp_bin,
            browser::agent_browser_profiles,
            browser::close_agent_browser,
            browser::detect_chrome,
            browser::setup_browser_chrome,
            kernel::kernel_execute,
            kernel::kernel_reset,
            kernel::python_interpreter,
            kernel::set_python_path,
            artifact_file::read_artifact,
            artifact_file::open_path,
            artifact_file::reveal_path,
            artifact_file::absolute_path,
            artifact_file::resolve_artifact,
            artifact_file::save_text_file,
            artifact_file::open_url,
            artifact_file::add_files_to_workspace,
            artifact_file::add_text_to_workspace,
            artifact_file::add_binary_to_workspace,
            artifact_file::add_paths_to_workspace,
            artifact_file::list_notebooks,
            artifact_file::list_dir,
            artifact_file::write_workspace_file,
            provenance::record_provenance,
            provenance::list_provenance,
            provenance::read_env_lockfile,
            runs::record_run,
            runs::list_runs,
            runs::read_run_log,
            runs_index::query_runs_cmd,
            science_mcp::science_mcp_python,
            science_mcp::setup_science_mcp,
            examples::install_example,
            git_snapshot::commit_workspace_snapshot,
            compute::list_ssh_hosts,
            compute::compute_machines,
            compute::add_compute_machine,
            compute::remove_compute_machine,
            compute::compute_probe,
            compute::compute_jobs,
            compute::compute_cancel,
            ssh_session::ssh_connect,
            ssh_session::ssh_answer,
            ssh_session::ssh_disconnect,
            ssh_session::ssh_sessions,
            ssh_session::ssh_sharing_supported,
            acp::acp_start,
            acp::acp_send,
            acp::acp_stop,
            acp::acp_running,
            modal::modal_status,
            preview_server::preview_url,
            large_file::probe_large_file,
            tools::detect_tools,
            updates::latest_release,
            debug_log::log_debug
        ])
        .build(tauri::generate_context!())
        .expect("error while building AI4S Workbench")
        .run(|app, event| {
            // Clean up on exit. macOS Cmd+Q / Quit terminates via RunEvent::Exit
            // (ExitRequested is not always delivered), so handle BOTH — otherwise
            // the OpenCode sidecar / kernel / Jupyter orphan on every quit. The
            // cleanup is idempotent, so running on both is safe.
            if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
                browser::close_agent_browser_on_exit();
                runtime::kill_child(env_of(app).runtime());
                kernel::kill_kernel(&app.state::<KernelState>());
                jupyter::kill_jupyter(&app.state::<JupyterState>());
                gateway::shutdown(app, app.state::<osd_core::gateway::GatewayState>().inner());
                // An authenticated ssh channel must not outlive the app that
                // opened it (#73) — the master lives past our exit otherwise.
                ssh_session::shutdown(app);
                // An ACP agent child must not outlive the window that started it.
                acp::shutdown(app);
            }
        });
}
