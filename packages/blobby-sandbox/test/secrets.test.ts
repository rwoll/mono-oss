import { generateKeyPairSync } from 'node:crypto'
import { chmod, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CallbackRequest } from '../src/sandboxes.ts'
import { binding } from '../src/seal.ts'
import { decodeBase32, normalizeSecret, redact, Secrets, totp } from '../src/secrets.ts'
import { guestLib } from './fake-guest.ts'
import { ACCOUNT, RFC_KEY, world, type World } from './world.ts'

describe('totp', () => {
  it.each([
    [59, '94287082'],
    [1_111_111_109, '07081804'],
    [1_234_567_890, '89005924'],
    [2_000_000_000, '69279037'],
  ])('matches the RFC 6238 vector at T=%i', (seconds, code) => {
    expect(totp(RFC_KEY, seconds * 1000, 8)).toBe(code)
    expect(totp(RFC_KEY, seconds * 1000)).toBe(code.slice(2))
  })

  it('accepts keys in lowercase, with spaces and padding, and rejects others', () => {
    expect(decodeBase32('gezd gnbv gy3t qojq gezd gnbv gy3t qojq==').toString()).toBe('12345678901234567890')
    expect(() => decodeBase32('not base32!')).toThrow(expect.objectContaining({ code: 'invalid_totp_key' }))
  })
})

describe('normalizeSecret', () => {
  it('reads common provider formats, such as username and totp_key, and otpauth URIs', () => {
    expect(normalizeSecret({ username: 'a', password: 'p', totp_key: RFC_KEY })).toEqual({ login: 'a', password: 'p', totpSecret: RFC_KEY })
    expect(normalizeSecret({ login: 'a', password: 'p', totpSecret: `otpauth://totp/GitHub:a?secret=${RFC_KEY}&issuer=GitHub` })).toMatchObject({ totpSecret: RFC_KEY })
    expect(normalizeSecret({ token: 't' })).toEqual({ token: 't' })
  })

  it('never quotes a value in its errors', () => {
    for (const bad of [{ password: 7 }, { login: 'no spaces', password: 'pa55-w0rd!' }, { totpSecret: 'pa55-w0rd!' }]) {
      const message = (() => {
        try {
          normalizeSecret(bad)
          return ''
        } catch (error) {
          return (error as Error).message
        }
      })()
      expect(message).not.toBe('')
      expect(message).not.toContain('pa55')
    }
  })

  it('redacts everything but identifiers', () => {
    expect(redact(`test-account pa55-w0rd! ${RFC_KEY}`, ACCOUNT)).toBe('test-account *** ***')
  })
})

describe('Secrets', () => {
  let w: World
  beforeEach(async () => {
    w = await world({ secret: false })
  })
  afterEach(() => w.cleanup())

  const configDir = () => join(w.env.XDG_CONFIG_HOME!, 'blobby')
  const request = (name: string, sensitive: boolean): CallbackRequest & { privateKey?: ReturnType<typeof generateKeyPairSync>['privateKey'] } => {
    const keys = generateKeyPairSync('x25519')
    return { sandbox: 't1', feature: 'vscode-insiders', step: 'aaaaaaaaaaaaaaaa', stepName: 'Sign in', id: 'bbbbbbbbbbbbbbbb', name, sensitive, ...(sensitive ? { publicKey: keys.publicKey.export({ format: 'jwk' }).x, privateKey: keys.privateKey } : {}) }
  }
  const open = (ask: ReturnType<typeof request>, answer: unknown) =>
    guestLib.openSealed((answer as { sealed: unknown }).sealed, ask.privateKey!, ask.publicKey!, binding(ask.sandbox, ask.step, ask.id, ask.name))

  it('saves file secrets that only you can read, and lists them', async () => {
    await w.secrets.setFile('github', ACCOUNT)
    const file = join(configDir(), 'secrets', 'github.json')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await stat(join(configDir(), 'secrets'))).mode & 0o777).toBe(0o700)
    expect(await w.secrets.list()).toEqual([{ name: 'github', source: 'file', detail: expect.stringContaining('github.json'), problem: null }])
    expect(await w.secrets.remove('github')).toBe(true)
    expect(await w.secrets.list()).toEqual([])
  })

  it('refuses a file other users can read', async () => {
    await w.secrets.setFile('github', ACCOUNT)
    await chmod(join(configDir(), 'secrets', 'github.json'), 0o644)
    const fresh = new Secrets({ env: w.env })
    await expect(fresh.resolve('github')).rejects.toThrow(/chmod 600/)
  })

  it('runs a provider for each new client, and never shows its output when it fails', async () => {
    const script = join(w.dir, 'provider.sh')
    await writeFile(script, `#!/bin/sh\necho '${JSON.stringify(ACCOUNT)}'\n`, { mode: 0o755 })
    await w.secrets.setProvider('github', [script])
    expect(JSON.parse(await readFile(join(configDir(), 'secrets.json'), 'utf8'))).toEqual({ providers: { github: [script] }, paths: {} })
    expect(await new Secrets({ env: w.env }).resolve('github')).toEqual(ACCOUNT)
    expect(await new Secrets({ env: w.env }).list()).toEqual([{ name: 'github', source: 'provider', detail: script, problem: null }])
    expect(await new Secrets({ env: w.env }).list({ check: true })).toEqual([{ name: 'github', source: 'provider', detail: script, problem: null }])

    await writeFile(script, `#!/bin/sh\necho 'pa55-w0rd! is wrong' >&2\nexit 3\n`, { mode: 0o755 })
    const error = await new Secrets({ env: w.env }).resolve('github').catch((caught: Error) => caught)
    expect(error).toMatchObject({ code: 'provider_failed' })
    expect((error as Error).message).not.toContain('pa55')
  })

  it('answers identifiers in the clear and seals everything else to the request\'s key', async () => {
    await w.secrets.setFile('github', ACCOUNT)
    expect(await w.secrets.answer(request('github.login', false))).toEqual({ value: 'test-account' })
    const ask = request('github.password', true)
    const answer = await w.secrets.answer(ask)
    expect(JSON.stringify(answer)).not.toContain(ACCOUNT.password)
    expect(open(ask, answer)).toBe(ACCOUNT.password)
    // A sealed answer opens only for the request it was made for.
    expect(() => guestLib.openSealed((answer as { sealed: unknown }).sealed, ask.privateKey!, ask.publicKey!, binding('t2', ask.step, ask.id, ask.name))).toThrow()
    expect(await w.secrets.answer(request('github.password', false))).toEqual({ error: expect.stringContaining('Mark github.password sensitive') })
    expect(await w.secrets.answer(request('github.token', true))).toEqual({ error: 'The github secret has no token.' })
    for (const name of ['github.totpSecret', 'github.totp_key', 'github.totp']) {
      expect(await w.secrets.answer(request(name, true))).toEqual({ error: expect.stringContaining('never sends a 2FA key') })
    }
    expect(await w.secrets.answer(request('npm.token', true))).toEqual({ error: expect.stringContaining('There is no npm secret') })
  })

  it('gives out each 2FA code from a later period than the last, so sign-ins take turns', async () => {
    await w.secrets.setFile('github', ACCOUNT)
    const first = request('github.otp', true)
    const second = request('github.otp', true)
    const start = w.clock.now
    expect(open(first, await w.secrets.answer(first))).toBe(totp(RFC_KEY, start))
    expect(open(second, await w.secrets.answer(second))).toBe(totp(RFC_KEY, start + 30_000))
    expect(w.clock.now - start).toBeGreaterThanOrEqual(29_000)
  })

  it('checks that steps signed in the secret\'s account', async () => {
    await w.secrets.setFile('github', ACCOUNT)
    await expect(w.secrets.verify([{ name: 'Sign in', result: { github: 'TEST-ACCOUNT' } }])).resolves.toBeUndefined()
    await expect(w.secrets.verify([{ name: 'Sign in', result: { github: 'someone-else' } }])).rejects.toMatchObject({ code: 'wrong_account' })
  })
})
