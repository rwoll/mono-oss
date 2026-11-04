import { randomBytes } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { DockerBackend, type DockerStatus } from '../src/docker/index.ts'
import { RUN_LABEL, runOwner, sweep, UBUNTU_IMAGE } from './docker-world.ts'

// VS Code's own check for its command sandbox, run as an unprivileged user.
const BWRAP_CHECK = ['bwrap', '--unshare-net', '--dev-bind', '/', '/', 'echo', 'ok']

// Real containers, on any computer with Docker; they install bubblewrap from Ubuntu's archive. Run them with
// BLOBBY_SANDBOX_CONFORMANCE_DOCKER=1 pnpm --filter @rwoll/blobby-sandbox exec vitest run docker
describe.skipIf(!process.env.BLOBBY_SANDBOX_CONFORMANCE_DOCKER)('the command sandbox on docker', () => {
  const run = randomBytes(4).toString('hex')
  const backend = new DockerBackend({ labels: runOwner(run, 'sandbox') })
  afterAll(async () => {
    await sweep(run)
    const left = new DockerBackend({ labels: { [RUN_LABEL]: run } })
    expect(await left.list()).toEqual([])
    expect(await left.snapshots()).toEqual([])
  }, 120_000)

  it('lets bubblewrap make its namespaces only with commandSandbox', async (context) => {
    const status = (await backend.check()) as DockerStatus
    expect(status.ok, status.detail).toBe(true)
    const apparmor = status.checks.find((check) => check.name === 'apparmor')?.ok === false

    const plain = await backend.create({ name: `bwrap-plain-${run}`, image: UBUNTU_IMAGE })
    const install = await backend.exec(plain.name, ['sh', '-c', 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends bubblewrap >/dev/null'], { user: 'root', timeoutSeconds: 300 })
    expect(install, install.stderr).toMatchObject({ exitCode: 0 })
    const refused = await backend.exec(plain.name, BWRAP_CHECK, { user: 'ubuntu', timeoutSeconds: 30 })
    expect(refused.exitCode, 'bwrap fails without the command sandbox').not.toBe(0)
    expect(refused.stdout).not.toContain('ok')
    expect((await backend.exec(plain.name, ['test', '-c', '/dev/net/tun'])).exitCode).not.toBe(0)

    const snapshot = await backend.snapshot(plain.name, { labels: { 'blobby.dev/test': 'bwrap' } })
    const name = `bwrap-sandbox-${run}`
    if (apparmor) {
      await expect(backend.createFrom(snapshot.id, { name, commandSandbox: true })).rejects.toMatchObject({ code: 'docker_apparmor' })
      await backend.createFrom(snapshot.id, { name, commandSandbox: true, providerOptions: { apparmor: 'unconfined' } })
    } else {
      await backend.createFrom(snapshot.id, { name, commandSandbox: true })
    }
    expect((await backend.exec(name, ['test', '-c', '/dev/net/tun'])).exitCode).toBe(0)
    const allowed = await backend.exec(name, BWRAP_CHECK, { user: 'ubuntu', timeoutSeconds: 30 })
    if (apparmor && allowed.exitCode !== 0) {
      return context.skip(`On this AppArmor host, bwrap still fails with apparmor: 'unconfined': ${allowed.stderr.trim()}`)
    }
    expect(allowed).toEqual({ exitCode: 0, stdout: 'ok\n', stderr: '' })
  }, 10 * 60_000)
})
