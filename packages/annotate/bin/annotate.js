#!/usr/bin/env node
// The `annotate` command. An installed package runs the compiled CLI in dist/.
// A workspace checkout that is not built yet runs the TypeScript source; Node.js
// strips its types because it is outside node_modules.
import { existsSync } from 'node:fs';

const compiled = new URL('../dist/cli.js', import.meta.url);
const { main } = await import(existsSync(compiled) ? compiled.href : new URL('../src/cli.ts', import.meta.url).href);
process.exitCode = await main(process.argv.slice(2));
