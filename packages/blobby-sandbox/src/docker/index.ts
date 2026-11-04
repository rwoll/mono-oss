import { randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { Readable } from 'node:stream'
import { once } from 'node:events'
import {
  DELETE_AFTER_LABEL,
  IDEMPOTENCY_LABEL,
  SandboxError,
  type Backend,
  type BackendCheck,
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
  type Snapshot,
  type SnapshotOptions,
  type WriteOptions,
} from '../backend.ts'
import { checkCreate, checkLabels, deleteAfterOf, EXEC_ID_ENV, hasLabels, KILL_SCRIPT } from '../contract.ts'
import { ownerLabels } from '../labels.ts'
import { checkGuestEnv } from '../guest-env.ts'
import { DockerApiError, DockerEngine, Demuxer, describeTarget, dockerTarget, jsonLines, type DockerTarget, type VersionInfo } from './engine.ts'
import { loadSandboxProfile, SECCOMP_PROFILE_URL, TUN_DEVICE } from './seccomp.ts'
import { archiveSize, extractFirstFile, packEntries, TarFormatError, type TarEntry } from './tar.ts'

export { DockerApiError, DockerEngine, dockerTarget, MAX_API_VERSION, MIN_API_VERSION } from './engine.ts'
export type { DockerTarget, VersionInfo } from './engine.ts'
export { NAMESPACE_SYSCALLS, SECCOMP_PROFILE_SOURCE, SECCOMP_PROFILE_URL, sandboxSeccompProfile, TUN_DEVICE } from './seccomp.ts'

/** Docker-only settings, in `CreateOptions.providerOptions`. Generic code leaves them out. */
export interface DockerProviderOptions {
  /**
   * Attach the machine to this Docker network, such as Home's `desktops` network under compose, instead
   * of the default bridge. Ports are then not published on the host: `endpoint()` returns the machine's
   * address on this network. Needs the `internet` network policy.
   */
  network?: string
  /**
   * `unconfined` runs the machine without AppArmor. On Linux hosts whose daemon applies AppArmor's
   * `docker-default` profile, the command sandbox needs it, and `commandSandbox` fails with
   * `docker_apparmor` until you pass it. It is never applied unless you pass it.
   */
  apparmor?: 'unconfined'
  /**
   * What the container runs as its main process: `sleep` (the default) keeps the machine up, with
   * Docker's init reaping orphans, whatever the image; `image` runs the image's own entrypoint and command.
   */
  command?: 'sleep' | 'image'
  /** The size of `/dev/shm` in MB. The default is 512, which browsers need. */
  shmSizeMb?: number
}

/** How far a pull has got, from the daemon's progress stream. */
export interface PullProgress {
  image: string
  /** Docker's status line, such as `Downloading` or `Pull complete`. */
  status: string
  /** The layer it is about, when it is about one. */
  layer?: string
  current?: number
  total?: number
}

export interface DockerBackendOptions {
  /**
   * The owner labels it stamps on everything it creates, and filters every lookup by. The default is this
   * host's standalone labels.
   */
  labels?: Record<string, string>
  /** For `DOCKER_HOST`, the limits, and the default labels' host ID. The default is `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Where Docker listens, instead of `DOCKER_HOST` and the default sockets. */
  target?: DockerTarget
  /**
   * The most machines this owner may run at once, and have in all. The defaults are 3 and 6, or
   * `BLOBBY_SANDBOX_DOCKER_MAX_RUNNING` and `BLOBBY_SANDBOX_DOCKER_MAX_TOTAL`.
   */
  limits?: { running?: number; total?: number }
  /** Called as `create` pulls a missing image. */
  onPull?: (progress: PullProgress) => void
}

/** A `doctor` line: what was checked, and whether it is fine. */
export interface DockerCheck extends BackendCheck {
  name: 'docker' | 'platform' | 'seccomp' | 'tun' | 'apparmor' | 'limits'
}

/** `check()`'s answer, with each thing `doctor` checks. */
export interface DockerStatus extends BackendStatus {
  checks: DockerCheck[]
}

export const DEFAULT_LIMITS = Object.freeze({ running: 3, total: 6 })
export const MAX_RUNNING_ENV = 'BLOBBY_SANDBOX_DOCKER_MAX_RUNNING'
export const MAX_TOTAL_ENV = 'BLOBBY_SANDBOX_DOCKER_MAX_TOTAL'
/** The repository snapshot images are tagged in. */
export const SNAPSHOT_REPOSITORY = 'blobby-snapshot'
/** Which labels on a container or image are the machine's or snapshot's own, as opposed to ones its image brought along. */
export const LABEL_KEYS_LABEL = 'blobby.dev/docker-labels'
/** The machine a snapshot was taken from. */
export const SNAPSHOT_SOURCE_LABEL = 'blobby.dev/snapshot-of'
/** The command `exec` kills a cancelled command with. Exported for fakes. */
export { EXEC_ID_ENV, KILL_SCRIPT }
/** How long `stop` waits before it kills a machine's processes. */
const STOP_SECONDS = 5
/** How long `stop` waits for Docker's list to show that the container stopped. */
const SETTLE_MS = 10_000
const STOPPED = new Set(['exited', 'dead', 'created'])
const DEFAULT_SHM_MB = 512
const IN_MEMORY_LIMIT = 8 * 1024 * 1024

const NAME = /^[a-z0-9][a-z0-9.-]{0,61}[a-z0-9]$/
const USER = /^(?:[a-z_][a-z0-9_-]{0,31}\$?|\d{1,10})(?::(?:[a-z_][a-z0-9_-]{0,31}|\d{1,10}))?$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/
const NETWORK = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/
// An image reference: [registry[:port]/]path[:tag][@digest], or an image ID.
const COMPONENT = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*'
const DOMAIN = '(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*(?::[0-9]{1,5})?/)?'
const IMAGE = new RegExp(`^(?:${DOMAIN}${COMPONENT}(?:/${COMPONENT})*(?::[\\w][\\w.-]{0,127})?(?:@sha256:[a-f0-9]{64})?|sha256:[a-f0-9]{64})$`)
const RESERVED_NETWORKS = new Set(['host', 'none', 'default'])

interface ContainerSummary {
  Id: string
  Names?: string[]
  Image?: string
  ImageID?: string
  Created?: number
  State?: string
  Labels?: Record<string, string> | null
  Ports?: { IP?: string; PrivatePort: number; PublicPort?: number; Type?: string }[]
  HostConfig?: { NetworkMode?: string }
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> | null }
}

interface ImageSummary {
  Id: string
  RepoTags?: string[] | null
  Created?: number
  Labels?: Record<string, string> | null
}

interface ImageInspect {
  Id: string
  Created?: string
  RepoTags?: string[] | null
  Config?: { Labels?: Record<string, string> | null; Entrypoint?: string[] | null; Cmd?: string[] | null } | null
}

interface InfoResponse {
  /** The CPUs Docker can give containers: the host's, or Docker Desktop's VM's. */
  NCPU?: number
  OperatingSystem?: string
  OSType?: string
  Architecture?: string
  SecurityOptions?: string[] | null
}

interface PathStat {
  name: string
  size: number
  mode: number
  linkTarget?: string
}

function invalid(message: string): SandboxError {
  return new SandboxError('invalid_options', message)
}

function checkName(name: string): string {
  if (typeof name !== 'string' || !NAME.test(name)) throw invalid(`"${String(name)}" isn't a valid machine name for Docker: use 2 to 63 lowercase letters, digits, dots, and dashes, starting and ending with a letter or digit.`)
  return name
}

function checkImage(image: string): string {
  if (typeof image !== 'string' || image.length > 512 || !IMAGE.test(image)) throw invalid(`"${String(image)}" isn't a valid image reference, such as ubuntu:24.04 or ubuntu@sha256:<digest>.`)
  return image
}

function checkPath(path: string): string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) throw invalid(`"${String(path)}" isn't an absolute path.`)
  const normal = posix.normalize(path)
  return normal.length > 1 ? normal.replace(/\/+$/, '') : normal
}

function checkUser(user: string | undefined): string | undefined {
  if (user === undefined) return undefined
  if (typeof user !== 'string' || !USER.test(user)) throw invalid(`"${String(user)}" isn't a valid user: use a name or a uid, optionally with :group.`)
  return user
}

function checkEnv(env: Record<string, string> | undefined): string[] {
  // Only what the caller passes, never credentials.
  checkGuestEnv(env)
  return Object.entries(env ?? {}).map(([key, value]) => {
    if (!ENV_NAME.test(key)) throw invalid(`"${key}" isn't a valid environment variable name.`)
    if (typeof value !== 'string' || value.includes('\0')) throw invalid(`The value of ${key} must be a string without NUL characters.`)
    if (key === EXEC_ID_ENV) throw invalid(`${EXEC_ID_ENV} is reserved by the docker backend.`)
    return `${key}=${value}`
  })
}

function positiveInteger(value: unknown, what: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > max) throw invalid(`${what} must be a whole number from 1 to ${max}.`)
  return value
}

function limitFrom(option: number | undefined, value: string | undefined, fallback: number, name: string): number {
  if (option !== undefined) return positiveInteger(option, `limits.${name}`, 1000)
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw invalid(`${name === 'running' ? MAX_RUNNING_ENV : MAX_TOTAL_ENV} must be a whole number above 0.`)
  return parsed
}

function iso(seconds: number | undefined): string | null {
  return typeof seconds === 'number' && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null
}

function ownLabelsOf(labels: Record<string, string> | null | undefined): Record<string, string> {
  const all = labels ?? {}
  const keys = (all[LABEL_KEYS_LABEL] ?? '').split(',').filter(Boolean)
  const out: Record<string, string> = {}
  for (const key of keys) if (all[key] !== undefined && all[key] !== '') out[key] = all[key]
  return out
}

function labelFilters(labels: Record<string, string>): string[] {
  return Object.entries(labels).map(([key, value]) => `${key}=${value}`)
}

function toState(state: string | undefined): string {
  if (state === 'exited' || state === 'dead') return 'stopped'
  return state ?? 'unknown'
}

/** Go's `os.FileMode` bits, as Docker's path stat reports them, to Unix permission bits. */
function unixMode(mode: number): { mode: number; directory: boolean; symlink: boolean } {
  const bit = (n: number) => Math.floor(mode / 2 ** n) % 2 === 1
  let unix = mode % 0o1000
  if (bit(23)) unix |= 0o4000
  if (bit(22)) unix |= 0o2000
  if (bit(20)) unix |= 0o1000
  return { mode: unix, directory: bit(31), symlink: bit(27) }
}

function parseStat(header: string | string[] | undefined): PathStat | null {
  if (typeof header !== 'string') return null
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as PathStat
  } catch {
    return null
  }
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The bytes to write, with their size known up front, as a tar header needs. Streams of unknown size go through a private temporary file once they outgrow memory. */
async function sized(data: Uint8Array | Readable): Promise<{ size: number; chunks: () => AsyncIterable<Uint8Array> | Iterable<Uint8Array>; cleanup: () => Promise<void> }> {
  if (data instanceof Uint8Array) return { size: data.byteLength, chunks: () => [data], cleanup: async () => {} }
  const held: Buffer[] = []
  let size = 0
  let spool: { dir: string; file: string; out: ReturnType<typeof createWriteStream> } | undefined
  try {
    for await (const chunk of data) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      size += buffer.length
      if (!spool && size <= IN_MEMORY_LIMIT) {
        held.push(buffer)
        continue
      }
      if (!spool) {
        const dir = await mkdtemp(join(tmpdir(), 'blobby-docker-'))
        const file = join(dir, 'data')
        spool = { dir, file, out: createWriteStream(file, { mode: 0o600 }) }
        for (const piece of held.splice(0)) if (!spool.out.write(piece)) await once(spool.out, 'drain')
      }
      if (!spool.out.write(buffer)) await once(spool.out, 'drain')
    }
    if (spool) {
      spool.out.end()
      await once(spool.out, 'close')
    }
  } catch (error) {
    spool?.out.destroy()
    if (spool) await rm(spool.dir, { recursive: true, force: true })
    throw error
  }
  if (!spool) return { size, chunks: () => held, cleanup: async () => {} }
  const { dir, file } = spool
  return { size, chunks: () => createReadStream(file), cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** Ubuntu 23.10 and later: unconfined processes get no capabilities in the user namespaces they make. */
export const USERNS_SYSCTL = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'

function readSysctl(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return null
  }
}

/**
 * What `doctor` says about AppArmor: whether the daemon applies `docker-default`, and, for a daemon on
 * this host, the setting that keeps the command sandbox from working even without AppArmor.
 */
export function apparmorCheck(applied: boolean, restrictUserns: string | null): DockerCheck {
  const sysctl = restrictUserns === '1'
    ? ' This host also gives unconfined processes no capabilities in their user namespaces (kernel.apparmor_restrict_unprivileged_userns=1), so bubblewrap still fails without AppArmor; on a throwaway host, set it to 0.'
    : ''
  if (!applied) return { name: 'apparmor', ok: true, detail: 'Not in use, so the command sandbox works.' }
  return {
    name: 'apparmor',
    ok: false,
    detail: `The daemon applies AppArmor's docker-default profile, which blocks the command sandbox: commandSandbox fails with docker_apparmor unless you pass providerOptions: { apparmor: 'unconfined' }.${sysctl}`,
  }
}

/** A user name or ID, as `writeFile` takes it, to numeric IDs from the machine's own passwd and group files. */
export function resolveOwner(user: string, passwd: string, group: string): { uid: number; gid: number } | null {
  const [userPart, groupPart] = user.split(':') as [string, string | undefined]
  const entries = passwd.split('\n').map((line) => line.split(':')).filter((fields) => fields.length >= 4)
  const entry = /^\d+$/.test(userPart) ? entries.find((fields) => fields[2] === userPart) : entries.find((fields) => fields[0] === userPart)
  let uid: number
  let gid: number
  if (entry) {
    uid = Number(entry[2])
    gid = Number(entry[3])
  } else if (/^\d+$/.test(userPart)) {
    uid = Number(userPart)
    gid = uid
  } else {
    return null
  }
  if (groupPart !== undefined) {
    if (/^\d+$/.test(groupPart)) gid = Number(groupPart)
    else {
      const found = group
        .split('\n')
        .map((line) => line.split(':'))
        .find((fields) => fields[0] === groupPart && fields.length >= 3)
      if (!found) return null
      gid = Number(found[2])
    }
  }
  return { uid, gid }
}

/**
 * Runs each machine as a Docker container through the Docker Engine API on the daemon's socket. It needs
 * no Docker CLI, so it also works inside a container under compose. Containers are never privileged,
 * get no added capabilities or host mounts, and publish ports on 127.0.0.1 only.
 */
export class DockerBackend implements Backend<DockerProviderOptions> {
  readonly name = 'docker'
  readonly engine: DockerEngine
  readonly #options: DockerBackendOptions
  readonly #env: NodeJS.ProcessEnv
  #labels: Promise<Record<string, string>> | undefined
  #info: Promise<InfoResponse> | undefined
  #target: DockerTarget | SandboxError

  constructor(options: DockerBackendOptions = {}) {
    this.#options = options
    this.#env = options.env ?? process.env
    try {
      this.#target = options.target ?? dockerTarget(this.#env)
    } catch (error) {
      if (!(error instanceof SandboxError)) throw error
      this.#target = error
    }
    this.engine = new DockerEngine(this.#target instanceof SandboxError ? { kind: 'unix', socketPath: '/var/run/docker.sock' } : this.#target)
  }

  capabilities(): Capabilities {
    return {
      branch: false,
      publish: false,
      gpu: false,
      networkPolicies: ['none', 'internet'],
      commandSandbox: true,
      streamingFiles: true,
      ports: true,
      labels: true,
      stdin: true,
      snapshot: true,
    }
  }

  /** The most machines this owner may run at once, and have in all. */
  limits(): { running: number; total: number } {
    return {
      running: limitFrom(this.#options.limits?.running, this.#env[MAX_RUNNING_ENV], DEFAULT_LIMITS.running, 'running'),
      total: limitFrom(this.#options.limits?.total, this.#env[MAX_TOTAL_ENV], DEFAULT_LIMITS.total, 'total'),
    }
  }

  #ownLabels(): Promise<Record<string, string>> {
    this.#labels ??= (async () => checkLabels(this.#options.labels ?? (await ownerLabels(this.#env))))()
    return this.#labels
  }

  #daemonInfo(): Promise<InfoResponse> {
    this.#info ??= this.#call(() => this.engine.json<InfoResponse>('GET', '/info'))
    this.#info.catch(() => (this.#info = undefined))
    return this.#info
  }

  /** Runs Engine API calls, and turns their failures into `SandboxError`s. */
  async #call<T>(run: () => Promise<T>, context: { name?: string } = {}): Promise<T> {
    if (this.#target instanceof SandboxError) throw this.#target
    try {
      return await run()
    } catch (error) {
      throw this.#error(error, context)
    }
  }

  #error(error: unknown, context: { name?: string } = {}): unknown {
    if (error instanceof SandboxError || !(error instanceof DockerApiError)) return error
    const message = error.message
    const what = context.name ? `${context.name}: ` : ''
    if (error.status === 404 && /no such container/i.test(message)) return new SandboxError('not_found', `${what}There's no machine named ${context.name ?? 'that'}.`, { cause: error })
    if (error.status === 409 && /is not running|is paused|is restarting/i.test(message)) return new SandboxError('not_running', `${what}The machine isn't running. Start it first.`, { cause: error })
    if (error.status === 409 && /already in use/i.test(message)) return new SandboxError('already_exists', `${what}A container with that name already exists.`, { cause: error })
    if (/port is already allocated|address already in use/i.test(message)) return new SandboxError('docker_port_in_use', `${what}A host port it asked for is taken: ${message}`, { cause: error })
    if (/error gathering device information|\/dev\/net\/tun/i.test(message)) {
      return new SandboxError('docker_tun_missing', `${what}Docker's host has no ${TUN_DEVICE}, which commandSandbox needs. Load the tun module on the Docker host (modprobe tun), or create the machine without commandSandbox.`, { cause: error })
    }
    if (/cannot overwrite/i.test(message)) return new SandboxError('invalid_options', `${what}${message}.`, { cause: error })
    if (error.status === 400 || /range of cpus|minimum memory limit|invalid/i.test(message)) return new SandboxError('invalid_options', `${what}Docker refused the options: ${message}`, { cause: error })
    if (/network .* not found|no such network/i.test(message)) return new SandboxError('invalid_options', `${what}${message}. Create the network first, or leave out providerOptions.network.`, { cause: error })
    return new SandboxError('docker_failed', `${what}Docker failed: ${message}`, { cause: error })
  }

  async check(): Promise<DockerStatus> {
    let version: VersionInfo
    let api: string
    let info: InfoResponse
    try {
      if (this.#target instanceof SandboxError) throw this.#target
      ;({ version, api } = await this.engine.negotiate())
      info = await this.#daemonInfo()
    } catch (error) {
      const code = error instanceof SandboxError ? error.code : 'docker_unreachable'
      const detail = error instanceof Error ? error.message : String(error)
      return { ok: false, detail, code, checks: [] }
    }
    const where = describeTarget(this.engine.target)
    const desktop = info.OperatingSystem === 'Docker Desktop' || /Docker Desktop/i.test(version.Platform?.Name ?? '')
    const checks: DockerCheck[] = []
    const product = desktop ? 'Docker Desktop' : (info.OperatingSystem ?? 'Docker Engine')
    checks.push({ name: 'docker', ok: true, detail: `Docker Engine ${version.Version} (${product}) at ${where}, speaking Engine API ${api}` })
    const linux = version.Os === 'linux'
    checks.push({ name: 'platform', ok: linux, detail: linux ? `${version.Os}/${version.Arch}` : `${version.Os}/${version.Arch}: the docker backend needs Linux containers` })
    const security = info.SecurityOptions ?? []
    const seccompDaemon = security.some((option) => option.startsWith('name=seccomp'))
    let profile = true
    try {
      await loadSandboxProfile()
    } catch {
      profile = false
    }
    checks.push({
      name: 'seccomp',
      ok: profile && seccompDaemon,
      detail: !profile
        ? `The command sandbox's seccomp profile is missing from the package (${SECCOMP_PROFILE_URL.pathname}). Reinstall @rwoll/blobby-sandbox.`
        : seccompDaemon
          ? 'The command sandbox\'s seccomp profile is in the package, and the daemon applies seccomp profiles.'
          : 'This daemon has no seccomp support, so commandSandbox machines can\'t get their profile.',
    })
    checks.push(this.#tunCheck(desktop))
    checks.push(apparmorCheck(security.some((option) => option.startsWith('name=apparmor')), this.#local() ? readSysctl(USERNS_SYSCTL) : null))
    let limits: { running: number; total: number } | undefined
    try {
      limits = this.limits()
      checks.push({ name: 'limits', ok: true, detail: `${limits.running} running and ${limits.total} in all (${MAX_RUNNING_ENV}, ${MAX_TOTAL_ENV})` })
    } catch (error) {
      checks.push({ name: 'limits', ok: false, detail: (error as Error).message })
    }
    const ok = linux && profile && limits !== undefined
    const detail = ok
      ? `Docker Engine ${version.Version} (${product}, ${version.Os}/${version.Arch}, Engine API ${api})`
      : checks
          .filter((check) => !check.ok && check.name !== 'apparmor' && check.name !== 'tun' && check.name !== 'seccomp')
          .map((check) => check.detail)
          .concat(profile ? [] : [checks.find((check) => check.name === 'seccomp')!.detail])
          .join(' ')
    return { ok, detail, ...(ok ? {} : { code: !linux ? 'docker_platform' : !profile ? 'docker_seccomp_missing' : 'invalid_options' }), checks }
  }

  /** Whether the daemon runs on this Linux host, so its devices and settings can be read here. */
  #local(): boolean {
    return this.engine.target.kind === 'unix' && process.platform === 'linux' && !existsSync('/.dockerenv')
  }

  #tunCheck(desktop: boolean): DockerCheck {
    if (desktop) return { name: 'tun', ok: true, detail: `Docker Desktop's VM has ${TUN_DEVICE}.` }
    if (!this.#local()) return { name: 'tun', ok: true, detail: `Not checked from here: commandSandbox machines fail with docker_tun_missing if the Docker host has no ${TUN_DEVICE}.` }
    return existsSync(TUN_DEVICE)
      ? { name: 'tun', ok: true, detail: `${TUN_DEVICE} is present.` }
      : { name: 'tun', ok: false, detail: `${TUN_DEVICE} is missing, so commandSandbox fails. Load the tun module: sudo modprobe tun.` }
  }

  async #containers(filters: Record<string, string[]> = {}): Promise<ContainerSummary[]> {
    const owner = await this.#ownLabels()
    const query = { all: true, filters: JSON.stringify({ ...filters, label: [...labelFilters(owner), ...(filters.label ?? [])] }) }
    return this.#call(() => this.engine.json<ContainerSummary[]>('GET', '/containers/json', { query }))
  }

  async #find(name: string): Promise<ContainerSummary | undefined> {
    const found = await this.#containers({ name: [`^/${escapeRegex(name)}$`] })
    return found.find((container) => container.Names?.includes(`/${name}`))
  }

  async #require(name: string): Promise<ContainerSummary> {
    const container = await this.#find(checkName(name))
    if (!container) throw new SandboxError('not_found', `There's no machine named ${name}.`)
    return container
  }

  #machine(container: ContainerSummary): Machine {
    const labels = ownLabelsOf(container.Labels)
    const ports: PublishedPort[] = []
    for (const port of container.Ports ?? []) {
      if (port.IP !== '127.0.0.1' || !port.PublicPort || (port.Type ?? 'tcp') !== 'tcp') continue
      if (!ports.some((seen) => seen.guest === port.PrivatePort)) ports.push({ guest: port.PrivatePort, host: port.PublicPort, hostIp: '127.0.0.1' })
    }
    ports.sort((a, b) => a.guest - b.guest)
    const name = container.Names?.find((entry) => entry.startsWith('/') && !entry.slice(1).includes('/'))?.slice(1) ?? container.Id.slice(0, 12)
    return {
      name,
      state: toState(container.State),
      ports,
      createdAt: iso(container.Created),
      labels,
      deleteAfter: deleteAfterOf(labels),
      ...(container.Image ? { image: container.Image } : {}),
    }
  }

  async list(filter: { labels?: Record<string, string> } = {}): Promise<Machine[]> {
    const wanted = checkLabels(filter.labels)
    const containers = await this.#containers({ label: labelFilters(wanted) })
    return containers
      .map((container) => this.#machine(container))
      .filter((machine) => hasLabels(machine.labels, wanted))
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
  }

  async get(name: string): Promise<Machine | null> {
    const container = await this.#find(checkName(name))
    return container ? this.#machine(container) : null
  }

  async create(options: CreateOptions<DockerProviderOptions>): Promise<Machine> {
    return this.#create(options, checkImage(options.image), 'image')
  }

  async createFrom(snapshot: string, options: Omit<CreateOptions<DockerProviderOptions>, 'image'>): Promise<Machine> {
    const image = await this.#ownedSnapshot(snapshot)
    if (!image) throw new SandboxError('not_found', `There's no snapshot ${snapshot}. See snapshots().`)
    return this.#create({ ...options, image: snapshot }, snapshot, 'snapshot')
  }

  async #create(options: CreateOptions<DockerProviderOptions>, image: string, from: 'image' | 'snapshot'): Promise<Machine> {
    const name = checkName(options.name)
    const body = await this.#containerBody(options, image)
    const existing = await this.#find(name)
    if (existing) return this.#repeat(existing, options)
    await this.#checkLimits({ adding: true, starting: true })
    if (from === 'image') await this.#ensureImage(image)
    let id: string
    try {
      id = (await this.engine.json<{ Id: string }>('POST', '/containers/create', { query: { name }, body })).Id
    } catch (error) {
      if (error instanceof DockerApiError && error.status === 409) {
        const raced = await this.#find(name)
        if (raced) return this.#repeat(raced, options)
        throw new SandboxError('already_exists', `A container named ${name} already exists, and it isn't one of this owner's machines. Pick another name.`, { cause: error })
      }
      throw this.#error(error, { name })
    }
    try {
      await this.#call(() => this.engine.send('POST', `/containers/${id}/start`), { name })
    } catch (error) {
      await this.engine.send('DELETE', `/containers/${id}`, { query: { force: true, v: true } }).catch(() => {})
      throw error
    }
    return this.#machine(await this.#require(name))
  }

  /** A create for a name that exists: the same machine when the idempotency key matches, else `already_exists`. */
  async #repeat(existing: ContainerSummary, options: CreateOptions<DockerProviderOptions>): Promise<Machine> {
    const key = options.idempotencyKey
    if (key === undefined || (existing.Labels ?? {})[IDEMPOTENCY_LABEL] !== key) {
      throw new SandboxError('already_exists', `There's already a machine named ${options.name}. Remove it first, or pick another name.`)
    }
    // A create that stopped between making the container and starting it finishes now.
    if (existing.State === 'created') {
      await this.#checkLimits({ adding: false, starting: true })
      await this.#call(() => this.engine.send('POST', `/containers/${existing.Id}/start`), { name: options.name })
      return this.#machine(await this.#require(options.name))
    }
    return this.#machine(existing)
  }

  async #checkLimits(change: { adding: boolean; starting: boolean }): Promise<void> {
    const limits = this.limits()
    const containers = await this.#containers()
    const running = containers.filter((container) => container.State === 'running' || container.State === 'restarting' || container.State === 'paused').length
    const how = '`blobby-sandbox list` shows them, and `blobby-sandbox stop <name>` or `blobby-sandbox rm <name>` frees one.'
    if (change.adding && containers.length >= limits.total) {
      throw new SandboxError('limit_reached', `This owner already has ${containers.length} Docker machines, and the limit is ${limits.total}. Remove one first: ${how} Or raise the limit with ${MAX_TOTAL_ENV}.`)
    }
    if (change.starting && running >= limits.running) {
      throw new SandboxError('limit_reached', `This owner already runs ${running} Docker machines, and the limit is ${limits.running}. Stop or remove one first: ${how} Or raise the limit with ${MAX_RUNNING_ENV}.`)
    }
  }

  /** The container's configuration: everything about its security, network, and resources is decided here. */
  async #containerBody(options: CreateOptions<DockerProviderOptions>, image: string): Promise<Record<string, unknown>> {
    const provider = options.providerOptions ?? {}
    if (typeof provider !== 'object' || provider === null || Array.isArray(provider)) throw invalid('providerOptions must be an object.')
    const known = new Set(['network', 'apparmor', 'command', 'shmSizeMb'])
    for (const key of Object.keys(provider)) if (!known.has(key)) throw invalid(`providerOptions.${key} isn't a docker option. It takes ${[...known].join(', ')}.`)
    // Capabilities, labels, and the network policy, which fails closed on anything Docker can't enforce.
    const checked = checkCreate(this.name, this.capabilities(), options, await this.#ownLabels())

    let networkMode = 'bridge'
    if (checked.network === 'none') {
      if (provider.network !== undefined) throw invalid('providerOptions.network attaches the machine to a network, so it needs the internet network policy, not none.')
      networkMode = 'none'
    } else if (provider.network !== undefined) {
      if (typeof provider.network !== 'string' || !NETWORK.test(provider.network) || RESERVED_NETWORKS.has(provider.network)) {
        throw invalid(`providerOptions.network must name a Docker network, other than ${[...RESERVED_NETWORKS].join(', ')}.`)
      }
      networkMode = provider.network
    }

    // Ports, on loopback only, and none on a named network, where clients use the machine's address.
    const exposed: Record<string, object> = {}
    const bindings: Record<string, { HostIp: string; HostPort: string }[]> = {}
    const guests = new Set<number>()
    for (const port of options.ports ?? []) {
      positiveInteger(port?.guest, 'A guest port', 65535)
      if (port.host !== undefined && port.host !== 0) positiveInteger(port.host, 'A host port', 65535)
      if (guests.has(port.guest)) throw invalid(`Guest port ${port.guest} is listed twice.`)
      guests.add(port.guest)
      if (networkMode === 'none') throw invalid('A machine without a network can\'t publish ports. Leave out ports, or use the internet network policy.')
      if (networkMode !== 'bridge') continue
      exposed[`${port.guest}/tcp`] = {}
      bindings[`${port.guest}/tcp`] = [{ HostIp: '127.0.0.1', HostPort: port.host ? String(port.host) : '' }]
    }

    // Security: never privileged, no added capabilities, no host mounts.
    const security: string[] = []
    if (!options.root) security.push('no-new-privileges:true')
    const devices: { PathOnHost: string; PathInContainer: string; CgroupPermissions: string }[] = []
    if (provider.apparmor !== undefined && provider.apparmor !== 'unconfined') throw invalid('providerOptions.apparmor can only be \'unconfined\'.')
    if (options.commandSandbox) {
      const info = await this.#daemonInfo()
      const apparmor = (info.SecurityOptions ?? []).some((option) => option.startsWith('name=apparmor'))
      if (apparmor && provider.apparmor !== 'unconfined') {
        throw new SandboxError(
          'docker_apparmor',
          'This Docker daemon applies AppArmor\'s docker-default profile, which blocks the command sandbox (bubblewrap can\'t mount in its namespaces). To run it anyway on this Linux host, pass providerOptions: { apparmor: \'unconfined\' }, which runs the machine without AppArmor; on Ubuntu 23.10 and later the host also needs kernel.apparmor_restrict_unprivileged_userns=0 (see doctor). Or create it without commandSandbox.',
        )
      }
      security.push(`seccomp=${await loadSandboxProfile()}`)
      devices.push({ PathOnHost: TUN_DEVICE, PathInContainer: TUN_DEVICE, CgroupPermissions: 'rwm' })
    }
    if (provider.apparmor === 'unconfined') security.push('apparmor=unconfined')

    const resources: Record<string, number> = {}
    const { cpus, memoryMb } = options.resources ?? {}
    if (cpus !== undefined) {
      if (typeof cpus !== 'number' || !Number.isFinite(cpus) || cpus <= 0 || cpus > 1024) throw invalid('resources.cpus must be a number above 0.')
      // Docker refuses more CPUs than it has, so a machine gets at most all of them, as on a small Docker Desktop.
      const available = (await this.#daemonInfo()).NCPU
      resources.NanoCpus = Math.round(Math.min(cpus, available && available > 0 ? available : cpus) * 1e9)
    }
    if (memoryMb !== undefined) {
      positiveInteger(memoryMb, 'resources.memoryMb', 1024 * 1024)
      if (memoryMb < 64) throw invalid('resources.memoryMb must be at least 64.')
      resources.Memory = memoryMb * 1024 * 1024
      resources.MemorySwap = resources.Memory
    }
    const shm = provider.shmSizeMb ?? DEFAULT_SHM_MB
    positiveInteger(shm, 'providerOptions.shmSizeMb', 64 * 1024)

    const command = provider.command ?? 'sleep'
    if (command !== 'sleep' && command !== 'image') throw invalid('providerOptions.command must be sleep or image.')

    const labels = checked.labels
    const keys = Object.keys(labels).sort()
    // Blank what a snapshot's image may carry over from the machine it was taken from.
    const inherited = { [DELETE_AFTER_LABEL]: '', [IDEMPOTENCY_LABEL]: '', [SNAPSHOT_SOURCE_LABEL]: '' }

    return {
      Image: image,
      Hostname: options.name.slice(0, 63),
      Labels: { ...inherited, ...labels, [LABEL_KEYS_LABEL]: keys.join(',') },
      ...(command === 'sleep' ? { Entrypoint: ['sleep', 'infinity'], Cmd: [] } : {}),
      ExposedPorts: exposed,
      HostConfig: {
        Init: true,
        Privileged: false,
        CapAdd: null,
        Binds: null,
        Mounts: null,
        Devices: devices,
        SecurityOpt: security,
        NetworkMode: networkMode,
        PortBindings: bindings,
        PublishAllPorts: false,
        ShmSize: shm * 1024 * 1024,
        RestartPolicy: { Name: 'no' },
        ...resources,
      },
    }
  }

  /** Pulls `image` unless Docker has it, reporting progress to `onPull`. */
  async pull(image: string, options: { onProgress?: (progress: PullProgress) => void; signal?: AbortSignal } = {}): Promise<void> {
    checkImage(image)
    const at = image.indexOf('@')
    const name = at === -1 ? image : image.slice(0, at)
    const hasTag = /:[\w][\w.-]*$/.test(name.slice(name.lastIndexOf('/') + 1))
    // A digest wins over a tag; without either, pull latest, never every tag.
    const query = at !== -1 ? { fromImage: `${name.replace(/:[\w][\w.-]*$/, '')}${image.slice(at)}` } : hasTag ? { fromImage: image } : { fromImage: image, tag: 'latest' }
    const response = await this.#call(() => this.engine.call('POST', '/images/create', { query, timeoutMs: 0, signal: options.signal }))
    for await (const event of jsonLines(response)) {
      if (event.error || event.errorDetail) {
        const message = String(event.error ?? (event.errorDetail as { message?: string } | undefined)?.message ?? 'unknown error')
        throw new SandboxError('docker_pull_failed', `Docker couldn't pull ${image}: ${message}. The docker backend never reads Docker's credentials: pull private images yourself first (docker pull ${image}).`)
      }
      const detail = (event.progressDetail ?? {}) as { current?: number; total?: number }
      options.onProgress?.({
        image,
        status: String(event.status ?? ''),
        ...(typeof event.id === 'string' ? { layer: event.id } : {}),
        ...(typeof detail.current === 'number' ? { current: detail.current } : {}),
        ...(typeof detail.total === 'number' ? { total: detail.total } : {}),
      })
    }
  }

  async #inspectImage(image: string): Promise<ImageInspect | null> {
    try {
      return await this.#call(() => this.engine.json<ImageInspect>('GET', `/images/${image}/json`))
    } catch (error) {
      if (error instanceof SandboxError && error.cause instanceof DockerApiError && error.cause.status === 404) return null
      throw error
    }
  }

  async #ensureImage(image: string): Promise<void> {
    if (await this.#inspectImage(image)) return
    if (image.startsWith('sha256:')) throw new SandboxError('not_found', `Docker has no image ${image}, and an image ID can't be pulled.`)
    await this.pull(image, { onProgress: this.#options.onPull })
    if (!(await this.#inspectImage(image))) throw new SandboxError('docker_pull_failed', `Docker pulled ${image}, but doesn't list it afterwards.`)
  }

  async start(name: string): Promise<Machine> {
    const container = await this.#require(name)
    if (container.State !== 'running') {
      await this.#checkLimits({ adding: false, starting: true })
      await this.#call(() => this.engine.send('POST', `/containers/${container.Id}/start`), { name })
    }
    return this.#machine(await this.#require(name))
  }

  async stop(name: string): Promise<void> {
    const container = await this.#require(name)
    if (STOPPED.has(container.State ?? '')) return
    await this.#call(() => this.engine.send('POST', `/containers/${container.Id}/stop`, { query: { t: STOP_SECONDS }, timeoutMs: (STOP_SECONDS + 60) * 1000 }), { name })
    await this.#settle(name, (state) => STOPPED.has(state))
  }

  /**
   * The container once Docker's list agrees with what a stop just did. The daemon answers a stop when the
   * container has exited, but updates the copy that lists read from a moment later, so a list right after
   * can still say `running`. A start updates it before it answers.
   */
  async #settle(name: string, settled: (state: string) => boolean): Promise<ContainerSummary> {
    const deadline = Date.now() + SETTLE_MS
    for (;;) {
      const container = await this.#require(name)
      if (settled(container.State ?? '') || Date.now() >= deadline) return container
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  async remove(name: string): Promise<void> {
    const container = await this.#find(checkName(name))
    if (!container) return
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.engine.send('DELETE', `/containers/${container.Id}`, { query: { force: true, v: true }, timeoutMs: 120_000 })
        return
      } catch (error) {
        if (error instanceof DockerApiError && error.status === 404) return
        // Another remove is under way; wait for it.
        if (error instanceof DockerApiError && error.status === 409 && /in progress/i.test(error.message) && attempt < 40) {
          await new Promise((resolve) => setTimeout(resolve, 250))
          continue
        }
        throw this.#error(error, { name })
      }
    }
  }

  async exec(name: string, command: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    if (!Array.isArray(command) || !command.length || command.some((part) => typeof part !== 'string' || part.includes('\0'))) {
      throw invalid('A command is a non-empty list of strings without NUL characters.')
    }
    const user = checkUser(options.user)
    const env = checkEnv(options.env)
    const timeout = options.timeoutSeconds
    if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0 || timeout > 7 * 24 * 3600)) {
      throw invalid('timeoutSeconds must be a number of seconds above 0.')
    }
    if (options.signal?.aborted) throw new SandboxError('cancelled', 'The command was cancelled before it started.')
    const stdin = options.stdin === undefined ? undefined : typeof options.stdin === 'string' ? Buffer.from(options.stdin, 'utf8') : Buffer.from(options.stdin)
    const container = await this.#require(name)
    if (container.State !== 'running') throw new SandboxError('not_running', `${name} isn't running. Start it first.`)

    const marker = randomBytes(12).toString('hex')
    // `timeout` runs inside the machine, so the limit holds even if this process goes away.
    const argv = timeout === undefined ? [...command] : ['timeout', '-k', '5', String(timeout), ...command]
    const created = await this.#call(
      () =>
        this.engine.json<{ Id: string }>('POST', `/containers/${container.Id}/exec`, {
          body: { Cmd: argv, User: user ?? '', Env: [...env, `${EXEC_ID_ENV}=${marker}`], AttachStdin: stdin !== undefined, AttachStdout: true, AttachStderr: true, Tty: false },
        }),
      { name },
    )
    const socket = await this.#call(() => this.engine.hijack(`/exec/${created.Id}/start`, { Detach: false, Tty: false }), { name })

    const output = { stdout: '', stderr: '' }
    const decoders = { stdout: new TextDecoder('utf-8'), stderr: new TextDecoder('utf-8') }
    const emit = (stream: 'stdout' | 'stderr', text: string) => {
      if (!text) return
      output[stream] += text
      options.onOutput?.({ stream, text })
    }
    const demuxer = new Demuxer((stream, data) => emit(stream, decoders[stream].decode(data, { stream: true })))

    const finished = new Promise<void>((resolve, reject) => {
      socket.on('data', (chunk: Buffer) => demuxer.push(chunk))
      socket.once('end', resolve)
      socket.once('close', resolve)
      socket.once('error', reject)
    })
    let kill: (reason: SandboxError) => void = () => {}
    const stopped = new Promise<never>((_, reject) => {
      kill = (reason) => {
        socket.destroy()
        reject(reason)
      }
    })
    const cancel = () => kill(new SandboxError('cancelled', 'The command was cancelled.'))
    options.signal?.addEventListener('abort', cancel, { once: true })
    // A backstop in case the machine's `timeout` can't run, such as in an image without coreutils.
    const backstop = timeout === undefined ? undefined : setTimeout(() => kill(new SandboxError('timeout', `The command in ${name} ran past its ${timeout}-second limit, and the machine didn't stop it.`)), (timeout + 30) * 1000)
    if (stdin !== undefined) {
      socket.on('error', () => {})
      socket.end(stdin)
    }
    try {
      await Promise.race([finished, stopped])
    } catch (error) {
      if (error instanceof SandboxError) {
        await this.#killExec(container.Id, user, marker)
        throw error
      }
      throw new SandboxError('docker_exec', `The command's output from ${name} broke off: ${(error as Error).message}`, { cause: error })
    } finally {
      options.signal?.removeEventListener('abort', cancel)
      clearTimeout(backstop)
    }
    emit('stdout', decoders.stdout.decode())
    emit('stderr', decoders.stderr.decode())

    for (let attempt = 0; ; attempt += 1) {
      const state = await this.#call(() => this.engine.json<{ Running: boolean; ExitCode: number | null }>('GET', `/exec/${created.Id}/json`), { name })
      if (!state.Running && state.ExitCode !== null) return { exitCode: state.ExitCode, stdout: output.stdout, stderr: output.stderr }
      if (attempt >= 100) throw new SandboxError('docker_exec', `Docker didn't report how the command in ${name} ended.`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  /** Kills a cancelled command and everything it started, in the background inside the machine. */
  async #killExec(containerId: string, user: string | undefined, marker: string): Promise<void> {
    try {
      const created = await this.engine.json<{ Id: string }>('POST', `/containers/${containerId}/exec`, {
        body: { Cmd: ['sh', '-c', KILL_SCRIPT, 'sh', marker, EXEC_ID_ENV], User: user ?? '', AttachStdout: false, AttachStderr: false, Tty: false },
      })
      await this.engine.send('POST', `/exec/${created.Id}/start`, { body: { Detach: true, Tty: false } })
    } catch {
      // The machine may have stopped, which ends the command too.
    }
  }

  async #pathStat(containerId: string, path: string): Promise<PathStat | null> {
    const { prefix } = await this.engine.negotiate()
    const response = await this.#call(() => this.engine.raw('HEAD', `${prefix}/containers/${containerId}/archive?${new URLSearchParams({ path })}`))
    response.resume()
    if (response.statusCode === 404) return null
    if ((response.statusCode ?? 500) >= 400) throw new SandboxError('docker_failed', `Docker couldn't look at ${path}: HTTP ${response.statusCode}.`)
    const stat = parseStat(response.headers['x-docker-container-path-stat'])
    if (!stat) throw new SandboxError('docker_failed', `Docker didn't say what ${path} is.`)
    return stat
  }

  /** Follows symbolic links to what they point at, as Docker resolves them inside the machine. */
  async #resolve(containerId: string, path: string): Promise<{ path: string; stat: PathStat } | null> {
    let current = path
    for (let hop = 0; hop < 16; hop += 1) {
      const stat = await this.#pathStat(containerId, current)
      if (!stat) return null
      if (!stat.linkTarget || !unixMode(stat.mode).symlink) return { path: current, stat }
      current = posix.resolve(posix.dirname(current), stat.linkTarget)
    }
    throw invalid(`${path} is a chain of too many symbolic links.`)
  }

  async stat(name: string, path: string): Promise<FileInfo | null> {
    const target = checkPath(path)
    const container = await this.#require(name)
    const resolved = await this.#resolve(container.Id, target)
    if (!resolved) return null
    return { size: resolved.stat.size, mode: unixMode(resolved.stat.mode).mode }
  }

  async readFile(name: string, path: string, range: ReadRange = {}): Promise<Readable> {
    const target = checkPath(path)
    const offset = range.offset ?? 0
    if (!Number.isSafeInteger(offset) || offset < 0) throw invalid('range.offset must be a whole number of bytes, 0 or more.')
    if (range.length !== undefined && (!Number.isSafeInteger(range.length) || range.length < 0)) throw invalid('range.length must be a whole number of bytes, 0 or more.')
    const container = await this.#require(name)
    const resolved = await this.#resolve(container.Id, target)
    if (!resolved) throw new SandboxError('not_found', `${name} has no file ${target}.`)
    if (unixMode(resolved.stat.mode).directory) throw invalid(`${target} in ${name} is a folder, not a file.`)
    const response = await this.#call(() => this.engine.call('GET', `/containers/${container.Id}/archive`, { query: { path: resolved.path }, timeoutMs: 120_000 }), { name })
    const file = extractFirstFile(response, { offset, ...(range.length !== undefined ? { length: range.length } : {}) })
    async function* checked(): AsyncGenerator<Buffer> {
      try {
        for await (const chunk of file) yield chunk as Buffer
      } catch (error) {
        if (error instanceof TarFormatError) throw new SandboxError('docker_archive', `Docker sent ${target} from ${name} in a form this backend doesn't read: ${error.message}`, { cause: error })
        throw error
      } finally {
        file.destroy()
        response.destroy()
      }
    }
    return Readable.from(checked(), { objectMode: false })
  }

  async writeFile(name: string, path: string, data: Uint8Array | Readable, options: WriteOptions = {}): Promise<void> {
    const target = checkPath(path)
    if (target === '/') throw invalid('Can\'t write a file at /.')
    const mode = options.mode ?? 0o644
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw invalid('mode must be a file mode from 0 to 0o7777.')
    const user = checkUser(options.user)
    const container = await this.#require(name)
    const owner = user === undefined || user === 'root' || user === '0' ? { uid: 0, gid: 0 } : await this.#owner(container.Id, name, user)

    // Folders that don't exist yet are made, owned like the file; existing ones are left as they are.
    const missing: string[] = []
    let base = posix.dirname(target)
    for (;;) {
      const stat = await this.#pathStat(container.Id, base)
      if (stat) {
        const kind = unixMode(stat.mode)
        if (!kind.directory && !kind.symlink) throw invalid(`${base} in ${name} is a file, so ${target} can't be written under it.`)
        break
      }
      missing.unshift(base)
      base = posix.dirname(base)
    }
    const mtime = Math.floor(Date.now() / 1000)
    const relative = (path: string) => posix.relative(base, path)
    const body = await sized(data)
    try {
      const entries: TarEntry[] = [
        ...missing.map((dir): TarEntry => ({ name: relative(dir), type: 'directory', mode: 0o755, ...owner, size: 0, mtime })),
        { name: relative(target), type: 'file', mode, ...owner, size: body.size, mtime },
      ]
      const archive = packEntries(entries, () => body.chunks())
      await this.#call(
        () =>
          this.engine.send('PUT', `/containers/${container.Id}/archive`, {
            query: { path: base, noOverwriteDirNonDir: true },
            body: archive,
            contentType: 'application/x-tar',
            contentLength: archiveSize(entries),
            timeoutMs: 0,
          }),
        { name },
      )
    } finally {
      await body.cleanup()
    }
  }

  async #owner(containerId: string, name: string, user: string): Promise<{ uid: number; gid: number }> {
    const read = async (path: string) => {
      const response = await this.engine.call('GET', `/containers/${containerId}/archive`, { query: { path } }).catch(() => null)
      if (!response) return ''
      const chunks: Buffer[] = []
      for await (const chunk of extractFirstFile(response)) chunks.push(chunk as Buffer)
      return Buffer.concat(chunks).toString('utf8')
    }
    const owner = resolveOwner(user, await read('/etc/passwd'), user.includes(':') ? await read('/etc/group') : '')
    if (!owner) throw invalid(`${name} has no user or group ${user}.`)
    return owner
  }

  async endpoint(name: string, guestPort: number): Promise<Endpoint> {
    positiveInteger(guestPort, 'The guest port', 65535)
    const container = await this.#require(name)
    if (container.State !== 'running') throw new SandboxError('not_running', `${name} isn't running. Start it first.`)
    const mode = container.HostConfig?.NetworkMode ?? 'bridge'
    if (mode !== 'bridge' && mode !== 'default' && mode !== 'none' && !mode.startsWith('container:')) {
      const address = container.NetworkSettings?.Networks?.[mode]?.IPAddress
      if (!address) throw new SandboxError('not_published', `${name} has no address on the ${mode} network yet.`)
      return { kind: 'tcp', host: address, port: guestPort }
    }
    const port = this.#machine(container).ports.find((entry) => entry.guest === guestPort)
    if (!port) throw new SandboxError('not_published', `${name} doesn't publish port ${guestPort}. Docker publishes ports only when a machine is created: create it with that port.`)
    return { kind: 'tcp', host: port.hostIp, port: port.host }
  }

  async snapshot(source: string, options: SnapshotOptions = {}): Promise<Snapshot> {
    const labels = checkLabels(options.labels)
    const container = await this.#require(source)
    const owner = await this.#ownLabels()
    const base = container.ImageID ? await this.#inspectImage(container.ImageID) : null
    const tag = `${source}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`.slice(0, 128)
    const own = { ...labels, ...owner }
    // Committing pauses the machine for the moment it takes. The image keeps its base image's command,
    // not the one the machine ran, and none of the machine's own deadlines or keys.
    const config: Record<string, unknown> = {
      Labels: { [DELETE_AFTER_LABEL]: '', [IDEMPOTENCY_LABEL]: '', ...own, [SNAPSHOT_SOURCE_LABEL]: source, [LABEL_KEYS_LABEL]: Object.keys(own).sort().join(',') },
    }
    if (base?.Config) {
      config.Entrypoint = base.Config.Entrypoint ?? []
      config.Cmd = base.Config.Cmd ?? []
    }
    await this.#call(
      () => this.engine.json('POST', '/commit', { query: { container: container.Id, repo: SNAPSHOT_REPOSITORY, tag, pause: true, comment: `Snapshot of ${source}` }, body: config, timeoutMs: 0 }),
      { name: source },
    )
    const id = `${SNAPSHOT_REPOSITORY}:${tag}`
    const image = await this.#inspectImage(id)
    const created = image?.Created ? new Date(image.Created) : new Date()
    return { id, source, createdAt: Number.isNaN(created.getTime()) ? null : created.toISOString(), labels: own }
  }

  async snapshots(filter: { labels?: Record<string, string> } = {}): Promise<Snapshot[]> {
    const wanted = checkLabels(filter.labels)
    const owner = await this.#ownLabels()
    const query = { filters: JSON.stringify({ label: [...labelFilters(owner), SNAPSHOT_SOURCE_LABEL], reference: [`${SNAPSHOT_REPOSITORY}:*`] }) }
    const images = await this.#call(() => this.engine.json<ImageSummary[]>('GET', '/images/json', { query }))
    const snapshots: Snapshot[] = []
    for (const image of images) {
      const labels = ownLabelsOf(image.Labels)
      if (!hasLabels(labels, owner) || !hasLabels(labels, wanted)) continue
      for (const tag of image.RepoTags ?? []) {
        if (!tag.startsWith(`${SNAPSHOT_REPOSITORY}:`)) continue
        snapshots.push({ id: tag, source: image.Labels?.[SNAPSHOT_SOURCE_LABEL] || null, createdAt: iso(image.Created), labels })
      }
    }
    return snapshots.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id))
  }

  /** The snapshot's image, when it is one of this owner's. */
  async #ownedSnapshot(id: string): Promise<ImageInspect | null> {
    if (typeof id !== 'string' || !id.startsWith(`${SNAPSHOT_REPOSITORY}:`)) throw invalid(`"${String(id)}" isn't a snapshot ID; they look like ${SNAPSHOT_REPOSITORY}:<tag>.`)
    checkImage(id)
    const image = await this.#inspectImage(id)
    if (!image) return null
    const labels = image.Config?.Labels ?? {}
    return hasLabels(labels, await this.#ownLabels()) && labels[SNAPSHOT_SOURCE_LABEL] ? image : null
  }

  async removeSnapshot(id: string): Promise<void> {
    const image = await this.#ownedSnapshot(id)
    if (!image) return
    const users = await this.#call(() => this.engine.json<ContainerSummary[]>('GET', '/containers/json', { query: { all: true, filters: JSON.stringify({ ancestor: [id] }) } }))
    if (users.length) {
      const mine = users.map((container) => this.#machine(container).name)
      throw new SandboxError('in_use', `Snapshot ${id} is in use by ${mine.length === 1 ? 'a machine' : `${mine.length} machines`}: ${mine.join(', ')}. Remove them first.`)
    }
    try {
      await this.engine.send('DELETE', `/images/${id}`)
    } catch (error) {
      if (error instanceof DockerApiError && error.status === 404) return
      if (error instanceof DockerApiError && error.status === 409) throw new SandboxError('in_use', `Snapshot ${id} is in use: ${error.message}`, { cause: error })
      throw this.#error(error)
    }
  }
}
