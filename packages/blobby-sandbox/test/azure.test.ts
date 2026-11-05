import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AzCliCredential,
  AzureBackend,
  azureError,
  diskImageName,
  egressPolicy,
  imageReference,
  lifecycle,
  loadAzureConfig,
  machineState,
  missingSdk,
  NAME_LABEL,
  otherSize,
  quantity,
  redact,
  OUTPUT_LIMIT_BYTES,
  shellQuote,
  SNAPSHOT_OF_LABEL,
  wrapCommand,
  type AzureApi,
  type AzureConfig,
  type AzureCreateRequest,
  type AzureDiskImage,
  type AzureSandbox,
  type AzureSnapshot,
  type Runner,
} from '../src/azure/index.ts'
import { readAll, SandboxError } from '../src/backend.ts'
import { KILL_SCRIPT } from '../src/contract.ts'
import { MANAGER_LABEL } from '../src/labels.ts'
import { backendConformance, type ConformanceTarget } from '../src/testing.ts'

const CONFIG: AzureConfig = { subscription: '00000000-0000-0000-0000-000000000000', resourceGroup: 'rg-contoso', sandboxGroup: 'sg-contoso', location: 'westus2' }
const OWNER = { [MANAGER_LABEL]: 'standalone:test' }

type ExecHandler = (id: string, command: string) => Promise<{ exitCode: number; stdout: string; stderr: string }> | { exitCode: number; stdout: string; stderr: string }

/** An in-memory sandbox group. Commands go to `onExec`, which tests set. */
class FakeApi implements AzureApi {
  sandboxes = new Map<string, AzureSandbox>()
  snapshotsById = new Map<string, AzureSnapshot>()
  images: AzureDiskImage[] = []
  files = new Map<string, { data: Buffer; mode: number }>()
  created: AzureCreateRequest[] = []
  builtImages: string[] = []
  commands: string[] = []
  deleted: string[] = []
  onExec: ExecHandler = () => ({ exitCode: 0, stdout: '', stderr: '' })
  #count = 0

  #id(prefix: string) {
    this.#count += 1
    return `${prefix}-${String(this.#count).padStart(4, '0')}`
  }

  async listSandboxes(labels: Record<string, string>) {
    return [...this.sandboxes.values()].filter((sandbox) => Object.entries(labels).every(([key, value]) => sandbox.labels[key] === value)).map((sandbox) => structuredClone(sandbox))
  }
  async getSandbox(id: string) {
    const sandbox = this.sandboxes.get(id)
    return sandbox ? structuredClone(sandbox) : null
  }
  async createSandbox(request: AzureCreateRequest) {
    this.created.push(structuredClone(request))
    const sandbox: AzureSandbox = {
      id: this.#id('sbx'),
      state: 'Running',
      labels: { ...request.labels },
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, this.#count)).toISOString(),
      sourcesRef: 'snapshot' in request.sourcesRef ? { snapshot: { ...request.sourcesRef.snapshot } } : { diskImage: { ...request.sourcesRef.diskImage } },
    }
    this.sandboxes.set(sandbox.id, sandbox)
    return structuredClone(sandbox)
  }
  async deleteSandbox(id: string) {
    this.deleted.push(id)
    if (!this.sandboxes.delete(id)) throw new SandboxError('not_found', 'gone')
  }
  async stopSandbox(id: string) {
    this.sandboxes.get(id)!.state = 'Stopped'
  }
  async resumeSandbox(id: string) {
    this.sandboxes.get(id)!.state = 'Running'
  }
  async exec(id: string, command: string) {
    this.commands.push(command)
    return this.onExec(id, command)
  }
  async writeFile(id: string, path: string, data: Uint8Array, mode: number) {
    this.files.set(`${id}:${path}`, { data: Buffer.from(data), mode })
  }
  async readFile(id: string, path: string) {
    const file = this.files.get(`${id}:${path}`)
    if (!file) throw new SandboxError('not_found', 'no file')
    // In small pieces, so ranges cross chunk boundaries.
    return Readable.from((function* () {
      for (let offset = 0; offset < file.data.length; offset += 7) yield file.data.subarray(offset, offset + 7)
    })())
  }
  async snapshot(id: string, labels: Record<string, string>) {
    const resources = this.created.find((request) => request.labels[NAME_LABEL] === this.sandboxes.get(id)?.labels[NAME_LABEL])?.resources
    const snapshot: AzureSnapshot = { id: this.#id('snap'), labels: { ...labels }, sandboxId: id, createdAtUtc: new Date(Date.UTC(2026, 0, 2, 0, 0, this.#count)).toISOString(), ...(resources ? { resources: { cpu: resources.cpu, memory: resources.memory, disk: resources.disk.replace(/(\d+)Gi$/, (_, gb: string) => `${Number(gb) * 1024}Mi`) } } : {}) }
    this.snapshotsById.set(snapshot.id, snapshot)
    return structuredClone(snapshot)
  }
  async listSnapshots() {
    return [...this.snapshotsById.values()].map((snapshot) => structuredClone(snapshot))
  }
  async getSnapshot(id: string) {
    const snapshot = this.snapshotsById.get(id)
    return snapshot ? structuredClone(snapshot) : null
  }
  async deleteSnapshot(id: string) {
    if (!this.snapshotsById.delete(id)) throw new SandboxError('not_found', 'gone')
  }
  async listDiskImages() {
    return structuredClone(this.images)
  }
  async createDiskImage(base: string, name: string) {
    this.builtImages.push(base)
    const image: AzureDiskImage = { id: this.#id('img'), name, labels: { name }, status: { state: 'Ready' } }
    this.images.push(image)
    return structuredClone(image)
  }
}

function backend(api: FakeApi, labels: Record<string, string> = OWNER, extra: Partial<ConstructorParameters<typeof AzureBackend>[0]> = {}) {
  return new AzureBackend({ labels, config: CONFIG, api: async () => api, pollMs: 1, now: () => Date.UTC(2026, 0, 1), ...extra })
}

const isCode = (code: string) => expect.objectContaining({ name: 'SandboxError', code })

describe('azure backend on a fake sandbox group', () => {
  let api: FakeApi
  beforeEach(() => {
    api = new FakeApi()
  })

  it('creates a machine from a disk image built once per image, with its name as a label it keeps to itself', async () => {
    const azure = backend(api)
    const deleteAfter = new Date(Date.UTC(2026, 0, 2))
    const machine = await azure.create({ name: 'one', image: 'ubuntu:24.04', resources: { cpus: 2, memoryMb: 4096, storageGb: 32 }, labels: { 'example.com/x': 'y' }, deleteAfter })
    expect(machine).toMatchObject({ name: 'one', state: 'running', ports: [], deleteAfter: deleteAfter.toISOString() })
    expect(machine.labels).toEqual({ 'example.com/x': 'y', 'blobby.dev/delete-after': deleteAfter.toISOString(), ...OWNER })
    expect(api.builtImages).toEqual(['docker.io/library/ubuntu:24.04'])
    expect(api.created[0]).toEqual({
      sourcesRef: { diskImage: { id: api.images[0]!.id } },
      resources: { cpu: '2', memory: '4096Mi', disk: '32Gi' },
      labels: { ...machine.labels, [NAME_LABEL]: 'one' },
      lifecycle: { autoSuspend: { enabled: false }, autoDelete: { enabled: true, deleteIntervalSeconds: 86_400 } },
      egressPolicy: { defaultAction: 'Allow', hostRules: [], rules: [], trafficInspection: 'None' },
    })
    await azure.create({ name: 'two', image: 'ubuntu:24.04' })
    await backend(api).create({ name: 'three', image: 'ubuntu:24.04' })
    expect(api.builtImages).toHaveLength(1)
    expect((await azure.list()).map((found) => found.name)).toEqual(['one', 'three', 'two'])
  })

  it('maps network policies onto the egress proxy, and fails closed on the one it lacks', async () => {
    const azure = backend(api)
    await azure.create({ name: 'internet', image: 'ubuntu' })
    await azure.create({ name: 'essential', image: 'ubuntu', network: 'essential' })
    await azure.create({ name: 'allow', image: 'ubuntu', network: { allow: ['github.com', '*.github.com'] } })
    expect(api.created.map((request) => request.egressPolicy)).toEqual([
      { defaultAction: 'Allow', hostRules: [], rules: [], trafficInspection: 'None' },
      { defaultAction: 'Deny', hostRules: [], rules: [], trafficInspection: 'Full' },
      { defaultAction: 'Deny', hostRules: [{ pattern: 'github.com', action: 'Allow' }, { pattern: '*.github.com', action: 'Allow' }], rules: [], trafficInspection: 'Full' },
    ])
    await expect(azure.create({ name: 'none', image: 'ubuntu', network: 'none' })).rejects.toEqual(isCode('network_unenforceable'))
    await expect(azure.create({ name: 'ports', image: 'ubuntu', ports: [{ guest: 6080 }] })).rejects.toEqual(isCode('unsupported'))
    expect(await azure.get('none')).toBeNull()
  })

  it('returns the machine an idempotent create already made, and refuses a second machine with the name', async () => {
    const azure = backend(api)
    const first = await azure.create({ name: 'a', image: 'ubuntu', idempotencyKey: 'k1' })
    expect(await azure.create({ name: 'a', image: 'ubuntu', idempotencyKey: 'k1' })).toEqual(first)
    await expect(azure.create({ name: 'a', image: 'ubuntu', idempotencyKey: 'k2' })).rejects.toEqual(isCode('already_exists'))
    await expect(azure.create({ name: 'a', image: 'ubuntu' })).rejects.toEqual(isCode('already_exists'))
    expect(api.created).toHaveLength(1)
    await expect(azure.create({ name: 'not a name', image: 'ubuntu' })).rejects.toEqual(isCode('invalid_options'))
  })

  it('removes its own sandbox when another create with the same name won a race', async () => {
    const azure = backend(api)
    const create = api.createSandbox.bind(api)
    api.createSandbox = async (request) => {
      // Another process creates the same name first.
      await create(request)
      return create(request)
    }
    await expect(azure.create({ name: 'raced', image: 'ubuntu' })).rejects.toEqual(isCode('already_exists'))
    expect(api.sandboxes.size).toBe(1)
    expect(api.deleted).toEqual(['sbx-0003'])
  })

  it('sees only its own owner\'s machines and snapshots', async () => {
    const mine = backend(api)
    const theirs = backend(api, { [MANAGER_LABEL]: 'standalone:other' })
    await mine.create({ name: 'mine', image: 'ubuntu' })
    await theirs.create({ name: 'theirs', image: 'ubuntu' })
    expect((await mine.list()).map((machine) => machine.name)).toEqual(['mine'])
    expect(await mine.get('theirs')).toBeNull()
    await mine.remove('theirs')
    expect(await theirs.get('theirs')).not.toBeNull()
    const snapshot = await theirs.snapshot('theirs')
    expect(await mine.snapshots()).toEqual([])
    await mine.removeSnapshot(snapshot.id)
    expect(api.snapshotsById.has(snapshot.id)).toBe(true)
    await expect(mine.createFrom(snapshot.id, { name: 'stolen' })).rejects.toEqual(isCode('not_found'))
  })

  it('starts, stops, and removes machines, and repeats safely', async () => {
    const azure = backend(api)
    await azure.create({ name: 'a', image: 'ubuntu' })
    await azure.stop('a')
    expect((await azure.get('a'))?.state).toBe('stopped')
    await azure.stop('a')
    await expect(azure.exec('a', ['true'])).rejects.toEqual(isCode('not_running'))
    expect((await azure.start('a')).state).toBe('running')
    await azure.remove('a')
    await azure.remove('a')
    expect(await azure.get('a')).toBeNull()
    await expect(azure.start('a')).rejects.toEqual(isCode('not_found'))
  })

  it('takes labeled snapshots, creates machines from them without resources, and keeps them while machines use them', async () => {
    const azure = backend(api)
    await azure.create({ name: 'base', image: 'ubuntu' })
    const snapshot = await azure.snapshot('base', { labels: { 'blobby.dev/base': 'abc' } })
    expect(snapshot).toMatchObject({ source: 'base', labels: { 'blobby.dev/base': 'abc', ...OWNER } })
    expect(api.snapshotsById.get(snapshot.id)?.labels[SNAPSHOT_OF_LABEL]).toBe('base')
    expect((await azure.snapshots({ labels: { 'blobby.dev/base': 'abc' } })).map((found) => found.id)).toEqual([snapshot.id])
    expect(await azure.snapshots({ labels: { 'blobby.dev/base': 'other' } })).toEqual([])
    await expect(azure.createFrom(snapshot.id, { name: 'big', resources: { cpus: 8, memoryMb: 1024 } })).rejects.toThrow("Azure sandboxes made from a snapshot have its size (1 CPU, 1024 MB), so big can't have 8 CPUs.")
    expect(await azure.get('big')).toBeNull()
    const copy = await azure.createFrom(snapshot.id, { name: 'copy', resources: { cpus: 1, memoryMb: 1024, storageGb: 10 }, network: 'essential' })
    expect(copy.image).toBe(snapshot.id)
    expect(api.created.at(-1)).toEqual({
      sourcesRef: { snapshot: { id: snapshot.id } },
      labels: { ...OWNER, [NAME_LABEL]: 'copy' },
      lifecycle: { autoSuspend: { enabled: false }, autoDelete: { enabled: false } },
      egressPolicy: { defaultAction: 'Deny', hostRules: [], rules: [], trafficInspection: 'Full' },
    })
    await expect(azure.removeSnapshot(snapshot.id)).rejects.toEqual(isCode('in_use'))
    await azure.remove('copy')
    await azure.removeSnapshot(snapshot.id)
    await azure.removeSnapshot(snapshot.id)
    expect(await azure.snapshots()).toEqual([])
  })

  it('runs a short command in one call, with the caller\'s user, variables, and limit', async () => {
    const azure = backend(api)
    await azure.create({ name: 'a', image: 'ubuntu' })
    api.onExec = () => ({ exitCode: 0, stdout: `3\n${Buffer.from('héllo\n').toString('base64')}\n${Buffer.from('oops').toString('base64')}\n1\n`, stderr: '' })
    expect(await azure.exec('a', ['sh', '-c', 'echo "$1"', 'sh', "it's"], { user: 'ubuntu', env: { A: 'b c' }, timeoutSeconds: 60 })).toEqual({ exitCode: 3, stdout: 'héllo\n', stderr: 'oops' })
    expect(api.commands).toHaveLength(1)
    expect(api.commands[0]).toContain(shellQuote(`u='ubuntu'`).slice(1, -1))
    expect(api.commands[0]).toContain(shellQuote(`'A=b c' 'timeout' '-k' '5' '60' 'sh' '-c' 'echo "$1"' 'sh' 'it'\\''s'`).slice(1, -1))
    await expect(azure.exec('a', ['true'], { env: { GH_TOKEN: 'x' } })).rejects.toEqual(isCode('env_blocked'))
    await expect(azure.exec('a', ['true'], { env: { BLOBBY_EXEC_ID: 'x' } })).rejects.toEqual(isCode('invalid_options'))
    await expect(azure.exec('a', ['true'], { user: 'a b' })).rejects.toEqual(isCode('invalid_options'))
    api.onExec = () => ({ exitCode: 125, stdout: '', stderr: 'mkdir: cannot create directory' })
    await expect(azure.exec('a', ['true'])).rejects.toEqual(isCode('azure_exec'))
  })

  it('passes stdin through a memory-only file the command removes once it is open', async () => {
    const azure = backend(api)
    await azure.create({ name: 'a', image: 'ubuntu' })
    api.onExec = () => ({ exitCode: 0, stdout: '0\n\n\n1\n', stderr: '' })
    await azure.exec('a', ['cat'], { stdin: 'pa55-w0rd!\n' })
    const [key, file] = [...api.files][0]!
    expect(key).toMatch(/^sbx-\d+:\/run\/blobby-exec\/[0-9a-f]{24}\.stdin$/)
    expect(file).toEqual({ data: Buffer.from('pa55-w0rd!\n'), mode: 0o600 })
    const path = key!.split(':')[1]!
    expect(api.commands[0]).toContain(shellQuote(`exec 0<'${path}' || exit 125; rm -f -- '${path}'`).slice(1, -1))
    expect(api.commands[0]).not.toContain('pa55')
  })

  it('kills a cancelled command and rejects with cancelled', async () => {
    const azure = backend(api)
    await azure.create({ name: 'a', image: 'ubuntu' })
    let release = () => {}
    api.onExec = (_, command) =>
      command.includes(KILL_SCRIPT.slice(0, 20))
        ? (release(), { exitCode: 0, stdout: '', stderr: '' })
        : new Promise((resolve) => (release = () => resolve({ exitCode: 143, stdout: '', stderr: '' })))
    const controller = new AbortController()
    const running = azure.exec('a', ['sleep', '60'], { signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()
    await expect(running).rejects.toEqual(isCode('cancelled'))
    const marker = /BLOBBY_EXEC_ID=([0-9a-f]{24})/.exec(api.commands[0]!)![1]
    expect(api.commands[1]).toContain(`sh ${marker} BLOBBY_EXEC_ID`)
    await expect(azure.exec('a', ['true'], { signal: AbortSignal.abort() })).rejects.toEqual(isCode('cancelled'))
  })

  it('stops waiting for a background command past its limit, with exit code 124', async () => {
    let now = Date.UTC(2026, 0, 1)
    const azure = backend(api, OWNER, { now: () => now })
    await azure.create({ name: 'a', image: 'ubuntu' })
    api.onExec = (_, command) => {
      if (command.startsWith('e=$(cat')) now += 120_000
      return { exitCode: 0, stdout: command.startsWith('e=$(cat') ? '\n\n\n0\n' : '', stderr: '' }
    }
    expect(await azure.exec('a', ['sleep', '600'], { timeoutSeconds: 1, onOutput: () => {} })).toEqual({ exitCode: 124, stdout: '', stderr: '' })
    expect(api.commands.some((command) => command.includes(KILL_SCRIPT.slice(0, 20)))).toBe(true)
  })

  it('reads files as streams and byte ranges, and writes them with their mode and owner', async () => {
    const azure = backend(api)
    const { name } = await azure.create({ name: 'a', image: 'ubuntu' })
    const bytes = randomBytes(100)
    api.onExec = (_, command) => (command.startsWith('stat') ? { exitCode: 0, stdout: '100 640\n', stderr: '' } : { exitCode: 0, stdout: '', stderr: '' })
    await azure.writeFile(name, '/opt/a b/file', Readable.from([bytes.subarray(0, 30), bytes.subarray(30)]), { mode: 0o640, user: 'ubuntu' })
    expect(api.commands.at(-1)).toBe(`chown -- 'ubuntu:' '/opt/a b/file' && chmod 640 -- '/opt/a b/file'`)
    await azure.writeFile(name, '/opt/plain', Buffer.from('x'))
    expect(api.commands.at(-1)).toBe(`chmod 644 -- '/opt/plain'`)
    expect(await readAll(azure, name, '/opt/a b/file')).toEqual(bytes)
    expect(await readAll(azure, name, '/opt/a b/file', { offset: 5, length: 20 })).toEqual(bytes.subarray(5, 25))
    expect(await readAll(azure, name, '/opt/a b/file', { offset: 95, length: 50 })).toEqual(bytes.subarray(95))
    expect(await readAll(azure, name, '/opt/a b/file', { offset: 10, length: 0 })).toEqual(Buffer.alloc(0))
    await expect(azure.readFile(name, '/opt/missing')).rejects.toEqual(isCode('not_found'))
    await expect(azure.readFile(name, 'relative')).rejects.toEqual(isCode('invalid_options'))
    expect(await azure.stat(name, '/opt/a b/file')).toEqual({ size: 100, mode: 0o640 })
    api.onExec = () => ({ exitCode: 1, stdout: '', stderr: "stat: cannot statx '/x': No such file or directory\n" })
    expect(await azure.stat(name, '/x')).toBeNull()
  })

  it('has no published ports', async () => {
    const azure = backend(api)
    await azure.create({ name: 'a', image: 'ubuntu' })
    await expect(azure.endpoint('a', 6080)).rejects.toEqual(isCode('not_published'))
    expect(azure.capabilities()).toMatchObject({ ports: false, publish: false, branch: false, stdin: true, snapshot: true, labels: true })
  })

  it('reports a missing sandbox group in check, without throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'blobby-azure-'))
    try {
      const status = await new AzureBackend({ env: { XDG_CONFIG_HOME: dir }, labels: OWNER }).check()
      expect(status).toMatchObject({ ok: false, code: 'azure_not_configured' })
      expect((await backend(api).check()).ok).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('azure backend parts', () => {
  it('reads azure.json from the config folder and says what is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'blobby-azure-'))
    try {
      const env = { XDG_CONFIG_HOME: dir }
      await expect(loadAzureConfig(env)).rejects.toEqual(isCode('azure_not_configured'))
      await mkdir(join(dir, 'blobby'))
      await writeFile(join(dir, 'blobby', 'azure.json'), JSON.stringify({ subscription: 's', location: 'westus2' }))
      await expect(loadAzureConfig(env)).rejects.toThrow(/has no resourceGroup, sandboxGroup/)
      await writeFile(join(dir, 'blobby', 'azure.json'), JSON.stringify({ ...CONFIG, extra: 1 }))
      expect(await loadAzureConfig(env)).toEqual(CONFIG)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('gets tokens from the Azure CLI for the configured subscription, and keeps them until they nearly expire', async () => {
    const calls: string[][] = []
    let expires = Math.floor(Date.now() / 1000) + 3600
    const run: Runner = async (_, args) => {
      calls.push([...args])
      return { code: 0, stdout: JSON.stringify({ accessToken: `t${calls.length}`, expires_on: expires }), stderr: '' }
    }
    const credential = new AzCliCredential(CONFIG.subscription, run)
    expect((await credential.getToken('https://dynamicsessions.io/.default')).token).toBe('t1')
    expect((await credential.getToken(['https://dynamicsessions.io/.default'])).token).toBe('t1')
    expect(calls).toEqual([['account', 'get-access-token', '--scope', 'https://dynamicsessions.io/.default', '--subscription', CONFIG.subscription, '--output', 'json']])
    expires = Math.floor(Date.now() / 1000) + 60
    const soon = new AzCliCredential(CONFIG.subscription, run)
    await soon.getToken('s')
    await soon.getToken('s')
    expect(calls).toHaveLength(3)
  })

  it('says how to sign in when the Azure CLI is missing or fails, without the subscription', async () => {
    const missing: Runner = async () => {
      throw Object.assign(new Error('spawn az ENOENT'), { code: 'ENOENT' })
    }
    await expect(new AzCliCredential(CONFIG.subscription, missing).getToken('s')).rejects.toEqual(isCode('azure_cli_missing'))
    const failing: Runner = async () => ({ code: 1, stdout: '', stderr: `ERROR: The subscription '${CONFIG.subscription}' doesn't exist. Run az login.\n` })
    const error = await new AzCliCredential(CONFIG.subscription, failing).getToken('s').catch((caught: SandboxError) => caught)
    expect(error).toEqual(isCode('azure_auth'))
    expect((error as Error).message).not.toContain(CONFIG.subscription)
    expect((error as Error).message).toContain('az login')
  })

  it('maps service errors onto stable codes with the service\'s words and no subscription IDs', () => {
    const body = JSON.stringify({ title: 'One or more validation errors occurred.', errors: { 'resources.cpu': ['must be at least 1'] } })
    const invalid = azureError({ statusCode: 400 }, body, CONFIG, 'Creating a sandbox')
    expect(invalid).toEqual(isCode('invalid_options'))
    expect(invalid.message).toBe('Creating a sandbox failed (HTTP 400): One or more validation errors occurred. resources.cpu: must be at least 1')
    const forbidden = azureError({ statusCode: 403, message: `No access to /subscriptions/${CONFIG.subscription}/resourceGroups/x` }, undefined, CONFIG, 'Listing sandboxes')
    expect(forbidden).toEqual(isCode('azure_forbidden'))
    expect(forbidden.message).toContain('/subscriptions/<subscription>/resourceGroups/x')
    expect(forbidden.message).toContain('SandboxGroup Data Owner')
    expect(azureError({ statusCode: 404 }, undefined, CONFIG, 'x')).toEqual(isCode('not_found'))
    expect(azureError({ statusCode: 409 }, undefined, CONFIG, 'x')).toEqual(isCode('in_use'))
    expect(azureError({ statusCode: 429 }, undefined, CONFIG, 'x')).toEqual(isCode('limit_reached'))
    expect(azureError({ statusCode: 500 }, undefined, CONFIG, 'x')).toEqual(isCode('azure_error'))
    const other = [8, 4, 4, 4, 12].map((length) => '1'.repeat(length)).join('-')
    expect(redact(`id ${CONFIG.subscription} and /subscriptions/${other}/x`, CONFIG)).toBe('id <subscription> and /subscriptions/<subscription>/x')
  })

  it('says how to install the SDK when it is missing', () => {
    const error = missingSdk(Object.assign(new Error("Cannot find package '@azure/containerapps-sandbox' imported from x"), { code: 'ERR_MODULE_NOT_FOUND' }))
    expect(error).toEqual(isCode('azure_sdk_missing'))
    expect(error?.message).toContain('npm install -g @azure/containerapps-sandbox@1.0.0-beta.1')
    expect(missingSdk(Object.assign(new Error("Cannot find package 'other'"), { code: 'ERR_MODULE_NOT_FOUND' }))).toBeNull()
  })

  it('reads the service\'s quantities, and says how a size differs from a snapshot\'s', () => {
    expect([quantity('4', 'cpu'), quantity('4000m', 'cpu'), quantity('8192Mi', 'MiB'), quantity('8Gi', 'MiB'), quantity('32768Mi', 'GiB'), quantity('32Gi', 'GiB')]).toEqual([4, 4, 8192, 8192, 32, 32])
    expect([quantity('', 'cpu'), quantity('4Gi', 'cpu'), quantity('lots', 'MiB')]).toEqual([null, null, null])
    const base = { cpu: '4', memory: '8192Mi', disk: '32768Mi' }
    expect(otherSize({ cpus: 4, memoryMb: 8192, storageGb: 32 }, base)).toBeNull()
    expect(otherSize({}, base)).toBeNull()
    expect(otherSize({ cpus: 8 }, undefined)).toBeNull()
    expect(otherSize({ cpus: 8, memoryMb: 16384, storageGb: 32 }, base)).toEqual({ wants: '8 CPUs, 16384 MB', has: '4 CPUs, 8192 MB, 32 GB' })
  })

  it('names images, states, lifecycles, and egress the way the service takes them', () => {
    expect(imageReference('ubuntu:24.04')).toBe('docker.io/library/ubuntu:24.04')
    expect(imageReference('ubuntu@sha256:abc')).toBe('docker.io/library/ubuntu@sha256:abc')
    expect(imageReference('contoso/desktop:1')).toBe('docker.io/contoso/desktop:1')
    expect(imageReference('registry.example.com/desktop:1')).toBe('registry.example.com/desktop:1')
    expect(imageReference('localhost/desktop')).toBe('localhost/desktop')
    expect(() => imageReference('bad image')).toThrow(SandboxError)
    expect(diskImageName('docker.io/library/ubuntu:24.04')).toMatch(/^blobby-[0-9a-f]{24}$/)
    expect(diskImageName('docker.io/library/ubuntu:24.04')).not.toBe(diskImageName('docker.io/library/ubuntu:26.04'))
    expect(['Running', 'Stopped', 'Suspended', 'Idle', 'Creating', 'Resuming', undefined].map(machineState)).toEqual(['running', 'stopped', 'stopped', 'stopped', 'created', 'resuming', 'unknown'])
    const now = Date.UTC(2026, 0, 1)
    expect(lifecycle(new Date(now + 60_000), now).autoDelete).toEqual({ enabled: true, deleteIntervalSeconds: 3600 })
    expect(lifecycle(new Date(now + 2 * 86_400_000 + 1), now).autoDelete).toEqual({ enabled: true, deleteIntervalSeconds: 172_801 })
    expect(egressPolicy('internet')).toEqual({ defaultAction: 'Allow', hostRules: [], rules: [], trafficInspection: 'None' })
  })
})

const sh = (script: string, env: NodeJS.ProcessEnv) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile('sh', ['-c', script], { env, encoding: 'utf8' }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, stdout, stderr }))
  })

describe('azure commands, in a real shell, with the service\'s 1 MiB output limit', () => {
  let dir: string
  let api: FakeApi
  let largest: number
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'blobby-azure-exec-'))
    await mkdir(join(dir, 'bin'))
    await writeFile(join(dir, 'bin', 'getent'), `#!/bin/sh\necho 'root:x:0:0:root:/root:/bin/sh'\n`)
    await chmod(join(dir, 'bin', 'getent'), 0o755)
    // The guest's setsid, which macOS lacks.
    await writeFile(join(dir, 'bin', 'setsid'), '#!/bin/sh\nexec "$@"\n')
    await chmod(join(dir, 'bin', 'setsid'), 0o755)
    api = new FakeApi()
    largest = 0
    // Runs each command here, with the guest's /run/blobby-exec in a temporary folder, and fails the way the
    // service does when the output passes 1 MiB.
    api.onExec = (_, command) =>
      new Promise((resolve, reject) => {
        const local = command.replaceAll('/run/blobby-exec', join(dir, 'exec'))
        execFile('sh', ['-c', local], { env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}` }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
          const size = Buffer.byteLength(stdout) + Buffer.byteLength(stderr)
          largest = Math.max(largest, size)
          if (size > OUTPUT_LIMIT_BYTES) return reject(new SandboxError('azure_exec', `[adc] output exceeded ${OUTPUT_LIMIT_BYTES} bytes and was truncated; process terminated`))
          resolve({ exitCode: error ? Number(error.code) || 1 : 0, stdout, stderr })
        })
      })
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  const leftovers = async () => (await readdir(join(dir, 'exec')).catch(() => [])).length

  it('returns a short command\'s small output in one call, and leaves nothing behind', async () => {
    const azure = backend(api)
    await azure.create({ name: 'a', image: 'ubuntu' })
    const before = api.commands.length
    expect(await azure.exec('a', ['sh', '-c', 'printf "héllo\\n"; printf oops >&2; exit 3'])).toEqual({ exitCode: 3, stdout: 'héllo\n', stderr: 'oops' })
    expect(api.commands.length - before).toBe(1)
    expect(await leftovers()).toBe(0)
  })

  it('returns megabytes of output, such as a screenshot, in calls under the limit', async () => {
    const azure = backend(api)
    await azure.create({ name: 'a', image: 'ubuntu' })
    const result = await azure.exec('a', ['sh', '-c', 'head -c 3000000 /dev/zero | tr "\\0" a; head -c 300000 /dev/zero | tr "\\0" b >&2'])
    expect([result.exitCode, result.stdout.length, result.stderr.length]).toEqual([0, 3_000_000, 300_000])
    expect(result.stdout).toBe('a'.repeat(3_000_000))
    expect(largest).toBeLessThan(OUTPUT_LIMIT_BYTES)
    expect(await leftovers()).toBe(0)
  })

  it('streams a background command\'s large output as it comes, in calls under the limit', async () => {
    const azure = backend(api)
    await azure.create({ name: 'a', image: 'ubuntu' })
    const chunks: string[] = []
    const result = await azure.exec('a', ['sh', '-c', 'printf "€"; head -c 2000000 /dev/zero | tr "\\0" c'], { onOutput: (chunk) => chunks.push(chunk.text) })
    expect(result).toEqual({ exitCode: 0, stdout: `€${'c'.repeat(2_000_000)}`, stderr: '' })
    expect(chunks.join('')).toBe(result.stdout)
    expect(chunks.length).toBeGreaterThan(1)
    expect(largest).toBeLessThan(OUTPUT_LIMIT_BYTES)
    expect(await leftovers()).toBe(0)
  })
})

describe('the command wrapper, in a real shell', () => {
  let dir: string
  let env: NodeJS.ProcessEnv
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'blobby-wrap-'))
    // Stand-ins for the guest's getent and runuser, so the wrapper runs on any host.
    await writeFile(join(dir, 'getent'), `#!/bin/sh\ncase "$2" in root|0) echo 'root:x:0:0:root:/root:/bin/sh';; ubuntu|1000) echo 'ubuntu:x:1000:1000::/home/ubuntu:/bin/bash';; *) exit 2;; esac\n`)
    await writeFile(join(dir, 'runuser'), `#!/bin/sh\necho "runuser:$2" >&2\nshift 3\nexec "$@"\n`)
    await chmod(join(dir, 'getent'), 0o755)
    await chmod(join(dir, 'runuser'), 0o755)
    env = { PATH: `${dir}:${process.env.PATH}`, IDENTITY_ENDPOINT: 'http://169.254.169.254/x', IDENTITY_HEADER: 'secret-header', NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/proxy.crt' }
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('runs the command with only a plain environment, the caller\'s variables, and the proxy certificate', async () => {
    const script = wrapCommand(['sh', '-c', 'env | sort; pwd; printf "%s|" "$@"', 'sh', "it's", 'a $b', '"q"'], { user: 'root', env: { CALLER: 'x y' }, marker: 'm1' })
    const result = await sh(script, env)
    expect(result.code).toBe(0)
    const lines = result.stdout.split('\n')
    const variables = lines.filter((line) => /^[A-Z_]+=/.test(line)).map((line) => line.split('=')[0])
    expect(variables.filter((name) => !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(name!))).toEqual(['BLOBBY_EXEC_ID', 'CALLER', 'HOME', 'LANG', 'LOGNAME', 'NODE_EXTRA_CA_CERTS', 'PATH', 'USER'])
    expect(result.stdout).toContain('CALLER=x y\n')
    expect(result.stdout).toContain('HOME=/root\n')
    expect(result.stdout).toContain('BLOBBY_EXEC_ID=m1\n')
    expect(result.stdout).not.toContain('IDENTITY')
    expect(lines.at(-1)).toBe(`it's|a $b|"q"|`)
    expect(lines).toContain('/')
    expect(result.stderr).toBe('')
  })

  it('switches to another user with runuser, and gives that user its own home', async () => {
    const result = await sh(wrapCommand(['sh', '-c', 'echo "$USER $HOME"'], { user: 'ubuntu', env: {}, marker: 'm2' }), env)
    expect(result).toEqual({ code: 0, stdout: 'ubuntu /home/ubuntu\n', stderr: 'runuser:ubuntu\n' })
    expect(await sh(wrapCommand(['true'], { user: 'nobody-here', env: {}, marker: 'm3' }), env)).toMatchObject({ code: 125, stderr: expect.stringContaining('there is no user nobody-here') })
  })

  it('reads stdin from its file, which is gone once the command runs, and from nothing otherwise', async () => {
    const file = join(dir, 'in.stdin')
    await writeFile(file, 'pa55\n')
    const result = await sh(wrapCommand(['sh', '-c', `cat; if test -e '${file}'; then echo still there; fi`], { user: 'root', env: {}, marker: 'm4', stdinFile: file }), env)
    expect(result).toEqual({ code: 0, stdout: 'pa55\n', stderr: '' })
    await expect(stat(file)).rejects.toThrow()
    expect(await sh(wrapCommand(['cat'], { user: 'root', env: {}, marker: 'm5' }), env)).toEqual({ code: 0, stdout: '', stderr: '' })
  })
})

// Real sandboxes in the sandbox group in azure.json. They cost money while they run; every one is removed.
// BLOBBY_SANDBOX_CONFORMANCE_AZURE=1 pnpm --filter @rwoll/blobby-sandbox exec vitest run azure
describe.skipIf(!process.env.BLOBBY_SANDBOX_CONFORMANCE_AZURE)('backend conformance: azure', () => {
  const run = randomBytes(4).toString('hex')
  const RUN_LABEL = 'blobby.dev/test-run'
  const owner = (id: string) => ({ [MANAGER_LABEL]: `standalone:test-${run}-${id}`, [RUN_LABEL]: run })
  let count = 0
  const target: ConformanceTarget = {
    image: 'ubuntu:24.04',
    resources: { cpus: 1, memoryMb: 2048, storageGb: 10 },
    setup: async () => {
      count += 1
      return { backend: new AzureBackend({ labels: owner(`${count}a`) }), other: new AzureBackend({ labels: owner(`${count}b`) }) }
    },
  }
  afterAll(async () => {
    const sweeper = new AzureBackend({ labels: { [RUN_LABEL]: run } })
    for (const machine of await sweeper.list()) await sweeper.remove(machine.name)
    for (const snapshot of await sweeper.snapshots()) await sweeper.removeSnapshot(snapshot.id).catch(() => {})
  }, 300_000)
  for (const check of backendConformance(target)) it(check.name, (context) => check.run(context), 10 * 60_000)
})
