#!/bin/sh
# Install Open Science Desktop on Linux for the current user — no root, no
# package manager, nothing outside $HOME.
#
#   curl -fsSL https://raw.githubusercontent.com/ai4s-research/open-science/master/scripts/install.sh | sh
#   curl -fsSL …/install.sh | sh -s -- --desktop     the desktop app as well
#   curl -fsSL …/install.sh | sh -s -- --uninstall
#
# Default: `osd`, the headless server and CLI (the same workbench and web UI,
# served over HTTP). `--desktop` installs the windowed app instead, which
# carries `osd` too; it needs the system's WebKitGTK 4.1, which this script
# cannot install without root, so it checks for it first.
#
# Layout:
#   ~/.local/share/open-science/osd/        the osd archive, unpacked
#   ~/.local/share/open-science/desktop/    the desktop app (usr/bin, usr/lib)
#   ~/.local/bin/osd                        a wrapper (not a symlink: osd finds
#                                           its sidecars next to its real path)
#   ~/.local/bin/open-science               the desktop app's launcher
#   ~/.local/share/applications/open-science.desktop
#
# Environment: OSD_VERSION=0.6.1 pins a release (default: latest).
#              OSD_DOWNLOAD_BASE overrides the release download URL (a mirror).
set -eu

REPO="ai4s-research/open-science"
# Shared with the desktop app's own wrapper (cli_shim.rs), so whichever wrote
# `osd` last, the other recognizes it as ours and may replace it.
SIGNATURE="Open Science Desktop CLI wrapper"

DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
PREFIX="$DATA/open-science"
BIN="$HOME/.local/bin"
DESKTOP_ENTRY="$DATA/applications/open-science.desktop"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

mode=cli
case "${1:-}" in
  "") ;;
  --desktop) mode=desktop ;;
  --uninstall) mode=uninstall ;;
  -h|--help) say "usage: install.sh [--desktop | --uninstall]"; exit 0 ;;
  *) die "unknown option: $1 (use --desktop or --uninstall)" ;;
esac

# Remove a file only when this project wrote it.
remove_ours() {
  if [ -f "$1" ] && grep -q "$SIGNATURE" "$1" 2>/dev/null; then
    rm -f "$1"
  fi
}

if [ "$mode" = uninstall ]; then
  rm -rf "$PREFIX"
  remove_ours "$BIN/osd"
  remove_ours "$BIN/open-science"
  remove_ours "$DESKTOP_ENTRY"
  say "Removed Open Science Desktop from $PREFIX."
  say "Your workspace (~/Documents/OpenScience) and settings were left in place."
  exit 0
fi

[ "$(uname -s)" = Linux ] || die "this installer is for Linux; get the macOS/Windows installer from https://github.com/$REPO/releases/latest"
command -v curl > /dev/null 2>&1 || die "curl is required"
command -v tar > /dev/null 2>&1 || die "tar is required"

case "$(uname -m)" in
  x86_64|amd64) target=x86_64-unknown-linux-gnu ;;
  aarch64|arm64) target=aarch64-unknown-linux-gnu ;;
  *) die "unsupported architecture: $(uname -m) (x86_64 and aarch64 only)" ;;
esac

# The latest version from the redirect of /releases/latest — no API call, so
# no rate limit.
version="${OSD_VERSION:-}"
if [ -z "$version" ]; then
  location=$(curl -fsSI "https://github.com/$REPO/releases/latest" | tr -d '\r' | sed -n 's/^[Ll]ocation: .*\/tag\/v\{0,1\}//p')
  version="$location"
  [ -n "$version" ] || die "could not determine the latest version (set OSD_VERSION=x.y.z)"
fi
version="${version#v}"
base="${OSD_DOWNLOAD_BASE:-https://github.com/$REPO/releases/download/v$version}"

if [ "$mode" = desktop ]; then
  archive="open-science-desktop-$version-$target.tar.gz"
else
  archive="osd-$version-$target.tar.gz"
fi

if [ "$mode" = desktop ]; then
  # Without root this script cannot add WebKitGTK, so say so before downloading
  # several hundred megabytes that would not start.
  if ! { /sbin/ldconfig -p 2>/dev/null || ldconfig -p 2>/dev/null; } | grep -q 'libwebkit2gtk-4\.1\.so\.0'; then
    die "the desktop app needs WebKitGTK 4.1 (libwebkit2gtk-4.1-0), which is not installed here.
Ask an administrator to install it, or run the workbench headless instead —
the same UI in your browser, nothing else required:
  curl -fsSL https://raw.githubusercontent.com/$REPO/master/scripts/install.sh | sh"
  fi
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading $archive…"
if ! curl -fL --progress-bar -o "$tmp/$archive" "$base/$archive"; then
  [ "$mode" = desktop ] && die "download failed: $base/$archive (releases up to 0.6.0 have no desktop archive)"
  die "download failed: $base/$archive"
fi
mkdir "$tmp/unpacked"
tar -xzf "$tmp/$archive" -C "$tmp/unpacked"

# Swap the new copy in only after it unpacked completely.
mkdir -p "$PREFIX"
if [ "$mode" = desktop ]; then
  dest="$PREFIX/desktop"
  osd_bin="$dest/usr/bin/osd"
else
  dest="$PREFIX/osd"
  osd_bin="$dest/osd"
fi
rm -rf "$dest"
mv "$tmp/unpacked/"* "$dest"
[ -x "$osd_bin" ] || die "the archive did not contain $osd_bin"

# Write a wrapper unless something that is not ours already has the name.
write_wrapper() {
  path="$1"
  binary="$2"
  if [ -e "$path" ] && ! grep -q "$SIGNATURE" "$path" 2>/dev/null; then
    say "warning: $path exists and is not ours; left it alone"
    return 0
  fi
  cat > "$path" <<EOF
#!/bin/sh
# $SIGNATURE. A wrapper, not a symlink: osd finds its sidecars and
# bundled resources next to the real executable.
if [ ! -x "$binary" ]; then
	echo "Open Science Desktop is no longer installed; removing this leftover command." >&2
	rm -f -- "\$0"
	exit 127
fi
exec "$binary" "\$@"
EOF
  chmod 755 "$path"
}

mkdir -p "$BIN"
write_wrapper "$BIN/osd" "$osd_bin"

if [ "$mode" = desktop ]; then
  app_bin="$dest/usr/bin/ai4s-workbench"
  [ -x "$app_bin" ] || die "the archive did not contain $app_bin"
  write_wrapper "$BIN/open-science" "$app_bin"
  mkdir -p "$(dirname "$DESKTOP_ENTRY")"
  cat > "$DESKTOP_ENTRY" <<EOF
[Desktop Entry]
# $SIGNATURE
Type=Application
Name=Open Science
Comment=Open Science Desktop
Exec="$app_bin"
Icon=$dest/usr/share/icons/hicolor/128x128/apps/ai4s-workbench.png
StartupWMClass=ai4s-workbench
Terminal=false
Categories=Science;Education;
EOF
fi

say ""
say "Installed Open Science Desktop $version ($mode) in $dest"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) say "Add $BIN to your PATH:  export PATH=\"$BIN:\$PATH\"" ;;
esac
if [ "$mode" = desktop ]; then
  say "Start it from your applications menu, or run:  open-science"
else
  say "Start it with:  osd server        (osd --help for everything else)"
fi
