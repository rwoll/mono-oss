#!/usr/bin/env node
// Installs the command-line tools that these skills run, globally with npm, so they don't need npx:
//   node install-tools.ts [agent-test-server] [annotate] [blobby-sandbox] [--azure] [--check] [--dry-run]
// With no names, it installs every tool. Each tool comes from its newest GitHub release in rwoll/mono-oss,
// not from registry.npmjs.org, which some machines can't reach: the script downloads the release's tarball,
// checks it against the SHA-256 digest GitHub shows for it, and installs that file. Other @rwoll packages
// it needs come from their own releases; everything else comes from npm's configured registry, only once
// it has been published for 7 days. npm older than 11.10 silently ignores that cooldown, so the script
// refuses to run with it. --check only reports what's installed, and which tools are older than their newest
// release. --dry-run says what it would install.
// --azure also installs the SDK that blobby-sandbox's azure backend needs.
//
// Where registry.npmjs.org is blocked, npm's default registry, the dependencies come from MIRROR instead,
// for this install only. When a registry serves its downloads from another host, as Azure Artifacts feeds
// do, the script passes --replace-registry-host for it, since npm 12 refuses downloads from other hosts.
// It never reads or writes npm's config files and never sends credentials: only these flags.
//
// Every skill that needs it ships an identical copy of this file. It uses only Node.js and npm, and
// GitHub's public API without a token.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPOSITORY = 'rwoll/mono-oss'
export const NPM_REGISTRY = 'https://registry.npmjs.org/'
/** Microsoft's public 1ES mirror of the npm registry, used when registry.npmjs.org is blocked. No token needed. */
export const MIRROR = 'https://ms-feed-25.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/'
const PROBE_TIMEOUT_MS = 8000
export const COOLDOWN_DAYS = 7
export const MIN_NPM = '11.10.0'
/** Each tool's command and the package that provides it. */
export const TOOLS: Readonly<Record<string, string>> = Object.freeze({
  'agent-test-server': '@rwoll/agent-test-server',
  annotate: '@rwoll/annotate',
  'blobby-sandbox': '@rwoll/blobby-sandbox',
})
/** blobby-sandbox's smolvm backend needs this next to it, on hosts smolvm runs on. Keep it at blobby-sandbox's peer dependency. */
export const SMOLMACHINES = 'smolmachines@1.31.0'
/** blobby-sandbox's azure backend needs this next to it, with --azure. Keep it at blobby-sandbox's peer dependency. */
export const AZURE_SDK = '@azure/containerapps-sandbox@1.0.0-beta.1'
const SMOLVM_HOSTS = new Set(['darwin-arm64', 'linux-x64', 'linux-arm64'])
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/

export interface Result {
  code: number
  stdout: string
  stderr: string
}

/** Runs a command without a shell (except Windows' .cmd launchers). `inherit` shows its output as it runs. */
export type Runner = (command: string, args: string[], options?: { inherit?: boolean }) => Promise<Result>

const runCommand: Runner = (command, args, { inherit = false } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: process.platform === 'win32', stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })

/** Whether version `a` is `b` or later. Pre-release suffixes are ignored. */
export function atLeast(a: string, b: string): boolean {
  const parse = (version: string) => (version.trim().replace(/^v/, '').split(/[-+]/)[0] ?? '').split('.').map(Number)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  }
  return true
}

/** npm's file name for a package's tarball: `@rwoll/annotate` 0.1.0 is `rwoll-annotate-0.1.0.tgz`. */
export const tarballName = (name: string, version: string) => `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`

interface GitHubRelease {
  tag_name: string
  draft: boolean
  prerelease: boolean
  assets: { name: string; browser_download_url: string; digest?: string | null }[]
}

export interface Release {
  tool: string
  version: string
  url: string
  sha256: string
}

/** The newest full release of each tool, with its tarball's URL and digest. */
export async function newestReleases(tools: string[], fetchFn: typeof fetch): Promise<Release[]> {
  const releases: GitHubRelease[] = []
  for (let page = 1; page <= 10; page++) {
    const response = await fetchFn(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=100&page=${page}`, { headers: { accept: 'application/vnd.github+json' } })
    if (!response.ok) throw new Error(`GitHub's API answered ${response.status} for ${REPOSITORY}'s releases${response.status === 403 ? '; its limit for requests without a token resets within an hour' : ''}.`)
    const batch = (await response.json()) as GitHubRelease[]
    releases.push(...batch)
    if (batch.length < 100) break
  }
  return tools.map((tool) => {
    const name = TOOLS[tool] ?? tool
    const newest = releases
      .filter((release) => !release.draft && !release.prerelease && release.tag_name.startsWith(`${tool}@`) && VERSION.test(release.tag_name.slice(tool.length + 1)))
      .sort((a, b) => (atLeast(a.tag_name.slice(tool.length + 1), b.tag_name.slice(tool.length + 1)) ? -1 : 1))[0]
    if (!newest) throw new Error(`${name} has no release yet. See its README to build it from source.`)
    const version = newest.tag_name.slice(tool.length + 1)
    const asset = newest.assets.find((candidate) => candidate.name === tarballName(name, version))
    if (!asset) throw new Error(`The ${newest.tag_name} release has no ${tarballName(name, version)} yet. Try again later.`)
    const sha256 = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? '')?.[1]
    if (!sha256) throw new Error(`GitHub shows no SHA-256 digest for ${asset.name}, so it can't be checked.`)
    return { tool, version, url: asset.browser_download_url, sha256 }
  })
}

/** The `npm` arguments that install these tarballs, and any other packages, globally. */
export function npmArgs(files: string[], flags: string[] = []): string[] {
  return ['install', '--global', `--min-release-age=${COOLDOWN_DAYS}`, '--ignore-scripts', ...flags, ...files]
}

type Manifest = { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }

/** The package.json in an npm tarball, read without unpacking anything else. */
export function tarballManifest(tgz: Uint8Array): Manifest {
  const tar = gunzipSync(tgz)
  const field = (header: Buffer, start: number, end: number) => header.subarray(start, end).toString('utf8').replace(/\0[\s\S]*$/, '')
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512)
    const name = field(header, 0, 100)
    if (!name) break
    const prefix = field(header, 345, 500)
    const size = parseInt(field(header, 124, 136).trim() || '0', 8)
    const body = offset + 512
    if ((prefix ? `${prefix}/${name}` : name) === 'package/package.json') return JSON.parse(tar.subarray(body, body + size).toString('utf8')) as Manifest
    offset = body + Math.ceil(size / 512) * 512
  }
  throw new Error('The tarball has no package/package.json.')
}

const withSlash = (url: string) => (url.endsWith('/') ? url : `${url}/`)

/**
 * Looks `dependency` up on `registry`. Resolves with where its downloads come from, `prefix`, when that's
 * another host or path than the registry's own, null when it's the registry's, or false when the registry
 * doesn't answer.
 */
export async function probeRegistry(registry: string, dependency: string, fetchFn: typeof fetch): Promise<string | null | false> {
  let response: Response
  try {
    response = await fetchFn(`${withSlash(registry)}${dependency.replace('/', '%2f')}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
  } catch {
    return false
  }
  if (!response.ok) return false
  const packument = (await response.json().catch(() => null)) as { 'dist-tags'?: { latest?: string }; versions?: Record<string, { dist?: { tarball?: string } }> } | null
  const latest = packument?.['dist-tags']?.latest
  const tarball = latest ? packument?.versions?.[latest]?.dist?.tarball : undefined
  const at = tarball?.indexOf(`/${dependency}/-/`) ?? -1
  if (!tarball || at <= 0) return null
  const prefix = tarball.slice(0, at)
  return withSlash(prefix).startsWith(withSlash(registry)) ? null : prefix
}

/**
 * The npm flags that let these dependencies install: none when npm's registry works as configured,
 * --registry when registry.npmjs.org is blocked and the mirror works, and --replace-registry-host when the
 * registry in use serves downloads from elsewhere. Throws when no registry answers.
 */
export async function registryFlags(dependencies: string[], configured: string, fetchFn: typeof fetch, log: (line: string) => void): Promise<string[]> {
  const dependency = dependencies[0]
  if (!dependency) return []
  const candidates = withSlash(configured) === NPM_REGISTRY ? [configured, MIRROR] : [configured]
  for (const registry of candidates) {
    const prefix = await probeRegistry(registry, dependency, fetchFn)
    if (prefix === false) continue
    const flags: string[] = []
    if (registry !== configured) {
      log(`${configured} isn't reachable, so this install gets its dependencies from ${registry}.`)
      flags.push(`--registry=${registry}`)
    }
    if (prefix) flags.push(`--replace-registry-host=${prefix}`)
    return flags
  }
  throw new Error(
    `Can't reach npm's registry, ${candidates.join(', or ')}, for ${dependency} and the tools' other dependencies. Check your network, or point npm at a mirror you can reach: npm config set registry <url>.`,
  )
}

/** The tools' dependencies that come from a registry: not other @rwoll packages, which come from their releases. */
function registryDependencies(manifests: Manifest[]): string[] {
  const names = manifests.flatMap((manifest) => Object.entries({ ...manifest.optionalDependencies, ...manifest.dependencies }))
  return [...new Set(names.filter(([name, spec]) => !name.startsWith('@rwoll/') && !/^[a-z+]+:/.test(spec)).map(([name]) => name))]
}

export interface Options {
  names?: string[]
  check?: boolean
  dryRun?: boolean
  azure?: boolean
  run?: Runner
  fetch?: typeof fetch
  log?: (line: string) => void
  platform?: NodeJS.Platform
  arch?: string
}

/** Installs, or with `check` only reports, the tools. Resolves with the exit code: 0, 1 (failed), or 2 (usage). */
export async function installTools({ names = [], check = false, dryRun = false, azure = false, run = runCommand, fetch: fetchFn = fetch, log = console.log, platform = process.platform, arch = process.arch }: Options = {}): Promise<number> {
  const unknown = names.filter((name) => !(name in TOOLS))
  if (unknown.length) {
    log(`Unknown tool: ${unknown.join(', ')}. The tools are ${Object.keys(TOOLS).join(', ')}.`)
    return 2
  }
  const tools = names.length ? [...new Set(names)] : Object.keys(TOOLS)
  const npm = platform === 'win32' ? 'npm.cmd' : 'npm'

  if (!check) {
    const version = await run(npm, ['--version']).catch(() => null)
    if (!version || version.code !== 0) {
      log('npm is not installed. Install Node.js 24 or later, which includes npm, then run this again.')
      return 1
    }
    if (!atLeast(version.stdout, MIN_NPM)) {
      log(`npm ${version.stdout.trim()} can't enforce the ${COOLDOWN_DAYS}-day cooldown on dependencies; it needs npm ${MIN_NPM} or later. Update npm, then run this again.`)
      return 1
    }
    let releases: Release[]
    try {
      releases = await newestReleases(tools, fetchFn)
    } catch (error) {
      log((error as Error).message)
      return 1
    }
    if (azure && !tools.includes('blobby-sandbox')) {
      log('--azure is for blobby-sandbox; add blobby-sandbox to the tools to install.')
      return 2
    }
    const extras = [
      ...(tools.includes('blobby-sandbox') && SMOLVM_HOSTS.has(`${platform}-${arch}`) ? [SMOLMACHINES] : []),
      ...(azure ? [AZURE_SDK] : []),
    ]
    const work = mkdtempSync(join(tmpdir(), 'install-tools-'))
    try {
      const files: string[] = []
      const manifests: Manifest[] = []
      for (const release of releases) {
        const response = await fetchFn(release.url)
        if (!response.ok) {
          log(`Couldn't download ${release.url}: ${response.status}.`)
          return 1
        }
        const bytes = Buffer.from(await response.arrayBuffer())
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        if (sha256 !== release.sha256) {
          log(`${release.url} doesn't match the digest GitHub shows for it (sha256 ${release.sha256}); nothing was installed.`)
          return 1
        }
        const file = join(work, release.url.split('/').pop() ?? `${release.tool}.tgz`)
        writeFileSync(file, bytes)
        files.push(file)
        manifests.push(tarballManifest(bytes))
      }
      const configured = (await run(npm, ['config', 'get', 'registry']).catch(() => null))?.stdout.trim() || NPM_REGISTRY
      let flags: string[]
      try {
        flags = await registryFlags([...registryDependencies(manifests), ...extras.map((spec) => spec.replace(/@[^@]*$/, ''))], configured, fetchFn, log)
      } catch (error) {
        log((error as Error).message)
        return 1
      }
      if (dryRun) {
        for (const release of releases) log(`${TOOLS[release.tool]}@${release.version}: ${release.url} (sha256 ${release.sha256})`)
        log([npm, ...npmArgs([...files.map((file) => file.split(/[\\/]/).pop() ?? file), ...extras], flags)].join(' '))
        return 0
      }
      log(`Installing ${releases.map((release) => `${TOOLS[release.tool]}@${release.version}`).concat(extras).join(', ')} globally with npm`)
      const installed = await run(npm, npmArgs([...files, ...extras], flags), { inherit: true })
      if (installed.code !== 0) {
        log(`npm install failed with exit code ${installed.code}.`)
        return 1
      }
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }

  let missing = 0
  const installed = new Map<string, string>()
  for (const tool of tools) {
    const result = await run(platform === 'win32' ? `${tool}.cmd` : tool, ['--version']).catch(() => null)
    if (result?.code === 0) {
      log(`${tool} ${result.stdout.trim()}`)
      const version = /\d+\.\d+\.\d+/.exec(result.stdout)?.[0]
      if (version) installed.set(tool, version)
      continue
    }
    missing++
    if (check) {
      log(`${tool} is not installed. Run this script without --check to install it.`)
      continue
    }
    const prefix = await run(npm, ['prefix', '--global']).catch(() => null)
    const bin = prefix?.code === 0 ? (platform === 'win32' ? prefix.stdout.trim() : join(prefix.stdout.trim(), 'bin')) : "npm's global bin folder"
    log(`${tool} was installed, but it isn't on PATH. Add ${bin} to PATH, then open a new terminal.`)
  }
  if (check && installed.size) {
    try {
      for (const release of await newestReleases([...installed.keys()], fetchFn)) {
        const version = installed.get(release.tool)!
        if (atLeast(version, release.version)) continue
        missing++
        log(`${release.tool} ${version} is older than its newest release, ${release.version}. Run this script without --check to update it.`)
      }
    } catch (error) {
      log(`Couldn't check for newer releases: ${(error as Error).message}`)
    }
  }
  return missing ? 1 : 0
}

export async function main(argv: string[]): Promise<number> {
  const flags = new Set(argv.filter((arg) => arg.startsWith('-')))
  const unknown = [...flags].filter((flag) => !['--azure', '--check', '--dry-run', '--help', '-h'].includes(flag))
  if (flags.has('--help') || flags.has('-h') || unknown.length) {
    console.log(`Usage: node install-tools.ts [${Object.keys(TOOLS).join('] [')}] [--azure] [--check] [--dry-run]`)
    return unknown.length ? 2 : 0
  }
  return installTools({ names: argv.filter((arg) => !arg.startsWith('-')), check: flags.has('--check'), dryRun: flags.has('--dry-run'), azure: flags.has('--azure') })
}

const invoked = (() => {
  try {
    return process.argv[1] ? realpathSync(process.argv[1]) : ''
  } catch {
    return ''
  }
})()
if (invoked === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2))
