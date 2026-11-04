import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { setTimeout as delay } from 'node:timers/promises'
import {
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
  type NetworkPolicy,
  type ReadRange,
  type Snapshot,
  type SnapshotOptions,
  type WriteOptions,
} from '../backend.ts'
import { checkCreate, checkLabels, collectStream, deleteAfterOf, EXEC_ID_ENV, hasLabels, KILL_SCRIPT } from '../contract.ts'
import { checkGuestEnv } from '../guest-env.ts'
import { ownerLabels } from '../labels.ts'
import { configDir, displayPath } from '../paths.ts'

// Runs each machine as an Azure Container Apps sandbox, a microVM in a sandbox group, through
// `@azure/containerapps-sandbox`, the official SDK. Sandboxes have no names, so a machine's name is a
// label. The data plane has no SSH and no streaming exec: commands run through buffered exec calls, and
// long or streaming ones run in the background and are polled. It signs in with the Azure CLI.

/** The version of `@azure/containerapps-sandbox`, an optional peer dependency, that this backend is tested with. */
export const AZURE_SDK_VERSION = '1.0.0-beta.1'
/** The label that holds a machine's name. */
export const NAME_LABEL = 'blobby.dev/name'
/** The label that holds the name of the machine a snapshot was taken from. */
export const SNAPSHOT_OF_LABEL = 'blobby.dev/snapshot-of'
/** The scope of the sandbox data plane's tokens. */
export const DATA_PLANE_SCOPE = 'https://dynamicsessions.io/.default'
/** Where the backend reads which sandbox group to use: `azure.json` in the config folder. */
export const AZURE_CONFIG_FILE = 'azure.json'

const PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
/** The variables Azure's egress proxy sets so programs trust its certificate. Commands keep them; nothing else from the guest's environment. */
const CA_VARIABLES = ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE'] as const
/** Memory-only, so stdin, which may be a secret, never touches the machine's disk. */
const EXEC_DIR = '/run/blobby-exec'
/** The longest a single buffered exec call is trusted to wait. Longer and streaming commands run in the background. */
const DIRECT_LIMIT_SECONDS = 240
const POLL_MS = 1000
const CHUNK_BYTES = 1024 * 1024
/** How long past its own limit a background command may run before this process stops it. */
const DEADLINE_GRACE_SECONDS = 60
/** Sandboxes don't suspend themselves after a short idle time, as they do by default; deleteAfter and reapers bound what they cost. */
const NO_AUTO_SUSPEND = { enabled: false } as const
const MIN_AUTO_DELETE_SECONDS = 3600

/**
 * What Azure sandboxes can do. Ports reach a sandbox only through HTTP ingress, so there is no viewer
 * yet. The egress proxy denies by default and allows hosts, but names always resolve through the
 * platform's DNS, so deny-all is `essential`, not `none`. Reads stream; writes go whole. Snapshots keep
 * labels, and sandboxes start from them in seconds.
 */
const CAPABILITIES: Readonly<Capabilities> = Object.freeze({
  branch: false,
  publish: false,
  ports: false,
  gpu: false,
  networkPolicies: ['essential', 'internet', 'allow'],
  commandSandbox: false,
  streamingFiles: false,
  labels: true,
  stdin: true,
  snapshot: true,
} satisfies Capabilities)

/** Which sandbox group to use. It names Azure resources, so it lives only in the config folder, never in code. */
export interface AzureConfig {
  subscription: string
  resourceGroup: string
  sandboxGroup: string
  /** The sandbox group's region, such as `westus2`. */
  location: string
}

/** Reads `azure.json` from the config folder. Fails with `azure_not_configured`, saying how to set it up. */
export async function loadAzureConfig(env: NodeJS.ProcessEnv = process.env): Promise<AzureConfig> {
  const file = join(configDir(env), AZURE_CONFIG_FILE)
  const setup = `Deploy infra/azure/main.bicep, then save its outputs in ${displayPath(file)} as {"subscription", "resourceGroup", "sandboxGroup", "location"}. See infra/azure/README.md.`
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new SandboxError('azure_not_configured', `The azure backend has no sandbox group yet. ${setup}`)
    throw error
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new SandboxError('azure_not_configured', `${displayPath(file)} is not valid JSON. ${setup}`)
  }
  const missing = (['subscription', 'resourceGroup', 'sandboxGroup', 'location'] as const).filter((key) => typeof parsed[key] !== 'string' || !parsed[key])
  if (missing.length) throw new SandboxError('azure_not_configured', `${displayPath(file)} has no ${missing.join(', ')}. ${setup}`)
  return { subscription: parsed.subscription as string, resourceGroup: parsed.resourceGroup as string, sandboxGroup: parsed.sandboxGroup as string, location: parsed.location as string }
}

/** Removes subscription IDs from text the service or the Azure CLI wrote, so messages never carry them. */
export function redact(text: string, config?: Pick<AzureConfig, 'subscription'>): string {
  let out = text.replace(/\/subscriptions\/[^/\s'"?]+/gi, '/subscriptions/<subscription>')
  if (config?.subscription) out = out.split(config.subscription).join('<subscription>')
  return out
}

/** Runs a program and gives its output. Tests pass a fake. */
export type Runner = (file: string, args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>

const runProgram: Runner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 60_000 }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') return reject(error)
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
      resolve({ code, stdout, stderr })
    })
  })

/** An access token, as `@azure/core-auth`'s `TokenCredential` gives one. */
export interface AccessToken {
  token: string
  expiresOnTimestamp: number
}

/**
 * Gets tokens from the Azure CLI, for the configured subscription, so it picks the right account when the
 * CLI is signed in to several. Tokens are kept until two minutes before they expire. It needs no
 * `@azure/identity`.
 */
export class AzCliCredential {
  readonly #subscription: string
  readonly #run: Runner
  readonly #tokens = new Map<string, Promise<AccessToken>>()

  constructor(subscription: string, run: Runner = runProgram) {
    this.#subscription = subscription
    this.#run = run
  }

  async getToken(scopes: string | string[]): Promise<AccessToken> {
    const scope = [scopes].flat()[0] ?? DATA_PLANE_SCOPE
    const cached = this.#tokens.get(scope)
    if (cached) {
      const token = await cached.catch(() => null)
      if (token && token.expiresOnTimestamp - Date.now() > 120_000) return token
    }
    const fresh = this.#fetch(scope)
    this.#tokens.set(scope, fresh)
    fresh.catch(() => this.#tokens.delete(scope))
    return fresh
  }

  async #fetch(scope: string): Promise<AccessToken> {
    let result: Awaited<ReturnType<Runner>>
    try {
      result = await this.#run('az', ['account', 'get-access-token', '--scope', scope, '--subscription', this.#subscription, '--output', 'json'])
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SandboxError('azure_cli_missing', 'The azure backend signs in with the Azure CLI, which is not installed. Install it (https://aka.ms/azure-cli), then run `az login`.')
      }
      throw error
    }
    const signIn = 'Sign in with `az login` to the account that deployed the sandbox group, or that has its SandboxGroup Data Owner role.'
    if (result.code !== 0) {
      const said = redact(result.stderr.trim().split('\n').filter(Boolean).at(-1) ?? '', { subscription: this.#subscription })
      throw new SandboxError('azure_auth', `The Azure CLI gave no token${said ? `: ${said}` : ''}. ${signIn}`)
    }
    try {
      const parsed = JSON.parse(result.stdout) as { accessToken?: string; expires_on?: number | string; expiresOn?: string }
      const expires = parsed.expires_on !== undefined ? Number(parsed.expires_on) * 1000 : Date.parse(parsed.expiresOn ?? '')
      if (!parsed.accessToken || !Number.isFinite(expires)) throw new Error('no token')
      return { token: parsed.accessToken, expiresOnTimestamp: expires }
    } catch {
      throw new SandboxError('azure_auth', `The Azure CLI's token was not in a form this backend reads. ${signIn}`)
    }
  }
}

// What the backend uses of the data plane, in its own types, so tests can fake it.

export interface AzureSandbox {
  id: string
  state?: string
  labels: Record<string, string>
  createdAt?: string
  sourcesRef?: { diskImage?: { id?: string; name?: string }; snapshot?: { id: string } }
}

export interface AzureSnapshot {
  id: string
  labels: Record<string, string>
  sandboxId?: string
  status?: string
  createdAtUtc?: string
  /** The size every sandbox made from it has, such as `{ cpu: '4', memory: '8192Mi', disk: '32768Mi' }`. */
  resources?: { cpu: string; memory: string; disk?: string }
}

export interface AzureDiskImage {
  id: string
  name?: string
  labels: Record<string, string>
  status?: { state: string; message?: string }
}

export interface AzureEgressPolicy {
  defaultAction: 'Allow' | 'Deny'
  hostRules: { pattern: string; action: 'Allow' | 'Deny' }[]
  rules: never[]
  /** `Full` puts the platform's TLS-inspecting proxy in the way, which `Deny` needs to be enforced at all. `None` connects directly. */
  trafficInspection: 'Full' | 'None'
}

export interface AzureLifecycle {
  autoSuspend: { enabled: boolean; interval?: number; mode?: 'Memory' | 'Disk' }
  autoDelete: { enabled: boolean; deleteIntervalSeconds?: number }
}

export interface AzureCreateRequest {
  sourcesRef: { diskImage: { id: string } } | { snapshot: { id: string } }
  /** Only for disk images: sandboxes from snapshots keep the snapshot's resources. */
  resources?: { cpu: string; memory: string; disk: string }
  labels: Record<string, string>
  lifecycle: AzureLifecycle
  egressPolicy: AzureEgressPolicy
}

/** The sandbox data plane. Methods fail with `SandboxError`s; a 404 from a get is null. */
export interface AzureApi {
  listSandboxes(labels: Record<string, string>): Promise<AzureSandbox[]>
  getSandbox(id: string): Promise<AzureSandbox | null>
  /** Creates a sandbox and waits until it runs. */
  createSandbox(request: AzureCreateRequest): Promise<AzureSandbox>
  /** Deletes a sandbox and waits until it is gone. */
  deleteSandbox(id: string): Promise<void>
  stopSandbox(id: string): Promise<void>
  resumeSandbox(id: string): Promise<void>
  /** Runs a shell command as root, with no stdin, and waits for it. */
  exec(id: string, command: string): Promise<{ exitCode: number; stdout: string; stderr: string }>
  /** Writes a file whole, creating its folders. */
  writeFile(id: string, path: string, data: Uint8Array, mode: number): Promise<void>
  /** Streams a file's bytes as they are. */
  readFile(id: string, path: string): Promise<Readable>
  /** Snapshots a sandbox with these labels, and waits until the snapshot is ready. */
  snapshot(id: string, labels: Record<string, string>): Promise<AzureSnapshot>
  listSnapshots(): Promise<AzureSnapshot[]>
  getSnapshot(id: string): Promise<AzureSnapshot | null>
  deleteSnapshot(id: string): Promise<void>
  listDiskImages(): Promise<AzureDiskImage[]>
  /** Builds a disk image from a container image, and waits until it is ready. */
  createDiskImage(base: string, name: string): Promise<AzureDiskImage>
}

/** The error to show when `@azure/containerapps-sandbox` is not installed, or null when `error` is about something else. */
export function missingSdk(error: unknown): SandboxError | null {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  const message = String((error as Error | undefined)?.message ?? '')
  if ((code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') || !message.includes('@azure/containerapps-sandbox')) return null
  return new SandboxError(
    'azure_sdk_missing',
    `The azure backend needs the @azure/containerapps-sandbox package, which is not installed. Install it next to @rwoll/blobby-sandbox: \`npm install -g @azure/containerapps-sandbox@${AZURE_SDK_VERSION}\` for the CLI, or \`npm install @azure/containerapps-sandbox@${AZURE_SDK_VERSION}\` in your project. Or pick another backend with --backend.`,
  )
}

/** Turns a data-plane failure into a `SandboxError`, with the service's own words and no subscription IDs. */
export function azureError(error: unknown, body: string | undefined, config: Pick<AzureConfig, 'subscription'>, what: string): SandboxError {
  if (error instanceof SandboxError) return error
  const status = Number((error as { statusCode?: unknown })?.statusCode ?? (error as { status?: unknown })?.status)
  const said = redact(describeBody(body) || String((error as Error)?.message ?? error), config)
  const message = `${what} failed${Number.isFinite(status) ? ` (HTTP ${status})` : ''}: ${said}`
  if (status === 404) return new SandboxError('not_found', message, { cause: error })
  if (status === 401 || status === 403) {
    return new SandboxError('azure_forbidden', `${message}. The signed-in account needs the SandboxGroup Data Owner role on the sandbox group; see infra/azure/README.md.`, { cause: error })
  }
  if (status === 409) return new SandboxError('in_use', message, { cause: error })
  if (status === 400) return new SandboxError('invalid_options', message, { cause: error })
  if (status === 429) return new SandboxError('limit_reached', `${message}. Wait, or remove sandboxes you no longer need.`, { cause: error })
  return new SandboxError('azure_error', message, { cause: error })
}

/** The useful part of an error body: problem+json's title, detail, and errors, or an ARM-style error message. */
function describeBody(body: string | undefined): string {
  if (!body) return ''
  try {
    const parsed = JSON.parse(body) as { title?: string; detail?: string; message?: string; error?: { message?: string }; errors?: Record<string, string[]> | string[] }
    const errors = Array.isArray(parsed.errors) ? parsed.errors : Object.entries(parsed.errors ?? {}).map(([field, messages]) => `${field}: ${[messages].flat().join(' ')}`)
    return [parsed.error?.message ?? parsed.message, parsed.title, parsed.detail, ...errors].filter(Boolean).join(' ').trim() || body.slice(0, 500)
  } catch {
    return body.slice(0, 500)
  }
}

type SdkModule = typeof import('@azure/containerapps-sandbox')
type SdkApiModule = typeof import('@azure/containerapps-sandbox/api')

/** Loads the SDK and binds it to one sandbox group. */
export async function loadAzureApi(config: AzureConfig, credential: AzCliCredential): Promise<AzureApi> {
  let sdk: SdkModule
  let rest: SdkApiModule
  try {
    sdk = await import('@azure/containerapps-sandbox')
    rest = await import('@azure/containerapps-sandbox/api')
  } catch (error) {
    throw missingSdk(error) ?? error
  }
  const endpoint = sdk.endpointForRegion(config.location)
  const client = new sdk.SandboxGroupClient(credential, endpoint, config.subscription, config.resourceGroup, config.sandboxGroup)
  const context = rest.createSandboxGroup(credential, endpoint, config.subscription, config.resourceGroup, config.sandboxGroup)
  const base = `/subscriptions/${encodeURIComponent(config.subscription)}/resourceGroups/${encodeURIComponent(config.resourceGroup)}/sandboxGroups/${encodeURIComponent(config.sandboxGroup)}`
  const query = () => ({ 'api-version': context.apiVersion })
  const poll = { updateIntervalInMs: 1000 }

  // The SDK drops error bodies, which say what was wrong with a request, so each call keeps the last one.
  async function call<T>(what: string, run: (options: { onResponse: (response: { status: number; bodyAsText?: string | null }) => void }) => Promise<T>): Promise<T> {
    let body: string | undefined
    try {
      return await run({
        onResponse: (response) => {
          if (response.status >= 400) body = response.bodyAsText ?? undefined
        },
      })
    } catch (error) {
      throw azureError(error, body, config, what)
    }
  }
  const orNull = async <T>(work: Promise<T>): Promise<T | null> => {
    try {
      return await work
    } catch (error) {
      if (error instanceof SandboxError && error.code === 'not_found') return null
      throw error
    }
  }
  const collect = async <T>(pages: AsyncIterable<T>): Promise<T[]> => {
    const out: T[] = []
    for await (const item of pages) out.push(item)
    return out
  }
  const ensure = (status: string, what: string, body: unknown) => {
    if (/^2\d\d$/.test(status)) return
    throw azureError({ statusCode: Number(status) }, typeof body === 'string' ? body : JSON.stringify(body ?? ''), config, what)
  }

  return {
    listSandboxes: (labels) => call('Listing sandboxes', (options) => collect(client.sandboxes.list({ ...options, labels }))),
    getSandbox: (id) => orNull(call('Getting a sandbox', (options) => client.sandboxes.get(id, options))),
    createSandbox: (request) => call('Creating a sandbox', (options) => client.sandboxes.beginCreate(request, { ...options, ...poll }).pollUntilDone()),
    deleteSandbox: async (id) => {
      await call('Deleting a sandbox', (options) => client.sandboxes.beginDelete(id, { ...options, ...poll }).pollUntilDone())
    },
    stopSandbox: async (id) => {
      await call('Stopping a sandbox', (options) => client.sandboxes.beginStop(id, { ...options, ...poll }).pollUntilDone())
    },
    resumeSandbox: async (id) => {
      await call('Resuming a sandbox', (options) => client.sandboxes.beginResume(id, { ...options, ...poll }).pollUntilDone())
    },
    exec: (id, command) => call('Running a command', (options) => client.sandboxes.exec(id, { command }, options)),
    // The service takes the mode as a decimal number.
    writeFile: (id, path, data, mode) => call('Writing a file', (options) => client.files.write(id, path, data, { ...options, createDirs: true, mode: String(mode) })),
    // The SDK's read decodes files as text, which changes binary ones, so this streams the raw response.
    readFile: async (id, path) => {
      const response = await call('Reading a file', () =>
        context.pathUnchecked(`${base}/sandboxes/${encodeURIComponent(id)}/files`).get({ queryParameters: { ...query(), path }, headers: { accept: 'application/octet-stream' } }).asNodeStream(),
      )
      if (!/^2\d\d$/.test(response.status)) {
        const body = response.body ? (await collectStream(Readable.from(response.body as AsyncIterable<Buffer>))).toString('utf8') : ''
        ensure(response.status, 'Reading a file', body)
      }
      if (!response.body) return Readable.from([])
      return response.body instanceof Readable ? response.body : Readable.from(response.body as AsyncIterable<Buffer>)
    },
    // The SDK's snapshot keeps only a name label, so this posts the labels itself.
    snapshot: async (id, labels) => {
      const created = await call('Taking a snapshot', async () => await context.pathUnchecked(`${base}/sandboxes/${encodeURIComponent(id)}/snapshot`).post({ queryParameters: query(), body: { labels } }))
      ensure(created.status, 'Taking a snapshot', created.body)
      const snapshot = created.body as AzureSnapshot
      for (let attempt = 0; attempt < 600; attempt += 1) {
        const current = await call('Getting a snapshot', (options) => client.snapshots.get(snapshot.id, options))
        if (!current.status || /^(ready|succeeded|available|completed)$/i.test(current.status)) return current
        if (/^fail/i.test(current.status)) throw new SandboxError('azure_error', `Snapshot ${snapshot.id} failed: ${current.status}.`)
        await delay(1000)
      }
      throw new SandboxError('timeout', `Snapshot ${snapshot.id} was not ready after 10 minutes.`)
    },
    listSnapshots: () => call('Listing snapshots', (options) => collect(client.snapshots.list(options))),
    getSnapshot: (id) => orNull(call('Getting a snapshot', (options) => client.snapshots.get(id, options))),
    deleteSnapshot: async (id) => {
      await call('Deleting a snapshot', (options) => client.snapshots.beginDelete(id, { ...options, ...poll }).pollUntilDone())
    },
    listDiskImages: () => call('Listing disk images', (options) => collect(client.diskImages.list(options))),
    createDiskImage: (image, name) =>
      call(`Building a disk image from ${image}`, (options) => client.diskImages.beginCreate(image, { ...options, name, cmd: ['sleep', 'infinity'], updateIntervalInMs: 2000 }).pollUntilDone()),
  }
}

/** A string as one shell word. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export interface WrapOptions {
  user: string
  env: Record<string, string>
  /** Marks every process of the command, for `KILL_SCRIPT`. */
  marker: string
  timeoutSeconds?: number
  /** A file the command reads as stdin, removed once it is open. */
  stdinFile?: string
}

/**
 * The shell script that runs `command` the way the contract says, since the service runs everything as
 * root with its own environment: as `user`, from `/`, with only a plain `PATH`, the user's `HOME`, the
 * egress proxy's certificate variables, and the caller's variables. The guest's own variables, such as
 * its managed identity endpoint, never reach the command.
 */
export function wrapCommand(command: readonly string[], options: WrapOptions): string {
  const ca = CA_VARIABLES.map((name) => `\${${name}:+"${name}=$${name}"}`).join(' ')
  const env = Object.entries(options.env).map(([key, value]) => shellQuote(`${key}=${value}`))
  const limit = options.timeoutSeconds === undefined ? [] : ['timeout', '-k', '5', String(options.timeoutSeconds)]
  const stdin = options.stdinFile ? `exec 0<${shellQuote(options.stdinFile)} || exit 125; rm -f -- ${shellQuote(options.stdinFile)}` : 'exec 0</dev/null'
  return [
    `u=${shellQuote(options.user)}`,
    `p=$(getent passwd "$u") || { echo "blobby-sandbox: there is no user $u" >&2; exit 125; }`,
    `n=$(printf %s "$p" | cut -d: -f1); h=$(printf %s "$p" | cut -d: -f6); i=$(printf %s "$p" | cut -d: -f3)`,
    stdin,
    'cd / || exit 125',
    `set -- env -i PATH=${PATH} LANG=C.UTF-8 HOME="$h" USER="$n" LOGNAME="$n" ${ca} ${EXEC_ID_ENV}=${options.marker} ${[...env, ...limit.map(shellQuote), ...command.map(shellQuote)].join(' ')}`,
    'if [ "$i" = 0 ]; then exec "$@"; fi',
    'exec runuser -u "$n" -- "$@"',
  ].join('\n')
}

/** Starts a wrapped command in the background, with its output and exit code in `dir`. */
function detachedScript(script: string, dir: string): string {
  const d = shellQuote(dir)
  const run = `sh -c ${shellQuote(script)} >${d}/out 2>${d}/err; echo $? >${d}/exit.tmp; mv ${d}/exit.tmp ${d}/exit`
  return `mkdir -p -m 700 ${d} && : >${d}/out && : >${d}/err && nohup setsid sh -c ${shellQuote(run)} </dev/null >/dev/null 2>&1 &`
}

/** Reads a background command's exit code, if it has one, and up to a chunk of its output past what was read. */
function pollScript(dir: string, read: { stdout: number; stderr: number }): string {
  const d = shellQuote(dir)
  return `e=$(cat ${d}/exit 2>/dev/null); printf '%s\\n' "$e"; tail -c +${read.stdout + 1} ${d}/out | head -c ${CHUNK_BYTES} | base64 -w0; echo; tail -c +${read.stderr + 1} ${d}/err | head -c ${CHUNK_BYTES} | base64 -w0; echo`
}

/** Passes only `range` of a stream through. */
function sliceStream(source: Readable, range: ReadRange): Readable {
  const offset = range.offset ?? 0
  const end = range.length === undefined ? Infinity : offset + range.length
  let position = 0
  const slicer = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      const start = position
      position += chunk.length
      const from = Math.max(0, offset - start)
      const to = Math.min(chunk.length, end - start)
      if (to > from) this.push(chunk.subarray(from, to))
      if (position >= end) {
        this.push(null)
        source.unpipe(this)
        source.destroy()
      }
      done()
    },
  })
  source.on('error', (error) => slicer.destroy(error))
  return source.pipe(slicer)
}

function iso(value: string | undefined): string | null {
  if (!value) return null
  const time = new Date(value)
  return Number.isNaN(time.getTime()) ? null : time.toISOString()
}

/** Maps the service's states onto the contract's. */
export function machineState(state: string | undefined): Machine['state'] {
  switch (state) {
    case 'Running':
      return 'running'
    case 'Stopped':
    case 'Suspended':
    case 'Idle':
      return 'stopped'
    case 'Creating':
      return 'created'
    default:
      return (state ?? 'unknown').toLowerCase()
  }
}

/** The machine a sandbox is. Its name label is internal, so it is left out of its labels. */
export function toMachine(sandbox: AzureSandbox): Machine {
  const { [NAME_LABEL]: name, ...labels } = sandbox.labels ?? {}
  const machine: Machine = { name: name ?? sandbox.id, state: machineState(sandbox.state), ports: [], createdAt: iso(sandbox.createdAt), labels, deleteAfter: deleteAfterOf(labels) }
  const snapshot = sandbox.sourcesRef?.snapshot?.id
  if (snapshot) machine.image = snapshot
  return machine
}

function toSnapshot(snapshot: AzureSnapshot): Snapshot {
  const { [SNAPSHOT_OF_LABEL]: source, ...labels } = snapshot.labels ?? {}
  return { id: snapshot.id, source: source ?? null, createdAt: iso(snapshot.createdAtUtc), labels }
}

/** The container image a disk image is built from, as a full reference: `ubuntu:24.04` is `docker.io/library/ubuntu:24.04`. */
export function imageReference(image: string): string {
  if (typeof image !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(image) || image.length > 512) {
    throw new SandboxError('invalid_options', `"${String(image)}" isn't a valid image reference, such as ubuntu:24.04 or ubuntu@sha256:<digest>.`)
  }
  const [first, ...rest] = image.split('/')
  if (!rest.length) return `docker.io/library/${image}`
  if (!/[.:]/.test(first!) && first !== 'localhost') return `docker.io/${image}`
  return image
}

/** The disk image name for an image reference: stable, so every process finds the one already built. */
export function diskImageName(reference: string): string {
  return `blobby-${createHash('sha256').update(reference).digest('hex').slice(0, 24)}`
}

/** The service's lifecycle for a machine: no idle suspend, and deletion once it has been idle past its deadline, as a backstop for reapers. */
export function lifecycle(deleteAfter: Date | undefined, now = Date.now()): AzureLifecycle {
  if (!deleteAfter) return { autoSuspend: { ...NO_AUTO_SUSPEND }, autoDelete: { enabled: false } }
  const seconds = Math.max(MIN_AUTO_DELETE_SECONDS, Math.ceil((deleteAfter.getTime() - now) / 1000))
  return { autoSuspend: { ...NO_AUTO_SUSPEND }, autoDelete: { enabled: true, deleteIntervalSeconds: seconds } }
}

/**
 * The service's egress policy for a network policy. Without one, the service sends everything through
 * its TLS-inspecting proxy, whose certificate browsers don't trust, so `internet` asks for none. `Deny`
 * is enforced only with inspection, which is named, so a change to the service's default can't quietly
 * turn enforcement off.
 */
export function egressPolicy(network: NetworkPolicy): AzureEgressPolicy {
  if (network === 'internet') return { defaultAction: 'Allow', hostRules: [], rules: [], trafficInspection: 'None' }
  if (network === 'essential') return { defaultAction: 'Deny', hostRules: [], rules: [], trafficInspection: 'Full' }
  if (typeof network === 'object') {
    return { defaultAction: 'Deny', hostRules: network.allow.map((pattern) => ({ pattern, action: 'Allow' as const })), rules: [], trafficInspection: 'Full' }
  }
  throw new SandboxError('network_unenforceable', `The azure backend can't enforce the ${network} network policy.`)
}

/** `cpus`, `memoryMb`, and `storageGb` as the service writes them. */
export function sandboxResources(resources: CreateOptions['resources'] = {}): { cpu: string; memory: string; disk: string } {
  const whole = (value: number | undefined, fallback: number, what: string) => {
    const number = value ?? fallback
    if (!Number.isInteger(number) || number <= 0) throw new SandboxError('invalid_options', `${what} must be a whole number above 0.`)
    return number
  }
  return {
    cpu: String(whole(resources.cpus, 1, 'resources.cpus')),
    memory: `${whole(resources.memoryMb, 1024, 'resources.memoryMb')}Mi`,
    disk: `${whole(resources.storageGb, 10, 'resources.storageGb')}Gi`,
  }
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/

/** A quantity the service writes, such as `4`, `4000m`, `8192Mi`, or `32Gi`, in whole units of `unit` (1 for CPUs, MiB, or GiB). */
export function quantity(value: string | undefined, unit: 'cpu' | 'MiB' | 'GiB'): number | null {
  const match = /^(\d+(?:\.\d+)?)(m|Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(value ?? '')
  if (!match) return null
  const number = Number(match[1])
  const suffix = match[2] ?? ''
  if (unit === 'cpu') return suffix === 'm' ? number / 1000 : suffix ? null : number
  const bytes: Record<string, number> = { '': 1, Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }
  if (!(suffix in bytes)) return null
  return (number * bytes[suffix]!) / (unit === 'MiB' ? 2 ** 20 : 2 ** 30)
}

/** How the size asked for differs from a snapshot's, in words, or null when it doesn't or the snapshot doesn't say. */
export function otherSize(wanted: CreateOptions['resources'] = {}, has: AzureSnapshot['resources']): { wants: string; has: string } | null {
  if (!has) return null
  const actual = { cpus: quantity(has.cpu, 'cpu'), memoryMb: quantity(has.memory, 'MiB'), storageGb: quantity(has.disk, 'GiB') }
  const words = { cpus: (n: number) => `${n} CPU${n === 1 ? '' : 's'}`, memoryMb: (n: number) => `${n} MB`, storageGb: (n: number) => `${n} GB` }
  const keys = (['cpus', 'memoryMb', 'storageGb'] as const).filter((key) => wanted[key] !== undefined && actual[key] !== null)
  const differs = keys.filter((key) => wanted[key] !== actual[key])
  if (!differs.length) return null
  return { wants: differs.map((key) => words[key](wanted[key]!)).join(', '), has: keys.map((key) => words[key](actual[key]!)).join(', ') }
}

function checkName(name: string): string {
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new SandboxError('invalid_options', `"${String(name)}" isn't a valid machine name: use up to 63 letters, digits, dots, underscores, and dashes, starting with a letter or digit.`)
  }
  return name
}

function checkPath(path: string): string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0') || /[\n\r]/.test(path)) {
    throw new SandboxError('invalid_options', `"${String(path)}" isn't an absolute path.`)
  }
  return path
}

function checkUser(user: string | undefined): string {
  const value = user ?? 'root'
  if (typeof value !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$/.test(value)) throw new SandboxError('invalid_options', `"${String(value)}" isn't a valid user name or uid.`)
  return value
}

export interface AzureOptions {
  /** Marks the sandboxes this backend creates, and lists only sandboxes with all of them. The default is this host's standalone owner label. */
  labels?: Record<string, string>
  /** Environment for the config folder and the default labels' host ID; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** The sandbox group, instead of `azure.json`. */
  config?: AzureConfig
  /** Makes the data plane. Tests pass a fake. */
  api?: (config: AzureConfig) => Promise<AzureApi>
  /** Runs the Azure CLI, for tokens. Tests pass a fake. */
  run?: Runner
  /** Milliseconds between polls of a background command. */
  pollMs?: number
  now?: () => number
}

/**
 * Runs each machine as an Azure Container Apps sandbox. Machines come from disk images built from
 * container images on first use, or from snapshots. The sandbox group is set up once with
 * `infra/azure/main.bicep`; see its README.
 */
export class AzureBackend implements Backend {
  readonly name = 'azure'
  readonly #options: AzureOptions
  readonly #pollMs: number
  readonly #now: () => number
  #config: Promise<AzureConfig> | undefined
  #api: Promise<AzureApi> | undefined
  #labels: Promise<Record<string, string>> | undefined
  readonly #images = new Map<string, Promise<AzureDiskImage>>()

  constructor(options: AzureOptions = {}) {
    this.#options = options
    this.#pollMs = options.pollMs ?? POLL_MS
    this.#now = options.now ?? Date.now
  }

  capabilities(): Capabilities {
    return { ...CAPABILITIES, networkPolicies: [...CAPABILITIES.networkPolicies] }
  }

  #configured(): Promise<AzureConfig> {
    this.#config ??= this.#options.config ? Promise.resolve(this.#options.config) : loadAzureConfig(this.#options.env ?? process.env)
    this.#config.catch(() => (this.#config = undefined))
    return this.#config
  }

  #client(): Promise<AzureApi> {
    this.#api ??= (async () => {
      const config = await this.#configured()
      if (this.#options.api) return this.#options.api(config)
      return loadAzureApi(config, new AzCliCredential(config.subscription, this.#options.run))
    })()
    this.#api.catch(() => (this.#api = undefined))
    return this.#api
  }

  #ownLabels(): Promise<Record<string, string>> {
    this.#labels ??= this.#options.labels ? Promise.resolve({ ...this.#options.labels }) : ownerLabels(this.#options.env ?? process.env)
    return this.#labels
  }

  async check(): Promise<BackendStatus> {
    const checks: BackendCheck[] = []
    const fail = (error: unknown): BackendStatus => {
      const code = error instanceof SandboxError ? error.code : 'azure_error'
      return { ok: false, detail: (error as Error).message, code, checks }
    }
    let config: AzureConfig
    try {
      config = await this.#configured()
      checks.push({ name: 'azure-config', ok: true, detail: `A sandbox group in ${config.location}` })
    } catch (error) {
      checks.push({ name: 'azure-config', ok: false, detail: (error as Error).message })
      return fail(error)
    }
    try {
      const api = await this.#client()
      await api.listSandboxes(await this.#ownLabels())
      checks.push({ name: 'azure-access', ok: true, detail: 'Signed in with the Azure CLI, with access to the sandbox group' })
    } catch (error) {
      checks.push({ name: 'azure-access', ok: false, detail: (error as Error).message })
      return fail(error)
    }
    return { ok: true, detail: `Azure Container Apps sandboxes in ${config.location}, with @azure/containerapps-sandbox`, checks }
  }

  async #sandboxes(labels: Record<string, string> = {}): Promise<AzureSandbox[]> {
    const owner = await this.#ownLabels()
    const wanted = { ...labels, ...owner }
    const found = await (await this.#client()).listSandboxes(wanted)
    // The service filters too; this keeps another owner's sandboxes out whatever it does.
    return found.filter((sandbox) => sandbox.labels?.[NAME_LABEL] && hasLabels(sandbox.labels, wanted) && sandbox.state !== 'Deleting')
  }

  async list(filter: { labels?: Record<string, string> } = {}): Promise<Machine[]> {
    const wanted = checkLabels(filter.labels)
    return (await this.#sandboxes(wanted)).map(toMachine).sort((a, b) => a.name.localeCompare(b.name))
  }

  /** The sandbox that is the machine `name`: the oldest, if a race made two. */
  async #find(name: string): Promise<AzureSandbox | null> {
    const found = await this.#sandboxes({ [NAME_LABEL]: checkName(name) })
    return found.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id))[0] ?? null
  }

  async #require(name: string): Promise<AzureSandbox> {
    const sandbox = await this.#find(name)
    if (!sandbox) throw new SandboxError('not_found', `There is no Azure sandbox named ${name}.`)
    return sandbox
  }

  async #running(name: string): Promise<AzureSandbox> {
    const sandbox = await this.#require(name)
    if (sandbox.state !== 'Running') throw new SandboxError('not_running', `${name} isn't running. Start it first.`)
    return sandbox
  }

  async get(name: string): Promise<Machine | null> {
    const sandbox = await this.#find(name)
    return sandbox ? toMachine(sandbox) : null
  }

  /** The machine already named this, as `create` returns it for a repeated idempotent create, or a failure. */
  async #existing(options: Pick<CreateOptions, 'name' | 'idempotencyKey'>): Promise<Machine | null> {
    const existing = await this.get(options.name)
    if (!existing) return null
    if (options.idempotencyKey !== undefined && existing.labels[IDEMPOTENCY_LABEL] === options.idempotencyKey) return existing
    throw new SandboxError('already_exists', `There is already an Azure sandbox named ${options.name}.`)
  }

  async #create(name: string, request: Omit<AzureCreateRequest, 'labels'> & { labels: Record<string, string> }, idempotencyKey: string | undefined): Promise<Machine> {
    const api = await this.#client()
    const created = await api.createSandbox({ ...request, labels: { ...request.labels, [NAME_LABEL]: name } })
    // Names are labels, which the service doesn't keep unique: if another create won a race, this one goes.
    const winner = await this.#find(name)
    if (winner && winner.id !== created.id) {
      await api.deleteSandbox(created.id).catch(() => {})
      const machine = toMachine(winner)
      if (idempotencyKey !== undefined && machine.labels[IDEMPOTENCY_LABEL] === idempotencyKey) return machine
      throw new SandboxError('already_exists', `There is already an Azure sandbox named ${name}.`)
    }
    return toMachine(created.state === 'Running' ? created : ((await api.getSandbox(created.id)) ?? created))
  }

  async create(options: CreateOptions): Promise<Machine> {
    checkName(options.name)
    const { labels, network } = checkCreate(this.name, CAPABILITIES, options, await this.#ownLabels())
    const resources = sandboxResources(options.resources)
    const egress = egressPolicy(network)
    const existing = await this.#existing(options)
    if (existing) return existing
    const image = await this.#diskImage(options.image)
    return this.#create(
      options.name,
      { sourcesRef: { diskImage: { id: image.id } }, resources, labels, lifecycle: lifecycle(options.deleteAfter, this.#now()), egressPolicy: egress },
      options.idempotencyKey,
    )
  }

  async createFrom(snapshot: string, options: Omit<CreateOptions, 'image'>): Promise<Machine> {
    checkName(options.name)
    const { labels, network } = checkCreate(this.name, CAPABILITIES, options, await this.#ownLabels())
    const egress = egressPolicy(network)
    const existing = await this.#existing(options)
    if (existing) return existing
    const source = await this.#ownedSnapshot(snapshot)
    if (!source) throw new SandboxError('not_found', `There is no snapshot ${snapshot}.`)
    // The service refuses a size for a sandbox from a snapshot: it always has the snapshot's.
    const other = otherSize(options.resources, source.resources)
    if (other) throw new SandboxError('unsupported', `Azure sandboxes made from a snapshot have its size (${other.has}), so ${options.name} can't have ${other.wants}.`)
    return this.#create(
      options.name,
      { sourcesRef: { snapshot: { id: snapshot } }, labels, lifecycle: lifecycle(options.deleteAfter, this.#now()), egressPolicy: egress },
      options.idempotencyKey,
    )
  }

  /** The disk image for a container image, built the first time it is used and reused after. */
  #diskImage(image: string): Promise<AzureDiskImage> {
    const reference = imageReference(image)
    let pending = this.#images.get(reference)
    if (!pending) {
      pending = (async () => {
        const api = await this.#client()
        const name = diskImageName(reference)
        const matches = (await api.listDiskImages()).filter((candidate) => candidate.name === name || candidate.labels?.name === name)
        const ready = matches.find((candidate) => candidate.status?.state === 'Ready')
        if (ready) return ready
        const built = await api.createDiskImage(reference, name)
        if (built.status?.state && built.status.state !== 'Ready') {
          throw new SandboxError('azure_image', `Azure could not build a disk image from ${reference}: ${built.status.state}${built.status.message ? `, ${built.status.message}` : ''}.`)
        }
        return built
      })()
      this.#images.set(reference, pending)
      pending.catch(() => this.#images.delete(reference))
    }
    return pending
  }

  async start(name: string): Promise<Machine> {
    const sandbox = await this.#require(name)
    if (sandbox.state === 'Running') return toMachine(sandbox)
    const api = await this.#client()
    await api.resumeSandbox(sandbox.id)
    return toMachine((await api.getSandbox(sandbox.id)) ?? sandbox)
  }

  async stop(name: string): Promise<void> {
    const sandbox = await this.#require(name)
    if (machineState(sandbox.state) === 'stopped') return
    await (await this.#client()).stopSandbox(sandbox.id)
  }

  async remove(name: string): Promise<void> {
    const api = await this.#client()
    for (const sandbox of await this.#sandboxes({ [NAME_LABEL]: checkName(name) })) {
      try {
        await api.deleteSandbox(sandbox.id)
      } catch (error) {
        if (!(error instanceof SandboxError && error.code === 'not_found')) throw error
      }
    }
  }

  async endpoint(name: string, guestPort: number): Promise<Endpoint> {
    await this.#running(name)
    throw new SandboxError('not_published', `Port ${guestPort} of ${name} is not published: Azure sandboxes have no published ports yet. Use \`blobby-sandbox screenshot\` to see a desktop.`)
  }

  async exec(name: string, command: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    if (!Array.isArray(command) || !command.length || command.some((part) => typeof part !== 'string' || part.includes('\0'))) {
      throw new SandboxError('invalid_options', 'A command is a non-empty list of strings without NUL characters.')
    }
    const user = checkUser(options.user)
    const env = checkGuestEnv(options.env)
    if (EXEC_ID_ENV in env) throw new SandboxError('invalid_options', `${EXEC_ID_ENV} is reserved by the azure backend.`)
    const timeout = options.timeoutSeconds
    if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout <= 0)) {
      throw new SandboxError('invalid_options', 'timeoutSeconds must be a whole number of seconds above 0.')
    }
    const cancelled = () => new SandboxError('cancelled', `The command in ${name} was cancelled.`)
    if (options.signal?.aborted) throw cancelled()
    const sandbox = await this.#running(name)
    const api = await this.#client()
    const marker = randomBytes(12).toString('hex')
    let stdinFile: string | undefined
    if (options.stdin !== undefined) {
      stdinFile = `${EXEC_DIR}/${marker}.stdin`
      const bytes = typeof options.stdin === 'string' ? Buffer.from(options.stdin, 'utf8') : Buffer.from(options.stdin)
      await api.writeFile(sandbox.id, stdinFile, bytes, 0o600)
    }
    const script = wrapCommand(command, { user, env, marker, timeoutSeconds: timeout, stdinFile })
    const kill = async () => {
      const dir = `${EXEC_DIR}/${marker}`
      await api.exec(sandbox.id, `sh -c ${shellQuote(KILL_SCRIPT)} sh ${marker} ${EXEC_ID_ENV}; rm -rf -- ${shellQuote(dir)} ${shellQuote(`${dir}.stdin`)}`).catch(() => {})
    }
    if (!options.onOutput && (timeout === undefined || timeout <= DIRECT_LIMIT_SECONDS)) {
      const run = api.exec(sandbox.id, script)
      if (!options.signal) return run
      run.catch(() => {})
      const signal = options.signal
      let abort = () => {}
      const aborted = new Promise<never>((_, reject) => {
        abort = () => reject(cancelled())
        signal.addEventListener('abort', abort, { once: true })
      })
      try {
        return await Promise.race([run, aborted])
      } catch (error) {
        if (signal.aborted) await kill()
        throw error
      } finally {
        signal.removeEventListener('abort', abort)
      }
    }
    return this.#background(sandbox.id, api, script, marker, { onOutput: options.onOutput, signal: options.signal, timeout, kill, cancelled })
  }

  /** Runs a command in the background and polls for its output, for commands that stream or run long. */
  async #background(
    id: string,
    api: AzureApi,
    script: string,
    marker: string,
    options: { onOutput?: ExecOptions['onOutput']; signal?: AbortSignal; timeout?: number; kill: () => Promise<void>; cancelled: () => SandboxError },
  ): Promise<ExecResult> {
    const dir = `${EXEC_DIR}/${marker}`
    const started = await api.exec(id, detachedScript(script, dir))
    if (started.exitCode !== 0) throw new SandboxError('azure_exec', `The command could not start in the background: ${started.stderr.trim() || `exit code ${started.exitCode}`}.`)
    const output = { stdout: '', stderr: '' }
    const read = { stdout: 0, stderr: 0 }
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
    const emit = (stream: 'stdout' | 'stderr', text: string) => {
      if (!text) return
      output[stream] += text
      options.onOutput?.({ stream, text })
    }
    const deadline = options.timeout === undefined ? Infinity : this.#now() + (options.timeout + DEADLINE_GRACE_SECONDS) * 1000
    try {
      for (;;) {
        if (options.signal?.aborted) throw options.cancelled()
        const polled = await api.exec(id, pollScript(dir, read))
        const [exit = '', out = '', err = ''] = polled.stdout.split('\n')
        const chunks = { stdout: Buffer.from(out, 'base64'), stderr: Buffer.from(err, 'base64') }
        for (const stream of ['stdout', 'stderr'] as const) {
          read[stream] += chunks[stream].length
          emit(stream, decoders[stream].write(chunks[stream]))
        }
        const more = chunks.stdout.length >= CHUNK_BYTES || chunks.stderr.length >= CHUNK_BYTES
        if (/^\d+$/.test(exit.trim()) && !more) {
          emit('stdout', decoders.stdout.end())
          emit('stderr', decoders.stderr.end())
          await api.exec(id, `rm -rf -- ${shellQuote(dir)}`).catch(() => {})
          return { exitCode: Number(exit.trim()), ...output }
        }
        if (this.#now() > deadline) {
          await options.kill()
          return { exitCode: 124, ...output }
        }
        if (!more) await waitOrAbort(this.#pollMs, options.signal)
      }
    } catch (error) {
      if (options.signal?.aborted) {
        await options.kill()
        throw options.cancelled()
      }
      throw error
    }
  }

  async readFile(name: string, path: string, range: ReadRange = {}): Promise<Readable> {
    const target = checkPath(path)
    const offset = range.offset ?? 0
    if (!Number.isSafeInteger(offset) || offset < 0) throw new SandboxError('invalid_options', 'range.offset must be a whole number of bytes, 0 or more.')
    if (range.length !== undefined && (!Number.isSafeInteger(range.length) || range.length < 0)) throw new SandboxError('invalid_options', 'range.length must be a whole number of bytes, 0 or more.')
    const sandbox = await this.#running(name)
    let stream: Readable
    try {
      stream = await (await this.#client()).readFile(sandbox.id, target)
    } catch (error) {
      if (error instanceof SandboxError && error.code === 'not_found') throw new SandboxError('not_found', `${name} has no file ${target}.`, { cause: error })
      throw error
    }
    if (offset === 0 && range.length === undefined) return stream
    if (range.length === 0) {
      stream.destroy()
      return Readable.from([])
    }
    return sliceStream(stream, range)
  }

  async writeFile(name: string, path: string, data: Uint8Array | Readable, options: WriteOptions = {}): Promise<void> {
    const target = checkPath(path)
    const mode = options.mode ?? 0o644
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new SandboxError('invalid_options', 'mode must be a file mode, such as 0o644.')
    const user = options.user === undefined ? undefined : checkUser(options.user)
    const sandbox = await this.#running(name)
    const bytes = data instanceof Uint8Array ? data : await collectStream(data)
    const api = await this.#client()
    await api.writeFile(sandbox.id, target, bytes, mode)
    // The service sets the mode only on new files, so it is set again for files that existed.
    const owner = user && user !== 'root' ? `chown -- ${shellQuote(`${user}:`)} ${shellQuote(target)} && ` : ''
    const result = await api.exec(sandbox.id, `${owner}chmod ${mode.toString(8)} -- ${shellQuote(target)}`)
    if (result.exitCode !== 0) throw new SandboxError('invalid_options', `${target} in ${name} could not be given its owner or mode: ${result.stderr.trim()}`)
  }

  async stat(name: string, path: string): Promise<FileInfo | null> {
    const target = checkPath(path)
    const sandbox = await this.#running(name)
    const result = await (await this.#client()).exec(sandbox.id, `stat -L -c '%s %a' -- ${shellQuote(target)}`)
    if (result.exitCode !== 0) {
      if (/No such file or directory/.test(result.stderr)) return null
      throw new SandboxError('azure_exec', `Could not stat ${target} in ${name}: ${result.stderr.trim()}`)
    }
    const [size, mode] = result.stdout.trim().split(' ')
    return { size: Number(size), mode: Number.parseInt(mode ?? '', 8) }
  }

  async snapshot(source: string, options: SnapshotOptions = {}): Promise<Snapshot> {
    const labels = { ...checkLabels(options.labels), ...(await this.#ownLabels()) }
    const sandbox = await this.#require(source)
    const taken = toSnapshot(await (await this.#client()).snapshot(sandbox.id, { ...labels, [SNAPSHOT_OF_LABEL]: source }))
    return { ...taken, source, labels: { ...labels, ...taken.labels } }
  }

  async snapshots(filter: { labels?: Record<string, string> } = {}): Promise<Snapshot[]> {
    const wanted = { ...checkLabels(filter.labels), ...(await this.#ownLabels()) }
    // The service's snapshot list has no label filter.
    const all = await (await this.#client()).listSnapshots()
    return all
      .filter((snapshot) => snapshot.labels?.[SNAPSHOT_OF_LABEL] && hasLabels(snapshot.labels, wanted))
      .map(toSnapshot)
      .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id))
  }

  async #ownedSnapshot(id: string): Promise<AzureSnapshot | null> {
    if (typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(id)) throw new SandboxError('invalid_options', `"${String(id)}" isn't a snapshot ID.`)
    const snapshot = await (await this.#client()).getSnapshot(id)
    if (!snapshot?.labels?.[SNAPSHOT_OF_LABEL] || !hasLabels(snapshot.labels, await this.#ownLabels())) return null
    return snapshot
  }

  async removeSnapshot(id: string): Promise<void> {
    if (!(await this.#ownedSnapshot(id))) return
    const api = await this.#client()
    const users: string[] = []
    for (const sandbox of await this.#sandboxes()) {
      const source = sandbox.sourcesRef ? sandbox.sourcesRef.snapshot?.id : (await api.getSandbox(sandbox.id))?.sourcesRef?.snapshot?.id
      if (source === id) users.push(toMachine(sandbox).name)
    }
    if (users.length) throw new SandboxError('in_use', `Snapshot ${id} is in use by ${users.length === 1 ? 'a machine' : `${users.length} machines`}: ${users.join(', ')}. Remove them first.`)
    try {
      await api.deleteSnapshot(id)
    } catch (error) {
      if (error instanceof SandboxError && error.code === 'not_found') return
      throw error
    }
  }
}

function waitOrAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
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
