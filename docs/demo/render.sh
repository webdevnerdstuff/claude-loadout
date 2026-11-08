#!/usr/bin/env bash
# Renders docs/demo/pane.html, a stand-in for the Loadout pane with made-up skills, to the README's
# light and dark screenshots. Needs Google Chrome (macOS path; set CHROME to use another).
set -euo pipefail

cd "$(dirname "$0")/../.."
chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
page="file://$PWD/docs/demo/pane.html"
size="${SIZE:-594,1010}"

for theme in light dark; do
	"$chrome" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
		--default-background-color=00000000 \
		--window-size="$size" --screenshot="$PWD/docs/screenshot-$theme.png" "$page#$theme" \
		2>/dev/null
done

echo "Wrote docs/screenshot-light.png and docs/screenshot-dark.png"
