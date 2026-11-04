import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import {
  DELETE_AFTER_LABEL,
  readAll,
  SandboxError,
  type Backend,
  type Capabilities,
  type CreateOptions,
  type Machine,
  type NetworkPolicy,
  type NetworkPolicyKind,
  type Resources,
  type Snapshot,
  type SnapshotOptions,
} from './backend.ts'

/**
 * The commands the conformance suite runs. A real backend runs them in its image, which needs only a
 * POSIX shell and coreutils, as `ubuntu:24.04` has; a fake answers them with `emulateCommand`.
 */
export const CONFORMANCE_COMMANDS = Object.freeze({
  /** Prints `stdout` and `stderr` as they are, and exits with `code`. */
  output: (stdout: string, stderr: string, code: number): string[] => ['sh', '-c', 'printf %s "$1"; printf %s "$2" >&2; exit "$3"', 'sh', stdout, stderr, String(code)],
  succeed: (): string[] => ['true'],
  /** Prints its stdin. */
  echoStdin: (): string[] => ['cat'],
  user: (): string[] => ['id', '-un'],
  env: (name: string): string[] => ['printenv', name],
  /** Prints a file's mode in octal, such as `755`. */
  mode: (path: string): string[] => ['stat', '-c', '%a', path],
  /** Prints a file's owner, such as `root`. */
  owner: (path: string): string[] => ['stat', '-c', '%U', path],
  /** Waits, for cancellation and time limits. */
  sleep: (seconds: number): string[] => ['sleep', String(seconds)],
})

type Emulated = { exitCode: number; stdout: string; stderr: string }

/** A file `emulateCommand` reads, and changes the owner of with `chown`. */
export interface EmulatedFile {
  data: Uint8Array
  mode?: number
  user?: string
}

/** What `emulateCommand` uses of a command's options. */
export interface EmulateOptions {
  user?: string
  env?: Record<string, string>
  stdin?: string | Uint8Array
  /** Stops `sleep` and `timeout`: the answer rejects with the signal's reason. */
  signal?: AbortSignal
}

/**
 * Answers `CONFORMANCE_COMMANDS` the way a Linux machine does, from a fake machine's files, along with
 * `timeout [-k S] N command...` around them, `chown`, and `stat -c` with `%a`, `%U`, and `%s`. Other commands fail with exit code 127, as a shell says when
 * it can't find one. `sleep` answers once its time has passed, so the answer is then a promise.
 */
export function emulateCommand(
  command: readonly string[],
  options: EmulateOptions = {},
  files?: ReadonlyMap<string, EmulatedFile>,
): Emulated | Promise<Emulated> {
  const [program, ...args] = command
  const ok = (stdout = ''): Emulated => ({ exitCode: 0, stdout, stderr: '' })
  if (program === 'sh' && args[0] === '-c' && args[1] === CONFORMANCE_COMMANDS.output('', '', 0)[2]) {
    return { exitCode: Number(args[5]), stdout: args[3] ?? '', stderr: args[4] ?? '' }
  }
  if (program === 'true' && !args.length) return ok()
  if (program === 'cat' && !args.length) return ok(typeof options.stdin === 'string' ? options.stdin : Buffer.from(options.stdin ?? '').toString('utf8'))
  if (program === 'id' && args[0] === '-un') return ok(`${options.user ?? 'root'}\n`)
  if (program === 'printenv' && args.length === 1) {
    const value = options.env?.[args[0]!]
    return value === undefined ? { exitCode: 1, stdout: '', stderr: '' } : ok(`${value}\n`)
  }
  if (program === 'stat') {
    // stat [-L] -c FORMAT [--] PATH, with %a (mode), %U (owner), and %s (size) in FORMAT.
    const rest = args.filter((arg) => arg !== '-L' && arg !== '--')
    if (rest.length === 3 && rest[0] === '-c') {
      const file = files?.get(rest[2]!)
      if (!file) return { exitCode: 1, stdout: '', stderr: `stat: cannot statx '${rest[2]}': No such file or directory\n` }
      const fields: Record<string, string> = { a: (file.mode ?? 0o644).toString(8), U: file.user ?? 'root', s: String(file.data.length) }
      return ok(`${rest[1]!.replace(/%([aUs])/g, (_, field: string) => fields[field]!)}\n`)
    }
  }
  if (program === 'chown' && files) {
    // chown USER[:[GROUP]] [--] PATH
    const rest = args.filter((arg) => arg !== '--')
    const file = rest.length === 2 ? files.get(rest[1]!) : undefined
    if (file) {
      file.user = rest[0]!.split(':')[0]!
      return ok()
    }
    if (rest.length === 2) return { exitCode: 1, stdout: '', stderr: `chown: cannot access '${rest[1]}': No such file or directory\n` }
  }
  if (program === 'sleep' && args.length === 1 && /^\d+(?:\.\d+)?$/.test(args[0]!)) return wait(Number(args[0]) * 1000, options.signal).then(() => ok())
  if (program === 'timeout') {
    const rest = args[0] === '-k' ? args.slice(2) : args[0]?.startsWith('--kill-after=') ? args.slice(1) : args
    if (rest.length >= 2 && /^\d+(?:\.\d+)?$/.test(rest[0]!)) return limit(Number(rest[0]) * 1000, rest.slice(1), options, files)
  }
  return { exitCode: 127, stdout: '', stderr: `sh: 1: ${program ?? ''}: not found\n` }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const abort = () => {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

async function limit(ms: number, command: string[], options: EmulateOptions, files: Parameters<typeof emulateCommand>[2]): Promise<Emulated> {
  const controller = new AbortController()
  const abort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', abort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => ((timedOut = true), controller.abort()), ms)
  try {
    return await emulateCommand(command, { ...options, signal: controller.signal }, files)
  } catch (error) {
    if (timedOut) return { exitCode: 124, stdout: '', stderr: '' }
    throw error
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}

/** One backend to check, and how to make a fresh world for each case. */
export interface ConformanceTarget {
  /** Makes the backend for one case, on machines no other case uses. */
  setup(): Promise<ConformanceWorld>
  /** The image the suite creates machines from. The default is `ubuntu:24.04`. */
  image?: string
  /** The size of the machines the suite creates. The default is 1 CPU, 1024 MB, and 10 GB. */
  resources?: Resources
}

export interface ConformanceWorld {
  backend: Backend
  /** A backend for another owner on the same provider, such as one with other labels. It must not see `backend`'s machines. */
  other?: Backend
  /** Runs after each case, once the suite has removed the machines and snapshots it made. */
  cleanup?(): Promise<void>
}

/** What a case can tell the test runner. */
export interface ConformanceContext {
  /** Marks the case skipped, for a capability the backend doesn't have. The case returns right after. */
  skip(reason: string): void
}

export interface ConformanceCase {
  name: string
  run(context?: ConformanceContext): Promise<void>
}

interface Scenario {
  backend: Backend
  other?: Backend
  capabilities: Capabilities
  /** A machine name unique to this case. */
  name(suffix: string): string
  /** Creates a machine that the suite removes after the case. */
  create(suffix: string, options?: Partial<CreateOptions>, on?: Backend): Promise<Machine>
  /** Copies a machine; the suite removes the copy after the case. */
  branch(source: string, suffix: string): Promise<Machine>
  /** Takes a snapshot that the suite removes after the case. */
  snapshot(source: string, options?: SnapshotOptions): Promise<Snapshot>
  /** Creates a machine from a snapshot; the suite removes it after the case. */
  createFrom(snapshot: string, suffix: string, options?: Partial<Omit<CreateOptions, 'image'>>): Promise<Machine>
}

const DEFAULT_RESOURCES: Resources = { cpus: 1, memoryMb: 1024, storageGb: 10 }
const POLICY_KINDS: readonly NetworkPolicyKind[] = ['none', 'essential', 'internet', 'allow']
const FLAGS = ['branch', 'publish', 'ports', 'gpu', 'commandSandbox', 'streamingFiles', 'labels', 'stdin', 'snapshot'] as const
const DIR = '/var/tmp/blobby-conformance'

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('No free port'))))
    })
  })
}

const isCode = (code: string) => (error: unknown) => {
  assert.ok(error instanceof SandboxError, `expected a SandboxError with code ${code}, got ${String(error)}`)
  assert.equal(error.code, code, error.message)
  return true
}
const text = (data: Uint8Array) => Buffer.from(data).toString('utf8')
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const sameTime = (actual: string | null | undefined, expected: Date, what: string) => {
  assert.ok(actual, `${what} is set`)
  assert.equal(new Date(actual).getTime(), expected.getTime(), `${what} is ${expected.toISOString()}, not ${actual}`)
}

/** `data` as a byte stream, in pieces of `size` bytes. */
function streamOf(data: Buffer, size: number): Readable {
  return Readable.from(
    (function* () {
      for (let offset = 0; offset < data.length; offset += size) yield data.subarray(offset, offset + size)
    })(),
    { objectMode: false },
  )
}

/**
 * The backend conformance suite: what the engine relies on from every backend, as test cases that any
 * runner can register. Each case makes its own machines and snapshots, with names unique to it, and
 * removes them. Cases for optional abilities skip themselves, through `context.skip`, when
 * `capabilities()` says the backend lacks them.
 *
 * ```ts
 * for (const check of backendConformance(target)) it(check.name, (context) => check.run(context))   // Vitest
 * for (const check of backendConformance(target)) test(check.name, (t) => check.run(t))             // node:test
 * ```
 */
export function backendConformance(target: ConformanceTarget): ConformanceCase[] {
  const scenario = (name: string, body: (s: Scenario, context: ConformanceContext) => Promise<void>): ConformanceCase => ({
    name,
    async run(context = { skip: () => {} }) {
      const world = await target.setup()
      const prefix = `conformance-${randomBytes(3).toString('hex')}`
      const made: { name: string; on: Backend }[] = []
      const snapshots: string[] = []
      const resources = { ...DEFAULT_RESOURCES, ...target.resources }
      const s: Scenario = {
        backend: world.backend,
        other: world.other,
        capabilities: world.backend.capabilities(),
        name: (suffix) => `${prefix}-${suffix}`,
        async create(suffix, options = {}, on = world.backend) {
          const machine = await on.create({ name: s.name(suffix), image: target.image ?? 'ubuntu:24.04', ports: [], resources, ...options })
          made.push({ name: machine.name, on })
          return machine
        },
        async branch(source, suffix) {
          const machine = await world.backend.branch!(source, s.name(suffix))
          made.push({ name: machine.name, on: world.backend })
          return machine
        },
        async snapshot(source, options) {
          const snapshot = await world.backend.snapshot!(source, options)
          snapshots.push(snapshot.id)
          return snapshot
        },
        async createFrom(snapshot, suffix, options = {}) {
          const machine = await world.backend.createFrom!(snapshot, { name: s.name(suffix), ports: [], resources, ...options })
          made.push({ name: machine.name, on: world.backend })
          return machine
        },
      }
      try {
        await body(s, context)
      } finally {
        // Copies first: a backend may refuse to remove a machine that has copies, or a snapshot that machines use.
        for (const { name: machine, on } of made.reverse()) await on.remove(machine).catch(() => {})
        for (const id of snapshots.reverse()) await world.backend.removeSnapshot!(id).catch(() => {})
        await world.cleanup?.()
      }
    },
  })

  return [
    scenario('check says this host can run machines, without throwing', async ({ backend }) => {
      const status = await backend.check()
      assert.equal(typeof status.detail, 'string')
      assert.ok(status.detail.length > 0, 'check gives a detail')
      assert.equal(status.ok, true, `check reports a problem: ${status.detail}`)
    }),

    scenario('capabilities say what it can do, and what it can\'t fails with unsupported', async (s) => {
      const { capabilities, backend } = s
      for (const flag of FLAGS) assert.equal(typeof capabilities[flag], 'boolean', `capabilities().${flag} is a boolean`)
      assert.ok(Array.isArray(capabilities.networkPolicies), 'capabilities().networkPolicies is a list')
      for (const kind of capabilities.networkPolicies) assert.ok(POLICY_KINDS.includes(kind), `${kind} is a network policy kind`)
      assert.deepEqual(backend.capabilities(), capabilities, 'capabilities are static')
      const methods = { publish: ['publish'], branch: ['branch'], snapshot: ['snapshot', 'snapshots', 'removeSnapshot', 'createFrom'] } as const
      for (const [flag, names] of Object.entries(methods) as [keyof typeof methods, readonly (keyof Backend)[]][]) {
        for (const method of names) if (capabilities[flag]) assert.equal(typeof backend[method], 'function', `with ${flag}, it has ${method}()`)
      }
      if (!capabilities.gpu) await assert.rejects(s.create('gpu', { resources: { ...DEFAULT_RESOURCES, gpu: true } }), isCode('unsupported'))
      if (!capabilities.ports) await assert.rejects(s.create('ports', { ports: [{ guest: 8080 }] }), isCode('unsupported'))
      if (!capabilities.commandSandbox) await assert.rejects(s.create('command-sandbox', { commandSandbox: true }), isCode('unsupported'))
      if (!capabilities.branch) await assert.rejects(s.create('branchable', { branchable: true }), isCode('unsupported'))
      if (!capabilities.snapshot && backend.snapshots) await assert.rejects(backend.snapshots(), isCode('unsupported'))
      if (capabilities.publish && capabilities.branch && capabilities.stdin) return
      const { name } = await s.create('a')
      if (!capabilities.publish && backend.publish) await assert.rejects(backend.publish(name, 8080), isCode('unsupported'))
      if (!capabilities.branch && backend.branch) await assert.rejects(backend.branch(name, s.name('copy')), isCode('unsupported'))
      if (!capabilities.stdin) await assert.rejects(backend.exec(name, CONFORMANCE_COMMANDS.echoStdin(), { stdin: 'x' }), isCode('unsupported'))
    }),

    scenario('create makes a running machine with the ports it asked for, fixed or picked', async (s, context) => {
      if (!s.capabilities.ports) return context.skip('This backend does not publish ports at create.')
      const host = await freePort()
      const machine = await s.create('a', { ports: [{ host, guest: 8080 }, { guest: 8081 }] })
      assert.equal(machine.name, s.name('a'))
      assert.equal(machine.state, 'running')
      assert.equal(machine.ports.length, 2)
      const fixed = machine.ports.find((port) => port.guest === 8080)
      const picked = machine.ports.find((port) => port.guest === 8081)
      assert.equal(fixed?.host, host, 'the host port it asked for')
      assert.ok(picked && Number.isInteger(picked.host) && picked.host > 0 && picked.host !== host, 'a free host port')
      for (const port of machine.ports) assert.ok(typeof port.hostIp === 'string' && port.hostIp.length > 0, 'a host address')
      const byGuest = (ports: Machine['ports']) => [...ports].sort((a, b) => a.guest - b.guest)
      assert.deepEqual(byGuest((await s.backend.get(machine.name))!.ports), byGuest(machine.ports))
      if (machine.createdAt !== null) assert.equal(new Date(machine.createdAt).toISOString(), machine.createdAt, 'createdAt is an ISO 8601 time')
    }),

    scenario('labels and deleteAfter are stored, returned, and filter list', async (s, context) => {
      if (!s.capabilities.labels) return context.skip('This backend does not store labels.')
      const tag = randomBytes(4).toString('hex')
      const deleteAfter = new Date(Math.ceil(Date.now() / 1000) * 1000 + 60 * 60_000)
      const labels = { 'blobby.dev/conformance': tag, 'example.com/value': 'Az09._:-' }
      const machine = await s.create('a', { labels, deleteAfter })
      for (const [key, value] of Object.entries(labels)) assert.equal(machine.labels[key], value, `create returns label ${key}`)
      sameTime(machine.deleteAfter, deleteAfter, 'deleteAfter')
      sameTime(machine.labels[DELETE_AFTER_LABEL], deleteAfter, `the ${DELETE_AFTER_LABEL} label`)
      const got = await s.backend.get(machine.name)
      assert.deepEqual(got?.labels, machine.labels, 'get returns the same labels')
      assert.equal(got?.deleteAfter, machine.deleteAfter)
      const plain = await s.create('b')
      assert.equal(plain.deleteAfter, null, 'no deadline unless asked')
      assert.deepEqual((await s.backend.list({ labels: { 'blobby.dev/conformance': tag } })).map((found) => found.name), [machine.name])
      assert.deepEqual(await s.backend.list({ labels: { 'blobby.dev/conformance': `${tag}x` } }), [])
      assert.ok((await s.backend.list()).some((found) => found.name === plain.name), 'list without a filter lists all of them')
      await assert.rejects(s.create('c', { labels: { 'Not A Key': 'x' } }), isCode('invalid_options'))
      await assert.rejects(s.create('d', { labels: { 'blobby.dev/conformance': 'x'.repeat(64) } }), isCode('invalid_options'))
    }),

    scenario('create with an idempotency key returns the machine it already made', async (s) => {
      const first = await s.create('a', { idempotencyKey: 'key-1' })
      const again = await s.create('a', { idempotencyKey: 'key-1' })
      assert.equal(again.name, first.name)
      assert.equal(again.createdAt, first.createdAt)
      assert.equal((await s.backend.list()).filter((machine) => machine.name === first.name).length, 1)
      await assert.rejects(s.create('a', { idempotencyKey: 'key-2' }), isCode('already_exists'))
      await assert.rejects(s.create('a'), isCode('already_exists'))
      await s.create('b')
      await assert.rejects(s.create('b', { idempotencyKey: 'key-1' }), isCode('already_exists'))
    }),

    scenario('list and get see only the machines of their own owner, and remove leaves others alone', async (s) => {
      const mine = await s.create('mine')
      assert.deepEqual(await s.backend.get(mine.name), (await s.backend.list()).find((machine) => machine.name === mine.name))
      assert.equal(await s.backend.get(s.name('missing')), null)
      if (!s.other) return
      const theirs = await s.create('theirs', {}, s.other)
      assert.equal((await s.backend.list()).some((machine) => machine.name === theirs.name), false, 'list leaves out another owner\'s machine')
      assert.equal(await s.backend.get(theirs.name), null)
      assert.equal((await s.other.list()).some((machine) => machine.name === mine.name), false)
      assert.equal(await s.other.get(mine.name), null)
      await s.backend.remove(theirs.name)
      assert.notEqual(await s.other.get(theirs.name), null, 'remove does not touch another owner\'s machine')
    }),

    scenario('exec passes output and the exit code through, as the user and with the environment asked for, but never credentials', async (s) => {
      const { name } = await s.create('a')
      assert.deepEqual(await s.backend.exec(name, CONFORMANCE_COMMANDS.output('héllo\n', 'oops', 3)), { exitCode: 3, stdout: 'héllo\n', stderr: 'oops' })
      assert.equal((await s.backend.exec(name, CONFORMANCE_COMMANDS.succeed())).exitCode, 0)
      assert.equal((await s.backend.exec(name, CONFORMANCE_COMMANDS.user(), { user: 'root', timeoutSeconds: 60 })).stdout, 'root\n')
      const env = await s.backend.exec(name, CONFORMANCE_COMMANDS.env('BLOBBY_CONFORMANCE'), { env: { BLOBBY_CONFORMANCE: 'yes' } })
      assert.deepEqual(env, { exitCode: 0, stdout: 'yes\n', stderr: '' })
      await assert.rejects(s.backend.exec(name, CONFORMANCE_COMMANDS.succeed(), { env: { GH_TOKEN: 'conformance' } }), isCode('env_blocked'))
    }),

    scenario('exec stops a command after timeoutSeconds, with exit code 124', async (s) => {
      const { name } = await s.create('a')
      const started = Date.now()
      const result = await s.backend.exec(name, CONFORMANCE_COMMANDS.sleep(60), { timeoutSeconds: 1 })
      assert.equal(result.exitCode, 124)
      assert.ok(Date.now() - started < 30_000, 'it did not wait for the command')
    }),

    scenario('exec rejects with cancelled when its signal aborts', async (s) => {
      const { name } = await s.create('a')
      const controller = new AbortController()
      const started = Date.now()
      const running = s.backend.exec(name, CONFORMANCE_COMMANDS.sleep(60), { signal: controller.signal })
      await delay(500)
      controller.abort()
      await assert.rejects(running, isCode('cancelled'))
      assert.ok(Date.now() - started < 30_000, 'it did not wait for the command')
      await assert.rejects(s.backend.exec(name, CONFORMANCE_COMMANDS.succeed(), { signal: AbortSignal.abort() }), isCode('cancelled'))
      assert.equal((await s.backend.exec(name, CONFORMANCE_COMMANDS.succeed())).exitCode, 0, 'the machine still runs commands')
    }),

    scenario('stop, start, and remove change a machine\'s state, and repeat safely', async (s) => {
      const { name } = await s.create('a')
      await s.backend.stop(name)
      assert.equal((await s.backend.get(name))?.state, 'stopped')
      await s.backend.stop(name)
      assert.equal((await s.backend.start(name)).state, 'running')
      assert.equal((await s.backend.exec(name, CONFORMANCE_COMMANDS.succeed())).exitCode, 0)
      await s.backend.remove(name)
      assert.equal(await s.backend.get(name), null)
      assert.equal((await s.backend.list()).some((machine) => machine.name === name), false)
      await s.backend.remove(name)
      await s.backend.remove(s.name('never'))
    }),

    scenario('branch copies a branchable machine with its files and no published ports, and keeps the source while copies exist', async (s, context) => {
      if (!s.capabilities.branch) return context.skip('This backend does not branch machines.')
      const base = await s.create('base', { branchable: true })
      await s.backend.writeFile(base.name, `${DIR}/marker`, Buffer.from('baked'))
      const copy = await s.branch(base.name, 'copy')
      assert.equal(copy.name, s.name('copy'))
      assert.equal(copy.state, 'running')
      assert.deepEqual(copy.ports, [])
      assert.equal(text(await readAll(s.backend, copy.name, `${DIR}/marker`)), 'baked')
      await assert.rejects(s.backend.remove(base.name), (error) => error instanceof SandboxError, 'a machine with copies is not removed')
      assert.notEqual(await s.backend.get(base.name), null)
      await s.backend.remove(copy.name)
      await s.backend.remove(base.name)
      assert.equal(await s.backend.get(base.name), null)
    }),

    scenario('publish publishes a guest port of a running machine on the host', async (s, context) => {
      if (!s.capabilities.publish) return context.skip('This backend fixes ports at create.')
      const { name } = await s.create('a')
      const port = await s.backend.publish!(name, 8080)
      assert.equal(port.guest, 8080)
      assert.ok(Number.isInteger(port.host) && port.host > 0, 'the host port is a port number')
      assert.ok(typeof port.hostIp === 'string' && port.hostIp.length > 0, 'a host address')
      assert.deepEqual((await s.backend.get(name))?.ports, [port])
      const endpoint = await s.backend.endpoint(name, 8080)
      if (endpoint.kind === 'tcp') assert.equal(endpoint.port, port.host)
    }),

    scenario('endpoint says where to reach a published port, and fails with not_published for others', async (s) => {
      if (!s.capabilities.ports) {
        const { name } = await s.create('a')
        await assert.rejects(s.backend.endpoint(name, 8082), isCode('not_published'))
        return
      }
      const { name, ports } = await s.create('a', { ports: [{ guest: 8080 }] })
      const endpoint = await s.backend.endpoint(name, 8080)
      if (endpoint.kind === 'tcp') {
        assert.ok(endpoint.host.length > 0, 'a host')
        assert.equal(endpoint.port, ports.find((port) => port.guest === 8080)?.host, 'the published host port')
      } else {
        assert.equal(endpoint.kind, 'url')
        assert.doesNotThrow(() => new URL(endpoint.url), 'a URL')
      }
      await assert.rejects(s.backend.endpoint(name, 8082), isCode('not_published'))
    }),

    scenario('machines it made, and their copies, run commands right away', async (s) => {
      const made = await s.create('a', { branchable: s.capabilities.branch })
      assert.equal((await s.backend.exec(made.name, CONFORMANCE_COMMANDS.succeed())).exitCode, 0)
      if (!s.capabilities.branch) return
      const copy = await s.branch(made.name, 'copy')
      assert.equal((await s.backend.exec(copy.name, CONFORMANCE_COMMANDS.succeed())).exitCode, 0)
      assert.equal((await s.backend.exec(made.name, CONFORMANCE_COMMANDS.succeed())).exitCode, 0)
    }),

    scenario('exec passes stdin to the command, also when output streams', async (s, context) => {
      if (!s.capabilities.stdin) return context.skip('This backend does not pass stdin to commands.')
      const { name } = await s.create('a')
      assert.equal((await s.backend.exec(name, CONFORMANCE_COMMANDS.echoStdin(), { stdin: 'pa55-w0rd!\n' })).stdout, 'pa55-w0rd!\n')
      assert.equal((await s.backend.exec(name, CONFORMANCE_COMMANDS.echoStdin(), { stdin: Buffer.from('bytes\n') })).stdout, 'bytes\n')
      const chunks: string[] = []
      const result = await s.backend.exec(name, CONFORMANCE_COMMANDS.echoStdin(), { stdin: 'second\n', onOutput: (chunk) => chunks.push(chunk.text) })
      assert.equal(result.stdout, 'second\n')
      assert.equal(chunks.join(''), 'second\n')
    }),

    scenario('writeFile and readFile move bytes in and out, with folders, spaces, modes, and owners', async (s) => {
      const { name } = await s.create('a')
      const path = `${DIR}/a folder/all bytes.bin`
      const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index))
      await s.backend.writeFile(name, path, bytes, { mode: 0o755 })
      assert.deepEqual(await readAll(s.backend, name, path), bytes)
      assert.equal((await s.backend.exec(name, CONFORMANCE_COMMANDS.mode(path))).stdout, '755\n')
      assert.equal((await s.backend.exec(name, CONFORMANCE_COMMANDS.owner(path))).stdout, 'root\n', 'files belong to root by default')
      await s.backend.writeFile(name, path, Buffer.from('short'))
      assert.equal(text(await readAll(s.backend, name, path)), 'short')
      assert.equal((await s.backend.exec(name, CONFORMANCE_COMMANDS.mode(path))).stdout, '644\n', 'the default mode is 644')
      const theirs = `${DIR}/nobody.txt`
      await s.backend.writeFile(name, theirs, Buffer.from('mine'), { user: 'nobody', mode: 0o600 })
      assert.equal((await s.backend.exec(name, CONFORMANCE_COMMANDS.owner(theirs))).stdout, 'nobody\n')
      assert.equal((await s.backend.exec(name, CONFORMANCE_COMMANDS.mode(theirs))).stdout, '600\n')
    }),

    scenario('readFile streams binary files byte for byte, and byte ranges of them; writeFile takes a stream', async (s) => {
      const { name } = await s.create('a')
      const path = `${DIR}/large.bin`
      // Random bytes are not valid UTF-8, so any text decoding on the way changes them.
      const bytes = randomBytes(3 * 1024 * 1024 + 123)
      await s.backend.writeFile(name, path, streamOf(bytes, 256 * 1024 - 7))
      const stream = await s.backend.readFile(name, path)
      assert.ok(stream instanceof Readable, 'readFile gives a Readable')
      const read: Buffer[] = []
      for await (const chunk of stream) read.push(Buffer.from(chunk as Uint8Array))
      const whole = Buffer.concat(read)
      assert.equal(whole.length, bytes.length)
      assert.equal(sha256(whole), sha256(bytes), 'the bytes read are the bytes written')
      const range = async (offset?: number, length?: number) => readAll(s.backend, name, path, { offset, length })
      assert.deepEqual(await range(1_000_001, 70_000), bytes.subarray(1_000_001, 1_070_001))
      assert.deepEqual(await range(bytes.length - 10), bytes.subarray(-10), 'to the end without a length')
      assert.deepEqual(await range(bytes.length - 5, 100), bytes.subarray(-5), 'a length past the end stops at the end')
      assert.deepEqual(await range(undefined, 16), bytes.subarray(0, 16), 'from the start without an offset')
      assert.equal((await s.backend.stat(name, path))?.size, bytes.length)
      await assert.rejects(s.backend.readFile(name, `${DIR}/missing`), isCode('not_found'))
    }),

    scenario('stat gives a file\'s size and mode, or null when there is none', async (s) => {
      const { name } = await s.create('a')
      const path = `${DIR}/stat.txt`
      await s.backend.writeFile(name, path, Buffer.from('twelve bytes'), { mode: 0o640 })
      const info = await s.backend.stat(name, path)
      assert.equal(info?.size, 12)
      assert.equal((info?.mode ?? 0) & 0o777, 0o640)
      assert.equal(await s.backend.stat(name, `${DIR}/missing`), null)
    }),

    scenario('snapshot saves a machine that createFrom makes new machines from, and keeps it while they exist', async (s, context) => {
      if (!s.capabilities.snapshot) return context.skip('This backend does not take snapshots.')
      const source = await s.create('source')
      await s.backend.writeFile(source.name, `${DIR}/marker`, Buffer.from('baked'))
      const tag = randomBytes(4).toString('hex')
      const snapshot = await s.snapshot(source.name, { labels: { 'blobby.dev/conformance': tag } })
      assert.ok(typeof snapshot.id === 'string' && snapshot.id.length > 0, 'a snapshot ID')
      assert.equal(snapshot.labels['blobby.dev/conformance'], tag)
      assert.ok(snapshot.source === null || snapshot.source === source.name, 'its source')
      assert.deepEqual((await s.backend.snapshots!({ labels: { 'blobby.dev/conformance': tag } })).map((found) => found.id), [snapshot.id])
      assert.ok((await s.backend.snapshots!()).some((found) => found.id === snapshot.id))
      if (s.other?.capabilities().snapshot) assert.equal((await s.other.snapshots!()).some((found) => found.id === snapshot.id), false, 'another owner does not see it')
      assert.equal((await s.backend.exec(source.name, CONFORMANCE_COMMANDS.succeed())).exitCode, 0, 'the source still runs')

      const copy = await s.createFrom(snapshot.id, 'copy')
      assert.equal(copy.name, s.name('copy'))
      assert.equal(copy.state, 'running')
      assert.equal(text(await readAll(s.backend, copy.name, `${DIR}/marker`)), 'baked')
      await s.backend.writeFile(copy.name, `${DIR}/marker`, Buffer.from('changed'))
      const second = await s.createFrom(snapshot.id, 'second')
      assert.equal(text(await readAll(s.backend, second.name, `${DIR}/marker`)), 'baked', 'copies do not change the snapshot')

      await assert.rejects(s.backend.removeSnapshot!(snapshot.id), isCode('in_use'))
      await s.backend.remove(copy.name)
      await s.backend.remove(second.name)
      await s.backend.removeSnapshot!(snapshot.id)
      assert.equal((await s.backend.snapshots!()).some((found) => found.id === snapshot.id), false)
      await s.backend.removeSnapshot!(snapshot.id)
    }),

    scenario('a network policy it can\'t enforce fails closed, unless allowed to run unrestricted', async (s, context) => {
      const kind = POLICY_KINDS.find((candidate) => !s.capabilities.networkPolicies.includes(candidate))
      if (!kind) return context.skip('This backend enforces every network policy.')
      const network: NetworkPolicy = kind === 'allow' ? { allow: ['example.com', '*.example.com'] } : kind
      await assert.rejects(s.create('a', { network }), isCode('network_unenforceable'))
      assert.equal(await s.backend.get(s.name('a')), null, 'nothing is left behind')
      const machine = await s.create('b', { network, allowUnenforcedNetwork: true })
      assert.equal(machine.state, 'running')
    }),

    scenario('exec streams output to onOutput and still returns all of it', async (s) => {
      const { name } = await s.create('a')
      const chunks: { stream: string; text: string }[] = []
      const result = await s.backend.exec(name, CONFORMANCE_COMMANDS.output('line one\nline two\n', 'oops\n', 2), { onOutput: (chunk) => chunks.push(chunk) })
      assert.deepEqual(result, { exitCode: 2, stdout: 'line one\nline two\n', stderr: 'oops\n' })
      const joined = (stream: string) => chunks.filter((chunk) => chunk.stream === stream).map((chunk) => chunk.text).join('')
      assert.equal(joined('stdout'), result.stdout)
      assert.equal(joined('stderr'), result.stderr)
    }),

    scenario('errors are SandboxErrors with stable codes', async (s) => {
      const missing = s.name('missing')
      await assert.rejects(s.backend.start(missing), isCode('not_found'))
      await assert.rejects(s.backend.exec(missing, CONFORMANCE_COMMANDS.succeed()), isCode('not_found'))
      await assert.rejects(s.backend.readFile(missing, '/etc/hostname'), isCode('not_found'))
      await assert.rejects(s.backend.stat(missing, '/etc/hostname'), isCode('not_found'))
      const { name } = await s.create('a')
      await assert.rejects(s.create('a'), isCode('already_exists'))
      await assert.rejects(s.backend.readFile(name, `${DIR}/missing`), isCode('not_found'))
    }),
  ]
}
