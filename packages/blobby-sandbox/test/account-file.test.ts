import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_FILE_MAX_BYTES, readAccountFile } from '../src/account-file.ts'
import { LocalResolver } from '../src/callbacks/index.ts'
import { main, type Io } from '../src/cli.ts'
import { connect } from '../src/client.ts'
import { Secrets } from '../src/secrets.ts'
import { runCommand } from './fake-guest.ts'
import { RFC_KEY, world, type World } from './world.ts'

// The test account comes from the file the user already keeps, by path. Only the
// path is saved, and no check ever prints what is in the file.

const PASSWORD = `canary-password-${randomBytes(12).toString('hex')}`
const account = (overrides: Record<string, unknown> = {}) => JSON.stringify({ username: 'test-account', password: PASSWORD, totp_key: RFC_KEY, ...overrides })

let w: World
let file: string
beforeEach(async () => {
  w = await world({ secret: false })
  await mkdir(join(w.dir, 'accounts'))
  file = join(w.dir, 'accounts', 'github-test.json')
  await writeFile(file, account(), { mode: 0o600 })
})
afterEach(() => {
  vi.restoreAllMocks()
  return w.cleanup()
})

const problem = (path = file) => readAccountFile(path).then(() => null, (error: Error & { code: string }) => error)

describe('readAccountFile', () => {
  it('reads username, password, and totp_key from your own private file', async () => {
    expect(await readAccountFile(file)).toEqual({ login: 'test-account', password: PASSWORD, totpSecret: RFC_KEY })
    await chmod(file, 0o400)
    expect(await readAccountFile(file)).toMatchObject({ login: 'test-account' })
    expect(await readAccountFile(file, { contents: false })).toBeNull()
  })

  it('refuses files others can read or change, or that aren\'t yours, without quoting them', async () => {
    for (const mode of [0o644, 0o640, 0o604, 0o620, 0o602]) {
      await chmod(file, mode)
      expect(await problem()).toMatchObject({ code: 'invalid_secret', message: expect.stringContaining(`chmod 600`) })
    }
    await chmod(file, 0o600)
    vi.spyOn(process, 'getuid').mockReturnValue(process.getuid!() + 1)
    expect(await problem()).toMatchObject({ code: 'invalid_secret', message: expect.stringContaining('must belong to you') })
  })

  it('refuses what isn\'t an account file: too large, not JSON, missing fields, not base32, not a file, or missing', async () => {
    const cases: [string | null, RegExp][] = [
      [`${account()}${' '.repeat(ACCOUNT_FILE_MAX_BYTES)}`, /larger than 4096 bytes/],
      [`{"username": "test-account", "password": "${PASSWORD}"`, /is not valid JSON/],
      [account({ totp_key: undefined }), /needs text username, password, and totp_key/],
      [account({ password: 7 }), /needs text username, password, and totp_key/],
      [account({ username: `${PASSWORD} x` }), /username .* is not a GitHub username/],
      [account({ totp_key: `${PASSWORD}!` }), /totp_key .* is not base32/],
    ]
    for (const [contents, message] of cases) {
      await writeFile(file, contents!, { mode: 0o600 })
      const error = await problem()
      expect(error).toMatchObject({ code: 'invalid_secret', message: expect.stringMatching(message) })
      expect(error!.message).not.toContain(PASSWORD)
      expect(error!.message).not.toContain('pa55')
    }
    expect(await problem(join(w.dir, 'accounts'))).toMatchObject({ message: expect.stringContaining('not a regular file') })
    expect(await problem(join(w.dir, 'missing.json'))).toMatchObject({ message: expect.stringContaining('is missing') })
    const fifo = join(w.dir, 'accounts', 'fifo')
    if (spawnSync('mkfifo', ['-m', '600', fifo]).status === 0) expect(await problem(fifo)).toMatchObject({ message: expect.stringContaining('not a regular file') })
  })
})

describe('Secrets with an account file', () => {
  it('saves only the path, reads the file each time, and lists its status without values or logins', async () => {
    await w.secrets.setPath('github', file)
    const config = join(w.env.XDG_CONFIG_HOME!, 'blobby')
    expect(JSON.parse(await readFile(join(config, 'secrets.json'), 'utf8'))).toEqual({ providers: {}, paths: { github: file } })
    const saved = await readdir(config, { recursive: true })
    for (const entry of saved) expect(await readFile(join(config, entry), 'utf8').catch(() => '')).not.toContain(PASSWORD)
    expect(await new Secrets({ env: w.env }).resolve('github')).toEqual({ login: 'test-account', password: PASSWORD, totpSecret: RFC_KEY })
    expect(await w.secrets.list()).toEqual([{ name: 'github', source: 'path', detail: file, problem: null }])

    await chmod(file, 0o644)
    const listed = await new Secrets({ env: w.env }).list()
    expect(listed).toEqual([{ name: 'github', source: 'path', detail: file, problem: expect.stringContaining('chmod 600') }])
    await chmod(file, 0o600)
    await writeFile(file, '{not json', { mode: 0o600 })
    // Without check, the file is checked but not read; with it, it is read too.
    expect(await new Secrets({ env: w.env }).list()).toEqual([expect.objectContaining({ problem: null })])
    expect(await new Secrets({ env: w.env }).list({ check: true })).toEqual([expect.objectContaining({ problem: expect.stringContaining('not valid JSON') })])

    expect(await w.secrets.remove('github')).toBe(true)
    expect(await w.secrets.list()).toEqual([])
    // Forgetting the path leaves the file where it is.
    expect(await readFile(file, 'utf8')).toContain('{not json')
  })

  it('refuses a bad file when it is set, and replaces other sources of that name', async () => {
    await chmod(file, 0o644)
    await expect(w.secrets.setPath('github', file)).rejects.toMatchObject({ code: 'invalid_secret' })
    await expect(w.secrets.setPath('github', 'relative.json')).rejects.toMatchObject({ code: 'usage' })
    await chmod(file, 0o600)
    await w.secrets.setFile('github', { login: 'test-account', password: 'saved', totpSecret: RFC_KEY })
    await w.secrets.setPath('github', file)
    expect(await w.secrets.list()).toEqual([expect.objectContaining({ source: 'path' })])
    await w.secrets.setProvider('github', ['/bin/false'])
    expect(JSON.parse(await readFile(join(w.env.XDG_CONFIG_HOME!, 'blobby', 'secrets.json'), 'utf8'))).toEqual({ providers: { github: ['/bin/false'] }, paths: {} })
  })

  it('answers callbacks from it, still gated by the allowlist', async () => {
    await w.secrets.setPath('github', file)
    const step = { id: 'aaaaaaaaaaaaaaaa', name: 'Sign in', uses: ['github.login'] }
    const context = { sandbox: 't1', feature: 'vscode-insiders', step, callbacks: { 'github.login': { sensitive: false } } }
    const request = { sandbox: 't1', feature: 'vscode-insiders', step: step.id, stepName: 'Sign in', id: 'bbbbbbbbbbbbbbbb', name: 'github.login', sensitive: false }
    const allowed = new LocalResolver({ secrets: w.secrets, env: w.env })
    expect(await allowed.resolve(request, context)).toEqual({ value: 'test-account' })
    await allowed.release()
    expect(allowed.redactor.text(`x ${PASSWORD}`)).toBe('x ***')
    const closed = new LocalResolver({ secrets: w.secrets, env: { ...w.env, BLOBBY_SANDBOX_ALLOWED_LOGINS: '' } })
    expect(await closed.resolve(request, context)).toMatchObject({ code: 'login_not_allowed' })
  })
})

describe('the CLI', () => {
  let out: string
  let io: Io
  const run = async (...args: string[]) => {
    out = ''
    return main(args, io)
  }
  beforeEach(() => {
    const stream = () => {
      const pass = new PassThrough()
      pass.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))
      return pass as unknown as NodeJS.WriteStream
    }
    io = { stdout: stream(), stderr: stream(), stdin: new PassThrough() as never, env: w.env, cwd: w.dir, connect: () => connect({ engine: async () => w.engine }), secrets: w.secrets, ghLogin: async () => 'my-own-login' }
  })

  it('sets a secret from a file by path, and shows its status but never its values or login', async () => {
    expect(await run('secrets', 'set', 'github', '--file', 'accounts/github-test.json', '--json')).toBe(0)
    expect(JSON.parse(out)).toEqual({ name: 'github', source: 'path', path: file })
    expect(await run('secrets', '--json')).toBe(0)
    expect(JSON.parse(out)).toEqual({ secrets: [{ name: 'github', source: 'path', detail: file, problem: null }] })
    expect(await run('secrets')).toBe(0)
    expect(out).toMatch(/^NAME\s+SOURCE\s+STATUS\s+WHERE\ngithub\s+account file\s+ok\s+/)
    expect(await run('doctor')).toBe(0)
    expect(out).toContain(`✓ Secret github: account file ${file}`)
    expect(await run('doctor', '--json')).toBe(0)
    for (const text of [out]) {
      expect(text).not.toContain(PASSWORD)
      expect(text).not.toContain('test-account')
    }
    await chmod(file, 0o644)
    expect(await run('doctor')).toBe(1)
    expect(out).toContain(`✗ Secret github: Other users can read or change the account file ${file}. Run: chmod 600 ${file}`)
  })

  it('refuses the account the GitHub CLI is signed in as, without naming it', async () => {
    await writeFile(file, account({ username: 'My-Own-Login' }), { mode: 0o600 })
    expect(await run('secrets', 'set', 'github', '--file', file, '--json')).toBe(1)
    expect(JSON.parse(out)).toMatchObject({ error: { code: 'own_account' } })
    expect(out).not.toMatch(/my-own-login/i)
    expect(await w.secrets.list()).toEqual([])
  })

  it('refuses exec --secret before anything runs when the allowlist is empty or the login is not on it', async () => {
    await w.secrets.setPath('github-test', file)
    await w.engine.start('t1', { steps: 'never' })
    io.env = { ...w.env, BLOBBY_SANDBOX_ALLOWED_LOGINS: '' }
    expect(await run('exec', 't1', '--secret', 'github-test', '--json', '--', 'vscode-signin')).toBe(1)
    expect(JSON.parse(out)).toMatchObject({ error: { code: 'login_not_allowed', message: expect.stringContaining('allowedLogins') } })
    io.env = { ...w.env, BLOBBY_SANDBOX_ALLOWED_LOGINS: 'someone-else' }
    expect(await run('exec', 't1', '--secret', 'github-test', '--json', '--', 'vscode-signin')).toBe(1)
    expect(JSON.parse(out)).toMatchObject({ error: { code: 'login_not_allowed' } })
    expect(await run('exec', 't1', '--secret', 'missing', '--json', '--', 'vscode-signin')).toBe(1)
    expect(JSON.parse(out)).toMatchObject({ error: { code: 'no_secret' } })
    expect(await run('exec', 't1', '--secret', 'github-test', '--root', '--json', '--', 'vscode-signin')).toBe(1)
    expect(JSON.parse(out)).toMatchObject({ error: { code: 'usage' } })
    expect(w.guest.steps.size).toBe(0)
    expect(out).not.toContain('test-account')
  })

  it('runs a command with --secret, streams its output redacted, and refuses an account other than the secret\'s', async () => {
    await w.secrets.setPath('github-test', file)
    await w.engine.start('t1', { steps: 'never' })
    expect(await run('exec', 't1', '--secret', 'github-test', '--', 'vscode-signin')).toBe(0)
    expect(out).toContain('running vscode-signin\n')
    expect(out).toContain('signed in as ***\n')
    expect(out).toContain('t1: signed in to the github-test test account (allowlisted).')
    const [step] = w.guest.steps.values()
    expect(step!.values.get('github-test.password')).toEqual({ value: PASSWORD })
    expect(out).not.toMatch(new RegExp(`${PASSWORD}|test-account`))

    // A command that reports another account than the secret's.
    w.guest.script = (fake) => {
      runCommand(fake)
      if (fake.exit === 0) fake.result = { 'github-test': 'someone-else' }
    }
    expect(await run('exec', 't1', '--secret', 'github-test', '--json', '--', 'vscode-signin')).toBe(1)
    expect(JSON.parse(out.trim().split('\n').at(-1)!)).toMatchObject({ error: { code: 'wrong_account' } })
    expect(out).not.toContain('someone-else')
  })
})
