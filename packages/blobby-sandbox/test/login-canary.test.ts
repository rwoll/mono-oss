import { randomBytes } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalResolver, type AuditEvent } from '../src/callbacks/index.ts'
import { main, type Io } from '../src/cli.ts'
import { connect } from '../src/client.ts'
import { serve } from '../src/serve.ts'
import { askInTurn, type FakeStep } from './fake-guest.ts'
import { RFC_KEY, SIGN_IN_RECIPE_DIR, signInRecipe, signInRef, world, type World } from './world.ts'

// The test account's login must never show up where an agent could copy it into a report, an issue, or a
// pull request: CLI output, progress, step results, errors, or audit events. The engine and the resolver
// check it, and show only that a test account signed in. A canary login, which steps also leak on
// purpose, must not appear anywhere.

const LOGIN = `cl-${randomBytes(8).toString('hex')}`

/** Signs in, then prints the login, returns it twice, or fails with it. */
const leaky = (fail: boolean) => (step: FakeStep) => {
  askInTurn(step)
  if (step.exit === null) return
  const login = (step.values.get('github.login') as { value: string }).value
  step.progress.push(`Signed in as ${login}`, JSON.stringify({ login }))
  if (fail) {
    step.exit = 1
    step.error = `GitHub signed in as ${login}, which is wrong`
    step.result = null
  } else step.result = { github: login, echo: login }
}

let w: World
beforeEach(async () => {
  w = await world({ secret: false })
  w.env.BLOBBY_SANDBOX_ALLOWED_LOGINS = LOGIN
  await w.secrets.setFile('github', { login: LOGIN, password: 'pa55-w0rd!', totpSecret: RFC_KEY })
})
afterEach(() => w.cleanup())

const SIGNED_IN = { signedIn: true, verified: true }

describe('the test account login', () => {
  it('never shows in what the engine, a client, or the CLI reports', async () => {
    const seen: unknown[] = []
    const audit: AuditEvent[] = []

    // The engine in this process, with a resolver.
    w.guest.script = leaky(false)
    const local = new LocalResolver({ secrets: w.secrets, env: w.env })
    const engine = await w.engine.start('e1', { recipe: signInRecipe, resolver: local, onProgress: (line) => seen.push(line), onAudit: (event) => audit.push(event) })
    expect(engine.steps).toEqual([{ name: 'Sign in to the test account', result: { github: SIGNED_IN, echo: '***' } }])
    seen.push(engine)

    // A client in this process, and one over HTTP, which check results through the job.
    const served = await serve({ engine: async () => w.engine, token: 'token' })
    try {
      for (const [name, client] of [['c1', connect({ engine: async () => w.engine })], ['c2', connect({ server: served.url, token: 'token' })]] as const) {
        const resolver = new LocalResolver({ secrets: w.secrets, env: w.env })
        const { started } = await client.start(name, { recipe: signInRef, resolver, onProgress: (line) => seen.push(line) }).finally(() => resolver.release())
        expect(started!.steps).toEqual([{ name: 'Sign in to the test account', result: { github: SIGNED_IN, echo: '***' } }])
        seen.push(started)
      }
    } finally {
      await served.close()
    }

    // The CLI, with --json and without, succeeding and failing.
    let out = ''
    const stream = () => {
      const pass = new PassThrough()
      pass.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))
      return pass as unknown as NodeJS.WriteStream
    }
    const io: Io = { stdout: stream(), stderr: stream(), stdin: new PassThrough() as never, env: w.env, cwd: w.dir, connect: () => connect({ engine: async () => w.engine }), secrets: w.secrets }
    expect(await main(['start', 'j1', '--recipe', SIGN_IN_RECIPE_DIR, '--json'], io)).toBe(0)
    expect(JSON.parse(out.slice(out.indexOf('{\n')))).toMatchObject({ steps: [{ result: { github: SIGNED_IN } }] })
    expect(await main(['start', 't1', '--recipe', SIGN_IN_RECIPE_DIR], io)).toBe(0)
    expect(out).toContain('signed in to the github test account (allowlisted)')
    w.guest.script = leaky(true)
    expect(await main(['start', 'f1', '--recipe', SIGN_IN_RECIPE_DIR, '--json'], io)).toBe(1)
    expect(out).toContain('"code":"step_failed"')
    expect(await main(['doctor', '--json'], io)).toBe(0)
    expect(await main(['secrets', '--json'], io)).toBe(0)
    seen.push(out, audit)

    const everything = JSON.stringify(seen)
    expect(everything).toContain('Signed in as ***')
    expect(everything).not.toContain(LOGIN)
    // Nor in anything written on this computer but the secret itself.
    await writeFile(join(w.dir, 'seen.json'), everything)
    for (const entry of await readdir(w.dir, { recursive: true, withFileTypes: true })) {
      const path = join(entry.parentPath, entry.name)
      expect(path).not.toContain(LOGIN)
      if (!entry.isFile() || path.endsWith(join('secrets', 'github.json'))) continue
      expect([path, (await readFile(path, 'utf8')).includes(LOGIN)]).toEqual([path, false])
    }
  })

  it('fails a step that signed in to another account, without naming either', async () => {
    w.guest.script = (step) => {
      askInTurn(step)
      if (step.exit === 0) step.result = { github: `${LOGIN}-other` }
    }
    let out = ''
    const pass = new PassThrough()
    pass.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))
    const io: Io = { stdout: pass as never, stderr: pass as never, stdin: new PassThrough() as never, env: w.env, cwd: w.dir, connect: () => connect({ engine: async () => w.engine }), secrets: w.secrets }
    expect(await main(['start', 't1', '--recipe', SIGN_IN_RECIPE_DIR, '--json'], io)).toBe(1)
    expect(JSON.parse(out.trim().split('\n').at(-1)!)).toMatchObject({ error: { code: 'wrong_account', message: expect.stringContaining("another account than the github secret's") } })
    expect(out).not.toContain(LOGIN)
  })
})
