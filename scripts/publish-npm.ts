// Publish every package whose version is not on npm yet. .github/workflows/release.yml runs:
//   node scripts/publish-npm.ts plan                  # which packages to release
//   node scripts/publish-npm.ts pack --out <dir> --github-out <dir>   # build job, no credentials
//   node scripts/publish-npm.ts publish --from <dir>  # publish job: stage on npm with trusted publishing
//   node scripts/publish-npm.ts release --from <dir>  # tag job: GitHub releases, with their tarballs
//   node scripts/publish-npm.ts backfill              # attach tarballs to earlier releases that lack them
//   node scripts/publish-npm.ts notes <folder> <version>
//
// A package is released when it is not "private", its version is not 0.0.0
// (unreleased), and that version is not on npm. pack and publish read the plan
// from the PLAN environment variable. In GitHub Actions, pack writes the
// tarballs' hashes as the step output `integrity`, and publish refuses tarballs
// whose hashes differ from EXPECTED_INTEGRITY, then stages them with
// `npm stage publish` through trusted publishing (with provenance from a public
// repository). A maintainer approves each staged version on npm, with 2FA.
// Versions already on npm are skipped, so a rerun after a partial failure is safe.
// Packages are packed with pnpm, which replaces workspace: and catalog: ranges,
// and published with npm. Locally: plan, pack, then `publish --dry-run`.
//
// Each GitHub release also gets a tarball: the npm one, with dependencies on other
// @rwoll packages pointing at their release tarballs (scripts/release-tarballs.ts),
// so the packages install where registry.npmjs.org is blocked. pack writes them
// with the npm tarballs and records their hashes as `github-integrity`; release
// checks them against EXPECTED_GITHUB_INTEGRITY and attaches them when it creates
// each release, which stays immutable afterwards.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readManifest, tarballName, variantProblem, writeGithubTarball, type Target } from './release-tarballs.ts';

const REGISTRY = 'https://registry.npmjs.org/';
// Trusted publishing needs npm 11.5.1 or later.
// The first npm with `npm stage`.
const MIN_NPM = [11, 15, 0];
// The only publishConfig a tarball may carry. npm applies publishConfig while it
// publishes, so anything else (a proxy, TLS settings, another registry) could
// redirect the trusted publishing credential.
const PUBLISH_CONFIG = { access: 'public', registry: REGISTRY };
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
  options: { out: { type: 'string' }, 'github-out': { type: 'string' }, from: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
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

function pack(out: string, githubOut: string): void {
  mkdirSync(out, { recursive: true });
  mkdirSync(githubOut, { recursive: true });
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

  const planned = new Set(plannedReleases().map(release => tarballName(release.name, release.version)));
  for (const entry of found) {
    const { targets } = writeGithubTarball(entry.file, githubOut);
    checkTargets(entry.name, targets, planned);
  }
  const github = githubTarballs(githubOut);
  console.log(`GitHub release tarballs:\n${github.map(entry => `- \`${entry.name}@${entry.version}\` \`${entry.integrity}\``).join('\n')}`);
  output('github-integrity', JSON.stringify(Object.fromEntries(github.map(entry => [entry.name, entry.integrity]))));
}

/** Every release a GitHub tarball points at must be released in this run, or already have its tarball. */
function checkTargets(name: string, targets: Target[], planned: Set<string>): void {
  for (const target of targets) {
    if (planned.has(tarballName(target.name, target.version))) continue;
    const head = run('curl', ['-sfIL', '--max-time', '30', '-o', '/dev/null', target.url], { capture: true, allowFailure: true });
    if (head.status !== 0) throw new Error(`${name} depends on ${target.name}@${target.version}, whose release has no tarball at ${target.url}; release it first, or run backfill`);
  }
}

const sha512 = (file: string) => `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`;

/** The GitHub tarballs in `dir`: exactly one per planned release, each with release URLs for @rwoll dependencies. */
function githubTarballs(dir: string) {
  const releases = plannedReleases();
  const found = readdirSync(dir)
    .filter(name => name.endsWith('.tgz'))
    .sort()
    .map(name => {
      const file = join(dir, name);
      const integrity = sha512(file);
      const expected = process.env.EXPECTED_GITHUB_INTEGRITY ? (JSON.parse(process.env.EXPECTED_GITHUB_INTEGRITY) as Record<string, string>) : undefined;
      if (mode === 'release' && !expected && process.env.GITHUB_ACTIONS) throw new Error('EXPECTED_GITHUB_INTEGRITY is not set; pass the build job\'s github-integrity output');
      if (expected && !Object.values(expected).includes(integrity)) throw new Error(`${name} does not match any of the build job's GitHub tarball hashes`);
      const manifest = readManifest(file);
      const release = releases.find(candidate => candidate.name === manifest.name && candidate.version === manifest.version);
      if (!release || name !== tarballName(manifest.name, manifest.version)) throw new Error(`${name} contains ${manifest.name}@${manifest.version}, which is not in the plan`);
      const problem = variantProblem(manifest, 'github');
      if (problem) throw new Error(problem);
      return { ...release, file, integrity };
    });
  const names = found.map(entry => entry.name).sort().join();
  const want = releases.map(release => release.name).sort().join();
  if (names !== want) throw new Error(`expected one GitHub tarball each for ${want} in ${dir}, found ${names || 'none'}`);
  return found;
}

/** Creates each planned release with its notes and GitHub tarball, which can't be added once it's published. */
function release(dir: string): void {
  const commit = releaseCommit();
  const notesDir = mkdtempSync(join(tmpdir(), 'release-notes-'));
  for (const entry of githubTarballs(dir)) {
    if (run('gh', ['release', 'view', entry.tag], { capture: true, allowFailure: true }).status === 0) {
      console.log(`${entry.tag} already exists.`);
      continue;
    }
    const notesFile = join(notesDir, `${entry.folder}.md`);
    writeFileSync(notesFile, `${notes(entry.folder, entry.version)}\n`);
    const prerelease = entry.version.includes('-') ? ['--prerelease'] : [];
    run('gh', ['release', 'create', entry.tag, '--target', commit, '--title', `${entry.name}@${entry.version}`, '--notes-file', notesFile, ...prerelease, entry.file]);
  }
}

/**
 * Attaches GitHub tarballs to releases made before they existed, from the tarballs on npm. Releases that
 * other backfilled tarballs point at go first. Versions not approved on npm yet are left for a later run.
 */
function backfill(): void {
  const releases = run('gh', ['api', '--paginate', 'repos/{owner}/{repo}/releases', '--jq', '.[] | {tag: .tag_name, immutable, assets: [.assets[].name]}'], { capture: true })
    .stdout.split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as { tag: string; immutable: boolean; assets: string[] });
  const work = mkdtempSync(join(tmpdir(), 'backfill-'));
  const pending: { tag: string; file: string; targets: Target[] }[] = [];
  for (const { tag, immutable, assets } of releases) {
    const match = /^([a-z0-9-]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
    if (!match) continue;
    const [, folder, version] = match as unknown as [string, string, string];
    const name = `@rwoll/${folder}`;
    if (assets.includes(tarballName(name, version))) continue;
    if (immutable) {
      console.log(`${tag} is immutable and has no tarball; it can't get one.`);
      continue;
    }
    if (!onNpm(name, version)) {
      console.log(`${name}@${version} isn't on npm yet; skipping ${tag} for now.`);
      continue;
    }
    const npmDir = join(work, 'npm');
    mkdirSync(npmDir, { recursive: true });
    run('npm', ['pack', `${name}@${version}`, '--pack-destination', npmDir, '--registry', REGISTRY, '--ignore-scripts']);
    const githubDir = join(work, 'github');
    mkdirSync(githubDir, { recursive: true });
    pending.push({ tag, ...writeGithubTarball(join(npmDir, tarballName(name, version)), githubDir) });
  }
  const uploading = new Set(pending.map(entry => basename(entry.file)));
  const order = [...pending].sort((a, b) => a.targets.length - b.targets.length);
  for (const entry of order) {
    for (const target of entry.targets) {
      if (uploading.has(tarballName(target.name, target.version))) continue;
      const head = run('curl', ['-sfIL', '--max-time', '30', '-o', '/dev/null', target.url], { capture: true, allowFailure: true });
      if (head.status !== 0) throw new Error(`${entry.tag} points at ${target.url}, which doesn't exist`);
    }
    if (values['dry-run']) console.log(`Would attach ${entry.file} to ${entry.tag}.`);
    else run('gh', ['release', 'upload', entry.tag, entry.file]);
  }
  rmSync(work, { recursive: true, force: true });
  if (!pending.length) console.log('Every release has its tarball.');
}

/** The tarballs in `dir`, each checked to be exactly one planned package at its planned version. */
function tarballs(dir: string) {
  const releases = plannedReleases();
  const files = readdirSync(dir).filter(name => name.endsWith('.tgz')).sort();
  const hashes = new Map(files.map(name => [name, sha512(join(dir, name))]));
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
    const problem = variantProblem(manifest, 'npm');
    if (problem) throw new Error(problem);
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
    throw new Error(`npm ${current.join('.')} cannot stage packages; use npm ${MIN_NPM.join('.')} or later`);
  }
}

function publish(dir: string): void {
  if (process.env.GITHUB_ACTIONS) checkNpmVersion();
  const staged: string[] = [];
  for (const { file, name, version, integrity } of tarballs(dir)) {
    if (onNpm(name, version)) {
      console.log(`${name}@${version} is already on npm; skipping.`);
      continue;
    }
    console.log(`Staging ${name}@${version} (${integrity})`);
    const tagArgs = version.includes('-') ? ['--tag', 'next'] : [];
    run('npm', ['stage', 'publish', file, '--access', 'public', '--ignore-scripts', '--registry', REGISTRY, ...tagArgs, ...(values['dry-run'] ? ['--dry-run'] : [])]);
    staged.push(`${name}@${version}`);
  }
  if (staged.length && process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        `Staged on npm, waiting for approval: ${staged.join(', ')}.`,
        '',
        'Approve each with 2FA on npmjs.com, or run `npm stage list <package>` and `npm stage approve <stage-id>`.',
        '',
      ].join('\n'),
    );
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
    if (!values.out || !values['github-out']) throw new Error('pack needs --out <dir> and --github-out <dir>');
    pack(resolve(values.out), resolve(values['github-out']));
    break;
  case 'release':
    if (!values.from) throw new Error('release needs --from <dir>');
    release(resolve(values.from));
    break;
  case 'backfill':
    backfill();
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
    throw new Error(`unknown mode "${mode}"; use plan, pack, publish, release, backfill, or notes`);
}
