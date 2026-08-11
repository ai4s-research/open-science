#!/usr/bin/env bash
set -euo pipefail

app_path=${1:-}
dmg_path=${2:-}
timeout_seconds=${MACOS_NOTARIZATION_TIMEOUT_SECONDS:-5400}
poll_seconds=${MACOS_NOTARIZATION_POLL_SECONDS:-60}
dmg_notarization_mode=${MACOS_DMG_NOTARIZATION_MODE:-wait}
notarytool_profile=${MACOS_NOTARYTOOL_PROFILE:-}

if [[ -z "$app_path" || ! -d "$app_path" ]]; then
  echo "macOS app bundle not found: ${app_path:-<empty>}" >&2
  exit 1
fi
if [[ -z "$dmg_path" ]]; then
  echo "output DMG path is required" >&2
  exit 1
fi
if [[ ! "$timeout_seconds" =~ ^[0-9]+$ || "$timeout_seconds" -eq 0 ]]; then
  echo "MACOS_NOTARIZATION_TIMEOUT_SECONDS must be a positive integer" >&2
  exit 1
fi
if [[ ! "$poll_seconds" =~ ^[0-9]+$ || "$poll_seconds" -eq 0 ]]; then
  echo "MACOS_NOTARIZATION_POLL_SECONDS must be a positive integer" >&2
  exit 1
fi
if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  echo "APPLE_SIGNING_IDENTITY is required to sign the DMG" >&2
  exit 1
fi
if [[ "$dmg_notarization_mode" != "wait" && "$dmg_notarization_mode" != "submit" ]]; then
  echo "MACOS_DMG_NOTARIZATION_MODE must be wait or submit" >&2
  exit 1
fi

notarytool_args=()
if [[ -n "$notarytool_profile" ]]; then
  notarytool_args=(--keychain-profile "$notarytool_profile")
elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
  notarytool_args=(
    --apple-id "$APPLE_ID"
    --password "$APPLE_PASSWORD"
    --team-id "$APPLE_TEAM_ID"
  )
else
  echo "Apple notarization credentials or MACOS_NOTARYTOOL_PROFILE are required" >&2
  exit 1
fi

show_notary_history() {
  xcrun notarytool history "${notarytool_args[@]}" || true
}

wait_for_ticket() {
  local target_path=$1
  local target_name=$2
  local deadline=$((SECONDS + timeout_seconds))
  local attempt=1
  local staple_output

  while true; do
    if xcrun stapler validate "$target_path" >/dev/null 2>&1; then
      echo "Apple notarization ticket is already stapled to $target_name."
      return 0
    fi

    echo "Checking the Apple notarization ticket for $target_name (attempt $attempt)..."
    if staple_output=$(xcrun stapler staple "$target_path" 2>&1); then
      printf '%s\n' "$staple_output"
      return 0
    fi

    if (( SECONDS >= deadline )); then
      printf '%s\n' "$staple_output" >&2
      echo "Apple notarization for $target_name did not finish within ${timeout_seconds}s." >&2
      show_notary_history
      return 1
    fi

    echo "Ticket is not ready; retrying in ${poll_seconds}s."
    sleep "$poll_seconds"
    attempt=$((attempt + 1))
  done
}

wait_for_ticket "$app_path" "app"
xcrun stapler validate "$app_path"
bash "$(dirname "$0")/verify-macos-signing.sh" "$app_path"

work_dir=$(mktemp -d)
mount_dir="$work_dir/mount"
staging_dir="$work_dir/staging"
attached=false
signing_keychain=
original_keychains=
cleanup() {
  if [[ "$attached" == true ]]; then
    hdiutil detach "$mount_dir" -quiet || true
  fi
  if [[ -n "$signing_keychain" ]]; then
    if [[ -n "$original_keychains" ]]; then
      # shellcheck disable=SC2086
      security list-keychains -d user -s $original_keychains || true
    fi
    security delete-keychain "$signing_keychain" || true
  fi
  rm -rf "$work_dir"
}
trap cleanup EXIT

mkdir -p "$mount_dir" "$staging_dir" "$(dirname "$dmg_path")"
ditto "$app_path" "$staging_dir/$(basename "$app_path")"
ln -s /Applications "$staging_dir/Applications"

rm -f "$dmg_path"
hdiutil create \
  -volname "Open Science" \
  -srcfolder "$staging_dir" \
  -format UDZO \
  -ov \
  "$dmg_path"

codesign_args=(
  --force
  --timestamp
  --sign "$APPLE_SIGNING_IDENTITY"
)
if [[ -n "${APPLE_CERTIFICATE:-}" && -n "${APPLE_CERTIFICATE_PASSWORD:-}" ]]; then
  certificate_path="$work_dir/certificate.p12"
  signing_keychain="$work_dir/signing.keychain-db"
  keychain_password=$(uuidgen)
  original_keychains=$(security list-keychains -d user | tr -d '"')

  printf '%s' "$APPLE_CERTIFICATE" | base64 --decode > "$certificate_path"
  security create-keychain -p "$keychain_password" "$signing_keychain"
  security unlock-keychain -p "$keychain_password" "$signing_keychain"
  security import "$certificate_path" \
    -k "$signing_keychain" \
    -P "$APPLE_CERTIFICATE_PASSWORD" \
    -T /usr/bin/codesign
  security set-keychain-settings -t 3600 -u "$signing_keychain"
  security set-key-partition-list \
    -S apple-tool:,apple:,codesign: \
    -s \
    -k "$keychain_password" \
    "$signing_keychain"
  # shellcheck disable=SC2086
  security list-keychains -d user -s "$signing_keychain" $original_keychains
  codesign_args+=(--keychain "$signing_keychain")
fi

codesign "${codesign_args[@]}" "$dmg_path"
codesign --verify --strict --verbose=2 "$dmg_path"
hdiutil verify "$dmg_path"

hdiutil attach "$dmg_path" -nobrowse -readonly -mountpoint "$mount_dir" -quiet
attached=true
bash "$(dirname "$0")/verify-macos-signing.sh" "$mount_dir/$(basename "$app_path")"
hdiutil detach "$mount_dir" -quiet
attached=false

submission_output=$(xcrun notarytool submit \
  "$dmg_path" \
  "${notarytool_args[@]}" \
  --output-format json)
printf '%s\n' "$submission_output"

if [[ "$dmg_notarization_mode" == "submit" ]]; then
  echo "Submitted signed DMG for asynchronous notarization: $dmg_path"
  exit 0
fi

wait_for_ticket "$dmg_path" "DMG"
xcrun stapler validate "$dmg_path"
/usr/sbin/spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg_path"

echo "Finalized notarized macOS installer: $dmg_path"
