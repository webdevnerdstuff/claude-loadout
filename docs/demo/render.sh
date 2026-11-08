#!/usr/bin/env bash
# Renders docs/demo/pane.html, a stand-in for the Loadout pane with made-up skills, to the README's
# screenshot, docs/screenshot-dark.png. Needs Google Chrome (macOS path; set CHROME to use another).
set -euo pipefail

cd "$(dirname "$0")/../.."
chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
page="file://$PWD/docs/demo/pane.html"
size="${SIZE:-800,1226}"

"$chrome" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
	--default-background-color=00000000 \
	--window-size="$size" --screenshot="$PWD/docs/screenshot-dark.png" "$page" \
	2>/dev/null

echo "Wrote docs/screenshot-dark.png"
