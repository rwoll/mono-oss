import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { emulateCommand, type EmulatedFile } from '../src/conformance.ts'
import { EXEC_ID_ENV, KILL_SCRIPT } from '../src/docker/index.ts'
import type { DockerTarget } from '../src/docker/engine.ts'
import { entryHeader } from '../src/docker/tar.ts'

// Test helper: an in-process Docker Engine API on a unix socket, with containers whose files live in
// memory and whose commands `emulateCommand` answers. It implements the endpoints the docker backend
// uses, as the daemon does, closely enough for the backend conformance suite.

// Docker API request bodies, read the way the real engine reads them.
// oxlint-disable-next-line typescript/no-explicit-any
type Json = any

export interface FakeEntry {
  type: 'file' | 'dir' | 'symlink'
  data: Buffer
  mode: number
  uid: number
  gid: number
  target?: string
  mtime: number
}

export type FakeFs = Map<string, FakeEntry>

export interface FakeImage {
  id: string
  tags: Set<string>
  labels: Record<string, string>
  entrypoint: string[] | null
  cmd: string[] | null
  fs: FakeFs
  created: number
}

export interface FakeContainer {
  id: string
  name: string
  image: string
  imageId: string
  labels: Record<string, string>
  state: 'created' | 'running' | 'exited'
  created: number
  /** The create request's body, as the backend sent it. */
  body: Record<string, Json>
  fs: FakeFs
  ports: { guest: number; host: number }[]
  networkMode: string
  ip: string | null
}

export interface FakeExecRecord {
  id: string
  container: string
  cmd: string[]
  user: string
  env: string[]
  attachStdin: boolean
  running: boolean
  exitCode: number | null
  stdin: string
  controller: AbortController
}

export interface FakeRequest {
  method: string
  path: string
  query: URLSearchParams
  body?: unknown
}

const PASSWD = 'root:x:0:0:root:/root:/bin/bash\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\nubuntu:x:1000:1000:Ubuntu:/home/ubuntu:/bin/bash\n'
const GROUP = 'root:x:0:\nnogroup:x:65534:\nubuntu:x:1000:\n'

/** An Ubuntu-like file system: the folders and files the backend and the conformance suite touch. */
export function baseFs(): FakeFs {
  const now = Math.floor(Date.now() / 1000)
  const fs: FakeFs = new Map()
  const dir = (path: string, mode = 0o755, uid = 0) => fs.set(path, { type: 'dir', data: Buffer.alloc(0), mode, uid, gid: uid, mtime: now })
  const file = (path: string, data: string, mode = 0o644) => fs.set(path, { type: 'file', data: Buffer.from(data), mode, uid: 0, gid: 0, mtime: now })
  for (const path of ['/', '/etc', '/usr', '/usr/bin', '/var', '/home', '/root']) dir(path, path === '/root' ? 0o700 : 0o755)
  dir('/tmp', 0o1777)
  dir('/var/tmp', 0o1777)
  dir('/home/ubuntu', 0o750, 1000)
  file('/etc/passwd', PASSWD)
  file('/etc/group', GROUP)
  file('/etc/hostname', 'fake\n')
  file('/usr/bin/sh', '\x7fELF', 0o755)
  fs.set('/bin', { type: 'symlink', data: Buffer.alloc(0), mode: 0o777, uid: 0, gid: 0, target: 'usr/bin', mtime: now })
  return fs
}

function cloneFs(fs: FakeFs): FakeFs {
  return new Map([...fs].map(([path, entry]) => [path, { ...entry, data: Buffer.from(entry.data) }]))
}

/** Normalizes a reference the way the daemon matches it: a digest wins over a tag, and no tag means latest. */
function normalize(ref: string): string {
  const at = ref.indexOf('@')
  if (at !== -1) return `${ref.slice(0, at).replace(/:[\w][\w.-]*$/, '')}${ref.slice(at)}`
  const last = ref.slice(ref.lastIndexOf('/') + 1)
  return last.includes(':') ? ref : `${ref}:latest`
}

/** Go's os.FileMode for an entry, as the daemon's path stat reports it. */
function goMode(entry: FakeEntry): number {
  let mode = entry.mode & 0o777
  if (entry.mode & 0o4000) mode += 2 ** 23
  if (entry.mode & 0o2000) mode += 2 ** 22
  if (entry.mode & 0o1000) mode += 2 ** 20
  if (entry.type === 'dir') mode += 2 ** 31
  if (entry.type === 'symlink') mode += 2 ** 27
  return mode
}

/** Parses a whole tar archive: ustar headers, with PAX path and size records. */
export function parseTar(data: Buffer): { name: string; type: string; mode: number; uid: number; gid: number; data: Buffer }[] {
  const entries: { name: string; type: string; mode: number; uid: number; gid: number; data: Buffer }[] = []
  let at = 0
  let pax: Record<string, string> = {}
  const text = (offset: number, length: number) => {
    const raw = data.subarray(at + offset, at + offset + length)
    const end = raw.indexOf(0)
    return raw.subarray(0, end === -1 ? length : end).toString('utf8')
  }
  while (at + 512 <= data.length) {
    if (data.subarray(at, at + 512).every((byte) => byte === 0)) break
    let sum = 0
    for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 32 : data[at + i]!
    if (sum !== parseInt(text(148, 8).trim(), 8)) throw new Error('bad tar checksum')
    const type = text(156, 1) || '0'
    const size = pax.size ? Number(pax.size) : parseInt(text(124, 12).trim() || '0', 8)
    const prefix = text(345, 155)
    const name = pax.path ?? (prefix ? `${prefix}/${text(0, 100)}` : text(0, 100))
    const body = data.subarray(at + 512, at + 512 + size)
    if (body.length !== size) throw new Error('truncated tar entry')
    if (type === 'x') {
      pax = {}
      let record = 0
      while (record < body.length) {
        const space = body.indexOf(0x20, record)
        const length = Number(body.subarray(record, space).toString())
        const line = body.subarray(space + 1, record + length - 1).toString('utf8')
        pax[line.slice(0, line.indexOf('='))] = line.slice(line.indexOf('=') + 1)
        record += length
      }
    } else {
      entries.push({ name, type, mode: parseInt(text(100, 8).trim(), 8), uid: parseInt(text(108, 8).trim(), 8), gid: parseInt(text(116, 8).trim(), 8), data: Buffer.from(body) })
      pax = {}
    }
    at += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}

class HttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface FakeDockerOptions {
  /** The daemon's newest Engine API version. Default 1.54. */
  apiVersion?: string
  minApiVersion?: string
  /** Reports AppArmor in `/info`, as Linux daemons with AppArmor do. */
  apparmor?: boolean
  /** The CPUs `/info` reports. Default 8. */
  cpus?: number
  /** Images it has before any pull. Default the conformance suite's Ubuntu image. */
  images?: string[]
}

export class FakeDockerEngine {
  readonly target: DockerTarget
  readonly requests: FakeRequest[] = []
  readonly containers = new Map<string, FakeContainer>()
  readonly images = new Map<string, FakeImage>()
  readonly execs = new Map<string, FakeExecRecord>()
  /** Docker networks that exist besides the built-in ones. */
  readonly networks = new Set<string>(['desktops'])
  /** References a pull fails for. */
  readonly unpullable = new Set<string>()
  /**
   * How many container lists after a stop still say the container runs, as the daemon's list can for a
   * moment after it answers a stop.
   */
  staleListsAfterStop = 0
  readonly #stale = new Map<string, number>()
  readonly info: Record<string, unknown>
  readonly version: Record<string, unknown>
  readonly #server: Server
  readonly #dir: string
  #nextPort = 20000
  #nextIp = 2

  private constructor(server: Server, dir: string, socketPath: string, options: FakeDockerOptions) {
    this.#server = server
    this.#dir = dir
    this.target = { kind: 'unix', socketPath }
    this.version = { Version: '29.4.1', ApiVersion: options.apiVersion ?? '1.54', MinAPIVersion: options.minApiVersion ?? '1.40', Os: 'linux', Arch: 'arm64', Platform: { Name: 'Fake Docker Engine' } }
    this.info = {
      OperatingSystem: 'Fake Linux',
      OSType: 'linux',
      Architecture: 'aarch64',
      SecurityOptions: ['name=seccomp,profile=builtin', ...(options.apparmor ? ['name=apparmor'] : []), 'name=cgroupns'],
      NCPU: options.cpus ?? 8,
    }
  }

  static async start(options: FakeDockerOptions = {}): Promise<FakeDockerEngine> {
    // Unix socket paths are short (104 bytes on macOS), so the folder name is too.
    const dir = await mkdtemp(join(tmpdir(), 'bfd-'))
    const socketPath = join(dir, 'd.sock')
    const server = createServer()
    const engine = new FakeDockerEngine(server, dir, socketPath, options)
    for (const ref of options.images ?? ['ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac']) engine.addImage(ref)
    server.on('request', (req, res) => void engine.#handle(req, res))
    server.on('upgrade', (req, socket, head) => void engine.#upgrade(req, socket as Socket, head))
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    return engine
  }

  async close(): Promise<void> {
    for (const exec of this.execs.values()) exec.controller.abort()
    this.#server.closeAllConnections()
    await new Promise((resolve) => this.#server.close(resolve))
    await rm(this.#dir, { recursive: true, force: true })
  }

  /** Adds an image as if it had been pulled. */
  addImage(ref: string, options: { labels?: Record<string, string>; entrypoint?: string[] | null; cmd?: string[] | null } = {}): FakeImage {
    const image: FakeImage = {
      id: `sha256:${randomBytes(32).toString('hex')}`,
      tags: new Set([normalize(ref)]),
      labels: { 'org.opencontainers.image.version': '24.04', ...options.labels },
      entrypoint: options.entrypoint ?? null,
      cmd: options.cmd === undefined ? ['/bin/bash'] : options.cmd,
      fs: baseFs(),
      created: Math.floor(Date.now() / 1000),
    }
    this.images.set(image.id, image)
    return image
  }

  /** The create bodies the backend sent, newest last. */
  get creates(): Record<string, Json>[] {
    return this.requests.filter((request) => request.method === 'POST' && request.path === '/containers/create').map((request) => request.body as Record<string, Json>)
  }

  findImage(ref: string): FakeImage | undefined {
    if (ref.startsWith('sha256:')) return this.images.get(ref)
    const wanted = normalize(ref)
    return [...this.images.values()].find((image) => image.tags.has(wanted))
  }

  findContainer(idOrName: string): FakeContainer | undefined {
    return this.containers.get(idOrName) ?? [...this.containers.values()].find((container) => container.name === idOrName || (idOrName.length >= 12 && container.id.startsWith(idOrName)))
  }

  #container(idOrName: string): FakeContainer {
    const container = this.findContainer(idOrName)
    if (!container) throw new HttpError(404, `No such container: ${idOrName}`)
    return container
  }

  async #body(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks)
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://docker')
    const path = url.pathname.replace(/^\/v\d+\.\d+/, '')
    const raw = await this.#body(req)
    const json = req.headers['content-type'] === 'application/json' && raw.length ? JSON.parse(raw.toString('utf8')) : undefined
    this.requests.push({ method: req.method ?? 'GET', path, query: url.searchParams, ...(json !== undefined ? { body: json } : {}) })
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
      res.end(req.method === 'HEAD' ? undefined : text)
    }
    try {
      const version = /^\/v(\d+\.\d+)\//.exec(url.pathname)?.[1]
      if (version && Number(version.split('.')[1]) > Number(String(this.version.ApiVersion).split('.')[1])) {
        throw new HttpError(400, `client version ${version} is too new. Maximum supported API version is ${this.version.ApiVersion}`)
      }
      const route = `${req.method} ${path}`
      let match: RegExpExecArray | null
      if (route === 'GET /version' || route === 'GET /_ping') return send(200, this.version)
      if (route === 'GET /info') return send(200, this.info)
      if (route === 'GET /containers/json') return send(200, this.#listContainers(url.searchParams))
      if (route === 'POST /containers/create') return send(201, this.#create(url.searchParams.get('name') ?? '', json))
      if ((match = /^POST \/containers\/([^/]+)\/start$/.exec(route))) return send(this.#start(match[1]!) ? 204 : 304)
      if ((match = /^POST \/containers\/([^/]+)\/stop$/.exec(route))) return send(this.#stop(match[1]!) ? 204 : 304)
      if ((match = /^DELETE \/containers\/([^/]+)$/.exec(route))) {
        const container = this.#container(match[1]!)
        if (container.state === 'running' && url.searchParams.get('force') !== 'true') throw new HttpError(409, 'You cannot remove a running container. Stop the container before attempting removal or force remove')
        this.#stop(container.id)
        this.containers.delete(container.id)
        return send(204)
      }
      if ((match = /^GET \/containers\/([^/]+)\/json$/.exec(route))) return send(200, this.#inspect(this.#container(match[1]!)))
      if ((match = /^POST \/containers\/([^/]+)\/exec$/.exec(route))) return send(201, this.#createExec(this.#container(match[1]!), json))
      if ((match = /^POST \/exec\/([^/]+)\/start$/.exec(route))) {
        const exec = this.execs.get(match[1]!)
        if (!exec) throw new HttpError(404, `No such exec instance: ${match[1]}`)
        if (!json?.Detach) throw new HttpError(400, 'This fake attaches only through a protocol upgrade.')
        void this.#run(exec)
        return send(200)
      }
      if ((match = /^GET \/exec\/([^/]+)\/json$/.exec(route))) {
        const exec = this.execs.get(match[1]!)
        if (!exec) throw new HttpError(404, `No such exec instance: ${match[1]}`)
        return send(200, { ID: exec.id, Running: exec.running, ExitCode: exec.exitCode, Pid: 1234 })
      }
      if ((match = /^(HEAD|GET|PUT) \/containers\/([^/]+)\/archive$/.exec(route))) {
        const container = this.#container(match[2]!)
        const target = url.searchParams.get('path') ?? ''
        if (match[1] === 'PUT') {
          this.#extract(container, target, raw, url.searchParams.get('noOverwriteDirNonDir') === 'true')
          return send(200)
        }
        const resolved = this.#lookup(container.fs, target)
        if (!resolved) throw new HttpError(404, `Could not find the file ${target} in container ${container.name}`)
        const stat = { name: posix.basename(resolved.path), size: resolved.entry.data.length, mode: goMode(resolved.entry), mtime: new Date(resolved.entry.mtime * 1000).toISOString(), linkTarget: resolved.entry.type === 'symlink' ? posix.resolve(posix.dirname(resolved.path), resolved.entry.target!) : '' }
        const headers = { 'X-Docker-Container-Path-Stat': Buffer.from(JSON.stringify(stat)).toString('base64'), 'Content-Type': 'application/x-tar' }
        if (match[1] === 'HEAD') return send(200, undefined, headers)
        res.writeHead(200, headers)
        res.end(this.#archive(resolved.path, resolved.entry))
        return
      }
      if (route === 'GET /images/json') return send(200, this.#listImages(url.searchParams))
      if ((match = /^GET \/images\/(.+)\/json$/.exec(route))) {
        const image = this.findImage(decodeURIComponent(match[1]!))
        if (!image) throw new HttpError(404, `No such image: ${match[1]}`)
        return send(200, { Id: image.id, RepoTags: [...image.tags], Created: new Date(image.created * 1000).toISOString(), Config: { Labels: image.labels, Entrypoint: image.entrypoint, Cmd: image.cmd } })
      }
      if (route === 'POST /images/create') return this.#pull(url.searchParams, res)
      if ((match = /^DELETE \/images\/(.+)$/.exec(route))) {
        const ref = decodeURIComponent(match[1]!)
        const image = this.findImage(ref)
        if (!image) throw new HttpError(404, `No such image: ${ref}`)
        const user = [...this.containers.values()].find((container) => container.imageId === image.id)
        if (user) throw new HttpError(409, `conflict: unable to remove repository reference "${ref}" (must force) - container ${user.id.slice(0, 12)} is using its referenced image ${image.id.slice(7, 19)}`)
        image.tags.delete(normalize(ref))
        if (!image.tags.size || ref.startsWith('sha256:')) this.images.delete(image.id)
        return send(200, [{ Untagged: ref }])
      }
      if (route === 'POST /commit') return send(201, this.#commit(url.searchParams, json ?? {}))
      throw new HttpError(404, `page not found: ${route}`)
    } catch (error) {
      if (error instanceof HttpError) return send(error.status, { message: error.message })
      return send(500, { message: (error as Error).message })
    }
  }

  #listContainers(query: URLSearchParams): unknown[] {
    const filters = JSON.parse(query.get('filters') ?? '{}') as Record<string, string[]>
    return [...this.containers.values()]
      .filter((container) => query.get('all') === 'true' || container.state === 'running')
      .filter((container) => (filters.label ?? []).every((filter) => this.#labelMatches(container.labels, filter)))
      .filter((container) => (filters.name ?? []).every((pattern) => new RegExp(pattern).test(`/${container.name}`)))
      .filter((container) => (filters.ancestor ?? []).every((ref) => this.findImage(ref)?.id === container.imageId))
      .map((container) => {
        const stale = this.#stale.get(container.id) ?? 0
        if (stale > 0) this.#stale.set(container.id, stale - 1)
        return { container, state: stale > 0 ? 'running' : container.state }
      })
      .map(({ container, state }) => ({
        Id: container.id,
        Names: [`/${container.name}`],
        Image: container.image,
        ImageID: container.imageId,
        Created: container.created,
        State: state,
        Labels: container.labels,
        Ports: container.state === 'running' ? container.ports.map((port) => ({ IP: '127.0.0.1', PrivatePort: port.guest, PublicPort: port.host, Type: 'tcp' })) : [],
        HostConfig: { NetworkMode: container.networkMode },
        NetworkSettings: { Networks: container.ip && container.state === 'running' ? { [container.networkMode]: { IPAddress: container.ip } } : {} },
      }))
  }

  #labelMatches(labels: Record<string, string>, filter: string): boolean {
    const equals = filter.indexOf('=')
    return equals === -1 ? filter in labels : labels[filter.slice(0, equals)] === filter.slice(equals + 1)
  }

  #inspect(container: FakeContainer): unknown {
    return { Id: container.id, Name: `/${container.name}`, Config: { Labels: container.labels }, HostConfig: container.body.HostConfig, State: { Status: container.state } }
  }

  #create(name: string, body: Record<string, Json>): { Id: string } {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(name)) throw new HttpError(400, `Invalid container name (${name})`)
    const existing = [...this.containers.values()].find((container) => container.name === name)
    if (existing) throw new HttpError(409, `Conflict. The container name "/${name}" is already in use by container "${existing.id}". You have to remove (or rename) that container to be able to reuse that name.`)
    const image = this.findImage(body.Image)
    if (!image) throw new HttpError(404, `No such image: ${body.Image}`)
    const host = body.HostConfig ?? {}
    const networkMode = host.NetworkMode ?? 'bridge'
    if (!['bridge', 'none', 'default'].includes(networkMode) && !this.networks.has(networkMode)) throw new HttpError(404, `network ${networkMode} not found`)
    if (networkMode === 'none' && Object.keys(host.PortBindings ?? {}).length) throw new HttpError(400, 'conflicting options: port publishing and the container type network mode')
    if (host.Privileged || host.CapAdd?.length || host.Binds?.length || host.Mounts?.length) throw new HttpError(400, 'This fake refuses privileged containers, added capabilities, and mounts.')
    const id = randomBytes(32).toString('hex')
    this.containers.set(id, {
      id,
      name,
      image: body.Image,
      imageId: image.id,
      labels: { ...image.labels, ...body.Labels },
      state: 'created',
      created: Math.floor(Date.now() / 1000),
      body,
      fs: cloneFs(image.fs),
      ports: [],
      networkMode,
      ip: null,
    })
    return { Id: id }
  }

  #start(idOrName: string): boolean {
    const container = this.#container(idOrName)
    if (container.state === 'running') return false
    const ports: { guest: number; host: number }[] = []
    for (const [key, bindings] of Object.entries((container.body.HostConfig?.PortBindings ?? {}) as Record<string, { HostIp: string; HostPort: string }[]>)) {
      const host = bindings[0]?.HostPort ? Number(bindings[0].HostPort) : this.#nextPort++
      const taken = [...this.containers.values()].some((other) => other.state === 'running' && other.ports.some((port) => port.host === host))
      if (taken) throw new HttpError(500, `driver failed programming external connectivity on endpoint ${container.name}: Bind for 127.0.0.1:${host} failed: port is already allocated`)
      ports.push({ guest: Number(key.split('/')[0]), host })
    }
    container.ports = ports
    container.ip = ['bridge', 'none', 'default'].includes(container.networkMode) ? null : `172.30.0.${this.#nextIp++}`
    container.state = 'running'
    return true
  }

  #stop(idOrName: string): boolean {
    const container = this.#container(idOrName)
    if (container.state !== 'running') return false
    for (const exec of this.execs.values()) if (exec.container === container.id && exec.running) exec.controller.abort(new Error('stopped'))
    container.state = 'exited'
    container.ports = []
    container.ip = null
    if (this.staleListsAfterStop) this.#stale.set(container.id, this.staleListsAfterStop)
    return true
  }

  #createExec(container: FakeContainer, body: Record<string, Json>): { Id: string } {
    if (container.state !== 'running') throw new HttpError(409, `container ${container.id} is not running`)
    const id = randomBytes(32).toString('hex')
    this.execs.set(id, {
      id,
      container: container.id,
      cmd: body.Cmd,
      user: body.User || 'root',
      env: body.Env ?? [],
      attachStdin: Boolean(body.AttachStdin),
      running: false,
      exitCode: null,
      stdin: '',
      controller: new AbortController(),
    })
    return { Id: id }
  }

  /** Runs a command: the backend's kill script kills the commands with its marker; anything else is emulated. */
  async #run(exec: FakeExecRecord, output?: (stream: 1 | 2, text: string) => void): Promise<void> {
    exec.running = true
    const container = this.containers.get(exec.container)!
    let result: { exitCode: number; stdout: string; stderr: string }
    if (exec.cmd[0] === 'sh' && exec.cmd[2] === KILL_SCRIPT) {
      const wanted = `${EXEC_ID_ENV}=${exec.cmd[4]}`
      for (const other of this.execs.values()) if (other.running && other.container === container.id && other.user === exec.user && other.env.includes(wanted)) other.controller.abort(new Error('killed'))
      result = { exitCode: 0, stdout: '', stderr: '' }
    } else {
      const env = Object.fromEntries(exec.env.map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]))
      const names = new Map(PASSWD.trim().split('\n').map((line) => [Number(line.split(':')[2]), line.split(':')[0]!]))
      const files = new Map<string, EmulatedFile>()
      for (const [path, entry] of container.fs) if (entry.type === 'file') files.set(path, { data: entry.data, mode: entry.mode, user: names.get(entry.uid) ?? String(entry.uid) })
      try {
        result = await emulateCommand(exec.cmd, { user: exec.user, env, stdin: exec.stdin, signal: exec.controller.signal }, files)
      } catch {
        result = { exitCode: 137, stdout: '', stderr: '' }
      }
    }
    if (result.stdout) output?.(1, result.stdout)
    if (result.stderr) output?.(2, result.stderr)
    exec.exitCode = result.exitCode
    exec.running = false
  }

  async #upgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://docker')
    const path = url.pathname.replace(/^\/v\d+\.\d+/, '')
    const exec = this.execs.get(/^\/exec\/([^/]+)\/start$/.exec(path)?.[1] ?? '')
    socket.on('error', () => {})
    if (!exec) {
      socket.end('HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{"message":"No such exec instance"}')
      return
    }
    // Node 26 hands an upgrade request's body to the request, and what follows it, stdin, to the socket.
    // Node 24 leaves the body on the socket too, so take any part the request didn't get from there.
    const chunks: Buffer[] = head.length ? [head] : []
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    const ending = new Promise<void>((resolve) => socket.once('end', resolve))
    let raw = await this.#body(req)
    const missing = Number(req.headers['content-length'] ?? 0) - raw.length
    if (missing > 0) {
      while (Buffer.concat(chunks).length < missing && !socket.readableEnded) await new Promise((resolve) => socket.once('data', resolve).once('end', resolve))
      const pending = Buffer.concat(chunks)
      raw = Buffer.concat([raw, pending.subarray(0, missing)])
      chunks.splice(0, chunks.length, pending.subarray(missing))
    }
    const body = JSON.parse(raw.toString('utf8') || '{}')
    this.requests.push({ method: 'POST', path, query: url.searchParams, body })
    socket.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.multiplexed-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n')
    if (exec.attachStdin) {
      await ending
      exec.stdin = Buffer.concat(chunks).toString('utf8')
    }
    await this.#run(exec, (stream, text) => {
      const data = Buffer.from(text, 'utf8')
      // Split into frames of a few bytes, so clients must join frames and characters that span them.
      for (let at = 0; at < data.length; at += 3) {
        const part = data.subarray(at, at + 3)
        const frame = Buffer.alloc(8)
        frame[0] = stream
        frame.writeUInt32BE(part.length, 4)
        if (!socket.destroyed) socket.write(Buffer.concat([frame, part]))
      }
    })
    if (!socket.destroyed) socket.end()
  }

  #lookup(fs: FakeFs, path: string): { path: string; entry: FakeEntry } | undefined {
    // Folders along the way may be links; the last part is not followed.
    const parts = posix.normalize(path).split('/').filter(Boolean)
    let current = '/'
    for (const [index, part] of parts.entries()) {
      let next = posix.join(current, part)
      let entry = fs.get(next)
      for (let hops = 0; entry?.type === 'symlink' && index < parts.length - 1 && hops < 8; hops += 1) {
        next = posix.resolve(current, entry.target!)
        entry = fs.get(next)
      }
      if (!entry) return undefined
      current = next
    }
    const entry = fs.get(current)
    return entry ? { path: current, entry } : undefined
  }

  #archive(path: string, entry: FakeEntry): Buffer {
    const name = posix.basename(path) || '.'
    if (entry.type !== 'file') {
      const header = Buffer.from(entryHeader({ name, type: 'directory', mode: entry.mode, uid: entry.uid, gid: entry.gid, size: 0, mtime: entry.mtime }))
      if (entry.type === 'symlink') {
        header.write('2', 156, 'ascii')
        header.write(entry.target!, 157, 100, 'utf8')
        header.write('        ', 148, 'ascii')
        let sum = 0
        for (const byte of header) sum += byte
        header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
      }
      return Buffer.concat([header, Buffer.alloc(1024)])
    }
    const header = entryHeader({ name, type: 'file', mode: entry.mode, uid: entry.uid, gid: entry.gid, size: entry.data.length, mtime: entry.mtime })
    return Buffer.concat([header, entry.data, Buffer.alloc((512 - (entry.data.length % 512)) % 512), Buffer.alloc(1024)])
  }

  #extract(container: FakeContainer, base: string, archive: Buffer, noOverwriteDirNonDir: boolean): void {
    const at = this.#lookup(container.fs, base)
    if (!at) throw new HttpError(404, `Could not find the file ${base} in container ${container.name}`)
    if (at.entry.type !== 'dir') throw new HttpError(400, `extraction point is not a directory`)
    const now = Math.floor(Date.now() / 1000)
    for (const entry of parseTar(archive)) {
      const path = posix.join(at.path, entry.name).replace(/(.)\/+$/, '$1')
      const existing = container.fs.get(path)
      for (let parent = posix.dirname(path); !container.fs.has(parent); parent = posix.dirname(parent)) {
        container.fs.set(parent, { type: 'dir', data: Buffer.alloc(0), mode: 0o755, uid: 0, gid: 0, mtime: now })
      }
      if (entry.type === '5') {
        // Like the daemon, an existing folder gets the entry's mode and owner.
        container.fs.set(path, { type: 'dir', data: Buffer.alloc(0), mode: entry.mode, uid: entry.uid, gid: entry.gid, mtime: now })
        continue
      }
      if (existing?.type === 'dir' && noOverwriteDirNonDir) throw new HttpError(400, `cannot overwrite directory "${path}" with non-directory "${path}"`)
      container.fs.set(path, { type: 'file', data: entry.data, mode: entry.mode, uid: entry.uid, gid: entry.gid, mtime: now })
    }
  }

  #listImages(query: URLSearchParams): unknown[] {
    const filters = JSON.parse(query.get('filters') ?? '{}') as Record<string, string[]>
    const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
    return [...this.images.values()]
      .filter((image) => (filters.label ?? []).every((filter) => this.#labelMatches(image.labels, filter)))
      .filter((image) => (filters.reference ?? []).every((pattern) => [...image.tags].some((tag) => glob(pattern).test(tag))))
      .map((image) => ({ Id: image.id, RepoTags: [...image.tags], Created: image.created, Labels: image.labels }))
  }

  #pull(query: URLSearchParams, res: ServerResponse): void {
    const from = query.get('fromImage') ?? ''
    const tag = query.get('tag')
    if (!tag && !/[:@]/.test(from.slice(from.lastIndexOf('/') + 1))) throw new HttpError(400, 'This fake refuses to pull every tag of a repository.')
    const ref = tag ? `${from}:${tag}` : from
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (this.unpullable.has(ref)) {
      res.end(`${JSON.stringify({ status: 'Pulling from library/x' })}\n${JSON.stringify({ errorDetail: { message: `pull access denied for ${ref}` }, error: `pull access denied for ${ref}` })}\n`)
      return
    }
    if (!this.findImage(ref)) this.addImage(ref)
    const lines = [{ status: `Pulling from ${from}`, id: tag ?? 'latest' }, { status: 'Downloading', id: 'abc123', progressDetail: { current: 512, total: 1024 } }, { status: 'Pull complete', id: 'abc123' }, { status: `Status: Downloaded newer image for ${ref}` }]
    res.end(lines.map((line) => `${JSON.stringify(line)}\n`).join(''))
  }

  #commit(query: URLSearchParams, body: Record<string, Json>): { Id: string } {
    const container = this.#container(query.get('container') ?? '')
    const repo = query.get('repo')
    const tag = query.get('tag') || 'latest'
    const base = this.images.get(container.imageId)!
    // As the daemon merges: the request's settings win, and the container's fill in the rest.
    const labels = { ...container.labels, ...body.Labels }
    let entrypoint: string[] | null = body.Entrypoint ?? null
    let cmd: string[] | null = body.Cmd ?? null
    if (!entrypoint?.length && !cmd?.length) {
      entrypoint = container.body.Entrypoint ?? base.entrypoint
      cmd = container.body.Cmd ?? base.cmd
    }
    const image: FakeImage = { id: `sha256:${randomBytes(32).toString('hex')}`, tags: new Set(repo ? [normalize(`${repo}:${tag}`)] : []), labels, entrypoint, cmd, fs: cloneFs(container.fs), created: Math.floor(Date.now() / 1000) }
    this.images.set(image.id, image)
    return { Id: image.id }
  }
}
