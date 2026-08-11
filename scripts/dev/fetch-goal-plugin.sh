#!/usr/bin/env bash
# Fetch + bundle the pinned OpenCode goal plugin into runtime/goal-plugin/
# (git-ignored; bundled into the installer as a Tauri resource).
#
# The goal plugin itself is tree-shaken into one ESM file. OpenCode also needs
# its plugin SDK installed beside the configured plugin before `/event` opens;
# the app ships that dependency so first launch never waits on npm.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

GOAL_PLUGIN_VERSION="${GOAL_PLUGIN_VERSION:-0.1.24}"
OPENCODE_PLUGIN_VERSION="${OPENCODE_PLUGIN_VERSION:-1.18.12}"
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
(
  cd "$OUT_DIR"
  npm init --yes > /dev/null
  npm install --silent --no-fund --no-audit --omit=dev --omit=optional --ignore-scripts \
    "@opencode-ai/plugin@${OPENCODE_PLUGIN_VERSION}" > /dev/null
)
echo "$OPENCODE_PLUGIN_VERSION" > "$OUT_DIR/.opencode-plugin-version"

# npm packages include source, declarations, source maps and documentation that
# are useful to developers but never loaded at runtime. Keep every production
# module and license while removing only those non-runtime files. This preserves
# the complete non-TUI plugin SDK rather than replacing it with a partial shim.
for source_dir in \
  "$OUT_DIR/node_modules/effect/src" \
  "$OUT_DIR/node_modules/zod/src"; do
  if [ -d "$source_dir" ]; then
    find "$source_dir" -depth -delete
  fi
done
find "$OUT_DIR/node_modules" -type f \( \
  -name '*.map' -o \
  -name '*.d.ts' -o \
  -name '*.d.cts' -o \
  -name '*.d.mts' -o \
  -name '*.md' \
\) ! -iname 'license*' ! -iname 'copying*' -delete
find "$OUT_DIR/node_modules" -depth -type d -empty -delete

# Fail the build if pruning breaks an official runtime entry or if a dependency
# bump silently restores the 60 MB tree. TUI is excluded because its peer
# dependencies are intentionally optional and are not part of the desktop.
(
  cd "$OUT_DIR"
  PLUGIN_DEPENDENCY_LIMIT_BYTES=$((24 * 1024 * 1024)) node --input-type=module <<'NODE'
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const entries = [
  "@opencode-ai/plugin",
  "@opencode-ai/plugin/tool",
  "@opencode-ai/plugin/v2/effect",
  "@opencode-ai/plugin/v2/effect/integration",
  "@opencode-ai/plugin/v2/effect/plugin",
  "@opencode-ai/plugin/v2/promise",
];
for (const entry of entries) await import(entry);

const { tool } = await import("@opencode-ai/plugin");
if (tool.schema.string().parse("ok") !== "ok") {
  throw new Error("OpenCode plugin schema validation failed");
}

async function directorySize(path) {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? await directorySize(child) : (await stat(child)).size;
  }
  return total;
}

const bytes = await directorySize("node_modules");
const limit = Number(process.env.PLUGIN_DEPENDENCY_LIMIT_BYTES);
if (bytes > limit) {
  throw new Error(`OpenCode plugin dependencies are ${(bytes / 1048576).toFixed(1)} MiB; limit is ${(limit / 1048576).toFixed(0)} MiB`);
}
console.log(`Verified OpenCode plugin runtime: ${(bytes / 1048576).toFixed(1)} MiB`);
NODE
)

echo "Placed ${PKG}@${GOAL_PLUGIN_VERSION} in $OUT_DIR:"
du -sh "$OUT_DIR"
