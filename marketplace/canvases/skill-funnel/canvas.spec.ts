import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canvasTest, expect } from '@rwoll/canvas-kit/playwright'
import { FakeSession, SKILLS } from '../copilot-spend/fixtures.ts'
import { createSkillFunnelCanvas } from './canvas.ts'
import { SAMPLE_START, invoked, sampleSession } from './fixtures.ts'

/** The ID of the chat the test canvas runs in. */
const CHAT = 'test-session'
const root = mkdtempSync(join(tmpdir(), 'skill-funnel-spec-'))
const test = canvasTest(createSkillFunnelCanvas({ root: () => root }))

test.beforeEach(async () => {
  await sampleSession(CHAT).write(root)
})

test('shows which of this chat’s skills were invoked, and what they take of its context', async ({ openCanvas }) => {
  const { page } = await openCanvas()
  await expect(page.getByRole('heading', { name: 'Skills · Fix the flaky upload test' })).toBeVisible()
  const stages = page.getByRole('list', { name: 'The session’s skills' }).getByRole('listitem')
  await expect(stages).toHaveText(['14Skills available', '4Skills invoked'])
  // A dot for every skill in both rows, lit in the second for the invoked ones.
  await expect(stages.nth(1).locator('.dots > i')).toHaveCount(14)
  await expect(stages.nth(1).locator('.dots > .on')).toHaveCount(4)
  await expect(page.getByRole('list', { name: 'Invoked skills' }).getByRole('listitem')).toHaveText(['monorepo-build', 'flaky-tests', 'pr-descriptions', 'writing-tone'])

  await expect(page.getByRole('heading', { name: 'Context usage' })).toBeVisible()
  await expect(page.getByRole('img', { name: /^Skills take about \d+% of the 24k tokens in the agent’s context$/ })).toBeVisible()
})

test('says so when the log does not list the available skills', async ({ openCanvas }) => {
  await new FakeSession(CHAT, SAMPLE_START).event('skill.context_delivered', { source: 'skill-monorepo-build', content: SKILLS['monorepo-build'] }).write(root)
  const { page } = await openCanvas()
  await expect(page.getByRole('list', { name: 'The session’s skills' }).getByRole('listitem')).toHaveText(['?Skills available', '1Skills invoked'])
  await expect(page.getByText('This session’s log is missing its start, which lists the available skills. Only invoked skills are shown.')).toBeVisible()
  await expect(page.getByRole('list', { name: 'Invoked skills' }).getByRole('listitem')).toHaveText(['monorepo-build'])
})

test('follows the agent as it invokes another skill', async ({ openCanvas, agent }) => {
  const { page } = await openCanvas()
  const chips = page.getByRole('list', { name: 'Invoked skills' }).getByRole('listitem')
  await expect(chips).toHaveCount(4)

  await sampleSession(CHAT).event('skill.invoked', invoked('release-notes', SKILLS['release-notes'])).write(root)
  agent.sessionEvent('tool.execution_start', { toolName: 'skill' })
  await expect(chips).toHaveText(['monorepo-build', 'flaky-tests', 'pr-descriptions', 'writing-tone', 'release-notes'])
  await expect(page.getByRole('list', { name: 'The session’s skills' }).getByRole('listitem')).toHaveText(['14Skills available', '5Skills invoked'])
})
