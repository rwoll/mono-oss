import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DELETE_AFTER_LABEL, IDEMPOTENCY_LABEL, readAll } from '../src/backend.ts'
import {
  apparmorCheck,
  DockerBackend,
  dockerTarget,
  EXEC_ID_ENV,
  KILL_SCRIPT,
  LABEL_KEYS_LABEL,
  NAMESPACE_SYSCALLS,
  resolveOwner,
  sandboxSeccompProfile,
  SECCOMP_PROFILE_URL,
  SNAPSHOT_SOURCE_LABEL,
  type DockerBackendOptions,
  type DockerStatus,
  type PullProgress,
} from '../src/docker/index.ts'
import { Demuxer } from '../src/docker/engine.ts'
import { archiveSize, extractFirstFile, packEntries, type TarEntry } from '../src/docker/tar.ts'
import { MANAGER_LABEL } from '../src/labels.ts'
import { UBUNTU_IMAGE } from './docker-world.ts'
import { FakeDockerEngine, parseTar, type FakeDockerOptions } from './fake-docker-engine.ts'

const OWNER = { [MANAGER_LABEL]: 'standalone:test-host' }
const collect = async (stream: Readable) => {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks)
}

describe('dockerTarget', () => {
  const none = () => false
  it('uses DOCKER_HOST for unix and plain tcp daemons', () => {
    expect(dockerTarget({ DOCKER_HOST: 'unix:///run/user/1000/docker.sock' })).toEqual({ kind: 'unix', socketPath: '/run/user/1000/docker.sock' })
    expect(dockerTarget({ DOCKER_HOST: 'tcp://docker.example.com:2375' })).toEqual({ kind: 'tcp', host: 'docker.example.com', port: 2375 })
    expect(dockerTarget({ DOCKER_HOST: 'tcp://10.0.0.5' })).toEqual({ kind: 'tcp', host: '10.0.0.5', port: 2375 })
  })

  it('refuses what it can\'t speak: TLS, ssh, and named pipes', () => {
    expect(() => dockerTarget({ DOCKER_HOST: 'tcp://docker.example.com:2376', DOCKER_TLS_VERIFY: '1' })).toThrow(expect.objectContaining({ code: 'docker_host_unsupported' }))
    expect(() => dockerTarget({ DOCKER_HOST: 'ssh://someone@docker.example.com' })).toThrow(expect.objectContaining({ code: 'docker_host_unsupported', message: expect.not.stringContaining('someone') }))
    expect(() => dockerTarget({ DOCKER_HOST: 'npipe:////./pipe/docker_engine' })).toThrow(expect.objectContaining({ code: 'docker_host_unsupported' }))
    expect(() => dockerTarget({ DOCKER_HOST: 'unix://relative.sock' })).toThrow(expect.objectContaining({ code: 'docker_host_unsupported' }))
  })

  it('finds Docker Desktop\'s socket on macOS, and rootless Docker\'s on Linux, after /var/run/docker.sock', () => {
    const home = '/home/someone'
    expect(dockerTarget({}, { platform: 'darwin', home, isSocket: none })).toEqual({ kind: 'unix', socketPath: '/var/run/docker.sock' })
    expect(dockerTarget({}, { platform: 'darwin', home, isSocket: (path) => path === `${home}/.docker/run/docker.sock` })).toEqual({ kind: 'unix', socketPath: `${home}/.docker/run/docker.sock` })
    expect(dockerTarget({}, { platform: 'darwin', home, isSocket: () => true })).toEqual({ kind: 'unix', socketPath: '/var/run/docker.sock' })
    expect(dockerTarget({ XDG_RUNTIME_DIR: '/run/user/1000' }, { platform: 'linux', home, isSocket: (path) => path === '/run/user/1000/docker.sock' })).toEqual({ kind: 'unix', socketPath: '/run/user/1000/docker.sock' })
  })

  it('never reads Docker\'s CLI configuration', async () => {
    for (const file of ['index.ts', 'engine.ts', 'tar.ts', 'seccomp.ts']) {
      const source = await readFile(new URL(`../src/docker/${file}`, import.meta.url), 'utf8')
      expect(source, file).not.toMatch(/config\.json|DOCKER_CONFIG|DOCKER_CONTEXT/)
      expect(source, file).not.toMatch(/child_process/)
    }
  })
})

describe('the docker backend on a fake Docker Engine', () => {
  let engine: FakeDockerEngine
  let backend: DockerBackend
  const start = async (options: FakeDockerOptions = {}, backendOptions: Partial<DockerBackendOptions> = {}) => {
    await engine?.close()
    engine = await FakeDockerEngine.start(options)
    backend = new DockerBackend({ target: engine.target, env: {}, labels: OWNER, limits: { running: 50, total: 50 }, ...backendOptions })
    return backend
  }
  beforeEach(() => start())
  afterEach(() => engine.close())
  const create = (name: string, options: Partial<Parameters<DockerBackend['create']>[0]> = {}) => backend.create({ name, image: UBUNTU_IMAGE, ...options })
  const lastCreate = () => engine.creates.at(-1)!

  it('negotiates the Engine API version with /version', async () => {
    await backend.list()
    expect(engine.requests.find((request) => request.path === '/containers/json')).toBeTruthy()
    expect(engine.requests[0]!.path).toBe('/version')
    expect((await backend.check()).detail).toContain('Engine API 1.47')

    await start({ apiVersion: '1.43' })
    expect((await backend.check()).detail).toContain('Engine API 1.43')
    await start({ apiVersion: '1.40' })
    expect(await backend.check()).toMatchObject({ ok: false, code: 'docker_too_old' })
    await start({ minApiVersion: '1.50' })
    expect(await backend.check()).toMatchObject({ ok: false, code: 'docker_too_new' })
  })

  it('reports what doctor checks: Docker, its platform, the seccomp profile, the tun device, AppArmor, and the limits', async () => {
    const status = (await backend.check()) as DockerStatus
    expect(status.ok).toBe(true)
    expect(status.checks.map((check) => check.name)).toEqual(['docker', 'platform', 'seccomp', 'tun', 'apparmor', 'limits'])
    expect(status.checks.find((check) => check.name === 'platform')).toEqual({ name: 'platform', ok: true, detail: 'linux/arm64' })
    expect(status.checks.find((check) => check.name === 'apparmor')?.ok).toBe(true)
    await start({ apparmor: true })
    const apparmor = (await backend.check()) as DockerStatus
    expect(apparmor.ok).toBe(true)
    expect(apparmor.checks.find((check) => check.name === 'apparmor')).toMatchObject({ ok: false, detail: expect.stringContaining("apparmor: 'unconfined'") })
    // On a Linux host that runs the daemon, it also reads the user namespace restriction.
    expect(apparmorCheck(true, '1').detail).toContain('kernel.apparmor_restrict_unprivileged_userns=1')
    expect(apparmorCheck(true, '0').detail).not.toContain('apparmor_restrict_unprivileged_userns')
    expect(apparmorCheck(false, '1')).toEqual({ name: 'apparmor', ok: true, detail: 'Not in use, so the command sandbox works.' })
  })

  it('says how to reach Docker when it can\'t', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'blobby-test-'))
    try {
      const offline = new DockerBackend({ env: { DOCKER_HOST: `unix://${join(dir, 'docker.sock')}` }, labels: OWNER })
      expect(await offline.check()).toMatchObject({ ok: false, code: 'docker_unreachable', detail: expect.stringContaining('set DOCKER_HOST') })
      await expect(offline.list()).rejects.toMatchObject({ code: 'docker_unreachable' })
      const unsupported = new DockerBackend({ env: { DOCKER_HOST: 'ssh://docker.example.com' }, labels: OWNER })
      expect(await unsupported.check()).toMatchObject({ ok: false, code: 'docker_host_unsupported' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('creates containers that are never privileged, with no added capabilities or mounts, ports on loopback only, and no-new-privileges', async () => {
    const machine = await create('plain-one', { ports: [{ guest: 6901 }], labels: { 'example.com/team': 'qa' } })
    const body = lastCreate()
    expect(body.HostConfig).toMatchObject({ Init: true, Privileged: false, CapAdd: null, Binds: null, Mounts: null, Devices: [], SecurityOpt: ['no-new-privileges:true'], NetworkMode: 'bridge', PublishAllPorts: false })
    expect(body.HostConfig.PortBindings).toEqual({ '6901/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] })
    expect(body.HostConfig.SecurityOpt.join(' ')).not.toMatch(/seccomp|apparmor/)
    expect(body.Entrypoint).toEqual(['sleep', 'infinity'])
    expect(body.Labels).toMatchObject({ ...OWNER, 'example.com/team': 'qa', [LABEL_KEYS_LABEL]: `${MANAGER_LABEL},example.com/team` })
    expect(machine).toMatchObject({ name: 'plain-one', state: 'running', labels: { ...OWNER, 'example.com/team': 'qa' }, deleteAfter: null, image: UBUNTU_IMAGE })
    expect(machine.ports).toEqual([{ guest: 6901, host: expect.any(Number), hostIp: '127.0.0.1' }])
    // The image's own labels are not the machine's.
    expect(machine.labels['org.opencontainers.image.version']).toBeUndefined()
  })

  it('adds the command sandbox\'s seccomp profile and /dev/net/tun only when asked, and leaves out no-new-privileges for root', async () => {
    await create('sandboxed', { commandSandbox: true, root: true, resources: { cpus: 2, memoryMb: 4096 }, providerOptions: { shmSizeMb: 1024 } })
    const host = lastCreate().HostConfig
    expect(host.Devices).toEqual([{ PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' }])
    expect(host.SecurityOpt).toHaveLength(1)
    const profile = JSON.parse((host.SecurityOpt[0] as string).slice('seccomp='.length))
    expect(profile.syscalls.at(-1)).toEqual({ names: [...NAMESPACE_SYSCALLS], action: 'SCMP_ACT_ALLOW' })
    expect(host).toMatchObject({ NanoCpus: 2e9, Memory: 4096 * 1024 * 1024, MemorySwap: 4096 * 1024 * 1024, ShmSize: 1024 * 1024 * 1024, Privileged: false, CapAdd: null })
  })

  it('gives a machine at most the CPUs Docker has', async () => {
    await start({ cpus: 2 })
    await create('small-host', { resources: { cpus: 4 } })
    expect(lastCreate().HostConfig.NanoCpus).toBe(2e9)
    await create('fits', { resources: { cpus: 1.5 } })
    expect(lastCreate().HostConfig.NanoCpus).toBe(1.5e9)
  })

  it('refuses the command sandbox under AppArmor\'s docker-default, unless the user turns AppArmor off for the machine', async () => {
    await start({ apparmor: true })
    await expect(create('blocked', { commandSandbox: true })).rejects.toMatchObject({ code: 'docker_apparmor', message: expect.stringContaining("providerOptions: { apparmor: 'unconfined' }") })
    expect(engine.creates).toHaveLength(0)
    await create('plain-two')
    expect(lastCreate().HostConfig.SecurityOpt).toEqual(['no-new-privileges:true'])
    await create('override', { commandSandbox: true, providerOptions: { apparmor: 'unconfined' } })
    expect(lastCreate().HostConfig.SecurityOpt).toEqual(['no-new-privileges:true', expect.stringMatching(/^seccomp=/), 'apparmor=unconfined'])
    await expect(create('wrong', { providerOptions: { apparmor: 'docker-default' as 'unconfined' } })).rejects.toMatchObject({ code: 'invalid_options' })
  })

  it('cuts a machine off with network none, fails closed on policies it can\'t enforce, and joins a named network without publishing ports', async () => {
    expect(backend.capabilities().networkPolicies).toEqual(['none', 'internet'])
    await create('offline', { network: 'none' })
    expect(lastCreate().HostConfig.NetworkMode).toBe('none')
    await expect(create('offline-ports', { network: 'none', ports: [{ guest: 80 }] })).rejects.toMatchObject({ code: 'invalid_options' })
    await expect(create('essential', { network: 'essential' })).rejects.toMatchObject({ code: 'network_unenforceable' })
    await expect(create('allow', { network: { allow: ['example.com'] } })).rejects.toMatchObject({ code: 'network_unenforceable' })
    await create('unenforced', { network: { allow: ['example.com'] }, allowUnenforcedNetwork: true })
    expect(lastCreate().HostConfig.NetworkMode).toBe('bridge')

    const viewer = await create('viewer', { ports: [{ guest: 6901 }], providerOptions: { network: 'desktops' } })
    expect(lastCreate().HostConfig).toMatchObject({ NetworkMode: 'desktops', PortBindings: {} })
    expect(viewer.ports).toEqual([])
    expect(await backend.endpoint('viewer', 6901)).toEqual({ kind: 'tcp', host: expect.stringMatching(/^172\.30\.0\.\d+$/), port: 6901 })
    await expect(create('missing-network', { providerOptions: { network: 'nowhere' } })).rejects.toMatchObject({ code: 'invalid_options', message: expect.stringContaining('nowhere') })
    for (const network of ['host', 'none', 'container:abc', '']) await expect(create('bad-network', { providerOptions: { network } })).rejects.toMatchObject({ code: 'invalid_options' })
    await expect(create('none-network', { network: 'none', providerOptions: { network: 'desktops' } })).rejects.toMatchObject({ code: 'invalid_options' })
  })

  it('waits after a stop until Docker\'s list says the machine stopped', async () => {
    await create('stopping')
    engine.staleListsAfterStop = 3
    await backend.stop('stopping')
    expect((await backend.get('stopping'))?.state).toBe('stopped')
    expect(engine.requests.filter((request) => request.path === '/containers/json').length).toBeGreaterThan(4)
  })

  it('returns where a published port listens, and not_published or not_running otherwise', async () => {
    const { ports } = await create('ported', { ports: [{ guest: 6901 }] })
    expect(await backend.endpoint('ported', 6901)).toEqual({ kind: 'tcp', host: '127.0.0.1', port: ports[0]!.host })
    await expect(backend.endpoint('ported', 22)).rejects.toMatchObject({ code: 'not_published', message: expect.stringContaining('created') })
    await backend.stop('ported')
    await expect(backend.endpoint('ported', 6901)).rejects.toMatchObject({ code: 'not_running' })
    expect((await backend.get('ported'))?.ports).toEqual([])
  })

  it('limits this owner to 3 running and 6 machines, saying how to clean up or raise the limit', async () => {
    backend = new DockerBackend({ target: engine.target, env: {}, labels: OWNER })
    expect(backend.limits()).toEqual({ running: 3, total: 6 })
    for (const name of ['one-1', 'two-2', 'three-3']) await create(name)
    await expect(create('four-4')).rejects.toMatchObject({ code: 'limit_reached', message: expect.stringMatching(/runs 3 .*limit is 3.*blobby-sandbox stop.*BLOBBY_SANDBOX_DOCKER_MAX_RUNNING/) })
    expect(await backend.get('four-4')).toBeNull()
    await backend.stop('one-1')
    await create('four-4')
    await expect(backend.start('one-1')).rejects.toMatchObject({ code: 'limit_reached' })
    for (const name of ['two-2', 'three-3', 'four-4']) await backend.stop(name)
    await create('five-5')
    await create('six-6')
    await expect(create('seven-7')).rejects.toMatchObject({ code: 'limit_reached', message: expect.stringMatching(/has 6 .*limit is 6.*blobby-sandbox rm.*BLOBBY_SANDBOX_DOCKER_MAX_TOTAL/) })
    // Another owner's machines don't count.
    const other = new DockerBackend({ target: engine.target, env: {}, labels: { [MANAGER_LABEL]: 'standalone:other-host' } })
    await other.create({ name: 'theirs-1', image: UBUNTU_IMAGE })

    const raised = new DockerBackend({ target: engine.target, env: { BLOBBY_SANDBOX_DOCKER_MAX_TOTAL: '10', BLOBBY_SANDBOX_DOCKER_MAX_RUNNING: '4' }, labels: OWNER })
    expect(raised.limits()).toEqual({ running: 4, total: 10 })
    await raised.create({ name: 'seven-7', image: UBUNTU_IMAGE })
    expect(new DockerBackend({ target: engine.target, env: {}, labels: OWNER, limits: { running: 1, total: 2 } }).limits()).toEqual({ running: 1, total: 2 })
    expect(() => new DockerBackend({ target: engine.target, env: { BLOBBY_SANDBOX_DOCKER_MAX_TOTAL: 'lots' }, labels: OWNER }).limits()).toThrow(expect.objectContaining({ code: 'invalid_options' }))
  })

  it('stores deleteAfter and the idempotency key as labels, and finishes a create that stopped before starting', async () => {
    const deleteAfter = new Date('2030-01-01T00:00:00.000Z')
    const machine = await create('keyed', { deleteAfter, idempotencyKey: 'req-1' })
    expect(machine.labels).toMatchObject({ [DELETE_AFTER_LABEL]: '2030-01-01T00:00:00.000Z', [IDEMPOTENCY_LABEL]: 'req-1' })
    expect(machine.deleteAfter).toBe('2030-01-01T00:00:00.000Z')
    engine.findContainer('keyed')!.state = 'created'
    expect((await create('keyed', { idempotencyKey: 'req-1' })).state).toBe('running')
    // Owner labels win over the caller's.
    expect((await create('spoofed', { labels: { [MANAGER_LABEL]: 'standalone:someone-else' } })).labels[MANAGER_LABEL]).toBe(OWNER[MANAGER_LABEL])
    // A name taken by a container this owner can't see.
    engine.addImage('other:1')
    await new DockerBackend({ target: engine.target, env: {}, labels: { [MANAGER_LABEL]: 'standalone:other-host' } }).create({ name: 'taken', image: 'other:1' })
    await expect(create('taken', { idempotencyKey: 'req-2' })).rejects.toMatchObject({ code: 'already_exists', message: expect.stringContaining('isn\'t one of this owner\'s') })
  })

  it('validates names, images, ports, labels, users, environment, and provider options before calling Docker', async () => {
    const before = engine.requests.length
    for (const name of ['a', 'Upper', '-dash', 'has space', 'x'.repeat(64), 'under_score']) await expect(create(name)).rejects.toMatchObject({ code: 'invalid_options' })
    for (const image of ['Ubuntu', 'ubuntu:24.04 && rm', 'ubuntu@sha256:abc', '../x']) await expect(backend.create({ name: 'valid-name', image })).rejects.toMatchObject({ code: 'invalid_options' })
    await expect(create('valid-name', { ports: [{ guest: 0 }] })).rejects.toMatchObject({ code: 'invalid_options' })
    await expect(create('valid-name', { ports: [{ guest: 80 }, { guest: 80 }] })).rejects.toMatchObject({ code: 'invalid_options' })
    await expect(create('valid-name', { ports: [{ guest: 80, host: 70000 }] })).rejects.toMatchObject({ code: 'invalid_options' })
    await expect(create('valid-name', { providerOptions: { privileged: true } as never })).rejects.toMatchObject({ code: 'invalid_options', message: expect.stringContaining('privileged') })
    await expect(create('valid-name', { providerOptions: { command: 'bash' as 'image' } })).rejects.toMatchObject({ code: 'invalid_options' })
    await expect(create('valid-name', { resources: { memoryMb: 10 } })).rejects.toMatchObject({ code: 'invalid_options' })
    await expect(create('valid-name', { resources: { gpu: true } })).rejects.toMatchObject({ code: 'unsupported' })
    await expect(create('valid-name', { branchable: true })).rejects.toMatchObject({ code: 'unsupported' })
    expect(engine.creates).toHaveLength(0)
    expect(engine.requests.slice(before).every((request) => request.method === 'GET')).toBe(true)

    await create('valid-name')
    await expect(backend.exec('valid-name', [])).rejects.toMatchObject({ code: 'invalid_options' })
    await expect(backend.exec('valid-name', ['true'], { user: 'root; rm -rf /' })).rejects.toMatchObject({ code: 'invalid_options' })
    await expect(backend.exec('valid-name', ['true'], { env: { 'BAD NAME': 'x' } })).rejects.toMatchObject({ code: 'invalid_options' })
    await expect(backend.exec('valid-name', ['true'], { env: { [EXEC_ID_ENV]: 'x' } })).rejects.toMatchObject({ code: 'invalid_options' })
    await expect(backend.exec('valid-name', ['true'], { timeoutSeconds: -1 })).rejects.toMatchObject({ code: 'invalid_options' })
    await expect(backend.writeFile('valid-name', 'relative/path', Buffer.from('x'))).rejects.toMatchObject({ code: 'invalid_options' })
    await expect(backend.readFile('valid-name', '/etc/passwd', { offset: -1 })).rejects.toMatchObject({ code: 'invalid_options' })
  })

  it('pulls a missing image, reporting progress, and says how to pull private ones itself', async () => {
    const progress: PullProgress[] = []
    await start({}, { onPull: (event) => progress.push(event) })
    await create('pulled', { image: 'example.com/team/tools:1.2' })
    const pull = engine.requests.find((request) => request.path === '/images/create')!
    expect(pull.query.get('fromImage')).toBe('example.com/team/tools:1.2')
    expect(pull.query.get('tag')).toBeNull()
    expect(progress).toContainEqual({ image: 'example.com/team/tools:1.2', status: 'Downloading', layer: 'abc123', current: 512, total: 1024 })
    expect(pull.query.has('X-Registry-Auth')).toBe(false)

    await create('latest-one', { image: 'busybox' })
    const latest = engine.requests.filter((request) => request.path === '/images/create').at(-1)!
    expect([latest.query.get('fromImage'), latest.query.get('tag')]).toEqual(['busybox', 'latest'])
    await create('digested', { image: 'alpine:3@sha256:' + 'a'.repeat(64) })
    expect(engine.requests.filter((request) => request.path === '/images/create').at(-1)!.query.get('fromImage')).toBe(`alpine@sha256:${'a'.repeat(64)}`)

    engine.unpullable.add('private.example.com/secret:1')
    await expect(create('private', { image: 'private.example.com/secret:1' })).rejects.toMatchObject({ code: 'docker_pull_failed', message: expect.stringContaining('docker pull private.example.com/secret:1') })
    expect(await backend.get('private')).toBeNull()
  })

  it('runs commands with `timeout` inside the machine, and kills a cancelled command by its marker', async () => {
    await create('runner')
    await backend.exec('runner', ['sleep', '1'], { timeoutSeconds: 30, user: 'ubuntu' })
    const created = engine.requests.filter((request) => request.path.endsWith('/exec')).at(-1)!.body as { Cmd: string[]; User: string; Env: string[] }
    expect(created.Cmd).toEqual(['timeout', '-k', '5', '30', 'sleep', '1'])
    expect(created.User).toBe('ubuntu')
    expect(created.Env).toEqual([expect.stringMatching(new RegExp(`^${EXEC_ID_ENV}=[0-9a-f]{24}$`))])

    const controller = new AbortController()
    const running = backend.exec('runner', ['sleep', '60'], { signal: controller.signal, user: 'ubuntu' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    controller.abort()
    await expect(running).rejects.toMatchObject({ code: 'cancelled' })
    const [sleeping, killer] = engine.requests.filter((request) => request.path.endsWith('/exec')).slice(-2).map((request) => request.body as { Cmd: string[]; User: string; Env: string[] })
    const marker = sleeping!.Env.find((pair) => pair.startsWith(`${EXEC_ID_ENV}=`))!.split('=')[1]
    expect(killer).toMatchObject({ Cmd: ['sh', '-c', KILL_SCRIPT, 'sh', marker, EXEC_ID_ENV], User: 'ubuntu' })
    expect([...engine.execs.values()].some((exec) => exec.running)).toBe(false)
  })

  it('joins output frames that split characters, and keeps stdout and stderr apart', () => {
    const out: string[] = []
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() }
    const demuxer = new Demuxer((stream, data) => out.push(`${stream}:${decoders[stream].decode(data, { stream: true })}`))
    const frame = (kind: number, data: Buffer) => Buffer.concat([Buffer.from([kind, 0, 0, 0, 0, 0, 0, data.length]), data])
    const e = Buffer.from('é')
    const all = Buffer.concat([frame(1, e.subarray(0, 1)), frame(1, e.subarray(1)), frame(2, Buffer.from('err'))])
    for (let at = 0; at < all.length; at += 5) demuxer.push(all.subarray(at, at + 5))
    expect(out.join('|')).toBe('stdout:|stdout:é|stderr:err')
    expect(demuxer.partial).toBe(false)
  })

  it('writes files as a user, creating only the folders that are missing, owned like the file', async () => {
    await create('files')
    await backend.writeFile('files', '/home/ubuntu/.config/app/settings.json', Buffer.from('{}'), { user: 'ubuntu', mode: 0o600 })
    const put = engine.requests.filter((request) => request.method === 'PUT').at(-1)!
    expect(put.query.get('path')).toBe('/home/ubuntu')
    expect(put.query.get('noOverwriteDirNonDir')).toBe('true')
    const fs = engine.findContainer('files')!.fs
    expect(fs.get('/home/ubuntu')).toMatchObject({ type: 'dir', mode: 0o750, uid: 1000 })
    expect(fs.get('/home/ubuntu/.config')).toMatchObject({ type: 'dir', mode: 0o755, uid: 1000, gid: 1000 })
    expect(fs.get('/home/ubuntu/.config/app/settings.json')).toMatchObject({ type: 'file', mode: 0o600, uid: 1000, gid: 1000 })
    await backend.writeFile('files', '/srv/data.bin', Buffer.from('x'), { user: '1234:ubuntu' })
    expect(fs.get('/srv/data.bin')).toMatchObject({ uid: 1234, gid: 1000 })
    await expect(backend.writeFile('files', '/srv/x', Buffer.from('x'), { user: 'nosuchuser' })).rejects.toMatchObject({ code: 'invalid_options' })
    await expect(backend.writeFile('files', '/etc/passwd/child', Buffer.from('x'))).rejects.toMatchObject({ code: 'invalid_options' })
    await expect(backend.writeFile('files', '/home/ubuntu', Buffer.from('x'))).rejects.toMatchObject({ code: 'invalid_options' })
    expect(fs.get('/home/ubuntu')?.type).toBe('dir')
  })

  it('reads through symbolic links, refuses folders, and streams ranges', async () => {
    await create('reader')
    expect((await readAll(backend, 'reader', '/bin/sh')).toString()).toBe('\x7fELF')
    expect(await backend.stat('reader', '/bin/sh')).toEqual({ size: 4, mode: 0o755 })
    expect(await backend.stat('reader', '/tmp')).toEqual({ size: 0, mode: 0o1777 })
    await expect(backend.readFile('reader', '/etc')).rejects.toMatchObject({ code: 'invalid_options' })
    const bytes = Buffer.from(Array.from({ length: 5000 }, (_, index) => index % 251))
    await backend.writeFile('reader', '/var/tmp/x.bin', Readable.from([bytes.subarray(0, 1000), bytes.subarray(1000)]))
    expect(await readAll(backend, 'reader', '/var/tmp/x.bin', { offset: 4990 })).toEqual(bytes.subarray(4990))
    expect(await readAll(backend, 'reader', '/var/tmp/x.bin', { offset: 10, length: 0 })).toEqual(Buffer.alloc(0))
  })

  it('snapshots keep the base image\'s command and none of the machine\'s deadline or key, and refuse removal while in use', async () => {
    const source = await create('source', { deleteAfter: new Date('2030-01-01T00:00:00Z'), idempotencyKey: 'k1', labels: { 'example.com/team': 'qa' } })
    const snapshot = await backend.snapshot!(source.name, { labels: { 'blobby.dev/feature-hash': 'abc' } })
    expect(snapshot).toMatchObject({ id: expect.stringMatching(/^blobby-snapshot:source-/), source: 'source', labels: { ...OWNER, 'blobby.dev/feature-hash': 'abc' } })
    const commit = engine.requests.find((request) => request.path === '/commit')!
    expect(commit.query.get('pause')).toBe('true')
    expect(commit.body).toMatchObject({ Entrypoint: [], Cmd: ['/bin/bash'], Labels: { [DELETE_AFTER_LABEL]: '', [IDEMPOTENCY_LABEL]: '', [SNAPSHOT_SOURCE_LABEL]: 'source' } })
    const copy = await backend.createFrom!(snapshot.id, { name: 'copy' })
    expect(copy.labels).toEqual(OWNER)
    expect(copy.deleteAfter).toBeNull()
    expect(await backend.list({ labels: { 'example.com/team': 'qa' } })).toEqual([expect.objectContaining({ name: 'source' })])
    expect(await backend.snapshots!({ labels: { 'example.com/team': 'qa' } })).toEqual([])
    await expect(backend.removeSnapshot!(snapshot.id)).rejects.toMatchObject({ code: 'in_use', message: expect.stringContaining('copy') })
    await expect(backend.createFrom!('ubuntu:24.04', { name: 'not-a-snapshot' })).rejects.toMatchObject({ code: 'invalid_options' })
    await expect(backend.createFrom!('blobby-snapshot:missing', { name: 'missing' })).rejects.toMatchObject({ code: 'not_found' })
    const other = new DockerBackend({ target: engine.target, env: {}, labels: { [MANAGER_LABEL]: 'standalone:other-host' } })
    await expect(other.createFrom!(snapshot.id, { name: 'stolen' })).rejects.toMatchObject({ code: 'not_found' })
    await other.removeSnapshot!(snapshot.id)
    expect(engine.findImage(snapshot.id)).toBeTruthy()
  })

  it('takes its owner labels from this host by default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'blobby-test-'))
    try {
      const local = new DockerBackend({ target: engine.target, env: { XDG_CONFIG_HOME: dir } })
      const machine = await local.create({ name: 'hosted', image: UBUNTU_IMAGE })
      expect(machine.labels).toEqual({ [MANAGER_LABEL]: `standalone:${(await readFile(join(dir, 'blobby', 'host-id'), 'utf8')).trim()}` })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('tar', () => {
  const entry = (name: string, size: number, type: TarEntry['type'] = 'file'): TarEntry => ({ name, type, mode: 0o640, uid: 1000, gid: 1001, size, mtime: 1_700_000_000 })

  it('packs folders and files with long and non-ASCII names, which a reader parses back', async () => {
    const long = `${'folder/'.repeat(20)}fïlé with spaces.txt`
    const data = Buffer.from('héllo')
    const entries = [entry('a/b', 0, 'directory'), entry(long, data.length)]
    const archive = await collect(packEntries(entries, () => [data]))
    expect(archive.length).toBe(archiveSize(entries))
    expect(archive.length % 512).toBe(0)
    const parsed = parseTar(archive)
    expect(parsed.map((item) => [item.name, item.type, item.mode, item.uid, item.gid])).toEqual([
      ['a/b/', '5', 0o640, 1000, 1001],
      [long, '0', 0o640, 1000, 1001],
    ])
    expect(parsed[1]!.data).toEqual(data)
    expect(await collect(extractFirstFile(Readable.from([archive])))).toEqual(data)
  })

  it('fails when a stream has more or fewer bytes than it was packed with', async () => {
    await expect(collect(packEntries([entry('x', 3)], () => [Buffer.from('four')]))).rejects.toThrow(/more than/)
    await expect(collect(packEntries([entry('x', 5)], () => [Buffer.from('four')]))).rejects.toThrow(/not the 5/)
  })

  it('extracts a byte range without reading past it', async () => {
    const data = Buffer.from(Array.from({ length: 70_000 }, (_, index) => index % 256))
    const archive = await collect(packEntries([entry('big.bin', data.length)], () => [data]))
    let pulled = 0
    async function* slowly() {
      for (let at = 0; at < archive.length; at += 1000) {
        pulled = at + 1000
        yield archive.subarray(at, at + 1000)
      }
    }
    expect(await collect(extractFirstFile(slowly(), { offset: 1234, length: 5000 }))).toEqual(data.subarray(1234, 6234))
    expect(pulled).toBeLessThan(8000)
    await expect(collect(extractFirstFile(Readable.from([Buffer.alloc(1024)])))).rejects.toThrow(/no file/)
  })

  it('resolves owners from the machine\'s passwd and group files', () => {
    const passwd = 'root:x:0:0::/root:/bin/sh\nubuntu:x:1000:1000::/home/ubuntu:/bin/bash\n'
    const group = 'root:x:0:\nubuntu:x:1000:\nstaff:x:50:\n'
    expect(resolveOwner('ubuntu', passwd, group)).toEqual({ uid: 1000, gid: 1000 })
    expect(resolveOwner('ubuntu:staff', passwd, group)).toEqual({ uid: 1000, gid: 50 })
    expect(resolveOwner('4242', passwd, group)).toEqual({ uid: 4242, gid: 4242 })
    expect(resolveOwner('1000:7', passwd, group)).toEqual({ uid: 1000, gid: 7 })
    expect(resolveOwner('nobody', passwd, group)).toBeNull()
    expect(resolveOwner('ubuntu:wheel', passwd, group)).toBeNull()
  })
})

describe('the command sandbox\'s seccomp profile', () => {
  it('is Docker\'s default profile with only the namespace syscalls allowed', async () => {
    const base = await readFile(SECCOMP_PROFILE_URL, 'utf8')
    const original = JSON.parse(base) as { defaultAction: string; syscalls: { names: string[]; action: string }[] }
    const sandbox = JSON.parse(sandboxSeccompProfile(base)) as typeof original
    expect(sandbox.defaultAction).toBe(original.defaultAction)
    const namespaced = new Set<string>(NAMESPACE_SYSCALLS)
    const without = (rules: typeof original.syscalls) => rules.map((rule) => ({ ...rule, names: rule.names.filter((name) => !namespaced.has(name)) })).filter((rule) => rule.names.length)
    expect(without(sandbox.syscalls.slice(0, -1))).toEqual(without(original.syscalls))
    expect(sandbox.syscalls.at(-1)).toEqual({ names: [...NAMESPACE_SYSCALLS], action: 'SCMP_ACT_ALLOW' })
    expect(sandbox.syscalls.slice(0, -1).some((rule) => rule.names.some((name) => namespaced.has(name)))).toBe(false)
  })

  it('ships in the package with its Apache-2.0 license, and matches the desktop image\'s copy', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { files: string[]; exports: Record<string, unknown> }
    expect(manifest.files).toContain('seccomp')
    expect(manifest.exports['./docker']).toEqual({ types: './dist/docker/index.d.ts', default: './dist/docker/index.js' })
    expect(await readFile(new URL('../seccomp/LICENSE', import.meta.url), 'utf8')).toContain('Apache License')
    // moby/profiles' seccomp/default.json at 6fe7deb, unchanged.
    expect(createHash('sha256').update(await readFile(SECCOMP_PROFILE_URL)).digest('hex')).toBe('6416b47770785a41ac59073cdc77d9fe98517df2799dc83ef207e622de3053f6')
    const image = new URL('../images/desktop/seccomp/docker-default.json', import.meta.url)
    if (!existsSync(image)) return
    const hash = async (url: URL) => createHash('sha256').update(await readFile(url)).digest('hex')
    expect(await hash(SECCOMP_PROFILE_URL)).toBe(await hash(image))
  })
})
