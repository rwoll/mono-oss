import {
  answerCallback,
  bindingOf,
  toResolver,
  withoutLogins,
  type AuditEvent,
  type CallbackAnswer,
  type CallbackRequest,
  type ResolveFunction,
  type Resolver,
  type StepContext,
} from './protocol.ts'
import { Redactor } from './redact.ts'

export interface StepCallbacksOptions extends StepContext {
  /** Answers the step's callbacks. Without one, every request is refused. */
  resolver?: Resolver | ResolveFunction
  /** Called for each answer and refusal. Never gets a value. */
  onAudit?: (event: AuditEvent) => void
  now?: () => number
}

/**
 * A controller's callbacks for one step it runs: the seam between a step runner, such as the engine,
 * and a resolver. It answers the step's requests (authorized against the step, audited), runs the step
 * through the resolver's `step` hook, and redacts the step's output with what the resolver knows.
 */
export class StepCallbacks {
  readonly context: StepContext
  readonly #resolver: Resolver | undefined
  readonly #redactor: Redactor
  readonly #onAudit: ((event: AuditEvent) => void) | undefined
  readonly #now: () => number

  constructor(options: StepCallbacksOptions) {
    const { resolver, onAudit, now, ...context } = options
    this.context = context
    this.#resolver = toResolver(resolver)
    this.#redactor = this.#resolver?.redactor ?? new Redactor()
    this.#onAudit = onAudit
    this.#now = now ?? Date.now
  }

  /** Runs the step, through the resolver's `step` hook when it has one. */
  run<T>(run: () => Promise<T>): Promise<T> {
    return this.#resolver?.step ? this.#resolver.step(this.context, run) : run()
  }

  /** Answers one of the step's requests. Refusal messages are redacted. */
  async answer(request: CallbackRequest): Promise<CallbackAnswer> {
    const answer = await answerCallback(request, { ...this.context, binding: bindingOf(request, this.context) }, this.#resolver, this.#onAudit, this.#now)
    return 'error' in answer ? { ...answer, error: this.redact(answer.error) } : answer
  }

  /**
   * What the step says it did, as it may be shown: the resolver checks the accounts it claims, every
   * login is replaced by `SignedIn`, and the rest is redacted. Throws when the resolver refuses it.
   */
  async result(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const checked = this.#resolver?.checkResult ? await this.#resolver.checkResult(raw, this.context) : raw
    // Whatever a resolver returned, no claimed account leaves as a login.
    return this.redactJson(withoutLogins(checked, this.context, false))
  }

  redact(text: string): string {
    return this.#redactor.text(text)
  }

  redactJson<T>(value: T): T {
    return this.#redactor.json(value)
  }
}
