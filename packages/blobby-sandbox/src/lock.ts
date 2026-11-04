import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { SandboxError } from './backend.ts'

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Whether a lock taken with `withLock` is held by a live process. */
export async function isLocked(path: string): Promise<boolean> {
  const owner = Number(await readFile(join(path, 'pid'), 'utf8').catch(() => ''))
  if (owner) return alive(owner)
  // A lock folder without a process ID was just taken, or left by a process that died taking it.
  const taken = (await stat(path).catch(() => null))?.mtimeMs
  return taken !== undefined && Date.now() - taken < 30_000
}

export interface LockOptions {
  /** Called once, when the lock is held by another process and this one starts waiting. */
  onWait?: () => void
  /** Stops waiting; the promise rejects with the signal's reason. */
  signal?: AbortSignal
}

/**
 * Takes a lock that other blobby-sandbox processes on this computer respect, and returns what releases
 * it. The lock is a folder holding the owner's process ID, so a lock left by a process that died is taken
 * over. Waits up to `timeoutMs`, then fails with `busy`.
 */
export async function acquireLock(path: string, what: string, timeoutMs: number, options: LockOptions = {}): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + timeoutMs
  let waiting = false
  for (;;) {
    options.signal?.throwIfAborted()
    try {
      await mkdir(path, { mode: 0o700 })
      await writeFile(join(path, 'pid'), String(process.pid), { mode: 0o600 })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const owner = Number(await readFile(join(path, 'pid'), 'utf8').catch(() => ''))
      // Without a process ID, the owner died between taking the lock and writing it, unless it just took it.
      const orphaned = !owner && Date.now() - ((await stat(path).catch(() => null))?.mtimeMs ?? Date.now()) > 30_000
      if ((owner && !alive(owner)) || orphaned) {
        await rm(path, { recursive: true, force: true })
        continue
      }
      if (Date.now() >= deadline) throw new SandboxError('busy', `Another blobby-sandbox command is ${what}. Try again when it finishes.`)
      if (!waiting) {
        waiting = true
        options.onWait?.()
      }
      await delay(500, undefined, { signal: options.signal }).catch(() => options.signal?.throwIfAborted())
    }
  }
  let released = false
  return async () => {
    if (released) return
    released = true
    await rm(path, { recursive: true, force: true })
  }
}

/** Runs `run` while holding the lock `acquireLock` takes. */
export async function withLock<T>(path: string, what: string, timeoutMs: number, run: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const release = await acquireLock(path, what, timeoutMs, options)
  try {
    return await run()
  } finally {
    await release()
  }
}
