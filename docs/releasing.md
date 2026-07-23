# Release and version synchronization

The canonical Perch package version is `package.json`.
For this source tree it is `perchctl@0.1.11`.
Release tag: `v0.1.11`.

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

## Bundled runtime gate

The no-mistakes runtime release is independent from the Perch package tag.
Its exact immutable inputs live in `vendor/no-mistakes/manifest.json`.
Release tooling must verify both Darwin assets against the manifest before packaging.

Never replace the pinned release with `latest`, a branch archive, an unsigned local build, or a PATH-resolved binary.
Updating the runtime requires the upstream-sync procedure in [No-mistakes upstream sync](no-mistakes-upstream-sync.md).
