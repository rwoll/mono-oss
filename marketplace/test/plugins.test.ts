import { fileURLToPath } from 'node:url';
import { describePlugins, describeSkills } from './plugin-rules.ts';

describePlugins(fileURLToPath(new URL('../plugins/', import.meta.url)));
describeSkills(fileURLToPath(new URL('../skills/', import.meta.url)));
