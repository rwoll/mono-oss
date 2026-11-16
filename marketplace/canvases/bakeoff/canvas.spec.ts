import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canvasTest, expect } from '@rwoll/canvas-kit/playwright'
import { screenshotPng } from '../annotate/fixtures.ts'
import canvas from './canvas.ts'

const test = canvasTest(canvas)

const MARKDOWN = '## Add the canvas\n\n| Phase | From |\n| --- | --- |\n| Draft | Opened |\n\nThe **validation log** is long.'
// A mock that tries to run a script, and that follows the color scheme it is shown in.
const HTML =
  '<style>:root{color-scheme:light dark}body{background:light-dark(rgb(255, 255, 255), rgb(0, 0, 0))}</style><button>Ask the agent</button><script>document.body.append("script ran")</script>'

/** A 640×400 PNG on disk, as an agent would have made it. */
function image(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'bakeoff-spec-')), 'shot.png')
  writeFileSync(path, screenshotPng())
  return path
}

test('shows images blind, keeps one winner, and pins a note to a spot', async ({ openCanvas, agent }) => {
  const { page, state } = await openCanvas({ id: 'logo', title: 'Logo for the README', brief: 'Blobby plus one prop.' })
  await expect(page.getByRole('heading', { name: 'Bakeoff · Logo for the README' })).toBeVisible()
  await expect(page.getByText('No variants yet.')).toBeVisible()

  await agent.invoke('add_variants', {
    variants: [
      { path: image(), approach: 'chart in a card', models: ['claude-opus-5.5'], credits: 3 },
      { path: image(), approach: 'arrow', models: ['gpt-6-sol'], credits: 1.5 },
    ],
  })
  const a = page.getByRole('article', { name: 'Variant A' })
  const b = page.getByRole('article', { name: 'Variant B' })
  await expect.poll(() => a.getByRole('img', { name: 'Variant A' }).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(640)
  await expect(page.getByText('Asked for: Blobby plus one prop.')).toBeVisible()

  // What made each variant stays hidden until Blind is off; the round's total cost does not give it away.
  await expect(page.getByText('claude-opus-5.5')).toBeHidden()
  await expect(page.getByRole('region', { name: 'Decide' })).toContainText("4.5 AIC to make this round's 2 variants")
  await page.getByLabel('Blind').uncheck()
  await expect(a.getByText('chart in a card · claude-opus-5.5 · 3 AIC')).toBeVisible()
  await expect(b.getByText('arrow · gpt-6-sol · 1.5 AIC')).toBeVisible()

  await a.getByRole('button', { name: 'Pick' }).click()
  await expect(a.getByText('Winner')).toBeVisible()
  await b.getByRole('button', { name: 'Pick' }).click()
  await expect(b.getByText('Winner')).toBeVisible()
  await expect(a.getByRole('button', { name: 'Keep' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'Use B' })).toBeEnabled()

  // A click on the image pins a numbered spot, and the note continues from its number.
  const box = await a.getByRole('img', { name: 'Variant A' }).boundingBox()
  if (!box) throw new Error('no image')
  await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.5)
  await expect(a.getByRole('button', { name: 'Remove pin 1' })).toBeVisible()
  const note = a.getByLabel('Note on A')
  await expect(note).toBeFocused()
  await expect(note).toHaveValue('[1] ')
  await page.keyboard.type('too busy here')
  await page.getByLabel('Overall feedback').fill("A's layout")
  await page.getByLabel('Overall feedback').blur()
  await expect.poll(() => state()?.rounds[0]?.entries[0]).toMatchObject({ note: '[1] too busy here', marks: [{ n: 1 }] })
  expect(state()?.rounds[0]?.entries[0]?.marks[0]).toMatchObject({ x: expect.closeTo(0.25, 1), y: expect.closeTo(0.5, 1) })
  await expect.poll(() => state()?.rounds[0]?.overall).toBe("A's layout")

  await a.getByRole('button', { name: 'Remove pin 1' }).click()
  await expect(a.getByRole('button', { name: 'Remove pin 1' })).toBeHidden()
  await expect(note).toHaveValue('[1] too busy here')

  // Canvases live in narrow side panels: nothing may push the page wider than the panel.
  await page.setViewportSize({ width: 360, height: 800 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
})

test('renders Markdown, quotes selected text, and shows HTML mocks without running them', async ({ openCanvas, agent }) => {
  const { page, state } = await openCanvas({ id: 'description', title: 'PR description' })
  await agent.invoke('add_variants', { variants: [{ content: MARKDOWN }, { content: HTML, kind: 'html' }] })
  const a = page.getByRole('article', { name: 'Variant A' })
  await expect(a.getByRole('columnheader', { name: 'Phase' })).toBeVisible()
  await expect(a.getByRole('cell', { name: 'Opened' })).toBeVisible()

  await a.getByText('validation log').dblclick()
  await a.getByRole('button', { name: 'Comment on the selected text' }).click()
  await expect(a.getByRole('list', { name: 'Quotes from A' })).toContainText('validation')
  await expect(a.getByLabel('Note on A')).toHaveValue('[1] ')
  await expect.poll(() => state()?.rounds[0]?.entries[0]?.marks).toEqual([{ n: 1, quote: 'validation' }])
  await a.getByRole('button', { name: 'Remove quote 1' }).click()
  await expect(a.getByRole('list', { name: 'Quotes from A' })).toBeHidden()

  // The mock draws, in the backdrop's color scheme, but its script never runs.
  const frame = page.frameLocator('iframe[title="Variant B"]')
  await expect(page.locator('iframe[title="Variant B"]')).toHaveAttribute('sandbox', '')
  await expect(frame.getByRole('button', { name: 'Ask the agent' })).toBeVisible()
  await expect(frame.getByText('script ran')).toHaveCount(0)
  // Forced colors replace a page's own backgrounds, in the mock as everywhere else.
  if (!(await page.evaluate(() => matchMedia('(forced-colors: active)').matches))) {
    await expect(frame.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    await page.getByRole('group', { name: 'Backdrop' }).getByRole('button', { name: 'Dark' }).click()
    await expect(frame.locator('body')).toHaveCSS('background-color', 'rgb(0, 0, 0)')
  }

  // Expanded, the mock fills the panel, and a click in it does not take the keys away.
  await page.getByRole('button', { name: 'Expand B' }).click()
  const expanded = page.getByRole('dialog', { name: 'Variant B, expanded' })
  await expanded.locator('iframe').click({ position: { x: 200, y: 200 } })
  await expect(expanded).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('dialog', { name: 'Variant A, expanded' }).getByRole('columnheader', { name: 'Phase' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()

  await page.getByRole('button', { name: 'Source' }).click()
  await expect(a.locator('pre')).toContainText('| Phase | From |')
  await expect(page.getByRole('article', { name: 'Variant B' }).locator('pre')).toContainText('<button>Ask the agent</button>')
})

test('picks head to head, asks for another round, and uses the winner', async ({ openCanvas, agent }) => {
  const { page } = await openCanvas({ id: 'tagline', title: 'Tagline' })
  await agent.invoke('add_variants', { variants: [{ content: 'One' }, { content: 'Two' }, { content: 'Three' }] })
  await page.getByRole('article', { name: 'Variant C' }).getByRole('button', { name: 'Drop' }).click()

  // Dropped variants sit out; the last one standing becomes the winner.
  await page.getByRole('button', { name: 'Head to head' }).click()
  await expect(page.getByText('Match 1 of 1.')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Decide' })).toBeHidden()

  // The two variants share the panel's height: the page does not scroll, and each scrolls in its own box.
  await page.setViewportSize({ width: 1200, height: 800 })
  const preview = page.getByRole('article', { name: 'Variant A' }).locator('.preview')
  await expect.poll(async () => (await preview.boundingBox())?.height).toBeGreaterThan(500)
  expect(await page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight)).toBe(0)

  // Expanded, a variant fills the panel; the arrow keys flip between the two and pick nothing.
  await page.getByRole('button', { name: 'Expand A' }).click()
  await expect(page.getByRole('dialog', { name: 'Variant A, expanded' })).toContainText('One')
  await page.keyboard.press('ArrowRight')
  const expanded = page.getByRole('dialog', { name: 'Variant B, expanded' })
  await expect(expanded).toContainText('Two')
  expect((await expanded.locator('.preview').boundingBox())?.width).toBeGreaterThan(1100)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(page.getByText('Match 1 of 1.')).toBeVisible()

  await page.getByRole('button', { name: 'B is better' }).click()
  await expect(page.getByRole('status')).toContainText('B won head to head')
  await page.getByRole('button', { name: 'Back to the grid' }).click()
  await expect(page.getByRole('article', { name: 'Variant B' }).getByText('Winner')).toBeVisible()

  await page.getByRole('article', { name: 'Variant A' }).getByLabel('Note on A').fill('Shorter.')
  await page.getByRole('button', { name: 'Ask for round 2' }).click()
  await expect(page.getByRole('status')).toContainText('Asked the agent for round 2')
  expect(agent.messages).toHaveLength(1)
  expect(agent.messages[0]!.prompt).toContain('[bakeoff:next-round]')
  // The note was still being typed when the button was clicked: it is in the message.
  expect(agent.messages[0]!.prompt).toContain('A: No vote\n  File: round-1/a.md\n  Note: Shorter.')

  await agent.invoke('add_variants', { variants: [{ content: 'Four' }] })
  await expect(page.getByText('Round 2', { exact: true })).toBeVisible()
  await expect(page.getByRole('article')).toHaveCount(2)
  await expect(page.getByRole('article', { name: 'Variant B' })).toContainText('from round 1')
  await expect(page.getByRole('article', { name: 'Variant D' })).toContainText('Four')

  // An earlier round shows what was decided, with nothing to change.
  await page.getByLabel('Round').selectOption('1')
  await expect(page.getByText('Round 1 is closed')).toBeVisible()
  await expect(page.getByRole('article', { name: 'Variant C' }).getByText('Dropped')).toBeVisible()
  await expect(page.getByRole('article', { name: 'Variant A' }).getByText('Shorter.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Pick' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Back to round 2' }).click()

  agent.failNextSend(new Error('The chat is not connected.'))
  await page.getByRole('article', { name: 'Variant D' }).getByRole('button', { name: 'Pick' }).click()
  await page.getByRole('button', { name: 'Use D' }).click()
  await expect(page.getByRole('alert')).toContainText('The chat is not connected.')
  await page.getByRole('button', { name: 'Use D' }).click()
  await expect(page.getByRole('status')).toContainText('Asked the agent to use D')
  expect(agent.messages.at(-1)!.prompt).toContain('[bakeoff:use]')
})
