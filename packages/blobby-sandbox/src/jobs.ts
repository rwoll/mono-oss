import { randomBytes } from 'node:crypto'
import { SandboxError } from './backend.ts'
import type { CallbackAnswer, CallbackRequest, ResolveContext, StepContext, WireContext } from './callbacks/protocol.ts'

export type JobEvent =
  | { type: 'progress'; text: string }
  /** A callback for the client to answer, with the step that asked, as the engine recorded it. */
  | { type: 'request'; request: CallbackRequest; context: WireContext }
  /**
   * A step's result for the client's resolver to check, with `checked`: the accounts it claims, which
   * only the resolver may see. The engine shows only what comes back. Emptied once answered.
   */
  | { type: 'check'; id: string; result: Record<string, unknown>; context: Omit<WireContext, 'binding'> }
  /** Output of a command that `exec` streams. */
  | { type: 'output'; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'done'; result: unknown }
  | { type: 'failed'; error: { code: string; message: string } }

export interface JobContext {
  progress(text: string): void
  /** Asks the client to answer a callback, and waits for `answer`. */
  request(request: CallbackRequest, context: ResolveContext): Promise<CallbackAnswer>
  /** Asks the client's resolver to check a step's result, and waits for `checked`. */
  check(result: Record<string, unknown>, context: StepContext): Promise<Record<string, unknown>>
  signal: AbortSignal
  /** Passes on a streamed command's output. */
  output(stream: 'stdout' | 'stderr', text: string): void
}

/** The client's answer to a `check` event: the result as it may be shown, or why the step fails. */
export type CheckReply = { result: Record<string, unknown> } | { error: { code: string; message: string } }

interface Job {
  events: JobEvent[]
  waiters: Set<() => void>
  pending: Map<string, (answer: CallbackAnswer) => void>
  checks: Map<string, (reply: CheckReply) => void>
  controller: AbortController
  finished: boolean
  expires: number
}

const KEEP_MS = 10 * 60_000
const ANSWER_MS = 5 * 60_000

/**
 * Long-running work, such as starting a sandbox, that a client follows by polling for events and
 * answers callbacks for. Polling works the same in-process and over plain HTTP, through any proxy, and
 * a client that loses its connection can pick the job up again by its ID.
 */
export class Jobs {
  readonly #jobs = new Map<string, Job>()

  start(run: (context: JobContext) => Promise<unknown>): string {
    this.#sweep()
    const id = randomBytes(16).toString('hex')
    const job: Job = { events: [], waiters: new Set(), pending: new Map(), checks: new Map(), controller: new AbortController(), finished: false, expires: Infinity }
    this.#jobs.set(id, job)
    const emit = (event: JobEvent) => {
      job.events.push(event)
      for (const wake of job.waiters) wake()
      job.waiters.clear()
    }
    const context: JobContext = {
      progress: (text) => emit({ type: 'progress', text }),
      // Functions stay here; the client gets the context as data.
      request: (request, { progress: _progress, signal: _signal, ...context }) =>
        new Promise<CallbackAnswer>((resolve) => {
          const timer = setTimeout(() => {
            job.pending.delete(request.id)
            resolve({ error: `No client answered ${request.name} in time.` })
          }, ANSWER_MS)
          job.pending.set(request.id, (answer) => {
            clearTimeout(timer)
            job.pending.delete(request.id)
            resolve(answer)
          })
          emit({ type: 'request', request, context })
        }),
      check: (result, { progress: _progress, signal: _signal, ...context }) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const id = randomBytes(8).toString('hex')
          const event: Extract<JobEvent, { type: 'check' }> = { type: 'check', id, result, context }
          const timer = setTimeout(() => settle({ error: { code: 'timeout', message: `No client checked "${context.step.name}" in time.` } }), ANSWER_MS)
          const settle = (reply: CheckReply) => {
            clearTimeout(timer)
            job.checks.delete(id)
            // The claimed accounts were for the client's resolver only.
            event.result = {}
            if ('error' in reply) reject(new SandboxError(reply.error.code, reply.error.message))
            else resolve(reply.result)
          }
          job.checks.set(id, settle)
          emit(event)
        }),
      signal: job.controller.signal,
      output: (stream, text) => emit({ type: 'output', stream, text }),
    }
    // A cancelled job answers what it still waits for at once, so nothing it runs waits on a client that left.
    job.controller.signal.addEventListener(
      'abort',
      () => {
        for (const resolve of job.pending.values()) resolve({ error: 'The job was cancelled.' })
        for (const settle of job.checks.values()) settle({ error: { code: 'cancelled', message: 'The job was cancelled.' } })
      },
      { once: true },
    )
    void run(context).then(
      (result) => emit({ type: 'done', result }),
      (error: unknown) => {
        const known = error instanceof SandboxError
        emit({ type: 'failed', error: { code: known ? error.code : 'internal', message: String((error as Error)?.message ?? error) } })
      },
    ).finally(() => {
      job.finished = true
      job.expires = Date.now() + KEEP_MS
      for (const resolve of job.pending.values()) resolve({ error: 'The job ended.' })
      for (const settle of job.checks.values()) settle({ error: { code: 'cancelled', message: 'The job ended.' } })
    })
    return id
  }

  /** Events after index `after`, waiting up to `waitMs` for one when there are none yet. */
  async events(id: string, after: number, waitMs: number): Promise<{ events: JobEvent[]; next: number; finished: boolean }> {
    const job = this.#get(id)
    if (job.events.length <= after && !job.finished && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          job.waiters.delete(wake)
          resolve()
        }, waitMs)
        const wake = () => {
          clearTimeout(timer)
          resolve()
        }
        job.waiters.add(wake)
      })
    }
    const events = job.events.slice(after)
    return { events, next: after + events.length, finished: job.finished && job.events.length <= after + events.length }
  }

  answer(id: string, requestId: string, answer: CallbackAnswer): void {
    const resolve = this.#get(id).pending.get(requestId)
    if (!resolve) throw new SandboxError('not_found', 'That request was answered already, or is not waiting for an answer.')
    resolve(answer)
  }

  checked(id: string, checkId: string, reply: CheckReply): void {
    const settle = this.#get(id).checks.get(checkId)
    if (!settle) throw new SandboxError('not_found', 'That result was checked already, or is not waiting for a check.')
    settle(reply)
  }

  cancel(id: string): void {
    this.#get(id).controller.abort(new SandboxError('cancelled', 'Cancelled.'))
  }

  #get(id: string): Job {
    const job = this.#jobs.get(id)
    if (!job) throw new SandboxError('not_found', 'There is no such job. Jobs are kept for 10 minutes after they end.')
    return job
  }

  #sweep(): void {
    const now = Date.now()
    for (const [id, job] of this.#jobs) if (job.finished && job.expires < now) this.#jobs.delete(id)
  }
}
