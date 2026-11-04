#!/bin/bash
# Updates VS Code Insiders, which gets a new build every weekday, before anything can start it. Runs as
# root once per boot, after the runtime is installed. Prints `blobby-info: insiders <version>`.
exec /opt/blobby/runtime/scripts/vscode-update --boot
