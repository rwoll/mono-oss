import { canvasTest, expect } from '@rwoll/canvas-kit/playwright'
import canvas from './canvas.ts'

const T0 = Date.parse('2026-10-01T09:00:00Z')
let now = T0
const test = canvasTest(canvas, { now: () => now })

test.beforeEach(async ({ page }) => {
  now = T0
  await page.clock.setFixedTime(T0)
})

const timer = (page: import('@playwright/test').Page) => page.getByRole('button', { name: /^Refresh settings/ })

test('the agent writes the summary and the user asks for a new one', async ({ openCanvas, canvasHarness, agent }) => {
  const { page } = await openCanvas()
  await expect(page.getByText('No summary yet. Use the refresh button to ask the agent for one.')).toBeVisible()

  await canvasHarness.tickJobs()
  await expect(timer(page)).toHaveText('Refresh settings, Updating…')
  await expect(page.getByText('Requesting the first summary…')).toBeVisible()
  await expect(page.getByRole('status')).toHaveText('Refresh requested. Waiting for the agent to pick it up…')
  expect(agent.messages.map((message) => message.displayPrompt)).toEqual(['Session summary · refresh'])
  expect(agent.messages[0]?.prompt).toContain('instanceId "test"')

  await agent.invoke('update_summary', {
    headline: 'Importer rewrite is in review: https://github.com/octo/widgets/pull/42',
    status: 'working',
    executiveSummary: 'The goal is a **streaming** importer. See `parse()`.',
    running: [{ title: 'CI', detail: 'Waiting on macOS', state: 'waiting' }],
    attention: ['Approve the schema change in https://github.com/octo/widgets/issues/7'],
    next: ['Merge after review'],
  })
  await expect(page.getByText('Importer rewrite is in review')).toBeVisible()
  const link = page.getByRole('link', { name: 'octo/widgets#42' })
  await expect(link).toHaveAttribute('href', 'https://github.com/octo/widgets/pull/42')
  await expect(page.getByRole('region', { name: 'Executive summary' }).locator('strong')).toHaveText('streaming')
  await expect(page.getByRole('region', { name: 'Running' })).toContainText('CIWaiting on macOSWaiting')
  await expect(page.getByRole('region', { name: 'Needs your attention' }).getByRole('link', { name: 'octo/widgets#7' })).toBeVisible()
  await expect(page.locator('header .pill')).toHaveText('Working')
  await expect(page.getByText('Updated just now')).toBeVisible()
  await expect(timer(page)).toHaveText('Refresh settings, next refresh in 10:00')

  await page.getByRole('button', { name: 'Refresh now' }).click()
  await expect(timer(page)).toHaveText('Refresh settings, Updating…')
  expect(agent.messages).toHaveLength(2)

  // The agent works on it but finishes without calling update_summary.
  agent.sessionEvent('assistant.turn_start', {}, T0 + 1_000)
  agent.sessionEvent('session.idle', {}, T0 + 2_000)
  await expect(page.getByRole('status')).toHaveText('The agent finished without updating the summary. Try refreshing again.')
})

test('the user retimes and pauses refreshes, and turns off idle skipping', async ({ openCanvas, agent }) => {
  const { page, state } = await openCanvas()
  await timer(page).click()
  const settings = page.getByRole('group', { name: 'Refresh settings' })
  const every = settings.getByRole('spinbutton', { name: 'Every' })
  await every.fill('5')
  await every.press('Enter')
  await expect.poll(() => agent.invoke('list_jobs', {})).toMatchObject([{ id: 'refresh', every: 5 * 60_000 }])

  // Out of range values are refused and Escape puts the saved value back.
  await every.fill('0')
  await every.press('Enter')
  await expect(settings.getByRole('alert')).toHaveText('Enter a whole number of minutes from 1 to 1440.')
  await every.press('Escape')
  await expect(settings).toBeHidden()
  await expect(timer(page)).toBeFocused()

  await timer(page).click()
  await expect(every).toHaveValue('5')
  // The boxes follow the saved settings, so they change once the server has them.
  const auto = settings.getByRole('checkbox', { name: 'Auto-refresh' })
  await auto.click()
  await expect(auto).not.toBeChecked()
  await expect(timer(page)).toHaveText('Refresh settings, auto-refresh Off')
  const skip = settings.getByRole('checkbox', { name: 'Skip when idle' })
  await skip.click()
  await expect(skip).not.toBeChecked()
  expect(state()?.skipWhenIdle).toBe(false)

  // The agent sees the same settings.
  expect(await agent.invoke('list_jobs', {})).toMatchObject([{ id: 'refresh', enabled: false, every: 5 * 60_000 }])

  // Clicking elsewhere closes the menu.
  await page.getByRole('heading', { name: 'Session summary' }).click()
  await expect(settings).toBeHidden()
})

test('a refresh that cannot reach the agent is reported', async ({ openCanvas, agent }) => {
  const { page } = await openCanvas()
  agent.failNextSend(new Error('session closed'))
  await page.getByRole('button', { name: 'Refresh now' }).click()
  const notice = page.getByRole('status')
  await expect(notice).toContainText('Could not reach the agent')
  await expect(notice).toContainText('session closed')
})

test('the user selects text, asks the agent about it, and can retry a failed send', async ({ openCanvas, agent }) => {
  const { page } = await openCanvas()
  await agent.invoke('update_summary', {
    headline: 'Importer rewrite is in review',
    status: 'working',
    executiveSummary: 'The parser now streams rows instead of loading the whole file.',
  })
  const passage = page.getByText('The parser now streams rows')
  await expect(passage).toBeVisible()

  // Selecting alone sends nothing.
  await passage.selectText()
  const ask = page.getByRole('button', { name: 'Ask agent' })
  await expect(ask).toBeVisible()
  expect(agent.messages).toEqual([])

  // Escape dismisses the button; selecting again brings it back.
  await page.keyboard.press('Escape')
  await expect(ask).toBeHidden()
  await passage.selectText()
  await ask.click()

  const dialog = page.getByRole('dialog', { name: 'Ask about selected text' })
  await expect(dialog).toHaveAccessibleDescription('Summary selection. Your question and this passage will be sent to this chat.')
  await expect(dialog.locator('blockquote')).toHaveText('The parser now streams rows instead of loading the whole file.')
  const box = dialog.getByLabel('Your question')
  await expect(box).toBeFocused()

  // An empty question is refused.
  await dialog.getByRole('button', { name: 'Send to agent' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('Write a question of at most 4,000 characters.')

  // A failed send keeps the question for a retry.
  agent.failNextSend(new Error('session closed'))
  await box.fill('Does this change memory use?')
  await box.press('ControlOrMeta+Enter')
  await expect(dialog.getByRole('alert')).toContainText('Your question is still here.')
  await expect(box).toHaveValue('Does this change memory use?')

  await dialog.getByRole('button', { name: 'Send to agent' }).click()
  await expect(dialog.getByRole('status')).toHaveText('Sent to this chat. The agent will answer here after its current turn.')
  expect(agent.messages).toHaveLength(1)
  expect(agent.messages[0]).toMatchObject({ mode: 'enqueue', displayPrompt: 'Session summary · question: Does this change memory use?' })
  expect(agent.messages[0]?.prompt).toContain('The parser now streams rows instead of loading the whole file.')

  // Sending again does nothing until the question changes.
  await expect(dialog.getByRole('button', { name: 'Send to agent' })).toBeDisabled()
  await box.press('ControlOrMeta+Enter')
  expect(agent.messages).toHaveLength(1)
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()
})

test('Alt+Enter opens the question box, and Escape cancels it without sending', async ({ openCanvas, agent }) => {
  const { page } = await openCanvas()
  await agent.invoke('update_summary', { headline: 'Shipping the importer', status: 'working', next: ['Merge after review'] })
  await page.getByText('Merge after review').selectText()
  await expect(page.getByRole('button', { name: 'Ask agent' })).toBeVisible()
  await page.keyboard.press('Alt+Enter')
  const dialog = page.getByRole('dialog', { name: 'Ask about selected text' })
  await expect(dialog.locator('blockquote')).toHaveText('Merge after review')
  await dialog.getByLabel('Your question').fill('Who reviews it?')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('button', { name: 'Ask agent' })).toBeFocused()
  expect(agent.messages).toEqual([])
})

test('the summary counts as read once the panel has been visible and focused for a few seconds', async ({ openCanvas, agent }) => {
  const opened = await openCanvas()
  await agent.invoke('update_summary', { headline: 'Shipping the importer', status: 'working' })
  await expect(opened.page.getByText('Shipping the importer')).toBeVisible()
  expect(opened.state()?.seen).toBeNull()
  await expect.poll(() => opened.state()?.seen?.headline, { timeout: 6_000 }).toBe('Shipping the importer')
  expect(opened.state()?.seen?.revision).toBe(opened.state()?.summary?.revision)
})
