import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { answerCallback, LocalResolver, type CallbackRequest, type ResolveContext } from '../src/callbacks/index.ts'
import { totp } from '../src/secrets.ts'
import { ACCOUNT, RFC_KEY, world, type World } from './world.ts'

const GUEST = fileURLToPath(new URL('../runtime/guest.py', import.meta.url))
const LIB = new URL('../runtime/lib/blobby.mjs', import.meta.url).href
const CHILD = fileURLToPath(new URL('./fixtures/signin-child.ts', import.meta.url))
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

let w: World
beforeEach(async () => {
  w = await world()
})
afterEach(() => w.cleanup())

describe('a step in the real guest runtime', () => {
  it('opens what the resolver sealed, through guest.py and blobby.mjs, and redacts it from its progress', async () => {
    const shm = join(w.dir, 'shm')
    const recipe = join(w.dir, 'recipe')
    await mkdir(shm)
    await mkdir(recipe)
    // A step as a recipe writes one, run by node from PATH instead of the sandbox's copy.
    await writeFile(join(recipe, 'step.sh'), 'exec node step.mjs\n')
    await writeFile(
      join(recipe, 'step.mjs'),
      `import { createHash } from 'node:crypto'
import { request, progress, done, run } from '${LIB}'
const hash = (text) => createHash('sha256').update(text).digest('hex')
run(async () => {
  const login = await request('github.login')
  const password = await request('github.password')
  const otp = await request('github.otp')
  progress(\`Got \${password} and \${otp}\`)
  console.log(\`Printed \${password}\`)
  process.stderr.write(Buffer.from(\`And \${otp}\\n\`))
  done({ github: login, hashes: [hash(password), hash(otp)] })
})
`,
    )
    const env = { ...process.env, BLOBBY_SHM: shm, PATH: `${dirname(process.execPath)}:${process.env.PATH}` }
    const guest = (op: string, options: object) => {
      const result = spawnSync('python3', [GUEST, op, JSON.stringify(options)], { encoding: 'utf8', env })
      const parsed = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>
      if (!parsed.ok) throw new Error(`${op} failed: ${result.stdout} ${result.stderr}`)
      return parsed
    }
    const id = 'abcdef0123456789'
    const uses = ['github.login', 'github.password', 'github.otp']
    const callbacks = { 'github.login': { sensitive: false }, 'github.password': { sensitive: true }, 'github.otp': { sensitive: true } }
    const context: ResolveContext = { sandbox: 't1', feature: 'vscode-insiders', step: { id, name: 'Sign in', uses }, callbacks }
    const resolver = new LocalResolver({ secrets: w.secrets, env: w.env })
    guest('step.start', { id, sandbox: 't1', callbacks, run: 'step.sh', cwd: recipe, sensitive: true })

    const progress: string[] = []
    let output = ''
    let outputOffset = 0
    let offset = 0
    let poll: Record<string, unknown> = {}
    const deadline = Date.now() + 20_000
    try {
      for (;;) {
        poll = guest('step.poll', { id, offset, outputOffset })
        offset = poll.offset as number
        output += poll.output as string
        outputOffset = poll.outputOffset as number
        progress.push(...(poll.progress as string[]))
        for (const request of poll.requests as Omit<CallbackRequest, 'sandbox' | 'feature' | 'step' | 'stepName'>[]) {
          const answer = await answerCallback({ ...request, sandbox: 't1', feature: 'vscode-insiders', step: id, stepName: 'Sign in' }, context, resolver)
          guest('step.answer', { id, request: request.id, answer })
        }
        if (poll.exit !== null || Date.now() > deadline) break
        await delay(100)
      }
    } finally {
      guest('step.stop', { id })
      await resolver.release()
    }
    expect(poll).toMatchObject({ exit: 0, error: null })
    expect(poll.result).toEqual({ github: ACCOUNT.login, hashes: [sha256(ACCOUNT.password), sha256(totp(RFC_KEY, w.clock.now))] })
    expect(progress).toEqual(['Got *** and ***'])
    // What the step itself prints is withheld too, before it leaves the sandbox.
    expect(output).toBe('Printed ***\nAnd ***\n')
  })
})

describe('sign-ins in two processes', () => {
  it('take turns on the account, and never use a 2FA period twice', async () => {
    const scale = 10
    // One second into a period, so the second sign-in finds its period used.
    const base = Date.UTC(2026, 0, 1, 0, 0, 1)
    const children = [0, 1].map(() => spawn(process.execPath, [CHILD, w.env.XDG_CONFIG_HOME!, String(base), String(scale), '300'], { stdio: ['pipe', 'pipe', 'inherit'] }))
    const events = children.map(() => [] as Record<string, unknown>[])
    const ready = children.map(
      (child, index) =>
        new Promise<void>((resolve) => {
          createInterface({ input: child.stdout }).on('line', (line) => {
            const event = JSON.parse(line) as Record<string, unknown>
            events[index]!.push(event)
            if (event.event === 'ready') resolve()
          })
        }),
    )
    const exited = children.map((child) => new Promise<number | null>((resolve) => child.once('exit', resolve)))
    await Promise.all(ready)
    const goAt = Date.now() + 200
    for (const child of children) child.stdin.end(`${goAt}\n`)
    expect(await Promise.all(exited)).toEqual([0, 0])

    const at = (index: number, event: string) => events[index]!.find((candidate) => candidate.event === event)!
    const [first, second] = [0, 1].sort((a, b) => (at(a, 'acquired').at as number) - (at(b, 'acquired').at as number))
    // The second took the lock only after the first let go, and waited for it, saying so.
    expect(at(second!, 'acquired').at as number).toBeGreaterThanOrEqual(at(first!, 'releasing').at as number)
    expect(events[second!]!.filter((event) => event.event === 'wait').map((event) => event.line)).toContain('Waiting for another sign-in to github to finish')
    // Its code is from a later period; when it got the lock within the first one's period, it waited for the next.
    const periods = [at(first!, 'code').period as number, at(second!, 'code').period as number]
    expect(periods[1]).toBeGreaterThan(periods[0]!)
    if (Math.floor((at(second!, 'acquired').at as number) / 30_000) === periods[0]) {
      expect(events[second!]!.map((event) => event.line)).toContainEqual(expect.stringContaining('was used already'))
    }
  }, 30_000)
})
