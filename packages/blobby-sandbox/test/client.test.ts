import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { connect as netConnect } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalResolver } from '../src/callbacks/index.ts'
import type { CallbackAnswer } from '../src/callbacks/protocol.ts'
import { connect, type SandboxClient } from '../src/client.ts'
import type { SandboxExecOptions, Sandboxes } from '../src/sandboxes.ts'
import { serve, type Served } from '../src/serve.ts'
import { fakePng } from './fake-guest.ts'
import { ACCOUNT, signInRef, world, type World } from './world.ts'

let w: World
beforeEach(async () => {
  w = await world()
})
afterEach(() => w.cleanup())

/** The same checks, for a client in this process and one talking to `blobby-sandbox serve` over HTTP. */
const modes: [string, () => Promise<{ client: SandboxClient; close(): Promise<void> }>][] = [
  ['in-process', async () => ({ client: connect({ engine: async () => w.engine }), close: async () => {} })],
  [
    'over HTTP',
    async () => {
      const served = await serve({ engine: async () => w.engine, token: 'secret-token' })
      return { client: connect({ server: served.url, token: 'secret-token' }), close: () => served.close() }
    },
  ],
]

describe.each(modes)('a client %s', (_mode, make) => {
  let client: SandboxClient
  let close: () => Promise<void>
  beforeEach(async () => {
    ;({ client, close } = await make())
  })
  afterEach(() => close())

  it('starts a sandbox, follows its progress, and answers its callbacks with sealed secrets', async () => {
    const progress: string[] = []
    const { started } = await client.start('t1', { recipe: signInRef, onProgress: (line) => progress.push(line), onRequest: (request) => w.secrets.answer(request) })
    expect(started).toMatchObject({ created: true, recipe: 'signin-test', steps: [{ result: { github: { signedIn: true, verified: false } } }] })
    expect(progress).toContain('Asking for github.password')
    const step = [...w.guest.steps.values()][0]!
    expect(JSON.stringify(step.raw)).not.toContain(ACCOUNT.password)
    expect(await client.list()).toEqual([expect.objectContaining({ name: 't1', state: 'running' })])
  })

  it('gets screenshots as bytes, and streams recordings to a file, never through a shared disk', async () => {
    await client.start('t1', { onRequest: (request) => w.secrets.answer(request) })
    expect(Buffer.from((await client.screenshot('t1')).png)).toEqual(fakePng(1280, 800))
    w.guest.recordingBytes = randomBytes(9 * 1024 * 1024)
    await client.recordStart('t1')
    const video = await client.recordStop('t1')
    expect(video).toMatchObject({ size: w.guest.recordingBytes.length, sha256: createHash('sha256').update(w.guest.recordingBytes).digest('hex') })
    const saved = await video.save(join(w.dir, 'videos', 'v.mp4'))
    expect((await readFile(saved.path)).equals(w.guest.recordingBytes)).toBe(true)
    // Through one streamed read of the backend's file, not the guest helper, and deleted once saved.
    const reads = w.backend.calls.filter((call) => call.method === 'readFile' && String(call.args[1]).startsWith('/var/tmp/blobby-media/'))
    expect(reads.map((call) => call.args[2])).toEqual([undefined])
    expect(w.guest.operations.filter((operation) => operation.op === 'media.read')).toEqual([])
    expect(w.guest.media.size).toBe(0)
  })

  it('reads byte ranges of a recording, and keeps it when asked', async () => {
    await client.start('t1', { onRequest: (request) => w.secrets.answer(request) })
    w.guest.recordingBytes = randomBytes(64 * 1024)
    await client.recordStart('t1')
    const video = await client.recordStop('t1')
    const chunks: Uint8Array[] = []
    for await (const chunk of video.read({ offset: 100, length: 1000 })) chunks.push(chunk)
    expect(Buffer.concat(chunks).equals(w.guest.recordingBytes.subarray(100, 1100))).toBe(true)
    await video.save(join(w.dir, 'kept.mp4'), { keep: true })
    expect(w.guest.media.size).toBe(1)
    const chunk = await client.mediaRead('t1', video.id, 0, 10)
    expect(Buffer.from(chunk.data).equals(w.guest.recordingBytes.subarray(0, 10))).toBe(true)
    await video.delete()
    expect(w.guest.media.size).toBe(0)
  })

  it('runs a command with a secret, answering its callbacks here, so no value goes to the server in the clear', async () => {
    await client.start('t1', { steps: 'never' })
    const resolver = new LocalResolver({ secrets: w.secrets, env: w.env })
    const chunks: string[] = []
    const result = await client.exec('t1', ['vscode-signin'], { secret: 'github', resolver, onOutput: (chunk) => chunks.push(chunk.text) })
    expect(result).toMatchObject({ exitCode: 0, stdout: 'running vscode-signin\nsigned in as ***\n', result: { github: { signedIn: true, verified: true } } })
    expect(chunks.join('')).not.toContain(ACCOUNT.login)
    const [step] = w.guest.steps.values()
    expect(step!.values.get('github.password')).toEqual({ value: ACCOUNT.password })
    expect(JSON.stringify(step!.raw)).not.toContain(ACCOUNT.password)
    await resolver.release()
  })

  it('waits for an element in the sandbox through the sandbox handle', async () => {
    const sb = await client.start('t1', { steps: 'never' })
    w.guest.a11y = { nodes: [{ path: '0.1', app: 'code-insiders', role: 'push button', name: 'Accounts' }], truncated: false }
    expect(await sb.desktop.waitFor({ app: 'code', match: 'Accounts' })).toMatchObject({ found: true, nodes: [{ path: '0.1' }] })
    await expect(sb.desktop.waitFor({ match: 'Nope', timeoutSeconds: 1 })).rejects.toMatchObject({ code: 'wait_timeout' })
  })

  it('keeps the library\'s error codes', async () => {
    await expect(client.screenshot('missing')).rejects.toMatchObject({ code: 'not_found', message: expect.stringContaining('There is no sandbox named missing') })
    await expect(client.start('Bad Name')).rejects.toMatchObject({ code: 'usage' })
  })

  it('reports failed steps, with the sandbox still there', async () => {
    const error = await client.start('t1', { recipe: signInRef, onRequest: async () => ({ error: 'No, thank you.' }) }).catch((caught: Error) => caught)
    expect(error).toMatchObject({ code: 'step_failed', message: expect.stringContaining('No, thank you.') })
    expect((await client.list()).map((sandbox) => sandbox.name)).toEqual(['t1'])
  })
})

describe('blobby-sandbox serve', () => {
  let served: Served
  let viewer: Server
  let upstreamPaths: string[]
  const sockets = new Set<import('node:stream').Duplex>()
  beforeEach(async () => {
    upstreamPaths = []
    viewer = createServer((req, res) => {
      upstreamPaths.push(`${req.url} host=${req.headers.host}`)
      res.end('<title>noVNC</title>')
    })
    viewer.on('upgrade', (req, socket) => {
      sockets.add(socket)
      upstreamPaths.push(`upgrade ${req.url}`)
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
      socket.on('data', (data) => socket.write(data))
    })
    await new Promise<void>((resolve) => viewer.listen(0, '127.0.0.1', resolve))
    const port = (viewer.address() as { port: number }).port
    w.backend.add('blobby-t1', { state: 'running', ports: [{ host: port, guest: 6901 }] })
    w.guest.ready = true
    served = await serve({ engine: async () => w.engine, token: 'secret-token' })
  })
  afterEach(async () => {
    await served.close()
    for (const socket of sockets) socket.destroy()
    viewer.closeAllConnections()
    await new Promise<void>((resolve) => viewer.close(() => resolve()))
  })

  it('survives requests that are not paths, and upgrades that reset', async () => {
    const port = Number(new URL(served.url).port)
    const raw = (text: string, reset = false) =>
      new Promise<string>((resolve) => {
        const socket = netConnect(port, '127.0.0.1', () => {
          socket.write(text)
          if (reset) socket.resetAndDestroy()
        })
        let reply = ''
        socket.on('data', (data) => (reply += data.toString()))
        socket.on('close', () => resolve(reply))
        socket.on('error', () => resolve(reply))
      })
    expect(await raw('GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')).toMatch(/^HTTP\/1\.1 400/)
    expect(await raw('GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')).toMatch(/^HTTP\/1\.1 400/)
    for (let i = 0; i < 20; i++) await raw('GET /nope HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n', true)
    await expect(connect({ server: served.url, token: 'secret-token' }).list()).resolves.toEqual(expect.any(Array))
  })

  it('refuses clients without its token', async () => {
    await expect(connect({ server: served.url, token: 'wrong' }).list()).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(connect({ server: served.url }).list()).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('relays the viewer, page and WebSocket, at a ticket URL that holds no token', async () => {
    const view = await connect({ server: served.url, token: 'secret-token' }).view('t1')
    const ticket = /\/viewer\/([a-f0-9]{48})\/vnc\.html#/.exec(view.url)?.[1]
    expect(ticket).toBeTruthy()
    expect(view.url).not.toContain('secret-token')
    expect(view.url).toContain(`path=${encodeURIComponent(`viewer/${ticket}/websockify`)}`)
    expect(view.websocket).toBe(`${served.url.replace('http', 'ws')}/viewer/${ticket}/websockify`)
    expect(view.password).toBe('Ab12+Cd3')

    const page = await fetch(view.url.split('#')[0]!)
    expect(await page.text()).toBe('<title>noVNC</title>')
    expect(upstreamPaths[0]).toMatch(/^\/vnc\.html host=127\.0\.0\.1:\d+$/)
    expect((await fetch(`${served.url}/viewer/${'0'.repeat(48)}/vnc.html`)).status).toBe(404)

    const echoed = await new Promise<string>((resolve, reject) => {
      const socket = netConnect(Number(new URL(served.url).port), '127.0.0.1', () => {
        socket.write(`GET /viewer/${ticket}/websockify HTTP/1.1\r\nHost: example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`)
      })
      let text = ''
      socket.on('data', (data) => {
        text += data.toString()
        if (text.includes('\r\n\r\n') && !text.includes('ping')) socket.write('ping')
        if (text.endsWith('ping')) {
          socket.end()
          resolve(text)
        }
      })
      socket.on('error', reject)
    })
    expect(echoed).toMatch(/^HTTP\/1\.1 101 /)
    expect(upstreamPaths).toContain('upgrade /websockify')
  })

  it('relays a viewer that the backend reaches at a URL with headers, only under that URL', async () => {
    const port = (viewer.address() as { port: number }).port
    const seen: string[] = []
    viewer.removeAllListeners('request')
    viewer.on('request', (req, res) => {
      seen.push(`${req.url} ${req.headers.authorization}`)
      res.end('ok')
    })
    viewer.removeAllListeners('upgrade')
    viewer.on('upgrade', (req, socket) => {
      sockets.add(socket)
      seen.push(`upgrade ${req.url} ${req.headers.authorization}`)
      socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    })
    w.backend.endpoint = async () => ({ kind: 'url', url: `http://127.0.0.1:${port}/connect/6901`, headers: { authorization: 'Bearer canary' } })
    const view = await connect({ server: served.url, token: 'secret-token' }).view('t1')
    const base = view.url.split('#')[0]!.replace(/vnc\.html$/, '')
    expect(await (await fetch(`${base}vnc.html?x=1`)).text()).toBe('ok')
    await fetch(`${base}%2F%2Fother/path`)
    await fetch(`${base}..%2F..%2Fadmin`)
    const ticket = /\/viewer\/([a-f0-9]{48})\//.exec(view.url)![1]
    await new Promise<void>((resolve, reject) => {
      const socket = netConnect(Number(new URL(served.url).port), '127.0.0.1', () => {
        socket.write(`GET /viewer/${ticket}/websockify HTTP/1.1\r\nHost: example\r\nAuthorization: Bearer client\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`)
      })
      socket.resume()
      socket.on('close', () => resolve())
      socket.on('error', reject)
    })
    expect(seen[0]).toBe('/connect/6901/vnc.html?x=1 Bearer canary')
    for (const path of seen) expect(path).toMatch(/^(?:upgrade )?\/connect\/6901\//)
    expect(seen).toContain('upgrade /connect/6901/websockify Bearer canary')
  })
})

describe('a viewer in-process', () => {
  it('opens where the engine reaches it, and refuses one that needs credentials a browser can\'t send', async () => {
    w.backend.add('blobby-t1', { state: 'running', ports: [{ host: 5901, guest: 6901, hostIp: '::1' }] })
    const client = connect({ engine: async () => w.engine })
    expect((await client.view('t1')).url).toMatch(/^http:\/\/\[::1\]:5901\/vnc\.html#autoconnect=1/)
    w.backend.endpoint = async () => ({ kind: 'url', url: 'https://example.com/connect/6901', headers: { authorization: 'Bearer canary' } })
    await expect(client.view('t1')).rejects.toMatchObject({ code: 'unsupported' })
  })
})

describe('exec with a secret, through a server that asks for more', () => {
  it('answers only fields of the secret the client chose, and from that secret', async () => {
    await w.secrets.setFile('npm', { login: 'npm-bot', token: 'npm_t0ken-value' })
    const answers: CallbackAnswer[] = []
    // An engine that asks the client for another secret's field, and points the chosen secret at it.
    const engine = {
      exec: async (_name: string, _command: string[], options: SandboxExecOptions) => {
        const step = { id: 'aaaaaaaaaaaaaaaa', name: 'x', uses: ['npm.token', 'github.login'] }
        const context = { sandbox: 't1', feature: 'exec', step, callbacks: { 'npm.token': { sensitive: false }, 'github.login': { sensitive: false } } }
        const ask = (name: string, binding?: string) =>
          options.resolver!.resolve({ id: 'bbbbbbbbbbbbbbbb', name, sensitive: false, sandbox: 't1', feature: 'exec', step: step.id, stepName: 'x' }, { ...context, binding })
        answers.push(await ask('npm.token'), await ask('github.login', 'npm'))
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    }
    const client = connect({ engine: async () => engine as unknown as Sandboxes })
    await client.exec('t1', ['x'], { secret: 'github', resolver: new LocalResolver({ secrets: w.secrets, env: w.env }) })
    expect(answers).toEqual([
      { code: 'not_declared', error: 'This command was given the github secret, not npm.' },
      { value: ACCOUNT.login },
    ])
  })
})

describe('exec with a secret, through a server that knows no values', () => {
  const step = { id: 'aaaaaaaaaaaaaaaa', name: 'x', uses: ['github.password'] }
  const context = { sandbox: 't1', feature: 'exec', step, callbacks: { 'github.password': { sensitive: true } } }
  const request = () => ({
    id: 'bbbbbbbbbbbbbbbb',
    name: 'github.password',
    sensitive: true,
    publicKey: generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }).x!,
    sandbox: 't1',
    feature: 'exec',
    step: step.id,
    stepName: 'x',
  })

  it('never shows a value that the server split across output events', async () => {
    // The server's engine has no values to redact with, and sends a long line in two events.
    const engine = {
      exec: async (_name: string, _command: string[], options: SandboxExecOptions) => {
        await options.resolver!.resolve(request(), context)
        options.onOutput!({ stream: 'stdout', text: `${'x'.repeat(5000)}${ACCOUNT.password.slice(0, 4)}` })
        options.onOutput!({ stream: 'stdout', text: `${ACCOUNT.password.slice(4)} end\n` })
        return { exitCode: 0, stdout: `${'x'.repeat(5000)}${ACCOUNT.password} end\n`, stderr: '' }
      },
    }
    const chunks: string[] = []
    const client = connect({ engine: async () => engine as unknown as Sandboxes })
    const result = await client.exec('t1', ['x'], { secret: 'github', resolver: new LocalResolver({ secrets: w.secrets, env: w.env }), onOutput: (chunk) => chunks.push(chunk.text) })
    expect(chunks.join('')).toBe(`${'x'.repeat(5000)}*** end\n`)
    expect(result.stdout).toBe(`${'x'.repeat(5000)}*** end\n`)
  })

  it('stops waiting for an answer when cancelled, and so does the job', async () => {
    let finished: unknown
    const engine = {
      exec: async (_name: string, _command: string[], options: SandboxExecOptions) => {
        finished = await options.resolver!.resolve(request(), context)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    }
    const controller = new AbortController()
    const client = connect({ engine: async () => engine as unknown as Sandboxes })
    const running = client.exec('t1', ['x'], { secret: 'github', onRequest: () => new Promise<never>(() => {}), signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    await expect(running).rejects.toMatchObject({ code: 'cancelled' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(finished).toEqual({ error: 'The job was cancelled.' })
  })
})
