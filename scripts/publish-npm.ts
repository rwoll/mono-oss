// Publish every package whose version is not on npm yet. .github/workflows/release.yml runs:
//   node scripts/publish-npm.ts plan                  # which packages to release
//   node scripts/publish-npm.ts pack --out <dir>      # build job, no npm credentials
//   node scripts/publish-npm.ts publish --from <dir>  # publish job, npm trusted publishing
//   node scripts/publish-npm.ts notes <folder> <version>
//
// A package is released when it is not "private", its version is not 0.0.0
// (unreleased), and that version is not on npm. pack and publish read the plan
// from the PLAN environment variable. In GitHub Actions, pack writes the
// tarballs' hashes as the step output `integrity`, and publish refuses tarballs
// whose hashes differ from EXPECTED_INTEGRITY, then publishes with provenance.
// Versions already on npm are skipped, so a rerun after a partial failure is safe.
// Packages are packed with pnpm, which replaces workspace: and catalog: ranges,
// and published with npm. Locally: plan, pack, then `publish --dry-run`.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REGISTRY = 'https://registry.npmjs.org/';
// Trusted publishing needs npm 11.5.1 or later.
const MIN_NPM = [11, 5, 1];
// The only publishConfig a tarball may carry. npm applies publishConfig while it
// publishes, so anything else (a proxy, TLS settings, another registry) could
// redirect the trusted publishing credential.
const PUBLISH_CONFIG = { access: 'public', registry: REGISTRY, provenance: true };
// Files written into a package while packing it: `canvas-kit init` pins new
// marketplaces' publish workflow to the mono-oss commit the kit was released from.
const STAMPS: Record<string, string> = { 'canvas-kit': 'release.json' };
const root = fileURLToPath(new URL('..', import.meta.url));

interface Release {
  name: string;
  folder: string;
  version: string;
  tag: string;
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { out: { type: 'string' }, from: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
});
const [mode, ...rest] = positionals;

function run(command: string, args: string[], options: { capture?: boolean; allowFailure?: boolean; cwd?: string } = {}) {
  console.log(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: options.capture ? 'pipe' : 'inherit', cwd: options.cwd ?? root });
  if (result.status !== 0 && !options.allowFailure) throw new Error(`${command} ${args.join(' ')} failed\n${result.stderr ?? ''}`);
  return result;
}

function output(name: string, value: string): void {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

/** The commit being released: the pushed commit in CI, or a clean local HEAD. */
function releaseCommit(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  if (run('git', ['status', '--porcelain'], { capture: true }).stdout.trim()) throw new Error('commit your changes first');
  return run('git', ['rev-parse', 'HEAD'], { capture: true }).stdout.trim();
}

function onNpm(name: string, version: string): boolean {
  const result = run('npm', ['view', `${name}@${version}`, 'version', '--registry', REGISTRY], { capture: true, allowFailure: true });
  return result.status === 0 && result.stdout.trim() === version;
}

function plan(): Release[] {
  const releases: Release[] = [];
  const packagesDir = join(root, 'packages');
  for (const folder of existsSync(packagesDir) ? readdirSync(packagesDir).sort() : []) {
    const manifestPath = join(packagesDir, folder, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const { name, version, private: isPrivate } = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (isPrivate || version === '0.0.0') continue;
    if (onNpm(name, version)) continue;
    releases.push({ name, folder, version, tag: `${folder}@${version}` });
  }
  return releases;
}

function plannedReleases(): Release[] {
  if (!process.env.PLAN) throw new Error('PLAN is not set; pass the plan job\'s releases output');
  const releases = JSON.parse(process.env.PLAN) as Release[];
  if (!releases.length) throw new Error('PLAN is empty');
  return releases;
}

function pack(out: string): void {
  mkdirSync(out, { recursive: true });
  for (const release of plannedReleases()) {
    const dir = join(root, 'packages', release.folder);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (manifest.name !== release.name || manifest.version !== release.version) {
      throw new Error(`packages/${release.folder} is ${manifest.name}@${manifest.version}, but the plan says ${release.name}@${release.version}`);
    }
    const stamp = STAMPS[release.folder];
    if (stamp) writeFileSync(join(dir, stamp), `${JSON.stringify({ commit: releaseCommit(), tag: release.tag }, null, 2)}\n`);
    try {
      run('pnpm', ['pack', '--pack-destination', out], { cwd: dir });
    } finally {
      if (stamp) rmSync(join(dir, stamp), { force: true });
    }
  }
  const found = tarballs(out);
  const lines = found.map(entry => `- \`${entry.name}@${entry.version}\` \`${entry.integrity}\``);
  console.log(`Packed:\n${lines.join('\n')}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Packed\n\n${lines.join('\n')}\n`);
  output('integrity', JSON.stringify(Object.fromEntries(found.map(entry => [entry.name, entry.integrity]))));
}

/** The tarballs in `dir`, each checked to be exactly one planned package at its planned version. */
function tarballs(dir: string) {
  const releases = plannedReleases();
  const files = readdirSync(dir).filter(name => name.endsWith('.tgz')).sort();
  const hashes = new Map(files.map(name => [name, `sha512-${createHash('sha512').update(readFileSync(join(dir, name))).digest('base64')}`]));
  // Compare hashes before reading anything inside the tarballs.
  checkIntegrity([...hashes.values()]);
  const found: (Release & { file: string; integrity: string })[] = [];
  for (const name of files) {
    const file = join(dir, name);
    const entries = run('tar', ['-tzf', file], { capture: true }).stdout.split('\n').filter(Boolean);
    if (entries.filter(entry => entry === 'package/package.json').length !== 1) throw new Error(`${name} must hold exactly one package/package.json`);
    if (entries.some(entry => /(^|\/)\.npmrc$/.test(entry))) throw new Error(`${name} contains an .npmrc`);
    const manifest = JSON.parse(run('tar', ['-xzOf', file, 'package/package.json'], { capture: true }).stdout);
    const canonical = (value: unknown) => JSON.stringify(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)));
    if (canonical(manifest.publishConfig) !== canonical(PUBLISH_CONFIG)) {
      throw new Error(`${name} has publishConfig ${JSON.stringify(manifest.publishConfig)}; only ${JSON.stringify(PUBLISH_CONFIG)} is allowed`);
    }
    const release = releases.find(candidate => candidate.name === manifest.name);
    if (!release) throw new Error(`${name} contains ${manifest.name}, which is not in the plan`);
    if (manifest.version !== release.version) throw new Error(`${name} contains ${manifest.name}@${manifest.version}, but the plan says ${release.version}`);
    const integrity = hashes.get(name) as string;
    const expected = expectedIntegrity();
    if (expected && expected[manifest.name] !== integrity) throw new Error(`${name} does not match the build job's hash for ${manifest.name}`);
    found.push({ ...release, file, integrity });
  }
  const names = found.map(entry => entry.name).sort().join();
  const want = releases.map(release => release.name).sort().join();
  if (names !== want) throw new Error(`expected one tarball each for ${want} in ${dir}, found ${names || 'none'}`);
  return found;
}

function expectedIntegrity(): Record<string, string> | undefined {
  return process.env.EXPECTED_INTEGRITY ? JSON.parse(process.env.EXPECTED_INTEGRITY) : undefined;
}

/** When publishing, the tarballs must be exactly the ones the build job packed. Required in GitHub Actions. */
function checkIntegrity(hashes: string[]): void {
  if (mode !== 'publish') return;
  const expected = expectedIntegrity();
  if (!expected) {
    if (process.env.GITHUB_ACTIONS) throw new Error('EXPECTED_INTEGRITY is not set; pass the build job\'s integrity output');
    return;
  }
  const want = Object.values(expected).sort().join();
  if (hashes.slice().sort().join() !== want) throw new Error(`the tarballs' hashes ${hashes.join(', ')} differ from the build job's ${want}`);
}

function checkNpmVersion(): void {
  const current = run('npm', ['--version'], { capture: true }).stdout.trim().split('.').map(Number);
  const index = current.findIndex((part, position) => part !== MIN_NPM[position]);
  if (index !== -1 && (current[index] as number) < (MIN_NPM[index] as number)) {
    throw new Error(`npm ${current.join('.')} cannot use trusted publishing; use npm ${MIN_NPM.join('.')} or later`);
  }
}

function publish(dir: string): void {
  if (process.env.GITHUB_ACTIONS) checkNpmVersion();
  for (const { file, name, version, integrity } of tarballs(dir)) {
    if (onNpm(name, version)) {
      console.log(`${name}@${version} is already on npm; skipping.`);
      continue;
    }
    console.log(`Publishing ${name}@${version} (${integrity})`);
    const tagArgs = version.includes('-') ? ['--tag', 'next'] : [];
    const provenanceArgs = process.env.GITHUB_ACTIONS ? ['--provenance'] : [];
    run('npm', ['publish', file, '--access', 'public', '--ignore-scripts', '--registry', REGISTRY, ...provenanceArgs, ...tagArgs, ...(values['dry-run'] ? ['--dry-run'] : [])]);
  }
}

/** The CHANGELOG.md section for `version`, for the GitHub release notes. */
function notes(folder: string, version: string): string {
  const changelog = readFileSync(join(root, 'packages', folder, 'CHANGELOG.md'), 'utf8');
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Keep a Changelog: "## [1.2.3] - 2026-11-02", up to the next heading or the link references.
  const section = new RegExp(`^## \\[${escaped}\\].*\\n([\\s\\S]*?)(?=^## |^\\[[^\\]]+\\]: |(?![\\s\\S]))`, 'm').exec(changelog);
  return section?.[1]?.trim() || `Released ${version}.`;
}

switch (mode) {
  case 'plan': {
    const releases = plan();
    console.log(releases.length ? `To release:\n${releases.map(release => `- ${release.name}@${release.version}`).join('\n')}` : 'Nothing to release.');
    output('releases', JSON.stringify(releases));
    output('any', String(releases.length > 0));
    break;
  }
  case 'pack':
    if (!values.out) throw new Error('pack needs --out <dir>');
    pack(resolve(values.out));
    break;
  case 'publish':
    if (!values.from) throw new Error('publish needs --from <dir>');
    publish(resolve(values.from));
    break;
  case 'notes': {
    const [folder, version] = rest;
    if (!folder || !version) throw new Error('notes needs <folder> <version>');
    process.stdout.write(`${notes(folder, version)}\n`);
    break;
  }
  default:
    throw new Error(`unknown mode "${mode}"; use plan, pack, publish, or notes`);
}
