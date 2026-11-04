import { existsSync, statSync } from 'node:fs'
import { request, type IncomingMessage, type OutgoingHttpHeaders, type RequestOptions } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Duplex, Readable } from 'node:stream'
import { SandboxError } from '../backend.ts'

/** The oldest Engine API this backend speaks: Docker 20.10. */
export const MIN_API_VERSION = '1.41'
/** The newest Engine API this backend speaks: Docker 27. Newer daemons answer it too. */
export const MAX_API_VERSION = '1.47'

/** Where the Docker daemon listens. */
export type DockerTarget = { kind: 'unix'; socketPath: string } | { kind: 'tcp'; host: string; port: number }

/**
 * Where to reach Docker: `DOCKER_HOST` (`unix://` or `tcp://` without TLS), else the first socket that
 * exists among `/var/run/docker.sock` and Docker Desktop's and rootless Docker's sockets. Docker's CLI
 * configuration and contexts are never read.
 */
export function dockerTarget(env: NodeJS.ProcessEnv = process.env, options: { platform?: NodeJS.Platform; home?: string; isSocket?: (path: string) => boolean } = {}): DockerTarget {
  const value = env.DOCKER_HOST?.trim()
  if (value) {
    if (value.startsWith('unix://')) {
      const socketPath = value.slice('unix://'.length)
      if (!socketPath.startsWith('/')) throw new SandboxError('docker_host_unsupported', `DOCKER_HOST is ${value}, which isn't an absolute unix:// socket path. Use unix:///path/to/docker.sock.`)
      return { kind: 'unix', socketPath }
    }
    if (value.startsWith('tcp://')) {
      if (env.DOCKER_TLS_VERIFY && env.DOCKER_TLS_VERIFY !== '0') {
        throw new SandboxError('docker_host_unsupported', 'DOCKER_TLS_VERIFY is set, and the docker backend does not speak TLS. Use a unix socket, or a plain tcp:// daemon on a network you trust.')
      }
      let url: URL
      try {
        url = new URL(value.replace(/^tcp:/, 'http:'))
      } catch {
        throw new SandboxError('docker_host_unsupported', `DOCKER_HOST is ${value}, which isn't a tcp://host:port address.`)
      }
      if ((url.pathname && url.pathname !== '/') || url.search || url.username) {
        throw new SandboxError('docker_host_unsupported', `DOCKER_HOST is ${value}; use tcp://host:port, without a path or credentials.`)
      }
      return { kind: 'tcp', host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port ? Number(url.port) : 2375 }
    }
    throw new SandboxError('docker_host_unsupported', `DOCKER_HOST is ${value.split('://')[0]}://…, and the docker backend supports only unix:// and tcp:// (without TLS).`)
  }
  const home = options.home ?? homedir()
  const platform = options.platform ?? process.platform
  const isSocket = options.isSocket ?? socketExists
  const candidates = ['/var/run/docker.sock']
  if (platform === 'darwin') candidates.push(join(home, '.docker', 'run', 'docker.sock'), join(home, '.docker', 'desktop', 'docker.sock'))
  if (platform === 'linux') {
    if (env.XDG_RUNTIME_DIR) candidates.push(join(env.XDG_RUNTIME_DIR, 'docker.sock'))
    candidates.push(join(home, '.docker', 'desktop', 'docker.sock'))
  }
  return { kind: 'unix', socketPath: candidates.find(isSocket) ?? candidates[0]! }
}

function socketExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isSocket()
  } catch {
    return false
  }
}

export function describeTarget(target: DockerTarget): string {
  return target.kind === 'unix' ? `unix://${target.socketPath}` : `tcp://${target.host}:${target.port}`
}

/** An error response from the Engine API. */
export class DockerApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'DockerApiError'
    this.status = status
  }
}

export interface VersionInfo {
  Version: string
  ApiVersion: string
  MinAPIVersion?: string
  Os: string
  Arch: string
  Platform?: { Name?: string }
}

function parseVersion(version: string): [number, number] {
  const [major, minor] = version.split('.').map(Number)
  return [major ?? 0, minor ?? 0]
}

export function compareVersions(a: string, b: string): number {
  const [x, y] = [parseVersion(a), parseVersion(b)]
  return x[0] - y[0] || x[1] - y[1]
}

export interface CallOptions {
  query?: Record<string, string | number | boolean | undefined>
  /** A JSON body, or a stream sent as it is. */
  body?: unknown
  /** The body's content type and length, for a stream. */
  contentType?: string
  contentLength?: number
  headers?: OutgoingHttpHeaders
  signal?: AbortSignal
  /** Fails if the daemon doesn't answer in time. The default is 60 seconds; 0 waits for ever. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 60_000

function isStream(body: unknown): body is Readable {
  return typeof (body as Readable | undefined)?.pipe === 'function'
}

/** A small Docker Engine API client over the daemon's socket, with the API version negotiated once. */
export class DockerEngine {
  readonly target: DockerTarget
  #api: Promise<{ prefix: string; version: VersionInfo; api: string }> | undefined

  constructor(target: DockerTarget) {
    this.target = target
  }

  #options(method: string, path: string, headers: OutgoingHttpHeaders): RequestOptions {
    const base = this.target.kind === 'unix' ? { socketPath: this.target.socketPath } : { host: this.target.host, port: this.target.port }
    return { ...base, method, path, headers: { Host: 'docker', ...headers } }
  }

  #unreachable(error: NodeJS.ErrnoException): SandboxError {
    const where = describeTarget(this.target)
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return new SandboxError('docker_permission', `This user can't open Docker's socket at ${where}. On Linux, add yourself to the docker group (and sign in again), or set DOCKER_HOST.`, { cause: error })
    }
    return new SandboxError('docker_unreachable', `Docker isn't running, or isn't at ${where}. Start Docker Desktop or the Docker daemon, or set DOCKER_HOST to where it listens.`, { cause: error })
  }

  /** Sends a request and resolves with the response, whatever its status. */
  raw(method: string, path: string, options: CallOptions = {}): Promise<IncomingMessage> {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) query.set(key, String(value))
    const fullPath = query.size ? `${path}?${query}` : path
    const headers: OutgoingHttpHeaders = { ...options.headers }
    let payload: Buffer | Readable | undefined
    if (isStream(options.body)) {
      payload = options.body
      headers['Content-Type'] = options.contentType ?? 'application/octet-stream'
      if (options.contentLength !== undefined) headers['Content-Length'] = options.contentLength
    } else if (options.body !== undefined) {
      payload = Buffer.from(JSON.stringify(options.body))
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = payload.length
    }
    return new Promise((resolve, reject) => {
      const req = request(this.#options(method, fullPath, headers))
      const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      let timer: NodeJS.Timeout | undefined
      const abort = () => req.destroy(new SandboxError('cancelled', 'The request to Docker was cancelled.'))
      const done = () => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
      }
      if (timeout) timer = setTimeout(() => req.destroy(new SandboxError('timeout', `Docker didn't answer ${method} ${path} within ${Math.round(timeout / 1000)} seconds.`)), timeout)
      if (options.signal?.aborted) abort()
      options.signal?.addEventListener('abort', abort, { once: true })
      req.once('response', (response) => {
        clearTimeout(timer)
        response.once('close', done)
        resolve(response)
      })
      req.once('error', (error: NodeJS.ErrnoException) => {
        done()
        reject(error instanceof SandboxError ? error : error.code && ['ECONNREFUSED', 'ENOENT', 'EACCES', 'EPERM', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND'].includes(error.code) ? this.#unreachable(error) : error)
      })
      if (isStream(payload)) {
        payload.once('error', (error) => req.destroy(error))
        payload.pipe(req)
      } else {
        req.end(payload)
      }
    })
  }

  /** The daemon's version, and the API version both sides speak. Cached; a failure is tried again next time. */
  negotiate(): Promise<{ prefix: string; version: VersionInfo; api: string }> {
    this.#api ??= (async () => {
      const response = await this.raw('GET', '/version', { timeoutMs: 15_000 })
      const version = (await readJson(response)) as VersionInfo
      if (response.statusCode !== 200 || !version.ApiVersion) throw new SandboxError('docker_unreachable', `${describeTarget(this.target)} didn't answer like a Docker daemon (HTTP ${response.statusCode}).`)
      const api = compareVersions(version.ApiVersion, MAX_API_VERSION) < 0 ? version.ApiVersion : MAX_API_VERSION
      if (compareVersions(api, MIN_API_VERSION) < 0) {
        throw new SandboxError('docker_too_old', `Docker ${version.Version} speaks Engine API ${version.ApiVersion}; the docker backend needs ${MIN_API_VERSION} or later (Docker 20.10). Update Docker.`)
      }
      if (version.MinAPIVersion && compareVersions(api, version.MinAPIVersion) < 0) {
        throw new SandboxError('docker_too_new', `Docker ${version.Version} no longer speaks Engine API ${api}. Update @rwoll/blobby-sandbox.`)
      }
      return { prefix: `/v${api}`, version, api }
    })()
    this.#api.catch(() => (this.#api = undefined))
    return this.#api
  }

  /** Sends a versioned request and resolves with the response. Error statuses throw `DockerApiError`. */
  async call(method: string, path: string, options: CallOptions = {}): Promise<IncomingMessage> {
    const { prefix } = await this.negotiate()
    const response = await this.raw(method, `${prefix}${path}`, options)
    if ((response.statusCode ?? 500) >= 400) {
      const body = await readText(response).catch(() => '')
      let message = body.trim()
      try {
        message = String((JSON.parse(body) as { message?: unknown }).message ?? message)
      } catch {
        // Not JSON: keep the text.
      }
      throw new DockerApiError(response.statusCode ?? 500, message || `HTTP ${response.statusCode}`)
    }
    return response
  }

  /** A versioned request whose answer doesn't matter beyond its status. The body is read, so the connection is free again. */
  async send(method: string, path: string, options: CallOptions = {}): Promise<void> {
    await readText(await this.call(method, path, options))
  }

  /** A versioned request whose answer is JSON, or nothing. */
  async json<T>(method: string, path: string, options: CallOptions = {}): Promise<T> {
    const response = await this.call(method, path, options)
    return (await readJson(response)) as T
  }

  /**
   * Starts a request that takes over the connection, as exec start does, and resolves with the raw
   * socket once the daemon switches protocols.
   */
  async hijack(path: string, body: unknown): Promise<Duplex> {
    const { prefix } = await this.negotiate()
    const payload = Buffer.from(JSON.stringify(body))
    return new Promise((resolve, reject) => {
      const req = request({
        ...this.#options('POST', `${prefix}${path}`, { 'Content-Type': 'application/json', 'Content-Length': payload.length, Connection: 'Upgrade', Upgrade: 'tcp' }),
        agent: false,
      })
      req.once('upgrade', (_response, socket, head) => {
        if (head.length) socket.unshift(head)
        resolve(socket)
      })
      req.once('response', async (response) => {
        const text = await readText(response).catch(() => '')
        let message = text.trim()
        try {
          message = String((JSON.parse(text) as { message?: unknown }).message ?? message)
        } catch {
          // Not JSON.
        }
        reject(new DockerApiError(response.statusCode ?? 500, message || `Docker answered HTTP ${response.statusCode} instead of switching protocols.`))
      })
      req.once('error', (error: NodeJS.ErrnoException) => reject(error.code ? this.#unreachable(error) : error))
      req.end(payload)
    })
  }
}

export async function readText(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of response) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

export async function readJson(response: IncomingMessage): Promise<unknown> {
  const text = await readText(response)
  return text.trim() ? JSON.parse(text) : undefined
}

/** The frames of an attached, non-TTY stream: an 8-byte header (stream, 0, 0, 0, size) before each payload. */
export class Demuxer {
  #pending: Buffer = Buffer.alloc(0)
  readonly #emit: (stream: 'stdout' | 'stderr', data: Buffer) => void

  constructor(emit: (stream: 'stdout' | 'stderr', data: Buffer) => void) {
    this.#emit = emit
  }

  push(chunk: Buffer): void {
    this.#pending = this.#pending.length ? Buffer.concat([this.#pending, chunk]) : chunk
    while (this.#pending.length >= 8) {
      const size = this.#pending.readUInt32BE(4)
      if (this.#pending.length < 8 + size) return
      const kind = this.#pending[0]
      const data = this.#pending.subarray(8, 8 + size)
      this.#pending = this.#pending.subarray(8 + size)
      if (kind === 1 || kind === 0) this.#emit('stdout', data)
      else if (kind === 2) this.#emit('stderr', data)
    }
  }

  /** Whether a partial frame is left over. */
  get partial(): boolean {
    return this.#pending.length > 0
  }
}

/** The JSON lines of a progress stream, such as a pull's. */
export async function* jsonLines(response: Readable): AsyncGenerator<Record<string, unknown>> {
  let pending = ''
  for await (const chunk of response) {
    pending += Buffer.from(chunk as Uint8Array).toString('utf8')
    let newline: number
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline).trim()
      pending = pending.slice(newline + 1)
      if (line) yield JSON.parse(line) as Record<string, unknown>
    }
  }
  if (pending.trim()) yield JSON.parse(pending) as Record<string, unknown>
}
