# Third-party notices

## no-mistakes

Perch bundles a pinned fork of no-mistakes under the MIT License.
The upstream source is `kunchenguid/no-mistakes` at commit `0a2c82f993b9467c5ab84992313dfd13b66830af`.
The authorization fork source is `zoidz123/no-mistakes` at commit `2d35e552b4cbc191b06abcadc3b05fd3da510d26` and release `v1.39.0-perch.1`.
The complete upstream and fork license notices ship under `vendor/no-mistakes/`.

## AutoReview skill

Perch bundles the byte-exact runtime subset of `skills/autoreview` from `openclaw/agent-skills` at commit `2a409d348a4bcf6f15e41e9a20efd0b298a32528`.
The helper, runtime harnesses, runtime instructions, attribution, and upstream MIT license are immutable package assets under `apps/server/assets/autoreview/`.
Upstream test and fixture bytes are intentionally excluded after bootstrap TruffleHog verified live credentials in them.
`apps/server/assets/autoreview/manifest.json` records every included runtime file and every excluded upstream test path with its source blob, mode, byte count, and SHA-256 hash.

## Project provenance

Perch descends from earlier private Firstmate and Treehouse work.
This statement preserves repository provenance and does not assert that those acknowledgements satisfy any separate third-party license obligation.
In particular, this notice does not resolve or alter the separate disposition required for Paseo code under the GNU Affero General Public License.
