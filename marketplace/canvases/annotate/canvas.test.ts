import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestCanvas, type TestCanvas } from '@rwoll/canvas-kit/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CanvasClient } from '@rwoll/canvas-kit/client'
import canvas, { ANNOTATE_VERSION, cliCommand, feedbackPrompt } from './canvas.ts'
import { screenshotPng } from './fixtures.ts'

const CLI = fileURLToPath(new URL('../../../packages/annotate/bin/annotate.js', import.meta.url))

describe('Annotate canvas', () => {
  let dir: string
  let harness: TestCanvas<typeof canvas> | undefined
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'annotate-canvas-'))
    await writeFile(join(dir, 'shot.png'), screenshotPng())
  })
  afterEach(async () => {
    await harness?.close()
    harness = undefined
    await rm(dir, { recursive: true, force: true })
  })

  const docPath = () => join(dir, 'shot.annotate.json')
  const saved = async () => JSON.parse(await readFile(docPath(), 'utf8')) as Record<string, unknown>
  let pageUrl = ''
  async function open(path = join(dir, 'shot.png')) {
    harness = await createTestCanvas(canvas)
    pageUrl = (await harness.open('a', { path })).url
    return harness
  }
  /** Fetches a file the way the page does: by ID, with the page's token. */
  async function fetchFile(id: string) {
    const html = await (await fetch(pageUrl)).text()
    const bootstrap = JSON.parse(/<script type="application\/json" id="canvas-kit-bootstrap">(.*?)<\/script>/s.exec(html)?.[1] as string)
    const client = new CanvasClient({ ...bootstrap, base: new URL(pageUrl).pathname })
    return fetch(new URL(client.fileUrl(id), pageUrl))
  }

  it('starts a document next to an image and serves the image to the page', async () => {
    const h = await open()
    expect(await saved()).toEqual({ version: 1, source: { path: 'shot.png' }, annotations: [] })
    const state = h.state('a')
    expect(state?.path).toBe(docPath())
    const id = state?.media?.source as string
    expect(id).toMatch(/^source-\d+\.png$/)
    const served = await fetchFile(id)
    expect([served.status, served.headers.get('content-type')]).toEqual([200, 'image/png'])
    // Only the document's own media, by the IDs in its state.
    expect((await fetchFile('source-1.png')).status).toBe(404)
    await h.invoke('a', 'media_info', { width: 640, height: 400 }, 'ui')
    expect(await saved()).toMatchObject({ source: { path: 'shot.png', width: 640, height: 400 } })
  })

  it('edits annotations by id or index, validating every change before saving', async () => {
    const h = await open()
    const result = await h.invoke('a', 'add_annotations', { annotations: [{ type: 'rect', box: [400, 300, 120, 40], label: 'Save' }, { type: 'arrow', from: [100, 100], to: 'rect-1' }] })
    expect(result).toMatchObject({ ids: ['rect-1', 'arrow-2'] })
    await h.invoke('a', 'update_annotation', { target: 'rect-1', changes: { label: 'Save button', tone: 'problem', step: true } }, 'ui')
    await h.invoke('a', 'update_annotation', { target: 0, changes: { step: null } })
    expect((await saved()).annotations).toEqual([
      { type: 'rect', id: 'rect-1', box: [400, 300, 120, 40], label: 'Save button', tone: 'problem' },
      { type: 'arrow', id: 'arrow-2', from: [100, 100], to: 'rect-1' },
    ])
    await expect(h.invoke('a', 'update_annotation', { target: 'rect-1', changes: { box: [0, 0, -5, 10] } })).rejects.toThrow(/would not be valid/)
    expect((await saved()).annotations).toHaveLength(2)
    await h.invoke('a', 'remove_annotations', { targets: ['arrow-2'] })
    expect(h.state('a')?.document?.annotations.map((a) => a.id)).toEqual(['rect-1'])
  })

  it('reports problems such as captions too fast to read', async () => {
    const h = await open()
    await h.invoke('a', 'set_narration', { narration: [{ t: 0, text: 'A caption far too long to read in the half second before the next one' }, { t: 0.5, text: 'Next' }] })
    expect(h.state('a')?.issues).toEqual([expect.objectContaining({ level: 'warning', path: 'narration.0' })])
  })

  it('applies an edit to the file as it is now, keeping changes made outside the canvas', async () => {
    const h = await open()
    await writeFile(docPath(), JSON.stringify({ version: 1, source: { path: 'shot.png' }, annotations: [{ id: 'outside', type: 'callout', at: [10, 10], text: 'From the agent' }] }))
    await utimes(docPath(), new Date(), new Date(Date.now() + 5_000))
    await h.invoke('a', 'add_annotations', { annotations: [{ type: 'rect', box: [1, 1, 10, 10] }] })
    expect((await saved()).annotations).toEqual([expect.objectContaining({ id: 'outside' }), expect.objectContaining({ type: 'rect' })])
  })

  it('reloads the document when the file changes outside the canvas', async () => {
    const h = await open()
    await writeFile(docPath(), JSON.stringify({ version: 1, source: { path: 'shot.png' }, annotations: [{ type: 'callout', at: [10, 10], text: 'From the agent' }] }))
    await utimes(docPath(), new Date(), new Date(Date.now() + 5_000))
    await h.runJob('watch_file')
    expect(h.state('a')?.document?.annotations).toEqual([{ type: 'callout', at: [10, 10], text: 'From the agent' }])
    await writeFile(docPath(), '{ not json')
    await utimes(docPath(), new Date(), new Date(Date.now() + 10_000))
    await h.runJob('watch_file')
    expect(h.state('a')).toMatchObject({ document: null, error: expect.stringMatching(/Could not read shot\.annotate\.json/) })
  })

  it('exports with the CLI and tells the agent where the file is', async () => {
    process.env.ANNOTATE_CLI = CLI
    try {
      const h = await open()
      await h.invoke('a', 'add_annotations', { annotations: [{ type: 'rect', box: [400, 300, 120, 40], label: 'Save' }] })
      const result = await h.invoke('a', 'export', { format: 'png' }, 'ui')
      const out = join(dir, 'shot-annotated.png')
      expect(result).toEqual({ path: out })
      expect((await readFile(out)).subarray(1, 4).toString()).toBe('PNG')
      expect(h.state('a')).toMatchObject({ exporting: null, exportError: null, exports: [{ path: out, format: 'png' }] })
      expect(h.sentToAgent).toEqual([expect.objectContaining({ prompt: expect.stringContaining(out), displayPrompt: 'Annotate · exported shot-annotated.png' })])

      // A still document has no video to render; the error is kept for the page.
      expect(await h.invoke('a', 'export', { format: 'mp4' })).toEqual({ error: expect.stringMatching(/no timeline/) })
      expect(h.state('a')?.exportError).toMatch(/no timeline/)

      // Never over the document's own media.
      await expect(h.invoke('a', 'export', { format: 'png', out: 'shot.png' })).rejects.toThrow(/own files/)
    } finally {
      delete process.env.ANNOTATE_CLI
    }
  })

  it.skipIf(spawnSync('ffmpeg', ['-version']).status !== 0)('makes an MP4 preview of a recording the page cannot play', async () => {
    process.env.ANNOTATE_CLI = CLI
    try {
      const webm = join(dir, 'clip.webm')
      expect(spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x200:rate=10:duration=1', '-c:v', 'libvpx-vp9', webm]).status).toBe(0)
      const h = await open(webm)
      expect(h.state('a')?.media?.preview).toBeUndefined()
      const { id } = (await h.invoke('a', 'preview', {}, 'ui')) as { id: string }
      expect(id).toMatch(/^preview-[0-9a-f]{24}\.mp4$/)
      expect(h.state('a')?.media?.preview).toBe(id)
      const served = await fetchFile(id)
      expect([served.status, served.headers.get('content-type')]).toEqual([200, 'video/mp4'])
      // The preview survives saves, so the page keeps playing it.
      await h.invoke('a', 'media_info', { width: 320, height: 200 }, 'ui')
      expect(h.state('a')?.media?.preview).toBe(id)
    } finally {
      delete process.env.ANNOTATE_CLI
    }
  })

  it('runs the pinned CLI with npx, or ANNOTATE_CLI', () => {
    expect(cliCommand({ ANNOTATE_CLI: '/x/bin/annotate.js' })).toEqual({ command: process.execPath, args: ['/x/bin/annotate.js'] })
    expect(cliCommand({ ANNOTATE_CLI: 'annotate' })).toEqual({ command: 'annotate', args: [] })
    if (ANNOTATE_VERSION === '0.0.0') expect(() => cliCommand({})).toThrow(/not published yet/)
    else expect(cliCommand({}).args).toEqual(['--yes', `@rwoll/annotate@${ANNOTATE_VERSION}`])
  })

  it('sends the user’s feedback with the selected annotation', async () => {
    const h = await open()
    await h.invoke('a', 'add_annotations', { annotations: [{ type: 'rect', box: [400, 300, 120, 40], label: 'Save' }] })
    await h.invoke('a', 'send_feedback', { text: 'Make this red', target: 0 }, 'ui')
    expect(h.sentToAgent.at(-1)?.prompt).toBe(feedbackPrompt(docPath(), 'Make this red', { type: 'rect', id: 'rect-1', box: [400, 300, 120, 40], label: 'Save' }))
  })

  it('opens an existing document and reports one it cannot read', async () => {
    await writeFile(join(dir, 'bad.json'), JSON.stringify({ version: 2 }))
    const h = await open(join(dir, 'bad.json'))
    expect(h.state('a')).toMatchObject({ document: null, media: null, error: expect.stringMatching(/version/) })
    await expect(h.invoke('a', 'add_annotations', { annotations: [{ type: 'callout', at: [1, 1], text: 'x' }] })).rejects.toThrow(/Could not read/)
  })
})
