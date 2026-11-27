#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ $(uname -s) == Darwin ]]
command -v bun >/dev/null || { echo 'Packaging needs Bun 1.3+ on the build Mac only.' >&2; exit 1; }
npm run build
name="Graviton-Computer-Use-macOS-$(uname -m)"
root="release/$name"
app="$root/Graviton Computer Use.app"
mkdir -p "$app/Contents/MacOS"
cp scripts/Info.plist "$app/Contents/Info.plist"
cp .build/release/graviton-computer-use "$app/Contents/MacOS/"
codesign --force --sign - "$app"
bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig --outfile "$root/computer-use-mcp" src/index.ts
codesign --force --sign - "$root/computer-use-mcp"
codesign --verify "$root/computer-use-mcp"
codesign --verify --strict "$app"
cp MACOS.md "$root/README.md"
/usr/bin/ditto -c -k --keepParent "$root" "release/$name.zip"
unzip -tq "release/$name.zip"
node scripts/smoke-package.mjs "$root/computer-use-mcp"
shasum -a 256 "release/$name.zip"
