import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { LocalResolver, type AuditEvent } from '../src/callbacks/index.ts'
import { main, type Io } from '../src/cli.ts'
import { connect } from '../src/client.ts'
import { askInTurn, type FakeStep } from './fake-guest.ts'
import { SIGN_IN_RECIPE_DIR, signInRecipe, world, type World } from './world.ts'

// Parent plan's canary rule: a fake provider returns unique canary values, a full sign-in runs through
// the engine and the CLI, and a step leaks everything it got. None of it may show up anywhere outside
// the sandbox's sealed answers.

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const canary = (label: string) => `CANARY-${label}-${randomBytes(12).toString('hex')}`
const PASSWORD = canary('password')
const TOKEN = canary('token')
const SEED = [...randomBytes(32)].map((byte) => BASE32[byte % 32]).join('')

class Output extends PassThrough {
  text = ''
  isTTY = false
  constructor() {
    super()
    this.on('data', (chunk: Buffer) => (this.text += chunk.toString('utf8')))
  }
}

/** A step that gets every value, then prints them, returns them, or fails with them. */
const leaky = (fail: boolean) => (step: FakeStep) => {
  askInTurn(step)
  if (step.exit === null) return
  const got = Object.fromEntries([...step.values].map(([name, value]) => [name, 'value' in value ? value.value : value.error]))
  const password = got['github.password']!
  const otp = got['github.otp']!
  step.progress.push(`leaking ${password} and ${otp}`, JSON.stringify(got), encodeURIComponent(password), `code ${otp.slice(0, 3)} ${otp.slice(3)}`)
  if (fail) {
    step.exit = 1
    step.error = `failed with ${password} and ${otp}`
    step.result = null
  } else step.result = { github: got['github.login'], echo: password, nested: { otp, [password]: otp } }
}

let w: World
let provider: string
beforeEach(async () => {
  w = await world({ secret: false })
  provider = join(w.dir, 'provider', 'github.sh')
  await mkdir(join(w.dir, 'provider'))
  const secret = { login: 'test-account', password: PASSWORD, totpSecret: SEED, token: TOKEN }
  await writeFile(provider, `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(secret)}\nEOF\n`, { mode: 0o755 })
  await w.secrets.setProvider('github', [provider])
})
afterEach(() => w.cleanup())

/** Every file under `dir`, but the provider, which is where the canaries come from. */
async function writtenFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).filter((path) => path !== provider)
}

it('never shows a secret value, or a 2FA code made from one, outside sealed answers', async () => {
  const seen: string[] = []
  const audit: AuditEvent[] = []
  const errors: string[] = []

  // The engine, in process, with a resolver: a step that leaks what it got, and one that fails with it.
  for (const [sandbox, fail] of [['e1', false], ['e2', true]] as const) {
    w.guest.script = leaky(fail)
    const resolver = new LocalResolver({ secrets: w.secrets, env: w.env })
    const started = await w.engine
      .start(sandbox, { recipe: signInRecipe, resolver, onProgress: (line) => seen.push(line), onAudit: (event) => audit.push(event) })
      .then((result) => JSON.stringify(result), (error: Error) => (errors.push(`${(error as { code?: string }).code}: ${error.message}`), ''))
    seen.push(started)
  }
  expect(errors).toEqual([expect.stringMatching(/^step_failed: .*failed with \*\*\* and \*\*\*/)])
  expect(seen.join('\n')).toContain('"echo":"***"')

  // The CLI, with --json, through the client, both ways.
  const stdout = new Output()
  const stderr = new Output()
  const io: Io = {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: new PassThrough() as unknown as NodeJS.ReadStream,
    env: w.env,
    cwd: w.dir,
    connect: () => connect({ engine: async () => w.engine }),
    secrets: w.secrets,
  }
  w.guest.script = leaky(false)
  expect(await main(['start', 'c1', '--recipe', SIGN_IN_RECIPE_DIR, '--json'], io)).toBe(0)
  expect(JSON.parse(stdout.text)).toMatchObject({ steps: [{ result: { github: { signedIn: true, verified: true }, echo: '***' } }] })
  w.guest.script = leaky(true)
  expect(await main(['start', 'c2', '--recipe', SIGN_IN_RECIPE_DIR, '--json'], io)).toBe(1)
  expect(JSON.parse(stderr.text.trim().split('\n').at(-1)!)).toMatchObject({ error: { code: 'step_failed' } })
  expect(await main(['doctor', '--json'], io)).toBe(0)
  seen.push(stdout.text, stderr.text)

  // What the steps opened: the canaries, and the codes the resolver made from the seed.
  const opened = [...w.guest.steps.values()].flatMap((step) => [...step.values.values()].flatMap((value) => ('value' in value ? [value.value] : [])))
  const codes = opened.filter((value) => /^\d{6}$/.test(value))
  expect(codes.length).toBe(4)
  expect(opened).toContain(PASSWORD)
  const secrets = [PASSWORD, TOKEN, SEED, ...codes]

  // The test's own log of everything, written like a tool would.
  const out = join(w.dir, 'out')
  await mkdir(out)
  await writeFile(join(out, 'progress.log'), seen.join('\n'))
  await writeFile(join(out, 'audit.json'), JSON.stringify(audit, null, 2))
  await writeFile(join(out, 'errors.log'), errors.join('\n'))

  const leaks = (text: string, values: string[]) => values.filter((value) => text.includes(value) || text.includes(`${value.slice(0, 3)} ${value.slice(3)}`))
  expect(leaks([...seen, ...errors, JSON.stringify(audit)].join('\n'), secrets)).toEqual([])
  for (const file of await writtenFiles(w.dir)) expect([file, leaks(await readFile(file, 'utf8'), secrets)]).toEqual([file, []])
  // Inside the sandboxes, only sealed answers crossed: no file and no answer on the wire holds a canary.
  for (const machine of w.backend.machines.values()) {
    for (const [path, file] of machine.files) expect([path, leaks(file.data.toString('utf8'), [PASSWORD, TOKEN, SEED])]).toEqual([path, []])
  }
  for (const step of w.guest.steps.values()) expect(leaks(JSON.stringify(step.raw), secrets)).toEqual([])
  expect(audit.length).toBeGreaterThanOrEqual(6)
  expect(audit.every((event) => event.outcome === 'answered')).toBe(true)
})
