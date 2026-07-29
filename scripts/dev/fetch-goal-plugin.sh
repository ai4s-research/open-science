#!/usr/bin/env bash
# Fetch + bundle the pinned OpenCode goal plugin into runtime/goal-plugin/
# (git-ignored; bundled into the installer as a Tauri resource).
#
# The plugin ships on npm with heavy runtime deps (effect ~46 MB, native
# msgpackr); esbuild tree-shakes it into ONE self-contained ESM file that the
# sidecar loads via a file:// plugin spec — opencode 1.17 cannot install npm
# plugin specs itself, and the app must not fetch from npm at run time.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

GOAL_PLUGIN_VERSION="${GOAL_PLUGIN_VERSION:-0.1.24}"
OPENCODE_PLUGIN_VERSION="${OPENCODE_PLUGIN_VERSION:-1.17.13}"
PKG="@prevalentware/opencode-goal-plugin"
OUT_DIR="$ROOT/runtime/goal-plugin"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "Packing ${PKG}@${GOAL_PLUGIN_VERSION}"
(cd "$TMP" && npm pack --silent "${PKG}@${GOAL_PLUGIN_VERSION}" > /dev/null)
tar -xzf "$TMP"/*.tgz -C "$TMP"

# Install runtime deps next to the entry so esbuild can resolve them.
(cd "$TMP/package" && npm install --silent --no-fund --no-audit --omit=dev --ignore-scripts effect zod > /dev/null)

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
# Give npm an explicit project boundary. Installing from an empty directory
# otherwise walks up to the monorepo root and mutates (or fails against) it.
(cd "$OUT_DIR" && npm init --yes --silent > /dev/null)
ESBUILD_VERSION="0.24.2"
npm exec --yes --package="esbuild@${ESBUILD_VERSION}" -- esbuild "$TMP/package/dist/server.js" \
  --bundle --format=esm --platform=node \
  --external:@opencode-ai/plugin \
  --outfile="$OUT_DIR/goal-plugin.server.js" \
  --log-level=warning
cp "$TMP/package/LICENSE" "$OUT_DIR/LICENSE"
echo "$GOAL_PLUGIN_VERSION" > "$OUT_DIR/.version"

# OpenCode waits for @opencode-ai/plugin before loading any configured plugin.
# Without a local copy, the first /event connection performs a live npm install
# and an unreachable registry leaves the desktop on "Connecting" for minutes.
# This script runs on every release target, so optional native packages match
# that platform.
(cd "$OUT_DIR" && npm install --silent --no-fund --no-audit --omit=dev --ignore-scripts \
  --save-exact "@opencode-ai/plugin@${OPENCODE_PLUGIN_VERSION}" > /dev/null)
echo "$OPENCODE_PLUGIN_VERSION" > "$OUT_DIR/.opencode-plugin-version"

echo "Placed ${PKG}@${GOAL_PLUGIN_VERSION} in $OUT_DIR:"
du -sh "$OUT_DIR"
