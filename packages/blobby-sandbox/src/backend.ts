import type { Readable } from 'node:stream'

// Backend contract v2. Every backend (smolvm, Docker, Azure sandboxes, and fakes) implements `Backend`,
// and the shared conformance suite checks it. Optional abilities are reported by `capabilities()` and
// gated on it: a request for something a backend can't do fails with `unsupported`, never silently.

/** What a backend can do. Callers check this before relying on an optional method or option. */
export interface Capabilities {
  /** `branch()`: copy a running machine's disk and memory. */
  branch: boolean
  /** `publish()`: publish a guest port on a machine that already exists. Docker can't; it fixes ports at create. */
  publish: boolean
  /** `CreateOptions.ports`: publish guest ports on host ports at create. Azure can't; it has only HTTP ingress, so its sandboxes have no viewer yet. */
  ports: boolean
  /** `resources.gpu`: give the guest the host GPU. */
  gpu: boolean
  /** The network policies this backend can enforce. Asking for another one fails closed with `network_unenforceable`. */
  networkPolicies: NetworkPolicyKind[]
  /** `commandSandbox`: run VS Code's command sandbox (bubblewrap with user and network namespaces) in the guest. */
  commandSandbox: boolean
  /** `readFile` and `writeFile` stream without holding a whole file in memory. */
  streamingFiles: boolean
  /** `labels` and `deleteAfter` are stored by the provider and returned by `list` and `get`. */
  labels: boolean
  /** `ExecOptions.stdin`. Azure passes it through a file in the guest's memory-only `/run`. */
  stdin: boolean
  /** `snapshot()`, `snapshots()`, `removeSnapshot()`, and `createFrom()`. */
  snapshot: boolean
}

export type NetworkPolicyKind = 'none' | 'essential' | 'internet' | 'allow'

/**
 * What a machine may reach. `essential`: only what the backend needs to run it (for example DNS and its
 * own control plane). `internet`: unrestricted. `{ allow }`: deny by default, except these hosts or
 * `*.`-prefixed patterns.
 */
export type NetworkPolicy = 'none' | 'essential' | 'internet' | { allow: string[] }

/** A machine that a backend runs. */
export interface Machine {
  name: string
  /** `created`, `running`, or `stopped`. Backends map their own states onto these; anything else is passed through. */
  state: MachineState
  /** Guest ports published on the host. Fixed at create on backends without `publish`. */
  ports: PublishedPort[]
  /** ISO 8601 time, or null when the backend does not say. */
  createdAt: string | null
  /** Its labels, owner labels included. Empty on backends without `labels`. */
  labels: Record<string, string>
  /** ISO 8601 absolute deletion deadline, from the `blobby.dev/delete-after` label, or null. */
  deleteAfter: string | null
  /** The image or snapshot it was created from, when the backend says. */
  image?: string
}

export type MachineState = 'created' | 'running' | 'stopped' | (string & {})

export interface PortRequest {
  guest: number
  /** The host port. 0 or absent picks a free one. */
  host?: number
}

export interface PublishedPort {
  guest: number
  host: number
  /** The host address it listens on. Standalone backends use 127.0.0.1 only. */
  hostIp: string
}

export interface Resources {
  cpus?: number
  memoryMb?: number
  /** Size of the machine's disk, where the backend sizes disks. */
  storageGb?: number
  /** Needs `capabilities().gpu`. */
  gpu?: boolean
}

export interface CreateOptions<P = unknown> {
  name: string
  /** An OCI image reference, such as `ubuntu:24.04`, or a backend-specific image. Snapshots use `createFrom`. */
  image: string
  resources?: Resources
  /** Guest ports to publish on the host, fixed for the machine's life on backends without `publish`. */
  ports?: PortRequest[]
  /**
   * Extra labels. The backend adds its owner labels (such as `blobby.dev/manager`), which these can't
   * override. Keys and values must be valid for every provider: `[a-z0-9.-]+(/[a-z0-9._-]+)?` keys and
   * values of at most 63 characters from `[A-Za-z0-9._:-]`.
   */
  labels?: Record<string, string>
  /**
   * Makes `create` safe to repeat. A machine with this name and key is returned as it is, instead of
   * failing with `already_exists`. A machine with this name and another key or none still fails.
   */
  idempotencyKey?: string
  /** The absolute deletion deadline, stored as the `blobby.dev/delete-after` label. Reapers delete the machine after it. */
  deleteAfter?: Date
  /** Default `internet`. A policy the backend can't enforce fails closed with `network_unenforceable`. */
  network?: NetworkPolicy
  /**
   * Local development only: run with a network policy the backend can't enforce, unrestricted. The caller
   * must print a warning. Ignored when the backend enforces the policy.
   */
  allowUnenforcedNetwork?: boolean
  /** Needs `capabilities().commandSandbox`. Docker adds its pinned seccomp profile and `/dev/net/tun` only then. */
  commandSandbox?: boolean
  /** Whether the guest may become root (for example with sudo). Without it, backends set `no-new-privileges` where they can. */
  root?: boolean
  /** Whether other machines can branch from this one. Needs `capabilities().branch`. */
  branchable?: boolean
  /** Backend-specific settings, typed by each backend. Generic code leaves this out. */
  providerOptions?: P
}

export interface ExecOptions {
  /** Guest user. Sandboxes default to the desktop user; use `root` for system changes, such as installing packages. */
  user?: string
  /** A hard limit, enforced in the guest (for example with `timeout`). The result then has exit code 124. */
  timeoutSeconds?: number
  env?: Record<string, string>
  /** Written to the command's stdin, then closed. Use it for secrets: it never touches the machine's disk. Needs `capabilities().stdin`. */
  stdin?: string | Uint8Array
  /** Called with output as it arrives, for long commands. */
  onOutput?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void
  /** Stops waiting and kills the command where the backend can. The promise rejects with `cancelled`. */
  signal?: AbortSignal
}

/** A non-zero exit code is a result, not an error. */
export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface ReadRange {
  /** First byte, default 0. */
  offset?: number
  /** Most bytes to read, default to the end. */
  length?: number
}

export interface WriteOptions {
  /** File mode, default 0o644. Parent folders are created as needed. */
  mode?: number
  /** Owner of the file, default root. */
  user?: string
}

export interface FileInfo {
  size: number
  mode: number
}

/** Where a client reaches a guest port. */
export type Endpoint =
  | { kind: 'tcp'; host: string; port: number }
  | { kind: 'url'; url: string; headers?: Record<string, string> }

export interface SnapshotOptions {
  /** Labels kept with the snapshot by the backend (image labels, tags, or machine labels). Same rules as `CreateOptions.labels`. */
  labels?: Record<string, string>
}

/** A saved machine that new machines can be created from with `createFrom`. Its metadata lives in the backend, not in local files. */
export interface Snapshot {
  /** Pass this to `createFrom` and `removeSnapshot`. */
  id: string
  /** The machine it was taken from, when the backend knows. */
  source: string | null
  createdAt: string | null
  labels: Record<string, string>
}

/** One thing `check()` looked at, such as whether Docker applies seccomp profiles. `doctor` lists them. */
export interface BackendCheck {
  name: string
  ok: boolean
  /** What it found, or what to fix. */
  detail: string
}

export interface BackendStatus {
  ok: boolean
  /** What runs the machines, such as `Docker Engine 29.4.1`, or what to fix. */
  detail: string
  /** When it is not ok, the error code, if there is one. */
  code?: string
  /**
   * Each thing the backend checked, when it checks more than one, for `doctor` to list. A failed check
   * doesn't make the status not ok by itself: some only limit options, such as `commandSandbox`.
   */
  checks?: BackendCheck[]
}

/**
 * Runs machines. A backend instance belongs to one owner: it stamps its owner labels on everything it
 * creates, and `list`, `get`, `snapshots`, and every other method see only machines and snapshots with
 * all of them. Two owners on one provider never see or touch each other's machines.
 */
export interface Backend<P = unknown> {
  readonly name: string
  /** Static for the instance. */
  capabilities(): Capabilities
  /** Whether this host can run machines. Never throws. */
  check(): Promise<BackendStatus>
  /** This owner's machines, optionally only those with all of `labels`. */
  list(filter?: { labels?: Record<string, string> }): Promise<Machine[]>
  /** The machine, or null when this owner has none with that name. */
  get(name: string): Promise<Machine | null>
  /** Creates and starts a machine. */
  create(options: CreateOptions<P>): Promise<Machine>
  start(name: string): Promise<Machine>
  /** Stops a machine and keeps its disk. Stopping a stopped machine does nothing. */
  stop(name: string): Promise<void>
  /** Deletes a machine and its disk. Removing a machine that doesn't exist does nothing, so reapers can repeat it. */
  remove(name: string): Promise<void>
  /** Runs a command. A non-zero exit code is a result, not an error. */
  exec(name: string, command: readonly string[], options?: ExecOptions): Promise<ExecResult>
  /** Streams a guest file, or a byte range of it. A missing file fails with `not_found`. */
  readFile(name: string, path: string, range?: ReadRange): Promise<Readable>
  /** Writes a guest file from bytes or a stream, creating parent folders. */
  writeFile(name: string, path: string, data: Uint8Array | Readable, options?: WriteOptions): Promise<void>
  /** A guest file's size and mode, or null when it doesn't exist. */
  stat(name: string, path: string): Promise<FileInfo | null>
  /** Where a client reaches a guest port of a running machine. Fails with `not_published` when it can't be reached. */
  endpoint(name: string, guestPort: number): Promise<Endpoint>
  /** Needs `capabilities().publish`. Publishes a guest port of an existing machine on a free host port. */
  publish?(name: string, guestPort: number): Promise<PublishedPort>
  /** Needs `capabilities().branch`. Creates `name` as a copy of the running, branchable machine `source`, without its published ports. */
  branch?(source: string, name: string): Promise<Machine>
  /** Needs `capabilities().snapshot`. Saves a machine as a snapshot. The backend may stop and restart it to do so. */
  snapshot?(source: string, options?: SnapshotOptions): Promise<Snapshot>
  /** Needs `capabilities().snapshot`. This owner's snapshots, optionally only those with all of `labels`. */
  snapshots?(filter?: { labels?: Record<string, string> }): Promise<Snapshot[]>
  /** Needs `capabilities().snapshot`. Removing one that doesn't exist does nothing. Fails with `in_use` while machines need it. */
  removeSnapshot?(id: string): Promise<void>
  /**
   * Needs `capabilities().snapshot`. Creates and starts a machine from a snapshot. Backends whose machines
   * from a snapshot always have its size fail with `unsupported` when `resources` ask for another.
   */
  createFrom?(snapshot: string, options: Omit<CreateOptions<P>, 'image'>): Promise<Machine>
}

/** The label that holds a machine's absolute deletion deadline, as an ISO 8601 UTC time. */
export const DELETE_AFTER_LABEL = 'blobby.dev/delete-after'
/** The label that holds `CreateOptions.idempotencyKey`. */
export const IDEMPOTENCY_LABEL = 'blobby.dev/create-key'

/**
 * Stable error codes. Messages say what to do; codes are for programs. Backends may add their own,
 * prefixed with their name (such as `docker_apparmor`).
 */
export const ERROR_CODES = [
  'not_found',
  'already_exists',
  'not_running',
  'not_published',
  'unsupported',
  'network_unenforceable',
  'invalid_options',
  'in_use',
  'cancelled',
  'timeout',
  'backend_unavailable',
  'unknown_backend',
  'limit_reached',
] as const

/** An expected failure, with a message that says what to do. */
export class SandboxError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SandboxError'
    this.code = code
  }
}

/** Whole-buffer read, for small files. Use `readFile` for anything large, such as recordings. */
export async function readAll(backend: Backend, name: string, path: string, range?: ReadRange): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of await backend.readFile(name, path, range)) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks)
}
