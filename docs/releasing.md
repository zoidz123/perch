# Release and version synchronization

The canonical Perch package version is `package.json`.
For this source tree it is `perchctl@0.1.12`.
Release tag: `v0.1.12`.

Workspace package manifests, `package-lock.json`, `perch --version`, installation documentation, and the expected release tag must match that source.
`npm run check:version` rejects drift.
Do not edit generated changelogs by hand.

## Package gate

Run these checks from the exact commit intended for the tag:

```sh
npm ci
npm run check:version
npm run check:public-seed
npm run build
npm run typecheck
npm test -w @perch/server
npm test -w @perch/relay
npm run test:package
npm pack --dry-run
```

The package smoke test installs the produced tarball locally and globally with `npm --ignore-scripts` in an isolated home.
It verifies the bundled no-mistakes inventory and byte hashes without downloading anything during consumer installation.

## TestFlight

Run TestFlight releases from a clean checkout of `origin/main` with Xcode installed and the existing Perch app record visible in App Store Connect.
Confirm the intended marketing version and build number are unused in App Store Connect before archiving.
Do not bump the build number merely to bypass a collision.

### Credentials

Automatic signing requires the Apple Developer team identifier and either a matching account in Xcode or a valid App Store Connect API key.
Read the team identifier from the maintainer's private configuration or Xcode account details, not from committed project settings.
An empty `~/.appstoreconnect/private_keys/` directory does not prove that this machine is unconfigured.
On maintainer machines, existing `AuthKey_*.p8` files may instead be loose in the home directory or on the Desktop:

```sh
find "$HOME" -type f -name 'AuthKey_*.p8' -print 2>/dev/null
```

The key identifier is the part of the filename between `AuthKey_` and `.p8`.
The issuer identifier is separate and cannot be inferred from the filename.
Look first in a durable private configuration outside the repository.
Until one exists, search local agent transcripts for references to the candidate filename or key identifier:

```sh
rg -l --hidden 'AuthKey_|apiIssuer|authenticationKeyIssuerID' "$HOME/.codex/sessions"
```

Treat transcripts only as a recovery source, and never copy credential values into this public repository, task output, or a PR.
Set the discovered values only in the current shell, then verify that the candidate key and issuer pairing authenticates before building:

```sh
xcrun altool --list-providers \
  --api-key "$ASC_KEY_ID" \
  --api-issuer "$ASC_ISSUER_ID" \
  --p8-file-path "$ASC_KEY_PATH"
```

Proceed only when that command returns provider information for the expected account.
Do not guess pairings or retry an upload with unverified credentials.

### Signing

A missing local `Apple Distribution` identity from `security find-identity` is not a blocker.
With automatic signing and `-allowProvisioningUpdates`, Xcode can use cloud-managed distribution certificates and provisioning profiles without installing an Apple Distribution certificate in the local keychain.
Never revoke an existing certificate or profile to free a slot.
If automatic signing reports a certificate limit, stop and ask the owner.

### Archive and upload

Archive the `Perch` scheme with the `Release` configuration from the clean checkout:

```sh
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
test -z "$(git status --porcelain)"

RELEASE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/perch-ios-testflight.XXXXXX")"
ARCHIVE_PATH="$RELEASE_DIR/Perch.xcarchive"

xcodebuild \
  -project apps/ios/Perch.xcodeproj \
  -scheme Perch \
  -configuration Release \
  -destination generic/platform=iOS \
  -archivePath "$ARCHIVE_PATH" \
  archive \
  DEVELOPMENT_TEAM="$PERCH_IOS_TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$ASC_KEY_PATH" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID"
```

Create the export options only in that temporary directory:

```sh
cat > "$RELEASE_DIR/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>destination</key>
  <string>upload</string>
  <key>teamID</key>
  <string>${PERCH_IOS_TEAM_ID}</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key>
  <false/>
  <key>testFlightInternalTestingOnly</key>
  <true/>
  <key>uploadSymbols</key>
  <true/>
</dict>
</plist>
PLIST
```

Export and upload the archive with the same authenticated pairing:

```sh
xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$RELEASE_DIR/upload" \
  -exportOptionsPlist "$RELEASE_DIR/ExportOptions.plist" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$ASC_KEY_PATH" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID"
```

### After upload

Treat an ambiguous upload response as unknown and check App Store Connect before retrying.
The build is restricted to TestFlight Internal Testing, not external beta testing or App Store review.
An internal group can contain zero testers, so an App Store Connect administrator may still need to add internal testers before anyone can install the build.

Never create a replacement app record, distribute to external testers, or submit for App Store review without explicit owner approval.
Never commit key identifiers, issuer identifiers, team identifiers, certificate identifiers, provisioning profile identifiers, `.p8` contents, or temporary export files.

The key path, key identifier, issuer identifier, and team identifier should be moved out of transcript-only history into a durable private configuration.
Use either the standard private-key directory or a local configuration file outside the repository with fields shaped like `ASC_KEY_PATH=<path>`, `ASC_KEY_ID=<value>`, `ASC_ISSUER_ID=<value>`, and `PERCH_IOS_TEAM_ID=<value>`.
Keep that file gitignored, readable only by its owner, and never populate or relocate it as part of a repository change.

## Bundled runtime gate

The no-mistakes runtime release is independent from the Perch package tag.
Its exact immutable inputs live in `vendor/no-mistakes/manifest.json`.
Release tooling must verify both Darwin assets against the manifest before packaging.

Never replace the pinned release with `latest`, a branch archive, an unsigned local build, or a PATH-resolved binary.
Updating the runtime requires the upstream-sync procedure in [No-mistakes upstream sync](no-mistakes-upstream-sync.md).
