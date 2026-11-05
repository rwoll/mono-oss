// Test the packages the way someone outside this repository gets them: pack
// @rwoll/canvas-kit and @rwoll/create-canvas as npm would publish them, create a
// marketplace with the packed create-canvas, install the packed kit, and run the
// new marketplace's checks and browser tests. Then install the packed
// @rwoll/blobby-sandbox into a new project and run its CLI and SDK, and check that
// it ships the desktop image's build files.
//   pnpm consumer-test [--keep] [--no-e2e]
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({ options: { keep: { type: 'boolean' }, 'no-e2e': { type: 'boolean' } } });

function run(command: string, args: string[], cwd: string): void {
  console.log(`\n$ ${command} ${args.join(' ')}   (in ${cwd})`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
}

const work = await mkdtemp(join(tmpdir(), 'canvas-kit-consumer-'));
try {
  run('pnpm', ['--filter', '@rwoll/canvas-kit', '--filter', '@rwoll/create-canvas', 'build'], root);
  const tarballs = join(work, 'tarballs');
  await mkdir(tarballs);
  for (const name of ['canvas-kit', 'create-canvas']) {
    run('pnpm', ['pack', '--pack-destination', tarballs], join(root, 'packages', name));
  }
  const files = await readdir(tarballs);
  const tarball = (prefix: string): string => {
    const file = files.find(name => name.startsWith(prefix));
    if (!file) throw new Error(`no ${prefix}*.tgz in ${tarballs}`);
    return join(tarballs, file);
  };
  const kit = tarball('rwoll-canvas-kit-');
  const create = tarball('rwoll-create-canvas-');

  // Run the packed create-canvas with the packed kit, as `npm create` would.
  const runner = join(work, 'runner');
  await mkdir(runner);
  await copyFile(join(root, '.npmrc'), join(runner, '.npmrc'));
  await writeFile(join(runner, 'package.json'), JSON.stringify({ name: 'runner', private: true, type: 'module' }));
  await writeFile(
    join(runner, 'pnpm-workspace.yaml'),
    `ignoreScripts: true\ntrustLockfile: true\noverrides:\n  '@rwoll/canvas-kit': ${JSON.stringify(`file:${kit}`)}\n`,
  );
  run('pnpm', ['add', `file:${create}`], runner);
  run('pnpm', ['exec', 'create-canvas', join(work, 'market'), '--repository', 'octo/market', '--canvas', 'board'], runner);

  // Point the new marketplace at the packed kit until it is on npm.
  const market = join(work, 'market');
  await copyFile(join(root, '.npmrc'), join(market, '.npmrc'));
  const workspace = await readFile(join(market, 'pnpm-workspace.yaml'), 'utf8');
  await writeFile(
    join(market, 'pnpm-workspace.yaml'),
    `${workspace}\ntrustLockfile: true\noverrides:\n  '@rwoll/canvas-kit': ${JSON.stringify(`file:${kit}`)}\n`,
  );
  run('pnpm', ['install'], market);
  run('pnpm', ['check'], market);
  if (!values['no-e2e']) {
    run('pnpm', ['run', 'playwright:install'], market);
    run('pnpm', ['e2e'], market);
  }
  console.log(`\nConsumer test passed in ${market}.`);

  // blobby-sandbox: the CLI and SDK from the packed tarball, without its optional backends.
  run('pnpm', ['--filter', '@rwoll/blobby-sandbox', 'build'], root);
  run('pnpm', ['pack', '--pack-destination', tarballs], join(root, 'packages', 'blobby-sandbox'));
  const blobby = (await readdir(tarballs)).find(name => name.startsWith('rwoll-blobby-sandbox-'));
  if (!blobby) throw new Error(`no rwoll-blobby-sandbox-*.tgz in ${tarballs}`);
  const app = join(work, 'blobby-app');
  await mkdir(app);
  await copyFile(join(root, '.npmrc'), join(app, '.npmrc'));
  await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'blobby-app', private: true, type: 'module' }));
  await writeFile(join(app, 'pnpm-workspace.yaml'), 'ignoreScripts: true\n');
  run('pnpm', ['add', `file:${join(tarballs, blobby)}`], app);
  run('pnpm', ['exec', 'blobby-sandbox', '--version'], app);
  run('pnpm', ['exec', 'blobby-sandbox', '--help'], app);
  await writeFile(
    join(app, 'check.mjs'),
    [
      "import { buildImage, connect, desktopImageDir } from '@rwoll/blobby-sandbox'",
      "import { FakeBackend } from '@rwoll/blobby-sandbox/testing'",
      "if (typeof connect !== 'function' || typeof buildImage !== 'function' || typeof FakeBackend !== 'function') throw new Error('missing exports')",
      "if (!(await desktopImageDir())) throw new Error('the desktop image build files are missing')",
      "console.log('blobby-sandbox SDK ok')",
    ].join('\n'),
  );
  run('node', ['check.mjs'], app);
  console.log(`\nblobby-sandbox consumer test passed in ${app}.`);
} finally {
  if (values.keep) console.log(`Kept ${work}`);
  else await rm(work, { recursive: true, force: true });
}
