import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canvasTest, expect } from '@rwoll/canvas-kit/playwright'
import { createCopilotSpendCanvas } from './canvas.ts'
import { writeSampleSessions } from './fixtures.ts'

const NOW = Date.parse('2026-10-30T12:00:00Z')
const root = mkdtempSync(join(tmpdir(), 'copilot-spend-spec-'))
const test = canvasTest(createCopilotSpendCanvas({ root: () => root, now: () => NOW }), { now: () => NOW })

test.beforeAll(() => writeSampleSessions(root, NOW))

test('shows shares, and amounts only when the user asks', async ({ openCanvas }) => {
  const { page, state } = await openCanvas()
  await expect(page.getByRole('heading', { name: 'Each session against its task type' })).toBeVisible()
  await expect(page.getByText('13 sessions · 8 task types')).toBeVisible()
  await expect(page.getByText('Feature work takes the largest share of your AIC')).toBeVisible()
  // Shares, ranks, and multiples, and no amount anywhere on the page.
  await expect(page.locator('body')).not.toContainText(/\d AIC/)

  await page.getByRole('switch', { name: 'Show AIC' }).click()
  await expect(page.getByText('3,412 AIC')).toBeVisible()
  expect(state()?.showAic).toBe(true)
})

test('opens a session to the skills and MCP servers it did not use', async ({ openCanvas }) => {
  const { page } = await openCanvas()
  await page.getByRole('button', { name: 'Session 2: Fix CI failures on the offline sync pull request' }).click()
  const detail = page.getByRole('region', { name: 'Detail of session 2' })
  await expect(detail.getByRole('listitem').filter({ hasText: 'pr-descriptions' })).toContainText('not used')
  await expect(detail.getByRole('listitem').filter({ hasText: 'monorepo-build' })).toContainText('scripts/build-all.sh appears in a later tool call')
  await expect(detail.getByRole('listitem').filter({ hasText: 'issue-tracker' })).toContainText('4 tools, none called')

  // The same session, from its numbered mark in the picture.
  await expect(page.getByRole('button', { name: /^Session 2: .* of all AIC, .* the PR follow-up median$/ })).toHaveAttribute('aria-pressed', 'true')

  await detail.getByLabel('Task type').selectOption('Bug fix')
  await expect(detail.getByText('Chosen by you.')).toBeVisible()
  await expect(detail.getByText('Within Bug fix')).toBeVisible()
})

test('follows the agent’s filters, and asks the agent about a session', async ({ openCanvas, agent }) => {
  const { page } = await openCanvas()
  await expect(page.getByText('13 sessions · 8 task types')).toBeVisible()
  await agent.invoke('set_filters', { days: 7 })
  await expect(page.getByText('6 sessions · 5 task types')).toBeVisible()
  await expect(page.getByLabel('Period')).toHaveValue('7')

  await page.getByRole('button', { name: 'Session 1: Add CSV export to the reports page' }).click()
  await page.getByRole('button', { name: 'Ask the agent why' }).click()
  await expect.poll(() => agent.messages.map((message) => message.displayPrompt)).toEqual(['Copilot spend · why was this session expensive?'])
})
