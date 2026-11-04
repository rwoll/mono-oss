import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  accountKey,
  answerCallback,
  authorize,
  loadAllowedLogins,
  LocalResolver,
  RedactedStream,
  Redactor,
  REDACTED,
  SignIns,
  allowlistStatus,
  type AuditEvent,
  type CallbackAnswer,
  type CallbackRequest,
  type ResolveContext,
} from '../src/callbacks/index.ts'
import { binding, seal } from '../src/callbacks/seal.ts'
import { SandboxError } from '../src/backend.ts'
import { totp } from '../src/secrets.ts'
import { guestLib } from './fake-guest.ts'
import { ACCOUNT, RFC_KEY, world, type World } from './world.ts'

const STEP = 'aaaaaaaaaaaaaaaa'
const USES = ['github.login', 'github.password', 'github.otp']
const CALLBACKS = { 'github.login': { sensitive: false }, 'github.password': { sensitive: true }, 'github.otp': { sensitive: true } }

function context(overrides: Partial<ResolveContext> = {}): ResolveContext {
  return { sandbox: 't1', feature: 'vscode-insiders', step: { id: STEP, name: 'Sign in', uses: USES }, callbacks: CALLBACKS, ...overrides }
}

type Ask = CallbackRequest & { privateKey?: KeyObject }
let next = 0
function ask(name: string, overrides: Partial<CallbackRequest> = {}): Ask {
  const sensitive = overrides.sensitive ?? CALLBACKS[name as keyof typeof CALLBACKS]?.sensitive ?? true
  const keys = generateKeyPairSync('x25519')
  const id = (++next).toString(16).padStart(16, 'b')
  return {
    sandbox: 't1',
    feature: 'vscode-insiders',
    step: STEP,
    stepName: 'Sign in',
    id,
    name,
    sensitive,
    ...(sensitive ? { publicKey: keys.publicKey.export({ format: 'jwk' }).x, privateKey: keys.privateKey } : {}),
    ...overrides,
  }
}

const open = (request: Ask, answer: CallbackAnswer) => {
  if (!('sealed' in answer)) throw new Error(`not sealed: ${JSON.stringify(answer)}`)
  return guestLib.openSealed(answer.sealed, request.privateKey!, request.publicKey!, guestLib.binding(request.sandbox, request.step, request.id, request.name))
}

describe('authorize', () => {
  it('answers only the running step, its declared callbacks, with matching sensitivity and a key', () => {
    expect(authorize(ask('github.password'), context())).toBeNull()
    expect(authorize(ask('github.password', { step: 'cccccccccccccccc' }), context())).toMatchObject({ code: 'wrong_step' })
    expect(authorize(ask('github.password', { sandbox: 't2' }), context())).toMatchObject({ code: 'wrong_step' })
    expect(authorize(ask('github.token'), context())).toMatchObject({ code: 'not_declared', error: 'This step cannot ask for github.token.' })
    expect(authorize(ask('github.password'), context({ step: { id: STEP, name: 'Sign in', uses: ['github.login'] } }))).toMatchObject({ code: 'not_declared' })
    expect(authorize(ask('github.password', { sensitive: false, publicKey: undefined }), context())).toMatchObject({ code: 'mismatch' })
    expect(authorize(ask('github.password', { publicKey: undefined }), context())).toMatchObject({ code: 'mismatch' })
  })
})

describe('answerCallback', () => {
  it('refuses before asking the resolver, checks the answer, and audits every outcome without values', async () => {
    const events: AuditEvent[] = []
    const audit = (event: AuditEvent) => events.push(event)
    const asked: string[] = []
    const resolver = {
      resolve: async (request: CallbackRequest) => {
        asked.push(request.name)
        if (request.name === 'github.otp') throw new Error('vault down')
        return request.sensitive ? { value: 'pa55-w0rd!' } : { value: 'test-account' }
      },
    }
    expect(await answerCallback(ask('github.token'), context(), resolver, audit)).toMatchObject({ code: 'not_declared' })
    expect(await answerCallback(ask('github.login'), context(), undefined, audit)).toMatchObject({ code: 'no_resolver' })
    expect(await answerCallback(ask('github.login'), context(), resolver, audit)).toEqual({ value: 'test-account' })
    expect(await answerCallback(ask('github.password'), context(), resolver, audit)).toMatchObject({ code: 'unsealed', error: expect.stringContaining('must be sealed') })
    expect(await answerCallback(ask('github.otp'), context(), resolver, audit)).toEqual({ error: 'vault down', code: 'resolver_failed' })
    expect(asked).toEqual(['github.login', 'github.password', 'github.otp'])
    expect(events.map((event) => [event.name, event.outcome, event.code])).toEqual([
      ['github.token', 'refused', 'not_declared'],
      ['github.login', 'refused', 'no_resolver'],
      ['github.login', 'answered', null],
      ['github.password', 'refused', 'unsealed'],
      ['github.otp', 'refused', 'resolver_failed'],
    ])
    expect(events[0]).toEqual({
      at: expect.stringMatching(/^\d{4}-/),
      sandbox: 't1',
      feature: 'vscode-insiders',
      step: STEP,
      stepName: 'Sign in',
      request: expect.any(String),
      name: 'github.token',
      binding: null,
      outcome: 'refused',
      code: 'not_declared',
      sealed: false,
    })
    expect(JSON.stringify(events)).not.toContain('pa55')
    expect(JSON.stringify(events)).not.toContain('test-account')
  })
})

describe('RedactedStream', () => {
  const redactor = new Redactor().add('pa55-w0rd!')
  const sent = (chunks: string[]) => {
    const stream = new RedactedStream((text) => redactor.text(text))
    return [...chunks.map((chunk) => stream.push(chunk)), stream.flush()]
  }

  it('sends whole lines, so a value split across chunks is redacted whole', () => {
    expect(sent(['one pa5', '5-w0r', 'd! two\nthree'])).toEqual(['', '', 'one *** two\n', 'three'])
  })

  it('sends a long line as it comes, keeping back enough to complete a value', () => {
    const chunks = sent(['x'.repeat(5000) + 'pa55-', 'w0rd! end'])
    expect(chunks[0]).toBe('x'.repeat(5000 + 5 - 1024))
    expect(chunks.join('')).toBe(`${'x'.repeat(5000)}*** end`)
  })
})

describe('Redactor', () => {
  it('redacts values in their common forms, and codes in groups', () => {
    const redactor = new Redactor().add('pa55 w0rd"!', '123456', 'abc', undefined)
    expect(redactor.size).toBe(2)
    const text = `a pa55 w0rd"! b pa55w0rd"! c ${JSON.stringify('pa55 w0rd"!')} d ${encodeURIComponent('pa55 w0rd"!')} e 123 456 f 123456 g abc`
    expect(redactor.text(text)).toBe(`a ${REDACTED} b ${REDACTED} c "${REDACTED}" d ${REDACTED} e ${REDACTED} f ${REDACTED} g abc`)
  })

  it('redacts JSON, keys included, and errors, keeping their codes', () => {
    const redactor = new Redactor().add('pa55-w0rd!')
    expect(redactor.json({ a: ['x pa55-w0rd!'], 'pa55-w0rd!': 1, n: 7, nested: { ok: true, value: 'pa55-w0rd!' } })).toEqual({
      a: [`x ${REDACTED}`],
      [REDACTED]: 1,
      n: 7,
      nested: { ok: true, value: REDACTED },
    })
    const error = redactor.error(new SandboxError('step_failed', 'it said pa55-w0rd!'))
    expect(error).toBeInstanceOf(SandboxError)
    expect(error).toMatchObject({ code: 'step_failed', message: `it said ${REDACTED}` })
    expect(redactor.error(new Error('pa55-w0rd!')).message).toBe(REDACTED)
  })
})

describe('sealing', () => {
  it('opens with the guest runtime, only for the request it was bound to', () => {
    const request = ask('github.password')
    const sealed = seal('pa55-w0rd!', request.publicKey!, binding(request.sandbox, request.step, request.id, request.name))
    expect(binding('t1', STEP, 'r', 'n')).toBe(guestLib.binding('t1', STEP, 'r', 'n'))
    expect(open(request, { sealed })).toBe('pa55-w0rd!')
    for (const bound of [binding('t2', request.step, request.id, request.name), binding('t1', 'cccccccccccccccc', request.id, request.name), binding('t1', request.step, 'other', request.name), binding('t1', request.step, request.id, 'github.otp')]) {
      expect(() => guestLib.openSealed(sealed, request.privateKey!, request.publicKey!, bound)).toThrow()
    }
    expect(() => seal('x', 'not-a-key', 'b')).toThrow(expect.objectContaining({ code: 'invalid_key' }))
  })
})

describe('LocalResolver', () => {
  let w: World
  beforeEach(async () => {
    w = await world()
  })
  afterEach(() => w.cleanup())

  const resolver = (options: ConstructorParameters<typeof LocalResolver>[0] = {}) => new LocalResolver({ secrets: w.secrets, env: w.env, ...options })

  it('answers identifiers in the clear, seals the rest, and remembers what to redact', async () => {
    const local = resolver()
    expect(await local.resolve(ask('github.login'), context())).toEqual({ value: 'test-account' })
    const password = ask('github.password')
    const answer = await local.resolve(password, context())
    expect(JSON.stringify(answer)).not.toContain(ACCOUNT.password)
    expect(open(password, answer)).toBe(ACCOUNT.password)
    const otp = ask('github.otp')
    const code = open(otp, await local.resolve(otp, context()))
    expect(code).toBe(totp(RFC_KEY, w.clock.now))
    expect(local.redactor.text(`${ACCOUNT.password} ${RFC_KEY} ${code} test-account`)).toBe(`${REDACTED} ${REDACTED} ${REDACTED} ${REDACTED}`)
    await local.release()
  })

  it('refuses with stable codes, and never sends a 2FA key', async () => {
    const local = resolver()
    const uses = [...USES, 'github.totpSecret', 'github.token', 'npm.token', 'github.email']
    const callbacks = { ...CALLBACKS, 'github.totpSecret': { sensitive: true }, 'github.token': { sensitive: true }, 'npm.token': { sensitive: true }, 'github.email': { sensitive: false } }
    const wide = context({ step: { id: STEP, name: 'Sign in', uses }, callbacks })
    expect(await local.resolve(ask('github.token', { sensitive: true }), context())).toMatchObject({ code: 'not_declared' })
    expect(await local.resolve(ask('github.totpSecret'), wide)).toMatchObject({ code: 'forbidden', error: expect.stringContaining('never sends a 2FA key') })
    expect(await local.resolve(ask('github.token'), wide)).toMatchObject({ code: 'no_field', error: 'The github secret has no token.' })
    expect(await local.resolve(ask('github.email', { sensitive: false }), wide)).toMatchObject({ code: 'no_field' })
    expect(await local.resolve(ask('npm.token'), wide)).toMatchObject({ code: 'no_binding', error: expect.stringContaining('blobby-sandbox secrets set npm') })
    const clear = context({ callbacks: { ...CALLBACKS, 'github.password': { sensitive: false } } })
    expect(await local.resolve(ask('github.password', { sensitive: false, publicKey: undefined }), clear)).toMatchObject({ code: 'not_sensitive' })
    expect(await local.resolve(ask('github.password', { publicKey: 'not-a-key' }), context())).toMatchObject({ code: 'invalid_key' })
    await local.release()
  })

  it('reads a failing provider as a binding that failed, without its output', async () => {
    const script = join(w.dir, 'provider.sh')
    await writeFile(script, "#!/bin/sh\necho 'pa55-w0rd! leaked' >&2\nexit 3\n", { mode: 0o755 })
    await w.secrets.setProvider('github', [script])
    const answer = await resolver().resolve(ask('github.login'), context())
    expect(answer).toMatchObject({ code: 'binding_failed' })
    expect(JSON.stringify(answer)).not.toContain('pa55')
  })

  it('uses the binding the controller names, then its own bindings, then the namespace', async () => {
    await w.secrets.setFile('github-test', { ...ACCOUNT, password: 'other-pa55' })
    const named = resolver()
    const password = ask('github.password')
    expect(open(password, await named.resolve(password, context({ binding: 'github-test' })))).toBe('other-pa55')
    expect(await named.resolve(ask('github.login'), context({ binding: 'missing' }))).toMatchObject({ code: 'no_binding' })
    await named.release()
    const bound = resolver({ bindings: { github: 'github-test' } })
    const again = ask('github.password')
    expect(open(again, await bound.resolve(again, context()))).toBe('other-pa55')
    await bound.release()
  })

  it('refuses every secret unless its login is allowed, failing closed', async () => {
    const env = { ...w.env, BLOBBY_SANDBOX_ALLOWED_LOGINS: '' }
    expect(await resolver({ env }).resolve(ask('github.login'), context())).toMatchObject({ code: 'login_not_allowed', error: expect.stringContaining('allowedLogins') })
    expect(await resolver({ allowedLogins: ['someone-else'] }).resolve(ask('github.password'), context())).toMatchObject({ code: 'login_not_allowed' })
    const allowed = resolver({ allowedLogins: ['TEST-ACCOUNT'] })
    expect(await allowed.resolve(ask('github.login'), context())).toEqual({ value: 'test-account' })
    await allowed.release()
    await w.secrets.setFile('github', { password: 'pa55-w0rd!' })
    expect(await resolver().resolve(ask('github.password'), context())).toMatchObject({ code: 'login_not_allowed', error: expect.stringContaining('has no login') })
  })

  it('holds secrets of other services to the same allowlist', async () => {
    await w.secrets.setFile('npm', { login: 'npm-bot', token: 'npm_t0ken-value' })
    const callbacks = { ...CALLBACKS, 'npm.login': { sensitive: false }, 'npm.token': { sensitive: true } }
    const npm = context({ step: { id: STEP, name: 'Publish', uses: ['npm.login', 'npm.token'] }, callbacks })
    expect(await resolver().resolve(ask('npm.token'), npm)).toMatchObject({ code: 'login_not_allowed' })
    await expect(resolver().checkSecret('npm')).rejects.toMatchObject({ code: 'login_not_allowed', message: expect.not.stringContaining('npm-bot') })
    const allowed = resolver({ allowedLogins: ['test-account', 'npm-bot'] })
    await allowed.checkSecret('npm')
    const token = ask('npm.token')
    expect(open(token, await allowed.resolve(token, npm))).toBe('npm_t0ken-value')
    await allowed.release()
    await expect(resolver().checkSecret('github')).resolves.toBeUndefined()
    await expect(resolver({ env: { ...w.env, BLOBBY_SANDBOX_ALLOWED_LOGINS: '' } }).checkSecret('github')).rejects.toMatchObject({ code: 'login_not_allowed' })
    await expect(resolver().checkSecret('missing')).rejects.toMatchObject({ code: 'no_secret' })
  })

  it('checks the accounts steps claim, and shows them only as signed in, never by login', async () => {
    // Only the namespaces of the step's callbacks are account claims; other values pass through.
    expect(await resolver().checkResult({ github: 'TEST-ACCOUNT', build: '1.2.3' }, context())).toEqual({ github: { signedIn: true, verified: true }, build: '1.2.3' })
    const wrong = await resolver().checkResult({ github: 'someone-else' }, context()).catch((error: Error) => error)
    expect(wrong).toMatchObject({ code: 'wrong_account' })
    expect((wrong as Error).message).not.toMatch(/someone-else|test-account/)
    const denied = await resolver({ allowedLogins: ['someone-else'] }).checkResult({ github: 'test-account' }, context()).catch((error: Error) => error)
    expect(denied).toMatchObject({ code: 'login_not_allowed' })
    expect((denied as Error).message).not.toMatch(/someone-else|test-account/)
  })

  it('gives each 2FA code out once, waits for the next period, and says so', async () => {
    const local = resolver()
    const progress: string[] = []
    const first = ask('github.otp')
    const start = w.clock.now
    expect(open(first, await local.resolve(first, context({ progress: (line) => progress.push(line) })))).toBe(totp(RFC_KEY, start))
    const second = ask('github.otp')
    expect(open(second, await local.resolve(second, context({ progress: (line) => progress.push(line) })))).toBe(totp(RFC_KEY, start + 30_000))
    expect(progress).toEqual([expect.stringMatching(/^The current 2FA code of github was used already, and GitHub accepts each code once; waiting \d+ seconds for the next one$/)])
    // Another resolver, as another process would be, doesn't reuse it either.
    await local.release()
    const other = new LocalResolver({ env: w.env, secrets: w.secrets })
    const third = ask('github.otp', { step: 'dddddddddddddddd' })
    expect(open(third, await other.resolve(third, context({ step: { id: 'dddddddddddddddd', name: 'Sign in', uses: USES } })))).toBe(totp(RFC_KEY, start + 60_000))
    await other.release()
  })

  it('holds the account for the whole step, so another sign-in of it waits', async () => {
    const local = resolver()
    const progress: string[] = []
    const one = context()
    const two = context({ sandbox: 't2', step: { id: 'eeeeeeeeeeeeeeee', name: 'Sign in', uses: USES }, progress: (line) => progress.push(line) })
    let releasedFirst = false
    const first = local.step(one, async () => {
      expect(await local.resolve(ask('github.login'), one)).toEqual({ value: 'test-account' })
      await new Promise((resolve) => setTimeout(resolve, 700))
      releasedFirst = true
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const second = local.step(two, async () => {
      const answer = await local.resolve(ask('github.login', { sandbox: 't2', step: 'eeeeeeeeeeeeeeee' }), two)
      expect(releasedFirst).toBe(true)
      return answer
    })
    await first
    expect(await second).toEqual({ value: 'test-account' })
    expect(progress).toContain('Waiting for another sign-in to github to finish')
    // Both steps ended, so neither holds the lock.
    await expect(stat(join(w.env.XDG_CONFIG_HOME!, 'blobby', 'signins', `${accountKey('github', 'test-account')}.lock`))).rejects.toThrow()
  })

  it('refuses with busy when another sign-in holds the account too long', async () => {
    const holder = await w.secrets.signIns.acquire(accountKey('github', 'test-account'), 'github')
    try {
      expect(await resolver({ lockTimeoutMs: 0 }).resolve(ask('github.login'), context())).toMatchObject({ code: 'busy' })
    } finally {
      await holder()
    }
  })
})

describe('allowed logins', () => {
  let w: World
  beforeEach(async () => {
    w = await world()
  })
  afterEach(() => w.cleanup())

  it('come from the environment, else config.json, else none', async () => {
    const env = { ...w.env, BLOBBY_SANDBOX_ALLOWED_LOGINS: undefined }
    expect(await loadAllowedLogins(env)).toEqual({ logins: [], source: 'none' })
    const config = join(w.env.XDG_CONFIG_HOME!, 'blobby', 'config.json')
    await mkdir(join(w.env.XDG_CONFIG_HOME!, 'blobby'), { recursive: true })
    await writeFile(config, JSON.stringify({ allowedLogins: ['Test-Account', ' other '] }))
    expect(await loadAllowedLogins(env)).toEqual({ logins: ['test-account', 'other'], source: 'config' })
    expect(await loadAllowedLogins({ ...env, BLOBBY_SANDBOX_ALLOWED_LOGINS: 'a, b' })).toEqual({ logins: ['a', 'b'], source: 'env' })
    await writeFile(config, JSON.stringify({ allowedLogins: 'test-account' }))
    await expect(loadAllowedLogins(env)).rejects.toMatchObject({ code: 'invalid_config' })
    await writeFile(config, '{')
    await expect(loadAllowedLogins(env)).rejects.toMatchObject({ code: 'invalid_config' })
  })

  it('are checked by doctor against every secret, without naming logins', async () => {
    expect(await allowlistStatus(w.secrets, w.env)).toEqual({ allowedLogins: 1, source: 'env', problem: null })
    expect(await allowlistStatus(w.secrets, { ...w.env, BLOBBY_SANDBOX_ALLOWED_LOGINS: '' })).toMatchObject({ allowedLogins: 0, problem: expect.stringContaining('allowedLogins') })
    const other = await allowlistStatus(w.secrets, { ...w.env, BLOBBY_SANDBOX_ALLOWED_LOGINS: 'someone-else' })
    expect(other.problem).toContain("The github secret's login is not in allowedLogins")
    expect(other.problem).not.toContain('test-account')
    await w.secrets.setFile('npm', { token: 'npm_t0ken-value' })
    expect((await allowlistStatus(w.secrets, w.env)).problem).toContain('The npm secret has no login')
  })
})

describe('SignIns', () => {
  let w: World
  beforeEach(async () => {
    w = await world()
  })
  afterEach(() => w.cleanup())

  it('keeps its lock and record private in the config folder', async () => {
    const signIns = new SignIns({ env: w.env, now: () => w.clock.now, sleep: async (ms) => void (w.clock.now += ms) })
    await signIns.hold('login-test-account', 'github', async () => {
      await signIns.nextCode('login-test-account', RFC_KEY, 'github')
      const dir = join(w.env.XDG_CONFIG_HOME!, 'blobby', 'signins')
      expect((await stat(dir)).mode & 0o777).toBe(0o700)
      expect((await stat(join(dir, 'login-test-account.lock'))).mode & 0o777).toBe(0o700)
      expect((await stat(join(dir, 'login-test-account.lock', 'pid'))).mode & 0o777).toBe(0o600)
      expect((await stat(join(dir, 'login-test-account.json'))).mode & 0o777).toBe(0o600)
      expect(JSON.parse(await readFile(join(dir, 'login-test-account.json'), 'utf8'))).toEqual({ lastPeriod: Math.floor(w.clock.now / 30_000) })
    })
    expect(await signIns.lastPeriod('login-test-account')).toBe(Math.floor(w.clock.now / 30_000))
  })

  it('waits when the period has less than 5 seconds left', async () => {
    w.clock.now = Date.UTC(2026, 0, 1, 0, 0, 27)
    const lines: string[] = []
    const signIns = new SignIns({ env: w.env, now: () => w.clock.now, sleep: async (ms) => void (w.clock.now += ms) })
    expect(await signIns.nextCode('secret-github', RFC_KEY, 'github', { onWait: (line) => lines.push(line) })).toBe(totp(RFC_KEY, Date.UTC(2026, 0, 1, 0, 0, 30)))
    expect(lines).toEqual([expect.stringMatching(/^The current 2FA code of github expires in 3 seconds; waiting 4 seconds for the next one$/)])
  })

  it('rejects account keys that could name other files', async () => {
    const signIns = new SignIns({ env: w.env })
    await expect(signIns.acquire('../x', 'github')).rejects.toMatchObject({ code: 'usage' })
    await expect(signIns.lastPeriod('a/b')).rejects.toMatchObject({ code: 'usage' })
  })

  it('reads a damaged record as none, and replaces it', async () => {
    const signIns = new SignIns({ env: w.env, now: () => w.clock.now })
    await mkdir(signIns.dir, { recursive: true })
    await writeFile(join(signIns.dir, 'secret-github.json'), 'oops')
    await chmod(join(signIns.dir, 'secret-github.json'), 0o644)
    expect(await signIns.lastPeriod('secret-github')).toBeNull()
    await signIns.nextCode('secret-github', RFC_KEY, 'github')
    expect((await stat(join(signIns.dir, 'secret-github.json'))).mode & 0o777).toBe(0o600)
  })
})
