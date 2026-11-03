import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Every plugin in plugins/ follows the same rules, so each one does not need its own test.
const pluginsDir = fileURLToPath(new URL('../plugins/', import.meta.url));
const SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const folders = (dir: string) => readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();

describe.each(folders(pluginsDir))('plugin %s', plugin => {
  const dir = join(pluginsDir, plugin);

  it('has a plugin.json named after its folder', () => {
    const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'));
    expect(manifest.$schema).toBe(SCHEMA);
    expect(manifest.name).toBe(plugin);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.description).toEqual(expect.any(String));
  });

  it('has a README', () => {
    expect(existsSync(join(dir, 'README.md'))).toBe(true);
  });

  const skillsDir = join(dir, 'skills');
  const skills = existsSync(skillsDir) ? folders(skillsDir) : [];
  it.runIf(skills.length > 0).each(skills)('skill %s has discovery frontmatter and resolvable references', skill => {
    const skillDir = join(skillsDir, skill);
    const text = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
    const match = /^---\nname: ([a-z0-9-]+)\ndescription: ("[^\n]+")\n---\n\n([\s\S]+)$/.exec(text);
    expect(match, 'frontmatter has a name and a quoted description').not.toBeNull();
    const [, name, quoted, body] = match as RegExpExecArray;
    expect(name).toBe(skill);
    expect((JSON.parse(quoted as string) as string).length).toBeLessThanOrEqual(1024);
    expect(text.split('\n').length).toBeLessThan(500);
    for (const [, link] of (body as string).matchAll(/\]\((references\/[^)#]+)\)/g)) {
      expect(existsSync(join(skillDir, link as string)), link).toBe(true);
    }
    expect(text, 'attribution stays out of file contents').not.toMatch(/Authored with GitHub Copilot/);
  });
});
