#!/usr/bin/env bash
# Rebuild the "Send to Claude" Safari Web Extension app.
#   ./build.sh          convert (if needed) + build
#   ./build.sh clean    remove generated Xcode project and build output
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="Send to Claude"
BUNDLE_ID="dk.lillefar.sendtoclaude"
PROJ_DIR="xcode"
BUILD_DIR="build"

if [[ "${1:-}" == "clean" ]]; then
  rm -rf "$PROJ_DIR" "$BUILD_DIR"
  echo "cleaned"
  exit 0
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

# (Re)generate the Xcode wrapper project. --copy-resources copies extension/
# into the project, so regenerate on every build to pick up source changes.
rm -rf "$PROJ_DIR"
xcrun safari-web-extension-converter extension \
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

# Ad-hoc ("Sign to Run Locally") signing; needs Safari's "Allow unsigned extensions".
xcodebuild \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -configuration Release \
  -derivedDataPath "$BUILD_DIR" \
  CODE_SIGN_IDENTITY="-" CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM="" \
  ENABLE_HARDENED_RUNTIME=NO \
  build

APP="$(find "$BUILD_DIR/Build/Products/Release" -maxdepth 1 -name '*.app' | head -n1)"
echo
echo "Built: $(cd "$(dirname "$APP")" && pwd)/$(basename "$APP")"
echo "Run it once:  open \"$APP\""
