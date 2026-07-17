#!/usr/bin/env bash
# Regenerates the AppIcon PNGs in apps/ios/Perch/Assets.xcassets/AppIcon.appiconset
# from the full-bleed SVG sources in this directory. Requires librsvg (brew install librsvg).
#
# icon-light/dark/tinted.svg are the authoritative full-bleed 1024x1024 sources.
# They have no rounded corners because iOS applies the squircle mask.
set -euo pipefail
cd "$(dirname "$0")"
OUT="../../apps/ios/Perch/Assets.xcassets/AppIcon.appiconset"
rsvg-convert -w 1024 -h 1024 icon-light.svg  -o "$OUT/AppIcon-1024.png"
rsvg-convert -w 1024 -h 1024 icon-dark.svg   -o "$OUT/AppIcon-1024-dark.png"
rsvg-convert -w 1024 -h 1024 icon-tinted.svg -o "$OUT/AppIcon-1024-tinted.png"
echo "wrote $OUT"
