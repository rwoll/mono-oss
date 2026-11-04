import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SandboxError } from '../src/backend.ts'
import type { CallbackRequest } from '../src/sandboxes.ts'
import { loadBuiltinRecipe } from '../src/recipe.ts'
import { LocalResolver } from '../src/callbacks/index.ts'
import { askFor } from './fake-guest.ts'
import { ACCOUNT, signInRecipe, world, type World } from './world.ts'

let w: World
beforeEach(async () => {
  w = await world()
})
afterEach(() => w.cleanup())

const answer = (request: CallbackRequest) => w.secrets.answer(request)
const execs = () => w.backend.calls.filter((call) => call.method === 'exec').map((call) => (call.args[1] as string[]).join(' '))

const snapshots = () => [...w.backend.snapshotStore.values()]
const called = (method: string) => w.backend.calls.filter((call) => call.method === method)

describe('start', () => {
  it('makes a new sandbox from a snapshot of its recipe base, and runs its steps with sealed callbacks', async () => {
    const progress: string[] = []
    const started = await w.engine.start('t1', { recipe: signInRecipe, onProgress: (line) => progress.push(line), onRequest: answer })

    expect(started).toMatchObject({ created: true, from: 'base', recipe: 'signin-test', info: { insiders: '1.2.3' } })
    expect(started.steps).toEqual([{ name: 'Sign in to the test account', result: { github: { signedIn: true, verified: false } } }])
    // The base is a snapshot, found again by its labels; the machine it was installed in is gone.
    const [snapshot] = snapshots()
    expect(snapshot!.labels).toEqual({
      'blobby.dev/base': expect.stringMatching(/^[a-f0-9]{12}$/),
      'blobby.dev/recipe': 'signin-test',
      'blobby.dev/image': 'ubuntu:24.04',
      'blobby.dev/runtime': expect.stringMatching(/^\d+\.\d+\.\d+/),
    })
    expect(snapshot!.source).toBe(`blobbybase-${snapshot!.labels['blobby.dev/base']}`)
    expect([...w.backend.machines.keys()]).toEqual(['blobby-t1'])
    expect(w.backend.machines.get('blobby-t1')!.snapshot).toBe(snapshot!.id)
    expect(execs()).toEqual(expect.arrayContaining(['bash /opt/blobby/runtime/setup.sh', 'bash /opt/blobby/recipe/setup.sh', 'bash /opt/blobby/runtime/boot.sh 1280x800']))
    expect(progress).toEqual(expect.arrayContaining(['Installing GNOME', "Saving the signin-test recipe's base", "Creating the sandbox from the signin-test recipe's base", 'Sign in to the test account', 'Asking for github.otp']))
    // The viewer's port is fixed at create, and the sandbox is labeled with its kind and a deletion deadline a day out.
    const [createFrom] = called('createFrom')
    expect(createFrom!.args[1]).toMatchObject({ name: 'blobby-t1', ports: [{ guest: 6901 }], labels: { 'blobby.dev/kind': 'desktop' }, network: 'internet' })
    expect(called('publish')).toEqual([])
    const deadline = Date.parse(w.backend.machines.get('blobby-t1')!.labels['blobby.dev/delete-after']!)
    expect(deadline - Date.now()).toBeGreaterThan(23.9 * 60 * 60_000)
    expect(deadline - Date.now()).toBeLessThanOrEqual(24 * 60 * 60_000)
    expect((await w.engine.list())[0]).toMatchObject({ name: 't1', deleteAfter: new Date(deadline).toISOString() })

    // The desktop opened each sensitive answer with its one-time key; only the login crossed in the clear.
    const step = [...w.guest.steps.values()][0]!
    expect(Object.fromEntries([...step.values].map(([name, value]) => [name, 'value' in value ? value.value : value.error]))).toEqual({
      'github.login': 'test-account',
      'github.password': ACCOUNT.password,
      'github.otp': expect.stringMatching(/^\d{6}$/),
    })
    const wire = JSON.stringify(step.raw)
    expect(wire).not.toContain(ACCOUNT.password)
    expect(wire).not.toContain(ACCOUNT.totpSecret)
    expect(step.stopped).toBe(true)
    // The runtime, the recipe, and its ID went into the sandbox.
    const files = w.backend.machines.get('blobby-t1')!.files
    expect([...files.keys()]).toEqual(expect.arrayContaining(['/opt/blobby/runtime/guest.py', '/opt/blobby/runtime/lib/blobby.mjs', '/opt/blobby/recipe/signin.mjs', '/etc/blobby/recipe']))
    expect(files.get('/opt/blobby/runtime/guest.py')!.mode).toBe(0o755)
  })

  it('reuses the base: a second sandbox does not install anything', async () => {
    await w.engine.start('t1', { onRequest: answer })
    w.backend.calls.length = 0
    await w.engine.start('t2', { onRequest: answer })
    expect(execs()).not.toContain('bash /opt/blobby/runtime/setup.sh')
    expect(called('create')).toEqual([])
    expect(called('createFrom')).toHaveLength(1)
    expect(called('snapshot')).toEqual([])
  })

  it('installs from scratch at the size asked for when the backend makes copies of the base only at its size', async () => {
    const createFrom = w.backend.createFrom.bind(w.backend)
    w.backend.createFrom = async (snapshot, options) => {
      if (options.resources?.cpus !== 4 || options.resources?.memoryMb !== 8192) throw new SandboxError('unsupported', 'Copies have the base snapshot size.')
      return createFrom(snapshot, options)
    }
    await w.engine.start('t1', { onRequest: answer })
    w.backend.calls.length = 0
    const progress: string[] = []
    const started = await w.engine.start('big', { cpus: 8, memoryMb: 16384, onRequest: answer, onProgress: (line) => progress.push(line) })
    expect(started).toMatchObject({ created: true, from: 'scratch' })
    expect(progress).toContain("The vscode-insiders recipe's base can't be resized on the fake backend, so this sandbox is installed from scratch at the size asked for. This takes a few minutes.")
    expect(called('create')[0]!.args[0]).toMatchObject({ name: 'blobby-big', image: 'ubuntu:24.04', resources: { cpus: 8, memoryMb: 16384 } })
    // It checks whether this new machine is set up, as for any sandbox installed from scratch.
    expect(execs()).toContain('test -e /etc/blobby/ready')
    // At the base's size, the same failure is an error, not a reason to install from scratch.
    w.backend.createFrom = async () => {
      throw new SandboxError('unsupported', 'No copies.')
    }
    await expect(w.engine.start('t2', { onRequest: answer })).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('installs a separate base per recipe, and a recipe without steps signs nothing in', async () => {
    const started = await w.engine.start('plain', { recipe: await loadBuiltinRecipe('desktop') })
    expect(started).toMatchObject({ recipe: 'desktop', steps: [] })
    expect(execs()).not.toContain('bash /opt/blobby/recipe/setup.sh')
    await w.engine.start('t1', { onRequest: answer })
    expect(snapshots().map((snapshot) => snapshot.labels['blobby.dev/recipe']).sort()).toEqual(['desktop', 'vscode-insiders'])
  })

  it('removes only the same recipe\'s older bases, reading bases without a recipe as vscode-insiders', async () => {
    const add = (id: string, labels: Record<string, string>) =>
      w.backend.snapshotStore.set(id, { id, source: null, createdAt: '2025-01-01T00:00:00.000Z', labels, files: new Map() })
    add('old-default', { 'blobby.dev/base': '000000000001' })
    add('old-desktop', { 'blobby.dev/base': '000000000002', 'blobby.dev/recipe': 'desktop' })
    add('not-a-base', {})
    await w.engine.start('t1', { onRequest: answer })
    expect(w.backend.snapshotStore.has('old-default')).toBe(false)
    expect(w.backend.snapshotStore.has('old-desktop')).toBe(true)
    expect(w.backend.snapshotStore.has('not-a-base')).toBe(true)
  })

  it('waits for another install of the same base, and takes over one that was abandoned', async () => {
    // Another engine is installing the base: its machine exists, and its snapshot appears a little later.
    await w.engine.start('t1', { onRequest: answer })
    const [snapshot] = snapshots()
    const builder = snapshot!.source!
    w.backend.snapshotStore.clear()
    w.backend.add(builder, { state: 'running', labels: { 'blobby.dev/base': snapshot!.labels['blobby.dev/base']! } })
    let polls = 0
    const snapshotsOf = w.backend.snapshots.bind(w.backend)
    w.backend.snapshots = async (filter) => {
      if (++polls === 3) {
        w.backend.machines.delete(builder)
        w.backend.snapshotStore.set(snapshot!.id, snapshot!)
      }
      return snapshotsOf(filter)
    }
    const progress: string[] = []
    w.backend.calls.length = 0
    await w.engine.start('t2', { onRequest: answer, onProgress: (line) => progress.push(line) })
    expect(progress).toContain("Waiting for another install of the vscode-insiders recipe's base")
    expect(called('create')).toEqual([])
    expect(w.backend.machines.get('blobby-t2')!.snapshot).toBe(snapshot!.id)

    // An install that died long ago left only its machine: it is removed, and the base installed again.
    w.backend.snapshotStore.clear()
    w.backend.add(builder, { state: 'running', labels: { 'blobby.dev/base': snapshot!.labels['blobby.dev/base']! } }).createdAt = '2020-01-01T00:00:00.000Z'
    await w.engine.start('t3', { onRequest: answer })
    expect(called('create').map((call) => (call.args[0] as { name: string }).name)).toEqual([builder])
    expect(snapshots()).toHaveLength(1)
  })

  it('keeps an existing sandbox\'s recipe, does not run its steps again unless asked, and refuses another recipe', async () => {
    await w.engine.start('t1', { recipe: signInRecipe, onRequest: answer })
    w.guest.steps.clear()
    expect((await w.engine.start('t1', { onRequest: answer })).steps).toEqual([])
    expect((await w.engine.start('t1', { steps: 'always', onRequest: answer })).steps).toHaveLength(1)
    await expect(w.engine.start('t1', { recipe: await loadBuiltinRecipe('desktop') })).rejects.toMatchObject({ code: 'recipe_mismatch' })
  })

  it('treats a sandbox without a recorded recipe as a VS Code Insiders sandbox', async () => {
    w.backend.add('blobby-old', { state: 'running', ports: [{ host: 50100, guest: 6901 }] })
    w.guest.ready = true
    w.guest.session = true
    const started = await w.engine.start('old', { resolution: '1600x1000' })
    expect(started).toMatchObject({ created: false, recipe: 'vscode-insiders', steps: [] })
    expect(w.backend.machines.get('blobby-old')!.files.get('/etc/blobby/recipe')!.data.toString()).toBe('vscode-insiders\n')
    // Its session already runs, so the new resolution applies to it directly.
    expect(w.guest.operations).toContainEqual({ op: 'resize', options: { width: 1600, height: 1000 } })
  })

  it('keeps the screen and commands usable while a step that handles secrets runs', async () => {
    let checked = false
    await w.engine.start('t1', {
      recipe: signInRecipe,
      onRequest: async (request) => {
        if (request.sensitive && !checked) {
          checked = true
          await expect(w.engine.screenshot('t1')).resolves.toMatchObject({ width: 1280 })
          await expect(w.engine.exec('t1', ['true'])).resolves.toMatchObject({ exitCode: 0 })
        }
        return answer(request)
      },
    })
    expect(checked).toBe(true)
  })

  it('does not pass a sensitive value the client sent in the clear', async () => {
    const error = await w.engine
      .start('t1', { recipe: signInRecipe, onRequest: async (request) => (request.sensitive ? { value: 'pa55-w0rd!' } : answer(request)) })
      .then(() => null, (caught: unknown) => caught as Error & { code: string })
    expect(error).toMatchObject({ code: 'step_failed' })
    expect(error!.message).toMatch(/^t1 is running, but "Sign in to the test account" failed: .*must be sealed.*blobby-sandbox start t1 --steps/)
    const step = [...w.guest.steps.values()][0]!
    expect(JSON.stringify(step.raw)).not.toContain('pa55-w0rd!')
  })

  it('fails a step with the client\'s reason when a secret is missing', async () => {
    const empty = await world({ secret: false })
    try {
      await expect(empty.engine.start('t1', { recipe: signInRecipe, onRequest: (request) => empty.secrets.answer(request) })).rejects.toThrow(
        /There is no github secret\. Set it with `blobby-sandbox secrets set github`/,
      )
      expect((await empty.engine.list()).map((sandbox) => sandbox.name)).toEqual(['t1'])
    } finally {
      await empty.cleanup()
    }
  })

  it('removes a base whose install failed, so the next start installs it again', async () => {
    w.guest.failSetup = true
    await expect(w.engine.start('t1')).rejects.toMatchObject({ code: 'setup_failed' })
    expect([...w.backend.machines.keys()]).toEqual([])
  })

  it('checks names and resolutions', async () => {
    await expect(w.engine.start('Bad Name')).rejects.toMatchObject({ code: 'invalid_name' })
    await expect(w.engine.start('t1', { resolution: 'huge' })).rejects.toMatchObject({ code: 'usage' })
  })
})

describe("driving a sandbox's desktop", () => {
  beforeEach(async () => {
    await w.engine.start('t1', { onRequest: answer })
  })

  it('takes screenshots, sends input, and reads and acts on the accessibility tree through the guest helper', async () => {
    expect(await w.engine.screenshot('t1')).toMatchObject({ width: 1280, height: 800 })
    await w.engine.input('t1', { click: [10, 20], button: 'right' })
    w.guest.a11y = { nodes: [{ path: '0.1', app: 'code', role: 'push button', name: 'Accounts' }], truncated: false }
    expect(await w.engine.ui('t1', { match: 'Acc' })).toEqual({ nodes: [{ path: '0.1', app: 'code', role: 'push button', name: 'Accounts' }], truncated: false })
    expect(await w.engine.act('t1', { path: '0.1', do: 'focus' })).toEqual({ path: '0.1', name: 'Accounts', did: 'focus' })
    expect(w.guest.operations.map((operation) => operation.op)).toEqual(expect.arrayContaining(['screenshot', 'input', 'ui.snapshot', 'ui.act']))
    expect(w.guest.operations.find((operation) => operation.op === 'ui.snapshot')!.options).toEqual({ match: 'Acc', max: 300 })
  })

  it('waits for an element in the sandbox, in one call, and for one to go', async () => {
    const accounts = { path: '0.1', app: 'code-insiders', role: 'push button', name: 'Accounts', states: ['focused'] }
    w.guest.a11y = { nodes: [accounts, { path: '0.2', app: 'code-insiders', role: 'label', name: 'Accounts menu' }], truncated: false }
    const before = w.guest.operations.length
    expect(await w.engine.waitFor('t1', { match: 'accounts', role: 'Push Button', state: 'focused' })).toEqual({ found: true, nodes: [accounts], waitedMs: 250 })
    expect(w.guest.operations.slice(before)).toEqual([{ op: 'ui.wait', options: { match: 'accounts', role: 'Push Button', state: 'focused', timeoutSeconds: 30 } }])
    // The command that waits may run longer than the wait itself.
    const call = w.backend.calls.filter((entry) => entry.method === 'exec').at(-1)!
    expect(call.args[2]).toMatchObject({ timeoutSeconds: 60 })
    await expect(w.engine.waitFor('t1', { match: 'Accounts', gone: true, timeoutSeconds: 5 })).rejects.toMatchObject({ code: 'wait_timeout' })
    expect(await w.engine.waitFor('t1', { match: 'Progress', gone: true })).toEqual({ found: false, nodes: [], waitedMs: 250 })
  })

  it('records into the sandbox, and reads the video back in chunks', async () => {
    w.guest.recordingBytes = Buffer.from('0123456789')
    const { id } = await w.engine.recordStart('t1', { maxSeconds: 5 })
    await expect(w.engine.recordStart('t1')).rejects.toMatchObject({ code: 'already_recording' })
    const info = await w.engine.recordStop('t1')
    expect(info).toMatchObject({ id, size: 10, seconds: 3.5 })
    const first = await w.engine.mediaRead('t1', id, 0, 6)
    const second = await w.engine.mediaRead('t1', id, 6, 6)
    expect(Buffer.concat([first.data, second.data]).toString()).toBe('0123456789')
    expect([first.eof, second.eof]).toEqual([false, true])
    await w.engine.mediaDelete('t1', id)
    await expect(w.engine.mediaRead('t1', id, 0, 6)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('gives a sandbox that an older blobby-sandbox started this version\'s runtime, then retries', async () => {
    const files = w.backend.machines.get('blobby-t1')!.files
    files.delete('/opt/blobby/runtime/guest.py')
    let first = true
    w.backend.onExec = ((inner) => (name, command, options) => {
      if (command[1] === '/opt/blobby/runtime/guest.py' && !files.has('/opt/blobby/runtime/guest.py') && first) {
        first = false
        return { exitCode: 2, stderr: "python3: can't open file '/opt/blobby/runtime/guest.py': [Errno 2] No such file or directory" }
      }
      return inner(name, command, options)
    })(w.backend.onExec)
    expect(await w.engine.screenshot('t1')).toMatchObject({ width: 1280 })
    expect(files.has('/opt/blobby/runtime/guest.py')).toBe(true)
  })

  it('gives the viewer\'s endpoint and password', async () => {
    expect(await w.engine.view('t1')).toEqual({ endpoint: { kind: 'tcp', host: '127.0.0.1', port: expect.any(Number) }, password: 'Ab12+Cd3' })
  })

  it('streams recordings, and byte ranges of them, through the backend\'s file reads', async () => {
    w.guest.recordingBytes = Buffer.from('0123456789')
    await w.engine.recordStart('t1')
    const { id } = await w.engine.recordStop('t1')
    const read = async (range?: { offset?: number; length?: number }) => {
      const { stream, size } = await w.engine.mediaStream('t1', id, range)
      const chunks: Buffer[] = []
      for await (const chunk of stream) chunks.push(chunk as Buffer)
      return { text: Buffer.concat(chunks).toString(), size }
    }
    expect(await read()).toEqual({ text: '0123456789', size: 10 })
    expect(await read({ offset: 3, length: 4 })).toEqual({ text: '3456', size: 10 })
    await expect(w.engine.mediaStream('t1', '../../etc/passwd')).rejects.toMatchObject({ code: 'invalid_id' })
    await expect(w.engine.mediaStream('t1', 'ab'.repeat(8))).rejects.toMatchObject({ code: 'not_found' })
  })

  it('runs commands through the guest helper, as the desktop user in its session, or as root', async () => {
    await w.engine.exec('t1', ['xdotool', 'getactivewindow'])
    let call = w.backend.calls.filter((entry) => entry.method === 'exec').at(-1)!
    expect(call.args[1]).toEqual(['python3', '/opt/blobby/runtime/guest.py', 'exec', '--', 'xdotool', 'getactivewindow'])
    expect(call.args[2]).toMatchObject({ user: 'ubuntu', env: expect.objectContaining({ DISPLAY: ':1', HOME: '/home/ubuntu' }) })
    await w.engine.exec('t1', ['apt-get', 'install', '-y', 'cowsay'], { user: 'root' })
    call = w.backend.calls.filter((entry) => entry.method === 'exec').at(-1)!
    expect(call.args[2]).toMatchObject({ user: 'root', env: expect.objectContaining({ HOME: '/root', DEBIAN_FRONTEND: 'noninteractive' }) })
  })

  it('stops and removes sandboxes, and the base of a removed sandbox\'s recipe stays', async () => {
    await w.engine.stop('t1')
    expect((await w.engine.list())[0]).toMatchObject({ name: 't1', state: 'stopped' })
    await w.engine.remove('t1')
    expect(await w.engine.list()).toEqual([])
    expect(snapshots()).toHaveLength(1)
    await expect(w.engine.remove('t1')).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('exec with a secret', () => {
  beforeEach(async () => {
    await w.engine.start('t1', { steps: 'never' })
  })
  const resolver = () => new LocalResolver({ secrets: w.secrets, env: w.env })

  it('runs the command as a step that asks for the secret, streams its output redacted, and checks the account', async () => {
    const chunks: string[] = []
    const audits: string[] = []
    const local = resolver()
    const result = await w.engine.exec('t1', ['vscode-signin', '--json'], {
      secret: 'github',
      resolver: local,
      onOutput: (chunk) => chunks.push(`${chunk.stream}:${chunk.text}`),
      onAudit: (event) => audits.push(`${event.name} ${event.outcome}`),
    })
    expect(result).toEqual({ exitCode: 0, stdout: 'running vscode-signin --json\nsigned in as ***\n', stderr: expect.stringContaining('Asking for github.password'), result: { github: { signedIn: true, verified: true } } })
    expect(chunks.join('')).not.toContain(ACCOUNT.login)
    expect(audits).toEqual(['github.login answered', 'github.password answered', 'github.otp answered'])
    const [step] = w.guest.steps.values()
    expect(step).toMatchObject({ argv: ['vscode-signin', '--json'], secret: 'github', run: null, stopped: true })
    expect(Object.keys(step!.callbacks)).toEqual(['github.login', 'github.username', 'github.email', 'github.password', 'github.otp', 'github.token'])
    expect(step!.values.get('github.password')).toEqual({ value: ACCOUNT.password })
    expect(JSON.stringify(step!.raw)).not.toContain(ACCOUNT.password)
    await local.release()
  })

  it('never sends part of a secret split across polls', async () => {
    let polls = 0
    w.guest.script = (step) => {
      if (!askFor(step, ['github.password'])) return
      polls++
      if (polls === 1) step.output += `debug ${ACCOUNT.password.slice(0, 5)}`
      else if (polls === 2) step.output += `${ACCOUNT.password.slice(5)} end\nlast line without a break`
      else step.exit = 0
    }
    const chunks: string[] = []
    const result = await w.engine.exec('t1', ['leaky'], { secret: 'github', resolver: resolver(), onOutput: (chunk) => void (chunk.stream === 'stdout' && chunks.push(chunk.text)) })
    expect(result.stdout).toBe('debug *** end\nlast line without a break')
    expect(chunks.join('')).toBe(result.stdout)
    for (const chunk of chunks) expect(ACCOUNT.password.includes(chunk.trim()) && chunk.trim().length > 0).toBe(false)
  })

  it('reports a failing command by its exit code, with its refusals redacted', async () => {
    const result = await w.engine.exec('t1', ['vscode-signin'], { secret: 'github', resolver: new LocalResolver({ secrets: w.secrets, allowedLogins: ['someone-else'] }) })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("error: The github secret's login is not in allowedLogins")
    expect(result.stdout).not.toContain(ACCOUNT.login)
  })

  it('refuses what a command with a secret cannot have, before anything runs', async () => {
    const before = w.guest.operations.length
    await expect(w.engine.exec('t1', ['true'], { secret: '../github' })).rejects.toMatchObject({ code: 'invalid_secret' })
    await expect(w.engine.exec('t1', ['true'], { secret: 'github', user: 'root' })).rejects.toMatchObject({ code: 'usage' })
    await expect(w.engine.exec('t1', ['true'], { secret: 'github', env: { A: '1' } })).rejects.toMatchObject({ code: 'usage' })
    await expect(w.engine.exec('t1', ['true'], { secret: 'github', stdin: 'x' })).rejects.toMatchObject({ code: 'usage' })
    expect(w.guest.operations.length).toBe(before)
  })

  it('stops a command that runs too long with exit code 124, and one that is cancelled', async () => {
    w.guest.script = () => {}
    const slow = await w.engine.exec('t1', ['sleep', 'forever'], { secret: 'github', resolver: resolver(), timeoutSeconds: 1 })
    expect(slow).toMatchObject({ exitCode: 124, stderr: expect.stringContaining('did not finish in 1 seconds') })
    const controller = new AbortController()
    const cancelled = w.engine.exec('t1', ['sleep', 'forever'], { secret: 'github', resolver: resolver(), signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' })
    expect([...w.guest.steps.values()].every((step) => step.stopped)).toBe(true)
  })

  it('stops at its deadline, or when cancelled, even while a request waits for an answer', async () => {
    const never = () => new Promise<never>(() => {})
    const started = Date.now()
    const slow = await w.engine.exec('t1', ['vscode-signin'], { secret: 'github', onRequest: never, timeoutSeconds: 1 })
    expect(slow).toMatchObject({ exitCode: 124, stderr: expect.stringContaining('did not finish in 1 seconds') })
    expect(Date.now() - started).toBeLessThan(3000)
    const controller = new AbortController()
    const cancelled = w.engine.exec('t1', ['vscode-signin'], { secret: 'github', onRequest: never, signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' })
    expect([...w.guest.steps.values()].map((step) => step.stopped)).toEqual([true, true])
  })
})
