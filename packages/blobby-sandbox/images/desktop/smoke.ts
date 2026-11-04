#!/usr/bin/env node
// Smoke test for the desktop image, on plain Docker: no Docker backend, no privileges. It starts a
// container from the image the way the Docker backend does for a sandbox with the command sandbox (the
// pinned seccomp profile and /dev/net/tun, no-new-privileges, no added capabilities), copies the guest
// runtime in, starts the session with runtime/boot.sh, and then checks the desktop through the runtime's
// own guest operations. It removes the container afterwards. Each check is a named entry in CHECKS, so
// more guest operations can be tested the same way.
//
//   node images/desktop/smoke.ts [--image blobby-desktop:latest] [--resolution 1280x800]
//     [--only <check,...>] [--artifacts <dir>] [--without-entrypoint] [--apparmor-unconfined] [--keep] [--json]
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { commandSandboxProfile, dockerDefaultProfile, TUN_DEVICE } from './seccomp/command-sandbox.ts'

export const DEFAULT_IMAGE = 'blobby-desktop:latest'
export const DEFAULT_RUNTIME = fileURLToPath(new URL('../../runtime/', import.meta.url))
/** The guest port noVNC serves the viewer on (VIEWER_PORT in src/). */
export const VIEWER_PORT = 6901
export const TEST_LABEL = 'blobby.dev/test=desktop-smoke'
const RUNTIME_DIR = '/opt/blobby/runtime'
const DESKTOP_USER = 'ubuntu'
const READY_SECONDS = 120
const RECORD_SECONDS = 5

// What guest.py prints, as JSON: each check reads the fields its operation returns.
// oxlint-disable-next-line typescript/no-explicit-any
type Json = any

interface DockerResult {
  code: number
  stdout: string
  stderr: string
}

interface DockerOptions {
  timeoutSeconds?: number
  input?: string
}

/** What a check gets: the running container, and helpers to run commands and guest operations in it. */
export interface SmokeContext {
  resolution: string
  timings: Record<string, number>
  apparmor: boolean
  apparmorUnconfined: boolean
  sessionReady: boolean
  viewerPort: number
  started: number
  exec(user: string, command: string[], options?: { timeoutSeconds?: number; env?: Record<string, string> }): Promise<DockerResult>
  guest(operation: string, input?: Record<string, unknown>, timeoutSeconds?: number): Promise<Json>
  artifact(name: string, data: Buffer): Promise<void>
}

export interface Check {
  name: string
  title: string
  /** Needs the running desktop session; skipped when it didn't start. */
  session?: boolean
  run(t: SmokeContext): Promise<string>
}

interface CheckResult {
  name: string
  ok: boolean
  skipped?: boolean
  seconds?: number
  detail?: string
  error?: string
}

export interface SmokeResult {
  ok: boolean
  image: string
  imageId: string | undefined
  platform: string
  container: string
  resolution: string
  entrypoint: 'none' | 'image'
  timings: Record<string, number>
  checks: CheckResult[]
}

export interface SmokeOptions {
  /** Default `blobby-desktop:latest`. */
  image?: string | undefined
  /** The guest runtime folder. Default: runtime/. */
  runtime?: string | undefined
  /** Default `1280x800`. */
  resolution?: string | undefined
  /** Run only these checks (by name), plus `session` when they need it. */
  only?: string[] | undefined
  /** Save the screenshot and recording in this folder. */
  artifacts?: string | undefined
  /** Run `sleep infinity` instead of the image's entry point (tini), as where a machine boots the image and only runs commands in it. */
  withoutEntrypoint?: boolean | undefined
  /** Run without Docker's AppArmor profile (Linux hosts with AppArmor). */
  apparmorUnconfined?: boolean | undefined
  /** Leave the container running, to look around. */
  keep?: boolean | undefined
  onProgress?: ((line: string) => void) | undefined
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Parses `runtime/session.env`, as blobby-sandbox does: the session's display and buses. */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim())
    if (match) env[match[1]!] = match[2]!
  }
  return env
}

/** Width and height of a PNG, or throws if it isn't one. */
export function pngSize(data: Buffer): { width: number; height: number } {
  if (data.length < 24 || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || data.subarray(12, 16).toString() !== 'IHDR') {
    throw new Error('the screenshot is not a PNG')
  }
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
}

/** The top-level box types of an MP4 file, or throws if it isn't one. */
export function mp4Boxes(data: Buffer): string[] {
  const boxes: string[] = []
  let offset = 0
  while (offset + 8 <= data.length) {
    let size = data.readUInt32BE(offset)
    const type = data.subarray(offset + 4, offset + 8).toString('latin1')
    if (size === 1 && offset + 16 <= data.length) size = Number(data.readBigUInt64BE(offset + 8))
    else if (size === 0) size = data.length - offset
    if (size < 8 || !/^[\x20-\x7e]{4}$/.test(type)) throw new Error(`the recording has a malformed box at byte ${offset}`)
    boxes.push(type)
    offset += size
  }
  if (boxes[0] !== 'ftyp' || !boxes.includes('moov') || !boxes.includes('mdat')) {
    throw new Error(`the recording is not an MP4 file (boxes: ${boxes.join(', ') || 'none'})`)
  }
  return boxes
}

/** Runs docker without a shell, with a time limit. */
function docker(args: string[], { timeoutSeconds = 120, input }: DockerOptions = {}): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutSeconds * 1000)
    child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`the docker CLI didn't run: ${error.message}`))
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const result = { code: code ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }
      if (signal === 'SIGKILL') reject(new Error(`docker ${args.slice(0, 2).join(' ')} took longer than ${timeoutSeconds} seconds`))
      else resolve(result)
    })
    if (input !== undefined) child.stdin?.end(input)
  })
}

async function dockerOk(args: string[], options?: DockerOptions): Promise<DockerResult> {
  const result = await docker(args, options)
  if (result.code !== 0) throw new Error(`docker ${args.slice(0, 2).join(' ')} failed: ${(result.stderr || result.stdout).trim().split('\n').slice(-5).join('\n')}`)
  return result
}

/** An HTTP GET of the viewer's page. */
async function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(10_000) })
  return { status: response.status, body: await response.text() }
}

/** Opens the viewer's WebSocket as noVNC does and returns the first message, which the VNC server sends. */
function websocketHello(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('the viewer\'s WebSocket sent nothing for 10 seconds'))
    }, 10_000)
    let buffer = Buffer.alloc(0)
    socket.on('connect', () => {
      socket.write(
        [
          'GET /websockify HTTP/1.1',
          `Host: 127.0.0.1:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Protocol: binary',
          '',
          '',
        ].join('\r\n'),
      )
    })
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf('\r\n\r\n')
      if (end === -1) return
      const status = buffer.subarray(0, buffer.indexOf('\r\n')).toString()
      if (!status.startsWith('HTTP/1.1 101 ')) {
        clearTimeout(timer)
        socket.destroy()
        reject(new Error(`the viewer refused the WebSocket: ${status}`))
        return
      }
      const frame = buffer.subarray(end + 4)
      if (frame.length < 2) return
      const length = frame[1]! & 0x7f
      if (frame.length < 2 + length) return
      clearTimeout(timer)
      socket.destroy()
      resolve(frame.subarray(2, 2 + length).toString('latin1'))
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

/** Retries `attempt` until it returns a value or the time runs out, then throws its last error. */
async function eventually<T>(seconds: number, attempt: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + seconds * 1000
  for (;;) {
    try {
      return await attempt()
    } catch (error) {
      if (Date.now() > deadline) throw error
      await delay(1000)
    }
  }
}

/**
 * The checks, in order. Each gets the test's context and returns a short detail. Checks that need the
 * running desktop session say `session: true` and are skipped when it didn't start.
 */
export const CHECKS: Check[] = [
  {
    name: 'image',
    title: 'The image has what the runtime needs, and no proprietary apps',
    run: async (t) => (await t.exec('root', ['/opt/blobby/image/bin/check'])).stdout.trim(),
  },
  {
    name: 'session',
    title: 'runtime/boot.sh starts the GNOME session',
    run: async (t) => {
      const boot = await t.exec('root', ['bash', `${RUNTIME_DIR}/boot.sh`, t.resolution], { timeoutSeconds: 120 })
      if (!/^blobby-boot: started$/m.test(boot.stdout)) throw new Error(`boot.sh did not start the session: ${boot.stdout.trim()}`)
      const bootStarted = Date.now()
      const status = await eventually(READY_SECONDS, async () => {
        const result = await t.guest('status')
        if (!result.session || !result.ready) throw new Error(`the session isn't ready: ${JSON.stringify(result)}`)
        return result
      }).catch(async (error) => {
        const log = await t.exec('root', ['tail', '-n', '30', '/var/log/blobby-session.log']).catch(() => ({ stdout: '' }))
        throw new Error(`${message(error)}\nThe session's log ends with:\n${log.stdout.trim()}`)
      })
      t.timings.bootSeconds = seconds(Date.now() - bootStarted)
      t.timings.readySeconds = seconds(Date.now() - t.started)
      t.sessionReady = true
      return `GNOME Shell is up ${t.timings.bootSeconds} s after boot.sh, ${t.timings.readySeconds} s after docker run (${JSON.stringify(status)})`
    },
  },
  {
    name: 'screenshot',
    title: 'A screenshot through the guest runtime is a PNG of the whole, painted screen',
    session: true,
    run: async (t) => {
      const [width = 0, height = 0] = t.resolution.split('x').map(Number)
      // GNOME Shell takes its bus name a moment before it paints. A screen of one flat color compresses
      // to a few bytes per thousand pixels; the desktop's wallpaper, top bar, and dock to far more.
      const { png, size } = await eventually(30, async () => {
        const shot = await t.guest('screenshot')
        const data = Buffer.from(shot.png, 'base64')
        const found = pngSize(data)
        if (found.width !== width || found.height !== height) throw new Error(`the screenshot is ${found.width}x${found.height}, not ${t.resolution}`)
        if (data.length < (width * height) / 100) throw new Error(`the screen is one flat color (a ${data.length}-byte PNG)`)
        return { png: data, size: found }
      })
      await t.artifact('screenshot.png', png)
      return `${size.width}x${size.height} PNG, ${png.length} bytes`
    },
  },
  {
    name: 'accessibility',
    title: 'The accessibility tree lists GNOME Shell',
    session: true,
    run: async (t) =>
      eventually(30, async () => {
        const snapshot = await t.guest('ui.snapshot', { app: 'gnome-shell', max: 50 })
        const shell = (snapshot.nodes as Json[]).filter((node) => node.app === 'gnome-shell')
        if (!shell.length) throw new Error('the accessibility tree has no GNOME Shell elements')
        return `${shell.length} GNOME Shell elements, such as ${shell.slice(0, 3).map((node) => `${node.role} "${node.name}"`).join(', ')}`
      }),
  },
  {
    name: 'viewer',
    title: 'The viewer serves noVNC and bridges its WebSocket to the VNC server',
    session: true,
    run: async (t) => {
      const page = await eventually(15, async () => {
        const response = await httpGet(t.viewerPort, '/vnc.html')
        if (response.status !== 200 || !response.body.includes('noVNC')) throw new Error(`GET /vnc.html answered ${response.status}`)
        return response
      })
      const hello = await websocketHello(t.viewerPort)
      if (!hello.startsWith('RFB ')) throw new Error(`the VNC server's first message is ${JSON.stringify(hello)}, not an RFB version`)
      return `GET /vnc.html: ${page.status}; WebSocket: ${hello.trim()}`
    },
  },
  {
    name: 'command-sandbox',
    title: 'bubblewrap runs a command in new namespaces, as VS Code\'s check does',
    run: async (t) => {
      const result = await t.exec(DESKTOP_USER, ['bwrap', '--unshare-net', '--dev-bind', '/', '/', 'echo', 'ok'])
      if (result.code !== 0 || result.stdout.trim() !== 'ok') {
        const hint = t.apparmor
          ? ' This Docker host uses AppArmor. The command sandbox needs --apparmor-unconfined, and on Ubuntu 23.10 and later also kernel.apparmor_restrict_unprivileged_userns=0 (see README.md).'
          : ''
        throw new Error(`bwrap printed ${JSON.stringify(result.stdout.trim())} and ${JSON.stringify(result.stderr.trim())}, exit ${result.code}.${hint}`)
      }
      return 'bwrap --unshare-net --dev-bind / / echo ok printed ok'
    },
  },
  {
    name: 'recording',
    title: `A ${RECORD_SECONDS}-second recording through the guest runtime is a playable H.264 MP4`,
    session: true,
    run: async (t) => {
      const started = await t.guest('record.start', { maxSeconds: RECORD_SECONDS })
      await delay((RECORD_SECONDS + 1.5) * 1000)
      const stopped = await t.guest('record.stop', {}, 60)
      const chunks: Buffer[] = []
      for (let offset = 0, eof = false; !eof; ) {
        const part = await t.guest('media.read', { id: stopped.id, offset, length: 1 << 20 })
        const data = Buffer.from(part.data, 'base64')
        chunks.push(data)
        offset += data.length
        eof = part.eof || data.length === 0
      }
      const video = Buffer.concat(chunks)
      const sha256 = createHash('sha256').update(video).digest('hex')
      if (video.length !== stopped.size || sha256 !== stopped.sha256) throw new Error(`read ${video.length} bytes with SHA-256 ${sha256}, but the desktop reported ${stopped.size} and ${stopped.sha256}`)
      const boxes = mp4Boxes(video)
      if (!(stopped.seconds >= RECORD_SECONDS - 1)) throw new Error(`the recording lasts ${stopped.seconds} s, not about ${RECORD_SECONDS}`)
      const probe = await t.exec(DESKTOP_USER, ['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', `/var/tmp/blobby-media/${stopped.id}.mp4`])
      const stream = JSON.parse(probe.stdout).streams?.[0]
      if (stream?.codec_name !== 'h264') throw new Error(`ffprobe found ${JSON.stringify(stream)}, not an H.264 video`)
      await t.artifact('recording.mp4', video)
      await t.guest('media.delete', { id: stopped.id })
      return `${stopped.seconds} s, ${stream.width}x${stream.height} H.264, ${video.length} bytes (boxes ${boxes.join(' ')}), recording ${started.id}`
    },
  },
]

const seconds = (ms: number) => Math.round(ms / 100) / 10

/**
 * Runs the smoke test and returns its results. Never leaves a container behind unless `keep` is set.
 */
export async function smokeTest(options: SmokeOptions = {}): Promise<SmokeResult> {
  const { image = DEFAULT_IMAGE, runtime = DEFAULT_RUNTIME, resolution = '1280x800', onProgress = () => {} } = options
  if (!/^[1-9]\d{2,3}x[1-9]\d{2,3}$/.test(resolution)) throw new Error(`The resolution must look like 1280x800, not ${resolution}.`)
  const unknown = (options.only ?? []).filter((name) => !CHECKS.some((check) => check.name === name))
  if (unknown.length) throw new Error(`There is no check named ${unknown.join(', ')}. Checks: ${CHECKS.map((check) => check.name).join(', ')}.`)
  const only = options.only ?? []
  const wanted = only.length ? CHECKS.filter((check) => only.includes(check.name) || (check.name === 'session' && CHECKS.some((c) => c.session && only.includes(c.name)))) : CHECKS

  const inspect = await docker(['image', 'inspect', '--format', '{{.Id}} {{.Architecture}}', image])
  if (inspect.code !== 0) throw new Error(`There is no ${image} image. Build it with \`node images/desktop/build.ts\`.`)
  const [imageId, arch] = inspect.stdout.trim().split(' ')
  const security = (await docker(['info', '--format', '{{json .SecurityOptions}}'])).stdout
  const sessionEnv = parseEnv(await readFile(join(runtime, 'session.env'), 'utf8'))

  const scratch = await mkdtemp(join(tmpdir(), 'blobby-desktop-smoke-'))
  const container = `blobby-desktop-smoke-${randomBytes(4).toString('hex')}`
  const entrypoint = options.withoutEntrypoint ? 'none' : 'image'
  const result: SmokeResult = { ok: false, image, imageId, platform: `linux/${arch}`, container, resolution, entrypoint, timings: {}, checks: [] }
  const t: SmokeContext = {
    resolution,
    timings: result.timings,
    apparmor: security.includes('name=apparmor'),
    apparmorUnconfined: Boolean(options.apparmorUnconfined),
    sessionReady: false,
    viewerPort: 0,
    started: 0,
    async exec(user, command, { timeoutSeconds = 60, env = user === DESKTOP_USER ? sessionEnv : {} } = {}) {
      const envArgs = Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`])
      return docker(['exec', '--user', user, ...envArgs, container, ...command], { timeoutSeconds })
    },
    async guest(operation, input = {}, timeoutSeconds = 60) {
      const run = await this.exec(DESKTOP_USER, ['python3', `${RUNTIME_DIR}/guest.py`, operation, JSON.stringify(input)], { timeoutSeconds })
      let parsed: Json
      try {
        parsed = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '')
      } catch {
        throw new Error(`guest.py ${operation} failed: ${run.stderr.trim().split('\n').slice(-3).join(' ') || `exit ${run.code}`}`)
      }
      if (!parsed.ok) throw new Error(`guest.py ${operation}: ${parsed.code}: ${parsed.error}`)
      return parsed
    },
    async artifact(name, data) {
      if (!options.artifacts) return
      await mkdir(options.artifacts, { recursive: true })
      await writeFile(join(options.artifacts, name), data)
    },
  }

  try {
    const profile = join(scratch, 'seccomp.json')
    await writeFile(profile, commandSandboxProfile(await dockerDefaultProfile()), { mode: 0o600 })
    onProgress(`Starting ${container} from ${image}`)
    t.started = Date.now()
    await dockerOk([
      'run', '--detach', '--name', container, '--hostname', 'smoke', '--label', TEST_LABEL, '--pull', 'never',
      '--security-opt', `seccomp=${profile}`, '--device', TUN_DEVICE, '--security-opt', 'no-new-privileges',
      ...(options.apparmorUnconfined ? ['--security-opt', 'apparmor=unconfined'] : []),
      '--shm-size', '512m', '--publish', `127.0.0.1::${VIEWER_PORT}`,
      ...(options.withoutEntrypoint ? ['--entrypoint', 'sleep', image, 'infinity'] : [image]),
    ])
    result.timings.containerSeconds = seconds(Date.now() - t.started)
    const port = await dockerOk(['port', container, `${VIEWER_PORT}/tcp`])
    t.viewerPort = Number(/:(\d+)\s*$/m.exec(port.stdout)?.[1])
    await dockerOk(['cp', `${runtime.replace(/\/?$/, '/')}.`, `${container}:${RUNTIME_DIR}`])
    await dockerOk(['exec', '--user', 'root', container, 'chmod', '-R', 'a+rX', '/opt/blobby'])

    for (const check of wanted) {
      if (check.session && !t.sessionReady) {
        result.checks.push({ name: check.name, ok: false, skipped: true, error: 'the session did not start' })
        onProgress(`- ${check.name}: skipped, the session did not start`)
        continue
      }
      const begun = Date.now()
      try {
        const detail = await check.run(t)
        result.checks.push({ name: check.name, ok: true, seconds: seconds(Date.now() - begun), detail })
        onProgress(`✓ ${check.name}: ${detail}`)
      } catch (error) {
        result.checks.push({ name: check.name, ok: false, seconds: seconds(Date.now() - begun), error: message(error) })
        onProgress(`✗ ${check.name}: ${message(error)}`)
      }
    }
    result.ok = result.checks.every((check) => check.ok)
    return result
  } finally {
    if (options.keep) onProgress(`Kept ${container}; remove it with \`docker rm -f ${container}\``)
    else await docker(['rm', '--force', '--volumes', container]).catch(() => {})
    await rm(scratch, { recursive: true, force: true })
  }
}

const USAGE = `Usage: node images/desktop/smoke.ts [options]

Starts a container from the desktop image with plain Docker, starts the session with the guest runtime,
and checks it: ${CHECKS.map((check) => check.name).join(', ')}.

  --image <ref>           Default ${DEFAULT_IMAGE}.
  --resolution <WxH>      Default 1280x800.
  --only <names>          Run only these checks, comma-separated.
  --artifacts <dir>       Save the screenshot and the recording here.
  --without-entrypoint    Run \`sleep infinity\` instead of the image's entry point, as where a machine
                          boots the image and only runs commands in it.
  --apparmor-unconfined   Run without Docker's AppArmor profile, which denies the command sandbox's mounts
                          on Linux hosts with AppArmor. See README.md.
  --keep                  Leave the container running.
  --json                  Print JSON, for scripts and agents.
`

async function main(argv: string[]): Promise<number> {
  let values
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: {
        image: { type: 'string' },
        resolution: { type: 'string' },
        only: { type: 'string' },
        artifacts: { type: 'string' },
        'without-entrypoint': { type: 'boolean' },
        'apparmor-unconfined': { type: 'boolean' },
        keep: { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }))
  } catch (error) {
    process.stderr.write(`blobby-desktop-smoke: ${message(error)}\n\n${USAGE}`)
    return 2
  }
  if (values.help) return process.stdout.write(USAGE), 0
  try {
    const result = await smokeTest({
      image: values.image,
      resolution: values.resolution,
      only: values.only?.split(',').map((name) => name.trim()).filter(Boolean),
      artifacts: values.artifacts,
      withoutEntrypoint: values['without-entrypoint'],
      apparmorUnconfined: values['apparmor-unconfined'],
      keep: values.keep,
      onProgress: (line) => process.stderr.write(`${line}\n`),
    })
    const failed = result.checks.filter((check) => !check.ok)
    if (values.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    else if (failed.length) process.stdout.write(`Smoke test failed: ${failed.map((check) => check.name).join(', ')}\n`)
    else process.stdout.write(`Smoke test passed: ${result.checks.length} checks. The session was ready ${result.timings.readySeconds} s after docker run.\n`)
    return result.ok ? 0 : 1
  } catch (error) {
    process.stderr.write(values.json ? `${JSON.stringify({ error: { code: 'smoke_failed', message: message(error) } })}\n` : `blobby-desktop-smoke: ${message(error)}\n`)
    return 1
  }
}

if (process.argv[1] && (await realpath(process.argv[1]).catch(() => '')) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
