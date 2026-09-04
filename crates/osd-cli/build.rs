// Compile the web client into the binary.
//
// `osd server` has to serve the SAME frontend the desktop does, on a machine
// that has nothing else installed, so the built `dist/` is embedded rather than
// read from disk at runtime. A build without `dist/` still works — it just says
// so when someone opens `/` — because `cargo test` must not require a frontend
// build first.
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let dist = manifest.join("../../apps/desktop/dist");
    println!("cargo:rerun-if-changed={}", dist.display());

    let mut files = Vec::new();
    collect(&dist, &dist, &mut files);
    files.sort();

    let mut out = String::from(
        "/// Every file of the embedded web client: (path relative to the site root, bytes).\n\
         pub static ASSETS: &[(&str, &[u8])] = &[\n",
    );
    for (rel, abs) in &files {
        writeln!(out, "    ({rel:?}, include_bytes!({abs:?})),").expect("write to a String");
    }
    out.push_str("];\n");

    if files.is_empty() {
        println!(
            "cargo:warning=no web client embedded ({} is missing — run `pnpm build` first)",
            dist.display()
        );
    }
    let dest = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("assets.rs");
    std::fs::write(dest, out).expect("write the asset table");
}

/// Every file under `dir`, as (site-root-relative path with `/` separators,
/// absolute path). Forward slashes on both: `include_bytes!` accepts them on
/// Windows, and the relative form is what an HTTP request asks for.
fn collect(root: &Path, dir: &Path, out: &mut Vec<(String, String)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect(root, &path, out);
        } else if let Ok(rel) = path.strip_prefix(root) {
            out.push((
                rel.to_string_lossy().replace('\\', "/"),
                path.to_string_lossy().replace('\\', "/"),
            ));
        }
    }
}
