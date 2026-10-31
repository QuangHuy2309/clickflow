#!/bin/sh
# Builds the Chrome Web Store upload zip: only manifest.json, _locales/, src/ and icons/.
set -eu
cd "$(dirname "$0")/.."

version=$(node -p "require('./manifest.json').version")
mkdir -p dist
zip="dist/clickflow-$version.zip"
rm -f "$zip"
zip -r -X "$zip" manifest.json _locales src icons
echo "Created $zip"
