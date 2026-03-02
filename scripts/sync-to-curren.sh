#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   npm run publish:curren
# or
#   npm run build && npm run sync:curren
#
# This copies the latest Mosher build output into the curren.dev site project
# so /mosher serves the updated app.

MOSHER_DIR="${MOSHER_DIR:-$PWD}"
CURRENT_SITE_DIR="${CURRENT_SITE_DIR:-/Users/curren/Documents/projects/curren}"
DIST_DIR="$MOSHER_DIR/dist"
TARGET_DIR="$CURRENT_SITE_DIR/public/mosher"
ROOT_SOUNDS_DIR="$CURRENT_SITE_DIR/public/sounds"

if [[ ! -d "$DIST_DIR" ]]; then
  echo "ERROR: Missing dist folder at $DIST_DIR"
  echo "Run 'npm run build' first."
  exit 1
fi

mkdir -p "$TARGET_DIR"
rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"
cp -R "$DIST_DIR"/. "$TARGET_DIR"/

mkdir -p "$ROOT_SOUNDS_DIR"
if [[ -d "$DIST_DIR/sounds" ]]; then
  cp -R "$DIST_DIR"/sounds/. "$ROOT_SOUNDS_DIR"/
fi

# Ensure /mosher/index.html loads assets relative to /mosher.
if [[ -f "$TARGET_DIR/index.html" ]]; then
  sed -i '' \
    -e 's|href="/vite.svg"|href="/mosher/vite.svg"|g' \
    -e 's|src="/assets/|src="/mosher/assets/|g' \
    -e 's|href="/assets/|href="/mosher/assets/|g' \
    "$TARGET_DIR/index.html"
fi

echo "Synced Mosher build to:"
echo "  $TARGET_DIR"
echo "  $ROOT_SOUNDS_DIR"
