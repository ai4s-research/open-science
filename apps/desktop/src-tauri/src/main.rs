// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let mut args = std::env::args_os();
    let _executable = args.next();
    if args.next().as_deref()
        == Some(std::ffi::OsStr::new(
            osd_core::browser_mcp_proxy::PROXY_FLAG,
        ))
    {
        std::process::exit(osd_core::browser_mcp_proxy::run(args.collect()));
    }
    ai4s_workbench_lib::run()
}
