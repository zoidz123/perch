#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

SIMULATOR_NAME="${SIMULATOR_NAME:-iPhone 17 Pro}"
DESTINATION="platform=iOS Simulator,name=${SIMULATOR_NAME}"

echo "Perch iOS: building for ${SIMULATOR_NAME}"
xcodebuild -project apps/ios/Perch.xcodeproj -scheme Perch -destination "${DESTINATION}" build

DEVICE_ID="$(
  xcrun simctl list devices available |
    awk -v name="${SIMULATOR_NAME}" '$0 ~ name && $0 ~ /\([A-F0-9-]+\)/ {
      match($0, /\([A-F0-9-]+\)/)
      print substr($0, RSTART + 1, RLENGTH - 2)
      exit
    }'
)"

if [[ -z "${DEVICE_ID}" ]]; then
  echo "Perch iOS: could not find simulator named ${SIMULATOR_NAME}" >&2
  exit 1
fi

if ! xcrun simctl list devices booted | grep -q "${DEVICE_ID}"; then
  echo "Perch iOS: booting ${SIMULATOR_NAME}"
  xcrun simctl boot "${DEVICE_ID}" || true
fi

APP_PATH="$(
  find "${HOME}/Library/Developer/Xcode/DerivedData" \
    -path "*/Build/Products/Debug-iphonesimulator/Perch.app" \
    -type d \
    -print0 |
    xargs -0 ls -td |
    head -n 1
)"

if [[ -z "${APP_PATH}" ]]; then
  echo "Perch iOS: build succeeded but Perch.app was not found in DerivedData" >&2
  exit 1
fi

echo "Perch iOS: installing ${APP_PATH}"
xcrun simctl install "${DEVICE_ID}" "${APP_PATH}"

echo "Perch iOS: launching com.ellipsoid.perch"
xcrun simctl launch "${DEVICE_ID}" com.ellipsoid.perch
