import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { SandboxError } from '../backend.ts'
import { acquireLock, type LockOptions } from '../lock.ts'
import { configDir } from '../paths.ts'
import { totp } from './totp.ts'

/** GitHub's TOTP period. */
export const TOTP_PERIOD_MS = 30_000
/** A code with less time left than this waits for the next period, so it doesn't expire on its way. */
const MIN_LEFT_MS = 5_000
/** How long a sign-in waits for another sign-in of the same account by default: less than the 3 minutes a step waits for an answer. */
const LOCK_TIMEOUT_MS = 2 * 60_000
const ACCOUNT = /^[a-z0-9][a-z0-9-]{0,62}$/

export interface SignInsOptions {
  env?: NodeJS.ProcessEnv
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export interface WaitOptions {
  /** Says why the caller waits, for progress. */
  onWait?: (line: string) => void
  signal?: AbortSignal
}

/**
 * The account a secret signs in to, as a file name: a hash of its login, so no login is in a file name, or
 * the secret's name when it has none. Two secrets with one login share a lock and a TOTP record.
 */
export function accountKey(secret: string, login?: string): string {
  const key = login ? `login-${createHash('sha256').update(login.toLowerCase()).digest('hex').slice(0, 24)}` : `secret-${secret}`
  if (!ACCOUNT.test(key)) throw new SandboxError('invalid_secret', `The ${secret} secret's login can't name a sign-in lock.`)
  return key
}

/**
 * Serializes sign-ins per account, without a database: a file lock per account, and a record of the last
 * TOTP period used, both in `~/.config/blobby/signins/` (mode 700, files mode 600). GitHub accepts each
 * code once, so a code from a period already used is never given out again; the next sign-in waits for
 * the next period. Locks don't coordinate across computers: use one test account per person.
 */
export class SignIns {
  readonly #env: NodeJS.ProcessEnv
  readonly #now: () => number
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>

  constructor(options: SignInsOptions = {}) {
    this.#env = options.env ?? process.env
    this.#now = options.now ?? Date.now
    this.#sleep = options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }))
  }

  get dir(): string {
    return join(configDir(this.#env), 'signins')
  }

  async #ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    await chmod(this.dir, 0o700)
  }

  /**
   * Takes the account's sign-in lock, and returns what releases it. Waits while another sign-in of the
   * account, in this process or another, holds it, and says so; fails with `busy` after `timeoutMs`.
   */
  async acquire(account: string, what: string, options: WaitOptions & { timeoutMs?: number } = {}): Promise<() => Promise<void>> {
    checkAccount(account)
    await this.#ensureDir()
    const lock: LockOptions = { signal: options.signal, onWait: () => options.onWait?.(`Waiting for another sign-in to ${what} to finish`) }
    return acquireLock(join(this.dir, `${account}.lock`), `signing in to ${what}`, options.timeoutMs ?? LOCK_TIMEOUT_MS, lock)
  }

  /** Runs `run` holding the account's sign-in lock. */
  async hold<T>(account: string, what: string, run: () => Promise<T>, options: WaitOptions & { timeoutMs?: number } = {}): Promise<T> {
    const release = await this.acquire(account, what, options)
    try {
      return await run()
    } finally {
      await release()
    }
  }

  /** The last TOTP period a code was given out for, or null. */
  async lastPeriod(account: string): Promise<number | null> {
    const text = await readFile(join(this.dir, `${checkAccount(account)}.json`), 'utf8').catch(() => null)
    if (text === null) return null
    try {
      const period = (JSON.parse(text) as { lastPeriod?: unknown }).lastPeriod
      return typeof period === 'number' && Number.isInteger(period) ? period : null
    } catch {
      return null
    }
  }

  async #record(account: string, period: number): Promise<void> {
    await this.#ensureDir()
    const file = join(this.dir, `${account}.json`)
    const temporary = `${file}.${process.pid}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify({ lastPeriod: period })}\n`, { mode: 0o600 })
      await chmod(temporary, 0o600)
      await rename(temporary, file)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  /**
   * A TOTP code from a period later than the last one used for the account, with at least 5 seconds
   * left, recorded as used. Waits for the next period when needed, and says so. Hold the account's lock
   * while calling it, so two sign-ins can't take the same period.
   */
  async nextCode(account: string, key: string, what: string, options: WaitOptions = {}): Promise<string> {
    const last = (await this.lastPeriod(account)) ?? -1
    for (;;) {
      options.signal?.throwIfAborted()
      const now = this.#now()
      const period = Math.floor(now / TOTP_PERIOD_MS)
      const left = (period + 1) * TOTP_PERIOD_MS - now
      if (period > last && left >= MIN_LEFT_MS) {
        await this.#record(account, period)
        return totp(key, now)
      }
      const wait = left + 250
      const seconds = Math.ceil(wait / 1000)
      options.onWait?.(
        period > last
          ? `The current 2FA code of ${what} expires in ${Math.floor(left / 1000)} seconds; waiting ${seconds} seconds for the next one`
          : `The current 2FA code of ${what} was used already, and GitHub accepts each code once; waiting ${seconds} seconds for the next one`,
      )
      await this.#sleep(wait, options.signal)
    }
  }
}

function checkAccount(account: string): string {
  if (!ACCOUNT.test(account)) throw new SandboxError('usage', `"${account}" is not an account key. Make one with accountKey().`)
  return account
}
