import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestCanvas } from '@rwoll/canvas-kit/testing'
import { CanvasKitError } from '@rwoll/canvas-kit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCanvas } from './canvas.ts'
import { createCli, withJson, type RunOptions, type SandboxCli } from './cli.ts'

const doctor = {
  backend: { name: 'smolvm', source: 'default', reason: 'This is macOS on Apple silicon, which runs smolvm.', ok: true, detail: 'smolmachines 1.31.0' },
  secrets: [{ name: 'github', source: 'provider', detail: '~/bin/test-account', problem: null }],
  allowlist: { allowedLogins: 1, source: 'config', problem: null },
}
const SIGN_IN = ['--secret', 'github', '--', 'vscode-signin']
const signedIn = { exitCode: 0, json: { exitCode: 0, stdout: 'Signed in as ***\n', stderr: '', result: { github: { signedIn: true, verified: true } } } }
const sandbox = (name: string, state = 'running', viewerPort: number | null = 5000) => ({ name, state, viewerPort, createdAt: null })

/** A fake CLI: answers by command, records calls, and lets a test finish a start when it wants. */
function fakeCli() {
  const calls: string[][] = []
  const sandboxes = [sandbox('t1')]
  let finishStart: ((value: { exitCode: number; json: unknown }) => void) | undefined
  let failStart: ((error: Error) => void) | undefined
  let report: unknown = doctor
  let signIn: { exitCode: number; json: unknown } = signedIn
  let startOptions: RunOptions | undefined
  const run: SandboxCli = async (args, options) => {
    calls.push(args)
    switch (args[0]) {
      case 'doctor':
        return { exitCode: 0, json: report }
      case 'list':
        return { exitCode: 0, json: { sandboxes } }
      case 'start':
        startOptions = options
        return new Promise((resolve, reject) => {
          finishStart = resolve
          failStart = reject
        })
      case 'screenshot':
        return { exitCode: 0, json: { path: args[3], width: 1280, height: 800 } }
      case 'record':
        if (args[2] === 'stop') return { exitCode: 0, json: { path: args[4], seconds: 4.2 } }
        return { exitCode: 0, json: { recording: true } }
      case 'view':
        return { exitCode: 0, json: { name: args[1], url: 'http://127.0.0.1:5000/vnc.html#autoconnect=1', websocket: 'ws://127.0.0.1:5000/websockify', password: 'Ab12+Cd3' } }
      case 'exec':
        if (args.includes('--secret')) return signIn
        return { exitCode: 3, json: { exitCode: 3, stdout: 'out', stderr: '' } }
      case 'stop':
        sandboxes[0] = sandbox('t1', 'stopped')
        return { exitCode: 0, json: { stopped: args[1] } }
      default:
        return { exitCode: 0, json: {} }
    }
  }
  return {
    run,
    calls,
    sandboxes,
    progress: (line: string) => startOptions?.onLine?.(line),
    finishStart: (value: { exitCode: number; json: unknown }) => finishStart?.(value),
    failStart: (error: Error) => failStart?.(error),
    setDoctor: (value: unknown) => void (report = value),
    setSignIn: (value: { exitCode: number; json: unknown }) => void (signIn = value),
  }
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'blobby-canvas-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

async function open(fake: ReturnType<typeof fakeCli>) {
  const harness = await createTestCanvas(createCanvas({ cli: fake.run }), { dataRoot: dir, now: () => 1_700_000_000_000 })
  await harness.open('test')
  return harness
}

describe('Blobby Sandbox canvas', () => {
  it('says when the secret that signs VS Code in is missing', async () => {
    const fake = fakeCli()
    fake.setDoctor({ ...doctor, secrets: [] })
    const harness = await open(fake)
    expect(await harness.invoke('test', 'refresh')).toMatchObject({
      account: null,
      problems: ['Signing VS Code in needs the github secret. Run `blobby-sandbox secrets set github --file <test-account file>` in a terminal.'],
    })
    await harness.close()
  })

  it('says when the allowlist refuses secrets', async () => {
    const fake = fakeCli()
    const problem = 'No logins are allowed, so every secret is refused.'
    fake.setDoctor({ ...doctor, allowlist: { allowedLogins: 0, source: 'none', problem } })
    const harness = await open(fake)
    expect(await harness.invoke('test', 'refresh')).toMatchObject({ problems: [problem] })
    await harness.close()
  })

  it('refreshes the backend, the account, and sandboxes from the CLI', async () => {
    const fake = fakeCli()
    const harness = await open(fake)
    const result = await harness.invoke('test', 'refresh')
    expect(result).toMatchObject({ problems: [], backend: 'smolvm', account: 'github', sandboxes: [sandbox('t1')] })
    expect(harness.state('test')).toMatchObject({ backend: 'smolvm', account: 'github', refreshedAt: 1_700_000_000_000 })
    await harness.close()
  })

  it('shows what to fix when the CLI is missing', async () => {
    const harness = await open({
      ...fakeCli(),
      run: async () => {
        throw new CanvasKitError('cli_missing', 'The blobby-sandbox CLI is not installed.', 503)
      },
    })
    await harness.invoke('test', 'refresh')
    expect(harness.state('test')?.problems).toEqual(['The blobby-sandbox CLI is not installed.'])
    await harness.close()
  })

  it('starts a sandbox in the background and shows its progress', async () => {
    const fake = fakeCli()
    const harness = await open(fake)
    expect(await harness.invoke('test', 'start_sandbox', { name: 't2' })).toEqual({ name: 't2', task: 'start-1', state: 'starting' })
    expect(fake.calls.at(-1)).toEqual(['start', 't2'])
    expect(harness.state('test')).toMatchObject({ selected: 't2', tasks: [{ sandbox: 't2', kind: 'start', state: 'running' }] })
    await harness.invoke('test', 'refresh')
    expect(harness.state('test')?.selected).toBe('t2')
    await expect(harness.invoke('test', 'start_sandbox', { name: 't2' })).rejects.toMatchObject({ code: 'busy' })

    fake.progress("t2: Copying the vscode-insiders recipe's base")
    fake.sandboxes.push(sandbox('t2', 'running', 5001))
    fake.finishStart({ exitCode: 0, json: { sandbox: sandbox('t2'), from: 'base', recipe: 'vscode-insiders', info: {}, steps: [{ name: 'Sign in', result: { github: { signedIn: true, verified: true } } }] } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await harness.invoke('test', 'refresh')
    expect(harness.state('test')?.tasks[0]).toMatchObject({
      state: 'done',
      lines: ["Copying the vscode-insiders recipe's base"],
      message: 'Ready, copied from the installed base, signed in to the github test account (allowlisted).',
    })
    await harness.close()
  })

  it('signs a new vscode-insiders sandbox in once it starts, and not one that only starts again', async () => {
    const fake = fakeCli()
    const harness = await open(fake)
    const started = { sandbox: sandbox('t2'), created: true, from: 'base', recipe: 'vscode-insiders', info: {}, steps: [] }
    const waited = harness.invoke('test', 'start_sandbox', { name: 't2', wait: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    fake.finishStart({ exitCode: 0, json: started })
    expect(await waited).toMatchObject({ created: true, task: 'start-1', signIn: { task: 'signin-2', exitCode: 0, result: { github: { signedIn: true, verified: true } } } })
    expect(fake.calls.filter((call) => call[0] === 'exec')).toEqual([['exec', 't2', ...SIGN_IN]])
    expect(harness.state('test')?.tasks.map((task) => [task.kind, task.state, task.message])).toEqual([
      ['signin', 'done', 'Signed in to the github test account (allowlisted).'],
      ['start', 'done', 'Ready, copied from the installed base.'],
    ])

    const again = harness.invoke('test', 'start_sandbox', { name: 't2', wait: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    fake.finishStart({ exitCode: 0, json: { ...started, created: false } })
    expect(await again).not.toHaveProperty('signIn')
    expect(fake.calls.filter((call) => call[0] === 'exec')).toHaveLength(1)
    await harness.close()
  })

  it('never shows a login from a step or command result, in messages, state, or action results', async () => {
    const login = `cl-${Math.random().toString(16).slice(2, 14)}`
    const fake = fakeCli()
    const harness = await open(fake)
    const json = { sandbox: sandbox('t3'), from: 'scratch', recipe: 'my-recipe', info: {}, steps: [{ name: 'Sign in', result: { github: login, other: { signedIn: true, verified: false } } }] }
    const waited = harness.invoke('test', 'start_sandbox', { name: 't3', recipe: 'desktop', wait: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    fake.finishStart({ exitCode: 0, json })
    const result = await waited
    fake.setSignIn({ exitCode: 0, json: { exitCode: 0, stdout: '', stderr: '', result: { github: login } } })
    const again = await harness.invoke('test', 'sign_in', { name: 't3', wait: true })
    await harness.invoke('test', 'refresh')
    expect(result).toMatchObject({ steps: [{ result: { github: '(hidden)', other: { signedIn: true, verified: false } } }] })
    expect(again).toMatchObject({ result: { github: '(hidden)' } })
    expect(harness.state('test')?.tasks[1]?.message).toBe('Ready, installed from scratch, signed in to the other test account (not checked).')
    for (const seen of [result, again, harness.state('test')]) expect(JSON.stringify(seen)).not.toContain(login)
    await harness.close()
  })

  it('passes the recipe and resolution on, and records a failed start and a failed sign-in', async () => {
    const fake = fakeCli()
    const harness = await open(fake)
    await harness.invoke('test', 'start_sandbox', { name: 't2', recipe: 'desktop', resolution: '1600x1000', signin: false })
    expect(fake.calls.at(-1)).toEqual(['start', 't2', '--recipe', 'desktop', '--resolution', '1600x1000'])
    fake.failStart(new CanvasKitError('setup_failed', 'Installing the base failed.', 422))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await harness.invoke('test', 'refresh')
    expect(harness.state('test')?.tasks[0]).toMatchObject({ state: 'failed', message: 'Installing the base failed.' })
    fake.setSignIn({ exitCode: 1, json: { exitCode: 1, stdout: 'running\nerror: GitHub says no.\n', stderr: '' } })
    await harness.invoke('test', 'sign_in', { name: 't2', wait: true })
    expect(fake.calls.filter((call) => call[0] === 'exec')).toEqual([['exec', 't2', ...SIGN_IN]])
    expect(harness.state('test')?.tasks[0]).toMatchObject({ kind: 'signin', state: 'failed', message: 'Signing in failed: error: GitHub says no.' })
    await harness.close()
  })

  it('saves screenshots and recordings in its data folder', async () => {
    const fake = fakeCli()
    const harness = await open(fake)
    const shot = await harness.invoke('test', 'take_screenshot', { name: 't1' })
    expect(shot.path).toMatch(/[/\\]captures[/\\]t1-2023-11-14T22-13-20\.png$/)
    await harness.invoke('test', 'start_recording', { name: 't1', maxSeconds: 30 })
    expect(harness.state('test')?.recording).toEqual(['t1'])
    const saved = await harness.invoke('test', 'stop_recording', { name: 't1' })
    expect(saved).toMatchObject({ seconds: 4.2 })
    expect(harness.state('test')).toMatchObject({ recording: [], captures: [{ kind: 'recording' }, { kind: 'screenshot' }] })
    await harness.close()
  })

  it('gives the viewer the websocket URL and password, and never puts them in state', async () => {
    const fake = fakeCli()
    const harness = await open(fake)
    expect(await harness.invoke('test', 'connect_desktop', { name: 't1' }, 'ui')).toEqual({ url: 'ws://127.0.0.1:5000/websockify', password: 'Ab12+Cd3' })
    expect(JSON.stringify(harness.state('test'))).not.toContain('Ab12')
    await expect(harness.invoke('test', 'connect_desktop', { name: 't1' })).rejects.toBeTruthy()
    await harness.close()
  })

  it('runs commands for the agent, passing the exit code through', async () => {
    const fake = fakeCli()
    const harness = await open(fake)
    expect(await harness.invoke('test', 'run_command', { name: 't1', command: ['ls', '-la'], user: 'root' })).toEqual({ exitCode: 3, stdout: 'out', stderr: '' })
    expect(fake.calls.at(-1)).toEqual(['exec', 't1', '--user', 'root', '--timeout', '600', '--', 'ls', '-la'])
    await harness.close()
  })

  it('rejects names that are not sandbox names', async () => {
    const harness = await open(fakeCli())
    await expect(harness.invoke('test', 'start_sandbox', { name: 'Bad Name' })).rejects.toBeTruthy()
    await harness.close()
  })
})

describe('the CLI runner', () => {
  it('puts --json before the command of exec', () => {
    expect(withJson(['list'])).toEqual(['list', '--json'])
    expect(withJson(['exec', 't1', '--', 'ls', '--json'])).toEqual(['exec', 't1', '--json', '--', 'ls', '--json'])
  })

  it('returns JSON, streams progress, and turns CLI errors into canvas errors', async () => {
    const cli = join(dir, 'cli.js')
    await writeFile(
      cli,
      `const args = process.argv.slice(2)
if (args[0] === 'fail') { process.stderr.write(JSON.stringify({ error: { code: 'not_found', message: 'There is no sandbox named x.' } }) + '\\n'); process.exit(1) }
process.stderr.write('t1: step one\\nt1: step two\\n')
process.stdout.write(JSON.stringify({ args }))`,
    )
    const run = createCli({ ...process.env, BLOBBY_SANDBOX_CLI: cli })
    const lines: string[] = []
    expect(await run(['start', 't1'], { onLine: (line) => lines.push(line) })).toEqual({ exitCode: 0, json: { args: ['start', 't1', '--json'] } })
    expect(lines).toEqual(['t1: step one', 't1: step two'])
    await expect(run(['fail'])).rejects.toMatchObject({ code: 'not_found', message: 'There is no sandbox named x.' })
  })

  it('says how to install the CLI when it is missing', async () => {
    const run = createCli({ ...process.env, BLOBBY_SANDBOX_CLI: join(dir, 'no-such-blobby-sandbox') })
    await expect(run(['list'])).rejects.toMatchObject({ code: 'cli_missing' })
  })
})
