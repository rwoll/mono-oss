import { randomBytes } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Backend } from '../src/backend.ts'
import { main, type Io } from '../src/cli.ts'
import { connect } from '../src/client.ts'
import { DockerBackend } from '../src/docker/index.ts'
import { checkGuestEnv, isCredentialEnv } from '../src/guest-env.ts'
import { KIND_LABEL, MANAGER_LABEL } from '../src/labels.ts'
import { SmolvmBackend } from '../src/smolvm.ts'
import { runOwner, sweep, UBUNTU_IMAGE } from './docker-world.ts'
import { world, type World } from './world.ts'

// No host credential ever enters a sandbox. Canary credentials sit in this process's
// environment, as a developer's shell would have them, and must never reach a sandbox's environment, a
// command's output, or a log.

const canary = (label: string) => `canary-${label}-${randomBytes(12).toString('hex')}`
const HOST: Record<string, string> = {
  GH_TOKEN: canary('gh'),
  GITHUB_TOKEN: canary('github'),
  COPILOT_API_TOKEN: canary('copilot'),
  AZURE_CLIENT_SECRET: canary('azure'),
  NPM_TOKEN: canary('npm'),
  SSH_AUTH_SOCK: `/nonexistent/${canary('ssh')}`,
  BLOBBY_SANDBOX_TOKEN: canary('server'),
}
const values = Object.values(HOST)
const leaks = (text: string) => values.filter((value) => text.includes(value))

let saved: Record<string, string | undefined>
beforeAll(() => {
  saved = Object.fromEntries(Object.keys(HOST).map((name) => [name, process.env[name]]))
  Object.assign(process.env, HOST)
})
afterAll(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe('isCredentialEnv', () => {
  it('blocks credentials and what brings them along, and lets the session through', () => {
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'COPILOT_API_KEY', 'AZURE_CLIENT_SECRET', 'ARM_CLIENT_SECRET', 'AWS_SECRET_ACCESS_KEY', 'NPM_TOKEN', 'npm_config__authToken', 'NODE_AUTH_TOKEN', 'SSH_AUTH_SOCK', 'GIT_ASKPASS', 'GIT_CONFIG_COUNT', 'OPENAI_API_KEY', 'MY_SERVICE_PASSWORD', 'BLOBBY_SANDBOX_TOKEN']) {
      expect([name, isCredentialEnv(name)]).toEqual([name, true])
    }
    for (const name of ['DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'HOME', 'PATH', 'LANG', 'DEBIAN_FRONTEND', 'BLOBBY_CONFORMANCE']) {
      expect([name, isCredentialEnv(name)]).toEqual([name, false])
    }
  })

  it('refuses a credential even when the caller passes it, naming it but never its value', () => {
    expect(checkGuestEnv({ DISPLAY: ':1', TERM: 'xterm' })).toEqual({ DISPLAY: ':1', TERM: 'xterm' })
    const error = (() => {
      try {
        checkGuestEnv({ DISPLAY: ':1', GH_TOKEN: HOST.GH_TOKEN! })
      } catch (caught) {
        return caught as Error & { code: string }
      }
    })()
    expect(error).toMatchObject({ code: 'env_blocked', message: expect.stringContaining('refuses GH_TOKEN') })
    expect(leaks(error!.message)).toEqual([])
    expect(() => checkGuestEnv({ 'BAD NAME': 'x' })).toThrow(expect.objectContaining({ code: 'invalid_options' }))
  })
})

describe('the engine, client, and CLI on FakeBackend', () => {
  let w: World
  beforeEach(async () => {
    w = await world()
    const guest = w.backend.onExec
    // Commands print the environment they got, as `env` in a real guest would.
    w.backend.onExec = (name, command, options) =>
      command.at(-1) === 'env' ? { exitCode: 0, stdout: Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}\n`).join('') } : guest(name, command, options)
  })
  afterEach(() => w.cleanup())

  it('never passes the host environment, through any path', async () => {
    const progress: string[] = []
    await w.engine.start('t1', { onProgress: (line) => progress.push(line), onRequest: (request) => w.secrets.answer(request) })
    const direct = await w.engine.exec('t1', ['env'])
    const root = await w.engine.exec('t1', ['env'], { user: 'root' })
    const client = connect({ engine: async () => w.engine })
    const remote = await client.exec('t1', ['env'], { env: { TERM: 'xterm' } })
    expect(direct.stdout).toContain('DISPLAY=:1')
    expect(remote.stdout).toContain('TERM=xterm')

    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let out = ''
    stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
    stderr.on('data', (chunk: Buffer) => (out += chunk.toString()))
    const io: Io = { stdout: stdout as never, stderr: stderr as never, stdin: new PassThrough() as never, env: { ...process.env, ...w.env }, cwd: w.dir, connect: () => client, secrets: w.secrets }
    expect(await main(['exec', 't1', '--json', '--', 'env'], io)).toBe(0)
    expect(await main(['exec', 't1', '--root', '--', 'env'], io)).toBe(0)

    const sent = w.backend.calls.filter((call) => call.method === 'exec').map((call) => (call.args[2] as { env?: Record<string, string> }).env ?? {})
    expect(sent.length).toBeGreaterThan(10)
    for (const env of sent) expect(Object.keys(env).filter(isCredentialEnv)).toEqual([])
    expect(leaks(JSON.stringify([sent, direct, root, remote, out, progress]))).toEqual([])
  })

  it('refuses credentials passed explicitly, in the engine, the client, the CLI, and the backend', async () => {
    await w.engine.start('t1', { steps: 'never' })
    const client = connect({ engine: async () => w.engine })
    for (const run of [
      () => w.engine.exec('t1', ['true'], { env: { GH_TOKEN: HOST.GH_TOKEN! } }),
      () => client.exec('t1', ['true'], { env: { COPILOT_API_TOKEN: HOST.COPILOT_API_TOKEN! } }),
      () => w.backend.exec('blobby-t1', ['true'], { env: { AZURE_CLIENT_SECRET: HOST.AZURE_CLIENT_SECRET! } }),
    ]) {
      const error = await run().then(() => null, (caught: Error) => caught)
      expect(error).toMatchObject({ code: 'env_blocked' })
      expect(leaks(error!.message)).toEqual([])
    }
  })
})

/** Every environment in the machine: each process's, and a new command's, as root and as the default user. */
async function environments(backend: Backend, name: string): Promise<string> {
  const dump = ['sh', '-c', 'for f in /proc/[0-9]*/environ; do tr "\\0" "\\n" < "$f" 2>/dev/null; done; env']
  const results = [await backend.exec(name, dump, { user: 'root' }), await backend.exec(name, dump)]
  for (const result of results) expect(result.exitCode, result.stderr).toBe(0)
  return results.map((result) => result.stdout + result.stderr).join('\n')
}

async function checkReal(backend: Backend, name: string, image: string): Promise<void> {
  await backend.create({ name, image, resources: { cpus: 1, memoryMb: 512 } })
  const seen = await environments(backend, name)
  expect(seen).toContain('PATH=')
  expect(leaks(seen)).toEqual([])
  for (const variable of Object.keys(HOST)) expect(seen).not.toMatch(new RegExp(`^${variable}=`, 'm'))
  await expect(backend.exec(name, ['true'], { env: { GH_TOKEN: HOST.GH_TOKEN! } })).rejects.toMatchObject({ code: 'env_blocked' })
}

// Real containers. Run them with BLOBBY_SANDBOX_CONFORMANCE_DOCKER=1 pnpm --filter @rwoll/blobby-sandbox exec vitest run host-env
describe.skipIf(!process.env.BLOBBY_SANDBOX_CONFORMANCE_DOCKER)('the host environment on docker', () => {
  const run = randomBytes(4).toString('hex')
  afterAll(() => sweep(run), 120_000)
  it('never reaches a container', async () => {
    await checkReal(new DockerBackend({ labels: runOwner(run, 'env') }), `env-${run}`, UBUNTU_IMAGE)
  }, 5 * 60_000)
})

// Real micro-VMs. Run them with BLOBBY_SANDBOX_CONFORMANCE_SMOLVM=1 pnpm --filter @rwoll/blobby-sandbox exec vitest run host-env
describe.skipIf(!process.env.BLOBBY_SANDBOX_CONFORMANCE_SMOLVM)('the host environment on smolvm', () => {
  const run = randomBytes(4).toString('hex')
  const backend = new SmolvmBackend({ labels: { [MANAGER_LABEL]: `standalone:test-env-${run}`, [KIND_LABEL]: 'conformance' } })
  afterAll(async () => {
    for (const machine of await backend.list()) await backend.remove(machine.name)
  }, 120_000)
  it('never reaches a micro-VM', async () => {
    await checkReal(backend, `env-${run}`, 'ubuntu:24.04')
  }, 5 * 60_000)
})
