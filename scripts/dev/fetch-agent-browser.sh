#!/usr/bin/env bash
# Fetch the pinned agent-browser binary and its version-matched official skill.
# The binary becomes a Tauri sidecar; the skill is bundled as an app resource.
# Runs per-platform locally and in CI so the binary never lives in git.
# agent-browser ships raw (unarchived) binaries per platform on its releases.
set -euo pipefail

AGENT_BROWSER_VERSION="${AGENT_BROWSER_VERSION:-0.32.1}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="$ROOT/apps/desktop/src-tauri/binaries"
mkdir -p "$OUT_DIR"

# Resolve the Rust target triple (arg 1 overrides; else host).
TRIPLE="${1:-$(rustc -Vv | sed -n 's/host: //p')}"

case "$TRIPLE" in
  aarch64-apple-darwin)         ASSET="agent-browser-darwin-arm64" ;;
  x86_64-apple-darwin)          ASSET="agent-browser-darwin-x64" ;;
  x86_64-pc-windows-msvc)       ASSET="agent-browser-win32-x64.exe" ;;
  x86_64-unknown-linux-gnu)     ASSET="agent-browser-linux-x64" ;;
  aarch64-unknown-linux-gnu)    ASSET="agent-browser-linux-arm64" ;;
  *) echo "Unsupported triple for agent-browser: $TRIPLE" >&2; exit 1 ;;
esac

URL="https://github.com/vercel-labs/agent-browser/releases/download/v${AGENT_BROWSER_VERSION}/${ASSET}"
case "$TRIPLE" in
  *windows*) DEST="$OUT_DIR/agent-browser-$TRIPLE.exe" ;;
  *)         DEST="$OUT_DIR/agent-browser-$TRIPLE" ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "Downloading $URL"
TMP_BIN="$TMP/agent-browser"
curl -fsSL "$URL" -o "$TMP_BIN"
chmod +x "$TMP_BIN"
mv "$TMP_BIN" "$DEST"
echo "Placed sidecar for $TRIPLE at $DEST"

# The raw release binary does not carry the repository's skill-data directory,
# so `agent-browser skills get core` cannot find its official guide by itself.
# Fetch the exact same tag, then turn the official `core` skill into one
# OpenCode-visible skill with a small transport/lifecycle adapter prepended.
# Everything after that adapter remains upstream-owned and version-matched.
SKILLS_OUT="$ROOT/runtime/skills/external/agent-browser"
SKILL_OUT="$SKILLS_OUT/open-science-browser"
ARCHIVE_URL="https://github.com/vercel-labs/agent-browser/archive/refs/tags/v${AGENT_BROWSER_VERSION}.tar.gz"
echo "Downloading $ARCHIVE_URL"
curl -fsSL "$ARCHIVE_URL" -o "$TMP/agent-browser.tar.gz"
tar -xzf "$TMP/agent-browser.tar.gz" -C "$TMP"

SRC="$TMP/agent-browser-${AGENT_BROWSER_VERSION}"
[ -f "$SRC/skill-data/core/SKILL.md" ] || {
  echo "No official skill-data/core/SKILL.md in agent-browser v$AGENT_BROWSER_VERSION" >&2
  exit 1
}
[ -f "$SRC/skill-data/core/references/session-management.md" ] || {
  echo "Official agent-browser skill is missing session-management.md" >&2
  exit 1
}

rm -rf "$SKILLS_OUT"
mkdir -p "$SKILL_OUT"
cp -R "$SRC/skill-data/core/." "$SKILL_OUT/"
cp "$SRC/LICENSE" "$SKILL_OUT/LICENSE.txt"

# OpenCode requires the frontmatter name to match its directory. The adapter
# maps upstream's CLI-oriented examples onto the already-configured MCP tools
# and explains the app-enforced conversation lease and ownership boundary.
awk '
  NR == 1 && $0 == "---" { frontmatter = 1 }
  frontmatter == 1 && $0 == "name: core" {
    print "name: open-science-browser"
    next
  }
  frontmatter == 1 && $0 ~ /^description:/ {
    print "description: Official version-matched agent-browser guide for Open Science Desktop. Use this skill for browser navigation, interaction, extraction, screenshots, tabs, forms, and authentication in this app; do not use the unrelated browser-control skill."
    next
  }
  {
    print
    if (frontmatter == 1 && NR > 1 && $0 == "---") {
      print ""
      print "## Open Science Desktop MCP adapter"
      print ""
      print "When Browser Control is enabled in Settings, this app provides the version-matched `open-science-browser` MCP server. Apply the official workflow below through its `agent_browser_*` MCP tools."
      print ""
      print "- Never install, upgrade, or run `agent-browser` through Bash. Do not load a user skill named `browser-control`; it belongs to a different integration."
      print "- If the `agent_browser_*` tools are unavailable, ask the user to enable Browser Control in Settings; do not fall back to the CLI."
      print "- Before the first browser action, call `agent_browser_inventory`. It reports this conversation's browser and tabs, whether to open or reuse them, and only aggregate counts for other conversations."
      print "- A browser lease is assigned automatically from the current conversation. Never pass `session`, `namespace`, restore fields, `extraArgs`, `headed`, or `webgpu`; the MCP boundary does not expose them."
      print "- Never pass the per-call `allowedDomains` argument. The app owns domain policy through Settings; upstream rejects `allowedDomains` when a Chrome profile is active."
      print "- Browsers opened by the user outside Open Science Desktop are external resources: never attach to, inspect, navigate, or close them. Other conversations' managed browsers are equally off-limits."
      print "- If inventory shows a current browser, reuse a suitable current tab. Otherwise open the target URL directly. Never call `open` without a URL; never create a tab merely to test availability."
      print "- For multiple sequential URLs, call `open(url)` on the reusable current tab. Use `tab_new` only when the task genuinely requires concurrent pages or the user asks for them."
      print "- Before the final answer, close this conversation's browser unless the user explicitly asks to keep it open for a handoff. Never request close-all. Idle timeout and app exit reclaim abandoned app-managed leases."
      frontmatter = 2
    }
  }
' "$SRC/skill-data/core/SKILL.md" > "$SKILL_OUT/SKILL.md"

printf '%s\n' "$AGENT_BROWSER_VERSION" > "$SKILLS_OUT/.version"
grep -q '^name: open-science-browser$' "$SKILL_OUT/SKILL.md"
grep -q '^## Open Science Desktop MCP adapter$' "$SKILL_OUT/SKILL.md"
echo "Placed official agent-browser skill v$AGENT_BROWSER_VERSION at $SKILL_OUT"
