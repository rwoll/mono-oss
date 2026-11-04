import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Capabilities } from '../src/backend.ts'
import { main, type Io } from '../src/cli.ts'
import { connect } from '../src/client.ts'
import { fakePng } from './fake-guest.ts'
import { ACCOUNT, RFC_KEY, SIGN_IN_RECIPE_DIR, world, type World } from './world.ts'

class Output extends PassThrough {
  text = ''
  isTTY = false
  constructor() {
    super()
    this.on('data', (chunk: Buffer) => (this.text += chunk.toString('utf8')))
  }
}

class Input extends PassThrough {
  isTTY = false
  setRawMode() {
    return this
  }
}

let w: World
let stdout: Output
let stderr: Output
let stdin: Input
let io: Io
let opened: string[]

async function setUp(secret: boolean, capabilities?: Partial<Capabilities>) {
  if (w) await w.cleanup()
  w = await world({ secret, capabilities })
  stdout = new Output()
  stderr = new Output()
  stdin = new Input()
  opened = []
  io = {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    env: w.env,
    cwd: w.dir,
    connect: () => connect({ engine: async () => w.engine }),
    secrets: w.secrets,
    ghLogin: async () => 'my-own-login',
    openUrl: async (url) => void opened.push(url),
  }
}

beforeEach(() => setUp(true))
afterEach(() => w.cleanup())

const run = async (...args: string[]) => {
  stdout.text = ''
  stderr.text = ''
  return main(args, io)
}

describe('start', () => {
  it('creates a sandbox, signs it in with the secrets, and says how to see it', async () => {
    expect(await run('start', 't1', '--recipe', SIGN_IN_RECIPE_DIR, '--resolution', '1600x1000')).toBe(0)
    expect(stdout.text.trim()).toBe('Created t1 (signin-test, VS Code Insiders 1.2.3), signed in to the github test account (allowlisted). See it with `blobby-sandbox view t1`.')
    expect(stderr.text).toContain('t1: Sign in to the test account\n')
    expect(stderr.text).not.toContain(ACCOUNT.password)
    expect(w.backend.calls.some((call) => call.method === 'exec' && (call.args[1] as string[]).join(' ') === 'bash /opt/blobby/runtime/boot.sh 1600x1000')).toBe(true)
  })

  it('leaves the GPU to the backend unless --no-gpu asks for none', async () => {
    await setUp(true, { gpu: false })
    expect(await run('start', 't1', '--no-steps')).toBe(0)
    const create = w.backend.calls.find((call) => call.method === 'create' || call.method === 'createFrom')!
    expect((create.args.at(-1) as { resources: { gpu: boolean } }).resources.gpu).toBe(false)
  })

  it('prints the result as JSON', async () => {
    expect(await run('start', 't1', '--json', '--no-steps')).toBe(0)
    expect(JSON.parse(stdout.text)).toMatchObject({ created: true, recipe: 'vscode-insiders', steps: [], sandbox: { name: 't1', state: 'running' }, viewer: true })
  })

  it('points to screenshot, not view, on a backend without a viewer', async () => {
    await setUp(true, { ports: false, publish: false })
    expect(await run('start', 't1', '--no-steps')).toBe(0)
    expect(stdout.text).toMatch(/See it with `blobby-sandbox screenshot t1`; this backend has no viewer yet\.\n$/)
    expect(stderr.text).toContain('t1: The fake backend has no viewer yet')
    expect(await run('view', 't1', '--json')).toBe(1)
    expect(JSON.parse(stderr.text)).toMatchObject({ error: { code: 'unsupported' } })
  })

  it('uploads a recipe folder from the client', async () => {
    const folder = join(w.dir, 'mine')
    await mkdir(folder)
    await writeFile(join(folder, 'recipe.json'), JSON.stringify({ apiVersion: 1 }))
    await writeFile(join(folder, 'setup.sh'), 'echo hi')
    expect(await run('start', 'c1', '--recipe', './mine')).toBe(0)
    expect(stdout.text).toMatch(/^Created c1 \(mine[,)]/)
    expect(w.backend.machines.get('blobby-c1')!.files.get('/opt/blobby/recipe/setup.sh')!.data.toString()).toBe('echo hi')
  })

  it('fails, with the sandbox running, when a secret its steps need is missing', async () => {
    await w.cleanup()
    await setUp(false)
    expect(await run('start', 't1', '--recipe', SIGN_IN_RECIPE_DIR)).toBe(1)
    expect(stderr.text).toContain('blobby-sandbox: t1 is running, but "Sign in to the test account" failed: There is no github secret. Set it with `blobby-sandbox secrets set github`.')
    expect(await run('list')).toBe(0)
    expect(stdout.text).toContain('t1    running')
  })
})

describe('driving', () => {
  beforeEach(async () => {
    expect(await run('start', 't1', '--no-steps')).toBe(0)
  })

  it('saves screenshots and recordings on the client', async () => {
    expect(await run('screenshot', 't1', '--out', 'shots/a.png')).toBe(0)
    expect(await readFile(join(w.dir, 'shots', 'a.png'))).toEqual(fakePng(1280, 800))
    expect(await run('record', 't1', 'start', '--max-seconds', '30')).toBe(0)
    expect(stdout.text).toContain('Stop with `blobby-sandbox record t1 stop -o <file>`')
    expect(await run('record', 't1', 'stop', '--out', 'a.mp4', '--json')).toBe(0)
    expect(JSON.parse(stdout.text)).toMatchObject({ path: join(w.dir, 'a.mp4'), seconds: 3.5 })
    expect((await readFile(join(w.dir, 'a.mp4'))).toString()).toBe('mp4 bytes')
  })

  it('waits for an element with ui --wait, and says what to fix in its options', async () => {
    w.guest.a11y = { nodes: [{ path: '0.1', app: 'code-insiders', role: 'push button', name: 'Accounts', box: [10, 20, 30, 40] }], truncated: false }
    expect(await run('ui', 't1', '--wait', '--match', 'Accounts', '--role', 'push button', '--timeout', '20')).toBe(0)
    expect(stdout.text).toBe('Found after 0.3s:\n0.1  push button "Accounts" at 10,20,30,40\n')
    expect(w.guest.operations.at(-1)).toEqual({ op: 'ui.wait', options: { match: 'Accounts', role: 'push button', gone: false, timeoutSeconds: 20 } })
    expect(await run('ui', 't1', '--gone', '--match', 'Loading', '--json')).toBe(0)
    expect(JSON.parse(stdout.text)).toEqual({ found: false, nodes: [], waitedMs: 250 })
    expect(await run('ui', 't1', '--wait', '--match', 'Accounts', '--gone', '--json')).toBe(1)
    expect(stderr.text).toContain('"code":"wait_timeout"')
    expect(await run('ui', 't1', '--wait')).toBe(1)
    expect(stderr.text).toContain('Usage: blobby-sandbox ui <name> --wait --match TEXT')
    expect(await run('ui', 't1', '--wait', '--match', 'x', '--state', 'shiny')).toBe(1)
    expect(stderr.text).toContain('--state must be one of focused, checked')
  })

  it('sends input', async () => {
    expect(await run('input', 't1', 'click', '10', '20', '--button', 'right', '--double')).toBe(0)
    expect(await run('input', 't1', 'type', 'hello world')).toBe(0)
    expect(await run('input', 't1', 'key', 'ctrl+l', 'Return')).toBe(0)
    expect(await run('input', 't1', 'scroll', '0', '3', '--at', '5,6')).toBe(0)
    expect(await run('input', 't1', 'move', '7', '8', '--instant')).toBe(0)
    expect(w.guest.operations.filter((operation) => operation.op === 'input').map((operation) => operation.options)).toEqual([
      { click: [10, 20], button: 'right', double: true },
      { type: 'hello world' },
      { key: 'ctrl+l Return' },
      { scroll: [0, 3], at: [5, 6] },
      { move: [7, 8], instant: true },
    ])
    expect(await run('input', 't1', 'click', 'x', '2')).toBe(1)
    expect(stderr.text).toContain('X must be a whole number')
  })

  it('prints and acts on the accessibility tree', async () => {
    w.guest.a11y = { nodes: [{ path: '2.0.1', app: 'code', role: 'push button', name: 'Accounts', states: ['focused'], box: [1, 2, 3, 4] }], truncated: true }
    expect(await run('ui', 't1', '--app', 'code')).toBe(0)
    expect(stdout.text).toBe('2.0.1  push button "Accounts" focused at 1,2,3,4\n(more elements: narrow with --app or --match, or raise --max)\n')
    expect(await run('ui', 't1', '2.0.1')).toBe(0)
    expect(stdout.text).toBe('Did press on "Accounts".\n')
    expect(await run('ui', 't1', '2.0.1', 'set', 'hello')).toBe(0)
    expect(w.guest.operations.at(-1)).toEqual({ op: 'ui.act', options: { path: '2.0.1', do: 'set', text: 'hello' } })
  })

  it('opens the viewer, or prints it', async () => {
    expect(await run('view', 't1')).toBe(0)
    expect(opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/vnc\.html#autoconnect=1&resize=remote&path=websockify&password=Ab12%2BCd3$/)
    expect(await run('view', 't1', '--json')).toBe(0)
    expect(JSON.parse(stdout.text)).toMatchObject({ name: 't1', websocket: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+\/websockify$/), password: 'Ab12+Cd3' })
  })

  it('runs commands and passes their exit code on', async () => {
    w.backend.onExec = ((inner) => (name, command, options) => (command.at(-1) === 'false' ? { exitCode: 3, stdout: 'out\n', stderr: 'err\n' } : inner(name, command, options)))(w.backend.onExec)
    expect(await run('exec', 't1', '--', 'false')).toBe(3)
    expect(stdout.text).toBe('out\n')
    expect(stderr.text).toBe('err\n')
    expect(await run('exec', 't1', '--root', '--', 'id', '-u')).toBe(0)
    expect(w.backend.calls.filter((call) => call.method === 'exec').at(-1)!.args[2]).toMatchObject({ user: 'root' })
    expect(await run('exec', 't1', '--root', '--user', 'ubuntu', '--', 'id')).toBe(1)
  })

  it('stops and removes sandboxes', async () => {
    expect(await run('stop', 't1')).toBe(0)
    expect(await run('rm', 't1', '--json')).toBe(0)
    expect(JSON.parse(stdout.text)).toEqual({ removed: 't1' })
    expect(await run('rm', 't1', '--json')).toBe(1)
    expect(JSON.parse(stderr.text)).toEqual({ error: { code: 'not_found', message: "There is no sandbox named t1 on the fake backend. See `blobby-sandbox list`, or pick the backend it's on with --backend." } })
  })
})

describe('secrets', () => {
  /** Answers each prompt once it appears. */
  function answer(pairs: [string, string][]) {
    const pending = [...pairs]
    stdout.on('data', () => {
      while (pending.length && stdout.text.includes(pending[0]![0])) stdin.write(pending.shift()![1])
    })
  }

  it('lists secrets, and uses a provider', async () => {
    const script = join(w.dir, 'provider.sh')
    await writeFile(script, `#!/bin/sh\necho '${JSON.stringify(ACCOUNT)}'\n`, { mode: 0o755 })
    expect(await run('secrets', 'set', 'github', '--provider', '--', script)).toBe(0)
    expect(await run('secrets')).toBe(0)
    expect(stdout.text).toMatch(/^NAME\s+SOURCE\s+STATUS\s+WHERE\ngithub\s+provider\s+ok\s+/)
    expect(stdout.text).not.toContain('test-account')
    expect(await run('doctor')).toBe(0)
    expect(stdout.text).toContain('✓ Backend fake: fake backend, in memory\n  The client was given its engine.')
    expect(stdout.text).toContain(`✓ Secret github: provider ${script}`)
    expect(stdout.text).toContain('✓ Allowlist: 1 login is allowed (BLOBBY_SANDBOX_ALLOWED_LOGINS)')
    expect(await run('secrets', 'rm', 'github')).toBe(0)
    // Without secrets, sandboxes still start; only `exec --secret` needs one.
    expect(await run('doctor')).toBe(0)
    expect(stdout.text).toContain('! Secrets files: No secrets yet. `exec --secret` needs one: run `blobby-sandbox secrets set github --file <test-account file>` in a terminal.')
  })

  describe('set from the keyboard', () => {
    beforeEach(async () => {
      await w.secrets.remove('github')
      stdin.isTTY = true
      stdout.isTTY = true
    })

    it('needs a terminal', async () => {
      stdin.isTTY = false
      expect(await run('secrets', 'set', 'github')).toBe(1)
      expect(stderr.text).toContain('in a terminal')
    })

    it('refuses the account the GitHub CLI is signed in as', async () => {
      answer([['Login: ', 'My-Own-Login\n']])
      expect(await run('secrets', 'set', 'github')).toBe(1)
      expect(stderr.text).toContain('Use a separate test account')
    })

    it('warns, shows the current code, and saves the secret privately', async () => {
      answer([['Login: ', 'test-account\n'], ['Password: ', 'pa55\r'], ['(base32, or empty for none): ', `${RFC_KEY}\r`]])
      expect(await run('secrets', 'set', 'github')).toBe(0)
      expect(stdout.text).toContain('treat it as compromised')
      expect(stdout.text).toMatch(/Current 2FA code: \d{3} \d{3}/)
      expect(stdout.text).not.toContain('pa55')
      const file = join(w.env.XDG_CONFIG_HOME!, 'blobby', 'secrets', 'github.json')
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ login: 'test-account', password: 'pa55', totpSecret: RFC_KEY })
    })
  })
})

describe('serve', () => {
  it('serves until stopped, and prints how to connect', async () => {
    let options: unknown
    io.serve = async (given) => {
      options = given
      return { url: 'http://127.0.0.1:4567', backend: 'smolvm', done: Promise.resolve() }
    }
    io.env.BLOBBY_SANDBOX_TOKEN = 'given-token'
    expect(await run('serve', '--port', '4567', '--backend', 'smolvm')).toBe(0)
    expect(options).toMatchObject({ port: 4567, token: 'given-token', backend: 'smolvm' })
    expect(stdout.text).toContain('Serving smolvm sandboxes at http://127.0.0.1:4567')
    expect(stdout.text).toContain('export BLOBBY_SANDBOX_SERVER=http://127.0.0.1:4567 BLOBBY_SANDBOX_TOKEN=given-token')
  })
})

describe('backends', () => {
  beforeEach(() => {
    // Docker is never reachable here, whatever this computer runs.
    io.connect = (options) => connect({ ...options, env: { ...options.env, XDG_CONFIG_HOME: w.env.XDG_CONFIG_HOME, DOCKER_HOST: `unix://${w.dir}/missing-docker.sock` } })
  })

  it('reports in doctor which backend it picked and why, and what is wrong with it', async () => {
    expect(await run('doctor', '--backend', 'docker', '--json')).toBe(1)
    expect(JSON.parse(stdout.text).backend).toEqual({
      name: 'docker',
      source: 'option',
      reason: 'It was asked for with --backend.',
      ok: false,
      code: 'docker_unreachable',
      detail: expect.stringContaining('Docker isn\'t running'),
      capabilities: expect.objectContaining({ snapshot: true, networkPolicies: ['none', 'internet'] }),
      checks: [],
    })
    io.env.BLOBBY_SANDBOX_BACKEND = 'docker'
    expect(await run('doctor')).toBe(1)
    expect(stdout.text).toMatch(/^✗ Backend docker: Docker isn't running.*\n {2}BLOBBY_SANDBOX_BACKEND is set to docker\.\n/)
  })

  it('lists what any backend checked under it in doctor', async () => {
    io.connect = () => connect({ engine: async () => w.engine })
    w.backend.status = { ok: true, detail: 'fake backend, in memory', checks: [{ name: 'disk', ok: true, detail: 'plenty' }, { name: 'gadget', ok: false, detail: 'missing; install it' }] }
    expect(await run('doctor')).toBe(0)
    expect(stdout.text).toContain('✓ Backend fake: fake backend, in memory\n  The client was given its engine.\n  ✓ disk: plenty\n  ! gadget: missing; install it\n')
    expect(await run('doctor', '--json')).toBe(0)
    expect(JSON.parse(stdout.text).backend.checks).toEqual(w.backend.status.checks)
  })

  it('fails other commands on an unavailable or unknown backend with a stable code', async () => {
    expect(await run('list', '--backend', 'docker', '--json')).toBe(1)
    expect(JSON.parse(stderr.text)).toMatchObject({ error: { code: 'docker_unreachable' } })
    expect(await run('start', 't1', '--backend', 'vmware', '--json')).toBe(1)
    expect(JSON.parse(stderr.text)).toEqual({ error: { code: 'unknown_backend', message: '--backend names an unknown backend, "vmware". Use one of: smolvm, docker, azure.' } })
    expect(await run('list', '--backend', 'smolvm', '--server', 'http://127.0.0.1:1')).toBe(1)
    expect(stderr.text).toContain('The server picks its own backend.')
  })
})

it('explains usage', async () => {
  expect(await run('--help')).toBe(0)
  expect(stdout.text).toContain('Usage: blobby-sandbox <command>')
  expect(await run('--help', '--json')).toBe(0)
  expect(JSON.parse(stdout.text).usage).toContain('--backend <name>')
  expect(await run('frobnicate')).toBe(1)
  expect(stderr.text).toBe('blobby-sandbox: Unknown command: frobnicate. Run `blobby-sandbox --help`.\n')
  expect(await run('list', '--bogus')).toBe(1)
  expect(stderr.text).toContain('Run `blobby-sandbox --help`.')
})
