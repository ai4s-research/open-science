// AI4S Workbench — Tauri 2 entry. Hosts the React frontend and supervises the
// bundled OpenCode sidecar (isolated config/data + dedicated port; killed on exit).
mod artifact_file;
mod browser;
mod debug_log;
mod examples;
mod gateway;
mod git_snapshot;
mod goal;
mod harness;
mod compute;
mod jupyter;
mod kernel;
mod large_file;
mod modal;
mod model_probe;
mod opencode_config;
mod preview_server;
mod project;
mod provenance;
mod runs;
mod runs_index;
mod runtime;
mod science_mcp;
mod tools;
#[cfg(target_os = "macos")]
mod macos;
mod updates;
mod uv;

use jupyter::JupyterState;
use kernel::KernelState;
use preview_server::PreviewState;
use provenance::ProvenanceState;
use runtime::RuntimeState;
use tauri::Manager;

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
        .manage(RuntimeState::default())
        .manage(KernelState::default())
        .manage(JupyterState::default())
        .manage(PreviewState::default())
        .manage(ProvenanceState::default())
        .manage(runs::RunState::default())
        .manage(gateway::GatewayState::default())
        .setup(|app| {
            // Watch the active workspace so changes made outside the app (an
            // external editor, a detached process) still enqueue a debounced
            // snapshot. Re-pointed on every workspace switch in set_workspace.
            if let Ok(ws) = runtime::workspace_dir(app.handle()) {
                git_snapshot::watch_workspace(&ws);
            }
            // Bring the remote-access gateway back up if the user left it enabled.
            gateway::autostart(app.handle());
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
            runtime::runtime_password,
            gateway::gateway_status,
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
            model_probe::probe_endpoint_models,
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
            runtime::get_proxy_setting,
            runtime::set_proxy_setting,
            runtime::get_mirror_setting,
            runtime::set_mirror_setting,
            browser::agent_browser_bin,
            browser::agent_browser_profiles,
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
                runtime::kill_child(&app.state::<RuntimeState>());
                kernel::kill_kernel(&app.state::<KernelState>());
                jupyter::kill_jupyter(&app.state::<JupyterState>());
                gateway::shutdown(app.state::<gateway::GatewayState>().inner());
            }
        });
}
