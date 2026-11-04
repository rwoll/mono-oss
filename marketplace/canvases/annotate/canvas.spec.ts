import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canvasTest, expect } from '@rwoll/canvas-kit/playwright'
import canvas from './canvas.ts'
import { screenshotPng } from './fixtures.ts'

const test = canvasTest(canvas)
// Exports run the workspace's CLI; an installed plugin runs the published one.
process.env.ANNOTATE_CLI = fileURLToPath(new URL('../../../packages/annotate/bin/annotate.js', import.meta.url))


function fixture(document?: unknown): { dir: string; doc: string } {
  const dir = mkdtempSync(join(tmpdir(), 'annotate-spec-'))
  writeFileSync(join(dir, 'shot.png'), screenshotPng())
  const doc = join(dir, 'shot.annotate.json')
  if (document) writeFileSync(doc, JSON.stringify(document))
  return { dir, doc }
}
const saved = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as { source: { width?: number }; annotations: { label?: string; box?: number[] }[] }

const DOC = {
  version: 1,
  source: { path: 'shot.png', width: 640, height: 400 },
  annotations: [{ type: 'rect', box: [400, 300, 120, 40], tone: 'problem', label: 'Save button' }],
  narration: [{ t: 0, text: 'The Save button is misaligned' }],
}

test('shows the document, and the user renames and moves a mark', async ({ openCanvas }) => {
  const { doc } = fixture(DOC)
  const { page } = await openCanvas({ path: doc })
  await expect(page.getByRole('heading', { name: 'shot.annotate.json' })).toBeVisible()
  await expect(page.locator('svg text', { hasText: /^Save button$/ })).toBeVisible()
  await expect(page.locator('svg text', { hasText: 'The Save button is misaligned' })).toBeVisible()

  await page.getByRole('button', { name: 'rect Save button always', exact: true }).click()
  await page.getByLabel('Label').fill('Save is misaligned')
  await page.getByLabel('Label').press('Enter')
  await expect.poll(() => saved(doc).annotations[0]?.label).toBe('Save is misaligned')

  await page.getByLabel('Edit').check()
  const handle = page.getByRole('button', { name: 'Move rect Save is misaligned', exact: true })
  const box = await handle.boundingBox()
  if (!box) throw new Error('no handle')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2 - 40, { steps: 5 })
  await page.mouse.up()
  await expect.poll(() => saved(doc).annotations[0]?.box?.[0]).toBeLessThan(380)
})

test('serves the media the page draws', async ({ openCanvas }) => {
  const { doc } = fixture(DOC)
  const { page, state } = await openCanvas({ path: doc })
  const id = (await state())?.media?.source as string
  // The page asks for files by ID with its token, as getCanvasClient().fileUrl(id) does.
  const token = await page.evaluate(() => (JSON.parse(document.getElementById('canvas-kit-bootstrap')?.textContent ?? '{}') as { token: string }).token)
  const response = await page.request.get(new URL(`__canvas/files/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`, page.url()).href)
  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toBe('image/png')
})

test('exports a PNG and tells the agent where it is', async ({ openCanvas, agent }) => {
  const { dir, doc } = fixture(DOC)
  const { page } = await openCanvas({ path: doc })
  await page.getByRole('button', { name: 'PNG' }).click()
  // The document has a timeline (its caption), so the still is named for the time shown.
  const out = join(dir, 'shot-annotated-0.0s.png')
  await expect(page.getByText(out)).toBeVisible()
  expect(readFileSync(out).subarray(1, 4).toString()).toBe('PNG')
  expect(agent.messages.map((message) => message.displayPrompt)).toEqual(['Annotate · exported shot-annotated-0.0s.png'])
})

test('starts a document from an image and reads its size', async ({ openCanvas }) => {
  const { dir, doc } = fixture()
  const { page } = await openCanvas({ path: join(dir, 'shot.png') })
  await expect(page.getByText('640×400')).toBeVisible()
  expect(saved(doc).source.width).toBe(640)
  await page.getByRole('button', { name: '+ Box' }).click()
  await expect(page.getByRole('button', { name: 'rect Note always', exact: true })).toBeVisible()
  await expect.poll(() => saved(doc).annotations.length).toBe(1)
})
