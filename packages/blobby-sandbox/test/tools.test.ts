import { readdir, readFile } from 'node:fs/promises'
import { inflateSync, crc32 } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connect } from '../src/client.ts'
import { LocalResolver } from '../src/callbacks/index.ts'
import {
  bindTools,
  clientTarget,
  DESKTOP_TOOLS,
  desktopExec,
  desktopInfo,
  desktopInput,
  desktopMediaRead,
  desktopRecordStart,
  desktopRecordStop,
  desktopScreenshot,
  desktopUi,
  engineTarget,
  readMedia,
  SCREENSHOT_AFTER_ERROR,
  toolsFor,
  toToolResultObject,
  type DesktopTarget,
  type ToolResult,
} from '../src/tools/index.ts'
import { signInRecipe, world, type World } from './world.ts'

/** Parses a PNG fully: the signature, every chunk's CRC, and image data of the right size. */
function decodePng(png: Buffer): { width: number; height: number } {
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  let offset = 8
  let header: Buffer | null = null
  const data: Buffer[] = []
  for (;;) {
    const length = png.readUInt32BE(offset)
    const type = png.subarray(offset + 4, offset + 8).toString('latin1')
    const body = png.subarray(offset + 8, offset + 8 + length)
    expect(png.readUInt32BE(offset + 8 + length)).toBe(crc32(png.subarray(offset + 4, offset + 8 + length)))
    offset += 12 + length
    if (type === 'IHDR') header = body
    if (type === 'IDAT') data.push(body)
    if (type === 'IEND') break
  }
  expect(offset).toBe(png.length)
  const width = header!.readUInt32BE(0)
  const height = header!.readUInt32BE(4)
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[header![9]!]!
  expect(inflateSync(Buffer.concat(data)).length).toBe(height * (1 + width * channels * (header![8]! / 8)))
  return { width, height }
}

let w: World
let target: DesktopTarget
beforeEach(async () => {
  w = await world()
  await w.engine.start('t1', { resolver: new LocalResolver({ secrets: w.secrets, env: w.env }) })
  target = engineTarget(w.engine, 't1')
})
afterEach(() => w.cleanup())

const call = (tool: (typeof DESKTOP_TOOLS)[number], input: unknown, options = {}) => tool.createHandler(target, options)(input)
const guestOps = (op: string) => w.guest.operations.filter((operation) => operation.op === op).map((operation) => operation.options)

describe('toolsFor', () => {
  it('has desktop tools only for sandboxes with the desktop feature', () => {
    expect(toolsFor(['vscode-insiders'])).toEqual([])
    expect(toolsFor(['desktop', 'vscode-insiders']).map((tool) => tool.name)).toEqual([
      'desktop_screenshot',
      'desktop_input',
      'desktop_ui',
      'desktop_exec',
      'desktop_record_start',
      'desktop_record_stop',
      'desktop_media_read',
      'desktop_info',
    ])
  })

  it('tells the agent to take a fresh screenshot after any error', async () => {
    for (const tool of DESKTOP_TOOLS) expect(tool.description).toContain(SCREENSHOT_AFTER_ERROR)
    const failed = await call(desktopInput, { action: 'click', x: 1 })
    expect(failed).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(failed.text).toContain('take a fresh screenshot')
  })

  it('binds tools to a desktop, with JSON Schema parameters for runtimes that take them', () => {
    const bound = bindTools(toolsFor(['desktop']), target)
    expect(bound.find((tool) => tool.name === 'desktop_input')!.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: { action: { enum: ['click', 'move', 'type', 'key', 'scroll'] } },
    })
  })
})

describe('desktop tools on the engine', () => {
  it('desktop_screenshot returns a real PNG as an image, with its size', async () => {
    const result = await call(desktopScreenshot, {})
    expect(result).toMatchObject({ ok: true, json: { width: 1280, height: 800 }, binary: [{ type: 'image', mimeType: 'image/png' }] })
    expect(decodePng(Buffer.from(result.binary[0]!.data, 'base64'))).toEqual({ width: 1280, height: 800 })
    expect(toToolResultObject(result)).toEqual({
      textResultForLlm: 'Screenshot of the desktop, 1280x800 pixels.',
      binaryResultsForLlm: [{ type: 'image', mimeType: 'image/png', data: result.binary[0]!.data, description: 'Desktop screenshot, 1280x800' }],
      resultType: 'success',
    })
  })

  it('desktop_input clicks, types, presses keys, scrolls, and moves', async () => {
    const inputs: [unknown, unknown][] = [
      [{ action: 'click', x: 10, y: 20 }, { click: [10, 20], button: 'left', double: false }],
      [{ action: 'click', x: 10, y: 20, button: 'right', double: true, instant: true }, { click: [10, 20], button: 'right', double: true, instant: true }],
      [{ action: 'type', text: 'hello' }, { type: 'hello' }],
      [{ action: 'key', keys: 'ctrl+l' }, { key: 'ctrl+l' }],
      [{ action: 'scroll', dy: 3 }, { scroll: [0, 3] }],
      [{ action: 'scroll', dx: -1, dy: 2, x: 5, y: 6 }, { scroll: [-1, 2], at: [5, 6] }],
      [{ action: 'move', x: 1, y: 2 }, { move: [1, 2] }],
    ]
    for (const [input] of inputs) expect(await call(desktopInput, input)).toMatchObject({ ok: true, text: expect.stringContaining('Take a screenshot') })
    expect(guestOps('input')).toEqual(inputs.map(([, action]) => action))
    expect(await call(desktopInput, { action: 'type' })).toMatchObject({ error: { code: 'invalid_input', message: 'type needs text.' } })
    expect(await call(desktopInput, { action: 'scroll', dy: 1, x: 3 })).toMatchObject({ error: { code: 'invalid_input' } })
    expect(await call(desktopInput, { action: 'jump' })).toMatchObject({ error: { code: 'invalid_input' } })
    expect(await call(desktopInput, { action: 'key', keys: 'a', extra: 1 })).toMatchObject({ error: { code: 'invalid_input' } })
  })

  it('desktop_ui lists elements, and acts on one by path', async () => {
    w.guest.a11y = { nodes: [{ path: '0.1', app: 'code', role: 'push button', name: 'Accounts', box: [1, 2, 3, 4] }], truncated: true }
    const listed = await call(desktopUi, { app: 'code', match: 'Acc' })
    expect(listed).toMatchObject({ ok: true, json: { truncated: true, nodes: [{ path: '0.1' }] } })
    expect(listed.text).toBe('0.1  push button "Accounts" at 1,2,3,4\n(more elements: narrow with app or match, or raise max)')
    expect(guestOps('ui.snapshot')).toEqual([{ app: 'code', match: 'Acc', max: 300 }])
    expect(await call(desktopUi, { path: '0.1' })).toMatchObject({ ok: true, json: { path: '0.1', name: 'Accounts', did: 'press' } })
    expect(await call(desktopUi, { path: '0.1', do: 'set' })).toMatchObject({ error: { code: 'invalid_input' } })
  })

  it('desktop_exec runs as the desktop user, and as root only when the host allows it', async () => {
    const execs = () => w.backend.calls.filter((entry) => entry.method === 'exec' && (entry.args[1] as string[]).includes('exec'))
    w.backend.calls.length = 0
    expect(await call(desktopExec, { command: ['xdotool', 'getactivewindow'] })).toMatchObject({ ok: true, json: { exitCode: 0 } })
    expect(execs().map((entry) => (entry.args[2] as { user: string }).user)).toEqual(['ubuntu'])
    expect(await call(desktopExec, { command: ['apt-get', 'update'], root: true })).toMatchObject({ ok: false, error: { code: 'root_not_allowed' } })
    expect(await call(desktopExec, { command: ['apt-get', 'update'], root: true }, { allowRoot: true })).toMatchObject({ ok: true })
    expect(execs().map((entry) => (entry.args[2] as { user: string }).user)).toEqual(['ubuntu', 'root'])
  })

  it('desktop_exec returns the end of long output', async () => {
    const long: DesktopTarget = { ...target, exec: async () => ({ exitCode: 3, stdout: `${'a'.repeat(100)}END`, stderr: 'oops' }) }
    const result = await desktopExec.createHandler(long, { maxOutputBytes: 10 })({ command: ['x'] })
    expect(result).toMatchObject({ ok: true, json: { exitCode: 3, stdout: 'aaaaaaaEND', stderr: 'oops', truncated: true } })
    expect(result.text).toBe('Exit code 3.\nstdout (end):\naaaaaaaEND\nstderr:\noops')
  })

  it('records, and reads the recording in chunks', async () => {
    w.guest.recordingBytes = Buffer.from('0123456789abcdefghij')
    expect(await call(desktopRecordStart, { maxSeconds: 30 })).toMatchObject({ ok: true, json: { maxSeconds: 30 } })
    const stopped = await call(desktopRecordStop, {})
    expect(stopped).toMatchObject({ ok: true, json: { size: 20, seconds: 3.5 } })
    const id = stopped.json.id as string
    const first = await call(desktopMediaRead, { id, length: 8 })
    expect(first).toMatchObject({ ok: true, json: { offset: 0, bytes: 8, nextOffset: 8, eof: false }, binary: [{ type: 'resource', mimeType: 'video/mp4' }] })
    expect(Buffer.from(first.binary[0]!.data, 'base64').toString()).toBe('01234567')
    expect(await call(desktopMediaRead, { id, offset: 16 })).toMatchObject({ json: { bytes: 4, eof: true } })
    const chunks: Buffer[] = []
    for await (const chunk of readMedia(target, id, { chunkBytes: 7 })) chunks.push(Buffer.from(chunk))
    expect(chunks.map((chunk) => chunk.toString())).toEqual(['0123456', '789abcd', 'efghij'])
    expect(await call(desktopMediaRead, { id: 'ffffffffffffffff' })).toMatchObject({ ok: false, error: { code: 'not_found' } })
  })

  it('desktop_info describes the sandbox', async () => {
    expect(await call(desktopInfo, {})).toMatchObject({ ok: true, text: 'Sandbox t1 is running.', json: { name: 't1', state: 'running' } })
    expect(await desktopInfo.createHandler(engineTarget(w.engine, 'nope'))({})).toMatchObject({ ok: false, error: { code: 'not_found' } })
  })
})

describe('while a step that handles secrets runs', () => {
  it('the desktop tools keep working', async () => {
    let during: ToolResult[] = []
    const resolver = new LocalResolver({ secrets: w.secrets, env: w.env })
    // The tools' sandbox again, from a recipe with a step that signs in.
    await w.engine.remove('t1')
    await w.engine.start('t1', {
      recipe: signInRecipe,
      onRequest: async (request, context) => {
        if (request.sensitive && !during.length) during = await Promise.all([call(desktopScreenshot, {}), call(desktopInput, { action: 'key', keys: 'a' }), call(desktopExec, { command: ['true'] }), call(desktopUi, {})])
        return resolver.resolve(request, context)
      },
    })
    await resolver.release()
    expect(during.map((result) => result.ok)).toEqual([true, true, true, true])
  })
})

describe('desktop tools through a client', () => {
  it('drive the same desktop, and keep recordings in the sandbox until read', async () => {
    const remote = clientTarget(connect({ engine: async () => w.engine }), 't1')
    const shot = await desktopScreenshot.createHandler(remote)({})
    expect(decodePng(Buffer.from(shot.binary[0]!.data, 'base64'))).toEqual({ width: 1280, height: 800 })
    w.guest.recordingBytes = Buffer.from('video')
    await desktopRecordStart.createHandler(remote)({})
    const stopped = await desktopRecordStop.createHandler(remote)({})
    const read = await desktopMediaRead.createHandler(remote)({ id: stopped.json.id })
    expect(Buffer.from(read.binary[0]!.data, 'base64').toString()).toBe('video')
    expect(await desktopInfo.createHandler(remote)({})).toMatchObject({ json: { name: 't1', state: 'running' } })
  })
})

describe('package', () => {
  it('loads ./callbacks and ./tools without the engine, the client, or an agent SDK', async () => {
    const sources = [...(await readdir(new URL('../src/callbacks/', import.meta.url))).map((file) => `callbacks/${file}`), ...(await readdir(new URL('../src/tools/', import.meta.url))).map((file) => `tools/${file}`)]
    for (const source of sources) {
      const text = await readFile(new URL(`../src/${source}`, import.meta.url), 'utf8')
      const imports = [...text.matchAll(/^import (?!type )[^']*?'([^']+)'/gm)].map((match) => match[1])
      expect([source, imports.filter((name) => /sandboxes|client|router|@trpc|playwright|copilot/.test(name!))]).toEqual([source, []])
    }
  })

  it('exports ./callbacks and ./tools', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { exports: Record<string, { default: string }> }
    expect(manifest.exports['./callbacks']).toEqual({ types: './dist/callbacks/index.d.ts', default: './dist/callbacks/index.js' })
    expect(manifest.exports['./tools']).toEqual({ types: './dist/tools/index.d.ts', default: './dist/tools/index.js' })
  })
})
