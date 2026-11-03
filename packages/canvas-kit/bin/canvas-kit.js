#!/usr/bin/env node
// The `canvas-kit` command. An installed package runs the compiled CLI in dist/.
// A workspace checkout of the kit that is not built yet runs the TypeScript
// source; Node.js strips its types because it is outside node_modules.
import { existsSync } from 'node:fs';

const compiled = new URL('../dist/cli/canvas-kit.js', import.meta.url);
await import(existsSync(compiled) ? compiled.href : new URL('../src/cli/canvas-kit.ts', import.meta.url).href);
