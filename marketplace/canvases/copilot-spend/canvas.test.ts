import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestCanvas } from '@rwoll/canvas-kit/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCopilotSpendCanvas } from './canvas.ts'
import { writeSampleSessions } from './fixtures.ts'

const NOW = Date.parse('2026-10-30T12:00:00Z')
// The sample's model calls, times what each costs: 218 at 15 AIC and 142 at 1 AIC.
const TOTAL_AIC = 218 * 15 + 142

describe('Copilot spend canvas', () => {
  let root = ''
  let closers: (() => Promise<void>)[] = []
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'copilot-spend-test-'))
    await writeSampleSessions(root, NOW)
  })
  afterEach(async () => {
    await Promise.all(closers.map((close) => close()))
    closers = []
    rmSync(root, { recursive: true, force: true })
  })

  async function start(options: Parameters<typeof createTestCanvas>[1] = {}) {
    const harness = await createTestCanvas(createCopilotSpendCanvas({ root: () => root, now: () => NOW }), { now: () => NOW, ...options })
    closers.push(harness.close)
    return harness
  }
  /** Open the canvas and wait for it to read the sessions. */
  async function read(options?: Parameters<typeof createTestCanvas>[1], instance = 'a') {
    const harness = await start(options)
    await harness.open(instance)
    await harness.invoke(instance, 'refresh')
    await vi.waitFor(() => expect(harness.state(instance)?.scan.status).toBe('ready'))
    return harness
  }

  it('shows shares only until the user asks for amounts, which the agent cannot do', async () => {
    const harness = await read()
    const hidden = harness.state('a')!
    expect(hidden).toMatchObject({ showAic: false, totals: { sessions: 13, types: 8, aic: null, withoutAic: 0 } })
    // No amount anywhere in what the page and the agent get.
    expect(JSON.stringify(hidden)).not.toMatch(/"aic":\s*[\d-]/)
    expect(hidden.types.reduce((sum, type) => sum + type.share, 0)).toBeCloseTo(1)
    expect(hidden.dots.reduce((sum, dot) => sum + dot.share, 0)).toBeCloseTo(1)

    await expect(harness.invoke('a', 'set_show_aic' as never, { show: true } as never)).rejects.toMatchObject({ code: 'not_found' })
    await harness.invoke('a', 'set_show_aic', { show: true }, 'ui')
    const shown = harness.state('a')!
    expect(shown.totals.aic).toBeCloseTo(TOTAL_AIC)
    expect(shown.rows[0]).toMatchObject({ id: 'offline-sync', rank: 1, aic: 900 })
  })

  it('ranks sessions against their task type, and says which skills and MCP servers went unused', async () => {
    const harness = await read()
    const state = harness.state('a')!
    expect(state.types[0]).toMatchObject({ type: 'feature', sessions: 4 })
    // Four feature sessions; the largest is far above the median of the two cheap ones and two expensive ones.
    expect(state.rows.map((row) => row.id).slice(0, 3)).toEqual(['offline-sync', 'sync-ci', 'billing-forms'])
    expect(state.rows.find((row) => row.id === 'sync-ci')).toMatchObject({ type: 'followup', reason: { tag: 'Repeated failures' }, unusedSkills: ['pr-descriptions', 'release-notes'], unusedMcp: ['issue-tracker', 'docs-search'] })

    const item = (name: string) => state.context.items.find((entry) => entry.name === name)
    // Every session is given both servers' tools; only two call docs-search, and none calls issue-tracker.
    expect(item('issue-tracker')).toMatchObject({ kind: 'mcp', tools: 4, sessions: 13, used: 0, calls: 0 })
    expect(item('docs-search')).toMatchObject({ kind: 'mcp', tools: 2, sessions: 13, used: 2, calls: 9 })
    expect(item('monorepo-build')).toMatchObject({ kind: 'skill', sessions: 5, used: 5, unused: 0 })
    expect(item('release-notes')).toMatchObject({ kind: 'skill', sessions: 3, used: 0 })
    expect(item('writing-tone')).toMatchObject({ kind: 'skill', sessions: 2, used: 0, unknown: 2, unused: 0 })
    expect(item('issue-tracker')!.unused).toBeCloseTo(item('issue-tracker')!.share)
    expect(state.context.read.unusedMcp).toBeGreaterThan(0)
    expect(state.summary).toContain('**Feature work** takes the largest share of your AIC')
  })

  it('opens one session, and narrows to a period or a repository', async () => {
    const harness = await read()
    await harness.invoke('a', 'select_session', { id: 'sync-ci' })
    expect(harness.state('a')!.detail).toMatchObject({
      id: 'sync-ci',
      within: { type: 'followup', sessions: 2 },
      skills: expect.arrayContaining([expect.objectContaining({ name: 'monorepo-build', verdict: 'used' }), expect.objectContaining({ name: 'pr-descriptions', verdict: 'unused' })]),
      mcp: expect.arrayContaining([expect.objectContaining({ name: 'issue-tracker', used: false, tools: 4 })]),
    })
    await expect(harness.invoke('a', 'select_session', { id: 'no-such-session' })).rejects.toMatchObject({ code: 'not_found' })

    expect(await harness.invoke('a', 'set_filters', { days: 7 })).toMatchObject({ sessions: 6 })
    expect(harness.state('a')).toMatchObject({ selected: null, detail: null })
    expect(await harness.invoke('a', 'set_filters', { days: 30, repository: 'acme/platform-tools' })).toMatchObject({ sessions: 3 })
    expect(harness.state('a')!.repositories).toEqual(['acme/api-gateway', 'acme/mobile-app', 'acme/platform-tools', 'acme/web-app'])
  })

  it('reads a log again only when it changed', async () => {
    const first = await read()
    expect(first.state('a')!.scan).toMatchObject({ status: 'ready', done: 13, total: 13 })
    const second = await read({ dataRoot: first.dataRoot }, 'b')
    expect(second.state('b')).toMatchObject({ scan: { status: 'ready', done: 0, total: 0 }, totals: { sessions: 13 } })
  })

  it('keeps the task type the user chose over the one the agent suggests', async () => {
    const harness = await read()
    const type = () => harness.state('a')!.rows.find((row) => row.id === 'offline-sync')
    expect(type()).toMatchObject({ type: 'feature', typeSource: 'auto' })
    expect(await harness.invoke('a', 'set_task_types', { types: [{ id: 'offline-sync', type: 'docs' }] })).toEqual({ applied: 1 })
    expect(type()).toMatchObject({ type: 'docs', typeSource: 'agent' })
    await harness.invoke('a', 'set_task_types', { types: [{ id: 'offline-sync', type: 'chores' }] }, 'ui')
    expect(await harness.invoke('a', 'set_task_types', { types: [{ id: 'offline-sync', type: 'docs' }] })).toEqual({ applied: 0 })
    expect(type()).toMatchObject({ type: 'chores', typeSource: 'you' })
    await harness.invoke('a', 'set_task_types', { types: [{ id: 'offline-sync', type: null }] }, 'ui')
    expect(type()).toMatchObject({ type: 'feature', typeSource: 'auto' })
  })

  it('asks the agent with a file of sessions, keeping their text and the amounts out of the prompt', async () => {
    const harness = await read()
    const sorted = (await harness.invoke('a', 'ask_to_sort', {}, 'ui')) as { sent: number; file: string }
    expect(sorted.sent).toBe(13)
    expect(JSON.parse(readFileSync(sorted.file, 'utf8'))).toContainEqual(expect.objectContaining({ id: 'webhook-dupes', type: 'bugfix', title: 'Fix duplicate webhook deliveries' }))

    const asked = (await harness.invoke('a', 'ask_about_session', { id: 'sync-ci' }, 'ui')) as { file: string }
    expect(readFileSync(asked.file, 'utf8')).not.toMatch(/"aic":\s*\d/)
    const [sort, why] = harness.sentToAgent.map((message) => message.prompt)
    expect(sort).toContain(sorted.file)
    expect(sort).toContain('instanceId "a", actionName "set_task_types"')
    expect(sort).not.toContain('webhook')
    expect(why).toContain(join(root, 'sync-ci', 'events.jsonl'))
    expect(why).toContain('never amounts')
  })
})
