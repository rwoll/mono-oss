import { execFile } from 'node:child_process'
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { readAccountFile } from './account-file.ts'
import { SandboxError } from './backend.ts'
import type { CallbackAnswer, CallbackRequest } from './callbacks/protocol.ts'
import { binding, seal } from './callbacks/seal.ts'
import { accountKey, SignIns } from './callbacks/signin.ts'
import { decodeBase32 } from './callbacks/totp.ts'
import { configDir, displayPath } from './paths.ts'
import type { StepResult } from './sandboxes.ts'

export { decodeBase32, totp } from './callbacks/totp.ts'

/**
 * Secrets live on the client and answer the callbacks recipe steps ask for. Callback `github.password`
 * is field `password` of secret `github`, and `github.otp` is a current 2FA code made from its
 * `totpSecret`, which never leaves the client. A secret comes from, in order:
 *
 * 1. a provider: a program in `secrets.json` that prints the secret as a JSON object, such as a
 *    script that reads a password manager, so the secret is never saved by blobby-sandbox;
 * 2. an account file you keep, by path in `secrets.json`: blobby-sandbox reads it when a step asks, and
 *    never copies it;
 * 3. a file, `secrets/<name>.json`, that `blobby-sandbox secrets set` writes from the keyboard, readable only
 *    by you.
 *
 * Only plain identifiers go to a sandbox in the clear. Every other value is sealed to the one-time key
 * of the request that asked for it.
 */

export const SECRET_NAME = /^[a-z][a-z0-9-]{0,31}$/
/** Fields that are identifiers, not secrets, and may be sent in the clear. */
export const PLAIN_FIELDS = new Set(['login', 'username', 'email'])
/** Field names providers use, and the names blobby-sandbox reads them as. */
export const FIELD_ALIASES: Readonly<Record<string, string>> = { username: 'login', totp_key: 'totpSecret', totp: 'totpSecret' }
const MAX_BYTES = 64 * 1024
const PROVIDER_MS = 30_000

export type SecretValues = Record<string, string>

/** A secret as `secrets list` and `doctor` show it: where it comes from, and whether it works. Never a value or a login. */
export interface SecretStatus {
  name: string
  /** `provider`: a program; `path`: an account file you keep; `file`: saved by `secrets set` from the keyboard. */
  source: 'provider' | 'path' | 'file'
  /** The provider command, or the file. */
  detail: string
  /** What to fix, when it is not usable. Never contains a secret. */
  problem: string | null
}

/**
 * Checks and normalizes a secret: string fields only, with `username` and `totp_key` read as `login`
 * and `totpSecret`, and an `otpauth://` URI reduced to its key. Messages never quote a value.
 */
export function normalizeSecret(value: unknown): SecretValues {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SandboxError('invalid_secret', 'A secret must be a JSON object.')
  const out: SecretValues = {}
  for (const [key, field] of Object.entries(value)) {
    if (typeof field !== 'string') throw new SandboxError('invalid_secret', `Field ${key} of the secret is not text.`)
    out[FIELD_ALIASES[key] ?? key] = field
  }
  if (out.totpSecret?.startsWith('otpauth://')) {
    const key = new URL(out.totpSecret).searchParams.get('secret')
    if (!key) throw new SandboxError('invalid_secret', 'The otpauth:// URI has no secret.')
    out.totpSecret = key
  }
  if (out.totpSecret !== undefined) decodeBase32(out.totpSecret)
  if (out.login !== undefined && !/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(out.login)) {
    throw new SandboxError('invalid_secret', 'The login is not a GitHub username.')
  }
  return out
}

/** Replaces every sensitive value of `secret` in `text`. */
export function redact(text: string, secret: SecretValues): string {
  const values = Object.entries(secret)
    .filter(([key, value]) => !PLAIN_FIELDS.has(key) && value.length >= 4)
    .flatMap(([, value]) => [value, value.replace(/\s/g, '')])
  return values.reduce((out, value) => out.split(value).join('***'), text)
}

interface Config {
  providers: Record<string, string[]>
  /** Account files, by absolute path. */
  paths: Record<string, string>
}

export interface SecretsOptions {
  env?: NodeJS.ProcessEnv
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** The secrets of this client, and how it answers callbacks with them. */
export class Secrets {
  /** Per-account sign-in locks and the last 2FA period each account used, with this object's clock. */
  readonly signIns: SignIns
  readonly #env: NodeJS.ProcessEnv
  readonly #cache = new Map<string, Promise<SecretValues>>()

  constructor(options: SecretsOptions = {}) {
    this.#env = options.env ?? process.env
    const sleep = options.sleep
    this.signIns = new SignIns({ env: this.#env, now: options.now, sleep: sleep ? (ms) => sleep(ms) : (ms, signal) => delay(ms, undefined, { signal }) })
  }

  get #configFile(): string {
    return join(configDir(this.#env), 'secrets.json')
  }

  #file(name: string): string {
    return join(configDir(this.#env), 'secrets', `${checkName(name)}.json`)
  }

  async #config(): Promise<Config> {
    const text = await readFile(this.#configFile, 'utf8').catch(() => null)
    if (text === null) return { providers: {}, paths: {} }
    try {
      const parsed = JSON.parse(text) as Partial<Config>
      return { providers: parsed.providers ?? {}, paths: parsed.paths ?? {} }
    } catch {
      throw new SandboxError('invalid_config', `${displayPath(this.#configFile)} is not valid JSON.`)
    }
  }

  async #saveConfig(config: Config): Promise<void> {
    await writePrivate(this.#configFile, `${JSON.stringify(config, null, 2)}\n`)
  }

  /**
   * Every configured secret. Account files are always checked, without being read; with `check`,
   * providers run and every secret is read and checked.
   */
  async list(options: { check?: boolean } = {}): Promise<SecretStatus[]> {
    const { providers, paths } = await this.#config()
    const files = (await readdir(join(configDir(this.#env), 'secrets')).catch(() => [] as string[]))
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => entry.slice(0, -'.json'.length))
      .filter((name) => SECRET_NAME.test(name))
    const names = [...new Set([...Object.keys(providers), ...Object.keys(paths), ...files])]
    const statuses: SecretStatus[] = []
    for (const name of names.sort()) {
      const source: SecretStatus['source'] = providers[name] ? 'provider' : paths[name] ? 'path' : 'file'
      const detail = source === 'provider' ? providers[name]!.join(' ') : displayPath(source === 'path' ? paths[name]! : this.#file(name))
      try {
        if (options.check) await this.resolve(name)
        else if (source === 'path') await readAccountFile(paths[name]!, { contents: false })
        statuses.push({ name, source, detail, problem: null })
      } catch (error) {
        statuses.push({ name, source, detail, problem: (error as Error).message })
      }
    }
    return statuses
  }

  /**
   * Reads a secret from its provider, account file, or saved file. A provider runs once per Secrets
   * object; files are read each time, so a changed account file applies at once.
   */
  async resolve(name: string): Promise<SecretValues> {
    checkName(name)
    const cached = this.#cache.get(name)
    if (cached) return cached
    const config = await this.#config()
    const provider = config.providers[name]
    if (provider) {
      let pending = this.#cache.get(name)
      if (!pending) {
        pending = runProvider(name, provider).then((text) => normalizeSecret(JSON.parse(text)))
        this.#cache.set(name, pending)
        pending.catch(() => this.#cache.delete(name))
      }
      return pending
    }
    const path = config.paths[name]
    if (path) return normalizeSecret(await readAccountFile(path))
    const file = await readPrivate(this.#file(name))
    if (file !== null) return normalizeSecret(parseJson(file, this.#file(name)))
    throw new SandboxError('no_secret', `There is no ${name} secret. Set it with \`blobby-sandbox secrets set ${name}\`.`)
  }

  /** Saves a secret as a file only you can read, replacing a provider or account file of that name. */
  async setFile(name: string, values: SecretValues): Promise<void> {
    const checked = normalizeSecret(values)
    await writePrivate(this.#file(name), `${JSON.stringify(checked)}\n`)
    const config = await this.#config()
    if (config.providers[name] || config.paths[name]) {
      delete config.providers[name]
      delete config.paths[name]
      await this.#saveConfig(config)
    }
    this.#cache.delete(name)
  }

  /**
   * Makes an account file you keep the source of a secret, by its absolute path. Only the path is saved;
   * the file is checked now, and read each time a step asks for it.
   */
  async setPath(name: string, path: string): Promise<void> {
    checkName(name)
    if (!isAbsolute(path)) throw new SandboxError('usage', 'Give the account file as an absolute path.')
    await readAccountFile(path)
    const config = await this.#config()
    delete config.providers[name]
    config.paths[name] = path
    await this.#saveConfig(config)
    await rm(this.#file(name), { force: true })
    this.#cache.delete(name)
  }

  /** Makes a program the source of a secret: it prints the secret as a JSON object. */
  async setProvider(name: string, command: string[]): Promise<void> {
    checkName(name)
    if (!command.length || !command[0]) throw new SandboxError('usage', 'Give the provider command after --, such as `blobby-sandbox secrets set github --provider -- ~/bin/test-account`.')
    const config = await this.#config()
    config.providers[name] = command
    delete config.paths[name]
    await this.#saveConfig(config)
    await rm(this.#file(name), { force: true })
    this.#cache.delete(name)
  }

  async remove(name: string): Promise<boolean> {
    const config = await this.#config()
    let removed = false
    if (config.providers[name] || config.paths[name]) {
      delete config.providers[name]
      delete config.paths[name]
      await this.#saveConfig(config)
      removed = true
    }
    // Only the path is forgotten; an account file stays where it is.
    removed = (await rm(this.#file(name)).then(() => true, () => false)) || removed
    this.#cache.delete(name)
    return removed
  }

  /**
   * Answers a recipe step's callback: a field of a secret, or a current 2FA code, sealed unless it is an
   * identifier. It doesn't check the step's declarations or the sign-in allowlist; `LocalResolver` does.
   */
  async answer(request: CallbackRequest): Promise<CallbackAnswer> {
    const [secret, field] = request.name.split('.') as [string, string]
    // The 2FA key stays here: steps get codes from it, as `otp`, never the key itself.
    if (field === 'totpSecret' || FIELD_ALIASES[field] === 'totpSecret') {
      return { error: `blobby-sandbox never sends a 2FA key into a sandbox. Ask for ${secret}.otp, a current code, instead.` }
    }
    if (!request.sensitive && !PLAIN_FIELDS.has(field)) {
      return { error: `blobby-sandbox sends only ${[...PLAIN_FIELDS].join(', ')} in the clear. Mark ${request.name} sensitive in the recipe.` }
    }
    let value: string
    try {
      const values = await this.resolve(secret)
      if (field === 'otp') {
        if (!values.totpSecret) return { error: `The ${secret} secret has no totpSecret, so there is no 2FA code for ${request.name}.` }
        const account = accountKey(secret, values.login)
        const key = values.totpSecret
        value = await this.signIns.hold(account, secret, () => this.signIns.nextCode(account, key, secret))
      } else {
        const found = values[field]
        if (found === undefined) return { error: `The ${secret} secret has no ${field}.` }
        value = found
      }
    } catch (error) {
      return { error: (error as Error).message }
    }
    if (!request.sensitive) return { value }
    if (!request.publicKey) return { error: `The request for ${request.name} has no key to seal the answer to.` }
    return { sealed: seal(value, request.publicKey, binding(request.sandbox, request.step, request.id, request.name)) }
  }

  /** Checks that steps signed in the accounts the secrets name. */
  async verify(steps: StepResult[]): Promise<void> {
    for (const step of steps) {
      for (const [secret, login] of Object.entries(step.result)) {
        if (!SECRET_NAME.test(secret) || typeof login !== 'string') continue
        const expected = (await this.resolve(secret).catch(() => ({}) as SecretValues)).login
        if (expected && expected.toLowerCase() !== login.toLowerCase()) {
          throw new SandboxError('wrong_account', `"${step.name}" signed in to another account than the ${secret} secret's. Remove the sandbox, and check the secret.`)
        }
      }
    }
  }
}

function checkName(name: string): string {
  if (!SECRET_NAME.test(name)) throw new SandboxError('invalid_secret', `"${name}" is not a valid secret name. Use lowercase letters, digits, and dashes.`)
  return name
}

function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // JSON.parse errors quote the input, so they are never passed on.
    throw new SandboxError('invalid_secret', `${displayPath(path)} is not valid JSON.`)
  }
}

/** A file that must belong to you and be readable only by you, or null when there is none. */
async function readPrivate(path: string): Promise<string | null> {
  const info = await stat(path).catch(() => null)
  if (!info) return null
  const file = displayPath(path)
  if (!info.isFile()) throw new SandboxError('invalid_secret', `${file} is not a file.`)
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new SandboxError('invalid_secret', `${file} must belong to you.`)
  if ((info.mode & 0o077) !== 0) throw new SandboxError('invalid_secret', `${file} can be read by other users. Run: chmod 600 ${file}`)
  if (info.size > MAX_BYTES) throw new SandboxError('invalid_secret', `${file} is too large to be a secret.`)
  return readFile(path, 'utf8')
}

/** Writes a file only you can read, replacing any other in one step. */
async function writePrivate(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx' })
    await chmod(temporary, 0o600)
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

/** Runs a provider: no input, 30 seconds, 64 KiB of JSON. Its output is never shown, even when it fails. */
function runProvider(name: string, command: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command[0]!, command.slice(1), { encoding: 'buffer', maxBuffer: MAX_BYTES, timeout: PROVIDER_MS, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      stderr.fill(0)
      if (error) {
        stdout.fill(0)
        reject(new SandboxError('provider_failed', `The ${name} secret's provider failed (${(error as NodeJS.ErrnoException).code ?? 'exit'}); its output was withheld.`))
        return
      }
      const text = stdout.toString('utf8')
      stdout.fill(0)
      try {
        JSON.parse(text)
      } catch {
        reject(new SandboxError('provider_failed', `The ${name} secret's provider did not print a JSON object.`))
        return
      }
      resolve(text)
    })
  })
}
