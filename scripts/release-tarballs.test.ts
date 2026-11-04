import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { githubManifest, readManifest, releaseUrl, tarballName, variantProblem, writeGithubTarball, type Manifest } from './release-tarballs.ts';

const CANVAS_KIT_URL = 'https://github.com/rwoll/mono-oss/releases/download/canvas-kit%400.3.0/rwoll-canvas-kit-0.3.0.tgz';
const work = mkdtempSync(join(tmpdir(), 'release-tarballs-test-'));
after(() => rmSync(work, { recursive: true, force: true }));

/** An npm-style tarball (everything under package/) with this manifest and an executable bin. */
function npmTarball(manifest: Manifest): string {
  const dir = mkdtempSync(join(work, 'pkg-'));
  mkdirSync(join(dir, 'package', 'bin'), { recursive: true });
  writeFileSync(join(dir, 'package', 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'package', 'bin', 'cli.js'), '#!/usr/bin/env node\n');
  chmodSync(join(dir, 'package', 'bin', 'cli.js'), 0o755);
  const file = join(dir, tarballName(manifest.name, manifest.version));
  assert.equal(spawnSync('tar', ['-czf', file, '-C', dir, 'package']).status, 0);
  return file;
}

describe('GitHub release tarballs', () => {
  it('names tarballs and release URLs the way npm and the release tags do', () => {
    assert.equal(tarballName('@rwoll/canvas-kit', '0.3.0'), 'rwoll-canvas-kit-0.3.0.tgz');
    assert.equal(releaseUrl('@rwoll/canvas-kit', '0.3.0'), CANVAS_KIT_URL);
  });

  it('points @rwoll dependencies at the release of the version they were packed from, and leaves the rest', () => {
    const { manifest, targets } = githubManifest({
      name: '@rwoll/create-canvas',
      version: '0.4.0',
      dependencies: { '@rwoll/canvas-kit': '^0.3.0', zod: '^4.6.7' },
      optionalDependencies: { '@rwoll/hello': '1.0.0-beta.1' },
      peerDependencies: { react: '^19.0.0' },
    });
    assert.deepEqual(manifest.dependencies, { '@rwoll/canvas-kit': CANVAS_KIT_URL, zod: '^4.6.7' });
    assert.equal(manifest.optionalDependencies?.['@rwoll/hello'], releaseUrl('@rwoll/hello', '1.0.0-beta.1'));
    assert.deepEqual(manifest.peerDependencies, { react: '^19.0.0' });
    assert.deepEqual(targets.map(target => `${target.name}@${target.version}`), ['@rwoll/canvas-kit@0.3.0', '@rwoll/hello@1.0.0-beta.1']);
    assert.equal(variantProblem(manifest, 'github'), null);
  });

  it('refuses ranges that name no single version, and @rwoll peer dependencies', () => {
    assert.throws(() => githubManifest({ name: '@rwoll/a', version: '1.0.0', dependencies: { '@rwoll/b': '>=1.0.0' } }), /range of one version/);
    assert.throws(() => githubManifest({ name: '@rwoll/a', version: '1.0.0', peerDependencies: { '@rwoll/b': '^1.0.0' } }), /peer dependencies/);
  });

  it('tells the variants apart', () => {
    const npm: Manifest = { name: '@rwoll/a', version: '1.0.0', dependencies: { '@rwoll/canvas-kit': '^0.3.0' } };
    assert.equal(variantProblem(npm, 'npm'), null);
    assert.match(variantProblem(npm, 'github') ?? '', /not a release URL/);
    assert.match(variantProblem({ ...npm, dependencies: { '@rwoll/canvas-kit': CANVAS_KIT_URL } }, 'npm') ?? '', /not a version range/);
  });

  it('rewrites only package.json in the tarball, and copies tarballs with nothing to rewrite unchanged', () => {
    const out = mkdtempSync(join(work, 'out-'));
    const rewritten = writeGithubTarball(npmTarball({ name: '@rwoll/create-canvas', version: '0.4.0', dependencies: { '@rwoll/canvas-kit': '^0.3.0' } }), out);
    assert.deepEqual(readManifest(rewritten.file).dependencies, { '@rwoll/canvas-kit': CANVAS_KIT_URL });
    const extracted = mkdtempSync(join(work, 'x-'));
    assert.equal(spawnSync('tar', ['-xzf', rewritten.file, '-C', extracted]).status, 0);
    assert.equal(statSync(join(extracted, 'package', 'bin', 'cli.js')).mode & 0o111, 0o111);

    const plain = npmTarball({ name: '@rwoll/annotate', version: '0.1.0', dependencies: { zod: '^4.6.7' } });
    const copied = writeGithubTarball(plain, out);
    assert.deepEqual(readFileSync(copied.file), readFileSync(plain));
    assert.deepEqual(copied.targets, []);
  });
});
