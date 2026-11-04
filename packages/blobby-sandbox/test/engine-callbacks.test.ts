import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalResolver, type AuditEvent, type CallbackRequest, type ResolveContext, type Resolver, type StepContext } from '../src/callbacks/index.ts'
import { connect } from '../src/client.ts'
import { totp } from '../src/secrets.ts'
import { askInTurn } from './fake-guest.ts'
import { RFC_KEY, signInRecipe, signInRef, world, type World } from './world.ts'

let w: World
beforeEach(async () => {
  w = await world()
})
afterEach(() => w.cleanup())

const USES = ['github.login', 'github.password', 'github.otp']

/** A resolver that records what it was asked, and answers with a LocalResolver. */
function recording(local: LocalResolver) {
  const calls: { request: CallbackRequest; context: Omit<ResolveContext, 'progress' | 'signal'> }[] = []
  const steps: StepContext[] = []
  const resolver: Resolver = {
    redactor: local.redactor,
    resolve: (request, context) => {
      const { progress: _progress, signal: _signal, ...data } = context
      calls.push({ request, context: data })
      return local.resolve(request, context)
    },
    step: (context, run) => {
      steps.push(context)
      return local.step(context, run)
    },
    checkResult: (result, context) => local.checkResult(result, context),
  }
  return { resolver, calls, steps }
}

describe('the engine\'s callback seam', () => {
  it('passes the step as it started it, the binding, and audits each answer', async () => {
    await w.secrets.setFile('github-test', { login: 'test-account', password: 'pa55-w0rd!', totpSecret: RFC_KEY })
    const local = new LocalResolver({ secrets: w.secrets, env: w.env })
    const { resolver, calls, steps } = recording(local)
    const audit: AuditEvent[] = []
    const started = await w.engine.start('t1', { recipe: signInRecipe, resolver, bindings: { github: 'github-test' }, onAudit: (event) => audit.push(event) })
    expect(started!.steps).toEqual([{ name: 'Sign in to the test account', result: { github: { signedIn: true, verified: true } } }])
    expect(steps).toEqual([expect.objectContaining({ sandbox: 't1', feature: 'signin-test', step: { id: expect.stringMatching(/^[a-f0-9]{16}$/), name: 'Sign in to the test account', uses: USES } })])
    expect(calls.map((call) => [call.request.name, call.request.feature, call.context.binding, call.context.step.uses])).toEqual(USES.map((name) => [name, 'signin-test', 'github-test', USES]))
    expect(audit.map((event) => [event.sandbox, event.name, event.outcome, event.binding, event.sealed])).toEqual([
      ['t1', 'github.login', 'answered', 'github-test', false],
      ['t1', 'github.password', 'answered', 'github-test', true],
      ['t1', 'github.otp', 'answered', 'github-test', true],
    ])
    const [step] = w.guest.steps.values()
    expect(step!.values.get('github.password')).toEqual({ value: 'pa55-w0rd!' })
  })

  it('refuses requests the step did not declare, and audits the refusal', async () => {
    w.guest.script = (step) => {
      if (!step.requests.length) step.requests.push({ id: 'cccccccccccccccc', name: 'github.token', sensitive: true, publicKey: 'x'.repeat(43) })
      else if (step.values.size) {
        step.exit = 1
        step.error = (step.values.get('github.token') as { error: string }).error
      }
    }
    const audit: AuditEvent[] = []
    const local = new LocalResolver({ secrets: w.secrets, env: w.env })
    await expect(w.engine.start('t1', { recipe: signInRecipe, resolver: local, onAudit: (event) => audit.push(event) })).rejects.toMatchObject({
      code: 'step_failed',
      message: expect.stringContaining('This step cannot ask for github.token.'),
    })
    expect(audit).toEqual([expect.objectContaining({ name: 'github.token', outcome: 'refused', code: 'not_declared' })])
  })

  it('signs in two sandboxes of one account in turn, each with its own 2FA code', async () => {
    const local = new LocalResolver({ secrets: w.secrets, env: w.env })
    const progress: string[] = []
    // The first sign-in finishes only once the second has started, so they overlap.
    w.guest.script = (step) => {
      askInTurn(step)
      if (step.exit !== null && w.guest.steps.size < 2) {
        step.exit = null
        step.result = null
      }
    }
    const [one, two] = await Promise.all(
      ['t1', 't2'].map((name) => w.engine.start(name, { recipe: signInRecipe, resolver: local, onProgress: (line) => progress.push(`${name}: ${line}`) })),
    )
    expect([one!.steps, two!.steps]).toEqual([[expect.objectContaining({ result: { github: { signedIn: true, verified: true } } })], [expect.objectContaining({ result: { github: { signedIn: true, verified: true } } })]])
    const codes = [...w.guest.steps.values()].map((step) => (step.values.get('github.otp') as { value: string }).value)
    expect(new Set(codes).size).toBe(2)
    expect(codes).toEqual(expect.arrayContaining([totp(RFC_KEY, Date.UTC(2026, 0, 1, 0, 0, 1))]))
    expect(progress).toContainEqual(expect.stringMatching(/^t[12]: Waiting for another sign-in to github to finish$/))
    expect(progress).toContainEqual(expect.stringMatching(/^t[12]: The current 2FA code of github was used already/))
  })
})

describe('a client with a resolver', () => {
  it('gets the step\'s context with each request, and answers through the resolver', async () => {
    const local = new LocalResolver({ secrets: w.secrets, env: w.env })
    const { resolver, calls } = recording(local)
    const client = connect({ engine: async () => w.engine })
    const { started } = await client.start('t1', { recipe: signInRef, resolver }).finally(() => local.release())
    expect(started!.steps).toEqual([expect.objectContaining({ result: { github: { signedIn: true, verified: true } } })])
    expect(calls.map((call) => call.context)).toEqual(
      USES.map(() => ({ sandbox: 't1', feature: 'signin-test', step: expect.objectContaining({ uses: USES }), callbacks: expect.any(Object) })),
    )
  })

  it('still takes a function, and refuses with a code when it has none', async () => {
    const client = connect({ engine: async () => w.engine })
    const error = await client.start('t1', { recipe: signInRef, onRequest: async () => ({ error: 'No, thank you.' }) }).catch((caught: Error) => caught)
    expect(error).toMatchObject({ code: 'step_failed', message: expect.stringContaining('No, thank you.') })
    const none = await client.start('t2', { recipe: signInRef }).catch((caught: Error) => caught)
    expect(none).toMatchObject({ code: 'step_failed', message: expect.stringContaining('does not answer callbacks') })
  })
})
