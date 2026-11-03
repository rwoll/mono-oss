// Rules every plugin follows, in this marketplace and any other in the monorepo,
// so a plugin needs no test of its own:
// - Agent Plugins 1.0 (a root plugin.json with $schema) by default. Copilot's
//   legacy format (.plugin/plugin.json and .mcp.json) only for MCP servers that
//   need settings Agent Plugins cannot express, such as OAuth client IDs.
// - A README, and skills with discovery frontmatter and resolvable references.
// - MCP servers use only reviewed fields and store no headers or credentials.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
const MCP_FIELDS = new Set(['type', 'command', 'args', 'cwd', 'url', 'headers', 'oauthClientId', 'oauthPublicClient', 'tools']);

const folders = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
const readJson = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, 'utf8'));

export function describePlugins(pluginsDir: string): void {
  describe.each(folders(pluginsDir))('plugin %s', plugin => {
    const dir = join(pluginsDir, plugin);
    const agentPlugin = existsSync(join(dir, 'plugin.json'));
    const mcpFile = join(dir, agentPlugin ? 'mcp.json' : '.mcp.json');

    it('has a manifest named after its folder, in Agent Plugins format unless it is a legacy MCP plugin', () => {
      if (agentPlugin) {
        const manifest = readJson(join(dir, 'plugin.json'));
        expect(manifest.$schema).toBe(PLUGIN_SCHEMA);
        expect(manifest).toMatchObject({ name: plugin, version: expect.stringMatching(/^\d+\.\d+\.\d+$/), description: expect.any(String) });
        expect(existsSync(join(dir, '.plugin')), 'one manifest only').toBe(false);
        expect(existsSync(join(dir, '.mcp.json')), 'Agent Plugins MCP servers go in mcp.json').toBe(false);
      } else {
        const manifest = readJson(join(dir, '.plugin', 'plugin.json'));
        expect(Object.keys(manifest).sort()).toEqual(['description', 'name', 'version']);
        expect(manifest).toMatchObject({ name: plugin, version: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
        expect(existsSync(mcpFile), 'the legacy format is only for MCP plugins').toBe(true);
        expect(existsSync(join(dir, 'skills')), 'put skills in an Agent Plugins plugin').toBe(false);
      }
    });

    it('has a README', () => {
      expect(existsSync(join(dir, 'README.md'))).toBe(true);
    });

    it.runIf(existsSync(mcpFile))('defines MCP servers with reviewed fields and no stored credentials', () => {
      const config = readJson(mcpFile);
      expect(Object.keys(config).sort()).toEqual(agentPlugin ? ['$schema', 'mcpServers'] : ['mcpServers']);
      if (agentPlugin) expect(config.$schema).toBe(MCP_SCHEMA);
      const servers = Object.entries(config.mcpServers as Record<string, Record<string, unknown>>);
      expect(servers.length).toBeGreaterThan(0);
      for (const [name, server] of servers) {
        expect(Object.keys(server).filter(field => !MCP_FIELDS.has(field)), `${name} has only reviewed fields`).toEqual([]);
        if (server.headers !== undefined) expect(server.headers, `${name} stores no headers`).toEqual({});
        if (server.url !== undefined) {
          const url = new URL(server.url as string);
          expect(url.protocol, `${name} uses https`).toBe('https:');
          expect(url.username + url.password + url.search + url.hash, `${name} keeps no credentials or query in its URL`).toBe('');
        }
        if (server.tools !== undefined) expect(server.tools).toEqual(['*']);
      }
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
      // Attribution belongs in commits and PRs, not in files: no footer signs the skill.
      // A skill may still quote the footer, for example as the instruction to add it.
      const lastLine = text.trimEnd().split('\n').at(-1) ?? '';
      expect(lastLine, 'the skill does not end with an attribution footer').not.toMatch(/Authored with GitHub Copilot/);
    });
  });
}
