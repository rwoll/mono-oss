import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SandboxError, type Backend, type Machine, type Snapshot } from './backend.ts'
import { hostId, MANAGER_LABEL } from './labels.ts'
import { stateDir } from './paths.ts'
import { BASE_LABEL, BASE_PREFIX, MACHINE_PREFIX, NAME_PATTERN, RECIPE_LABEL } from './sandboxes.ts'

// The standalone reaper. A standalone host has no controller watching its sandboxes, so it cleans up
// after itself with `rm --expired`, `gc`, and `doctor --reap`. It acts only on machines and snapshots
// labelled `blobby.dev/manager=standalone:<this host's ID>`: never on another manager's, and never on
// unlabelled ones, even when the backend shows them.

/** The label the engine puts on every machine it creates during one start, with that start's ID. */
export const START_LABEL = 'blobby.dev/start'
const START_ID = /^[a-f0-9]{32}$/
/** How far a machine's creation time may be before its start's, for clocks that disagree a little. */
const CLOCK_SKEW_MS = 60_000

/**
 * A start in progress. It is written before the engine creates anything and removed when the start
 * returns, so a record whose process is gone is a start that died before its sandbox was ready.
 */
export interface StartRecord {
  /** 32 hex characters. The engine labels what it creates with it (`blobby.dev/start`). */
  id: string
  /** The sandbox's name. */
  name: string
  /** The process running the start. */
  pid: number
  /** ISO 8601. */
  startedAt: string
  /** The backend it runs on, such as `docker`. */
  backend: string
  /** Whether the sandbox existed when the start began. A start that dies takes only what it created with it. */
  existed: boolean
}

/** Where start records are kept: `$XDG_STATE_HOME/blobby/starts`. */
export function startsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), 'starts')
}

/** Whether a process is running. A process this user can't signal is running too. */
export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Writes a file whole or not at all: a reader never sees half of it, even when this process dies mid-write. */
async function writeAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/** A start that is recorded until `done` is called. */
export interface RecordedStart {
  record: StartRecord
  /** Removes the record. Call it when the start returns, whether it worked or failed. */
  done(): Promise<void>
}

/** Records a start before anything is created for it, so `doctor --reap` can clean up if its process dies. */
export async function recordStart(
  start: { name: string; backend: string; existed: boolean },
  options: { env?: NodeJS.ProcessEnv; now?: () => number; pid?: number } = {},
): Promise<RecordedStart> {
  const dir = startsDir(options.env)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const record: StartRecord = {
    id: randomBytes(16).toString('hex'),
    name: start.name,
    pid: options.pid ?? process.pid,
    startedAt: new Date((options.now ?? Date.now)()).toISOString(),
    backend: start.backend,
    existed: start.existed,
  }
  const file = join(dir, `${record.id}.json`)
  await writeAtomic(file, `${JSON.stringify(record, null, 2)}\n`)
  let removed = false
  return {
    record,
    done: async () => {
      if (removed) return
      removed = true
      await rm(file, { force: true })
    },
  }
}

function parseRecord(text: string): StartRecord | null {
  try {
    const value = JSON.parse(text) as Partial<StartRecord>
    if (
      typeof value.id === 'string' &&
      START_ID.test(value.id) &&
      typeof value.name === 'string' &&
      NAME_PATTERN.test(value.name) &&
      Number.isSafeInteger(value.pid) &&
      typeof value.startedAt === 'string' &&
      !Number.isNaN(Date.parse(value.startedAt)) &&
      typeof value.backend === 'string' &&
      typeof value.existed === 'boolean'
    ) {
      return { id: value.id, name: value.name, pid: value.pid!, startedAt: value.startedAt, backend: value.backend, existed: value.existed }
    }
  } catch {
    // Reported as unreadable below.
  }
  return null
}

/** The recorded starts, and the files in the folder that are not readable records. */
export async function readStarts(env: NodeJS.ProcessEnv = process.env): Promise<{ starts: StartRecord[]; unreadable: string[]; leftovers: string[] }> {
  const dir = startsDir(env)
  const entries = await readdir(dir).catch(() => [] as string[])
  const starts: StartRecord[] = []
  const unreadable: string[] = []
  const leftovers: string[] = []
  for (const entry of entries.sort()) {
    // A temporary file whose writer died: the record it was writing never existed.
    const temporary = /^[a-f0-9]{32}\.json\.(\d+)\.[a-f0-9]{8}\.tmp$/.exec(entry)
    if (temporary) {
      if (!processAlive(Number(temporary[1]))) leftovers.push(join(dir, entry))
      continue
    }
    if (!/^[a-f0-9]{32}\.json$/.test(entry)) continue
    const record = parseRecord(await readFile(join(dir, entry), 'utf8').catch(() => ''))
    if (record && `${record.id}.json` === entry) starts.push(record)
    else unreadable.push(join(dir, entry))
  }
  return { starts, unreadable, leftovers }
}

/** What the reaper does to one thing, or would do in a dry run. */
export interface ReapAction {
  kind: 'machine' | 'snapshot' | 'start'
  /** The backend's machine name, the snapshot's ID, or the start record's ID. */
  id: string
  /** The sandbox it belongs to, or null for a base or a snapshot. */
  sandbox: string | null
  /**
   * `expired`: past its `blobby.dev/delete-after`. `interrupted`: left by a start whose process died before
   * the sandbox was ready. `unused_base`: an older cached base that no machine needs. `cleared`: a start
   * record whose start was cleaned up, or that can't be read.
   */
  reason: 'expired' | 'interrupted' | 'unused_base' | 'cleared'
  /** For people: what it is and why. */
  detail: string
  /** Whether it was done. False in a dry run, and when it failed. */
  done: boolean
  /** Why it failed, when it did. */
  error?: { code: string; message: string }
}

/** Something the reaper left alone that you may want to know about. */
export interface ReapSkip {
  kind: 'machine' | 'snapshot' | 'start'
  id: string
  sandbox: string | null
  /** `running`: its start is still going. `in_use`: machines were made from it. `other_backend`: a start on another backend. */
  reason: 'running' | 'in_use' | 'other_backend'
  detail: string
}

export interface ReapReport {
  dryRun: boolean
  backend: string
  /** The manager label value it acted on: `standalone:<host ID>`. */
  owner: string
  actions: ReapAction[]
  skipped: ReapSkip[]
}

export interface ReapOptions {
  /** Remove machines past their `blobby.dev/delete-after` (`rm --expired`). */
  expired?: boolean
  /** Remove what starts left when their process died before the sandbox was ready (`doctor --reap`). */
  interrupted?: boolean
  /** Remove older cached bases that no machine needs (`gc`). The newest base of each recipe stays, as the cache. */
  bases?: boolean
  /** Say what would be removed, and remove nothing. */
  dryRun?: boolean
  env?: NodeJS.ProcessEnv
  now?: () => number
  /** Whether a start's process is still running. Tests replace it. */
  alive?: (pid: number) => boolean
}

const sandboxOf = (machine: string): string | null => {
  if (!machine.startsWith(MACHINE_PREFIX)) return null
  const name = machine.slice(MACHINE_PREFIX.length)
  return NAME_PATTERN.test(name) ? name : null
}

const describe = (error: unknown): { code: string; message: string } => ({
  code: error instanceof SandboxError ? error.code : 'internal',
  message: String((error as Error)?.message ?? error),
})

const ago = (ms: number): string => {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`
}

/**
 * Removes this host's expired machines, what interrupted starts left, and cached bases nothing needs, as
 * asked. Removal is idempotent and each failure is reported, not thrown, so running it again finishes
 * the job.
 */
export async function reap(backend: Backend, options: ReapOptions = {}): Promise<ReapReport> {
  const env = options.env ?? process.env
  const now = (options.now ?? Date.now)()
  const alive = options.alive ?? processAlive
  const dryRun = options.dryRun ?? false
  const owner = `standalone:${await hostId(env)}`
  const report: ReapReport = { dryRun, backend: backend.name, owner, actions: [], skipped: [] }
  const mine = (labels: Readonly<Record<string, string>>) => labels[MANAGER_LABEL] === owner
  const machines = (await backend.list()).filter((machine) => mine(machine.labels))
  const removed = new Set<string>()

  const act = async (action: Omit<ReapAction, 'done'>, run: () => Promise<void>): Promise<boolean> => {
    const entry: ReapAction = { ...action, done: false }
    report.actions.push(entry)
    if (dryRun) return false
    try {
      await run()
      entry.done = true
    } catch (error) {
      entry.error = describe(error)
    }
    return entry.done
  }
  const removeMachine = async (machine: Machine, reason: ReapAction['reason'], detail: string): Promise<boolean> => {
    if (removed.has(machine.name)) return true
    removed.add(machine.name)
    return act({ kind: 'machine', id: machine.name, sandbox: sandboxOf(machine.name), reason, detail }, () => backend.remove(machine.name))
  }

  const { starts, unreadable, leftovers } = await readStarts(env)
  const running = new Set(starts.filter((start) => alive(start.pid)).map((start) => start.id))

  if (options.interrupted) {
    for (const start of starts) {
      if (running.has(start.id)) {
        report.skipped.push({ kind: 'start', id: start.id, sandbox: start.name, reason: 'running', detail: `Starting ${start.name} in process ${start.pid} since ${start.startedAt}.` })
        continue
      }
      if (start.backend !== backend.name) {
        report.skipped.push({
          kind: 'start',
          id: start.id,
          sandbox: start.name,
          reason: 'other_backend',
          detail: `${start.name} was being started on the ${start.backend} backend. Run \`blobby-sandbox doctor --reap --backend ${start.backend}\`.`,
        })
        continue
      }
      const since = Date.parse(start.startedAt) - CLOCK_SKEW_MS
      const left = machines.filter((machine) => {
        if (machine.labels[START_LABEL]) return machine.labels[START_LABEL] === start.id
        // Made before the engine labelled what each start creates: the sandbox itself, when this start created it.
        return !start.existed && machine.name === MACHINE_PREFIX + start.name && machine.createdAt !== null && Date.parse(machine.createdAt) >= since
      })
      let clean = true
      for (const machine of left) {
        const what = machine.name.startsWith(BASE_PREFIX) ? 'a base it was installing' : start.name
        clean = (await removeMachine(machine, 'interrupted', `${what}: the start in process ${start.pid} at ${start.startedAt} stopped before the sandbox was ready.`)) && clean
      }
      // A record stays until everything its start left is gone, so the next run tries again.
      if (clean || dryRun) {
        await act(
          { kind: 'start', id: start.id, sandbox: start.name, reason: 'cleared', detail: `The record of the interrupted start of ${start.name}.` },
          () => rm(join(startsDir(env), `${start.id}.json`), { force: true }),
        )
      }
    }
    for (const file of [...unreadable, ...leftovers]) {
      await act({ kind: 'start', id: file, sandbox: null, reason: 'cleared', detail: 'A start record that could not be read, or was never finished.' }, () => rm(file, { force: true }))
    }
  }

  if (options.expired) {
    for (const machine of machines) {
      const deadline = machine.deleteAfter === null ? NaN : Date.parse(machine.deleteAfter)
      if (Number.isNaN(deadline) || deadline > now) continue
      const start = machine.labels[START_LABEL]
      if (start && running.has(start)) {
        report.skipped.push({ kind: 'machine', id: machine.name, sandbox: sandboxOf(machine.name), reason: 'running', detail: 'It is past its deadline, but the start that made it is still going.' })
        continue
      }
      await removeMachine(machine, 'expired', `${sandboxOf(machine.name) ?? machine.name} expired ${ago(now - deadline)} ago (${machine.deleteAfter}).`)
    }
  }

  if (options.bases) await reapBases(backend, { machines: machines.filter((machine) => !removed.has(machine.name)), mine, dryRun, report, act, removeMachine })
  return report
}

/** Groups bases by recipe and removes all but the newest of each, unless machines still need them. */
async function reapBases(
  backend: Backend,
  context: {
    machines: Machine[]
    mine: (labels: Readonly<Record<string, string>>) => boolean
    dryRun: boolean
    report: ReapReport
    act: (action: Omit<ReapAction, 'done'>, run: () => Promise<void>) => Promise<boolean>
    removeMachine: (machine: Machine, reason: ReapAction['reason'], detail: string) => Promise<boolean>
  },
): Promise<void> {
  const { machines, mine, report, act } = context
  const byNewest = <T extends { createdAt: string | null }>(items: T[]) => [...items].sort((a, b) => (Date.parse(b.createdAt ?? '') || 0) - (Date.parse(a.createdAt ?? '') || 0))
  const groups = <T>(items: T[], key: (item: T) => string) => {
    const grouped = new Map<string, T[]>()
    for (const item of items) grouped.set(key(item), [...(grouped.get(key(item)) ?? []), item])
    return grouped
  }
  if (backend.capabilities().snapshot && backend.snapshots && backend.removeSnapshot) {
    const bases = (await backend.snapshots()).filter((snapshot) => mine(snapshot.labels) && snapshot.labels[BASE_LABEL])
    for (const [recipe, list] of groups(bases, (snapshot: Snapshot) => snapshot.labels[RECIPE_LABEL] ?? '')) {
      for (const snapshot of byNewest(list).slice(1)) {
        const users = machines.filter((machine) => machine.image === snapshot.id).map((machine) => sandboxOf(machine.name) ?? machine.name)
        if (users.length) {
          report.skipped.push({ kind: 'snapshot', id: snapshot.id, sandbox: null, reason: 'in_use', detail: `An older ${recipe || 'default'} base that ${users.join(', ')} were made from.` })
          continue
        }
        const done = await act({ kind: 'snapshot', id: snapshot.id, sandbox: null, reason: 'unused_base', detail: `An older ${recipe || 'default'} base (${snapshot.createdAt ?? 'time unknown'}).` }, () =>
          backend.removeSnapshot!(snapshot.id),
        )
        const failed = report.actions.at(-1)!
        if (!done && failed.error?.code === 'in_use') {
          report.actions.pop()
          report.skipped.push({ kind: 'snapshot', id: snapshot.id, sandbox: null, reason: 'in_use', detail: failed.error.message })
        }
      }
    }
    return
  }
  // Backends without snapshots keep each base as a machine that sandboxes are copied from.
  const bases = machines.filter((machine) => machine.name.startsWith(BASE_PREFIX))
  for (const [recipe, list] of groups(bases, (machine: Machine) => machine.labels[RECIPE_LABEL] ?? '')) {
    for (const machine of byNewest(list).slice(1)) {
      const done = await context.removeMachine(machine, 'unused_base', `An older ${recipe || 'default'} base (${machine.createdAt ?? 'time unknown'}).`)
      const failed = report.actions.at(-1)!
      if (!done && failed.error?.code === 'in_use') {
        report.actions.pop()
        report.skipped.push({ kind: 'machine', id: machine.name, sandbox: null, reason: 'in_use', detail: failed.error.message })
      }
    }
  }
}
