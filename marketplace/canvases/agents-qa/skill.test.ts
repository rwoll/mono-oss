import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The agents-qa skill's scripts, run as the skill runs them: with Node.js and a stand-in gh.
const script = (name: string) => fileURLToPath(new URL(`../../skills/agents-qa/scripts/${name}`, import.meta.url));

describe('agents-qa skill scripts', () => {
  it('check-run rejects what the canvas rejects', async () => {
    const qa = await mkdtemp(join(tmpdir(), 'agents-qa-check-'));
    try {
      const dir = join(qa, 'runs', 'bad');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'findings.json'),
        JSON.stringify({
          format: 'agents-qa-run',
          version: 1,
          id: 'bad',
          status: 'running',
          startedAt: new Date().toISOString(),
          build: null,
          scope: 'x',
          findings: [{ id: 'R1', key: 'a-key', title: 'T', severity: 'low', repro: 'steps', owner: { login: 'octo\nmore' } }],
          verified: [],
        }),
      );
      const result = spawnSync(process.execPath, [script('check-run.ts'), dir], { encoding: 'utf8', env: { ...process.env, AGENTS_QA_ROOT: qa } });
      expect(result.status).toBe(1);
      for (const field of ['build', 'scope', 'findings[0] (R1).repro', 'findings[0] (R1).owner.login']) {
        expect(result.stdout).toMatch(new RegExp(`problem: ${field.replace(/[[\]().]/g, '\\$&')}: `));
      }
    } finally {
      await rm(qa, { recursive: true, force: true });
    }
  });

  it("pick-prs takes the PRs in this build and not the last run's, by merge commit", async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-qa-pick-'));
  try {
    const [base, build, inside, test, later, earlier, outsider] = ['a', 'b', 'c', 'd', 'e', 'f', '0'].map(c => c.repeat(40));
    await mkdir(join(root, 'runs', 'prev'), { recursive: true });
    await writeFile(
      join(root, 'runs', 'prev', 'findings.json'),
      JSON.stringify({ format: 'agents-qa-run', version: 1, id: 'prev', status: 'complete', startedAt: '2026-10-28T01:00:00Z', build: { version: '1.145.0-insider', commit: base } }),
    );
    const pr = (number: number, oid: string, mergedAt: string) => ({ number, title: `PR ${number}`, url: `https://github.com/microsoft/vscode/pull/${number}`, mergedAt, mergeCommit: { oid }, author: { login: 'octo' } });
    const fake = join(root, 'bin');
    await mkdir(fake);
    // A stand-in for the gh CLI that answers the calls pick-prs makes.
    await writeFile(
      join(fake, 'gh'),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const joined = args.join(' ');
const dates = { ${JSON.stringify(base)}: '2026-10-28T00:00:00Z', ${JSON.stringify(build)}: '2026-10-29T00:00:00Z' };
const commit = (args[1] ?? '').startsWith('repos/microsoft/vscode/commits/') ? [null, args[1].split('/').pop()] : null;
if (commit && joined.endsWith('--jq .sha')) console.log(commit[1]);
else if (commit) console.log(dates[commit[1]]);
else if (joined.includes('/compare/${base}...${build}')) console.log(${JSON.stringify([inside, test, outsider, build].join('\n'))});
else if (args[0] === 'pr') console.log(JSON.stringify(${JSON.stringify([
      pr(1, inside, '2026-10-28T10:00:00Z'),
      pr(2, test, '2026-10-28T11:00:00Z'),
      pr(3, build, '2026-10-28T23:00:00Z'),
      pr(4, later, '2026-10-29T05:00:00Z'),
      pr(5, earlier, '2026-10-27T05:00:00Z'),
      pr(6, outsider, '2026-10-28T12:00:00Z'),
    ])}));
else if (args[1] === 'graphql') console.log(JSON.stringify({ data: { repository: {
  p1: { authorAssociation: 'MEMBER', files: { nodes: [{ path: 'src/vs/sessions/browser/list.ts' }, { path: 'src/vs/sessions/test/browser/list.test.ts' }] } },
  p2: { authorAssociation: 'MEMBER', files: { nodes: [{ path: 'src/vs/sessions/test/browser/x.test.ts' }] } },
  p3: { authorAssociation: 'OWNER', files: { nodes: [{ path: 'build/gulpfile.js' }, { path: 'package.json' }] } },
  p6: { authorAssociation: 'CONTRIBUTOR', files: { nodes: [{ path: 'src/vs/sessions/browser/list.ts' }] } },
} } }));
else { console.error('unexpected: ' + joined); process.exit(1); }
`,
      { mode: 0o755 },
    );
    const out = join(root, 'prs.json');
    const result = spawnSync(process.execPath, [script('pick-prs.ts'), build, '--out', out], {
      encoding: 'utf8',
      env: { ...process.env, AGENTS_QA_ROOT: root, PATH: `${fake}:${process.env.PATH}` },
    });
    expect(result.status, result.stderr).toBe(0);
    const picked = JSON.parse(await readFile(out, 'utf8'));
    expect(picked.base).toEqual({ commit: base, date: '2026-10-28T00:00:00Z', version: '1.145.0-insider', run: 'prev', how: 'the last run’s build' });
    expect(picked.prs.map((entry: { number: number; relevance: string }) => [entry.number, entry.relevance])).toEqual(
      [
        [1, 'agents-window'],
        [2, 'test-only'],
        [3, 'engineering'],
      ],
    );
    expect(picked.notYetInBuild).toBe(1);
    expect(picked.notByMembers).toEqual(['https://github.com/microsoft/vscode/pull/6']);
    expect(JSON.stringify(picked)).not.toContain('PR 6');
    expect(result.stdout).toMatch(/3 PRs are in this build and not the base: 1 touch the Agents window/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  });
});
