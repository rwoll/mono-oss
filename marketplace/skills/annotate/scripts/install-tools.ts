#!/usr/bin/env node
// Installs the command-line tools that these skills run, globally with npm, so they don't need npx:
//   node install-tools.ts [annotate] [blobby-sandbox] [--check] [--dry-run]
// With no names, it installs every tool. Each tool comes from its newest GitHub release in rwoll/mono-oss,
// not from registry.npmjs.org, which some machines can't reach: the script downloads the release's tarball,
// checks it against the SHA-256 digest GitHub shows for it, and installs that file. Other @rwoll packages
// it needs come from their own releases; everything else comes from npm's configured registry, only once
// it has been published for 7 days. npm older than 11.10 silently ignores that cooldown, so the script
// refuses to run with it. --check only reports what's installed. --dry-run says what it would install.
//
// Every skill that needs it ships an identical copy of this file. It uses only Node.js and npm, and
// GitHub's public API without a token.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPOSITORY = 'rwoll/mono-oss'
export const COOLDOWN_DAYS = 7
export const MIN_NPM = '11.10.0'
/** Each tool's command and the package that provides it. */
export const TOOLS: Readonly<Record<string, string>> = Object.freeze({
  annotate: '@rwoll/annotate',
  'blobby-sandbox': '@rwoll/blobby-sandbox',
})
/** blobby-sandbox's smolvm backend needs this next to it, on hosts smolvm runs on. Keep it at blobby-sandbox's peer dependency. */
export const SMOLMACHINES = 'smolmachines@1.31.0'
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
export function npmArgs(files: string[]): string[] {
  return ['install', '--global', `--min-release-age=${COOLDOWN_DAYS}`, '--ignore-scripts', ...files]
}

export interface Options {
  names?: string[]
  check?: boolean
  dryRun?: boolean
  run?: Runner
  fetch?: typeof fetch
  log?: (line: string) => void
  platform?: NodeJS.Platform
  arch?: string
}

/** Installs, or with `check` only reports, the tools. Resolves with the exit code: 0, 1 (failed), or 2 (usage). */
export async function installTools({ names = [], check = false, dryRun = false, run = runCommand, fetch: fetchFn = fetch, log = console.log, platform = process.platform, arch = process.arch }: Options = {}): Promise<number> {
  const unknown = names.filter((name) => !(name in TOOLS))
  if (unknown.length) {
    log(`Unknown tool: ${unknown.join(', ')}. The tools are ${Object.keys(TOOLS).join(' and ')}.`)
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
    const extras = tools.includes('blobby-sandbox') && SMOLVM_HOSTS.has(`${platform}-${arch}`) ? [SMOLMACHINES] : []
    if (dryRun) {
      for (const release of releases) log(`${TOOLS[release.tool]}@${release.version}: ${release.url} (sha256 ${release.sha256})`)
      log([npm, ...npmArgs([...releases.map((release) => release.url.split('/').pop() ?? release.url), ...extras])].join(' '))
      return 0
    }
    const work = mkdtempSync(join(tmpdir(), 'install-tools-'))
    try {
      const files: string[] = []
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
      }
      log(`Installing ${releases.map((release) => `${TOOLS[release.tool]}@${release.version}`).concat(extras).join(', ')} globally with npm`)
      const installed = await run(npm, npmArgs([...files, ...extras]), { inherit: true })
      if (installed.code !== 0) {
        log(`npm install failed with exit code ${installed.code}.`)
        return 1
      }
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }

  let missing = 0
  for (const tool of tools) {
    const result = await run(platform === 'win32' ? `${tool}.cmd` : tool, ['--version']).catch(() => null)
    if (result?.code === 0) {
      log(`${tool} ${result.stdout.trim()}`)
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
  return missing ? 1 : 0
}

export async function main(argv: string[]): Promise<number> {
  const flags = new Set(argv.filter((arg) => arg.startsWith('-')))
  const unknown = [...flags].filter((flag) => !['--check', '--dry-run', '--help', '-h'].includes(flag))
  if (flags.has('--help') || flags.has('-h') || unknown.length) {
    console.log(`Usage: node install-tools.ts [${Object.keys(TOOLS).join('] [')}] [--check] [--dry-run]`)
    return unknown.length ? 2 : 0
  }
  return installTools({ names: argv.filter((arg) => !arg.startsWith('-')), check: flags.has('--check'), dryRun: flags.has('--dry-run') })
}

const invoked = (() => {
  try {
    return process.argv[1] ? realpathSync(process.argv[1]) : ''
  } catch {
    return ''
  }
})()
if (invoked === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2))
