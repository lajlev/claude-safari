#!/usr/bin/env bash
# Build a Developer ID-signed, notarized and stapled release of "Send to Claude"
# and package it as dist/Send-to-Claude-<version>.zip plus a .sha256 file.
#
#   scripts/release.sh 1.2.3            (or VERSION=1.2.3 scripts/release.sh)
#
# Signing: a "Developer ID Application" identity must be in a keychain on the
# search list. APPLE_TEAM_ID is read from the environment, or taken from the
# identity's name "(TEAMID)" when there is exactly one such identity.
#
# Notarization credentials, first match wins:
#   NOTARY_KEYCHAIN_PROFILE                      profile from `xcrun notarytool store-credentials`
#   ASC_KEY_PATH + ASC_KEY_ID + ASC_ISSUER_ID    App Store Connect API key (.p8), recommended
#   APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD       Apple ID (uses APPLE_TEAM_ID)
# NOTARIZE=0 skips notarization (signed-only zip, for local testing; not for publishing).
#
# Other env: BUILD_NUMBER (CFBundleVersion, default 1), SIGN_IDENTITY,
# MACOS_DEPLOYMENT_TARGET (see build.sh).
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-${VERSION:-}}"
VERSION="${VERSION#v}"
[[ -n "$VERSION" ]] || { echo "usage: scripts/release.sh <version>   (e.g. 1.2.3)" >&2; exit 1; }
BUILD_NUMBER="${BUILD_NUMBER:-1}"
NOTARIZE="${NOTARIZE:-1}"
SIGN_IDENTITY="${SIGN_IDENTITY:-Developer ID Application}"
DIST="dist"
ZIP_NAME="Send-to-Claude-${VERSION}.zip"

die() { echo "error: $*" >&2; exit 1; }

# --- signing identity -------------------------------------------------------
IDENTITIES="$(security find-identity -v -p codesigning 2>/dev/null | grep "\"${SIGN_IDENTITY}" || true)"
[[ -n "$IDENTITIES" ]] || die "no valid '${SIGN_IDENTITY}' signing identity found in your keychains. See docs/RELEASING.md."
if [[ -z "${APPLE_TEAM_ID:-}" ]]; then
  [[ "$(printf '%s\n' "$IDENTITIES" | wc -l | tr -d ' ')" == 1 ]] \
    || die "several '${SIGN_IDENTITY}' identities found; set APPLE_TEAM_ID (and SIGN_IDENTITY if needed)"
  APPLE_TEAM_ID="$(printf '%s\n' "$IDENTITIES" | sed -n 's/.*(\([A-Z0-9]\{10\}\))".*/\1/p')"
  [[ -n "$APPLE_TEAM_ID" ]] || die "could not read the Team ID from the identity name; set APPLE_TEAM_ID"
fi
export APPLE_TEAM_ID SIGN_IDENTITY

# --- notarization credentials (checked before the slow build) ---------------
NOTARY_AUTH=()
if [[ "$NOTARIZE" != 0 ]]; then
  if [[ -n "${NOTARY_KEYCHAIN_PROFILE:-}" ]]; then
    NOTARY_AUTH=(--keychain-profile "$NOTARY_KEYCHAIN_PROFILE")
  elif [[ -n "${ASC_KEY_PATH:-}" && -n "${ASC_KEY_ID:-}" && -n "${ASC_ISSUER_ID:-}" ]]; then
    [[ -f "$ASC_KEY_PATH" ]] || die "ASC_KEY_PATH does not point to a file"
    NOTARY_AUTH=(--key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID")
  elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]]; then
    NOTARY_AUTH=(--apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID")
  else
    die "no notarization credentials. Set NOTARY_KEYCHAIN_PROFILE, or ASC_KEY_PATH/ASC_KEY_ID/ASC_ISSUER_ID, or APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD (or NOTARIZE=0 for a local signed-only build)."
  fi
fi

# --- build ------------------------------------------------------------------
echo "==> Building $VERSION ($BUILD_NUMBER), team $APPLE_TEAM_ID"
./build.sh clean
SIGN_MODE=developer-id VERSION="$VERSION" BUILD_NUMBER="$BUILD_NUMBER" ./build.sh

BUILT_APP="$(find "build/Send to Claude.xcarchive/Products/Applications" -maxdepth 1 -name '*.app' 2>/dev/null | head -n1)"
[[ -d "$BUILT_APP" ]] || die "build produced no .app"
rm -rf "$DIST"; mkdir -p "$DIST"
APP="$DIST/$(basename "$BUILT_APP")"
ditto "$BUILT_APP" "$APP"
APPEX="$(find "$APP/Contents/PlugIns" -maxdepth 1 -name '*.appex' | head -n1)"
[[ -d "$APPEX" ]] || die "no .appex inside the app"

# --- verify signature + entitlements ---------------------------------------
echo "==> Verifying code signature"
codesign --verify --deep --strict --verbose=2 "$APP"
for BUNDLE in "$APP" "$APPEX"; do
  INFO="$(codesign -dvv "$BUNDLE" 2>&1)"
  grep -q "^Authority=Developer ID Application" <<<"$INFO" || die "$BUNDLE is not signed with Developer ID"
  grep -q "^TeamIdentifier=$APPLE_TEAM_ID" <<<"$INFO" || die "$BUNDLE has the wrong team"
  grep -q "^Timestamp=" <<<"$INFO" || die "$BUNDLE has no secure timestamp"
  grep -Eq "flags=.*runtime" <<<"$INFO" || die "$BUNDLE is not signed with the hardened runtime"
  ENT="$(codesign -d --entitlements - --xml "$BUNDLE" 2>/dev/null)"
  grep -q "com.apple.security.app-sandbox" <<<"$ENT" || die "$BUNDLE lost the app sandbox entitlement"
  if grep -q "com.apple.security.get-task-allow" <<<"$ENT"; then die "$BUNDLE has get-task-allow (notarization would reject it)"; fi
  echo "ok: $(basename "$BUNDLE")"
done
plutil -p "$APP/Contents/Info.plist" | grep -E 'CFBundle(ShortVersionString|Version)"|LSMinimumSystemVersion'

# --- notarize + staple ------------------------------------------------------
if [[ "$NOTARIZE" != 0 ]]; then
  echo "==> Notarizing (this usually takes a few minutes)"
  SUBMIT_ZIP="$(mktemp -d)/submit.zip"
  ditto -c -k --keepParent "$APP" "$SUBMIT_ZIP"
  RESULT="$(xcrun notarytool submit "$SUBMIT_ZIP" "${NOTARY_AUTH[@]}" --wait --output-format json)" || true
  rm -f "$SUBMIT_ZIP"
  read -r SUB_ID SUB_STATUS < <(python3 -I -c '
import json, sys
try:
    d = json.loads(sys.stdin.read())
except ValueError:
    d = {}
print(d.get("id") or "-", d.get("status") or "unknown")' <<<"$RESULT")
  echo "Submission $SUB_ID: $SUB_STATUS"
  if [[ "$SUB_STATUS" != "Accepted" ]]; then
    if [[ "$SUB_ID" != "-" ]]; then xcrun notarytool log "$SUB_ID" "${NOTARY_AUTH[@]}" || true; fi
    die "notarization failed (status: $SUB_STATUS). See docs/RELEASING.md > Troubleshooting."
  fi
  xcrun stapler staple "$APP"
  xcrun stapler validate "$APP"
  echo "==> Gatekeeper assessment"
  spctl -a -vvv -t exec "$APP"
else
  echo "==> NOTARIZE=0: skipping notarization. Do not publish this build."
fi

# --- package ----------------------------------------------------------------
echo "==> Packaging"
ditto -c -k --keepParent "$APP" "$DIST/$ZIP_NAME"
(cd "$DIST" && shasum -a 256 "$ZIP_NAME" > "$ZIP_NAME.sha256" && cat "$ZIP_NAME.sha256")

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  { echo "zip=$DIST/$ZIP_NAME"; echo "sha256=$DIST/$ZIP_NAME.sha256"; } >> "$GITHUB_OUTPUT"
fi
echo "Done: $DIST/$ZIP_NAME"
