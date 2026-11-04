// The callback protocol, sealing, and resolvers, at `@rwoll/blobby-sandbox/callbacks`. A feature's steps
// ask for callbacks by name; a controller checks each request against the step it started and asks a
// `Resolver`, which answers sealed values or refuses with a stable code. `LocalResolver` reads this
// computer's `Secrets`; a hosted controller implements `Resolver` over its own vault. Nothing here needs
// a database, the Blobby app, or an agent SDK.

export {
  answerCallback,
  authorize,
  bindingOf,
  accountClaims,
  isRefusal,
  isSignedIn,
  REFUSAL_CODES,
  refuse,
  splitCallback,
  toResolver,
  withoutLogins,
} from './protocol.ts'
export type {
  AuditEvent,
  CallbackAnswer,
  CallbackRequest,
  Refusal,
  RefusalCode,
  ResolveContext,
  ResolveFunction,
  Resolver,
  SignedIn,
  StepContext,
  StepRecord,
  WireContext,
} from './protocol.ts'
export { binding, seal } from './seal.ts'
export type { Sealed } from './seal.ts'
export { RedactedStream, Redactor, REDACTED } from './redact.ts'
export { accountKey, SignIns, TOTP_PERIOD_MS } from './signin.ts'
export type { SignInsOptions, WaitOptions } from './signin.ts'
export { ALLOWED_LOGINS_ENV, allowlistStatus, loadAllowedLogins, LocalResolver, type AllowlistStatus } from './local.ts'
export type { AllowedLogins, LocalResolverOptions } from './local.ts'
export { StepCallbacks } from './step.ts'
export type { StepCallbacksOptions } from './step.ts'
export { decodeBase32, totp } from './totp.ts'
export { normalizeSecret, PLAIN_FIELDS, Secrets } from '../secrets.ts'
export type { SecretStatus, SecretValues, SecretsOptions } from '../secrets.ts'
