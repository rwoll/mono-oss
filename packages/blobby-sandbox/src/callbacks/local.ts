import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SandboxError } from '../backend.ts'
import { configDir, displayPath } from '../paths.ts'
import { FIELD_ALIASES, PLAIN_FIELDS, Secrets, type SecretValues } from '../secrets.ts'
import {
  accountClaims,
  authorize,
  bindingOf,
  refuse,
  splitCallback,
  withoutLogins,
  type CallbackAnswer,
  type CallbackRequest,
  type ResolveContext,
  type Resolver,
  type StepContext,
} from './protocol.ts'
import { Redactor } from './redact.ts'
import { binding, seal } from './seal.ts'
import { accountKey } from './signin.ts'

/** Lists the logins whose secrets may go into sandboxes, comma-separated. Wins over `allowedLogins` in `config.json`. */
export const ALLOWED_LOGINS_ENV = 'BLOBBY_SANDBOX_ALLOWED_LOGINS'

export interface AllowedLogins {
  /** Lowercase. */
  logins: string[]
  source: 'env' | 'config' | 'option' | 'none'
}

/**
 * The logins whose secrets may go into sandboxes: `BLOBBY_SANDBOX_ALLOWED_LOGINS`, else `allowedLogins`
 * in `~/.config/blobby/config.json`, else none, so every secret is refused. Keep it to dedicated test accounts.
 */
export async function loadAllowedLogins(env: NodeJS.ProcessEnv = process.env): Promise<AllowedLogins> {
  const listed = env[ALLOWED_LOGINS_ENV]
  if (listed?.trim()) return { logins: clean(listed.split(',')), source: 'env' }
  const file = join(configDir(env), 'config.json')
  const text = await readFile(file, 'utf8').catch(() => null)
  if (text === null) return { logins: [], source: 'none' }
  let config: unknown
  try {
    config = JSON.parse(text)
  } catch {
    throw new SandboxError('invalid_config', `${displayPath(file)} is not valid JSON.`)
  }
  const logins = (config as { allowedLogins?: unknown } | null)?.allowedLogins
  if (logins === undefined) return { logins: [], source: 'none' }
  if (!Array.isArray(logins) || logins.some((login) => typeof login !== 'string')) {
    throw new SandboxError('invalid_config', `"allowedLogins" in ${displayPath(file)} must be a list of logins.`)
  }
  return { logins: clean(logins as string[]), source: 'config' }
}

const clean = (logins: string[]) => [...new Set(logins.map((login) => login.trim().toLowerCase()).filter(Boolean))]

const HOW_TO_ALLOW = `Add your test account's login to "allowedLogins" in ~/.config/blobby/config.json, or set ${ALLOWED_LOGINS_ENV}.`

export interface LocalResolverOptions {
  /** Where secrets come from. Default: `new Secrets({ env })`. Its clock also times 2FA codes. */
  secrets?: Secrets
  env?: NodeJS.ProcessEnv
  /** The logins whose secrets may be answered. Default: `loadAllowedLogins(env)`. Empty refuses every secret. */
  allowedLogins?: readonly string[]
  /** The secret behind each callback namespace, such as `{ github: 'github-test' }`. Default: the secret named like the namespace. The controller's `context.binding` wins. */
  bindings?: Readonly<Record<string, string>>
  /** How long a sign-in waits for another sign-in of the same account before it is refused with `busy`. Default 2 minutes. */
  lockTimeoutMs?: number
}

/**
 * Answers callbacks from this computer's `Secrets`: `github.password` is field `password` of the
 * `github` secret (or of the secret `bindings` names), and `github.otp` a current 2FA code made from its
 * `totpSecret`, which never leaves this process.
 *
 * - **Authorization:** only callbacks the running step declared, from a secret that exists and whose
 *   login is on the allowlist. It fails closed: no allowlist, or a secret without a login, is refused.
 * - **One sign-in per account at a time:** the first request of a step for an account takes the
 *   account's lock in `~/.config/blobby/signins/`, until the step ends (`step`) or `release`. A 2FA code
 *   is never given out twice; the next sign-in waits for the next period, and says so.
 * - **Redaction:** every secret value it reads or makes goes into `redactor`.
 */
export class LocalResolver implements Resolver {
  readonly secrets: Secrets
  readonly redactor = new Redactor()
  readonly #env: NodeJS.ProcessEnv
  readonly #bindings: Readonly<Record<string, string>>
  readonly #lockTimeoutMs: number | undefined
  #allowed: Promise<AllowedLogins> | null
  /** Sign-in locks this resolver holds, by sandbox, step, and account. */
  readonly #held = new Map<string, Promise<() => Promise<void>>>()

  constructor(options: LocalResolverOptions = {}) {
    this.#env = options.env ?? process.env
    this.secrets = options.secrets ?? new Secrets({ env: this.#env })
    this.#bindings = { ...options.bindings }
    this.#lockTimeoutMs = options.lockTimeoutMs
    this.#allowed = options.allowedLogins ? Promise.resolve({ logins: clean([...options.allowedLogins]), source: 'option' }) : null
  }

  /** The allowlist, read once. */
  allowedLogins(): Promise<AllowedLogins> {
    this.#allowed ??= loadAllowedLogins(this.#env)
    this.#allowed.catch(() => (this.#allowed = null))
    return this.#allowed
  }

  /** The secret that answers a namespace's callbacks. */
  secretFor(namespace: string, context?: Pick<ResolveContext, 'binding'>): string {
    return context?.binding ?? this.#bindings[namespace] ?? namespace
  }

  async resolve(request: CallbackRequest, context: ResolveContext): Promise<CallbackAnswer> {
    const refused = authorize(request, context)
    if (refused) return refused
    const { namespace, field } = splitCallback(request.name)
    const secret = this.secretFor(namespace, context)
    // The 2FA key stays here: steps get codes from it, as `otp`, never the key itself.
    if (field === 'totpSecret' || FIELD_ALIASES[field] === 'totpSecret') {
      return refuse('forbidden', `blobby-sandbox never sends a 2FA key into a sandbox. Ask for ${namespace}.otp, a current code, instead.`)
    }
    if (!request.sensitive && !PLAIN_FIELDS.has(field)) {
      return refuse('not_sensitive', `blobby-sandbox sends only ${[...PLAIN_FIELDS].join(', ')} in the clear. Mark ${request.name} sensitive in the recipe.`)
    }
    let values: SecretValues
    try {
      values = await this.secrets.resolve(secret)
    } catch (error) {
      const missing = error instanceof SandboxError && error.code === 'no_secret'
      return refuse(missing ? 'no_binding' : 'binding_failed', this.redactor.text((error as Error).message))
    }
    this.#remember(values)
    const problem = await this.#allowProblem(secret, values.login)
    if (problem) return refuse('login_not_allowed', problem)
    let value: string
    try {
      const account = values.login || values.totpSecret ? await this.#holdAccount(secret, values, context) : null
      if (field === 'otp') {
        if (!values.totpSecret || !account) return refuse('no_field', `The ${secret} secret has no totpSecret, so there is no 2FA code for ${request.name}.`)
        value = await this.secrets.signIns.nextCode(account, values.totpSecret, secret, { onWait: context.progress, signal: context.signal })
        this.redactor.add(value)
      } else {
        const found = values[field]
        if (found === undefined) return refuse('no_field', `The ${secret} secret has no ${field}.`)
        value = found
      }
    } catch (error) {
      if (error instanceof SandboxError && error.code === 'busy') return refuse('busy', error.message)
      throw error
    }
    if (!request.sensitive) return { value }
    try {
      return { sealed: seal(value, request.publicKey!, binding(request.sandbox, request.step, request.id, request.name)) }
    } catch (error) {
      return refuse('invalid_key', (error as Error).message)
    }
  }

  /**
   * Checks, before anything starts, that the secret behind a namespace (`exec --secret github`) may go
   * into a sandbox: the allowlist isn't empty, the secret exists, and its login is on the list. Fails
   * with `login_not_allowed`, or the secret's own error. Never names the login.
   */
  async checkSecret(namespace: string): Promise<void> {
    const secret = this.secretFor(namespace)
    if (!(await this.allowedLogins()).logins.length) {
      throw new SandboxError('login_not_allowed', `No logins are allowed, so blobby-sandbox refuses the ${secret} secret. ${HOW_TO_ALLOW}`)
    }
    const values = await this.secrets.resolve(secret)
    const problem = await this.#allowProblem(secret, values.login)
    if (problem) throw new SandboxError('login_not_allowed', problem)
  }

  /** Runs a step, then releases the sign-in locks it took. */
  async step<T>(context: StepContext, run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } finally {
      await this.#release(`${context.sandbox}\0${context.step.id}\0`)
    }
  }

  /** Releases every sign-in lock this resolver holds. Clients that relay requests from a server call it when a start ends. */
  release(): Promise<void> {
    return this.#release('')
  }

  /**
   * Checks the accounts a step says it signed in to: each must be its secret's, and on the allowlist.
   * Returns the result with each login replaced by `SignedIn`, so no login is shown. Errors never name a login.
   */
  async checkResult(result: Record<string, unknown>, context: StepContext): Promise<Record<string, unknown>> {
    for (const [namespace, login] of accountClaims(result, context)) {
      const secret = this.secretFor(namespace, { binding: bindingOf({ name: `${namespace}.login` }, context) })
      const expected = (await this.secrets.resolve(secret).catch(() => ({}) as SecretValues)).login
      if (expected && expected.toLowerCase() !== login.toLowerCase()) {
        throw new SandboxError('wrong_account', `"${context.step.name}" signed in to another account than the ${secret} secret's. Remove the sandbox, and check the secret.`)
      }
      if (!(await this.allowedLogins()).logins.includes(login.toLowerCase())) {
        throw new SandboxError('login_not_allowed', `"${context.step.name}" signed in to ${namespace} with a login that is not in allowedLogins. Remove the sandbox, and check the ${secret} secret.`)
      }
    }
    return withoutLogins(result, context, true)
  }

  /** Every value of a secret is withheld from output, its login too, so no account name is shown. */
  #remember(values: SecretValues): void {
    this.redactor.add(...Object.values(values))
  }

  async #allowProblem(secret: string, login: string | undefined): Promise<string | null> {
    const { logins } = await this.allowedLogins()
    if (!logins.length) return `No logins are allowed, so blobby-sandbox refuses the ${secret} secret. ${HOW_TO_ALLOW}`
    if (!login) return `The ${secret} secret has no login, so blobby-sandbox can't check it against allowedLogins. Add the login of the test account it belongs to.`
    if (!logins.includes(login.toLowerCase())) return `The ${secret} secret's login is not in allowedLogins, so blobby-sandbox refuses it. ${HOW_TO_ALLOW}`
    return null
  }

  /** Takes the account's sign-in lock for this step, once, and returns the account. */
  async #holdAccount(secret: string, values: SecretValues, context: ResolveContext): Promise<string> {
    const account = accountKey(secret, values.login)
    const key = `${context.sandbox}\0${context.step.id}\0${account}`
    let held = this.#held.get(key)
    if (!held) {
      held = this.secrets.signIns.acquire(account, secret, { onWait: context.progress, signal: context.signal, timeoutMs: this.#lockTimeoutMs })
      this.#held.set(key, held)
      held.catch(() => this.#held.delete(key))
    }
    await held
    return account
  }

  async #release(prefix: string): Promise<void> {
    for (const [key, held] of this.#held) {
      if (!key.startsWith(prefix)) continue
      this.#held.delete(key)
      await held.then((release) => release(), () => {})
    }
  }
}

export interface AllowlistStatus {
  /** How many logins are allowed. */
  allowedLogins: number
  source: AllowedLogins['source'] | 'invalid'
  /** What to fix before secrets can go into sandboxes, or null. Never names a login. */
  problem: string | null
}

/** For `doctor`: the allowlist, and whether each secret that resolves has a login on it. */
export async function allowlistStatus(secrets: Secrets, env: NodeJS.ProcessEnv = process.env): Promise<AllowlistStatus> {
  let allowed: AllowedLogins
  try {
    allowed = await loadAllowedLogins(env)
  } catch (error) {
    return { allowedLogins: 0, source: 'invalid', problem: (error as Error).message }
  }
  const base = { allowedLogins: allowed.logins.length, source: allowed.source }
  if (!allowed.logins.length) return { ...base, problem: `No logins are allowed, so every secret is refused. ${HOW_TO_ALLOW}` }
  for (const { name, problem } of await secrets.list()) {
    // A secret that doesn't resolve has its own doctor check.
    const values = problem ? null : await secrets.resolve(name).catch(() => null)
    if (!values) continue
    if (!values.login) return { ...base, problem: `The ${name} secret has no login, so it is refused. Add the login of the test account it belongs to.` }
    if (!allowed.logins.includes(values.login.toLowerCase())) return { ...base, problem: `The ${name} secret's login is not in allowedLogins, so it is refused. ${HOW_TO_ALLOW}` }
  }
  return { ...base, problem: null }
}
