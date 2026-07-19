#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

TEAM_ID="${PERCH_IOS_TEAM_ID:-}"
if [[ -z "${TEAM_ID}" ]]; then
  echo "Perch iOS: set PERCH_IOS_TEAM_ID to your Apple Developer Team ID before uploading" >&2
  exit 1
fi

RELEASE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/perch-ios-testflight.XXXXXX")"
ARCHIVE_PATH="${RELEASE_DIR}/Perch.xcarchive"
EXPORT_PATH="${RELEASE_DIR}/export"
EXPORT_OPTIONS_PLIST="${RELEASE_DIR}/ExportOptions.plist"

cleanup() {
  rm -rf "${RELEASE_DIR}"
}
trap cleanup EXIT

cat > "${EXPORT_OPTIONS_PLIST}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>destination</key>
  <string>upload</string>
  <key>teamID</key>
  <string>${TEAM_ID}</string>
  <key>manageAppVersionAndBuildNumber</key>
  <true/>
</dict>
</plist>
EOF

echo "Perch iOS: archiving for App Store Connect"
xcodebuild \
  -project apps/ios/Perch.xcodeproj \
  -scheme Perch \
  -destination generic/platform=iOS \
  -archivePath "${ARCHIVE_PATH}" \
  archive \
  DEVELOPMENT_TEAM="${TEAM_ID}" \
  CODE_SIGN_STYLE=Automatic \
  -allowProvisioningUpdates

echo "Perch iOS: exporting and uploading to App Store Connect"
xcodebuild \
  -exportArchive \
  -archivePath "${ARCHIVE_PATH}" \
  -exportPath "${EXPORT_PATH}" \
  -exportOptionsPlist "${EXPORT_OPTIONS_PLIST}"
