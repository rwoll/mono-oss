import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect, isIP } from 'node:net'
import type { Duplex, Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { connect as tlsConnect } from 'node:tls'
import { createHTTPHandler } from '@trpc/server/adapters/standalone'
import { SandboxError, type Backend, type Endpoint, type ReadRange } from './backend.ts'
import type { BackendSelection } from './backends.ts'
import { endpointUrl } from './net.ts'
import { NAME_PATTERN, type Sandboxes } from './sandboxes.ts'
import { Jobs } from './jobs.ts'
import { appRouter } from './router.ts'

export interface ServeOptions {
  /** The engine, created on first use. */
  engine: () => Promise<Sandboxes>
  /** Which backend the engine runs on, and why, for `doctor`. */
  selection?: BackendSelection
  /** Clients send it as `Authorization: Bearer <token>`. */
  token: string
  /** Default 127.0.0.1. Put anything else behind TLS. */
  host?: string
  /** Default 0: any free port. */
  port?: number
  /** How long a viewer link works. Default 8 hours. */
  viewerTicketMs?: number
  /** The engine host's environment, for its state folder (start records) and host ID. Default `process.env`. */
  env?: NodeJS.ProcessEnv
  /** The backend without an owner filter, for `list --all`. */
  others?: () => Promise<Backend | null>
}

export interface Served {
  server: Server
  /** The server's base URL, for `blobby-sandbox --server`. */
  url: string
  close(): Promise<void>
}

const TICKET = /^\/viewer\/([a-f0-9]{48})(\/.*)?$/
const FILES = /^\/files\/([^/]+)$/
const MEDIA = /^\/media\/([^/]+)\/([a-f0-9]{8,64})$/
const USER = /^[a-z_][a-z0-9_-]{0,31}$/

/** The HTTP status of a SandboxError's code. */
function statusOf(code: string): number {
  if (code === 'not_found') return 404
  if (code === 'unauthorized') return 401
  if (code === 'usage' || code.startsWith('invalid')) return 400
  if (code === 'range_not_satisfiable') return 416
  return 409
}

/** A `Range: bytes=<first>-[<last>]` header as a read range. Suffix ranges and lists aren't supported. */
function parseRange(header: string | undefined): ReadRange | undefined {
  if (!header) return undefined
  const match = /^bytes=(\d{1,15})-(\d{1,15})?$/.exec(header.trim())
  if (!match) throw new SandboxError('range_not_satisfiable', 'Only ranges like bytes=<first>-[<last>] are supported.')
  const offset = Number(match[1])
  if (match[2] === undefined) return { offset }
  const last = Number(match[2])
  if (last < offset) throw new SandboxError('range_not_satisfiable', 'The range ends before it starts.')
  return { offset, length: last - offset + 1 }
}

/** A request's URL, or null for a target that is not a path, such as `//[`, which `new URL` throws on. */
function requestUrl(url: string | undefined): URL | null {
  if (!url?.startsWith('/') || url.startsWith('//')) return null
  try {
    return new URL(url, 'http://localhost')
  } catch {
    return null
  }
}

function sameToken(given: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`)
  const actual = Buffer.from(given ?? '')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** Where a viewer request goes: the endpoint's URL with the rest of the request's path under it, and the headers the endpoint needs. */
function upstreamOf(endpoint: Endpoint, rest: string, search: string): { url: URL; headers: Record<string, string> } {
  const { url, headers } = endpointUrl(endpoint)
  // Appended to the endpoint's path, never resolved against it, so no request reaches outside it.
  url.pathname = `${url.pathname}${rest.replace(/^\/+/, '')}`
  url.search = search
  return { url, headers }
}

/**
 * Serves the engine over HTTP for remote clients: the tRPC API at `/trpc/`, which needs the token, and
 * sandbox viewers at `/viewer/<ticket>/`, which a `view` call opens for a while. A ticket is the only
 * credential in a viewer URL, so the token never ends up in a browser's history. The server relays a
 * viewer to wherever the backend's endpoint for it is, with the headers the endpoint needs.
 */
export async function serve(options: ServeOptions): Promise<Served> {
  const jobs = new Jobs()
  const tickets = new Map<string, { endpoint: Endpoint; expires: number }>()
  const ticketMs = options.viewerTicketMs ?? 8 * 60 * 60_000
  const trpc = createHTTPHandler({
    router: appRouter,
    basePath: '/trpc/',
    maxBodySize: 16 * 1024 * 1024,
    createContext: () => ({
      engine: options.engine,
      selection: options.selection,
      jobs,
      env: options.env,
      others: options.others,
      viewerUrl: async (_sandbox: string, endpoint: Endpoint) => {
        const now = Date.now()
        for (const [ticket, entry] of tickets) if (entry.expires < now) tickets.delete(ticket)
        const ticket = randomBytes(24).toString('hex')
        tickets.set(ticket, { endpoint, expires: now + ticketMs })
        return `/viewer/${ticket}/vnc.html`
      },
    }),
  })

  const viewer = (url: URL | null): { url: URL; headers: Record<string, string> } | null => {
    const match = url ? TICKET.exec(url.pathname) : null
    const entry = match ? tickets.get(match[1]!) : undefined
    if (!url || !match || !entry || entry.expires < Date.now()) return null
    return upstreamOf(entry.endpoint, match[2] ?? '/', url.search)
  }

  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    try {
      handleRequest(req, res)
    } catch {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    }
  }

  const handleRequest = (req: IncomingMessage, res: ServerResponse) => {
    const url = requestUrl(req.url)
    if (!url) {
      res.writeHead(400).end()
      return
    }
    if (FILES.test(url.pathname) || MEDIA.test(url.pathname)) {
      if (!sameToken(req.headers.authorization, options.token)) {
        const message = 'This sandbox server needs its token. Set BLOBBY_SANDBOX_TOKEN to the token `blobby-sandbox serve` printed.'
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'unauthorized', message } }))
        return
      }
      void transfer(req, res, url)
      return
    }
    if (url.pathname.startsWith('/trpc/')) {
      if (!sameToken(req.headers.authorization, options.token)) {
        // Shaped like a tRPC error, so clients get the library's code and this message.
        const message = 'This sandbox server needs its token. Set BLOBBY_SANDBOX_TOKEN to the token `blobby-sandbox serve` printed.'
        const error = { message, code: -32001, data: { code: 'UNAUTHORIZED', httpStatus: 401, sandboxCode: 'unauthorized' } }
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error }))
        return
      }
      void trpc(req, res)
      return
    }
    const target = viewer(url)
    if (!target) {
      res.writeHead(404).end()
      return
    }
    const request = target.url.protocol === 'https:' ? httpsRequest : httpRequest
    const upstream = request(target.url, { method: req.method, headers: { ...req.headers, ...target.headers, host: target.url.host } }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(res)
    })
    upstream.on('error', () => (res.headersSent ? res.destroy() : res.writeHead(502).end()))
    req.pipe(upstream)
  }

  /**
   * Streams files and recordings, which tRPC's JSON can't carry without holding them whole:
   * `GET /files/<sandbox>?path=<path>` and `GET /media/<sandbox>/<id>` (both take a `Range` header), and
   * `PUT /files/<sandbox>?path=<path>[&user=<user>][&mode=<octal>]` with the file as the body.
   */
  const transfer = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const fail = (error: unknown) => {
      const known = error instanceof SandboxError
      const body = { error: { code: known ? error.code : 'internal', message: known ? error.message : 'The server failed to move the file.' } }
      if (res.headersSent) res.destroy()
      else res.writeHead(known ? statusOf(error.code) : 500, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    }
    try {
      const files = FILES.exec(url.pathname)
      const media = MEDIA.exec(url.pathname)
      const name = decodeURIComponent((files ?? media)![1]!)
      if (!NAME_PATTERN.test(name)) throw new SandboxError('invalid_name', `"${name}" is not a valid sandbox name.`)
      const path = url.searchParams.get('path') ?? ''
      const engine = await options.engine()
      if (files && req.method === 'PUT') {
        const user = url.searchParams.get('user') ?? undefined
        const mode = url.searchParams.get('mode')
        if (user !== undefined && !USER.test(user)) throw new SandboxError('usage', `"${user}" is not a user name.`)
        if (mode !== null && !/^[0-7]{1,4}$/.test(mode)) throw new SandboxError('usage', 'mode must be octal, such as 644.')
        await engine.writeFile(name, path, req, { ...(user ? { user } : {}), ...(mode !== null ? { mode: parseInt(mode, 8) } : {}) })
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
        return
      }
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: files ? 'GET, PUT' : 'GET' }).end()
        return
      }
      const range = parseRange(req.headers.range)
      const read: { stream: Readable; size: number } = files ? await engine.readFile(name, path, range) : await engine.mediaStream(name, media![2]!, range)
      const offset = Math.min(range?.offset ?? 0, read.size)
      const length = Math.max(0, Math.min(range?.length ?? Infinity, read.size - offset))
      const headers: Record<string, string> = { 'content-type': files ? 'application/octet-stream' : 'video/mp4', 'content-length': String(length), 'x-blobby-size': String(read.size) }
      if (range) headers['content-range'] = `bytes ${offset}-${offset + length - 1}/${read.size}`
      res.writeHead(range ? 206 : 200, headers)
      await pipeline(read.stream, res).catch(() => res.destroy())
    } catch (error) {
      req.resume()
      fail(error)
    }
  }

  // Upgraded connections leave the server's bookkeeping, so close() ends them itself.
  const upgraded = new Set<Duplex>()
  const track = (socket: Duplex) => {
    upgraded.add(socket)
    socket.once('close', () => upgraded.delete(socket))
  }
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Node removes its own error listener before 'upgrade'; without one, a reset socket crashes the server.
    socket.on('error', () => socket.destroy())
    track(socket)
    const target = viewer(requestUrl(req.url))
    if (!target) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
      return
    }
    const { url, headers } = target
    const secure = url.protocol === 'https:'
    const port = Number(url.port) || (secure ? 443 : 80)
    const host = url.hostname.replace(/^\[(.*)\]$/, '$1')
    const replaced = new Set(['host', ...Object.keys(headers).map((header) => header.toLowerCase())])
    const onConnect = () => {
      const lines = [`${req.method} ${url.pathname}${url.search} HTTP/1.1`, `Host: ${url.host}`]
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (!replaced.has(req.rawHeaders[i]!.toLowerCase())) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
      }
      for (const [header, value] of Object.entries(headers)) lines.push(`${header}: ${value}`)
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    }
    const upstream = secure ? tlsConnect({ host, port, ...(isIP(host) ? {} : { servername: host }) }, onConnect) : connect(port, host, onConnect)
    track(upstream)
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
    upstream.on('close', () => socket.destroy())
    socket.on('close', () => upstream.destroy())
  }

  const server = createServer(onRequest)
  server.on('upgrade', onUpgrade)
  const host = options.host ?? '127.0.0.1'
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  const shown = host.includes(':') ? `[${host}]` : host
  return {
    server,
    url: `http://${shown === '0.0.0.0' ? '127.0.0.1' : shown}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of upgraded) socket.destroy()
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
