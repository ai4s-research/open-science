#!/usr/bin/env bash
# Fetch the pinned OpenCode binary and place it as a Tauri sidecar
# (apps/desktop/src-tauri/binaries/opencode-<target-triple>).
# Runs per-platform locally and in CI so the binary never lives in git.
set -euo pipefail

OPENCODE_VERSION="${OPENCODE_VERSION:-1.18.12}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="$ROOT/apps/desktop/src-tauri/binaries"
mkdir -p "$OUT_DIR"

# Resolve the Rust target triple (arg 1 overrides; else host).
TRIPLE="${1:-$(rustc -Vv | sed -n 's/host: //p')}"

case "$TRIPLE" in
  aarch64-apple-darwin)         ASSET="opencode-darwin-arm64.zip" ;;
  x86_64-apple-darwin)          ASSET="opencode-darwin-x64.zip" ;;
  x86_64-pc-windows-msvc)       ASSET="opencode-windows-x64.zip" ;;
  aarch64-pc-windows-msvc)      ASSET="opencode-windows-arm64.zip" ;;
  x86_64-unknown-linux-gnu)     ASSET="opencode-linux-x64.tar.gz" ;;
  aarch64-unknown-linux-gnu)    ASSET="opencode-linux-arm64.tar.gz" ;;
  *) echo "Unsupported triple: $TRIPLE" >&2; exit 1 ;;
esac

URL="https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/${ASSET}"
TMP="$(mktemp -d)"
echo "Downloading $URL"
curl -fsSL "$URL" -o "$TMP/$ASSET"
case "$ASSET" in
  *.tar.gz) tar -xzf "$TMP/$ASSET" -C "$TMP" ;;
  *)
    if command -v unzip >/dev/null 2>&1; then
      unzip -oq "$TMP/$ASSET" -d "$TMP"
    else
      tar -xf "$TMP/$ASSET" -C "$TMP"   # bsdtar (macOS/Windows) extracts zip
    fi
    ;;
esac

# The archive contains an `opencode` (or opencode.exe) binary.
if [ -f "$TMP/opencode.exe" ]; then
  cp "$TMP/opencode.exe" "$OUT_DIR/opencode-$TRIPLE.exe"
else
  BIN="$(find "$TMP" -type f -name opencode | head -1)"
  cp "$BIN" "$OUT_DIR/opencode-$TRIPLE"
  chmod +x "$OUT_DIR/opencode-$TRIPLE"
fi
rm -rf "$TMP"
echo "Placed sidecar for $TRIPLE in $OUT_DIR"
