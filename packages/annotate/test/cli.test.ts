import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';
import { writeScreen } from './fixtures.ts';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'annotate-cli-'));
  await writeScreen(join(dir, 'shot.png'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

async function run(...argv: string[]) {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, { stdout: { write: text => (stdout += text) }, stderr: { write: text => (stderr += text) } });
  return { code, stdout, stderr };
}

describe('annotate CLI', () => {
  it('init writes a document with the size, and refuses to overwrite it', async () => {
    const shot = join(dir, 'shot.png');
    expect(await run('init', shot)).toMatchObject({ code: 0, stdout: expect.stringMatching(/1280×800 image/) });
    expect(JSON.parse(await readFile(join(dir, 'shot.annotate.json'), 'utf8'))).toEqual({
      version: 1,
      source: { path: 'shot.png', width: 1280, height: 800 },
      annotations: [],
    });
    expect(await run('init', shot)).toMatchObject({ code: 1, stderr: expect.stringMatching(/already exists/) });
  });

  it('check reports problems and fails on errors', async () => {
    const doc = join(dir, 'check.json');
    await writeFile(doc, JSON.stringify({ version: 1, source: { path: 'shot.png' }, annotations: [{ type: 'arrow', from: [1, 1], to: 'nope' }] }));
    expect(await run('check', doc)).toMatchObject({ code: 1, stdout: expect.stringMatching(/error: annotations\.0\.to: no annotation has the id "nope"/) });
    await writeFile(doc, JSON.stringify({ version: 1, source: { path: 'shot.png' }, annotations: [{ id: 'a', type: 'rect', box: [1, 1, 10, 10] }] }));
    expect(await run('check', doc)).toMatchObject({ code: 0, stdout: 'OK: 1280×800, still, 1 annotation, 0 camera shots, 0 captions.\n' });
    await writeFile(doc, JSON.stringify({ version: 1, source: { path: 'missing.png' } }));
    expect(await run('check', doc)).toMatchObject({ code: 1, stdout: expect.stringMatching(/missing\.png does not exist/) });
  });

  it('renders several outputs and exports captions', async () => {
    const doc = join(dir, 'render.json');
    await writeFile(doc, JSON.stringify({ version: 1, source: { path: 'shot.png' }, narration: [{ t: 0, text: 'Hello <there>' }] }));
    const result = await run('render', doc, '-o', join(dir, 'a.png'), '-o', join(dir, 'b.webp'), '--width', '640');
    expect(result).toMatchObject({ code: 0, stdout: expect.stringMatching(/Wrote .*a\.png \(640×400\)\.\nWrote .*b\.webp \(640×400\)\.\n/) });
    expect(await run('captions', doc, '--format', 'md')).toMatchObject({ code: 0, stdout: expect.stringContaining('- `0:00.0` Hello <there>') });
  });

  it('prints the JSON Schema, help, and usage errors', async () => {
    const schema = JSON.parse((await run('schema')).stdout) as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(['source', 'annotations', 'narration', 'camera']));
    expect(await run('--help')).toMatchObject({ code: 0, stdout: expect.stringMatching(/^annotate:/) });
    expect(await run('render', 'x.json')).toMatchObject({ code: 2, stderr: expect.stringMatching(/at least one -o/) });
    expect(await run('nope')).toMatchObject({ code: 2 });
  });
});
