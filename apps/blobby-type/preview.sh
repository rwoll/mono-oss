#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
WORK="$(mktemp -d "${TMPDIR:?}/blobby-type-preview.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
APP="$WORK/Preview.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
xcrun swiftc -swift-version 6 -warnings-as-errors \
  -module-cache-path "${TMPDIR:?}/blobby-type-module-cache" \
  Sources/TypingSession.swift Sources/PracticeLibrary.swift Sources/PracticeStore.swift \
  Sources/TypingInput.swift Sources/ContentView.swift Sources/FingerPractice.swift \
  Sources/TechniqueView.swift Sources/SoundEffects.swift Tools/Preview.swift \
  -o "$APP/Contents/MacOS/Preview"
cp Resources/*.png Resources/LICENSE-blobby-sprites.txt "$APP/Contents/Resources/"
cp Resources/Info.plist "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleExecutable Preview' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier dev.rwoll.BlobbyType.preview' "$APP/Contents/Info.plist"
"$APP/Contents/MacOS/Preview" "${TMPDIR:?}/blobby-type-previews" "$@"
