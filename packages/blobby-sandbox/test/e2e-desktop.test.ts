import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LocalResolver } from '../src/callbacks/index.ts'
import { connect, type SandboxClient } from '../src/client.ts'
import { Secrets } from '../src/secrets.ts'

// A real desktop sandbox, driven end to end without signing in, on the backend `doctor` picks or
// BLOBBY_SANDBOX_BACKEND names. CI runs it on Docker. Run it with
// BLOBBY_SANDBOX_E2E=1 pnpm --filter @rwoll/blobby-sandbox exec vitest run e2e
describe.skipIf(!process.env.BLOBBY_SANDBOX_E2E)('end to end: a desktop sandbox, without signing in', () => {
  const name = `e2e-${randomBytes(3).toString('hex')}`
  let dir: string
  let client: SandboxClient
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'blobby-e2e-'))
    // This computer's own config, so the sandbox is made from the bases it already has.
    client = connect()
  })
  afterAll(async () => {
    await client?.remove(name).catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }, 5 * 60_000)

  it('starts, shows its desktop, is driven, records, and refuses a secret', async () => {
    const progress: string[] = []
    const sb = await client.start(name, { recipe: { builtin: 'desktop' }, deleteAfter: '2h', onProgress: (line) => progress.push(line) })
    expect(sb.started).toMatchObject({ created: true, recipe: 'desktop', sandbox: { state: 'running' } })

    const shot = await sb.desktop.screenshot()
    expect([shot.width, shot.height]).toEqual([1280, 800])
    expect(Buffer.from(shot.png).subarray(1, 4).toString()).toBe('PNG')

    // GNOME Shell's top bar, found by waiting in the sandbox rather than polling from here.
    const activities = await sb.desktop.waitFor({ app: 'gnome-shell', match: 'Activities', timeoutSeconds: 60 })
    expect(activities.nodes[0]).toMatchObject({ role: 'toggle button', name: 'Activities' })

    const recording = await sb.desktop.record({ maxSeconds: 30 })
    await sb.desktop.input({ move: [640, 400] })
    const video = await recording.stop()
    const saved = await video.save(join(dir, 'e2e.mp4'))
    expect((await stat(saved.path)).size).toBeGreaterThan(1000)

    const scripts = await sb.exec(['blobby-scripts', '--json'])
    expect((JSON.parse(scripts.stdout) as { name: string }[]).map((script) => script.name)).toContain('vscode-signin')
    expect(await sb.exec(['sh', '-c', 'echo "$(id -un) on $DISPLAY"'])).toMatchObject({ exitCode: 0, stdout: 'ubuntu on :1\n' })

    // With no logins allowed and no secrets, a secret is refused before anything runs.
    const resolver = new LocalResolver({ allowedLogins: [], secrets: new Secrets({ env: { XDG_CONFIG_HOME: join(dir, 'config') } }) })
    await expect(sb.exec(['true'], { secret: 'github', resolver })).rejects.toMatchObject({ code: 'login_not_allowed' })
  }, 30 * 60_000)
})
