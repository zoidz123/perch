# Physical iPhone install

Use this runbook to build and install the current Perch source on a paired physical iPhone.
It is separate from the [TestFlight release procedure](releasing.md): it signs one local development build and does not upload anything to App Store Connect.

## Current signing boundary

The Perch project deliberately leaves `DEVELOPMENT_TEAM` unset.
The active physical-device provisioning profile verified on 2026-07-24 has team `JU7RZ24773`, which is the value to pass as `DEVELOPMENT_TEAM` after validating that profile.
The `3GQJU32CPH` suffix in an `Apple Development` certificate subject is not the Ellipsoid Labs `DEVELOPMENT_TEAM`.

- A certificate is Apple’s public credential that names a signing identity.
- Its private key is the secret local half that actually creates a signature.
- A provisioning profile is Apple’s signed permission slip that ties a team, app ID, permitted certificates, and registered devices together.
- A team ID identifies the Apple Developer organization that owns the app and profile.
- A `.p8` file is an App Store Connect API key for upload and account automation.
  It is not needed to sign or install this local development build.

This procedure needs no Xcode GUI, Computer Use, or `.p8` key.
It uses `xcodebuild`, `security`, `plutil`, `node`, and `xcrun devicectl` only.

## Install deterministically

Run these commands from the repository root with Xcode 26 installed.
Connect, unlock, and trust the intended iPhone, and enable Developer Mode on it.
The commands use `devicectl` JSON because that is its supported scripting interface.
Run the following blocks in the same shell and in their displayed order.

First select the physical device deliberately, rather than accepting the first connected device:

```sh
set -euo pipefail

BUNDLE_ID=com.ellipsoid.perch
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/perch-ios-device.XXXXXX")"
DEVICE_JSON="$RUN_DIR/devices.json"

xcrun devicectl list devices --json-output "$DEVICE_JSON" >/dev/null
node --input-type=module - "$DEVICE_JSON" <<'NODE'
import { readFileSync } from "node:fs";

const { result: { devices = [] } = {} } = JSON.parse(readFileSync(process.argv[2], "utf8"));
for (const device of devices) {
  if (device.hardwareProperties?.platform === "iOS" && device.hardwareProperties?.reality === "physical") {
    console.log(`${device.deviceProperties?.name ?? "Unnamed iPhone"}\t${device.hardwareProperties.udid}`);
  }
}
NODE

# Copy one displayed UDID. Do not use a device name or choose one implicitly.
DEVICE_ID='<selected physical iPhone UDID>'
```

Before inspecting signing material, read the source target and the installed app.
Stop without building or installing when both version and build already match:

```sh
BUILD_SETTINGS="$RUN_DIR/build-settings.txt"
DEVICE_APPS_JSON="$RUN_DIR/installed-apps.json"

if ! xcodebuild \
  -project apps/ios/Perch.xcodeproj \
  -scheme Perch \
  -configuration Debug \
  -destination 'generic/platform=iOS' \
  -showBuildSettings > "$BUILD_SETTINGS"; then
  printf '%s\n' 'Stop: could not read Perch version and build settings.' >&2
  exit 1
fi

EXPECTED_VERSION="$(awk -F ' = ' '$1 ~ /MARKETING_VERSION$/ { print $2; exit }' "$BUILD_SETTINGS")"
EXPECTED_BUILD="$(awk -F ' = ' '$1 ~ /CURRENT_PROJECT_VERSION$/ { print $2; exit }' "$BUILD_SETTINGS")"
if [[ -z "$EXPECTED_VERSION" || -z "$EXPECTED_BUILD" ]]; then
  printf '%s\n' 'Stop: Perch source did not expose a marketing version and build number.' >&2
  exit 1
fi

if ! xcrun devicectl device info apps \
  --device "$DEVICE_ID" \
  --bundle-id "$BUNDLE_ID" \
  --json-output "$DEVICE_APPS_JSON" >/dev/null; then
  printf '%s\n' 'Stop: cannot query the selected iPhone. Check its cable or network pairing, trust, unlock state, and Developer Mode.' >&2
  exit 1
fi

INSTALLED_VERSION="$(plutil -extract result.apps.0.version raw -o - "$DEVICE_APPS_JSON" 2>/dev/null || true)"
INSTALLED_BUILD="$(plutil -extract result.apps.0.bundleVersion raw -o - "$DEVICE_APPS_JSON" 2>/dev/null || true)"
printf 'Source: %s (%s)\nInstalled: %s (%s)\n' \
  "$EXPECTED_VERSION" "$EXPECTED_BUILD" \
  "${INSTALLED_VERSION:-not installed}" "${INSTALLED_BUILD:-not installed}"

if [[ "$INSTALLED_VERSION" == "$EXPECTED_VERSION" && "$INSTALLED_BUILD" == "$EXPECTED_BUILD" ]]; then
  printf '%s\n' 'Stop: the selected iPhone already has the requested Perch version and build. No build or install was performed.'
  exit 0
fi
```

Next enumerate the usable local identities.
`security find-identity` lists certificate and private-key pairs, so choose one `Apple Development` entry and copy both its SHA-1 hash and name from the same line:

```sh
security find-identity -v -p codesigning

IDENTITY_SHA1='<selected 40-character SHA-1 hash>'
IDENTITY_NAME='<selected Apple Development identity name>'

if ! security find-identity -v -p codesigning \
  | awk -v hash="$IDENTITY_SHA1" '$2 == hash { found = 1 } END { exit !found }'; then
  printf '%s\n' 'Stop: the selected code-signing identity is not a valid local certificate with its private key.' >&2
  exit 1
fi
```

Choose the exact local development profile for `com.ellipsoid.perch` and validate it before the build.
This checks the profile team, app ID, selected identity, and selected device.
It passes the profile’s team, unique UUID, and the selected identity’s validated SHA-1 fingerprint to `xcodebuild`, so it cannot silently select a different team, profile, or same-named certificate:

```sh
PROFILE_PATH='<absolute path to the selected .mobileprovision file>'
EXPECTED_PROFILE_TEAM=JU7RZ24773
PROFILE_PLIST="$RUN_DIR/profile.plist"
PROFILE_CERTIFICATES_JSON="$RUN_DIR/profile-certificates.json"
PROFILE_DEVICES_JSON="$RUN_DIR/profile-devices.json"
SELECTED_CERTIFICATE="$RUN_DIR/selected-certificate.txt"
SELECTED_CERTIFICATE_PEM="$RUN_DIR/selected-certificate.pem"

if [[ ! -f "$PROFILE_PATH" ]]; then
  printf '%s\n' 'Stop: the selected provisioning profile is not present locally. Obtain the intended profile from its owner; do not revoke certificates or profiles.' >&2
  exit 1
fi
if ! security cms -D -i "$PROFILE_PATH" > "$PROFILE_PLIST"; then
  printf '%s\n' 'Stop: the selected provisioning profile could not be decoded.' >&2
  exit 1
fi

PROFILE_TEAM="$(plutil -extract TeamIdentifier.0 raw -o - "$PROFILE_PLIST")"
PROFILE_UUID="$(plutil -extract UUID raw -o - "$PROFILE_PLIST")"
PROFILE_APP_ID="$(plutil -extract Entitlements.application-identifier raw -o - "$PROFILE_PLIST")"
if [[ "$PROFILE_TEAM" != "$EXPECTED_PROFILE_TEAM" ]]; then
  printf 'Stop: profile team %s is not the active Perch physical-device team %s.\n' "$PROFILE_TEAM" "$EXPECTED_PROFILE_TEAM" >&2
  exit 1
fi
PROFILE_APP_ID_PATTERN="${PROFILE_APP_ID#"$PROFILE_TEAM."}"
case "$BUNDLE_ID" in
  $PROFILE_APP_ID_PATTERN) ;;
  *)
    printf 'Stop: profile app ID %s does not authorize %s.\n' "$PROFILE_APP_ID" "$BUNDLE_ID" >&2
    exit 1
    ;;
esac

security find-certificate -Z -p -c "$IDENTITY_NAME" > "$SELECTED_CERTIFICATE"
SELECTED_CERTIFICATE_SHA1="$(awk -F ': ' '/^SHA-1 hash:/ { print $2; exit }' "$SELECTED_CERTIFICATE")"
if [[ "$SELECTED_CERTIFICATE_SHA1" != "$IDENTITY_SHA1" ]]; then
  printf '%s\n' 'Stop: the identity name is ambiguous or does not match the selected identity hash.' >&2
  exit 1
fi
sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/p' \
  "$SELECTED_CERTIFICATE" > "$SELECTED_CERTIFICATE_PEM"

if ! plutil -extract DeveloperCertificates json -o "$PROFILE_CERTIFICATES_JSON" "$PROFILE_PLIST" \
  || ! plutil -extract ProvisionedDevices json -o "$PROFILE_DEVICES_JSON" "$PROFILE_PLIST"; then
  printf '%s\n' 'Stop: this is not a readable development profile with certificate and device authorization.' >&2
  exit 1
fi
node --input-type=module - "$PROFILE_CERTIFICATES_JSON" "$PROFILE_DEVICES_JSON" \
  "$SELECTED_CERTIFICATE_PEM" "$DEVICE_ID" <<'NODE'
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

const [certificatesPath, devicesPath, certificatePath, deviceID] = process.argv.slice(2);
const certificates = JSON.parse(readFileSync(certificatesPath, "utf8"));
const devices = JSON.parse(readFileSync(devicesPath, "utf8"));
const fingerprint = (bytes) => createHash("sha1").update(bytes).digest("hex");
const identity = new X509Certificate(readFileSync(certificatePath)).raw;
if (!Array.isArray(certificates) || !certificates.some((certificate) =>
  fingerprint(Buffer.from(certificate, "base64")) === fingerprint(identity))) {
  console.error("Stop: the selected identity is not authorized by the selected provisioning profile.");
  process.exit(1);
}
if (!Array.isArray(devices) || !devices.includes(deviceID)) {
  console.error("Stop: the selected iPhone is not registered in the selected provisioning profile.");
  process.exit(1);
}
NODE
```

Build, install, and re-read the version and build with the exact validated values:

```sh
DERIVED_DATA="$RUN_DIR/DerivedData"
APP_PATH="$DERIVED_DATA/Build/Products/Debug-iphoneos/Perch.app"

if ! xcodebuild \
  -project apps/ios/Perch.xcodeproj \
  -scheme Perch \
  -configuration Debug \
  -destination "platform=iOS,id=$DEVICE_ID" \
  -derivedDataPath "$DERIVED_DATA" \
  CODE_SIGN_STYLE=Manual \
  DEVELOPMENT_TEAM="$PROFILE_TEAM" \
  CODE_SIGN_IDENTITY="$IDENTITY_SHA1" \
  PROVISIONING_PROFILE="$PROFILE_UUID" \
  build; then
  printf '%s\n' 'Stop: the command-line build failed. Preserve the signing material and resolve the reported Xcode error before retrying.' >&2
  exit 1
fi
if [[ ! -d "$APP_PATH" ]]; then
  printf 'Stop: expected signed app was not produced at %s.\n' "$APP_PATH" >&2
  exit 1
fi
if ! xcrun devicectl device install app --device "$DEVICE_ID" "$APP_PATH"; then
  printf '%s\n' 'Stop: the signed app could not be installed. Recheck the reported device or profile authorization error; do not delete signing material.' >&2
  exit 1
fi

xcrun devicectl device info apps \
  --device "$DEVICE_ID" \
  --bundle-id "$BUNDLE_ID" \
  --json-output "$RUN_DIR/installed-after.json" >/dev/null
INSTALLED_VERSION="$(plutil -extract result.apps.0.version raw -o - "$RUN_DIR/installed-after.json")"
INSTALLED_BUILD="$(plutil -extract result.apps.0.bundleVersion raw -o - "$RUN_DIR/installed-after.json")"
if [[ "$INSTALLED_VERSION" != "$EXPECTED_VERSION" || "$INSTALLED_BUILD" != "$EXPECTED_BUILD" ]]; then
  printf 'Stop: install returned, but the device reports %s (%s), not %s (%s).\n' \
    "$INSTALLED_VERSION" "$INSTALLED_BUILD" "$EXPECTED_VERSION" "$EXPECTED_BUILD" >&2
  exit 1
fi
printf 'Installed Perch %s (%s) on the selected iPhone.\n' "$INSTALLED_VERSION" "$INSTALLED_BUILD"
```

## Do not repair by deletion

A grey certificate in Keychain Access without a local private key is only an unusable copy on this Mac.
It does not prove that the certificate or profile is invalid, and it is never a reason to delete or revoke either one.
If no valid local `Apple Development` identity appears in `security find-identity`, stop and ask the signing-material owner to recover or import the intended certificate and private key.
