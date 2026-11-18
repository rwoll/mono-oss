import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestCanvas } from '@rwoll/canvas-kit/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeSession, SKILLS } from '../copilot-spend/fixtures.ts'
import { createSkillFunnelCanvas } from './canvas.ts'
import { SAMPLE_START, invoked, systemPrompt, writeSampleSession } from './fixtures.ts'
import { readSessionSkills } from './log.ts'

const OPUS = 'claude-opus-5.5'
const NOTES_TOKENS = Math.ceil(SKILLS['release-notes'].length / 4)

describe('Skill funnel canvas', () => {
  let root = ''
  let closers: (() => Promise<void>)[] = []
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'skill-funnel-test-'))
  })
  afterEach(async () => {
    await Promise.all(closers.map((close) => close()))
    closers = []
    rmSync(root, { recursive: true, force: true })
  })

  async function start(options: Parameters<typeof createTestCanvas>[1] = {}) {
    const harness = await createTestCanvas(createSkillFunnelCanvas({ root: () => root }), options)
    closers.push(harness.close)
    return harness
  }

  it('shows the skills of the chat it is opened in: available and invoked, and what they take of its context', async () => {
    await writeSampleSession(root, 'chat-1')
    const harness = await start({ sessionId: 'chat-1' })
    await harness.open('a')
    expect(harness.state('a')).toMatchObject({ session: 'chat-1', status: 'idle' })

    expect(await harness.invoke('a', 'refresh')).toEqual({
      status: 'ready',
      error: null,
      counts: { available: 14, invoked: 4 },
      context: expect.objectContaining({ total: 24_000 }),
      invoked: ['monorepo-build', 'flaky-tests', 'pr-descriptions', 'writing-tone'],
    })
    const state = harness.state('a')!
    expect(state).toMatchObject({ title: 'Fix the flaky upload test', listed: true })
    // Four skills of about 1,500 tokens each were invoked; the list of all fourteen is far smaller.
    expect(state.context!.invoked).toBeGreaterThan(6000)
    expect(state.context!.available).toBeGreaterThan(400)
    expect(state.context!.available).toBeLessThan(1000)
    expect(state.skills[2]).toEqual({ name: 'pr-descriptions', description: 'Write pull request titles & descriptions a reviewer can skim in 30 seconds.', stage: 'invoked' })
    expect(state.skills[4]).toMatchObject({ name: 'release-notes', stage: 'available' })
  })

  it('shows another session when asked, and says when a session has no log', async () => {
    await writeSampleSession(root, 'chat-1')
    await new FakeSession('other', SAMPLE_START)
      .event('system.message', { role: 'system', content: systemPrompt([['release-notes', 'Add an entry to the release notes.']]) })
      .write(root)
    const harness = await start({ sessionId: 'chat-1' })

    await harness.open('a', { session: 'other' })
    expect(await harness.invoke('a', 'refresh')).toMatchObject({ counts: { available: 1, invoked: 0 }, context: null })
    // Opened again without a session, it goes back to the chat's own.
    await harness.open('a')
    expect(harness.state('a')).toMatchObject({ session: 'chat-1', status: 'idle', skills: [] })

    await harness.open('b', { session: 'gone' })
    expect(await harness.invoke('b', 'refresh')).toMatchObject({ status: 'error', error: `Session gone has no log in ${root}.` })
    await expect(harness.open('c', { session: '../chat-1' })).rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('reading a session’s skills', () => {
  let root = ''
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'skill-funnel-log-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('counts in the wheel only what is in the main agent’s context now', async () => {
    const read = async (session: FakeSession) => readSessionSkills(await session.write(root))
    const session = new FakeSession('s1', SAMPLE_START)
      .user('Build it')
      .subagent('agent-1')
      .event('skill.invoked', invoked('monorepo-build', SKILLS['monorepo-build']), 'agent-1')
      .call(OPUS, { input: 5000, aic: 15 })
    // A log that lists no skills still shows the invoked one. The sub-agent read it in its own context.
    expect(await read(session)).toEqual({ title: '', listed: false, skills: [{ name: 'monorepo-build', description: '', stage: 'invoked' }], context: { total: 5000, available: 0, invoked: 0 } })

    session.event('skill.invoked', invoked('release-notes', SKILLS['release-notes'])).call(OPUS, { input: 6000, aic: 15 })
    expect((await read(session)).context).toEqual({ total: 6000, available: 0, invoked: NOTES_TOKENS })
    // Invoked again, it is recorded by reference to the same instructions, and is in the context twice.
    const contentId = `sha256:${createHash('sha256').update(SKILLS['release-notes']).digest('hex')}`
    session.event('skill.invoked_ref', { name: 'release-notes', contentId }).call(OPUS, { input: 6100, aic: 15 })
    expect((await read(session)).context).toEqual({ total: 6100, available: 0, invoked: NOTES_TOKENS * 2 })

    // Instructions leave the context when the conversation is compacted.
    session.event('session.compaction_complete', { success: true }).call(OPUS, { input: 2000, aic: 15 })
    expect(await read(session)).toMatchObject({ skills: [{ name: 'monorepo-build' }, { name: 'release-notes', stage: 'invoked' }], context: { total: 2000, available: 0, invoked: 0 } })
  })
})
