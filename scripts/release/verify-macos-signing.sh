#!/usr/bin/env bash
set -euo pipefail

app_path=${1:-}
if [[ -z "$app_path" || ! -d "$app_path" ]]; then
  echo "macOS app bundle not found: ${app_path:-<empty>}" >&2
  exit 1
fi

signature_info() {
  /usr/bin/codesign --display --verbose=4 "$1" 2>&1
}

verify_developer_id() {
  local path=$1
  local expected_team=$2
  local info
  local team
  info=$(signature_info "$path")
  team=$(printf '%s\n' "$info" | sed -n 's/^TeamIdentifier=//p' | head -n 1)
  if ! grep -q '^Authority=Developer ID Application:' <<<"$info"; then
    echo "not Developer ID-signed: $path" >&2
    exit 1
  fi
  if [[ -z "$team" || "$team" == "not set" || "$team" != "$expected_team" ]]; then
    echo "unexpected TeamIdentifier for $path: ${team:-<empty>}" >&2
    exit 1
  fi
}

/usr/bin/codesign --verify --deep --strict --verbose=2 "$app_path"
app_team=$(signature_info "$app_path" | sed -n 's/^TeamIdentifier=//p' | head -n 1)
if [[ -z "$app_team" || "$app_team" == "not set" ]]; then
  echo "app bundle has no stable Developer ID team identity" >&2
  exit 1
fi
verify_developer_id "$app_path" "$app_team"

for sidecar in opencode uv agent-browser; do
  sidecar_path="$app_path/Contents/MacOS/$sidecar"
  if [[ ! -x "$sidecar_path" ]]; then
    echo "missing executable sidecar: $sidecar_path" >&2
    exit 1
  fi
  /usr/bin/codesign --verify --strict --verbose=2 "$sidecar_path"
  verify_developer_id "$sidecar_path" "$app_team"
done

/usr/sbin/spctl --assess --type execute --verbose=2 "$app_path"
