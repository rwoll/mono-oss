import { randomBytes } from 'node:crypto'
import type { Readable } from 'node:stream'
import { checkGuestEnv } from './guest-env.ts'
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
  type NetworkPolicy,
  type PublishedPort,
  type ReadRange,
  type Snapshot,
  type SnapshotOptions,
  type WriteOptions,
} from './backend.ts'
import { emulateCommand } from './conformance.ts'
import { ALL_CAPABILITIES, checkCreate, checkLabels, collectStream, deleteAfterOf, hasLabels, requireCapability, sliceRange, streamBytes } from './contract.ts'

/** A file in a fake machine. */
export interface FakeFile {
  data: Buffer
  mode?: number
  /** Its owner; root when unset. */
  user?: string
}

/** A machine of a `FakeBackend`, with everything tests may want to look at or change. */
export interface FakeMachine {
  name: string
  state: string
  ports: PublishedPort[]
  createdAt: string | null
  /** All of its labels, owner labels included, also on a fake without the `labels` capability. */
  labels: Record<string, string>
  branchable: boolean
  image?: string
  /** The network policy it runs with: `internet` when it was let run unrestricted. */
  network: NetworkPolicy
  /** How it was created, or null when it was added with `add`. */
  options: CreateOptions | null
  /** Its files by absolute path. */
  files: Map<string, FakeFile>
  /** The machine this one is a copy of. */
  source?: string
  /** The snapshot it was created from. */
  snapshot?: string
}

/** A snapshot of a `FakeBackend`. */
export interface FakeSnapshot {
  id: string
  source: string | null
  createdAt: string | null
  labels: Record<string, string>
  files: Map<string, FakeFile>
}

export interface FakeExecResult {
  exitCode: number
  stdout?: string
  stderr?: string
}

/**
 * Answers a command in a fake machine. `options.signal` aborts when the call is cancelled or times out;
 * long answers should stop then.
 */
export type FakeExec = (name: string, command: readonly string[], options: ExecOptions) => FakeExecResult | Promise<FakeExecResult>

export interface FakeBackendOptions {
  /** The owner labels of the machines and snapshots it creates. It sees only those that carry all of them. Default none. */
  labels?: Record<string, string>
  /** Machines to share with another fake, as two owners on one provider would. */
  machines?: Map<string, FakeMachine>
  /** Snapshots to share with another fake. */
  snapshots?: Map<string, FakeSnapshot>
  /** Answers commands. The default runs the conformance suite's commands, and fails others with 127. */
  exec?: FakeExec
  /**
   * What it can do. Everything is on by default; turn capabilities off to test code on a backend like
   * Docker (`{ publish: false, branch: false }`) or Azure. Methods of a capability that is off fail with
   * `unsupported`.
   */
  capabilities?: Partial<Capabilities>
  now?: () => number
}

/**
 * An in-memory backend that behaves like a real one, for tests: machines, their files, ports, copies,
 * snapshots, and labels live in maps, every call is recorded in `calls`, and `onExec` answers commands.
 * It implements all of the backend contract and passes the conformance suite.
 */
export class FakeBackend implements Backend {
  readonly name = 'fake'
  readonly machines: Map<string, FakeMachine>
  readonly snapshotStore: Map<string, FakeSnapshot>
  readonly labels: Readonly<Record<string, string>>
  /** Every call, in order, with its arguments. */
  readonly calls: { method: string; args: unknown[] }[] = []
  /** What `check` reports. */
  status: BackendStatus = { ok: true, detail: 'fake backend, in memory' }
  onExec: FakeExec
  readonly #capabilities: Capabilities
  readonly #now: () => number
  #nextPort = 50000

  constructor(options: FakeBackendOptions = {}) {
    this.machines = options.machines ?? new Map()
    this.snapshotStore = options.snapshots ?? new Map()
    this.labels = Object.freeze({ ...options.labels })
    this.#capabilities = { ...ALL_CAPABILITIES, networkPolicies: [...ALL_CAPABILITIES.networkPolicies], ...options.capabilities }
    this.#now = options.now ?? Date.now
    this.onExec = options.exec ?? ((name, command, execOptions) => emulateCommand(command, execOptions, this.machines.get(name)?.files))
  }

  capabilities(): Capabilities {
    return { ...this.#capabilities, networkPolicies: [...this.#capabilities.networkPolicies] }
  }

  /** Adds a machine as if it had been made earlier, by this process or another. */
  add(
    name: string,
    options: { state?: string; ports?: { host: number; guest: number; hostIp?: string }[]; labels?: Record<string, string>; branchable?: boolean; image?: string } = {},
  ): FakeMachine {
    const machine: FakeMachine = {
      name,
      state: options.state ?? 'stopped',
      ports: (options.ports ?? []).map((port) => ({ guest: port.guest, host: port.host, hostIp: port.hostIp ?? '127.0.0.1' })),
      createdAt: new Date(this.#now()).toISOString(),
      labels: { ...(options.labels ?? this.labels) },
      branchable: options.branchable ?? false,
      network: 'internet',
      options: null,
      files: new Map(),
    }
    if (options.image !== undefined) machine.image = options.image
    this.machines.set(name, machine)
    return machine
  }

  async check(): Promise<BackendStatus> {
    this.#record('check', [])
    return { ...this.status }
  }

  async list(filter: { labels?: Record<string, string> } = {}): Promise<Machine[]> {
    this.#record('list', [filter])
    if (filter.labels && Object.keys(filter.labels).length) requireCapability(this.name, this.#capabilities, 'labels', 'filter machines by label')
    return [...this.machines.values()].filter((machine) => this.#owns(machine) && hasLabels(machine.labels, filter.labels)).map((machine) => this.#toMachine(machine))
  }

  async get(name: string): Promise<Machine | null> {
    this.#record('get', [name])
    const machine = this.machines.get(name)
    return machine && this.#owns(machine) ? this.#toMachine(machine) : null
  }

  async create(options: CreateOptions): Promise<Machine> {
    this.#record('create', [options])
    return this.#make(options, null)
  }

  async createFrom(snapshot: string, options: Omit<CreateOptions, 'image'>): Promise<Machine> {
    this.#record('createFrom', [snapshot, options])
    requireCapability(this.name, this.#capabilities, 'snapshot', 'create machines from snapshots')
    const saved = this.snapshotStore.get(snapshot)
    if (!saved || !hasLabels(saved.labels, this.labels)) throw new SandboxError('not_found', `There is no snapshot ${snapshot}.`)
    return this.#make({ ...options, image: snapshot }, saved)
  }

  async start(name: string): Promise<Machine> {
    this.#record('start', [name])
    const machine = this.#require(name)
    machine.state = 'running'
    return this.#toMachine(machine)
  }

  async stop(name: string): Promise<void> {
    this.#record('stop', [name])
    this.#require(name).state = 'stopped'
  }

  async remove(name: string): Promise<void> {
    this.#record('remove', [name])
    const machine = this.machines.get(name)
    if (!machine || !this.#owns(machine)) return
    const copies = [...this.machines.values()].filter((other) => other.source === name).map((other) => other.name)
    if (copies.length) throw new SandboxError('in_use', `${name} has copies (${copies.join(', ')}). Remove them first.`)
    this.machines.delete(name)
  }

  async exec(name: string, command: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    this.#record('exec', [name, [...command], options])
    checkGuestEnv(options.env)
    this.#running(name)
    if (options.stdin !== undefined) requireCapability(this.name, this.#capabilities, 'stdin', 'pass stdin to commands')
    const cancelled = () => new SandboxError('cancelled', `The command in ${name} was cancelled.`)
    if (options.signal?.aborted) throw cancelled()
    // One signal for the answer, aborted when the caller cancels or the time limit passes.
    const controller = new AbortController()
    const abort = () => controller.abort()
    let timedOut = false
    options.signal?.addEventListener('abort', abort, { once: true })
    const timer = options.timeoutSeconds === undefined ? undefined : setTimeout(() => ((timedOut = true), abort()), options.timeoutSeconds * 1000)
    let answer: FakeExecResult
    try {
      const stopped = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }))
      const answering = Promise.resolve(this.onExec(name, command, { ...options, signal: controller.signal }))
      // An answer that fails after the call was cancelled has no one to tell.
      answering.catch(() => {})
      answer = await Promise.race([answering, stopped])
    } catch (error) {
      if (timedOut) answer = { exitCode: 124 }
      else if (options.signal?.aborted) throw cancelled()
      else throw error
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
    }
    const result = { exitCode: answer.exitCode, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' }
    if (options.onOutput) {
      // Output arrives in pieces that need not end at a line, as from a real stream.
      const pieces = options.stdin === undefined ? [result.stdout.slice(0, 7), result.stdout.slice(7)] : [result.stdout]
      for (const text of pieces) if (text) options.onOutput({ stream: 'stdout', text })
      if (result.stderr) options.onOutput({ stream: 'stderr', text: result.stderr })
    }
    return result
  }

  async readFile(name: string, path: string, range?: ReadRange): Promise<Readable> {
    this.#record('readFile', [name, path, range])
    const file = this.#require(name).files.get(path)
    if (!file) throw new SandboxError('not_found', `There is no ${path} in ${name}.`)
    return streamBytes(Buffer.from(sliceRange(file.data, range)))
  }

  async writeFile(name: string, path: string, data: Uint8Array | Readable, options: WriteOptions = {}): Promise<void> {
    this.#record('writeFile', [name, path, data, options])
    const machine = this.#require(name)
    const bytes = data instanceof Uint8Array ? Buffer.from(data) : await collectStream(data)
    const file: FakeFile = { data: bytes }
    if (options.mode !== undefined) file.mode = options.mode
    if (options.user !== undefined) file.user = options.user
    machine.files.set(path, file)
  }

  async stat(name: string, path: string): Promise<FileInfo | null> {
    this.#record('stat', [name, path])
    const file = this.#require(name).files.get(path)
    return file ? { size: file.data.length, mode: file.mode ?? 0o644 } : null
  }

  async endpoint(name: string, guestPort: number): Promise<Endpoint> {
    this.#record('endpoint', [name, guestPort])
    const port = this.#running(name).ports.find((published) => published.guest === guestPort)
    if (!port) throw new SandboxError('not_published', `Port ${guestPort} of ${name} is not published.`)
    return { kind: 'tcp', host: port.hostIp === '0.0.0.0' ? '127.0.0.1' : port.hostIp, port: port.host }
  }

  async publish(name: string, guestPort: number): Promise<PublishedPort> {
    this.#record('publish', [name, guestPort])
    requireCapability(this.name, this.#capabilities, 'publish', 'publish ports of a machine after it is created; ask for them at create')
    const machine = this.#running(name)
    const existing = machine.ports.find((port) => port.guest === guestPort)
    if (existing) return { ...existing }
    const port = { guest: guestPort, host: this.#nextPort++, hostIp: '127.0.0.1' }
    machine.ports.push(port)
    return { ...port }
  }

  async branch(source: string, name: string): Promise<Machine> {
    this.#record('branch', [source, name])
    requireCapability(this.name, this.#capabilities, 'branch', 'branch machines')
    const from = this.#running(source)
    if (!from.branchable) throw new SandboxError('invalid_options', `${source} was not created branchable, so it can't be copied.`)
    if (this.machines.has(name)) throw new SandboxError('already_exists', `A machine named ${name} already exists.`)
    // Copies keep their source's labels, as smolvm's do.
    const copy = this.add(name, { state: 'running', labels: from.labels, image: from.image })
    copy.options = from.options && { ...from.options, name, ports: [], branchable: false }
    copy.network = from.network
    copy.files = copyFiles(from.files)
    copy.source = source
    return this.#toMachine(copy)
  }

  async snapshot(source: string, options: SnapshotOptions = {}): Promise<Snapshot> {
    this.#record('snapshot', [source, options])
    requireCapability(this.name, this.#capabilities, 'snapshot', 'take snapshots')
    const machine = this.#require(source)
    const saved: FakeSnapshot = {
      id: `fake-snapshot-${randomBytes(6).toString('hex')}`,
      source: machine.name,
      createdAt: new Date(this.#now()).toISOString(),
      labels: { ...checkLabels(options.labels), ...this.labels },
      files: copyFiles(machine.files),
    }
    this.snapshotStore.set(saved.id, saved)
    return toSnapshot(saved)
  }

  async snapshots(filter: { labels?: Record<string, string> } = {}): Promise<Snapshot[]> {
    this.#record('snapshots', [filter])
    requireCapability(this.name, this.#capabilities, 'snapshot', 'take snapshots')
    return [...this.snapshotStore.values()].filter((saved) => hasLabels(saved.labels, this.labels) && hasLabels(saved.labels, filter.labels)).map(toSnapshot)
  }

  async removeSnapshot(id: string): Promise<void> {
    this.#record('removeSnapshot', [id])
    requireCapability(this.name, this.#capabilities, 'snapshot', 'take snapshots')
    const saved = this.snapshotStore.get(id)
    if (!saved || !hasLabels(saved.labels, this.labels)) return
    const users = [...this.machines.values()].filter((machine) => machine.snapshot === id).map((machine) => machine.name)
    if (users.length) throw new SandboxError('in_use', `Machines were created from snapshot ${id} (${users.join(', ')}). Remove them first.`)
    this.snapshotStore.delete(id)
  }

  #make(options: CreateOptions, from: FakeSnapshot | null): Machine {
    const { labels, network } = checkCreate(this.name, this.#capabilities, options, this.labels)
    for (const port of options.ports ?? []) {
      if (!validPort(port.guest) || (port.host !== undefined && port.host !== 0 && !validPort(port.host))) {
        throw new SandboxError('invalid_options', `${port.guest} → ${port.host} is not a valid port mapping.`)
      }
    }
    const existing = this.machines.get(options.name)
    if (existing) {
      const key = options.idempotencyKey
      if (key !== undefined && this.#owns(existing) && existing.labels[IDEMPOTENCY_LABEL] === key) return this.#toMachine(existing)
      throw new SandboxError('already_exists', `A machine named ${options.name} already exists.`)
    }
    const machine = this.add(options.name, {
      state: 'running',
      ports: (options.ports ?? []).map((port) => ({ guest: port.guest, host: port.host || this.#nextPort++ })),
      labels,
      branchable: options.branchable ?? false,
      image: options.image,
    })
    machine.network = network
    machine.options = { ...options, ports: [...(options.ports ?? [])] }
    if (from) {
      machine.files = copyFiles(from.files)
      machine.snapshot = from.id
    }
    return this.#toMachine(machine)
  }

  #toMachine(machine: FakeMachine): Machine {
    const labels = this.#capabilities.labels ? { ...machine.labels } : {}
    const result: Machine = {
      name: machine.name,
      state: machine.state,
      ports: machine.ports.map((port) => ({ ...port })),
      createdAt: machine.createdAt,
      labels,
      deleteAfter: deleteAfterOf(labels),
    }
    if (machine.image !== undefined) result.image = machine.image
    return result
  }

  #record(method: string, args: unknown[]): void {
    this.calls.push({ method, args })
  }

  #owns(machine: FakeMachine): boolean {
    return hasLabels(machine.labels, this.labels)
  }

  #require(name: string): FakeMachine {
    const machine = this.machines.get(name)
    if (!machine || !this.#owns(machine)) throw new SandboxError('not_found', `There is no machine named ${name}.`)
    return machine
  }

  #running(name: string): FakeMachine {
    const machine = this.#require(name)
    if (machine.state !== 'running') throw new SandboxError('not_running', `${name} is not running.`)
    return machine
  }
}

const validPort = (port: number) => Number.isInteger(port) && port > 0 && port < 65536

function copyFiles(files: Map<string, FakeFile>): Map<string, FakeFile> {
  return new Map([...files].map(([path, file]) => [path, { ...file, data: Buffer.from(file.data) }]))
}

function toSnapshot(saved: FakeSnapshot): Snapshot {
  return { id: saved.id, source: saved.source, createdAt: saved.createdAt, labels: { ...saved.labels } }
}
