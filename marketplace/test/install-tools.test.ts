import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { atLeast, installTools, SMOLMACHINES, type Result, type Runner } from '../scripts/install-tools.ts'

const ok = (stdout = ''): Result => ({ code: 0, stdout, stderr: '' })
const TARBALL = Buffer.from('the annotate tarball')
const SHA256 = createHash('sha256').update(TARBALL).digest('hex')
const DOWNLOADS = 'https://github.com/rwoll/mono-oss/releases/download'

const release = (tag: string, assets: { name: string; digest?: string | null }[], prerelease = false) => ({
  tag_name: tag,
  draft: false,
  prerelease,
  assets: assets.map((asset) => ({ browser_download_url: `${DOWNLOADS}/${encodeURIComponent(tag)}/${asset.name}`, ...asset })),
})

/** GitHub's releases API and their downloads. */
function github(releases: unknown[], body: Buffer = TARBALL) {
  const urls: string[] = []
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input)
    urls.push(url)
    if (url.startsWith('https://api.github.com/')) return new Response(JSON.stringify(releases))
    return new Response(new Uint8Array(body))
  }) as typeof fetch
  return { urls, fetch: fetchFn }
}

/** A fake npm and PATH: `answers` maps "command arg0" to a result, or to null for a missing command. */
function fake(answers: Record<string, Result | null>) {
  const calls: { command: string; args: string[] }[] = []
  const run: Runner = async (command, args) => {
    calls.push({ command, args })
    const answer = answers[`${command} ${args[0]}`]
    if (answer === null) throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' })
    return answer ?? ok()
  }
  const lines: string[] = []
  return { calls, run, lines, log: (line: string) => lines.push(line) }
}

const annotateReleases = [
  release('annotate@0.2.0', [{ name: 'rwoll-annotate-0.2.0.tgz', digest: `sha256:${SHA256}` }]),
  release('annotate@0.3.0-beta.1', [{ name: 'rwoll-annotate-0.3.0-beta.1.tgz', digest: `sha256:${SHA256}` }], true),
  release('annotate@0.1.0', [{ name: 'rwoll-annotate-0.1.0.tgz', digest: `sha256:${SHA256}` }]),
  release('canvas-kit@0.9.0', [{ name: 'rwoll-canvas-kit-0.9.0.tgz', digest: `sha256:${SHA256}` }]),
]

describe('install-tools', () => {
  it("installs the newest release's tarball after checking its digest, with a cooldown for other dependencies", async () => {
    const t = fake({ 'npm --version': ok('12.2.1\n'), 'annotate --version': ok('0.2.0\n') })
    const gh = github(annotateReleases)
    expect(await installTools({ names: ['annotate'], run: t.run, fetch: gh.fetch, log: t.log, platform: 'darwin', arch: 'arm64' })).toBe(0)
    expect(gh.urls[1]).toBe(`${DOWNLOADS}/annotate%400.2.0/rwoll-annotate-0.2.0.tgz`)
    const install = t.calls.find((call) => call.args[0] === 'install')
    expect(install?.args.slice(0, 4)).toEqual(['install', '--global', '--min-release-age=7', '--ignore-scripts'])
    expect(install?.args.slice(4)).toEqual([expect.stringMatching(/rwoll-annotate-0\.2\.0\.tgz$/)])
    expect(install?.args.join(' ')).not.toMatch(/registry/)
    expect(t.lines.at(-1)).toBe('annotate 0.2.0')
  })

  it("refuses a download that doesn't match GitHub's digest, or an asset without one", async () => {
    const t = fake({ 'npm --version': ok('12.2.1') })
    expect(await installTools({ names: ['annotate'], run: t.run, fetch: github(annotateReleases, Buffer.from('tampered')).fetch, log: t.log })).toBe(1)
    expect(t.lines.at(-1)).toMatch(/doesn't match the digest GitHub shows/)
    const unverified = [release('annotate@0.2.0', [{ name: 'rwoll-annotate-0.2.0.tgz', digest: null }])]
    expect(await installTools({ names: ['annotate'], run: t.run, fetch: github(unverified).fetch, log: t.log })).toBe(1)
    expect(t.lines.at(-1)).toMatch(/no SHA-256 digest/)
    expect(t.calls.some((call) => call.args[0] === 'install')).toBe(false)
  })

  it('says when a tool has no release yet', async () => {
    const t = fake({ 'npm --version': ok('12.2.1') })
    expect(await installTools({ names: ['blobby-sandbox'], run: t.run, fetch: github(annotateReleases).fetch, log: t.log })).toBe(1)
    expect(t.lines.at(-1)).toBe('@rwoll/blobby-sandbox has no release yet. See its README to build it from source.')
  })

  it("adds smolmachines for blobby-sandbox where smolvm runs, at blobby-sandbox's peer version", async () => {
    const blobby = JSON.parse(readFileSync(new URL('../../packages/blobby-sandbox/package.json', import.meta.url), 'utf8')) as { peerDependencies: Record<string, string> }
    expect(SMOLMACHINES).toBe(`smolmachines@${blobby.peerDependencies.smolmachines}`)
    const releases = [release('blobby-sandbox@0.1.0', [{ name: 'rwoll-blobby-sandbox-0.1.0.tgz', digest: `sha256:${SHA256}` }])]
    const installed = async (platform: NodeJS.Platform, arch: string) => {
      const t = fake({ 'npm --version': ok('12.2.1'), 'blobby-sandbox --version': ok('0.1.0') })
      await installTools({ names: ['blobby-sandbox'], run: t.run, fetch: github(releases).fetch, log: t.log, platform, arch })
      return t.calls.find((call) => call.args[0] === 'install')?.args.slice(5)
    }
    expect(await installed('darwin', 'arm64')).toEqual([SMOLMACHINES])
    expect(await installed('darwin', 'x64')).toEqual([])
  })

  it('refuses npm too old to enforce the cooldown, before downloading anything', async () => {
    const t = fake({ 'npm --version': ok('11.9.0\n') })
    const gh = github(annotateReleases)
    expect(await installTools({ run: t.run, fetch: gh.fetch, log: t.log, platform: 'darwin' })).toBe(1)
    expect(gh.urls).toEqual([])
    expect(t.lines[0]).toMatch(/needs npm 11\.10\.0 or later/)
  })

  it("says which folder to add to PATH when the installed command isn't found", async () => {
    const t = fake({ 'npm --version': ok('12.2.1'), 'annotate --version': null, 'npm prefix': ok('/opt/node\n') })
    expect(await installTools({ names: ['annotate'], run: t.run, fetch: github(annotateReleases).fetch, log: t.log, platform: 'linux' })).toBe(1)
    expect(t.lines.at(-1)).toBe("annotate was installed, but it isn't on PATH. Add /opt/node/bin to PATH, then open a new terminal.")
  })

  it('only reports with --check, and rejects unknown tools', async () => {
    const t = fake({ 'annotate --version': ok('0.1.0'), 'blobby-sandbox --version': null })
    expect(await installTools({ check: true, run: t.run, fetch: github([]).fetch, log: t.log, platform: 'darwin' })).toBe(1)
    expect(t.calls.map((call) => call.command)).toEqual(['annotate', 'blobby-sandbox'])
    expect(t.lines).toEqual(['annotate 0.1.0', 'blobby-sandbox is not installed. Run this script without --check to install it.'])
    expect(await installTools({ names: ['canvas-kit'], run: t.run, log: t.log })).toBe(2)
  })

  it('compares versions', () => {
    expect(atLeast('11.10.0', '11.10.0')).toBe(true)
    expect(atLeast('v12.0.0-pre.1', '11.10.0')).toBe(true)
    expect(atLeast('11.9.9', '11.10.0')).toBe(false)
  })
})
