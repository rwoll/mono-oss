import type { Redactor } from './redact.ts'
import type { Sealed } from './seal.ts'

/**
 * The callback protocol between a feature's steps and whoever holds the secrets. A step asks for a
 * callback by name, such as `github.password`; the controller (the engine, or a hosted controller)
 * checks the request against the step it started, and asks a `Resolver`. Sensitive answers are sealed to
 * a one-time key the step made for that one request. Sealing protects delivery; it doesn't authorize.
 */

/** A callback a step asked for. `publicKey` is set when it is sensitive. */
export interface CallbackRequest {
  /** The sandbox the step runs in. */
  sandbox: string
  /** The feature (recipe) whose step asked. */
  feature: string
  /** The step's run ID, which a sealed answer is bound to. */
  step: string
  stepName: string
  /** The request's ID, which a sealed answer is bound to. */
  id: string
  /** `<binding>.<field>`, such as `github.password`. */
  name: string
  sensitive: boolean
  /** The step's one-time X25519 public key for this request, base64url. */
  publicKey?: string
}

/** Stable codes for why a callback was refused. */
export const REFUSAL_CODES = [
  /** The request isn't for the step that runs now. */
  'wrong_step',
  /** The running step doesn't declare the callback in its `uses`. */
  'not_declared',
  /** The request's sensitivity or key doesn't match the declaration. */
  'mismatch',
  /** Nothing answers callbacks. */
  'no_resolver',
  /** The identity binding (a secret) behind the callback doesn't exist. */
  'no_binding',
  /** The binding exists but can't be read, such as a failing provider. */
  'binding_failed',
  /** The binding has no such field. */
  'no_field',
  /** Never answered, such as a 2FA seed. */
  'forbidden',
  /** Only identifiers go in the clear; this one must be declared sensitive. */
  'not_sensitive',
  /** The binding's login isn't on the sign-in allowlist. */
  'login_not_allowed',
  /** Another sign-in of the account held its lock for too long. */
  'busy',
  /** The request's key isn't a valid X25519 public key. */
  'invalid_key',
  /** A sensitive callback was answered in the clear. */
  'unsealed',
  /** The resolver failed. */
  'resolver_failed',
  /** The resolver refused without a code. */
  'refused',
] as const
export type RefusalCode = (typeof REFUSAL_CODES)[number]

/** Why a callback has no answer. Messages never contain secret values. */
export interface Refusal {
  error: string
  code?: RefusalCode | (string & {})
}

/** A plain value (identifiers only), a value sealed to the request's key, or a refusal. */
export type CallbackAnswer = { value: string } | { sealed: Sealed } | Refusal

/** A step, as the controller that started it recorded it. */
export interface StepRecord {
  /** The step's run ID. */
  id: string
  name: string
  /** The callbacks the step declared it uses. Only these are answered. */
  uses: readonly string[]
}

/** The step that runs now, as the controller recorded it. */
export interface StepContext {
  sandbox: string
  feature: string
  step: StepRecord
  /** The declared callbacks the step uses, with their sensitivity. */
  callbacks: Readonly<Record<string, { sensitive: boolean }>>
  /** Identity bindings by callback namespace, such as `{ github: 'github-test' }`. */
  bindings?: Readonly<Record<string, string>>
  /** Shows a line of progress to whoever started the sandbox, such as why an answer waits. */
  progress?: (line: string) => void
  signal?: AbortSignal
}

/** What a resolver knows about a request: the step that runs now, and the binding behind the request. */
export interface ResolveContext extends StepContext {
  /** The identity binding behind this request's namespace, when the controller has one, such as `github`. */
  binding?: string
}

/** `StepContext` and `ResolveContext` as they travel to a remote client: data only. */
export type WireContext = Omit<ResolveContext, 'progress' | 'signal'>

/**
 * Answers callbacks. The local implementation, `LocalResolver`, reads `Secrets`; a hosted one can read a
 * vault. A resolver must authorize every request itself (see `authorize`), never put a secret value in a
 * refusal, and seal every sensitive value to the request.
 */
export interface Resolver {
  resolve(request: CallbackRequest, context: ResolveContext): Promise<CallbackAnswer>
  /**
   * Runs one step that uses callbacks. Resolvers that hold locks for a whole step, such as a per-account
   * sign-in lock, release them when `run` settles.
   */
  step?<T>(context: StepContext, run: () => Promise<T>): Promise<T>
  /**
   * Checks what a step says it did, such as `{ github: '<login>' }` for the account it signed in to,
   * against the binding and the allowlist, and returns it with every account replaced by `SignedIn`.
   * Throws a `SandboxError`, such as `wrong_account`, to fail the step. Never puts a login in its errors.
   */
  checkResult?(result: Record<string, unknown>, context: StepContext): Promise<Record<string, unknown>>
  /** The values this resolver gave out, or knows are secret, so step output can be redacted. */
  readonly redactor?: Redactor
}

/**
 * What a step's result says about an account it signed in to, in place of the login, which never leaves
 * the engine and the resolver. `verified`: a resolver checked the account against the binding's, and for
 * sign-in namespaces such as `github`, against the allowlist.
 */
export interface SignedIn {
  signedIn: true
  verified: boolean
}

export function isSignedIn(value: unknown): value is SignedIn {
  return typeof value === 'object' && value !== null && (value as SignedIn).signedIn === true && typeof (value as SignedIn).verified === 'boolean'
}

/** The accounts a step's result claims: text values under the namespaces of the callbacks the step uses. */
export function accountClaims(result: Record<string, unknown>, context: Pick<StepContext, 'step'>): [namespace: string, login: string][] {
  const namespaces = new Set(context.step.uses.map((name) => splitCallback(name).namespace))
  return Object.entries(result).filter((entry): entry is [string, string] => namespaces.has(entry[0]) && typeof entry[1] === 'string')
}

/** The result with each account it claims replaced by `SignedIn`, so no login is in it. */
export function withoutLogins(result: Record<string, unknown>, context: Pick<StepContext, 'step'>, verified: boolean): Record<string, unknown> {
  const claims = new Set(accountClaims(result, context).map(([namespace]) => namespace))
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, claims.has(key) ? ({ signedIn: true, verified } satisfies SignedIn) : value]))
}

/** A resolver as a plain function, as `onRequest` options take it. */
export type ResolveFunction = (request: CallbackRequest, context: ResolveContext) => Promise<CallbackAnswer>

/** One answer or refusal, for an audit log. Never holds a value. */
export interface AuditEvent {
  /** ISO 8601 time. */
  at: string
  sandbox: string
  feature: string
  /** The step's run ID. */
  step: string
  stepName: string
  /** The request's ID. */
  request: string
  name: string
  binding: string | null
  outcome: 'answered' | 'refused'
  /** For refusals, why. */
  code: string | null
  /** For answers, whether the value was sealed. */
  sealed: boolean
}

export function refuse(code: RefusalCode, error: string): Refusal {
  return { error, code }
}

export function isRefusal(answer: CallbackAnswer): answer is Refusal {
  return 'error' in answer
}

/** The namespace and field of a callback name: `github.password` is field `password` of `github`. */
export function splitCallback(name: string): { namespace: string; field: string } {
  const dot = name.indexOf('.')
  return dot === -1 ? { namespace: name, field: '' } : { namespace: name.slice(0, dot), field: name.slice(dot + 1) }
}

/** The binding behind a request: the controller's binding for its namespace, or none. */
export function bindingOf(request: Pick<CallbackRequest, 'name'>, context: StepContext): string | undefined {
  return context.bindings?.[splitCallback(request.name).namespace]
}

/**
 * Whether a request may be answered at all: it belongs to the step that runs now, the step declared
 * the callback, and the request's sensitivity and key match the declaration. Returns the refusal, or
 * null. Resolvers still check that the binding exists and may be used.
 */
export function authorize(request: CallbackRequest, context: StepContext): Refusal | null {
  if (request.sandbox !== context.sandbox || request.step !== context.step.id) {
    return refuse('wrong_step', `The request for ${request.name} is not from the step that runs in ${context.sandbox} now.`)
  }
  const declared = context.callbacks[request.name]
  if (!context.step.uses.includes(request.name) || !declared) return refuse('not_declared', `This step cannot ask for ${request.name}.`)
  if (declared.sensitive !== request.sensitive || (declared.sensitive && !request.publicKey)) {
    return refuse('mismatch', `The request for ${request.name} does not match the recipe's callbacks.`)
  }
  return null
}

/** Accepts a resolver object or function, as engine and client options do. */
export function toResolver(resolver: Resolver | ResolveFunction | undefined): Resolver | undefined {
  return typeof resolver === 'function' ? { resolve: resolver } : resolver
}

/**
 * The controller's side of one request: authorizes it against the running step, asks the resolver,
 * checks that sensitive answers are sealed, and reports the outcome to `onAudit`. Never throws.
 */
export async function answerCallback(
  request: CallbackRequest,
  context: ResolveContext,
  resolver: Resolver | undefined,
  onAudit?: (event: AuditEvent) => void,
  now: () => number = Date.now,
): Promise<CallbackAnswer> {
  const finish = (answer: CallbackAnswer): CallbackAnswer => {
    try {
      onAudit?.({
        at: new Date(now()).toISOString(),
        sandbox: request.sandbox,
        feature: request.feature,
        step: request.step,
        stepName: request.stepName,
        request: request.id,
        name: request.name,
        binding: context.binding ?? null,
        outcome: isRefusal(answer) ? 'refused' : 'answered',
        code: isRefusal(answer) ? (answer.code ?? 'refused') : null,
        sealed: 'sealed' in answer,
      })
    } catch {
      // An audit sink that fails doesn't change the answer.
    }
    return answer
  }
  const refused = authorize(request, context)
  if (refused) return finish(refused)
  if (!resolver) return finish(refuse('no_resolver', `No client is answering callbacks, so ${request.name} has no answer.`))
  let answer: CallbackAnswer
  try {
    answer = await resolver.resolve(request, context)
  } catch (error) {
    return finish(refuse('resolver_failed', String((error as Error)?.message ?? error)))
  }
  if (isRefusal(answer)) return finish({ error: String(answer.error), code: answer.code ?? 'refused' })
  if (request.sensitive ? !('sealed' in answer) : !('value' in answer)) {
    return finish(refuse('unsealed', `The client answered ${request.name} the wrong way: sensitive callbacks must be sealed.`))
  }
  return finish(answer)
}
