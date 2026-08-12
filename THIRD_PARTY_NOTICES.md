# Third-party notices

## AutoReview skill

Perch bundles the byte-exact runtime subset of `skills/autoreview` from `openclaw/agent-skills` at commit `2a409d348a4bcf6f15e41e9a20efd0b298a32528`.
The helper, runtime harnesses, runtime instructions, attribution, and upstream MIT license are immutable package assets under `apps/server/assets/autoreview/`.
Upstream test and fixture bytes are intentionally excluded after bootstrap TruffleHog verified live credentials in them.
`apps/server/assets/autoreview/manifest.json` records every included runtime file and every excluded upstream test path with its source blob, mode, byte count, and SHA-256 hash.

## Project provenance

Perch descends from earlier private Firstmate and Treehouse work.
This statement preserves repository provenance and does not assert that those acknowledgements satisfy any separate third-party license obligation.
