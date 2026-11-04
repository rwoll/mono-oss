import { afterEach, describe, expect, it } from 'vitest'
import type { Capabilities } from '../src/backend.ts'
import type { CallbackRequest } from '../src/sandboxes.ts'
import { signInRecipe, world, type World } from './world.ts'

// The engine on backends that can do less than the fake can by default: like smolvm (branches, but takes
// no snapshots), like Docker (fixes ports at create, and neither branches nor takes snapshots, or takes
// snapshots), and backends that enforce fewer network policies.

const SMOLVM: Partial<Capabilities> = { snapshot: false, networkPolicies: ['internet'] }
const DOCKER: Partial<Capabilities> = { publish: false, branch: false, snapshot: false, gpu: false, networkPolicies: ['internet'] }
const DOCKER_SNAPSHOTS: Partial<Capabilities> = { ...DOCKER, snapshot: true }

let w: World
afterEach(() => w.cleanup())

const answer = (request: CallbackRequest) => w.secrets.answer(request)
const called = (method: string) => w.backend.calls.filter((call) => call.method === method)
const execs = () => called('exec').map((call) => (call.args[1] as string[]).join(' '))
const bases = () => [...w.backend.machines.keys()].filter((name) => name.startsWith('blobbybase-'))

describe('on a backend that branches but takes no snapshots, like smolvm', () => {
  it('copies new sandboxes from a running base, found by its name and labels, and publishes their viewer', async () => {
    w = await world({ capabilities: SMOLVM })
    const progress: string[] = []
    const started = await w.engine.start('t1', { recipe: signInRecipe, onRequest: answer, onProgress: (line) => progress.push(line) })
    expect(started).toMatchObject({ created: true, from: 'base', steps: [{ name: 'Sign in to the test account' }] })
    const [base] = bases()
    const machine = w.backend.machines.get(base!)!
    expect(machine.branchable).toBe(true)
    expect(machine.labels).toMatchObject({ 'blobby.dev/kind': 'desktop', 'blobby.dev/recipe': 'signin-test', 'blobby.dev/image': 'ubuntu:24.04' })
    expect(machine.labels['blobby.dev/delete-after']).toBeUndefined()
    expect(w.backend.machines.get('blobby-t1')!.source).toBe(base)
    expect(called('publish').map((call) => call.args)).toEqual([['blobby-t1', 6901]])
    expect(progress).toContain("Copying the signin-test recipe's base")
    expect(called('snapshot')).toEqual([])

    w.backend.calls.length = 0
    await w.engine.start('t2', { recipe: signInRecipe, onRequest: answer })
    expect(called('create')).toEqual([])
    expect(execs()).not.toContain('bash /opt/blobby/runtime/setup.sh')
  })

  it('removes a copy of an unfinished base, and installs the base again when its install was abandoned', async () => {
    w = await world({ capabilities: SMOLVM })
    await w.engine.start('t1', { onRequest: answer })
    await w.engine.remove('t1')
    const [base] = bases()
    // A base from an install that died: it never got its finished marker, long ago.
    w.backend.machines.get(base!)!.files.delete('/etc/blobby/base-ready')
    w.backend.machines.get(base!)!.createdAt = '2020-01-01T00:00:00.000Z'
    w.backend.calls.length = 0
    expect(await w.engine.start('t2', { onRequest: answer })).toMatchObject({ from: 'base' })
    expect(called('remove').map((call) => call.args[0])).toEqual(['blobby-t2', base])
    expect(called('create').map((call) => (call.args[0] as { name: string }).name)).toEqual([base])
    expect(w.backend.machines.get('blobby-t2')!.files.has('/etc/blobby/base-ready')).toBe(true)
  })

  it('installs from scratch when an unfinished base can\'t be removed, instead of waiting for it', async () => {
    w = await world({ capabilities: SMOLVM })
    await w.engine.start('t1', { onRequest: answer })
    const [base] = bases()
    w.backend.machines.get(base!)!.files.delete('/etc/blobby/base-ready')
    w.backend.machines.get(base!)!.createdAt = '2020-01-01T00:00:00.000Z'
    const progress: string[] = []
    expect(await w.engine.start('t2', { onRequest: answer, onProgress: (line) => progress.push(line) })).toMatchObject({ from: 'scratch' })
    expect(progress).toContain(`The vscode-insiders recipe's base ${base} was never finished, and can't be removed while it has copies. Installing this one from scratch.`)
  })

  it('waits for another process\'s install of the base to finish', async () => {
    w = await world({ capabilities: SMOLVM })
    await w.engine.start('t1', { onRequest: answer })
    await w.engine.remove('t1')
    const [base] = bases()
    const files = w.backend.machines.get(base!)!.files
    const marker = files.get('/etc/blobby/base-ready')!
    files.delete('/etc/blobby/base-ready')
    let branches = 0
    const branch = w.backend.branch.bind(w.backend)
    w.backend.branch = async (source, name) => {
      if (++branches === 3) files.set('/etc/blobby/base-ready', marker)
      return branch(source, name)
    }
    const progress: string[] = []
    expect(await w.engine.start('t2', { onRequest: answer, onProgress: (line) => progress.push(line) })).toMatchObject({ from: 'base' })
    expect(branches).toBe(3)
    expect(progress).toContain("Waiting for another install of the vscode-insiders recipe's base")
  })

  it('removes only the same recipe\'s older bases, reading bases without a recipe label as vscode-insiders', async () => {
    w = await world({ capabilities: SMOLVM })
    // Bases from before labels, and another recipe's.
    w.backend.add('blobbybase-000000000001', { state: 'running', labels: { 'blobby.dev/kind': 'desktop' } })
    w.backend.add('blobbybase-000000000002', { state: 'running', labels: { 'blobby.dev/recipe': 'desktop' } })
    await w.engine.start('t1', { onRequest: answer })
    expect(w.backend.machines.has('blobbybase-000000000001')).toBe(false)
    expect(w.backend.machines.has('blobbybase-000000000002')).toBe(true)
    expect(bases()).toHaveLength(2)
  })

  it('installs from scratch for sizes and network policies a copy can\'t have', async () => {
    w = await world({ capabilities: { snapshot: false } })
    expect(await w.engine.start('t1', { cpus: 2, steps: 'never' })).toMatchObject({ from: 'scratch' })
    expect(await w.engine.start('t2', { network: { allow: ['github.com'] }, steps: 'never' })).toMatchObject({ from: 'scratch' })
    expect(w.backend.machines.get('blobby-t2')!.network).toEqual({ allow: ['github.com'] })
    expect(called('branch')).toEqual([])
  })
})

describe('on a backend that fixes ports at create and neither branches nor takes snapshots, like Docker', () => {
  it('installs each sandbox from scratch, with the viewer\'s port asked for at create', async () => {
    w = await world({ capabilities: DOCKER })
    const started = await w.engine.start('t1', { recipe: signInRecipe, onRequest: answer })
    expect(started).toMatchObject({ created: true, from: 'scratch', steps: [{ name: 'Sign in to the test account' }] })
    const [create] = called('create')
    expect(create!.args[0]).toMatchObject({
      name: 'blobby-t1',
      image: 'ubuntu:24.04',
      ports: [{ guest: 6901 }],
      resources: { cpus: 4, memoryMb: 8192, gpu: false },
      labels: { 'blobby.dev/kind': 'desktop' },
      deleteAfter: expect.any(Date),
    })
    expect(started.sandbox.viewerPort).toBe(w.backend.machines.get('blobby-t1')!.ports[0]!.host)
    for (const method of ['publish', 'branch', 'snapshot', 'snapshots', 'createFrom']) expect(called(method)).toEqual([])
    expect(bases()).toEqual([])
    expect(await w.engine.view('t1')).toMatchObject({ endpoint: { kind: 'tcp', host: '127.0.0.1' } })
    await w.engine.remove('t1')
    expect(called('snapshots')).toEqual([])
  })

  it('says how to recover a sandbox whose viewer was never published', async () => {
    w = await world({ capabilities: DOCKER })
    w.backend.add('blobby-old', { state: 'running' })
    w.guest.ready = true
    await expect(w.engine.start('old', { steps: 'never' })).rejects.toMatchObject({ code: 'not_published', message: expect.stringContaining('blobby-sandbox rm old') })
  })

  it('makes new sandboxes from a snapshot of the base when it takes snapshots', async () => {
    w = await world({ capabilities: DOCKER_SNAPSHOTS })
    await w.engine.start('t1', { onRequest: answer })
    await w.engine.start('t2', { onRequest: answer, cpus: 2 })
    expect(called('createFrom').map((call) => call.args[1])).toEqual([
      expect.objectContaining({ name: 'blobby-t1', ports: [{ guest: 6901 }] }),
      expect.objectContaining({ name: 'blobby-t2', ports: [{ guest: 6901 }], resources: expect.objectContaining({ cpus: 2 }) }),
    ])
    expect(called('create').map((call) => (call.args[0] as { name: string; ports: unknown[] }).name)).toEqual([expect.stringMatching(/^blobbybase-/)])
    expect(called('publish')).toEqual([])
    expect(bases()).toEqual([])
  })
})

describe('network policies and deadlines', () => {
  it('fails closed, before making anything, for a network policy the backend can\'t enforce', async () => {
    w = await world({ capabilities: DOCKER_SNAPSHOTS })
    await expect(w.engine.start('t1', { network: 'none' })).rejects.toMatchObject({ code: 'network_unenforceable', message: expect.stringContaining("can't enforce the none network policy") })
    expect(called('create')).toEqual([])
    expect(called('createFrom')).toEqual([])
  })

  it('runs unrestricted, with a warning, when allowed to', async () => {
    w = await world({ capabilities: DOCKER_SNAPSHOTS })
    const progress: string[] = []
    await w.engine.start('t1', { network: 'none', allowUnenforcedNetwork: true, steps: 'never', onProgress: (line) => progress.push(line) })
    expect(progress).toContain("Warning: the fake backend can't enforce the none network policy, so this sandbox's network is unrestricted. Use this for local development only.")
    expect(w.backend.machines.get('blobby-t1')!.network).toBe('internet')
  })

  it('passes a network policy the backend enforces on to it', async () => {
    w = await world()
    await w.engine.start('t1', { network: 'none', steps: 'never' })
    expect(w.backend.machines.get('blobby-t1')!.network).toBe('none')
  })

  it('gives new sandboxes the deletion deadline asked for, or none', async () => {
    w = await world()
    await w.engine.start('t1', { deleteAfter: '2h', steps: 'never' })
    const deadline = Date.parse(w.backend.machines.get('blobby-t1')!.labels['blobby.dev/delete-after']!)
    expect(Math.abs(deadline - (Date.now() + 2 * 60 * 60_000))).toBeLessThan(60_000)
    await w.engine.start('t2', { deleteAfter: 'never', steps: 'never' })
    expect(w.backend.machines.get('blobby-t2')!.labels['blobby.dev/delete-after']).toBeUndefined()
    expect((await w.engine.list()).find((sandbox) => sandbox.name === 't2')).toMatchObject({ deleteAfter: null })
    await expect(w.engine.start('t3', { deleteAfter: '2 hours' })).rejects.toMatchObject({ code: 'usage' })
    expect(w.backend.machines.has('blobby-t3')).toBe(false)
  })
})
