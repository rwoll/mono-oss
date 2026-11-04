import { beforeEach, describe, expect, it } from 'vitest'
import { readAll } from '../src/backend.ts'
import { SmolvmBackend } from '../src/smolvm.ts'
import { FakeSdk, smolError, TEST_LABELS } from './fake-sdk.ts'

let sdk: FakeSdk
let backend: SmolvmBackend

beforeEach(() => {
  sdk = new FakeSdk()
  backend = new SmolvmBackend({ load: async () => sdk, labels: TEST_LABELS })
})

describe('SmolvmBackend', () => {
  it('always targets the local engine and never waits for ports', async () => {
    sdk.add('a', { state: 'running' })
    await backend.list()
    await backend.exec('a', ['true'])
    await backend.create({ name: 'b', image: 'ubuntu:24.04', resources: { cpus: 1, memoryMb: 512, storageGb: 20 } })
    const conns = sdk.calls.filter((call) => !['exec', 'execStream', 'start'].includes(call.method)).map((call) => call.args[call.method === 'list' ? 0 : 1])
    expect(new Set(sdk.calls.map((call) => call.method))).toEqual(new Set(['list', 'connect', 'exec', 'create']))
    for (const conn of conns) expect(conn).toEqual({ target: 'local', waitForPorts: false, handleSignals: false })
  })

  it('creates detached, labeled machines with the GPU and network', async () => {
    const deleteAfter = new Date('2026-01-02T03:04:05.000Z')
    const machine = await backend.create({
      name: 'a',
      image: 'ubuntu:24.04',
      resources: { cpus: 2, memoryMb: 1024, storageGb: 32, gpu: true },
      ports: [{ host: 5000, guest: 6901 }],
      labels: { 'blobby.dev/kind': 'desktop', 'example.com/x': 'y' },
      deleteAfter,
      idempotencyKey: 'k1',
    })
    const labels = { 'example.com/x': 'y', 'blobby.dev/delete-after': '2026-01-02T03:04:05.000Z', 'blobby.dev/create-key': 'k1', ...TEST_LABELS }
    expect(sdk.vms.get('a')?.config).toEqual({
      name: 'a',
      image: 'ubuntu:24.04',
      ports: [{ host: 5000, guest: 6901 }],
      waitForPorts: false,
      detach: true,
      branchable: false,
      labels,
      resources: { cpus: 2, memoryMb: 1024, storageGb: 32, network: true, gpu: true, networkBackend: 'virtio-net' },
    })
    expect(machine).toEqual({
      name: 'a',
      state: 'running',
      ports: [{ host: 5000, guest: 6901, hostIp: '127.0.0.1' }],
      createdAt: '2023-11-14T22:13:20.000Z',
      labels,
      deleteAfter: '2026-01-02T03:04:05.000Z',
    })
    expect(await backend.create({ name: 'a', image: 'ubuntu:24.04', idempotencyKey: 'k1' })).toEqual(machine)
    await expect(backend.create({ name: 'a', image: 'ubuntu:24.04', idempotencyKey: 'k2' })).rejects.toMatchObject({ code: 'already_exists' })
  })

  it('lists only its own machines, and only ports published on the host', async () => {
    sdk.add('mine', { ports: [{ host: 5000, guest: 6901 }, { guest: 22 }] })
    sdk.add('theirs', { labels: {} })
    expect(await backend.list()).toEqual([
      { name: 'mine', state: 'stopped', ports: [{ host: 5000, guest: 6901, hostIp: '127.0.0.1' }], createdAt: '2023-11-14T22:13:20.000Z', labels: TEST_LABELS, deleteAfter: null },
    ])
    expect(await backend.get('theirs')).toBeNull()
  })

  it('runs commands and passes the exit code through', async () => {
    sdk.add('a', { state: 'running' })
    sdk.onExec = () => ({ exitCode: 3, stdout: 'héllo\n', stderr: 'oops' })
    expect(await backend.exec('a', ['echo', 'hi'], { user: 'dev', env: { A: '1' } })).toEqual({ exitCode: 3, stdout: 'héllo\n', stderr: 'oops' })
    expect(sdk.calls.at(-1)?.args).toEqual(['a', ['echo', 'hi'], { user: 'dev', env: { A: '1' } }])
  })

  it('enforces time limits in the guest, so they end with exit code 124, with the SDK\'s limit as a backstop', async () => {
    sdk.add('a', { state: 'running' })
    await backend.exec('a', ['sleep', '9'], { timeoutSeconds: 5 })
    expect(sdk.calls.at(-1)?.args).toEqual(['a', ['timeout', '-k', '5', '5', 'sleep', '9'], { timeout: 35 }])
    sdk.onExec = () => {
      throw smolError('TIMEOUT', 'the command timed out')
    }
    expect(await backend.exec('a', ['sleep', '9'], { timeoutSeconds: 5 })).toEqual({ exitCode: 124, stdout: '', stderr: '' })
  })

  it('starts, stops, and removes machines', async () => {
    sdk.add('a')
    expect((await backend.start('a')).state).toBe('running')
    expect(sdk.calls.find((call) => call.method === 'start')?.args).toEqual(['a', { waitUntilReady: false }])
    await backend.stop('a')
    expect((await backend.get('a'))?.state).toBe('stopped')
    await backend.remove('a')
    expect(sdk.vms.size).toBe(0)
  })

  it('branches a branchable machine, and publishes ports on running machines', async () => {
    await backend.create({ name: 'base', image: 'ubuntu:24.04', branchable: true })
    await backend.writeFile('base', '/etc/marker', Buffer.from('baked'))
    const copy = await backend.branch('base', 'copy')
    expect(copy).toMatchObject({ name: 'copy', state: 'running', ports: [] })
    expect(sdk.vms.get('copy')?.files.get('/etc/marker')?.data.toString()).toBe('baked')
    expect(await backend.publish('copy', 6901)).toEqual({ host: 50000, guest: 6901, hostIp: '127.0.0.1' })
    expect((await backend.get('copy'))?.ports).toEqual([{ host: 50000, guest: 6901, hostIp: '127.0.0.1' }])
    expect(await backend.endpoint('copy', 6901)).toEqual({ kind: 'tcp', host: '127.0.0.1', port: 50000 })
    await expect(backend.remove('base')).rejects.toMatchObject({ code: 'smolvm_smolvm_error' })
    expect(backend.capabilities()).toMatchObject({ branch: true, publish: true, snapshot: false, networkPolicies: ['internet'] })
  })

  it('reuses the handles it created, which branch sources need', async () => {
    await backend.create({ name: 'base', image: 'ubuntu:24.04', branchable: true })
    await backend.exec('base', ['true'])
    expect(sdk.calls.filter((call) => call.method === 'connect' && call.args[0] === 'base')).toHaveLength(1)
  })

  it('passes stdin to commands, for secrets, without streaming, which drops it', async () => {
    sdk.add('a', { state: 'running' })
    sdk.onExec = () => ({ exitCode: 0, stdout: 'done\n' })
    const chunks: string[] = []
    await backend.exec('a', ['cat'], { stdin: 'secret', onOutput: (chunk) => chunks.push(chunk.text) })
    expect(sdk.calls.at(-1)).toMatchObject({ method: 'exec', args: ['a', ['cat'], { stdin: 'secret' }] })
    expect(chunks).toEqual(['done\n'])
  })

  it('moves files in and out', async () => {
    sdk.add('a', { state: 'running' })
    await backend.writeFile('a', '/tmp/a b.txt', Buffer.from('data'), { mode: 0o755 })
    expect(sdk.vms.get('a')?.files.get('/tmp/a b.txt')?.mode).toBe(0o755)
    expect((await readAll(backend, 'a', '/tmp/a b.txt')).toString()).toBe('data')
    expect((await readAll(backend, 'a', '/tmp/a b.txt', { offset: 1, length: 2 })).toString()).toBe('at')
    await backend.writeFile('a', '/tmp/plain', Buffer.from('x'))
    expect(sdk.vms.get('a')?.files.get('/tmp/plain')?.mode).toBe(0o644)
  })

  it('streams output to onOutput and still returns all of it', async () => {
    sdk.add('a', { state: 'running' })
    sdk.onExec = () => ({ exitCode: 2, stdout: 'line one\nline two\n', stderr: 'oops\n' })
    const chunks: string[] = []
    const result = await backend.exec('a', ['setup'], { onOutput: (chunk) => chunks.push(`${chunk.stream}:${chunk.text}`) })
    expect(result).toEqual({ exitCode: 2, stdout: 'line one\nline two\n', stderr: 'oops\n' })
    expect(chunks).toEqual(['stdout:line on', 'stdout:e\nline two\n', 'stderr:oops\n'])
    expect(sdk.calls.at(-1)?.method).toBe('execStream')
  })

  it('maps SDK errors to codes', async () => {
    sdk.add('a')
    await expect(backend.exec('a', ['true'])).rejects.toMatchObject({ code: 'smolvm_invalid_state', message: "machine 'a' is not running" })
    await expect(backend.start('missing')).rejects.toMatchObject({ code: 'not_found' })
    await expect(backend.readFile('a', '/nope')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('reports whether the host can run machines', async () => {
    expect(await backend.check()).toEqual({ ok: true, detail: 'smolmachines 1.31.0' })
    sdk.availability = { available: false, code: 'KVM_UNAVAILABLE', reason: 'Cannot open /dev/kvm.' }
    expect(await backend.check()).toEqual({ ok: false, detail: 'Cannot open /dev/kvm. (KVM_UNAVAILABLE)' })
    const broken = new SmolvmBackend({
      labels: TEST_LABELS,
      load: async () => {
        throw smolError('RUNTIME_NOT_INSTALLED', 'No engine for this platform.')
      },
    })
    expect(await broken.check()).toEqual({ ok: false, detail: 'The smolvm engine did not load: No engine for this platform.', code: 'smolvm_runtime_not_installed' })
  })
})
