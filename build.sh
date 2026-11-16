#!/usr/bin/env bash
# Rebuild the "Send to Claude" Safari Web Extension app.
#   ./build.sh          convert + build, ad hoc signed (local development)
#   ./build.sh clean    remove generated Xcode project and build output
#
# Optional environment (used by scripts/release.sh; defaults keep the dev build):
#   VERSION=1.2.3            stamp extension manifest "version" (in a temp copy,
#                            never in extension/) and MARKETING_VERSION
#   BUILD_NUMBER=42          CURRENT_PROJECT_VERSION (CFBundleVersion), default 1
#   SIGN_MODE=developer-id   sign with a Developer ID Application identity,
#                            hardened runtime and secure timestamp (needs
#                            APPLE_TEAM_ID; SIGN_IDENTITY overrides the identity)
#   MACOS_DEPLOYMENT_TARGET  minimum macOS for developer-id builds (default 12.0)
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="Send to Claude"
BUNDLE_ID="dk.lillefar.sendtoclaude"
PROJ_DIR="xcode"
BUILD_DIR="build"
SIGN_MODE="${SIGN_MODE:-adhoc}"

if [[ "${1:-}" == "clean" ]]; then
  rm -rf "$PROJ_DIR" "$BUILD_DIR"
  echo "cleaned"
  exit 0
fi

case "$SIGN_MODE" in
  adhoc) ;;
  developer-id)
    [[ -n "${APPLE_TEAM_ID:-}" ]] || { echo "SIGN_MODE=developer-id needs APPLE_TEAM_ID" >&2; exit 1; } ;;
  *) echo "Unknown SIGN_MODE '$SIGN_MODE' (use adhoc or developer-id)" >&2; exit 1 ;;
esac
if [[ -n "${VERSION:-}" && ! "$VERSION" =~ ^[0-9]+(\.[0-9]+){0,3}$ ]]; then
  echo "VERSION must be 1 to 4 dot-separated integers, got '$VERSION'" >&2; exit 1
fi
if [[ -n "${BUILD_NUMBER:-}" && ! "$BUILD_NUMBER" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]]; then
  echo "BUILD_NUMBER must be numeric, got '$BUILD_NUMBER'" >&2; exit 1
fi

# Use Xcode.app even if xcode-select points at the Command Line Tools.
if [[ -z "${DEVELOPER_DIR:-}" ]]; then
  XCODE_APP="$(mdfind "kMDItemCFBundleIdentifier == com.apple.dt.Xcode" 2>/dev/null | head -n1)"
  [[ -z "$XCODE_APP" && -d /Applications/Xcode.app ]] && XCODE_APP=/Applications/Xcode.app
  [[ -z "$XCODE_APP" ]] && { echo "Xcode.app not found" >&2; exit 1; }
  export DEVELOPER_DIR="$XCODE_APP/Contents/Developer"
fi
echo "Using DEVELOPER_DIR=$DEVELOPER_DIR"

if ! xcodebuild -license check >/dev/null 2>&1; then
  cat >&2 <<EOF
The Xcode license has not been accepted yet, so xcrun/xcodebuild refuse to run.
Run this once in Terminal (needs your admin password), then re-run ./build.sh:

  sudo DEVELOPER_DIR="$DEVELOPER_DIR" xcodebuild -license accept
  sudo DEVELOPER_DIR="$DEVELOPER_DIR" xcodebuild -runFirstLaunch
(Or just open Xcode.app once and accept the license there.)
EOF
  exit 1
fi

# With VERSION set, convert a temp copy of extension/ with the version stamped
# into its manifest, so the working tree is never modified.
EXT_SRC="extension"
if [[ -n "${VERSION:-}" ]]; then
  STAGE="$(mktemp -d)"
  trap 'rm -rf "$STAGE"' EXIT
  cp -R extension "$STAGE/extension"
  EXT_SRC="$STAGE/extension"
  python3 -I - "$EXT_SRC/manifest.json" "$VERSION" <<'PY'
import json, sys
path, version = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as f:
    manifest = json.load(f)
manifest["version"] = version
with open(path, "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY
  echo "Stamped manifest version $VERSION"
fi

# (Re)generate the Xcode wrapper project. --copy-resources copies extension/
# into the project, so regenerate on every build to pick up source changes.
rm -rf "$PROJ_DIR"
xcrun safari-web-extension-converter "$EXT_SRC" \
  --project-location "$PROJ_DIR" \
  --app-name "$APP_NAME" \
  --bundle-identifier "$BUNDLE_ID" \
  --macos-only --swift --copy-resources --no-open --no-prompt --force

PROJECT="$(find "$PROJ_DIR" -maxdepth 3 -name '*.xcodeproj' 2>/dev/null | head -n1)"
[[ -n "$PROJECT" ]] || { echo "safari-web-extension-converter did not produce an .xcodeproj" >&2; exit 1; }
# The converter derives the app's bundle id from the app name, which breaks the
# rule that the extension id must be prefixed by the app id. Force the app id.
# Newer Xcode writes project.xcproj (JSON); older writes project.pbxproj.
PROJFILE="$(find "$PROJECT" -maxdepth 1 -type f \( -name 'project.pbxproj' -o -name 'project.xcproj' \) | head -n1)"
APP_ID_GUESS="${BUNDLE_ID%.*}.$(echo "$APP_NAME" | tr ' ' '-')"
sed -i '' "s/\"${APP_ID_GUESS}\"/\"${BUNDLE_ID}\"/g; s/= ${APP_ID_GUESS};/= ${BUNDLE_ID};/g" "$PROJFILE"
echo "Bundle ids:"; grep -a -o "${BUNDLE_ID%.*}[A-Za-z.-]*" "$PROJFILE" | sort -u
SCHEME="$(xcodebuild -list -project "$PROJECT" | awk '/Schemes:/{f=1;next} f&&NF{gsub(/^ +/,"");print;exit}')"
echo "Project: $PROJECT  Scheme: $SCHEME"

# Build settings on the command line apply to both targets (app + appex).
# The app sandbox entitlements come from the converter's ENABLE_APP_SANDBOX /
# ENABLE_USER_SELECTED_FILES / ENABLE_OUTGOING_NETWORK_CONNECTIONS settings,
# which are left untouched.
SETTINGS=()
if [[ -n "${VERSION:-}" ]]; then
  SETTINGS+=(MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="${BUILD_NUMBER:-1}")
fi
if [[ "$SIGN_MODE" == "developer-id" ]]; then
  SETTINGS+=(
    CODE_SIGN_STYLE=Manual
    CODE_SIGN_IDENTITY="${SIGN_IDENTITY:-Developer ID Application}"
    DEVELOPMENT_TEAM="$APPLE_TEAM_ID"
    PROVISIONING_PROFILE_SPECIFIER=""
    ENABLE_HARDENED_RUNTIME=YES
    OTHER_CODE_SIGN_FLAGS="--timestamp"
    # The converter sets the target to the build machine's macOS.
    MACOSX_DEPLOYMENT_TARGET="${MACOS_DEPLOYMENT_TARGET:-12.0}"
  )
else
  # Ad-hoc ("Sign to Run Locally") signing; needs Safari's "Allow unsigned extensions".
  SETTINGS+=(CODE_SIGN_IDENTITY="-" CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM="" ENABLE_HARDENED_RUNTIME=NO)
fi

if [[ "$SIGN_MODE" == "developer-id" ]]; then
  # Archive rather than build: an archive build leaves out the
  # com.apple.security.get-task-allow entitlement (notarization rejects it)
  # while keeping the sandbox entitlements injected from the build settings.
  ARCHIVE="$BUILD_DIR/$APP_NAME.xcarchive"
  xcodebuild \
    -project "$PROJECT" \
    -scheme "$SCHEME" \
    -configuration Release \
    -derivedDataPath "$BUILD_DIR" \
    -archivePath "$ARCHIVE" \
    "${SETTINGS[@]}" \
    archive
  APP="$(find "$ARCHIVE/Products/Applications" -maxdepth 1 -name '*.app' | head -n1)"
else
  xcodebuild \
    -project "$PROJECT" \
    -scheme "$SCHEME" \
    -configuration Release \
    -derivedDataPath "$BUILD_DIR" \
    "${SETTINGS[@]}" \
    build
  APP="$(find "$BUILD_DIR/Build/Products/Release" -maxdepth 1 -name '*.app' | head -n1)"
fi
echo
echo "Built: $(cd "$(dirname "$APP")" && pwd)/$(basename "$APP")"
echo "Run it once:  open \"$APP\""
