import { createHash, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'
import type { FakeBackend, FakeExec, FakeExecResult } from '../src/fake.ts'
import type { AccessibleNode } from '../src/sandboxes.ts'

interface GuestLib {
  openSealed(sealed: unknown, privateKey: KeyObject, recipient: string, bound: string): string
  binding(sandbox: string, step: string, requestId: string, name: string): string
}
/** The real guest library, so sealed answers are opened exactly as a desktop opens them. */
export const guestLib = (await import(new URL('../runtime/lib/blobby.mjs', import.meta.url).href)) as GuestLib

export interface FakeRequest {
  id: string
  name: string
  sensitive: boolean
  publicKey?: string
  privateKey?: KeyObject
}

export interface FakeStep {
  id: string
  sandbox: string
  /** The recipe step file, or null for a command started with `argv` (`exec --secret`). */
  run: string | null
  argv: string[] | null
  /** The secret a command started with `argv` may ask for. */
  secret: string | null
  callbacks: Record<string, { sensitive: boolean }>
  progress: string[]
  requests: FakeRequest[]
  /** Opened answers by callback name: the value, or the error the client sent. */
  values: Map<string, { value: string } | { error: string }>
  /** Answers as they crossed the wire. */
  raw: unknown[]
  exit: number | null
  result: Record<string, unknown> | null
  error: string | null
  stopped: boolean
  /** What the step printed, as `step.poll` streams it. */
  output: string
}

export interface GuestState {
  ready?: boolean
  failSetup?: boolean
  /** Whether the session runs, so boot.sh says `running`. */
  session?: boolean
  info?: Record<string, string>
  recording?: string | null
  recordingBytes?: Buffer
  media: Map<string, Buffer>
  a11y?: unknown
  steps: Map<string, FakeStep>
  /** Every guest.py operation, in order. */
  operations: { op: string; options: Record<string, unknown> }[]
  /**
   * What a step does at each poll. By default a recipe step asks for each callback it uses, in order, then
   * reports `{ github: login }`, and a command (`exec --secret`) is `runCommand`.
   */
  script?: (step: FakeStep) => void
  /** Called on every guest.py operation before it runs. */
  onOperation?: (op: string, options: Record<string, unknown>) => void
}

export function guestState(state: Partial<GuestState> = {}): GuestState {
  return { media: new Map(), steps: new Map(), operations: [], ...state }
}

const pngs = new Map<string, Buffer>()

/** A real PNG: a gray gradient, 8-bit grayscale, with valid chunk CRCs and image data. */
export function fakePng(width: number, height: number): Buffer {
  const cached = pngs.get(`${width}x${height}`)
  if (cached) return cached
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  const rows = Buffer.alloc(height * (width + 1))
  for (let y = 0; y < height; y++) rows.fill(Math.floor((y * 255) / Math.max(1, height - 1)), y * (width + 1) + 1, (y + 1) * (width + 1))
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
  pngs.set(`${width}x${height}`, png)
  return png
}

/** Asks for each of `names` in turn, one per poll, as the guest library's `request` does. True once all are answered. */
export function askFor(step: FakeStep, names: readonly string[]): boolean {
  for (const name of names) {
    if (step.requests.some((request) => request.name === name)) {
      if (!step.values.has(name)) return false
      continue
    }
    const sensitive = Boolean(step.callbacks[name]?.sensitive)
    const request: FakeRequest = { id: randomBytes(8).toString('hex'), name, sensitive }
    if (sensitive) {
      const keys = generateKeyPairSync('x25519')
      request.privateKey = keys.privateKey
      request.publicKey = keys.publicKey.export({ format: 'jwk' }).x
    }
    step.requests.push(request)
    step.progress.push(`Asking for ${name}`)
    return false
  }
  return true
}

/**
 * A command run with `exec --secret`, like `vscode-signin`: it prints what it does (its login too, which
 * the engine must redact), asks for the secret's login, password, and 2FA code, then reports the account.
 */
export function runCommand(step: FakeStep): void {
  if (!step.output) step.output = `running ${step.argv!.join(' ')}\n`
  const secret = step.secret
  if (!askFor(step, secret ? ['login', 'password', 'otp'].map((field) => `${secret}.${field}`) : [])) return
  const failed = [...step.values.values()].find((value) => 'error' in value)
  if (failed && 'error' in failed) {
    step.output += `error: ${failed.error}\n`
    step.exit = 1
    return
  }
  const login = secret ? step.values.get(`${secret}.login`) : undefined
  const name = login && 'value' in login ? login.value : null
  step.output += name ? `signed in as ${name}\n` : 'done\n'
  step.exit = 0
  step.result = secret && name ? { [secret]: name } : {}
}

/** Asks for each callback in turn, then finishes with the github login it got, or fails with an error it got. */
export function askInTurn(step: FakeStep): void {
  if (!askFor(step, Object.keys(step.callbacks))) return
  const failed = [...step.values.values()].find((value) => 'error' in value)
  if (failed && 'error' in failed) {
    step.exit = 1
    step.error = failed.error
    return
  }
  const login = step.values.get('github.login')
  step.exit = 0
  step.result = login && 'value' in login ? { github: login.value } : {}
}

const ok = (result: object = {}) => ({ exitCode: 0, stdout: `${JSON.stringify({ ok: true, ...result })}\n` })
const fail = (code: string, error: string) => ({ exitCode: 1, stdout: `${JSON.stringify({ ok: false, code, error })}\n` })

/** Answers commands the way a sandbox's desktop runtime does. */
export function fakeGuest(backend: FakeBackend, state: GuestState): FakeExec {
  const files = (name: string) => backend.machines.get(name)!.files
  const mediaPath = (id: string) => `/var/tmp/blobby-media/${id}.mp4`
  const operation = (name: string, op: string, options: Record<string, unknown>) => {
    state.operations.push({ op, options })
    state.onOperation?.(op, options)
    switch (op) {
      case 'status':
        return ok({ session: state.session ?? false, ready: state.session ?? false, recording: state.recording ?? null })
      case 'screenshot':
        return ok({ png: fakePng(1280, 800).toString('base64'), width: 1280, height: 800 })
      case 'input':
      case 'resize':
        return ok(op === 'resize' ? options : {})
      case 'ui.snapshot':
        return ok((state.a11y as object) ?? { nodes: [], truncated: false })
      case 'ui.act':
        return ok({ path: options.path, name: 'Accounts', did: options.do ?? 'press' })
      case 'ui.wait': {
        // The tree as it is now, filtered as the desktop's helper filters it; it never changes while waiting.
        const match = String(options.match).toLowerCase()
        const all = ((state.a11y as { nodes?: AccessibleNode[] } | undefined)?.nodes ?? []) as AccessibleNode[]
        const nodes = all.filter(
          (node) =>
            `${node.name} ${node.text ?? ''}`.toLowerCase().includes(match) &&
            (!options.role || node.role.toLowerCase() === String(options.role).toLowerCase()) &&
            (!options.state || (node.states ?? []).includes(String(options.state))) &&
            (!options.app || node.app.toLowerCase().includes(String(options.app).toLowerCase())),
        )
        if (options.gone ? nodes.length : !nodes.length) return fail('wait_timeout', `Waited ${options.timeoutSeconds} seconds.`)
        return ok({ found: !options.gone, nodes: options.gone ? [] : nodes, waitedMs: 250 })
      }
      case 'record.start': {
        if (state.recording) return fail('already_recording', 'The desktop is already recording.')
        state.recording = randomBytes(16).toString('hex')
        return ok({ id: state.recording, maxSeconds: options.maxSeconds })
      }
      case 'record.stop': {
        if (!state.recording) return fail('not_recording', 'The desktop is not recording.')
        const data = state.recordingBytes ?? Buffer.from('mp4 bytes')
        const id = state.recording
        state.media.set(id, data)
        files(name).set(mediaPath(id), { data, mode: 0o600, user: 'ubuntu' })
        state.recording = null
        return ok({ id, size: data.length, sha256: createHash('sha256').update(data).digest('hex'), seconds: 3.5 })
      }
      case 'media.read': {
        const data = state.media.get(String(options.id))
        if (!data) return fail('not_found', 'There is no such recording in the desktop.')
        const offset = Number(options.offset)
        const chunk = data.subarray(offset, offset + Number(options.length))
        return ok({ data: chunk.toString('base64'), eof: offset + chunk.length >= data.length })
      }
      case 'media.delete':
        state.media.delete(String(options.id))
        files(name).delete(mediaPath(String(options.id)))
        return ok()
      case 'step.start': {
        const step: FakeStep = {
          id: String(options.id),
          sandbox: String(options.sandbox),
          run: typeof options.run === 'string' ? options.run : null,
          argv: Array.isArray(options.argv) ? (options.argv as string[]) : null,
          secret: typeof options.secret === 'string' ? options.secret : null,
          callbacks: options.callbacks as FakeStep['callbacks'],
          progress: [],
          requests: [],
          values: new Map(),
          raw: [],
          exit: null,
          result: null,
          error: null,
          stopped: false,
          output: '',
        }
        state.steps.set(step.id, step)
        return ok()
      }
      case 'step.poll': {
        const step = state.steps.get(String(options.id))
        if (!step) return fail('not_found', 'There is no such step in the desktop.')
        if (step.exit === null) (state.script ?? (step.argv ? runCommand : askInTurn))(step)
        const offset = Number(options.offset)
        const pending = step.requests.filter((request) => !step.values.has(request.name)).map((request) => ({ id: request.id, name: request.name, sensitive: request.sensitive, publicKey: request.publicKey }))
        const outputOffset = Number(options.outputOffset ?? 0)
        return ok({
          progress: step.progress.slice(offset),
          offset: step.progress.length,
          requests: pending,
          exit: step.exit,
          result: step.exit === null ? null : step.result,
          error: step.error,
          output: step.output.slice(outputOffset),
          outputOffset: step.output.length,
          outputDone: step.exit !== null,
        })
      }
      case 'step.answer': {
        const step = state.steps.get(String(options.id))!
        const request = step.requests.find((candidate) => candidate.id === options.request)!
        const answer = options.answer as { value?: string; sealed?: unknown; error?: string }
        step.raw.push(answer)
        if (answer.error !== undefined) step.values.set(request.name, { error: answer.error })
        else if (answer.sealed !== undefined) {
          const bound = guestLib.binding(step.sandbox, step.id, request.id, request.name)
          step.values.set(request.name, { value: guestLib.openSealed(answer.sealed, request.privateKey!, request.publicKey!, bound) })
        } else step.values.set(request.name, { value: answer.value! })
        return ok()
      }
      case 'step.stop': {
        const step = state.steps.get(String(options.id))
        if (step) step.stopped = true
        return ok()
      }
      default:
        return fail('usage', `Unknown operation ${op}`)
    }
  }

  const handle = (name: string, command: readonly string[]): FakeExecResult => {
    if (command[0] === 'python3' && command[1] === '/opt/blobby/runtime/guest.py') {
      if (command[2] === 'exec' && command[3] === '--') return handle(name, command.slice(4))
      return operation(name, command[2]!, JSON.parse(command[3] ?? '{}') as Record<string, unknown>)
    }
    const line = command.join(' ')
    if (line === 'true') return { exitCode: 0 }
    if (line === 'test -e /etc/blobby/ready') return { exitCode: state.ready ? 0 : 1 }
    if (command[0] === 'test' && command[1] === '-e' && command.length === 3) return { exitCode: files(name).has(command[2]!) ? 0 : 1 }
    if (line === 'bash /opt/blobby/runtime/setup.sh') {
      if (state.failSetup) return { exitCode: 100, stdout: 'blobby-setup: Installing GNOME\n', stderr: 'E: Unable to fetch some archives\n' }
      return { exitCode: 0, stdout: 'blobby-setup: Installing GNOME\nblobby-setup: Installed the desktop\n' }
    }
    if (line === 'bash /opt/blobby/recipe/setup.sh') return { exitCode: 0, stdout: 'blobby-setup: Installing VS Code Insiders\n' }
    const stamped = /^bash -c date -u \+%FT%TZ > (\S+)$/.exec(line)?.[1]
    if (stamped) {
      if (stamped === '/etc/blobby/ready') state.ready = true
      files(name).set(stamped, { data: Buffer.from('2026-01-01T00:00:00Z\n') })
      return { exitCode: 0 }
    }
    if (command[0] === 'bash' && command[1] === '/opt/blobby/runtime/boot.sh') {
      if (state.session) return { exitCode: 0, stdout: 'blobby-boot: running\n' }
      state.session = true
      const info = Object.entries(state.info ?? {}).map(([key, value]) => `blobby-info: ${key} ${value}\n`).join('')
      return { exitCode: 0, stdout: `${info}blobby-boot: started\n`, stderr: 'blobby-boot: could not check for an update\n' }
    }
    if (line === 'cat /etc/blobby/vnc-password') return { exitCode: 0, stdout: 'Ab12+Cd3' }
    if (command[0] === 'cat' && command.length === 2) {
      const file = files(name).get(command[1]!)
      return file ? { exitCode: 0, stdout: file.data.toString('utf8') } : { exitCode: 1, stderr: 'No such file' }
    }
    if (command[0] === 'find' && command[2] === '-type') {
      const prefix = `${command[1]}/`
      return { exitCode: 0, stdout: [...files(name).keys()].filter((path) => path.startsWith(prefix)).map((path) => `${path}\n`).join('') }
    }
    if (command[0] === 'rm' && command[1] === '-rf') {
      for (const path of files(name).keys()) if (path === command[2] || path.startsWith(`${command[2]}/`)) files(name).delete(path)
      return { exitCode: 0 }
    }
    return { exitCode: 0 }
  }
  return handle
}
