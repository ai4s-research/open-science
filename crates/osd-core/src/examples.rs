// Built-in example projects (P0-1 / P1-1): real, small datasets bundled as
// resources and copied into the workspace on demand, so the agent runs a
// genuine analysis on genuine data — including a non-bio one (climate-trends).
use std::path::Path;

use crate::env::Env;
use crate::runtime::workspace_dir;

/// Bundled example projects; the command rejects anything else.
const EXAMPLES: &[&str] = &["climate-trends"];

/// Copy `src` into `dst` recursively WITHOUT overwriting existing files — a
/// re-installed example must never clobber the user's edited copy.
pub fn copy_missing(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_missing(&entry.path(), &to)?;
        } else if !to.exists() {
            std::fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

/// Copy a bundled example project into the workspace (idempotent, never
/// overwrites) and return its workspace-relative directory name.
pub fn install_example(env: &Env, name: String) -> Result<String, String> {
    if !EXAMPLES.contains(&name.as_str()) {
        return Err(format!("unknown example: {name}"));
    }
    let src = env
        .resource(&format!("examples/{name}"))
        .filter(|p| p.is_dir())
        .ok_or_else(|| "example not bundled in this build".to_string())?;
    let dst = workspace_dir(env)?.join(&name);
    copy_missing(&src, &dst).map_err(|e| format!("example install failed: {e}"))?;
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::copy_missing;

    #[test]
    fn copies_recursively_but_never_overwrites() {
        let base = std::env::temp_dir().join(format!("ai4s-example-{}", std::process::id()));
        let src = base.join("src");
        let dst = base.join("dst");
        std::fs::create_dir_all(src.join("data")).unwrap();
        std::fs::write(src.join("README.md"), "bundled readme").unwrap();
        std::fs::write(src.join("data/x.csv"), "a,b\n1,2\n").unwrap();

        copy_missing(&src, &dst).unwrap();
        assert_eq!(std::fs::read_to_string(dst.join("data/x.csv")).unwrap(), "a,b\n1,2\n");

        // The user edits a file; re-installing must keep the edit.
        std::fs::write(dst.join("README.md"), "user edited").unwrap();
        copy_missing(&src, &dst).unwrap();
        assert_eq!(std::fs::read_to_string(dst.join("README.md")).unwrap(), "user edited");

        let _ = std::fs::remove_dir_all(base);
    }
}
