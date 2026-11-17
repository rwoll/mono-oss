import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { SUMMARY_VERSION, summarizeSession, type SessionSummary } from './scan.ts'
import { TASK_TYPES, type TaskType, type TypeSource } from './shared.ts'

// The canvas's own files, in its private data folder: a summary of every session it has
// read, so a session's log is read again only when it changed, and the task types you or
// the agent chose.

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/
const MAX_OVERRIDES = 5000
/** Save what has been read this often, so a long first read that is cut short is not lost. */
const SAVE_EVERY = 100

export async function writeAtomic(file: string, text: string) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(temp, text, { mode: 0o600 })
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

interface Cached {
  /** The log's size and modification time when it was read. */
  size: number
  mtimeMs: number
  /** Null for a session with no model calls. */
  summary: SessionSummary | null
}

export interface ScanProgress {
  done: number
  total: number
}

/** Every session's summary, read from the session logs under `root` and cached in `dataDir`. */
export class Sessions {
  readonly #root: () => string
  readonly #file: () => string
  #cache = new Map<string, Cached>()
  #loaded: Promise<void> | undefined
  #running: Promise<void> = Promise.resolve()

  constructor(root: () => string, dataDir: () => string) {
    this.#root = root
    this.#file = () => join(dataDir(), `sessions-v${SUMMARY_VERSION}.json`)
  }

  get root() {
    return this.#root()
  }

  /** The summaries read so far, from this run or an earlier one. */
  async all(): Promise<SessionSummary[]> {
    await (this.#loaded ??= this.#load())
    return [...this.#cache.values()].flatMap((entry) => (entry.summary ? [entry.summary] : []))
  }

  async #load() {
    const saved = (await readJson(this.#file())) as { version?: number; sessions?: Record<string, Cached> } | undefined
    if (saved?.version !== SUMMARY_VERSION || typeof saved.sessions !== 'object' || saved.sessions === null) return
    for (const [id, entry] of Object.entries(saved.sessions)) {
      if (SESSION_ID.test(id) && typeof entry?.size === 'number' && typeof entry.mtimeMs === 'number') this.#cache.set(id, entry)
    }
  }

  /**
   * Read the sessions whose logs changed since `since`, skipping those already read.
   * Scans run one after another, so two chats never read the same log at once.
   */
  scan(since: number, onProgress: (progress: ScanProgress) => void): Promise<void> {
    const run = this.#running.then(() => this.#scan(since, onProgress))
    this.#running = run.catch(() => undefined)
    return run
  }

  async #scan(since: number, onProgress: (progress: ScanProgress) => void) {
    await (this.#loaded ??= this.#load())
    const root = this.#root()
    let names: string[]
    try {
      names = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && SESSION_ID.test(entry.name)).map((entry) => entry.name)
    } catch {
      names = []
    }
    const stale: { id: string; size: number; mtimeMs: number }[] = []
    for (const id of names) {
      let info
      try {
        info = await stat(join(root, id, 'events.jsonl'))
      } catch {
        continue
      }
      if (info.mtimeMs < since) continue
      const cached = this.#cache.get(id)
      if (cached?.size !== info.size || cached.mtimeMs !== info.mtimeMs) stale.push({ id, size: info.size, mtimeMs: info.mtimeMs })
    }
    // A session whose folder is gone no longer counts.
    const present = new Set(names)
    let changed = false
    for (const id of this.#cache.keys()) {
      if (!present.has(id)) changed = this.#cache.delete(id) || changed
    }
    onProgress({ done: 0, total: stale.length })
    for (const [index, entry] of stale.entries()) {
      let summary: SessionSummary | null = null
      try {
        summary = await summarizeSession(join(root, entry.id), entry.id)
      } catch {
        // Unreadable now; its size and time are kept, so it is tried again when it changes.
      }
      this.#cache.set(entry.id, { size: entry.size, mtimeMs: entry.mtimeMs, summary })
      changed = true
      onProgress({ done: index + 1, total: stale.length })
      if ((index + 1) % SAVE_EVERY === 0) await this.#save()
    }
    if (changed) await this.#save()
  }

  #save() {
    return writeAtomic(this.#file(), JSON.stringify({ version: SUMMARY_VERSION, sessions: Object.fromEntries(this.#cache) }))
  }
}

export interface TypeChoice {
  type: TaskType
  by: Exclude<TypeSource, 'auto'>
}

/** The task types chosen for sessions, which replace the ones the canvas works out. */
export class TaskTypes {
  readonly #file: () => string
  #choices: Map<string, TypeChoice> | undefined

  constructor(dataDir: () => string) {
    this.#file = () => join(dataDir(), 'task-types.json')
  }

  async read(): Promise<ReadonlyMap<string, TypeChoice>> {
    if (this.#choices) return this.#choices
    const choices = new Map<string, TypeChoice>()
    const saved = (await readJson(this.#file())) as { types?: Record<string, TypeChoice> } | undefined
    for (const [id, choice] of Object.entries(saved?.types ?? {})) {
      if (SESSION_ID.test(id) && TASK_TYPES.includes(choice?.type) && (choice.by === 'you' || choice.by === 'agent')) choices.set(id, { type: choice.type, by: choice.by })
    }
    return (this.#choices = choices)
  }

  /** Set or, with a null type, clear the choice for each session. What you chose is kept over what the agent suggests. */
  async set(changes: readonly { id: string; type: TaskType | null }[], by: TypeChoice['by']): Promise<number> {
    const choices = new Map(await this.read())
    let applied = 0
    for (const { id, type } of changes) {
      const current = choices.get(id)
      if (by === 'agent' && current?.by === 'you') continue
      if (type === null) {
        if (!choices.delete(id)) continue
      } else {
        if (current?.type === type && current.by === by) continue
        choices.set(id, { type, by })
      }
      applied += 1
    }
    if (!applied) return 0
    // The oldest choices go first when there are too many to keep.
    const kept = new Map([...choices].slice(-MAX_OVERRIDES))
    await writeAtomic(this.#file(), JSON.stringify({ types: Object.fromEntries(kept) }, null, 2))
    this.#choices = kept
    return applied
  }
}
