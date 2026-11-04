import { createHash, randomBytes } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'
import type { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import {
  readAll,
  SandboxError,
  type Backend,
  type BackendStatus,
  type Capabilities,
  type CreateOptions,
  type Endpoint,
  type ExecOptions,
  type ExecResult,
  type Machine,
  type NetworkPolicy,
  type ReadRange,
  type Snapshot,
} from './backend.ts'
import { collectStream, networkPolicyKind } from './contract.ts'
import { KIND_LABEL } from './labels.ts'
import { checkGuestEnv } from './guest-env.ts'
import { endpointUrl } from './net.ts'
import { builtinRecipeIds, DEFAULT_RECIPE, describeBuiltinRecipes, loadBuiltinRecipe, parseRecipe, type Recipe, type RecipeStep } from './recipe.ts'
import type { AuditEvent, ResolveFunction, Resolver } from './callbacks/protocol.ts'
import { SECRET_NAME } from './secrets.ts'
import { untilAborted } from './abort.ts'
import { RedactedStream } from './callbacks/redact.ts'
import { StepCallbacks } from './callbacks/step.ts'

export type { CallbackAnswer, CallbackRequest } from './callbacks/protocol.ts'

/** Backend machines that are sandboxes have this prefix, so other machines are left alone. */
export const MACHINE_PREFIX = 'blobby-'
/**
 * Installed sandboxes that new sandboxes are made from, one per recipe: kept as snapshots where the backend
 * takes them, else as running machines that new sandboxes branch from. Their names never match a sandbox's.
 */
export const BASE_PREFIX = 'blobbybase-'
/** The labels of a recipe's base, which find it again: the hash of what it installs, its recipe, its image, and the runtime that made it. */
export const BASE_LABEL = 'blobby.dev/base'
export const RECIPE_LABEL = 'blobby.dev/recipe'
export const IMAGE_LABEL = 'blobby.dev/image'
export const RUNTIME_LABEL = 'blobby.dev/runtime'
/** How long a new standalone sandbox lives before reapers may delete it, unless `deleteAfter` says otherwise. */
export const DEFAULT_DELETE_AFTER = '24h'
export const DURATION_PATTERN = /^(?:never|[1-9]\d{0,5}[mhd])$/
export const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/
export const RESOLUTION_PATTERN = /^[1-9]\d{2,3}x[1-9]\d{2,3}$/
export const BASE_IMAGE = 'ubuntu:24.04'
/** The guest port noVNC serves the viewer on. */
export const VIEWER_PORT = 6901
/** The desktop's user, who runs the session, its apps, and recipe steps. */
export const DESKTOP_USER = 'ubuntu'
/** Where this package's `runtime/` folder goes in a sandbox. */
export const RUNTIME_DIR = '/opt/blobby/runtime'
/** Where the sandbox's recipe goes. */
export const RECIPE_DIR = '/opt/blobby/recipe'
const GUEST = `${RUNTIME_DIR}/guest.py`
const NODE_MODULES = '/opt/blobby/node_modules'
const READY_FILE = '/etc/blobby/ready'
/** Written in a base once it is installed, so a copy of it shows that the base was finished. */
const BASE_READY_FILE = '/etc/blobby/base-ready'
const MEDIA_DIR = '/var/tmp/blobby-media'
const MEDIA_ID = /^[a-f0-9]{8,64}$/
const RECIPE_ID_FILE = '/etc/blobby/recipe'
const PASSWORD_FILE = '/etc/blobby/vnc-password'
const DEFAULT_RESOLUTION = '1280x800'
const DEFAULT_CPUS = 4
const DEFAULT_MEMORY_MB = 8192
const STORAGE_GB = 32
const BOOT_MS = 60_000
const VIEWER_MS = 90_000
const SETUP_SECONDS = 30 * 60
const STEP_SECONDS = 300
/** How long `exec` with a secret may run unless `timeoutSeconds` says otherwise. */
const SECRET_EXEC_SECONDS = 30 * 60
/** Why `exec` with a secret stopped waiting: its deadline, rather than the caller cancelling. */
const TIMED_OUT = Symbol('timed out')
/** A base still being installed after this long was left by an install that died. */
const STALE_BASE_MS = (SETUP_SECONDS + 15 * 60) * 1000
const runtimeDir = fileURLToPath(new URL('../runtime/', import.meta.url))
const packageVersion = async () => (JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

/** A sandbox, as `list` and `start` describe it. */
export interface SandboxInfo {
  name: string
  state: string
  /** The viewer's port on the backend's host, or null when it is not published there. Use `view` to reach the viewer. */
  viewerPort: number | null
  /** ISO 8601 time, or null when the backend does not say. */
  createdAt: string | null
  /** When reapers may delete it (ISO 8601), or null for never or when the backend does not say. */
  deleteAfter: string | null
}

export interface StartOptions {
  /** The recipe of a new sandbox; the default is vscode-insiders. An existing sandbox keeps its own unless this is set. */
  recipe?: Recipe
  /** The screen size, such as 1600x1000. */
  resolution?: string
  /** CPUs and memory of a new sandbox. Other sizes than the defaults install the sandbox from scratch. */
  cpus?: number
  memoryMb?: number
  /** Give a new sandbox the host GPU (default true). Without it, the sandbox installs from scratch. */
  gpu?: boolean
  /** When to run the recipe's steps: for a new sandbox (the default), every time, or never. */
  steps?: 'new' | 'always' | 'never'
  /**
   * How long a new sandbox lives before reapers may delete it, such as `90m`, `8h`, or `7d`, or `never`.
   * It becomes the sandbox's `deleteAfter` deadline. The default is the engine's, 24 hours unless set.
   */
  deleteAfter?: string
  /** What a new sandbox may reach. The default is `internet`. One the backend can't enforce fails closed with `network_unenforceable`. */
  network?: NetworkPolicy
  /** Local development only: run a new sandbox unrestricted when the backend can't enforce `network`, with a warning. */
  allowUnenforcedNetwork?: boolean
  onProgress?: (line: string) => void
  /** Answers the callbacks recipe steps ask for, such as a `LocalResolver`. Without it or `onRequest`, steps that ask for one fail. */
  resolver?: Resolver
  /** Answers callbacks with a function, when there is no `resolver`. */
  onRequest?: ResolveFunction
  /** The identity binding behind each callback namespace, such as `{ github: 'github-test' }`, passed to the resolver. */
  bindings?: Record<string, string>
  /** Called for each callback answer and refusal, with names and outcomes, never values. */
  onAudit?: (event: AuditEvent) => void
  signal?: AbortSignal
}

/**
 * The fields of its secret that a command run with `exec --secret` may ask for, as
 * `<secret>.<field>`: identifiers in the clear, the rest sealed to the request.
 */
export const SECRET_FIELDS: Readonly<Record<string, { sensitive: boolean }>> = {
  login: { sensitive: false },
  username: { sensitive: false },
  email: { sensitive: false },
  password: { sensitive: true },
  otp: { sensitive: true },
  token: { sensitive: true },
}

export interface SandboxExecOptions extends ExecOptions {
  /**
   * Lets the command ask for fields of this secret (`SECRET_FIELDS`) while it runs, through
   * `secret(field)` of the guest library, with `BLOBBY_SECRET` set to its name. Values are answered by
   * `resolver` or `onRequest` and withheld from the output. The command runs as the desktop user, with
   * the scripts library on its PATH, and stops after `timeoutSeconds` (default 30 minutes).
   */
  secret?: string
  resolver?: Resolver
  onRequest?: ResolveFunction
  /** Called for each callback answer and refusal, with names and outcomes, never values. */
  onAudit?: (event: AuditEvent) => void
}

export interface SandboxExecResult extends ExecResult {
  /** With `secret`: what the command said it did through `done(result)`, accounts as `SignedIn`, never logins. */
  result?: Record<string, unknown>
}

export interface StepResult {
  name: string
  /** What the step said it did. Accounts it signed in to show as `{ github: { signedIn: true, verified: true } }`, never as logins. */
  result: Record<string, unknown>
}

export interface Started {
  sandbox: SandboxInfo
  created: boolean
  /** How a new sandbox was made: copied from its recipe's installed base, or installed from scratch. */
  from: 'base' | 'scratch' | null
  recipe: string
  /** What the recipe's boot.sh reported, such as `{ insiders: '1.106.0-...' }`. */
  info: Record<string, string>
  steps: StepResult[]
  /** Whether the sandbox has a desktop viewer for `view`. Backends that can't publish ports, such as azure, have none yet. */
  viewer: boolean
}

export interface Screenshot {
  png: Uint8Array
  width: number
  height: number
}

/** A finished recording, kept in the sandbox until it is deleted. Read it with `mediaRead`. */
export interface RecordingInfo {
  id: string
  size: number
  sha256: string
  seconds: number | null
}

export interface AccessibleNode {
  /** Pass to `act`. Valid until the UI changes. */
  path: string
  app: string
  role: string
  name: string
  text?: string
  states?: string[]
  /** x, y, width, and height on the screen. */
  box?: [number, number, number, number]
  actions?: string[]
}

/**
 * Input by screen coordinates. The pointer glides to a point as a hand moves a mouse, and clicks hold the
 * button for a moment; `instant` jumps and clicks at once instead, for speed.
 */
export type InputAction =
  | { click: [number, number]; button?: 'left' | 'middle' | 'right'; double?: boolean; instant?: boolean }
  | { move: [number, number]; instant?: boolean }
  | { type: string }
  | { key: string }
  | { scroll: [number, number]; at?: [number, number]; instant?: boolean }

export interface UiQuery {
  app?: string
  match?: string
  max?: number
}

/** What `waitFor` waits for: an element whose name or text has `match`, optionally of one app, role, and state. */
export interface UiWait {
  match: string
  app?: string
  /** The element's role, such as `push button`, compared without case. */
  role?: string
  /** A state it must have. */
  state?: 'focused' | 'checked' | 'selected' | 'expanded' | 'editable' | 'disabled'
  /** Wait until no element matches instead, such as for a progress bar or dialog to go. */
  gone?: boolean
  /** How long to wait, 1 to 300 seconds. Default 30. */
  timeoutSeconds?: number
}

export interface UiWaited {
  /** False when `gone` was asked and nothing matches any more. */
  found: boolean
  /** The elements that matched, as `ui` lists them. */
  nodes: AccessibleNode[]
  waitedMs: number
}

export interface UiAct {
  path: string
  /** press (the default) runs an element's action; focus focuses it; set replaces its text. */
  do?: 'press' | 'focus' | 'set'
  /** For press: which action, such as click, when an element has several. */
  action?: string
  text?: string
}

export interface SandboxesOptions {
  /** How long new sandboxes live unless `StartOptions.deleteAfter` says otherwise. Default `24h`. */
  deleteAfter?: string
  /** Whether the viewer answers at a URL, with these headers. Tests replace it. */
  viewerUp?: (url: string, headers: Record<string, string>) => Promise<boolean>
  /** The folder of the playwright-core package to copy into sandboxes for recipe steps. */
  playwrightDir?: () => Promise<string>
  now?: () => number
  /** How often to poll a running step. */
  pollMs?: number
}

interface StepPoll {
  progress: string[]
  offset: number
  requests: { id: string; name: string; sensitive: boolean; publicKey?: string }[]
  exit: number | null
  result: Record<string, unknown> | null
  error: string | null
  /** The step's output from `outputOffset` on, and where the next poll continues. */
  output?: string
  outputOffset?: number
  /** Whether the step exited and all its output has been read. */
  outputDone?: boolean
}

const playwrightCoreDir = async () => dirname(createRequire(import.meta.url).resolve('playwright-core/package.json'))

async function answers(url: string, headers: Record<string, string>): Promise<boolean> {
  try {
    return (await fetch(url, { headers, signal: AbortSignal.timeout(2_000) })).ok
  } catch {
    return false
  }
}

/** Milliseconds in a duration such as `90m`, `8h`, or `7d`, or null for `never`. */
export function parseDuration(text: string): number | null {
  if (!DURATION_PATTERN.test(text)) {
    throw new SandboxError('usage', `"${text}" is not a duration. Use minutes, hours, or days, such as 90m, 8h, or 7d, or never.`)
  }
  if (text === 'never') return null
  const unit = { m: 60_000, h: 60 * 60_000, d: 24 * 60 * 60_000 }[text.slice(-1) as 'm' | 'h' | 'd']
  return Number(text.slice(0, -1)) * unit
}

const isCode = (error: unknown, ...codes: string[]) => error instanceof SandboxError && codes.includes(error.code)
const newest = <T extends { createdAt: string | null }>(items: T[]): T | undefined =>
  [...items].sort((a, b) => Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? '') || 0)[0]

/** Parses `runtime/session.env`: the session's display and buses, which commands need to join it. */
export function parseEnv(text: string): Record<string, string> {
  const entries = text.split('\n').flatMap((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
    return match ? [[match[1]!, match[2]!] as const] : []
  })
  return Object.fromEntries(entries)
}

function checkName(name: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw new SandboxError('invalid_name', `"${name}" is not a valid name. Use 1 to 24 lowercase letters, digits, and dashes.`)
  }
  return name
}

function toSandbox(machine: Machine): SandboxInfo {
  return {
    name: machine.name.slice(MACHINE_PREFIX.length),
    state: machine.state,
    viewerPort: machine.ports.find((port) => port.guest === VIEWER_PORT)?.host ?? null,
    createdAt: machine.createdAt,
    deleteAfter: machine.deleteAfter,
  }
}

const tail = (text: string, lines = 15) => text.trim().split('\n').slice(-lines).join('\n')

/** Splits streamed output into lines, and passes on those that start with `prefix`. */
function lineReader(prefix: string, onLine: (line: string) => void): (text: string) => void {
  let pending = ''
  return (text) => {
    const lines = (pending + text).split('\n')
    pending = lines.pop()!
    for (const line of lines) if (line.startsWith(prefix)) onLine(line.slice(prefix.length))
  }
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && !relative(dir, join(entry.parentPath, entry.name)).split(sep).some((part) => part.startsWith('.') || part === '__pycache__'))
    .map((entry) => join(entry.parentPath, entry.name))
}

// Shell and Python files, and the scripts library's commands, which have no extension.
const executable = (path: string) => /\.(sh|py)$/.test(path) || /^scripts\/[^/.]+$/.test(path)

/** The sandbox's guest helper predates this package: it lacks an operation, or the sandbox has none. */
const outdated = (result: ExecResult) =>
  result.exitCode === 2 && ((result.stdout.includes('"code": "usage"') && result.stdout.includes('Operations:')) || /can't open file .*guest\.py/.test(result.stderr))

/**
 * The sandbox engine: sandboxes on one backend. It runs where the backend runs, and is what the tRPC
 * router serves; clients reach it in-process or over HTTP, so nothing here assumes a disk shared with
 * the client. Media goes back as bytes or streams, and recipe files come in as bytes. It keeps no state
 * of its own about the backend's machines: what it needs to find again, such as a recipe's base, it
 * finds by labels and names in the backend.
 *
 * The first new sandbox of a recipe installs a base sandbox, which takes a few minutes. Later sandboxes
 * of that recipe are made from it and start in seconds: from a snapshot of it where the backend takes
 * snapshots, as copies of it where the backend branches machines, and from scratch where it does neither.
 */
export class Sandboxes {
  readonly backend: Backend
  readonly #capabilities: Capabilities
  readonly #deleteAfter: string
  readonly #viewerUp: (url: string, headers: Record<string, string>) => Promise<boolean>
  readonly #playwrightDir: () => Promise<string>
  readonly #now: () => number
  readonly #pollMs: number

  constructor(backend: Backend, options: SandboxesOptions = {}) {
    this.backend = backend
    this.#capabilities = backend.capabilities()
    this.#deleteAfter = options.deleteAfter ?? DEFAULT_DELETE_AFTER
    parseDuration(this.#deleteAfter)
    this.#viewerUp = options.viewerUp ?? answers
    this.#playwrightDir = options.playwrightDir ?? playwrightCoreDir
    this.#now = options.now ?? Date.now
    this.#pollMs = options.pollMs ?? 300
  }

  check(): Promise<BackendStatus> {
    return this.backend.check()
  }

  /** The built-in recipes, with the callbacks their steps ask for. */
  recipes(): ReturnType<typeof describeBuiltinRecipes> {
    return describeBuiltinRecipes()
  }

  async list(): Promise<SandboxInfo[]> {
    const machines = await this.backend.list()
    return machines
      .filter((machine) => machine.name.startsWith(MACHINE_PREFIX) && NAME_PATTERN.test(machine.name.slice(MACHINE_PREFIX.length)))
      .map(toSandbox)
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
  }

  /**
   * Creates the sandbox, or starts it when it exists, waits until its viewer answers, and runs its
   * recipe's steps when it is new.
   */
  async start(name: string, options: StartOptions = {}): Promise<Started> {
    const machineName = MACHINE_PREFIX + checkName(name)
    const progress = options.onProgress ?? (() => {})
    if (options.resolution !== undefined && !RESOLUTION_PATTERN.test(options.resolution)) {
      throw new SandboxError('usage', `The resolution must look like 1600x1000, not ${options.resolution}.`)
    }
    parseDuration(options.deleteAfter ?? this.#deleteAfter)
    let machine = await this.backend.get(machineName)
    let from: Started['from'] = null
    let recipe = options.recipe ?? null
    if (!machine) {
      recipe ??= await loadBuiltinRecipe(DEFAULT_RECIPE)
      ;({ machine, from } = await this.#create(machineName, recipe, options, progress))
    } else {
      if (machine.state !== 'running') {
        progress('Starting the machine')
        machine = await this.backend.start(machineName)
      }
    }
    await this.#waitBoot(name, machineName)
    if (from === null) {
      const own = await this.#recipeOf(machineName)
      if (recipe && recipe.id !== own.id) {
        throw new SandboxError('recipe_mismatch', `${name} was made with the ${own.id} recipe, not ${recipe.id}. Use a new sandbox for ${recipe.id}.`)
      }
      // A newer copy of the same recipe replaces the sandbox's, so fixes to its steps apply.
      recipe ??= own
    }
    recipe ??= await loadBuiltinRecipe(DEFAULT_RECIPE)
    await this.#install(machineName, recipe)
    if ((await this.backend.exec(machineName, ['test', '-e', READY_FILE])).exitCode !== 0) {
      await this.#setup(name, machineName, recipe, progress)
    }

    const boot = await this.backend.exec(machineName, ['bash', `${RUNTIME_DIR}/boot.sh`, options.resolution ?? DEFAULT_RESOLUTION], { timeoutSeconds: 600 })
    lineReader('blobby-boot: ', progress)(`${boot.stderr}\n`)
    if (boot.exitCode !== 0) throw new SandboxError('session_failed', `The desktop session in ${name} did not start:\n${tail(boot.stderr)}`)
    const info = Object.fromEntries([...boot.stdout.matchAll(/^blobby-info: (\S+) (.*)$/gm)].map((match) => [match[1]!, match[2]!.trim()]))
    if (/^blobby-boot: running$/m.test(boot.stdout) && options.resolution) {
      const [width, height] = options.resolution.split('x').map(Number)
      await this.#guest(machineName, 'resize', { width, height })
    }

    if (this.#hasViewer()) await this.#waitViewer(name, await this.#viewer(name, machineName))
    else progress(`The ${this.backend.name} backend has no viewer yet; see ${name} with \`blobby-sandbox screenshot ${name}\``)
    const sandbox = toSandbox((await this.backend.get(machineName)) ?? machine)
    if (/^blobby-boot: started$/m.test(boot.stdout)) await this.#waitShell(machineName, progress)

    const steps: StepResult[] = []
    const runSteps = options.steps === 'always' || (options.steps !== 'never' && from !== null)
    // Recipe steps and the scripts library drive apps with it; a sandbox made from a base has it already.
    if (from !== null || (runSteps && recipe.spec.steps.length)) await this.#installPlaywright(machineName)
    if (runSteps && recipe.spec.steps.length) {
      for (const step of recipe.spec.steps) {
        try {
          steps.push(await this.#runStep(name, machineName, recipe, step, options, progress))
        } catch (error) {
          if (!(error instanceof SandboxError) || error.code === 'cancelled') throw error
          throw new SandboxError(error.code, `${name} is running, but ${error.message} Run \`blobby-sandbox start ${name} --steps\` to run its steps again.`)
        }
      }
    }
    return { sandbox: { ...sandbox, state: 'running' }, created: from !== null, from, recipe: recipe.id, info, steps, viewer: this.#hasViewer() }
  }

  /**
   * Where the viewer is reached from where the engine runs, and its password. Clients turn the endpoint
   * into a URL they can reach: directly in-process, or through `blobby-sandbox serve`'s relay.
   */
  async view(name: string): Promise<{ endpoint: Endpoint; password: string }> {
    if (!this.#hasViewer()) {
      throw new SandboxError('unsupported', `The ${this.backend.name} backend has no viewer yet. See ${name} with \`blobby-sandbox screenshot ${name}\`, or record it.`)
    }
    const machine = await this.#running(name)
    const password = (await this.backend.exec(machine.name, ['cat', PASSWORD_FILE])).stdout.trim()
    const notSetUp = () => new SandboxError('not_set_up', `${name} is not set up yet. Run \`blobby-sandbox start ${name}\`.`)
    if (!password) throw notSetUp()
    const endpoint = await this.backend.endpoint(machine.name, VIEWER_PORT).catch((error: unknown) => {
      throw isCode(error, 'not_published') ? notSetUp() : error
    })
    return { endpoint, password }
  }

  async stop(name: string): Promise<void> {
    const machine = await this.#find(name)
    if (machine.state === 'running') await this.backend.stop(machine.name)
  }

  async remove(name: string): Promise<void> {
    await this.backend.remove((await this.#find(name)).name)
    await this.#removeOldBases(null, null)
  }

  /**
   * Runs a command in the sandbox, in its desktop session, so it can open windows and drive them: as the
   * desktop user, or with `user: 'root'` for system changes such as installing packages, where apt
   * doesn't prompt.
   */
  async exec(name: string, command: readonly string[], options: SandboxExecOptions = {}): Promise<SandboxExecResult> {
    if (options.secret !== undefined) return this.#execWithSecret(name, command, options)
    // Only the session's variables and the caller's go in, never the host's, and never credentials.
    const env = checkGuestEnv(options.env)
    const machine = await this.#running(name)
    const user = options.user ?? DESKTOP_USER
    const home: Record<string, string> = user === 'root' ? { HOME: '/root', DEBIAN_FRONTEND: 'noninteractive' } : user === DESKTOP_USER ? { HOME: `/home/${DESKTOP_USER}` } : {}
    // Through the guest helper, which puts the scripts library on the command's PATH.
    const run = async () =>
      this.backend.exec(machine.name, ['python3', GUEST, 'exec', '--', ...command], { ...options, user, env: { ...(await this.#sessionEnv()), ...home, ...env } })
    let result = await run()
    if (outdated(result)) {
      await this.#installRuntime(machine.name)
      result = await run()
    }
    return result
  }

  async screenshot(name: string): Promise<Screenshot> {
    const machine = await this.#usable(name)
    const shot = await this.#guest<{ png: string; width: number; height: number }>(machine, 'screenshot')
    return { png: Buffer.from(shot.png, 'base64'), width: shot.width, height: shot.height }
  }

  /** Clicks, moves the pointer, types, presses keys, or scrolls, by screen coordinates. */
  async input(name: string, action: InputAction): Promise<void> {
    await this.#guest(await this.#usable(name), 'input', action)
  }

  /** The visible, named elements of the desktop's accessibility tree, optionally of one app or matching some text. */
  async ui(name: string, query: UiQuery = {}): Promise<{ nodes: AccessibleNode[]; truncated: boolean }> {
    const result = await this.#guest<{ nodes: AccessibleNode[]; truncated: boolean }>(await this.#usable(name), 'ui.snapshot', { ...query, max: query.max ?? 300 })
    return { nodes: result.nodes, truncated: result.truncated }
  }

  /** Presses, focuses, or sets the text of an element, by the path a snapshot gave it. */
  /**
   * Waits until an element matches, or with `gone`, until none does. It polls the accessibility tree in
   * the sandbox, so it costs one call however long it waits. Fails with `wait_timeout`.
   */
  async waitFor(name: string, wait: UiWait): Promise<UiWaited> {
    const seconds = wait.timeoutSeconds ?? 30
    const result = await this.#guest<UiWaited>(await this.#usable(name), 'ui.wait', { ...wait, timeoutSeconds: seconds }, seconds + 30)
    return { found: result.found, nodes: result.nodes, waitedMs: result.waitedMs }
  }

  async act(name: string, act: UiAct): Promise<{ path: string; name: string; did: string }> {
    const result = await this.#guest<{ path: string; name: string; did: string }>(await this.#usable(name), 'ui.act', act)
    return { path: result.path, name: result.name, did: result.did }
  }

  /** Starts recording the screen in the desktop. It stops by itself after `maxSeconds`. */
  async recordStart(name: string, options: { maxSeconds?: number } = {}): Promise<{ id: string; maxSeconds: number }> {
    const result = await this.#guest<{ id: string; maxSeconds: number }>(await this.#usable(name), 'record.start', { maxSeconds: options.maxSeconds ?? 600 })
    return { id: result.id, maxSeconds: result.maxSeconds }
  }

  /** Stops the recording. The video stays in the desktop until `mediaDelete`; read it with `mediaRead`. */
  async recordStop(name: string): Promise<RecordingInfo> {
    const result = await this.#guest<RecordingInfo>((await this.#running(name)).name, 'record.stop', {}, 60)
    return { id: result.id, size: result.size, sha256: result.sha256, seconds: result.seconds }
  }

  /** Streams a recording, or a byte range of it, from the sandbox, without holding it in memory. */
  async mediaStream(name: string, id: string, range?: ReadRange): Promise<{ stream: Readable; size: number }> {
    const machine = await this.#running(name)
    if (!MEDIA_ID.test(id)) throw new SandboxError('invalid_id', 'A recording ID is 8 to 64 lowercase hex characters.')
    const path = `${MEDIA_DIR}/${id}.mp4`
    const info = await this.backend.stat(machine.name, path)
    if (!info) throw new SandboxError('not_found', 'There is no such recording in the desktop.')
    return { stream: await this.backend.readFile(machine.name, path, range), size: info.size }
  }

  /** Reads up to `length` bytes of a recording from `offset`. Remote clients read in chunks, so videos never need a shared disk. */
  async mediaRead(name: string, id: string, offset: number, length: number): Promise<{ data: Uint8Array; eof: boolean }> {
    const { stream, size } = await this.mediaStream(name, id, { offset, length })
    const data = await collectStream(stream)
    return { data, eof: offset + data.length >= size }
  }

  async mediaDelete(name: string, id: string): Promise<void> {
    await this.#guest((await this.#running(name)).name, 'media.delete', { id })
  }

  /** Runs one operation of the desktop's guest helper, `runtime/guest.py`. */
  async #guest<T>(machineName: string, operation: string, options: object = {}, timeoutSeconds = 60): Promise<T> {
    const run = async () =>
      this.backend.exec(machineName, ['python3', GUEST, operation, JSON.stringify(options)], { user: DESKTOP_USER, env: await this.#sessionEnv(), timeoutSeconds })
    let result = await run()
    // A sandbox started by an older blobby-sandbox gets this version's runtime, once.
    if (outdated(result)) {
      await this.#installRuntime(machineName)
      result = await run()
    }
    let parsed: { ok?: boolean; code?: string; error?: string } & Record<string, unknown>
    try {
      parsed = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '')
    } catch {
      throw new SandboxError('guest_failed', `The desktop's ${operation} failed: ${tail(result.stderr, 3) || `exit ${result.exitCode}`}`)
    }
    if (!parsed.ok) throw new SandboxError(parsed.code ?? 'guest_failed', parsed.error ?? `The desktop's ${operation} failed.`)
    return parsed as T
  }

  /** The recipe a sandbox was created with: the newest built-in version, or its own copy of a custom one. */
  async #recipeOf(machineName: string): Promise<Recipe> {
    const recorded = (await this.backend.exec(machineName, ['cat', RECIPE_ID_FILE])).stdout.trim()
    // A sandbox without a recorded recipe has the default one.
    const id = recorded || DEFAULT_RECIPE
    if ((await builtinRecipeIds()).includes(id)) return loadBuiltinRecipe(id)
    const listing = await this.backend.exec(machineName, ['find', RECIPE_DIR, '-type', 'f'])
    const files = new Map<string, Uint8Array>()
    for (const path of listing.stdout.split('\n').filter(Boolean)) {
      files.set(relative(RECIPE_DIR, path), await readAll(this.backend, machineName, path))
    }
    return parseRecipe(id, files, false)
  }

  async #installRuntime(machineName: string): Promise<void> {
    for (const file of await filesUnder(runtimeDir)) {
      const path = relative(runtimeDir, file).split(sep).join('/')
      await this.backend.writeFile(machineName, `${RUNTIME_DIR}/${path}`, await readFile(file), { mode: executable(path) ? 0o755 : 0o644 })
    }
    await this.backend.exec(machineName, ['chmod', '-R', 'a+rX', RUNTIME_DIR])
  }

  /** Copies this package's runtime and the recipe into the sandbox, so it runs these versions of them. */
  async #install(machineName: string, recipe: Recipe): Promise<void> {
    await this.#installRuntime(machineName)
    if (recipe.files.size) {
      await this.backend.exec(machineName, ['rm', '-rf', RECIPE_DIR])
      for (const [path, data] of recipe.files) await this.backend.writeFile(machineName, `${RECIPE_DIR}/${path}`, data, { mode: executable(path) ? 0o755 : 0o644 })
    }
    await this.backend.writeFile(machineName, RECIPE_ID_FILE, Buffer.from(`${recipe.id}\n`), { mode: 0o644 })
    await this.backend.exec(machineName, ['chmod', '-R', 'a+rX', '/opt/blobby'])
  }

  /**
   * Makes the new sandbox from its recipe's base: from a snapshot of it, or as a copy of it. It installs
   * the sandbox from scratch on a backend that can do neither, for sizes and network policies a base
   * can't give, and when copying fails.
   */
  async #create(machineName: string, recipe: Recipe, options: StartOptions, progress: (line: string) => void): Promise<{ machine: Machine; from: 'base' | 'scratch' }> {
    const capabilities = this.#capabilities
    const network = options.network ?? 'internet'
    const enforced = this.#network(network, options.allowUnenforcedNetwork ?? false, progress)
    const gpu = options.gpu ?? capabilities.gpu
    const ttl = parseDuration(options.deleteAfter ?? this.#deleteAfter)
    const create: Omit<CreateOptions, 'image'> = {
      name: machineName,
      resources: { cpus: options.cpus ?? DEFAULT_CPUS, memoryMb: options.memoryMb ?? DEFAULT_MEMORY_MB, storageGb: STORAGE_GB, gpu },
      // Fixed at create, which backends without publish need. Backends with neither have no viewer.
      ports: capabilities.ports ? [{ guest: VIEWER_PORT }] : [],
      labels: { [KIND_LABEL]: 'desktop' },
      network,
      allowUnenforcedNetwork: options.allowUnenforcedNetwork ?? false,
    }
    if (ttl !== null) create.deleteAfter = new Date(this.#now() + ttl)
    if (capabilities.snapshot) {
      const snapshot = await this.#baseSnapshot(recipe, progress)
      progress(`Creating the sandbox from the ${recipe.id} recipe's base`)
      try {
        return { machine: await this.backend.createFrom!(snapshot, create), from: 'base' }
      } catch (error) {
        // Some backends, such as azure, make machines from a snapshot only at the snapshot's size.
        const custom = (options.cpus ?? DEFAULT_CPUS) !== DEFAULT_CPUS || (options.memoryMb ?? DEFAULT_MEMORY_MB) !== DEFAULT_MEMORY_MB
        if (custom && isCode(error, 'unsupported')) {
          progress(`The ${recipe.id} recipe's base can't be resized on the ${this.backend.name} backend, so this sandbox is installed from scratch at the size asked for. This takes a few minutes.`)
        } else if (isCode(error, 'already_exists', 'invalid_options', 'network_unenforceable', 'unsupported', 'limit_reached')) {
          throw error
        } else {
          progress(`Could not create the sandbox from its base (${(error as Error).message}). Installing this one from scratch.`)
        }
      }
    } else if (capabilities.branch && capabilities.publish) {
      // A copy keeps its base's size, GPU, and network.
      const custom = (options.cpus ?? DEFAULT_CPUS) !== DEFAULT_CPUS || (options.memoryMb ?? DEFAULT_MEMORY_MB) !== DEFAULT_MEMORY_MB || gpu !== capabilities.gpu
      if (!custom && (!enforced || networkPolicyKind(network) === 'internet')) {
        const copy = await this.#branchBase(machineName, recipe, progress)
        if (copy) return { machine: copy, from: 'base' }
      }
    }
    progress('Creating the machine')
    return { machine: await this.backend.create({ ...create, image: BASE_IMAGE }), from: 'scratch' }
  }

  /** Fails closed for a network policy the backend can't enforce, unless allowed, and warns then. Whether it is enforced. */
  #network(network: NetworkPolicy, allowUnenforced: boolean, progress: (line: string) => void): boolean {
    const kind = networkPolicyKind(network)
    if (this.#capabilities.networkPolicies.includes(kind)) return true
    const enforced = this.#capabilities.networkPolicies.join(', ') || 'none'
    if (!allowUnenforced) {
      throw new SandboxError(
        'network_unenforceable',
        `The ${this.backend.name} backend can't enforce the ${kind} network policy (it enforces: ${enforced}). Ask for one it enforces, or use another backend.`,
      )
    }
    progress(`Warning: the ${this.backend.name} backend can't enforce the ${kind} network policy, so this sandbox's network is unrestricted. Use this for local development only.`)
    return false
  }

  /** The name and labels of this recipe's base, for this version of what the base installs. */
  async #baseOf(recipe: Recipe): Promise<{ name: string; labels: Record<string, string> }> {
    // Only what a base installs decides it. The rest of the runtime and the recipe is copied in on every start.
    // Bases made before they were labeled and marked as finished have other names, so they are never copied.
    const digest = createHash('sha256').update('base-v2\0').update(BASE_IMAGE).update('\0').update(await readFile(join(runtimeDir, 'setup.sh'))).update('\0')
    digest.update(recipe.files.get('setup.sh') ?? new Uint8Array()).update('\0')
    digest.update(await readFile(join(await this.#playwrightDir(), 'package.json')))
    const hash = digest.digest('hex').slice(0, 12)
    return {
      name: BASE_PREFIX + hash,
      labels: { [BASE_LABEL]: hash, [RECIPE_LABEL]: recipe.id, [IMAGE_LABEL]: BASE_IMAGE, [RUNTIME_LABEL]: await packageVersion() },
    }
  }

  /**
   * Installs a recipe's base as the machine `name`. Returns false, having done nothing, when another
   * process is installing it. A base that fails to install is removed.
   */
  async #installBase(base: { name: string; labels: Record<string, string> }, recipe: Recipe, branchable: boolean, progress: (line: string) => void): Promise<boolean> {
    const create: CreateOptions = {
      name: base.name,
      image: BASE_IMAGE,
      resources: { cpus: DEFAULT_CPUS, memoryMb: DEFAULT_MEMORY_MB, storageGb: STORAGE_GB, gpu: this.#capabilities.gpu },
      ports: [],
      labels: { ...base.labels, [KIND_LABEL]: 'desktop' },
      branchable,
    }
    // A snapshot outlives the machine it is taken from, so that machine can go once its install is over or abandoned.
    if (!branchable) create.deleteAfter = new Date(this.#now() + STALE_BASE_MS)
    try {
      await this.backend.create(create)
    } catch (error) {
      if (isCode(error, 'already_exists')) return false
      throw error
    }
    progress(`Installing the ${recipe.id} recipe's base. This takes a few minutes, once; later ${recipe.id} sandboxes start from it in seconds.`)
    try {
      await this.#waitBoot('the base sandbox', base.name)
      await this.#install(base.name, recipe)
      await this.#setup('the base sandbox', base.name, recipe, progress)
      await this.#installPlaywright(base.name)
      await this.backend.exec(base.name, ['bash', '-c', `date -u +%FT%TZ > ${BASE_READY_FILE}`])
    } catch (error) {
      await this.backend.remove(base.name).catch(() => {})
      throw error
    }
    return true
  }

  /** Waits for another process's install of a base, or gives up when it takes longer than an install can. */
  async #waitForBase(base: string, recipe: Recipe, since: number, waited: boolean, progress: (line: string) => void): Promise<void> {
    if (this.#now() - since > STALE_BASE_MS) {
      throw new SandboxError('base_timeout', `The ${recipe.id} recipe's base did not finish installing. Run \`blobby-sandbox start\` again; if it says the same, remove ${base} from the backend.`)
    }
    if (!waited) progress(`Waiting for another install of the ${recipe.id} recipe's base`)
    await delay(this.#pollMs * 30)
  }

  /** Whether a base that is not finished is too old to be still installing. */
  #abandoned(machine: Machine): boolean {
    return machine.createdAt !== null && this.#now() - Date.parse(machine.createdAt) > STALE_BASE_MS
  }

  /** The ID of this recipe's base snapshot, installing it first if there is none. */
  async #baseSnapshot(recipe: Recipe, progress: (line: string) => void): Promise<string> {
    const base = await this.#baseOf(recipe)
    const since = this.#now()
    for (let waited = false; ; waited = true) {
      const found = newest(await this.backend.snapshots!({ labels: { [BASE_LABEL]: base.labels[BASE_LABEL]! } }))
      if (found) return found.id
      const installing = await this.backend.get(base.name)
      if (installing && this.#abandoned(installing)) {
        await this.backend.remove(base.name)
        continue
      }
      if (!installing && (await this.#installBase(base, recipe, false, progress))) {
        let snapshot: Snapshot
        try {
          progress(`Saving the ${recipe.id} recipe's base`)
          snapshot = await this.backend.snapshot!(base.name, { labels: base.labels })
        } finally {
          await this.backend.remove(base.name).catch(() => {})
        }
        await this.#removeOldBases(recipe.id, base.labels[BASE_LABEL]!)
        return snapshot.id
      }
      await this.#waitForBase(base.name, recipe, since, waited, progress)
    }
  }

  /**
   * Copies the new sandbox from this recipe's base machine, installing the base first if there is none.
   * The copy shows whether the base was finished: a copy of an unfinished one is removed again. Null when
   * the base can't be copied.
   */
  async #branchBase(machineName: string, recipe: Recipe, progress: (line: string) => void): Promise<Machine | null> {
    const base = await this.#baseOf(recipe)
    const since = this.#now()
    for (let waited = false; ; waited = true) {
      const existing = await this.backend.get(base.name)
      if (!existing) {
        if (await this.#installBase(base, recipe, true, progress)) await this.#removeOldBases(recipe.id, base.labels[BASE_LABEL]!)
        continue
      }
      if (existing.state !== 'running') await this.backend.start(base.name)
      progress(`Copying the ${recipe.id} recipe's base`)
      let copy: Machine
      try {
        copy = await this.backend.branch!(base.name, machineName)
      } catch (error) {
        progress(`Could not copy the installed base (${(error as Error).message}). Installing this one from scratch.`)
        return null
      }
      await this.#waitBoot(machineName, machineName)
      if ((await this.backend.exec(machineName, ['test', '-e', BASE_READY_FILE])).exitCode === 0) return copy
      await this.backend.remove(machineName)
      if (this.#abandoned(existing)) {
        if (await this.backend.remove(base.name).then(() => true, () => false)) continue
        progress(`The ${recipe.id} recipe's base ${base.name} was never finished, and can't be removed while it has copies. Installing this one from scratch.`)
        return null
      }
      await this.#waitForBase(base.name, recipe, since, waited, progress)
    }
  }

  /**
   * Removes bases that are not the newest of their recipe, once nothing needs them: the backend refuses
   * to remove a snapshot that machines were made from, or a machine that has copies. With `recipe` and
   * `keep` (a base hash), it removes only that recipe's other bases. Bases without a recipe label are the
   * default recipe's.
   */
  async #removeOldBases(recipe: string | null, keep: string | null): Promise<void> {
    type Base = { id: string; recipe: string; hash: string | undefined; createdAt: string | null }
    const bases: Base[] = this.#capabilities.snapshot
      ? (await this.backend.snapshots!()).filter((snapshot) => snapshot.labels[BASE_LABEL]).map((snapshot) => ({
          id: snapshot.id,
          recipe: snapshot.labels[RECIPE_LABEL] ?? DEFAULT_RECIPE,
          hash: snapshot.labels[BASE_LABEL],
          createdAt: snapshot.createdAt,
        }))
      : (await this.backend.list())
          .filter((machine) => machine.name.startsWith(BASE_PREFIX))
          .map((machine) => ({ id: machine.name, recipe: machine.labels[RECIPE_LABEL] ?? DEFAULT_RECIPE, hash: machine.labels[BASE_LABEL] ?? machine.name.slice(BASE_PREFIX.length), createdAt: machine.createdAt }))
    const kept = new Set<string>()
    if (recipe === null) {
      for (const of of new Set(bases.map((base) => base.recipe))) kept.add(newest(bases.filter((base) => base.recipe === of))!.id)
    }
    for (const base of bases) {
      if (recipe !== null ? base.recipe !== recipe || base.hash === keep : kept.has(base.id)) continue
      // A base that is still installing is not a snapshot yet, and a base machine that is still installing is the newest.
      if (this.#capabilities.snapshot) await this.backend.removeSnapshot!(base.id).catch(() => {})
      else await this.backend.remove(base.id).catch(() => {})
    }
  }

  async #setup(label: string, machineName: string, recipe: Recipe, progress: (line: string) => void): Promise<void> {
    if (!machineName.startsWith(BASE_PREFIX)) progress('Installing the sandbox. This takes a few minutes.')
    const scripts = [`${RUNTIME_DIR}/setup.sh`, ...(recipe.files.has('setup.sh') ? [`${RECIPE_DIR}/setup.sh`] : [])]
    for (const script of scripts) {
      const setupLines = lineReader('blobby-setup: ', progress)
      const result = await this.backend.exec(machineName, ['bash', script], {
        timeoutSeconds: SETUP_SECONDS,
        onOutput: (chunk) => {
          if (chunk.stream === 'stdout') setupLines(chunk.text)
        },
      })
      if (result.exitCode !== 0) {
        throw new SandboxError('setup_failed', `Installing ${label} failed in ${script}:\n${tail(result.stderr)}\nRun \`blobby-sandbox start\` again to retry.`)
      }
    }
    await this.backend.exec(machineName, ['bash', '-c', `date -u +%FT%TZ > ${READY_FILE}`])
  }

  /** Copies playwright-core in from this package's own install, for recipe steps and scripts, unless the sandbox has this version. */
  async #installPlaywright(machineName: string): Promise<void> {
    const dir = await this.#playwrightDir()
    const manifest = await readFile(join(dir, 'package.json'))
    const target = `${NODE_MODULES}/playwright-core`
    const current = await this.backend.exec(machineName, ['cat', `${target}/package.json`])
    if (current.exitCode === 0 && current.stdout === manifest.toString('utf8')) return
    await this.backend.exec(machineName, ['rm', '-rf', target])
    for (const file of await filesUnder(dir)) {
      const mode = ((await stat(file)).mode & 0o111) !== 0 ? 0o755 : 0o644
      await this.backend.writeFile(machineName, `${target}/${relative(dir, file)}`, await readFile(file), { mode })
    }
    await this.backend.exec(machineName, ['chmod', '-R', 'a+rX', NODE_MODULES])
  }

  /**
   * Runs one recipe step in the background, polls it, and passes the callbacks it asks for to the
   * client. The sandbox stays usable meanwhile: test accounts are assumed exposed to anything in it.
   */
  async #runStep(name: string, machineName: string, recipe: Recipe, step: RecipeStep, options: StartOptions, progress: (line: string) => void): Promise<StepResult> {
    const id = randomBytes(8).toString('hex')
    const callbacks = Object.fromEntries(step.uses.map((use) => [use, { sensitive: Boolean(recipe.spec.callbacks[use]?.sensitive) }]))
    // Answers, audits, and redacts through the resolver, against the step as started here.
    const answers = new StepCallbacks({
      sandbox: name,
      feature: recipe.id,
      step: { id, name: step.name, uses: step.uses },
      callbacks,
      bindings: options.bindings,
      resolver: options.resolver ?? options.onRequest,
      onAudit: options.onAudit,
      progress,
      signal: options.signal,
      now: this.#now,
    })
    const run = async (): Promise<StepResult> => {
      progress(step.name)
      await this.#guest(machineName, 'step.start', { id, sandbox: name, callbacks, run: step.run, cwd: RECIPE_DIR })
      const deadline = this.#now() + (step.timeoutSeconds ?? STEP_SECONDS) * 1000
      const handled = new Set<string>()
      let offset = 0
      try {
        for (;;) {
          options.signal?.throwIfAborted()
          const poll = await this.#guest<StepPoll>(machineName, 'step.poll', { id, offset })
          offset = poll.offset
          for (const line of poll.progress) progress(answers.redact(line))
          for (const request of poll.requests) {
            if (handled.has(request.id)) continue
            handled.add(request.id)
            const answer = await answers.answer({ ...request, sandbox: name, feature: recipe.id, step: id, stepName: step.name })
            await this.#guest(machineName, 'step.answer', { id, request: request.id, answer })
          }
          if (poll.exit !== null) {
            if (poll.exit !== 0) throw new SandboxError('step_failed', answers.redact(`"${step.name}" failed: ${poll.error ?? `it exited with code ${poll.exit}`}`))
            return { name: step.name, result: await answers.result(poll.result ?? {}) }
          }
          if (this.#now() > deadline) throw new SandboxError('step_timeout', `"${step.name}" did not finish in ${step.timeoutSeconds ?? STEP_SECONDS} seconds.`)
          await delay(this.#pollMs)
        }
      } finally {
        await this.#guest(machineName, 'step.stop', { id }).catch(() => {})
      }
    }
    return answers.run(run)
  }

  /**
   * Runs a command as a step that may ask for fields of one secret: in the background, polled, its
   * output streamed a line at a time and redacted, its requests answered through the resolver.
   */
  async #execWithSecret(name: string, command: readonly string[], options: SandboxExecOptions): Promise<SandboxExecResult> {
    const secret = options.secret!
    if (!SECRET_NAME.test(secret)) throw new SandboxError('invalid_secret', `"${secret}" is not a valid secret name. Use lowercase letters, digits, and dashes.`)
    if (!command.length) throw new SandboxError('usage', 'Give the command to run.')
    if ((options.user !== undefined && options.user !== DESKTOP_USER) || options.env !== undefined || options.stdin !== undefined) {
      throw new SandboxError('usage', 'A command with a secret runs as the desktop user, without env or stdin.')
    }
    const machine = await this.#running(name)
    const id = randomBytes(8).toString('hex')
    const callbacks = Object.fromEntries(Object.entries(SECRET_FIELDS).map(([field, callback]) => [`${secret}.${field}`, callback]))
    let stdout = ''
    let stderr = ''
    const note = (line: string) => {
      stderr += `${line}\n`
      options.onOutput?.({ stream: 'stderr', text: `${line}\n` })
    }
    const seconds = options.timeoutSeconds ?? SECRET_EXEC_SECONDS
    // Aborted at the deadline or when the caller cancels, so a request nobody answers can't hold the command open.
    const stop = new AbortController()
    const timer = setTimeout(() => stop.abort(TIMED_OUT), seconds * 1000)
    const cancel = () => stop.abort(options.signal!.reason)
    if (options.signal?.aborted) cancel()
    else options.signal?.addEventListener('abort', cancel, { once: true })
    const race = <T>(promise: Promise<T>) => untilAborted(promise, stop.signal)
    const answers = new StepCallbacks({
      sandbox: name,
      feature: 'exec',
      step: { id, name: command.join(' ').slice(0, 200), uses: Object.keys(callbacks) },
      callbacks,
      resolver: options.resolver ?? options.onRequest,
      onAudit: options.onAudit,
      progress: note,
      signal: stop.signal,
      now: this.#now,
    })
    const output = new RedactedStream((text) => answers.redact(text))
    const emit = (text: string) => {
      if (!text) return
      stdout += text
      options.onOutput?.({ stream: 'stdout', text })
    }
    const run = async (): Promise<SandboxExecResult> => {
      await this.#guest(machine.name, 'step.start', { id, sandbox: name, callbacks, argv: [...command], secret })
      const deadline = this.#now() + seconds * 1000
      const handled = new Set<string>()
      let offset = 0
      let outputOffset = 0
      try {
        for (;;) {
          stop.signal.throwIfAborted()
          const poll = await race(this.#guest<StepPoll>(machine.name, 'step.poll', { id, offset, outputOffset }))
          offset = poll.offset
          outputOffset = poll.outputOffset ?? outputOffset
          for (const line of poll.progress) note(answers.redact(line))
          if (poll.output) emit(output.push(poll.output))
          for (const request of poll.requests) {
            if (handled.has(request.id)) continue
            handled.add(request.id)
            const answer = await race(answers.answer({ ...request, sandbox: name, feature: 'exec', step: id, stepName: answers.context.step.name }))
            await race(this.#guest(machine.name, 'step.answer', { id, request: request.id, answer }))
          }
          if (poll.exit !== null && poll.outputDone !== false) {
            emit(output.flush())
            const error = poll.error ? answers.redact(poll.error) : ''
            // A step's own error (from `run`) is not in its output; the tail of the output already is.
            if (poll.exit !== 0 && error && !stdout.includes(error.split(' / ').at(-1)!)) note(error)
            const result = poll.result && Object.keys(poll.result).length ? await race(answers.result(poll.result)) : undefined
            return { exitCode: poll.exit, stdout, stderr, ...(result ? { result } : {}) }
          }
          if (this.#now() > deadline) stop.abort(TIMED_OUT)
          else if (!poll.output) await race(delay(this.#pollMs))
        }
      } catch (error) {
        if (!stop.signal.aborted) throw error
        if (stop.signal.reason !== TIMED_OUT) throw new SandboxError('cancelled', `The command in ${name} was cancelled.`)
        emit(output.flush())
        note(`The command did not finish in ${seconds} seconds, so it was stopped.`)
        return { exitCode: 124, stdout, stderr }
      } finally {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', cancel)
        await this.#guest(machine.name, 'step.stop', { id }).catch(() => {})
      }
    }
    return answers.run(run)
  }

  async #usable(name: string): Promise<string> {
    return (await this.#running(name)).name
  }

  async #sessionEnv(): Promise<Record<string, string>> {
    return parseEnv(await readFile(join(runtimeDir, 'session.env'), 'utf8'))
  }

  async #find(name: string): Promise<Machine> {
    const machine = await this.backend.get(MACHINE_PREFIX + checkName(name))
    if (!machine) throw new SandboxError('not_found', `There is no sandbox named ${name} on the ${this.backend.name} backend. See \`blobby-sandbox list\`, or pick the backend it's on with --backend.`)
    return machine
  }

  async #running(name: string): Promise<Machine> {
    const machine = await this.#find(name)
    if (machine.state !== 'running') throw new SandboxError('not_running', `${name} is not running. Run \`blobby-sandbox start ${name}\`.`)
    return machine
  }

  /** A started machine runs commands only once its guest agent is up. */
  async #waitBoot(label: string, machineName: string): Promise<void> {
    const deadline = Date.now() + BOOT_MS
    for (;;) {
      const result = await this.backend.exec(machineName, ['true'], { timeoutSeconds: 10 }).catch(() => null)
      if (result?.exitCode === 0) return
      if (Date.now() >= deadline) throw new SandboxError('not_ready', `${label} started but does not run commands yet. Try again.`)
      await delay(500)
    }
  }

  /** Waits for GNOME Shell, so the first screenshot is not of an empty screen. A slow shell is not an error. */
  async #waitShell(machineName: string, progress: (line: string) => void): Promise<void> {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const status = await this.#guest<{ ready?: boolean }>(machineName, 'status').catch(() => null)
      if (status?.ready) {
        await delay(this.#pollMs * 3)
        return
      }
      await delay(500)
    }
    progress('GNOME Shell is still starting; the screen may be empty for a moment')
  }

  /** Whether the backend can publish the viewer's port, at create or later. */
  #hasViewer(): boolean {
    return this.#capabilities.ports || this.#capabilities.publish
  }

  /** Where the viewer is reached, publishing its port first where the backend can and it is not published. */
  async #viewer(name: string, machineName: string): Promise<Endpoint> {
    try {
      return await this.backend.endpoint(machineName, VIEWER_PORT)
    } catch (error) {
      if (!isCode(error, 'not_published')) throw error
      if (!this.#capabilities.publish || !this.backend.publish) {
        throw new SandboxError(
          'not_published',
          `${name}'s viewer is not published, and the ${this.backend.name} backend publishes ports only when it creates a sandbox. Remove it and start it again: \`blobby-sandbox rm ${name}\`.`,
        )
      }
      await this.backend.publish(machineName, VIEWER_PORT)
      return this.backend.endpoint(machineName, VIEWER_PORT)
    }
  }

  async #waitViewer(name: string, endpoint: Endpoint): Promise<void> {
    const deadline = Date.now() + VIEWER_MS
    const { url, headers } = endpointUrl(endpoint, 'vnc.html')
    while (!(await this.#viewerUp(url.href, headers))) {
      if (Date.now() >= deadline) {
        throw new SandboxError('viewer_timeout', `${name}'s viewer did not start. See its log: \`blobby-sandbox exec ${name} --user root -- cat /var/log/blobby-session.log\`.`)
      }
      await delay(500)
    }
  }

  /** Streams a file in the sandbox, or a byte range of it, without holding it in memory. */
  async readFile(name: string, path: string, range?: ReadRange): Promise<{ stream: Readable; size: number }> {
    const machine = await this.#usable(name)
    const file = guestPath(path)
    const info = await this.backend.stat(machine, file)
    if (!info) throw new SandboxError('not_found', `${name} has no file ${file}.`)
    return { stream: await this.backend.readFile(machine, file, range), size: info.size }
  }

  /** Writes a file in the sandbox from bytes or a stream, creating its folders. It belongs to the desktop user unless `user` says otherwise. */
  async writeFile(name: string, path: string, data: Uint8Array | Readable, options: { user?: string; mode?: number } = {}): Promise<void> {
    const machine = await this.#usable(name)
    await this.backend.writeFile(machine, guestPath(path), data, { mode: options.mode ?? 0o644, user: options.user ?? DESKTOP_USER })
  }
}

function guestPath(path: string): string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0') || path.split('/').includes('..')) {
    throw new SandboxError('invalid_path', `"${path}" is not a path in the sandbox. Use an absolute path, such as /home/${DESKTOP_USER}/file.txt, without "..".`)
  }
  return path
}
