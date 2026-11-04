#!/usr/bin/env node
// Builds the desktop image from a checkout, for development and CI. See README.md.
//
//   node images/desktop/build.ts [--json] [--platform linux/amd64|linux/arm64] [--no-cache] [--pull]
//     [--builder <name>] [--cache-from <spec>]... [--cache-to <spec>]... [--verbose] [--dry-run] [--hash]
import { main } from '../../src/desktop-image.ts'

process.exitCode = await main(process.argv.slice(2))
