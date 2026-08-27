#!/usr/bin/env bash
# Package `osd` — the headless server and CLI — as a self-contained directory.
#
#   scripts/release/package-osd.sh <rust-target> [output-dir]
#
# The result unpacks and runs on a machine with nothing else installed, which is
# the whole point: a compute node has no desktop app to borrow resources from.
# It carries the same sidecars and the same bundled resources the installer
# ships, laid out the way `Env::headless` looks for them:
#
#   osd-<version>-<target>/
#     osd                 the binary (web client compiled in)
#     opencode            the agent runtime
#     uv                  Python environment provisioning
#     agent-browser       browser tooling
#     resources/…         skills, plugins, agent prompts, examples
#
# Run it AFTER the frontend is built (`pnpm build`) — otherwise `osd` embeds no
# web client and only serves /v1.
set -euo pipefail

target="${1:?usage: package-osd.sh <rust-target> [output-dir]}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out_dir="${2:-$root/dist-osd}"
# A RELATIVE path on purpose: under Git Bash (which is what the Windows CI leg
# runs), `$root` is a POSIX path like /d/a/repo, and MSYS only translates those
# when they are whole arguments — inside a JS string it reaches node unchanged
# and `require` fails. Measured on Windows 11: the absolute form errors, the
# relative form returns the version.
version="$(cd "$root" && node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version")"

ext=""
case "$target" in *windows*) ext=".exe" ;; esac

stage="$out_dir/osd-$version-$target"
rm -rf "$stage"
mkdir -p "$stage/resources"

echo "Building osd for ${target}..."
cargo build --release --target "$target" --package osd-cli --manifest-path "$root/Cargo.toml"
cp "$root/target/$target/release/osd$ext" "$stage/osd$ext"

# The sidecars, under the plain names `sidecar_bin()` looks for next to the
# executable (Tauri strips the target triple the same way when it bundles).
for name in opencode uv agent-browser; do
  src="$root/apps/desktop/src-tauri/binaries/$name-$target$ext"
  if [ ! -e "$src" ]; then
    echo "Missing sidecar: $src (run scripts/dev/fetch-$name.sh $target)" >&2
    exit 1
  fi
  cp "$src" "$stage/$name$ext"
  chmod +x "$stage/$name$ext"
done

# The bundled resources, under the names `Env::resource` asks for. This list
# MUST match `bundle.resources` in tauri.conf.json — the two hosts deploy the
# same profile, and a resource in one and not the other means the agent behaves
# differently depending on which door you came in by.
copy_resource() {
  local src="$root/$1" dst="$stage/resources/$2"
  if [ ! -e "$src" ]; then
    echo "Missing bundled resource: $1" >&2
    return 1
  fi
  mkdir -p "$(dirname "$dst")"
  cp -R "$src" "$dst"
}

copy_resource runtime/goal-plugin goal-plugin
copy_resource runtime/browser-plugin browser-plugin
copy_resource runtime/history-plugin history-plugin
copy_resource runtime/tools tools
copy_resource runtime/skills/external/ai4s-skills skills
copy_resource runtime/skills/external/anthropic-skills skills-office
copy_resource runtime/skills/external/agent-browser skills-agent-browser
copy_resource runtime/skills/core skills-core
copy_resource runtime/opencode-profile/agent profile/agent
copy_resource runtime/opencode-profile/command profile/command
copy_resource runtime/harness harness
copy_resource runtime/acp-server acp-server
copy_resource examples/climate-trends examples/climate-trends

cat > "$stage/README.txt" <<'EOF'
Open Science Desktop — headless (osd)

Nothing to install: this directory runs as it is, on a server with no packages
added (checked on a bare Ubuntu container).

  ./osd server                 serve the workbench here (web UI + API)
  ./osd server --lan           also reachable from the network
  ./osd --help                 everything else

The web UI is the same one the desktop app runs. Open the URL it prints,
including the ?token=... it gives you.

Set the machine up before starting a server:

  ./osd auth set anthropic --key <api-key>      credentials, LOCAL to this box
  ./osd auth set openai --key <k> --base-url <url>   a self-hosted endpoint
  ./osd model set anthropic/claude-opus-4-5     the default for every turn
  ./osd model ls                                what this machine can serve
  ./osd approval                                what the agent must ask first

Or export the provider's API key before starting the server; the agent runtime
inherits this process's environment, so no key has to touch a file.

Approvals: the agent asks before running commands, deleting files, installing
dependencies or reaching the network. `--wait` prints what is waiting, and you
answer with `./osd permission allow <id>` or in the browser at the URL it shows.
For a machine with nobody watching, `./osd approval set full` never asks.

As a service, systemd runs `osd server` unchanged, and stopping the unit takes
the agent runtime with it. A unit that was tested end to end:

  [Unit]
  Description=Open Science Desktop (headless)
  After=network-online.target
  [Service]
  Type=simple
  User=ubuntu
  Environment=HOME=/home/ubuntu
  ExecStart=/opt/osd/osd server --port 4788
  Restart=on-failure
  RestartSec=3
  [Install]
  WantedBy=multi-user.target

macOS: files from a downloaded archive are quarantined. If macOS refuses to
run them, clear it once with:  xattr -dr com.apple.quarantine .
EOF

archive="$out_dir/osd-$version-$target"
case "$target" in
  *windows*)
    # GitHub's Windows runners ship 7-Zip and PowerShell but NOT `zip`, so this
    # takes whichever is actually there rather than assuming.
    if command -v zip > /dev/null 2>&1; then
      (cd "$out_dir" && zip -qr "$(basename "$archive").zip" "$(basename "$stage")")
    elif command -v 7z > /dev/null 2>&1; then
      (cd "$out_dir" && 7z a -bso0 -bsp0 "$(basename "$archive").zip" "$(basename "$stage")" > /dev/null)
    else
      # PowerShell cannot resolve a POSIX path either (measured: Compress-Archive
      # with /c/... silently produces nothing), so hand it Windows paths.
      src="$stage"
      dst="$archive.zip"
      if command -v cygpath > /dev/null 2>&1; then
        src="$(cygpath -w "$stage")"
        dst="$(cygpath -w "$archive.zip")"
      fi
      powershell.exe -NoProfile -NonInteractive -Command \
        "Compress-Archive -Path '$src' -DestinationPath '$dst' -Force"
    fi
    [ -f "$archive.zip" ] || { echo "could not create $archive.zip" >&2; exit 1; }
    echo "$archive.zip"
    ;;
  *)
    tar -czf "$archive.tar.gz" -C "$out_dir" "$(basename "$stage")"
    echo "$archive.tar.gz"
    ;;
esac
