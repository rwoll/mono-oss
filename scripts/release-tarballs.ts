// The GitHub release copy of a package: the tarball published to npm, except that dependencies on other
// @rwoll packages point at those packages' GitHub release tarballs instead of version ranges. Machines that
// can't reach registry.npmjs.org install it from its release URL; every other dependency still comes from
// npm's configured registry. scripts/publish-npm.ts makes and attaches these copies.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

export const RELEASES_URL = 'https://github.com/rwoll/mono-oss/releases/download';
const SCOPE = '@rwoll/';
// The fields npm installs for a package's dependents. devDependencies never are.
const INSTALLED = ['dependencies', 'optionalDependencies'] as const;
const SINGLE_VERSION = /^[\^~]?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

export type Manifest = { name: string; version: string } & Partial<Record<(typeof INSTALLED)[number] | 'peerDependencies', Record<string, string>>>;

export interface Target {
  name: string;
  version: string;
  url: string;
}

/** npm's file name for a package's tarball: `@rwoll/canvas-kit` 0.3.0 is `rwoll-canvas-kit-0.3.0.tgz`. */
export function tarballName(name: string, version: string): string {
  return `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
}

/** The release tag, `<folder>@<version>`; every package's folder is its name without the scope. */
export function releaseTag(name: string, version: string): string {
  return `${name.slice(SCOPE.length)}@${version}`;
}

export function releaseUrl(name: string, version: string): string {
  return `${RELEASES_URL}/${encodeURIComponent(releaseTag(name, version))}/${tarballName(name, version)}`;
}

/**
 * The manifest with each @rwoll dependency pointing at the release of the version its range was packed
 * from (pnpm writes `workspace:^` as `^<that version>`), and the releases it points at.
 */
export function githubManifest(manifest: Manifest): { manifest: Manifest; targets: Target[] } {
  const scoped = Object.keys(manifest.peerDependencies ?? {}).filter(name => name.startsWith(SCOPE));
  if (scoped.length) throw new Error(`${manifest.name} has @rwoll peer dependencies (${scoped.join(', ')}), which a release URL can't satisfy`);
  const targets: Target[] = [];
  const result: Manifest = { ...manifest };
  for (const field of INSTALLED) {
    const dependencies = manifest[field];
    if (!dependencies) continue;
    result[field] = Object.fromEntries(
      Object.entries(dependencies).map(([name, range]) => {
        if (!name.startsWith(SCOPE)) return [name, range];
        const version = SINGLE_VERSION.exec(range)?.[1];
        if (!version) throw new Error(`${manifest.name} depends on ${name}@${range}; a release URL needs a range of one version, such as ^1.2.3`);
        const url = releaseUrl(name, version);
        targets.push({ name, version, url });
        return [name, url];
      }),
    );
  }
  return { manifest: result, targets };
}

/** Why a manifest isn't the variant it should be, or null: npm's has version ranges for @rwoll packages, GitHub's has release URLs. */
export function variantProblem(manifest: Manifest, variant: 'npm' | 'github'): string | null {
  for (const field of INSTALLED) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (!name.startsWith(SCOPE)) continue;
      const isUrl = spec.startsWith(`${RELEASES_URL}/`);
      if (variant === 'npm' && !SINGLE_VERSION.test(spec)) return `${manifest.name}'s npm tarball has ${field}.${name} = ${spec}, not a version range`;
      if (variant === 'github' && !isUrl) return `${manifest.name}'s GitHub tarball has ${field}.${name} = ${spec}, not a release URL`;
    }
  }
  return null;
}

function tar(args: string[]): string {
  const result = spawnSync('tar', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`tar ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

export function readManifest(file: string): Manifest {
  return JSON.parse(tar(['-xzOf', file, 'package/package.json'])) as Manifest;
}

/** Writes the GitHub copy of an npm tarball into `outDir`, under the same file name. */
export function writeGithubTarball(file: string, outDir: string): { file: string; targets: Target[] } {
  const out = join(outDir, basename(file));
  const { manifest, targets } = githubManifest(readManifest(file));
  if (!targets.length) {
    copyFileSync(file, out);
    return { file: out, targets };
  }
  const work = mkdtempSync(join(tmpdir(), 'github-tarball-'));
  try {
    tar(['-xzf', file, '-C', work]);
    writeFileSync(join(work, 'package', 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    tar(['-czf', out, '-C', work, 'package']);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (readFileSync(out).length === 0) throw new Error(`${out} is empty`);
  return { file: out, targets };
}
