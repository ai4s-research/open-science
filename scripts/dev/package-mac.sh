#!/usr/bin/env bash
# Build a local macOS test DMG the same way CI does, from any checkout or worktree.
#
#   scripts/dev/package-mac.sh [rust-target]     (default: aarch64-apple-darwin)
#
# The sidecars and external skills are gitignored, so a checkout only has
# whatever was fetched into it last, possibly an old pin. Copying them from
# another checkout shipped OpenCode 1.19.4 against an app that speaks OpenCode 2,
# and every model selection failed with a 500. So this script brings every
# sidecar to its pin (fetching only the ones that differ), builds the osd
# sidecar and the DMG, then checks the sidecars inside the app against their
# pins before printing the DMG path.
set -euo pipefail

target="${1:-aarch64-apple-darwin}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"
cd "$root"
bin="apps/desktop/src-tauri/binaries"

# The version a fetch script pins: its NAME="${NAME:-x.y.z}" line.
pin() {
  local v
  v="$(sed -n "s/^$1=\"\\\${$1:-\(.*\)}\"\$/\1/p" "scripts/dev/$2")"
  [ -n "$v" ] || { echo "Cannot read $1 from scripts/dev/$2" >&2; exit 1; }
  echo "$v"
}

# What a binary reports as its version, bare: "opencode v2.2.5" -> 2.2.5,
# "uv 0.11.26 (abc 2026-01-01)" -> 0.11.26, "agent-browser 0.32.1" -> 0.32.1.
version_of() {
  [ -x "$1" ] || return 0
  "$1" --version 2>/dev/null | head -1 | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /^v?[0-9]+\.[0-9]/) { sub(/^v/, "", $i); print $i; exit } }'
}

# GitHub release downloads through the local proxy sometimes answer 504.
retry() {
  local n
  for n in 1 2 3; do
    "$@" && return 0
    echo "Attempt $n failed: $*" >&2
    sleep $((n * 5))
  done
  return 1
}

opencode_pin="$(pin OPENCODE_VERSION fetch-opencode.sh)"
uv_pin="$(pin UV_VERSION fetch-uv.sh)"
browser_pin="$(pin AGENT_BROWSER_VERSION fetch-agent-browser.sh)"

# sidecar-name pin fetch-script
ensure() {
  local have
  have="$(version_of "$bin/$1-$target")"
  if [ "$have" = "$2" ]; then
    echo "$1 $have matches the pin"
  else
    echo "$1 is '${have:-missing}', the pin is $2: fetching"
    retry bash "scripts/dev/$3" "$target"
  fi
}

echo "== Bringing sidecars and skills to their pins"
ensure opencode "$opencode_pin" fetch-opencode.sh
ensure uv "$uv_pin" fetch-uv.sh
ensure agent-browser "$browser_pin" fetch-agent-browser.sh
retry bash scripts/dev/fetch-skills.sh
bash scripts/dev/build-osd-sidecar.sh "$target"

echo "== Releasing DMG volumes left by earlier builds of this checkout"
hdiutil info | awk -v t="$root/target/" '
  /^image-path/ { img = substr($0, index($0, ":") + 2) }
  /^\/dev\/disk/ && $NF ~ /^\/Volumes\// && index(img, t) == 1 { print $1 }
' | sort -u | while read -r dev; do hdiutil detach "$dev" -force || true; done
rm -f "$root"/target/"$target"/release/bundle/macos/rw.*.dmg

echo "== Building the DMG"
(cd apps/desktop && pnpm tauri build --target "$target" --bundles dmg)

# Check the DMG itself (tauri removes the intermediate .app once the DMG is made).
dmg="$(ls -t "$root/target/$target/release/bundle/dmg/"*.dmg | head -1)"
mnt="$(mktemp -d)"
hdiutil attach -nobrowse -readonly -mountpoint "$mnt" "$dmg" >/dev/null
trap 'hdiutil detach "$mnt" -force >/dev/null 2>&1 || true' EXIT
macos="$mnt/Open Science.app/Contents/MacOS"
for pair in "opencode $opencode_pin" "uv $uv_pin" "agent-browser $browser_pin"; do
  set -- $pair
  inside="$(version_of "$macos/$1")"
  if [ "$inside" != "$2" ]; then
    echo "The DMG carries $1 '${inside:-missing}', the pin is $2. Do not ship it." >&2
    exit 1
  fi
done

echo "== OK: opencode $opencode_pin, uv $uv_pin, agent-browser $browser_pin inside the app"
echo "$dmg"
