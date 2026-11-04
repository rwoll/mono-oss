import { readFile } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import type { ConnectOptions, ExecEvent, ExecResult as SmolExecResult, LocalAvailability, MachineConfig, MachineSummary, PublishedPort as SmolPublishedPort } from 'smolmachines'
import {
  IDEMPOTENCY_LABEL,
  SandboxError,
  type Backend,
  type BackendStatus,
  type Capabilities,
  type CreateOptions,
  type Endpoint,
  type ExecOptions,
  type ExecResult,
  type FileInfo,
  type Machine,
  type PublishedPort,
  type ReadRange,
  type WriteOptions,
} from './backend.ts'
import { checkCreate, collectStream, deleteAfterOf, hasLabels, sliceRange, streamBytes } from './contract.ts'
import { checkGuestEnv } from './guest-env.ts'
import { ownerLabels } from './labels.ts'
import { loopbackPort } from './net.ts'

// Without `target`, the SDK uses smol's cloud whenever SMOL_CLOUD_TOKEN is set. Sandboxes are local only.
// Sandboxes outlive the process that made them: without `handleSignals: false`, the SDK stops copies made
// in this process when it gets SIGINT or SIGTERM, such as Ctrl+C on `blobby-sandbox serve`.
const LOCAL = Object.freeze({ target: 'local', waitForPorts: false, handleSignals: false }) satisfies ConnectOptions

type SmolExecOptions = { user?: string; timeout?: number; env?: Record<string, string>; stdin?: string | Uint8Array; signal?: AbortSignal }

/** A machine handle from the SDK, narrowed to what the backend uses. */
export interface SmolMachine {
  start(options?: { waitUntilReady?: boolean }): Promise<void>
  stop(): Promise<void>
  delete(): Promise<void>
  exec(command: string[], options?: SmolExecOptions): Promise<SmolExecResult>
  execStream(command: string[], options?: SmolExecOptions): AsyncGenerator<ExecEvent>
  readFile(path: string): Promise<Buffer>
  writeFile(path: string, data: Uint8Array, mode?: number): Promise<void>
  publish(port: { guest: number }): Promise<SmolPublishedPort>
  branch(name: string): Promise<SmolMachine>
}

/** The parts of the `smolmachines` SDK the backend uses. Tests pass a fake. */
export interface SmolSdk {
  readonly version: string
  create(config: MachineConfig, conn: ConnectOptions): Promise<SmolMachine>
  connect(name: string, conn: ConnectOptions): Promise<SmolMachine>
  list(conn: ConnectOptions, options: { labels: Record<string, string> }): Promise<MachineSummary[]>
  localAvailability(): LocalAvailability
}

/** The version of `smolmachines`, an optional peer dependency, that this backend is tested with. */
export const SMOLMACHINES_VERSION = '1.31.0'

/** The error to show when `smolmachines` is not installed, or null when `error` is about something else. */
export function missingSdk(error: unknown): SandboxError | null {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  const message = String((error as Error | undefined)?.message ?? '')
  if ((code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') || !/['"]smolmachines['"]/.test(message)) return null
  return new SandboxError(
    'smolvm_missing',
    `The smolvm backend needs the smolmachines package, which is not installed. Install it next to @rwoll/blobby-sandbox: \`npm install -g smolmachines@${SMOLMACHINES_VERSION}\` for the CLI, or \`npm install smolmachines@${SMOLMACHINES_VERSION}\` in your project. Or pick another backend with --backend.`,
  )
}

/** Loads the SDK, and its native engine, only when a command needs a machine. */
export async function loadSdk(): Promise<SmolSdk> {
  let sdk: typeof import('smolmachines')
  let manifest: URL
  try {
    sdk = await import('smolmachines')
    manifest = new URL('../package.json', import.meta.resolve('smolmachines'))
  } catch (error) {
    throw missingSdk(error) ?? error
  }
  const { Machine } = sdk
  const { version } = JSON.parse(await readFile(manifest, 'utf8')) as { version: string }
  return {
    version,
    create: (config, conn) => Machine.create(config, conn),
    connect: (name, conn) => Machine.connect(name, conn),
    list: (conn, options) => Machine.list(conn, options),
    localAvailability: () => Machine.localAvailability(),
  }
}


/**
 * What smolvm can do. It branches running machines and publishes ports on them, on 127.0.0.1. Its
 * network policies other than `internet` are not verified yet, so asking for them fails closed. A
 * microVM has its own kernel, so VS Code's command sandbox runs in it as on any Linux machine. Files
 * move whole through the SDK, and snapshots are left to `branch`: smolvm sets labels only at create.
 */
const CAPABILITIES: Readonly<Capabilities> = Object.freeze({
  branch: true,
  publish: true,
  ports: true,
  gpu: true,
  networkPolicies: ['internet'],
  commandSandbox: true,
  streamingFiles: false,
  labels: true,
  stdin: true,
  snapshot: false,
} satisfies Capabilities)

/** smolvm publishes ports on the host's loopback interface only. */
const LOOPBACK = '127.0.0.1'

function toError(error: unknown): unknown {
  if (error instanceof SandboxError) return error
  const code = (error as { code?: unknown })?.code
  if (typeof code !== 'string') return error
  const message = String((error as Error).message ?? error)
  if (code === 'NOT_FOUND') return new SandboxError('not_found', message)
  if (code === 'CONFLICT' || code === 'ALREADY_EXISTS') return new SandboxError('already_exists', message)
  return new SandboxError(`smolvm_${code.toLowerCase()}`, message)
}

function toMachine(summary: MachineSummary): Machine {
  const created = summary.createdAt ? new Date(summary.createdAt) : null
  const labels = { ...summary.labels }
  const machine: Machine = {
    name: summary.name,
    state: summary.state,
    ports: (summary.ports ?? []).flatMap((port) => (port.host === undefined ? [] : [{ guest: port.guest, host: port.host, hostIp: LOOPBACK }])),
    createdAt: created && !Number.isNaN(created.getTime()) ? created.toISOString() : null,
    labels,
    deleteAfter: deleteAfterOf(labels),
  }
  if (summary.image) machine.image = summary.image
  return machine
}

/** Stops waiting for `work` when `signal` aborts. */
function unlessAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work
  work.catch(() => {})
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export interface SmolvmOptions {
  /**
   * Marks the machines this backend creates, among everything in smolvm's shared machine list, and
   * lists only machines that carry all of them. The default is this host's standalone owner label.
   */
  labels?: Record<string, string>
  /** Environment for the default labels' host ID; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Loads the SDK. Tests pass a fake. */
  load?: () => Promise<SmolSdk>
  /** Picks a free host port for a port asked for without one. */
  freePort?: () => Promise<number>
}

/**
 * Runs each machine as a smolvm micro-VM through `smolmachines`, the official SDK, which embeds the
 * engine: there is no server to install or run. Machines are detached, so they outlive the CLI.
 */
export class SmolvmBackend implements Backend {
  readonly name = 'smolvm'
  readonly #load: () => Promise<SmolSdk>
  readonly #options: SmolvmOptions
  readonly #freePort: () => Promise<number>
  #sdk: Promise<SmolSdk> | undefined
  #labels: Promise<Record<string, string>> | undefined
  // Handles from create and branch. A branchable machine runs commands only through the handle that
  // created it, so they are reused for the rest of this process.
  readonly #handles = new Map<string, SmolMachine>()
  // Machines known to carry this backend's owner labels, so calls by name never reach another owner's.
  readonly #owned = new Set<string>()

  constructor(options: SmolvmOptions = {}) {
    this.#options = options
    this.#load = options.load ?? loadSdk
    this.#freePort = options.freePort ?? loopbackPort
  }

  capabilities(): Capabilities {
    return { ...CAPABILITIES, networkPolicies: [...CAPABILITIES.networkPolicies] }
  }

  #ownLabels(): Promise<Record<string, string>> {
    this.#labels ??= this.#options.labels ? Promise.resolve({ ...this.#options.labels }) : ownerLabels(this.#options.env ?? process.env)
    return this.#labels
  }

  async #call<T>(run: (sdk: SmolSdk) => Promise<T>): Promise<T> {
    this.#sdk ??= this.#load()
    try {
      return await run(await this.#sdk)
    } catch (error) {
      throw toError(error)
    }
  }

  async #machine<T>(name: string, run: (machine: SmolMachine) => Promise<T>): Promise<T> {
    if (!this.#handles.has(name) && !this.#owned.has(name)) {
      if (!(await this.get(name))) throw new SandboxError('not_found', `smolvm has no machine named ${name}.`)
      this.#owned.add(name)
    }
    return this.#call(async (sdk) => run(this.#handles.get(name) ?? (await sdk.connect(name, LOCAL))))
  }

  #forget(name: string): void {
    this.#handles.delete(name)
    this.#owned.delete(name)
  }

  async check(): Promise<BackendStatus> {
    try {
      return await this.#call(async (sdk) => {
        const availability = sdk.localAvailability()
        return availability.available
          ? { ok: true, detail: `smolmachines ${sdk.version}` }
          : { ok: false, detail: `${availability.reason} (${availability.code})` }
      })
    } catch (error) {
      const code = error instanceof SandboxError ? { code: error.code } : {}
      if (code.code === 'smolvm_missing') return { ok: false, detail: (error as Error).message, ...code }
      return { ok: false, detail: `The smolvm engine did not load: ${(error as Error).message}`, ...code }
    }
  }

  async list(filter: { labels?: Record<string, string> } = {}): Promise<Machine[]> {
    const labels = { ...filter.labels, ...(await this.#ownLabels()) }
    const summaries = await this.#call((sdk) => sdk.list(LOCAL, { labels }))
    return summaries.map(toMachine).filter((machine) => hasLabels(machine.labels, filter.labels))
  }

  async get(name: string): Promise<Machine | null> {
    return (await this.list()).find((machine) => machine.name === name) ?? null
  }

  async create(options: CreateOptions): Promise<Machine> {
    const { labels } = checkCreate(this.name, CAPABILITIES, options, await this.#ownLabels())
    const existing = await this.get(options.name)
    if (existing) {
      if (options.idempotencyKey !== undefined && existing.labels[IDEMPOTENCY_LABEL] === options.idempotencyKey) return existing
      throw new SandboxError('already_exists', `smolvm already has a machine named ${options.name}.`)
    }
    const ports = await Promise.all((options.ports ?? []).map(async (port) => ({ host: port.host || (await this.#freePort()), guest: port.guest })))
    const handle = await this.#call((sdk) =>
      sdk.create(
        {
          name: options.name,
          image: options.image,
          ports,
          // The viewer listens only once the desktop is set up, so do not wait for ports here.
          waitForPorts: false,
          detach: true,
          branchable: options.branchable ?? false,
          labels,
          resources: {
            cpus: options.resources?.cpus,
            memoryMb: options.resources?.memoryMb,
            storageGb: options.resources?.storageGb,
            network: true,
            gpu: options.resources?.gpu ?? false,
            // Ports can be published on a running machine only with virtio-net.
            networkBackend: 'virtio-net',
          },
        },
        LOCAL,
      ),
    )
    this.#handles.set(options.name, handle)
    return this.#require(options.name)
  }

  async branch(source: string, name: string): Promise<Machine> {
    // Branching with ports would wait for them to listen, so they are published afterwards.
    const child = await this.#machine(source, (machine) => machine.branch(name))
    this.#handles.set(name, child)
    return this.#require(name)
  }

  async publish(name: string, guestPort: number): Promise<PublishedPort> {
    const port = await this.#machine(name, (machine) => machine.publish({ guest: guestPort }))
    if (port.host === undefined) throw new SandboxError('smolvm_publish', `smolvm did not say which host port it published for ${name}.`)
    return { guest: port.guest, host: port.host, hostIp: LOOPBACK }
  }

  async endpoint(name: string, guestPort: number): Promise<Endpoint> {
    const machine = await this.#require(name)
    if (machine.state !== 'running') throw new SandboxError('not_running', `${name} is not running.`)
    const port = machine.ports.find((published) => published.guest === guestPort)
    if (!port) throw new SandboxError('not_published', `Port ${guestPort} of ${name} is not published.`)
    return { kind: 'tcp', host: port.hostIp, port: port.host }
  }

  async start(name: string): Promise<Machine> {
    // The SDK's readiness wait includes published ports, which listen only once the desktop is set up.
    await this.#machine(name, (machine) => machine.start({ waitUntilReady: false }))
    return this.#require(name)
  }

  async stop(name: string): Promise<void> {
    if ((await this.#require(name)).state === 'stopped') return
    await this.#machine(name, (machine) => machine.stop())
  }

  async remove(name: string): Promise<void> {
    if (!(await this.get(name))) return this.#forget(name)
    try {
      await this.#machine(name, (machine) => machine.delete())
    } catch (error) {
      if (!(error instanceof SandboxError && error.code === 'not_found')) throw error
    }
    this.#forget(name)
  }

  async exec(name: string, command: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    const cancelled = () => new SandboxError('cancelled', `The command in ${name} was cancelled.`)
    if (options.signal?.aborted) throw cancelled()
    const limit = options.timeoutSeconds
    // The guest enforces the time limit, so the result is exit code 124 as the contract says; the SDK's own limit is a backstop.
    const argv = limit === undefined ? [...command] : ['timeout', '-k', '5', String(limit), ...command]
    // Only what the caller passes, never credentials.
    const smolOptions: SmolExecOptions = { user: options.user, timeout: limit === undefined ? undefined : limit + 30, env: options.env && checkGuestEnv(options.env), stdin: options.stdin }
    // smolmachines 1.31 kills a cancelled command only on its streaming path, which drops stdin. With stdin, it only stops waiting.
    if (options.signal && options.stdin === undefined) smolOptions.signal = options.signal
    const run = this.#machine(name, async (machine): Promise<ExecResult> => {
      if (!options.onOutput || options.stdin !== undefined) {
        const result = await machine.exec(argv, smolOptions)
        if (options.onOutput) {
          if (result.stdout) options.onOutput({ stream: 'stdout', text: result.stdout })
          if (result.stderr) options.onOutput({ stream: 'stderr', text: result.stderr })
        }
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
      }
      const output = { stdout: '', stderr: '' }
      for await (const event of machine.execStream(argv, smolOptions)) {
        if (event.kind === 'exit') return { exitCode: event.exitCode, ...output }
        if (event.kind === 'error') throw new SandboxError('smolvm_exec', event.message)
        output[event.kind] += event.data
        options.onOutput({ stream: event.kind, text: event.data })
      }
      throw new SandboxError('smolvm_exec', `The command in ${name} ended without an exit code.`)
    })
    try {
      return await unlessAborted(run, options.signal)
    } catch (error) {
      if (options.signal?.aborted) throw cancelled()
      if (limit !== undefined && error instanceof SandboxError && error.code === 'smolvm_timeout') return { exitCode: 124, stdout: '', stderr: '' }
      throw error
    }
  }

  async readFile(name: string, path: string, range?: ReadRange): Promise<Readable> {
    const data = await this.#machine(name, (machine) => machine.readFile(path))
    return streamBytes(sliceRange(data, range))
  }

  async writeFile(name: string, path: string, data: Uint8Array | Readable, options: WriteOptions = {}): Promise<void> {
    const bytes = data instanceof Uint8Array ? data : await collectStream(data)
    await this.#machine(name, (machine) => machine.writeFile(path, bytes, options.mode ?? 0o644))
    if (options.user === undefined || options.user === 'root') return
    const result = await this.exec(name, ['chown', `${options.user}:`, '--', path], { user: 'root' })
    if (result.exitCode !== 0) throw new SandboxError('invalid_options', `${path} in ${name} could not be given to ${options.user}: ${result.stderr.trim()}`)
  }

  async stat(name: string, path: string): Promise<FileInfo | null> {
    const result = await this.exec(name, ['stat', '-L', '-c', '%s %a', '--', path], { user: 'root' })
    if (result.exitCode !== 0) {
      if (/No such file or directory/.test(result.stderr)) return null
      throw new SandboxError('smolvm_exec', `Could not stat ${path} in ${name}: ${result.stderr.trim()}`)
    }
    const [size, mode] = result.stdout.trim().split(' ')
    return { size: Number(size), mode: Number.parseInt(mode ?? '', 8) }
  }

  async #require(name: string): Promise<Machine> {
    const machine = await this.get(name)
    if (!machine) throw new SandboxError('not_found', `smolvm has no machine named ${name}.`)
    this.#owned.add(name)
    return machine
  }
}
