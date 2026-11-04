import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createTRPCClient, httpLink, TRPCClientError, unstable_localLink, type TRPCClient } from '@trpc/client'
import { SandboxError, type Backend, type Endpoint, type ExecResult, type NetworkPolicy, type ReadRange } from './backend.ts'
import { createBackend, selectBackend, type BackendSelection } from './backends.ts'
import { LocalResolver } from './callbacks/local.ts'
import { untilAborted } from './abort.ts'
import { RedactedStream } from './callbacks/redact.ts'
import { refuse, splitCallback, toResolver, withoutLogins, type CallbackAnswer, type ResolveFunction, type Resolver } from './callbacks/protocol.ts'
import type { AccessibleNode, InputAction, RecordingInfo, SandboxExecResult, SandboxInfo, Sandboxes, Screenshot, Started, UiAct, UiQuery, UiWait, UiWaited } from './sandboxes.ts'
import { Jobs, type CheckReply, type JobEvent } from './jobs.ts'
import type { ReapOptions, ReapReport } from './reaper.ts'
import type { RecipeRef } from './recipe.ts'
import { endpointUrl } from './net.ts'
import { appRouter, type AppRouter, type ListedSandbox } from './router.ts'

export interface ConnectOptions {
  /** A `blobby-sandbox serve` URL. Without it, the engine runs in this process. */
  server?: string
  /** The server's token. */
  token?: string
  /**
   * For in-process use: the backend, `smolvm`, `docker`, or `azure`. The default is `BLOBBY_SANDBOX_BACKEND`, else
   * smolvm when this host runs it, else docker. `doctor` says which, and why. A server picks its own.
   */
  backend?: string
  /** For in-process use: makes the engine, instead of a backend. Tests pass one with a fake backend. */
  engine?: () => Promise<Sandboxes>
  /** For in-process use with `engine`: the same backend without an owner filter, for `list({ mine: false })`. */
  others?: () => Promise<Backend | null>
  env?: NodeJS.ProcessEnv
}

export interface ClientStartOptions {
  recipe?: RecipeRef
  resolution?: string
  cpus?: number
  memoryMb?: number
  gpu?: boolean
  steps?: 'new' | 'always' | 'never'
  /** How long a new sandbox lives before reapers may delete it, such as `8h` or `7d`, or `never`. Default 24 hours. */
  deleteAfter?: string
  /** What a new sandbox may reach. Default `internet`. */
  network?: NetworkPolicy
  /** Local development only: run unrestricted when the backend can't enforce `network`, with a warning. */
  allowUnenforcedNetwork?: boolean
  onProgress?: (line: string) => void
  /**
   * Answers recipe steps' callbacks, usually a `LocalResolver`. Progress, errors, and the result are
   * also redacted with what it knows. Locks it takes are its to release, with `LocalResolver.release`.
   */
  resolver?: Resolver
  /** Answers callbacks with a function, when there is no `resolver`. */
  onRequest?: ResolveFunction
  signal?: AbortSignal
}

/** How `exec` runs a command. A non-zero exit code is a result, not an error. */
export interface ClientExecOptions {
  /** Run as root, for system changes such as `apt-get install -y`. Same as `user: 'root'`. */
  root?: boolean
  /** The guest user. Default the desktop user. */
  user?: string
  /** Variables for the command, on top of the desktop session's. The host's environment never goes in. */
  env?: Record<string, string>
  /** Written to the command's stdin, then closed. At most 1 MiB. */
  stdin?: string | Uint8Array
  /** Stops the command after this long, with exit code 124. */
  timeoutSeconds?: number
  /** Called with output as it arrives. The result still has all of it. */
  onOutput?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void
  /** Stops waiting and kills the command; the promise rejects with `cancelled`. */
  signal?: AbortSignal
  /**
   * Lets the command ask for fields of this secret while it runs (`secret(field)` in the guest library),
   * such as `exec(['vscode-signin'], { secret: 'github' })`. The secret's login must be on the
   * allowlist. It runs as the desktop user, without `env` or `stdin`, for at most 30 minutes by default.
   */
  secret?: string
  /** Answers the secret's callbacks. Default: a `LocalResolver` on this computer's secrets, released when the command ends. */
  resolver?: Resolver
  /** Answers the secret's callbacks with a function, when there is no `resolver`. */
  onRequest?: ResolveFunction
}

/** What `files.write` takes: text, bytes, or a stream of bytes. */
export type FileData = string | Uint8Array | Readable | AsyncIterable<Uint8Array>

export interface WriteFileOptions {
  /** Write it as root, owned by root. Default the desktop user. */
  root?: boolean
  /** The file's mode. Default 0o644. */
  mode?: number
}

export interface Viewer {
  /** The viewer page, with its password in the fragment so it never reaches a server or a log. */
  url: string
  /** The VNC WebSocket, for embedding noVNC. */
  websocket: string
  password: string
  /** Whether the page only watches: it sends no input, so it never interferes with an agent's run. */
  viewOnly: boolean
}

/** A finished recording, still in the sandbox. Stream it with `read`, or `save` it to a file. */
export interface RecordedVideo extends RecordingInfo {
  /** Streams the MP4, or a byte range of it, without holding it in memory. */
  read(range?: ReadRange): AsyncIterable<Uint8Array>
  /**
   * Streams the MP4 to a file, checks its size and SHA-256, and then deletes it from the sandbox unless
   * `keep` is set. A file that doesn't arrive whole is not left behind.
   */
  save(path: string, options?: { keep?: boolean }): Promise<{ path: string; size: number; sha256: string }>
  /** Deletes it from the sandbox. */
  delete(): Promise<void>
}

/** A recording in progress. */
export interface Recording {
  id: string
  /** It stops by itself after this long. */
  maxSeconds: number
  /** Stops it. The video stays in the sandbox until you save or delete it. */
  stop(): Promise<RecordedVideo>
}

const CHUNK = 4 * 1024 * 1024

/** The engine on the selected backend, which loads only now, when a command needs it. */
export async function createEngine(selection: BackendSelection, env: NodeJS.ProcessEnv = process.env): Promise<Sandboxes> {
  const { Sandboxes } = await import('./sandboxes.ts')
  return new Sandboxes(await createBackend(selection.name, { env }))
}

/** Moves files and recordings without tRPC, which carries only JSON: directly in-process, or over the server's HTTP routes. */
export interface FileTransfer {
  readFile(name: string, path: string, range?: ReadRange): Promise<{ stream: Readable; size: number }>
  writeFile(name: string, path: string, data: Readable, options: { user?: string; mode?: number }): Promise<void>
  readMedia(name: string, id: string, range?: ReadRange): Promise<{ stream: Readable; size: number }>
}

function engineTransfer(engine: () => Promise<Sandboxes>): FileTransfer {
  return {
    readFile: async (name, path, range) => (await engine()).readFile(name, path, range),
    writeFile: async (name, path, data, options) => (await engine()).writeFile(name, path, data, options),
    readMedia: async (name, id, range) => (await engine()).mediaStream(name, id, range),
  }
}

/** Turns an HTTP route's error, `{ error: { code, message } }`, into a SandboxError. */
async function httpError(response: Response, server: string): Promise<SandboxError> {
  const body = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
  if (body?.error?.code && body.error.message) return new SandboxError(body.error.code, body.error.message)
  if (response.status === 401) return new SandboxError('unauthorized', `The sandbox server at ${server} refused the token. Set BLOBBY_SANDBOX_TOKEN to the token \`blobby-sandbox serve\` printed.`)
  return new SandboxError('server_failed', `The sandbox server at ${server} answered ${response.status} ${response.statusText}.`)
}

function httpTransfer(base: string, token: string | undefined): FileTransfer {
  const headers = (extra: Record<string, string> = {}) => ({ ...extra, ...(token ? { authorization: `Bearer ${token}` } : {}) })
  const rangeHeader = (range?: ReadRange): Record<string, string> => {
    if (!range || (!range.offset && range.length === undefined)) return {}
    const first = range.offset ?? 0
    return { range: `bytes=${first}-${range.length === undefined ? '' : first + range.length - 1}` }
  }
  const request = async (path: string, init: RequestInit & { duplex?: 'half' }): Promise<Response> => {
    let response: Response
    try {
      response = await fetch(`${base}${path}`, init)
    } catch (error) {
      throw new SandboxError('server_unreachable', `Could not reach the sandbox server at ${base}: ${(error as Error).message}`, { cause: error })
    }
    if (!response.ok) throw await httpError(response, base)
    return response
  }
  const download = async (path: string, range?: ReadRange) => {
    if (range?.length === 0) return { stream: Readable.from([]), size: NaN }
    const response = await request(path, { headers: headers(rangeHeader(range)) })
    const size = Number(response.headers.get('x-blobby-size'))
    const expected = Number(response.headers.get('content-length'))
    const body = response.body ? Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>) : Readable.from([])
    // A connection that breaks mid-file ends the stream early; the length says so.
    async function* checked(): AsyncGenerator<Uint8Array> {
      let received = 0
      for await (const chunk of body) {
        received += (chunk as Uint8Array).length
        yield chunk as Uint8Array
      }
      if (Number.isFinite(expected) && received !== expected) {
        throw new SandboxError('transfer_failed', `The download from ${base} ended after ${received} of ${expected} bytes. Try again.`)
      }
    }
    return { stream: Readable.from(checked(), { objectMode: false }), size }
  }
  return {
    readFile: (name, path, range) => download(`/files/${name}?${new URLSearchParams({ path })}`, range),
    readMedia: (name, id, range) => download(`/media/${name}/${id}`, range),
    writeFile: async (name, path, data, options) => {
      const query = new URLSearchParams({ path, ...(options.user ? { user: options.user } : {}), ...(options.mode !== undefined ? { mode: options.mode.toString(8) } : {}) })
      await request(`/files/${name}?${query}`, {
        method: 'PUT',
        headers: headers({ 'content-type': 'application/octet-stream' }),
        body: Readable.toWeb(data) as ReadableStream<Uint8Array>,
        duplex: 'half',
      })
    },
  }
}

function toReadable(data: FileData): Readable {
  if (typeof data === 'string') return Readable.from([Buffer.from(data, 'utf8')])
  if (data instanceof Uint8Array) return Readable.from([Buffer.from(data.buffer, data.byteOffset, data.byteLength)])
  if (data instanceof Readable) return data
  return Readable.from(data, { objectMode: false })
}

/**
 * A Blobby Sandbox client: in-process with `connect()`, or connected to a `blobby-sandbox serve` with
 * `connect({ server, token })`, with the same API either way. The CLI and canvas are thin wrappers around it.
 *
 * ```ts
 * const bb = connect()
 * const sb = await bb.start('qa')
 * await sb.exec(['uname', '-a'])
 * ```
 */
export function connect(options: ConnectOptions = {}): SandboxClient {
  if (options.server && options.backend) {
    throw new SandboxError('usage', 'The server picks its own backend. Leave out --backend, or start the server with it: `blobby-sandbox serve --backend <name>`.')
  }
  if (options.server) {
    const base = options.server.replace(/\/+$/, '')
    const trpc = createTRPCClient<AppRouter>({
      links: [httpLink({ url: `${base}/trpc`, headers: () => (options.token ? { authorization: `Bearer ${options.token}` } : {}) })],
    })
    return new SandboxClient(trpc, base, httpTransfer(base, options.token))
  }
  const env = options.env ?? process.env
  const selection = options.engine ? undefined : selectBackend({ backend: options.backend, env })
  let engine: Promise<Sandboxes> | undefined
  const getEngine = () => (engine ??= options.engine ? options.engine() : createEngine(selection!, env))
  const others = options.others ?? (selection ? () => createBackend(selection.name, { env, labels: {} }) : undefined)
  const jobs = new Jobs()
  const trpc = createTRPCClient<AppRouter>({
    links: [
      unstable_localLink({
        router: appRouter,
        createContext: async () => ({
          engine: getEngine,
          selection,
          jobs,
          viewerUrl: async (_sandbox: string, endpoint: Endpoint) => localViewerUrl(endpoint),
          env,
          others,
        }),
      }),
    ],
  })
  return new SandboxClient(trpc, null, engineTransfer(getEngine))
}

/** In-process, the client is where the engine is, so it reaches the viewer where the engine does. */
function localViewerUrl(endpoint: Endpoint): string {
  const { url, headers } = endpointUrl(endpoint, 'vnc.html')
  if (Object.keys(headers).length) {
    throw new SandboxError('unsupported', "This backend's viewer needs credentials that a browser can't send. Run `blobby-sandbox serve` and connect to it, which relays the viewer.")
  }
  return url.href
}

/** Turns tRPC's errors back into SandboxErrors, with the code the engine gave them. */
async function call<T>(server: string | null, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof SandboxError) throw error
    if (error instanceof TRPCClientError) {
      const data = error.data as { sandboxCode?: string | null; code?: string; httpStatus?: number } | undefined
      if (data?.sandboxCode) throw new SandboxError(data.sandboxCode, error.message)
      if (data?.code === 'BAD_REQUEST') throw new SandboxError('usage', error.message)
      if (data?.httpStatus === 401 || /401|Unauthorized/.test(error.message)) {
        throw new SandboxError('unauthorized', `The sandbox server at ${server} refused the token. Set BLOBBY_SANDBOX_TOKEN to the token \`blobby-sandbox serve\` printed.`)
      }
      if (!data && server) throw new SandboxError('server_unreachable', `Could not reach the sandbox server at ${server}: ${error.message}`)
      throw new SandboxError(data?.code?.toLowerCase() ?? 'internal', error.message)
    }
    throw error
  }
}

interface FollowOptions {
  onProgress?: (line: string) => void
  onOutput?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void
  resolver?: Resolver
  signal?: AbortSignal
}

export class SandboxClient {
  readonly trpc: TRPCClient<AppRouter>
  /** The server's URL, or null in-process. */
  readonly server: string | null
  readonly #transfer: FileTransfer

  /** Use `connect` to make one. */
  constructor(trpc: TRPCClient<AppRouter>, server: string | null, transfer: FileTransfer) {
    this.trpc = trpc
    this.server = server
    this.#transfer = transfer
  }

  /** Which backend runs sandboxes and why, whether it works, what it can do, and the engine host's free disk. */
  doctor() {
    return call(this.server, () => this.trpc.doctor.query())
  }

  /**
   * This host's sandboxes, by name. With `{ mine: false }`, also other managers' sandboxes on a shared
   * backend, marked `mine: false`; machines without a manager label are never listed.
   */
  async list(options: { mine?: boolean } = {}): Promise<ListedSandbox[]> {
    return (await call(this.server, () => this.trpc.list.query({ all: options.mine === false }))).sandboxes
  }

  /** A handle for an existing sandbox. Fails with `not_found` when there is none. */
  async get(name: string): Promise<Sandbox> {
    const info = await call(this.server, () => this.trpc.get.query({ name }))
    return new Sandbox(this, info.name, null)
  }

  /** A handle for a sandbox by name, without checking that it exists. */
  sandbox(name: string): Sandbox {
    return new Sandbox(this, name, null)
  }

  /**
   * Creates or starts a sandbox, following its progress and answering its steps' callbacks, and returns
   * a handle for it. `sandbox.started` says what the start did.
   */
  async start(name: string, options: ClientStartOptions = {}): Promise<Sandbox> {
    const { onProgress, onRequest, resolver: given, signal, ...input } = options
    const resolver = toResolver(given ?? onRequest)
    const { job } = await call(this.server, () => this.trpc.start.mutate({ name, ...input }))
    const started = await this.#follow<Started>(job, { onProgress, resolver, signal })
    return new Sandbox(this, name, resolver?.redactor ? resolver.redactor.json(started) : started)
  }

  /** Follows a job's events, answering its callbacks with `resolver`, until it ends. */
  async #follow<T>(job: string, options: FollowOptions): Promise<T> {
    const { onProgress, onOutput, resolver, signal } = options
    const redact = (text: string) => resolver?.redactor?.text(text) ?? text
    // The server can't redact what only this client knows, and may split a value across events, so output is held back to whole lines.
    const streams = resolver?.redactor ? { stdout: new RedactedStream(redact), stderr: new RedactedStream(redact) } : null
    const flush = () => {
      for (const stream of ['stdout', 'stderr'] as const) {
        const text = streams?.[stream].flush()
        if (text) onOutput?.({ stream, text })
      }
    }
    const cancel = () => void this.trpc.jobs.cancel.mutate({ id: job }).catch(() => {})
    if (signal?.aborted) cancel()
    signal?.addEventListener('abort', cancel, { once: true })
    // Cancelling stops waiting at once: for events, and for this client's own resolver.
    const race = <R>(promise: Promise<R>) => untilAborted(promise, signal)
    try {
      let after = 0
      for (;;) {
        const page = await race(call(this.server, () => this.trpc.jobs.events.query({ id: job, after, waitMs: 20_000 })))
        after = page.next
        for (const event of page.events as JobEvent[]) {
          if (event.type === 'progress') onProgress?.(redact(event.text))
          else if (event.type === 'output') {
            const text = streams ? streams[event.stream].push(event.text) : event.text
            if (text) onOutput?.({ stream: event.stream, text })
          }
          else if (event.type === 'request') {
            const context = { ...event.context, progress: onProgress && ((line: string) => onProgress(redact(line))), signal }
            let answer: CallbackAnswer = resolver
              ? await race(resolver.resolve(event.request, context).catch((error: unknown) => ({ error: (error as Error).message })))
              : { error: `This client does not answer callbacks such as ${event.request.name}.`, code: 'no_resolver' }
            if ('error' in answer) answer = { ...answer, error: redact(answer.error).slice(0, 1000) }
            await call(this.server, () => this.trpc.jobs.answer.mutate({ id: job, request: event.request.id, answer }))
          } else if (event.type === 'check') {
            const context = { ...event.context, progress: onProgress && ((line: string) => onProgress(redact(line))), signal }
            let reply: CheckReply
            try {
              // Only the resolver sees the accounts a step claims; without one, they are shown as unverified.
              const checked = resolver?.checkResult ? await race(resolver.checkResult(event.result, context)) : event.result
              reply = { result: withoutLogins(checked, context, false) }
            } catch (error) {
              reply = { error: { code: error instanceof SandboxError ? error.code : 'internal', message: redact(String((error as Error)?.message ?? error)).slice(0, 1000) } }
            }
            await call(this.server, () => this.trpc.jobs.check.mutate({ id: job, check: event.id, reply }))
          } else if (event.type === 'done') {
            flush()
            return event.result as T
          } else {
            flush()
            throw new SandboxError(event.error.code, redact(event.error.message))
          }
        }
        if (page.finished) throw new SandboxError('internal', 'The job ended without a result.')
      }
    } catch (error) {
      if (signal?.aborted) throw new SandboxError('cancelled', 'Cancelled.')
      throw error
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
  }

  /** Stops a sandbox and keeps its files. */
  async stop(name: string): Promise<void> {
    await call(this.server, () => this.trpc.stop.mutate({ name }))
  }

  /** Deletes a sandbox and its files. */
  async remove(name: string): Promise<void> {
    await call(this.server, () => this.trpc.remove.mutate({ name }))
  }

  /**
   * The viewer, at a URL this client can reach: on this machine, or through the server's relay. With
   * `viewOnly`, the page only watches, so it never interferes with an agent's run.
   */
  async view(name: string, options: { viewOnly?: boolean } = {}): Promise<Viewer> {
    const { url, password } = await call(this.server, () => this.trpc.view.query({ name }))
    const page = new URL(url, this.server ?? undefined)
    const path = new URL('websockify', page).pathname.slice(1)
    const websocket = new URL(`/${path}`, page)
    websocket.protocol = page.protocol === 'https:' ? 'wss:' : 'ws:'
    const viewOnly = options.viewOnly ?? false
    const fragment = `autoconnect=1&resize=remote&path=${encodeURIComponent(path)}${viewOnly ? '&view_only=1' : ''}&password=${encodeURIComponent(password)}`
    return { url: `${page.href}#${fragment}`, websocket: websocket.href, password, viewOnly }
  }

  /**
   * Runs a command in the sandbox's desktop session, as the desktop user or, with `root`, as root. With
   * `onOutput` or `signal`, its output streams as it arrives and it can be cancelled.
   */
  async exec(name: string, command: string[], options: ClientExecOptions = {}): Promise<SandboxExecResult> {
    const { root, user, onOutput, signal, stdin, resolver: given, onRequest, ...rest } = options
    if (root && user && user !== 'root') throw new SandboxError('usage', 'Use root or user, not both.')
    const input = {
      name,
      command,
      ...rest,
      ...(root || user ? { user: root ? 'root' : user } : {}),
      ...(stdin === undefined ? {} : typeof stdin === 'string' ? { stdin } : { stdinBase64: Buffer.from(stdin).toString('base64') }),
    }
    if (options.secret === undefined) {
      if (!onOutput && !signal) return call(this.server, () => this.trpc.exec.mutate(input))
      const { job } = await call(this.server, () => this.trpc.execJob.mutate(input))
      return this.#follow<ExecResult>(job, { onOutput, signal })
    }
    // The secret stays with this client: the server passes the command's requests here to answer.
    const own = given || onRequest ? null : new LocalResolver()
    const resolver = own ?? toResolver(given ?? onRequest)!
    const secret = options.secret
    // The server describes each request, so only fields of the secret this client chose are answered, from that secret.
    const scoped: Resolver = {
      redactor: resolver.redactor,
      resolve: async (request, context) =>
        splitCallback(request.name).namespace === secret
          ? resolver.resolve(request, { ...context, binding: undefined })
          : refuse('not_declared', `This command was given the ${secret} secret, not ${splitCallback(request.name).namespace}.`),
      ...(resolver.checkResult ? { checkResult: resolver.checkResult.bind(resolver) } : {}),
    }
    try {
      // Refused here, before anything runs, when the secret's login is not on the allowlist.
      if (resolver instanceof LocalResolver) await resolver.checkSecret(secret)
      const { job } = await call(this.server, () => this.trpc.execJob.mutate(input))
      const result = await this.#follow<SandboxExecResult>(job, { onOutput, signal, resolver: scoped })
      return resolver.redactor ? resolver.redactor.json(result) : result
    } finally {
      await own?.release()
    }
  }

  /** Streams a file from the sandbox, or a byte range of it. */
  async *readFile(name: string, path: string, options: { range?: ReadRange } = {}): AsyncGenerator<Uint8Array> {
    const { stream } = await this.#transfer.readFile(name, path, options.range)
    for await (const chunk of stream) yield chunk as Uint8Array
  }

  /** Writes a file in the sandbox from text, bytes, or a stream, creating its folders. */
  async writeFile(name: string, path: string, data: FileData, options: WriteFileOptions = {}): Promise<void> {
    await this.#transfer.writeFile(name, path, toReadable(data), { ...(options.root ? { user: 'root' } : {}), ...(options.mode !== undefined ? { mode: options.mode } : {}) })
  }

  /** A PNG of the screen. Needs the desktop feature: other sandboxes fail with `no_desktop`. */
  async screenshot(name: string): Promise<Screenshot> {
    const shot = await call(this.server, () => this.trpc.screenshot.mutate({ name }))
    return { png: Buffer.from(shot.png, 'base64'), width: shot.width, height: shot.height }
  }

  /** Clicks, moves the pointer, types, presses keys, or scrolls, by screen coordinates. */
  async input(name: string, action: InputAction): Promise<void> {
    await call(this.server, () => this.trpc.input.mutate({ name, action }))
  }

  /** The visible, named elements of the desktop's accessibility tree, optionally of one app or matching some text. */
  ui(name: string, query: UiQuery = {}): Promise<{ nodes: AccessibleNode[]; truncated: boolean }> {
    return call(this.server, () => this.trpc.ui.query({ name, ...query })) as Promise<{ nodes: AccessibleNode[]; truncated: boolean }>
  }

  /** Presses, focuses, or sets the text of an element, by the path `ui` gave it. */
  act(name: string, act: UiAct): Promise<{ path: string; name: string; did: string }> {
    return call(this.server, () => this.trpc.act.mutate({ name, ...act }))
  }

  /** Waits in the sandbox until an element matches, or with `gone`, until none does. Fails with `wait_timeout`. */
  waitFor(name: string, wait: UiWait): Promise<UiWaited> {
    return call(this.server, () => this.trpc.waitFor.mutate({ name, ...wait })) as Promise<UiWaited>
  }

  /** Starts recording the screen. It stops by itself after `maxSeconds` (default 600). */
  recordStart(name: string, options: { maxSeconds?: number } = {}): Promise<{ id: string; maxSeconds: number }> {
    return call(this.server, () => this.trpc.record.start.mutate({ name, ...options }))
  }

  /** Stops the recording. The video stays in the sandbox: stream it with `read`, or `save` it to a file. */
  async recordStop(name: string): Promise<RecordedVideo> {
    const info = await call(this.server, () => this.trpc.record.stop.mutate({ name }))
    return this.recorded(name, info)
  }

  /** A recording that is in the sandbox, from `recordStop` or the tools, as a `RecordedVideo`. */
  recorded(name: string, info: RecordingInfo): RecordedVideo {
    return {
      id: info.id,
      size: info.size,
      sha256: info.sha256,
      seconds: info.seconds,
      read: (range) => this.mediaStream(name, info.id, range),
      save: (path, options) => this.saveRecording(name, info, path, options),
      delete: () => this.mediaDelete(name, info.id),
    }
  }

  /**
   * Streams a recording to `path`, checking its size and SHA-256 as it goes, then deletes it from the
   * sandbox unless `keep` is set. The file appears only once it arrived whole.
   */
  async saveRecording(name: string, info: RecordingInfo, path: string, options: { keep?: boolean } = {}): Promise<{ path: string; size: number; sha256: string }> {
    await mkdir(dirname(path), { recursive: true })
    const partial = `${path}.partial`
    const hash = createHash('sha256')
    let size = 0
    const counted = async function* (source: AsyncIterable<Uint8Array>) {
      for await (const chunk of source) {
        hash.update(chunk)
        size += chunk.length
        yield chunk
      }
    }
    try {
      await pipeline(Readable.from(counted(this.mediaStream(name, info.id)), { objectMode: false }), createWriteStream(partial))
      const sha256 = hash.digest('hex')
      if (size !== info.size || sha256 !== info.sha256) {
        throw new SandboxError('transfer_failed', `The recording did not arrive whole (${size} of ${info.size} bytes). It is still in the sandbox as ${info.id}.`)
      }
      await rename(partial, path)
      if (!options.keep) await this.mediaDelete(name, info.id)
      return { path, size, sha256 }
    } finally {
      await rm(partial, { force: true })
    }
  }

  /** Streams a recording, or a byte range of it, without holding it in memory. */
  async *mediaStream(name: string, id: string, range?: ReadRange): AsyncGenerator<Uint8Array> {
    const { stream } = await this.#transfer.readMedia(name, id, range)
    for await (const chunk of stream) yield chunk as Uint8Array
  }

  /** Reads up to `length` bytes (at most 4 MiB) of a recording from `offset`. */
  async mediaRead(name: string, id: string, offset: number, length: number): Promise<{ data: Uint8Array; eof: boolean }> {
    const chunk = await call(this.server, () => this.trpc.media.read.query({ name, id, offset, length: Math.min(length, CHUNK) }))
    return { data: Buffer.from(chunk.data, 'base64'), eof: chunk.eof }
  }

  /** Deletes a recording from the sandbox. */
  async mediaDelete(name: string, id: string): Promise<void> {
    await call(this.server, () => this.trpc.media.delete.mutate({ name, id }))
  }

  /**
   * Cleans up this host's machines on the engine's backend: expired ones, what interrupted starts left,
   * and older cached bases, as asked. Reports what it did, or with `dryRun`, what it would do.
   */
  reap(options: Pick<ReapOptions, 'expired' | 'interrupted' | 'bases' | 'dryRun'>): Promise<ReapReport> {
    return call(this.server, () => this.trpc.reap.mutate(options))
  }

  /** Deletes this host's sandboxes past their `deleteAfter` deadline (`rm --expired`). */
  removeExpired(options: { dryRun?: boolean } = {}): Promise<ReapReport> {
    return this.reap({ expired: true, dryRun: options.dryRun })
  }

  /** Deletes expired sandboxes and older cached bases nothing needs (`gc`). The newest base of each recipe stays. */
  gc(options: { dryRun?: boolean } = {}): Promise<ReapReport> {
    return this.reap({ expired: true, bases: true, dryRun: options.dryRun })
  }
}

/** Reads and writes files in one sandbox. */
export class SandboxFiles {
  readonly #client: SandboxClient
  readonly #name: string

  constructor(client: SandboxClient, name: string) {
    this.#client = client
    this.#name = name
  }

  /** Writes a file from text, bytes, or a stream, creating its folders. It belongs to the desktop user unless `root` is set. */
  write(path: string, data: FileData, options: WriteFileOptions = {}): Promise<void> {
    return this.#client.writeFile(this.#name, path, data, options)
  }

  /** Streams a file, or a byte range of it: `for await (const chunk of sb.files.read(path)) …`. */
  read(path: string, options: { range?: ReadRange } = {}): AsyncIterable<Uint8Array> {
    return this.#client.readFile(this.#name, path, options)
  }
}

/** Drives one sandbox's desktop. Every method needs the desktop feature; other sandboxes fail with `no_desktop`. */
export class SandboxDesktop {
  readonly #client: SandboxClient
  readonly #name: string

  constructor(client: SandboxClient, name: string) {
    this.#client = client
    this.#name = name
  }

  /** A PNG of the screen, with its size. */
  screenshot(): Promise<Screenshot> {
    return this.#client.screenshot(this.#name)
  }

  /** Clicks, moves the pointer, types, presses keys, or scrolls, by screen coordinates. */
  input(action: InputAction): Promise<void> {
    return this.#client.input(this.#name, action)
  }

  /** The visible, named elements of the accessibility tree, optionally of one app or matching some text. */
  ui(query: UiQuery = {}): Promise<{ nodes: AccessibleNode[]; truncated: boolean }> {
    return this.#client.ui(this.#name, query)
  }

  /** Presses, focuses, or sets the text of an element, by the path `ui` gave it. */
  act(act: UiAct): Promise<{ path: string; name: string; did: string }> {
    return this.#client.act(this.#name, act)
  }

  /**
   * Waits until an element matches, or with `gone`, until none does, such as
   * `waitFor({ app: 'code-insiders', match: 'Accounts', role: 'push button' })`. One call, however long it
   * waits; fails with `wait_timeout`.
   */
  waitFor(wait: UiWait): Promise<UiWaited> {
    return this.#client.waitFor(this.#name, wait)
  }

  /** Starts recording the screen. Stop it with `stop()` on what this returns. */
  async record(options: { maxSeconds?: number } = {}): Promise<Recording> {
    const started = await this.#client.recordStart(this.#name, options)
    return { id: started.id, maxSeconds: started.maxSeconds, stop: () => this.#client.recordStop(this.#name) }
  }

  /** The live viewer (noVNC): its URL, WebSocket, and password. `viewOnly` watches without sending input. */
  view(options: { viewOnly?: boolean } = {}): Promise<Viewer> {
    return this.#client.view(this.#name, options)
  }
}

/** One sandbox, from `start` or `get`. Everything it does goes through its client, in-process or remote. */
export class Sandbox {
  readonly name: string
  /** What `start` did, for a handle from `start`; null for one from `get`. */
  readonly started: Started | null
  /** Reads and writes its files, streamed. */
  readonly files: SandboxFiles
  /** Drives its desktop. Needs the desktop feature. */
  readonly desktop: SandboxDesktop
  readonly #client: SandboxClient

  constructor(client: SandboxClient, name: string, started: Started | null) {
    this.#client = client
    this.name = name
    this.started = started
    this.files = new SandboxFiles(client, name)
    this.desktop = new SandboxDesktop(client, name)
  }

  /** Its current state, deadline, and viewer port. */
  async info(): Promise<SandboxInfo> {
    return call(this.#client.server, () => this.#client.trpc.get.query({ name: this.name }))
  }

  /** Runs a command. A non-zero exit code is a result, not an error. See `SandboxClient.exec`. */
  exec(command: string[], options: ClientExecOptions = {}): Promise<SandboxExecResult> {
    return this.#client.exec(this.name, command, options)
  }

  /** Stops it and keeps its files. */
  stop(): Promise<void> {
    return this.#client.stop(this.name)
  }

  /** Deletes it and its files. */
  remove(): Promise<void> {
    return this.#client.remove(this.name)
  }
}
