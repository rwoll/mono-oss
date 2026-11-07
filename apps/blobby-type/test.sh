#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
WORK="$(mktemp -d "${TMPDIR:?}/blobby-type-tests.XXXXXX")"
trap 'rm -f "$WORK/tests"; rmdir "$WORK"' EXIT
xcrun swiftc -swift-version 6 -warnings-as-errors \
  -module-cache-path "${TMPDIR:?}/blobby-type-module-cache" \
  Sources/TypingSession.swift Sources/PracticeLibrary.swift \
  Sources/PracticeStore.swift Sources/TypingInput.swift Sources/FingerPractice.swift \
  Sources/SoundEffects.swift Tests/Tests.swift \
  -o "$WORK/tests"
"$WORK/tests"
