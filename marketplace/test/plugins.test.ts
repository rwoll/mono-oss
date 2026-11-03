import { fileURLToPath } from 'node:url';
import { describePlugins } from './plugin-rules.ts';

describePlugins(fileURLToPath(new URL('../plugins/', import.meta.url)));
