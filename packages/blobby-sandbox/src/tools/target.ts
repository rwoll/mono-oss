import type { ExecResult } from '../backend.ts'
import type { SandboxClient } from '../client.ts'
import type { AccessibleNode, InputAction, RecordingInfo, SandboxInfo, Sandboxes, Screenshot, UiAct, UiQuery } from '../sandboxes.ts'
import { SandboxError } from '../backend.ts'

/** What `desktop_info` reports about a sandbox. */
export interface DesktopInfo {
  name: string
  state: string
  /** ISO 8601 time, or null when the backend doesn't say. */
  createdAt: string | null
}

export interface DesktopExecOptions {
  /** Run as root instead of the desktop user. Tools pass it only when their factory allows root. */
  root?: boolean
  timeoutSeconds?: number
  stdin?: string
}

/**
 * One sandbox's desktop, as tool handlers drive it. The engine (`engineTarget`) and a client, in-process
 * or remote (`clientTarget`), both provide one, and a hosted broker can bind it to its own procedures.
 * Methods throw `SandboxError`.
 */
export interface DesktopTarget {
  info(): Promise<DesktopInfo>
  screenshot(): Promise<Screenshot>
  input(action: InputAction): Promise<void>
  ui(query: UiQuery): Promise<{ nodes: AccessibleNode[]; truncated: boolean }>
  act(act: UiAct): Promise<{ path: string; name: string; did: string }>
  exec(command: string[], options?: DesktopExecOptions): Promise<ExecResult>
  recordStart(options?: { maxSeconds?: number }): Promise<{ id: string; maxSeconds: number }>
  /** Stops the recording and leaves it in the sandbox; read it with `mediaRead`. */
  recordStop(): Promise<RecordingInfo>
  /** Up to `length` bytes of a recording from `offset`. */
  mediaRead(id: string, offset: number, length: number): Promise<{ data: Uint8Array; eof: boolean }>
}

function infoOf(list: SandboxInfo[], name: string): DesktopInfo {
  const sandbox = list.find((candidate) => candidate.name === name)
  if (!sandbox) throw new SandboxError('not_found', `There is no sandbox named ${name}.`)
  return { name: sandbox.name, state: sandbox.state, createdAt: sandbox.createdAt }
}

type EngineLike = Pick<Sandboxes, 'list' | 'screenshot' | 'input' | 'ui' | 'act' | 'exec' | 'recordStart' | 'recordStop' | 'mediaRead'>

/** One sandbox of an engine in this process, such as a hosted controller's. */
export function engineTarget(engine: EngineLike, name: string): DesktopTarget {
  return {
    info: async () => infoOf(await engine.list(), name),
    screenshot: () => engine.screenshot(name),
    input: (action) => engine.input(name, action),
    ui: (query) => engine.ui(name, query),
    act: (act) => engine.act(name, act),
    exec: (command, options = {}) => engine.exec(name, command, { user: options.root ? 'root' : undefined, timeoutSeconds: options.timeoutSeconds, stdin: options.stdin }),
    recordStart: (options = {}) => engine.recordStart(name, options),
    recordStop: () => engine.recordStop(name),
    mediaRead: (id, offset, length) => engine.mediaRead(name, id, offset, length),
  }
}

type ClientLike = Pick<SandboxClient, 'list' | 'screenshot' | 'input' | 'ui' | 'act' | 'exec' | 'recordStart' | 'recordStop' | 'mediaRead'>

/** One sandbox through a client: `connect()` in this process, or `connect({ server, token })`. */
export function clientTarget(client: ClientLike, name: string): DesktopTarget {
  return {
    info: async () => infoOf(await client.list(), name),
    screenshot: () => client.screenshot(name),
    input: (action) => client.input(name, action),
    ui: (query) => client.ui(name, query),
    act: (act) => client.act(name, act),
    exec: (command, options = {}) => client.exec(name, command, { user: options.root ? 'root' : undefined, timeoutSeconds: options.timeoutSeconds, stdin: options.stdin }),
    recordStart: (options = {}) => client.recordStart(name, options),
    recordStop: async () => {
      const video = await client.recordStop(name)
      return { id: video.id, size: video.size, sha256: video.sha256, seconds: video.seconds }
    },
    mediaRead: (id, offset, length) => client.mediaRead(name, id, offset, length),
  }
}

/** Streams a recording in chunks, for storage that takes a stream. Nothing holds the whole file. */
export async function* readMedia(target: Pick<DesktopTarget, 'mediaRead'>, id: string, options: { chunkBytes?: number; offset?: number } = {}): AsyncGenerator<Uint8Array> {
  let offset = options.offset ?? 0
  for (;;) {
    const chunk = await target.mediaRead(id, offset, options.chunkBytes ?? 1024 * 1024)
    if (chunk.data.length) yield chunk.data
    offset += chunk.data.length
    if (chunk.eof || !chunk.data.length) return
  }
}
