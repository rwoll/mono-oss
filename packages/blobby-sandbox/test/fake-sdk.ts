import type { ConnectOptions, ExecEvent, ExecResult, LocalAvailability, MachineConfig, MachineSummary } from 'smolmachines'
import type { SmolMachine, SmolSdk } from '../src/smolvm.ts'

/** The labels the test backends give their machines, as if this host's ID were `test-host`. */
export const TEST_LABELS = Object.freeze({ 'blobby.dev/manager': 'standalone:test-host', 'blobby.dev/kind': 'desktop' })

/** An SDK error: a plain Error with a string `code`, like `SmolError`. */
export function smolError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

export interface FakeVm {
  summary: MachineSummary
  config: MachineConfig
  files: Map<string, { data: Buffer; mode?: number }>
  /** The machine this one is a copy of. */
  source?: string
}

type Answer = { exitCode: number; stdout?: string; stderr?: string }

export type ExecHandler = (
  name: string,
  command: string[],
  options: { user?: string; timeout?: number; env?: Record<string, string>; stdin?: string | Uint8Array; signal?: AbortSignal },
) => Answer | Promise<Answer>

/** An in-memory `smolmachines` SDK that records every call. */
export class FakeSdk implements SmolSdk {
  readonly version = '1.31.0'
  readonly vms = new Map<string, FakeVm>()
  readonly calls: { method: string; args: unknown[] }[] = []
  availability: LocalAvailability = { available: true }
  onExec: ExecHandler = () => ({ exitCode: 0 })
  #nextPort = 50000

  add(name: string, options: { state?: string; labels?: Record<string, string>; ports?: { host?: number; guest: number }[] } = {}): FakeVm {
    const vm: FakeVm = {
      config: { name },
      files: new Map(),
      summary: {
        name,
        id: name,
        state: options.state ?? 'stopped',
        labels: options.labels ?? { ...TEST_LABELS },
        persistent: true,
        detached: true,
        branchable: false,
        createdAt: '2023-11-14T22:13:20Z',
        ports: (options.ports ?? []).map((port) => ({ ...port, protocol: 'tcp' as const })),
      },
    }
    this.vms.set(name, vm)
    return vm
  }

  async create(config: MachineConfig, conn: ConnectOptions): Promise<SmolMachine> {
    this.calls.push({ method: 'create', args: [config, conn] })
    if (this.vms.has(config.name!)) throw smolError('CONFLICT', `machine '${config.name}' already exists`)
    const vm = this.add(config.name!, { state: 'running', labels: config.labels, ports: config.ports })
    vm.config = config
    return this.connect(config.name!, conn)
  }

  async list(conn: ConnectOptions, options: { labels: Record<string, string> }): Promise<MachineSummary[]> {
    this.calls.push({ method: 'list', args: [conn, options] })
    const matches = (labels: Record<string, string>) => Object.entries(options.labels).every(([key, value]) => labels[key] === value)
    return [...this.vms.values()].map((vm) => vm.summary).filter((summary) => matches(summary.labels))
  }

  async connect(name: string, conn: ConnectOptions): Promise<SmolMachine> {
    this.calls.push({ method: 'connect', args: [name, conn] })
    const vm = this.vms.get(name)
    if (!vm) throw smolError('NOT_FOUND', `VM not found: ${name}`)
    return this.#handle(name, vm)
  }

  localAvailability(): LocalAvailability {
    return this.availability
  }

  #handle(name: string, vm: FakeVm): SmolMachine {
    const running = () => {
      if (vm.summary.state !== 'running') throw smolError('INVALID_STATE', `machine '${name}' is not running`)
    }
    const record = (method: string, args: unknown[]) => this.calls.push({ method, args })
    const run: ExecHandler = (...args) => this.onExec(...args)
    return {
      start: async (options) => {
        record('start', [name, options])
        vm.summary.state = 'running'
      },
      stop: async () => void (vm.summary.state = 'stopped'),
      delete: async () => {
        const copies = [...this.vms.values()].filter((other) => other.source === name).map((other) => other.summary.name)
        if (copies.length) throw smolError('SMOLVM_ERROR', `machine '${name}' has dependent fork(s) (${copies.join(', ')}); delete descendants first`)
        this.vms.delete(name)
      },
      exec: async (command, options = {}) => {
        running()
        record('exec', [name, command, options])
        const result = await run(name, command, options)
        return { exitCode: result.exitCode, stdout: result.stdout ?? '', stderr: result.stderr ?? '' } as ExecResult
      },
      execStream: async function* (command, options = {}): AsyncGenerator<ExecEvent> {
        running()
        record('execStream', [name, command, options])
        const result = await run(name, command, options)
        // Split output mid-line, as a real stream can.
        const stdout = result.stdout ?? ''
        for (const data of [stdout.slice(0, 7), stdout.slice(7)]) if (data) yield { kind: 'stdout', data }
        if (result.stderr) yield { kind: 'stderr', data: result.stderr }
        yield { kind: 'exit', exitCode: result.exitCode }
      },
      readFile: async (path) => {
        const file = vm.files.get(path)
        if (!file) throw smolError('NOT_FOUND', `no such file: ${path}`)
        return file.data
      },
      writeFile: async (path, data, mode) => void vm.files.set(path, { data: Buffer.from(data), mode }),
      publish: async ({ guest }) => {
        record('publish', [name, guest])
        const port = { host: this.#nextPort++, guest, protocol: 'tcp' as const }
        vm.summary.ports = [...(vm.summary.ports ?? []), port]
        return port
      },
      branch: async (child) => {
        running()
        record('branch', [name, child])
        if (!vm.config.branchable) throw smolError('INVALID_STATE', `machine '${name}' is not branchable`)
        const copy = this.add(child, { state: 'running', labels: vm.summary.labels })
        copy.config = { ...vm.config, name: child, branchable: false }
        copy.files = new Map(vm.files)
        copy.source = name
        return this.#handle(child, copy)
      },
    }
  }
}
