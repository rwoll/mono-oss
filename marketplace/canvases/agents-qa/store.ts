import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { CanvasKitError } from '@rwoll/canvas-kit'
import { emptyTriage, firstIssue, outcomeSchema, RUN_ID, runSchema, triageSchema, type OutcomeFile, type Run, type Triage } from './format.ts'

const MAX_RUN_BYTES = 4 * 1024 * 1024
const MAX_TRIAGE_BYTES = 4 * 1024 * 1024
const MAX_OUTCOME_BYTES = 64 * 1024
const MAX_RUNS = 60
const MAX_OUTCOMES = 100
const LOCK_WAIT_MS = 3000
const LOCK_STALE_MS = 15_000

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

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

export interface RunRead {
  id: string
  dir: string
  run: Run | null
  /** Why the run file could not be used. */
  problem?: string
}

/** Runs in `<root>/runs/<id>/findings.json`, newest first, re-read only when a file changes. */
export class RunReader {
  readonly #cache = new Map<string, { stamp: string; read: RunRead }>()

  async read(root: string): Promise<RunRead[]> {
    const dir = join(root, 'runs')
    let names: string[]
    try {
      names = (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory() && RUN_ID.test(entry.name)).map((entry) => entry.name)
    } catch {
      return []
    }
    names.sort().reverse()
    const reads = (await Promise.all(names.slice(0, MAX_RUNS).map((id) => this.#one(join(dir, id), id)))).filter((read): read is RunRead => read !== null)
    const at = (read: RunRead) => (read.run ? Date.parse(read.run.startedAt) : 0)
    return reads.sort((a, b) => at(b) - at(a) || b.id.localeCompare(a.id))
  }

  async #one(dir: string, id: string): Promise<RunRead | null> {
    const file = join(dir, 'findings.json')
    let stamp: string
    let size: number
    try {
      const info = await stat(file)
      stamp = `${info.mtimeMs}:${info.size}`
      size = info.size
    } catch {
      // A run folder gets its findings.json once the run starts writing.
      return null
    }
    const cached = this.#cache.get(file)
    if (cached?.stamp === stamp) return cached.read
    let read: RunRead
    if (size > MAX_RUN_BYTES) read = { id, dir, run: null, problem: 'findings.json is larger than 4 MB.' }
    else {
      try {
        const parsed = runSchema.safeParse(JSON.parse(await readFile(file, 'utf8')))
        if (!parsed.success) read = { id, dir, run: null, problem: `findings.json: ${firstIssue(parsed.error)}` }
        else if (parsed.data.id !== id) read = { id, dir, run: null, problem: `findings.json says id "${parsed.data.id}", but its folder is "${id}".` }
        else read = { id, dir, run: parsed.data }
      } catch (error) {
        read = { id, dir, run: null, problem: `findings.json is not valid JSON: ${errorText(error)}` }
      }
    }
    this.#cache.set(file, { stamp, read })
    return read
  }
}

/**
 * `triage.json`: your decisions. Several chats can have the canvas open, each in its own process, so every
 * change takes a lock folder next to the file, reads the latest version, and writes it back atomically.
 */
export class TriageFile {
  readonly #file: () => string
  readonly #now: () => number
  #queue: Promise<unknown> = Promise.resolve()

  constructor(file: () => string, now: () => number = Date.now) {
    this.#file = file
    this.#now = now
  }

  get path(): string {
    return this.#file()
  }

  /** The decisions, or empty ones with the reason when the file cannot be used. */
  async read(): Promise<{ triage: Triage; problem?: string }> {
    const file = this.#file()
    let raw: string
    try {
      const info = await stat(file)
      if (info.size > MAX_TRIAGE_BYTES) return { triage: emptyTriage(), problem: `${file} is larger than 4 MB.` }
      raw = await readFile(file, 'utf8')
    } catch {
      return { triage: emptyTriage() }
    }
    try {
      const parsed = triageSchema.safeParse(JSON.parse(raw))
      return parsed.success ? { triage: parsed.data } : { triage: emptyTriage(), problem: `${file}: ${firstIssue(parsed.error)}` }
    } catch (error) {
      return { triage: emptyTriage(), problem: `${file} is not valid JSON: ${errorText(error)}` }
    }
  }

  /** Change the decisions under the lock. Returning the same object skips the write. */
  update(change: (triage: Triage) => Triage): Promise<Triage> {
    const run = this.#queue.then(() =>
      this.#locked(async () => {
        const { triage, problem } = await this.read()
        if (problem) {
          throw new CanvasKitError('triage_unreadable', `Your decisions could not be read (${problem}). Fix or move the file, then try again.`, 409)
        }
        const next = change(triage)
        if (next === triage) return triage
        const valid = triageSchema.parse(next)
        await writeAtomic(this.#file(), `${JSON.stringify(valid, null, 2)}\n`)
        return valid
      }),
    )
    this.#queue = run.catch(() => undefined)
    return run
  }

  async #locked<T>(work: () => Promise<T>): Promise<T> {
    const lock = `${this.#file()}.lock`
    await mkdir(dirname(lock), { recursive: true, mode: 0o700 })
    const started = this.#now()
    for (;;) {
      try {
        await mkdir(lock)
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const info = await stat(lock).catch(() => null)
        // A process that died holding the lock leaves it behind.
        if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) await rm(lock, { recursive: true, force: true })
        else if (this.#now() - started > LOCK_WAIT_MS) {
          throw new CanvasKitError('busy', 'Another chat is saving your decisions. Try again in a moment.', 409)
        } else await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    try {
      return await work()
    } finally {
      await rm(lock, { recursive: true, force: true })
    }
  }
}

export interface ReadOutcome {
  file: string
  outcome: OutcomeFile
}

/** Results that fix and investigation sessions left in `<root>/outcomes/`; unusable files move to `invalid/`. */
export async function readOutcomes(root: string): Promise<{ outcomes: ReadOutcome[]; problems: string[] }> {
  const dir = join(root, 'outcomes')
  let names: string[]
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name)
  } catch {
    return { outcomes: [], problems: [] }
  }
  const outcomes: ReadOutcome[] = []
  const problems: string[] = []
  for (const name of names.sort().slice(0, MAX_OUTCOMES)) {
    const file = join(dir, name)
    let problem: string | undefined
    try {
      const info = await stat(file)
      if (info.size > MAX_OUTCOME_BYTES) problem = 'larger than 64 KB'
      else {
        const parsed = outcomeSchema.safeParse(JSON.parse(await readFile(file, 'utf8')))
        if (parsed.success) outcomes.push({ file, outcome: parsed.data })
        else problem = firstIssue(parsed.error)
      }
    } catch (error) {
      problem = errorText(error)
    }
    if (problem) {
      problems.push(`outcomes/${name} was not used: ${problem}. It was moved to outcomes/invalid/.`)
      await moveInto(file, join(dir, 'invalid'))
    }
  }
  return { outcomes, problems }
}

/** Move a file into a folder; another chat may have moved it already. */
export async function moveInto(file: string, folder: string) {
  try {
    await mkdir(folder, { recursive: true, mode: 0o700 })
    await rename(file, join(folder, basename(file)))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
