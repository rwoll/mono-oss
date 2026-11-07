#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

ARCH="${ARCH:-$(uname -m)}"
case "$ARCH" in
  arm64|x86_64) ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

APP="dist/Blobby Type.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
xcrun swiftc -swift-version 6 -O -warnings-as-errors \
  -target "$ARCH-apple-macosx14.0" \
  -module-cache-path "${TMPDIR:?}/blobby-type-module-cache" \
  Sources/*.swift -o "$APP/Contents/MacOS/BlobbyType"
cp Resources/Info.plist "$APP/Contents/Info.plist"
cp Resources/*.png Resources/LICENSE-blobby-sprites.txt "$APP/Contents/Resources/"
echo "Built: $APP"
