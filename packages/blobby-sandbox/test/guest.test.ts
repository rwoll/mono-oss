import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// The real guest helper, run with python3, its memory folder in a temporary one, and a fake xdotool.
const GUEST = fileURLToPath(new URL('../runtime/guest.py', import.meta.url))

let dir: string
let shm: string
let log: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'blobby-guest-'))
  shm = join(dir, 'shm')
  log = join(dir, 'xdotool.log')
  await mkdir(join(dir, 'bin'))
  await mkdir(shm)
  await writeFile(
    join(dir, 'bin', 'xdotool'),
    `#!/bin/sh\nif [ "$1" = getmouselocation ]; then echo X=100; echo Y=100; exit 0; fi\necho "$*" >> '${log}'\n`,
    { mode: 0o755 },
  )
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const guest = (...args: string[]) =>
  spawnSync('python3', [GUEST, ...args], { encoding: 'utf8', env: { ...process.env, BLOBBY_SHM: shm, PATH: `${join(dir, 'bin')}:${process.env.PATH}` } })
const json = (...args: string[]) => JSON.parse(guest(...args).stdout) as Record<string, unknown>

describe('exec', () => {
  it('runs the command as itself, with its output and exit code', () => {
    const result = guest('exec', '--', 'sh', '-c', 'echo out; echo err >&2; exit 3')
    expect([result.status, result.stdout, result.stderr]).toEqual([3, 'out\n', 'err\n'])
  })

  it('puts the scripts library first on the command\'s PATH', () => {
    expect(guest('exec', '--', 'sh', '-c', 'echo "$PATH"').stdout).toMatch(/^\/opt\/blobby\/runtime\/scripts:/)
  })
})

describe('the scripts library', () => {
  const SCRIPTS = fileURLToPath(new URL('../runtime/scripts/', import.meta.url))
  // Only the system's own folders, so no test can find a VS Code installed on this computer.
  const script = (name: string, ...args: string[]) =>
    spawnSync(join(SCRIPTS, name), args, { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: dir } })

  it('lists itself, and each script says how to use it', () => {
    const listed = JSON.parse(script('blobby-scripts', '--json').stdout) as { name: string; description: string }[]
    expect(listed.map((entry) => entry.name)).toEqual(['blobby-scripts', 'vscode-open', 'vscode-signin', 'vscode-update'])
    expect(listed.every((entry) => entry.description.length > 20)).toBe(true)
    for (const name of ['vscode-open', 'vscode-update']) expect(script(name, '--help')).toMatchObject({ status: 0, stdout: expect.stringMatching(/^Usage: blobby-sandbox exec <name>/) })
  })

  it('says what to do when run as the wrong user or without VS Code', () => {
    expect(script('vscode-update')).toMatchObject({ status: 2, stderr: expect.stringContaining('exec <name> --root -- vscode-update') })
    expect(script('vscode-open')).toMatchObject({ status: 1, stderr: expect.stringContaining('--recipe vscode-insiders') })
    expect(script('vscode-update', '--bogus')).toMatchObject({ status: 2, stderr: expect.stringContaining('Usage:') })
  })
})

describe('ui.wait', () => {
  it('needs text to match, before it touches the accessibility tree', () => {
    expect(json('ui.wait', '{}')).toMatchObject({ ok: false, code: 'usage', error: expect.stringContaining('needs match') })
  })
})

describe('step.start with argv', () => {
  const id = 'abcdef0123456789'
  async function finish(): Promise<Record<string, unknown>> {
    let output = ''
    let outputOffset = 0
    for (let tries = 0; tries < 100; tries++) {
      const poll = json('step.poll', JSON.stringify({ id, offset: 0, outputOffset }))
      output += String(poll.output)
      outputOffset = Number(poll.outputOffset)
      if (poll.exit !== null) return { ...poll, output }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('the step did not finish')
  }

  it('runs any command with the secret\'s name and the scripts library, and streams its output', async () => {
    const argv = ['sh', '-c', 'echo "secret=$BLOBBY_SECRET"; case "$PATH" in /opt/blobby/runtime/scripts:*) echo scripts;; esac; exit 3']
    expect(json('step.start', JSON.stringify({ id, sandbox: 't1', callbacks: {}, argv, secret: 'github' }))).toEqual({ ok: true })
    const done = await finish()
    expect(done).toMatchObject({ exit: 3 })
    expect(done.output).toBe('secret=github\nscripts\n')
  })

  it('refuses a bad argv or secret name', () => {
    expect(json('step.start', JSON.stringify({ id, sandbox: 't1', argv: [] }))).toMatchObject({ ok: false, code: 'usage' })
    expect(json('step.start', JSON.stringify({ id, sandbox: 't1', argv: ['true'], secret: '../x' }))).toMatchObject({ ok: false, code: 'usage' })
  })
})

describe('input', () => {
  const commands = async () => (await readFile(log, 'utf8')).trim().split('\n')

  it('glides the pointer like a hand: many small moves with pauses, ending exactly on target', async () => {
    expect(json('input', '{"click": [700, 500]}')).toEqual({ ok: true })
    const words = (await commands())[0]!.split(' ')
    const moves = words.flatMap((word, index) => (word === 'mousemove' ? [[Number(words[index + 1]), Number(words[index + 2])]] : []))
    expect(moves.length).toBeGreaterThan(20)
    expect(moves.at(-1)).toEqual([700, 500])
    // Never a jump: each move covers a small part of the way.
    const longest = Math.max(...moves.slice(1).map(([x, y], index) => Math.hypot(x! - moves[index]![0]!, y! - moves[index]![1]!)))
    expect(longest).toBeLessThan(80)
    expect(words.filter((word) => word === 'sleep').length).toBeGreaterThan(20)
    // The button is held for a moment, not clicked in no time.
    expect(words.join(' ')).toMatch(/mousedown 1 sleep 0\.\d+ mouseup 1$/)
  })

  it('jumps and clicks at once with instant', async () => {
    expect(json('input', '{"click": [700, 500], "instant": true, "double": true, "button": "right"}')).toEqual({ ok: true })
    expect(await commands()).toEqual(['mousemove --sync 700 500 click --repeat 2 3'])
  })
})
