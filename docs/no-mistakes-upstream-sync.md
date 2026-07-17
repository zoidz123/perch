# No-mistakes fork upstream sync

Perch-managed no-mistakes is built from the Ellipsoid Labs fork because managed authorization must be enforced inside the CLI, git receiver, daemon, and external-agent launch boundary.
Do not contact or request changes from `kunchenguid/no-mistakes` as part of this maintenance path.

## Current pin

- Fork repository: `zoidz123/no-mistakes`
- Fork commit: `2d35e552b4cbc191b06abcadc3b05fd3da510d26`
- Upstream base: `0a2c82f993b9467c5ab84992313dfd13b66830af`
- Release: `v1.39.0-perch.1`
- GitHub immutable release and attestation: enabled and verified
- Authorization protocol: `1`
- Signing identifier: `com.ellipsoidlabs.no-mistakes`
- Signing Team ID: `JU7RZ24773`

`vendor/no-mistakes/manifest.json` is the machine-readable authority for exact asset hashes, binary hashes, architecture, build inputs, signing timestamp, and notarization status.

## Update procedure

1. Fetch the desired upstream commit into the fork and review every conflict at the CLI, hook, IPC, daemon, database, recovery, self-update, and agent-launch authorization boundaries.
2. Keep standalone unmanaged behavior unchanged and preserve fail-closed handling whenever any managed context variable is present.
3. Run fork tests with fake verifiers and fake agents only.
4. Create an immutable fork release from one exact commit through the fork release workflow.
5. Build Darwin arm64 and x64 with the approved Developer ID Application identity without exporting its private key.
6. Verify the source version and protocol, strict code signature, identifier, Team ID, hardened runtime, secure timestamp, architecture, binary SHA-256, archive SHA-256, and GitHub asset digest.
7. Update the two bundled binaries, upstream and fork MIT notices, and the manifest in one Perch change.
8. Run runtime resolution, package inventory, isolated `npm --ignore-scripts` installation, full server, typecheck, build, package smoke, and iOS checks.

A protocol change requires coordinated fork and Perch changes.
Perch must reject an old or new incompatible protocol before project activation.
Managed execution never falls back to PATH.
