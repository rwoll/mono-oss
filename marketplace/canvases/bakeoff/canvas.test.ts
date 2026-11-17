import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CanvasClient } from '@rwoll/canvas-kit/react'
import { createTestCanvas } from '@rwoll/canvas-kit/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { screenshotPng } from '../annotate/fixtures.ts'
import canvas from './canvas.ts'

const NOW = Date.parse('2026-10-14T12:00:00Z')

describe('Bakeoff canvas', () => {
  let close: (() => Promise<void>) | undefined
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bakeoff-test-'))
  })
  afterEach(async () => {
    await close?.()
    rmSync(dir, { recursive: true, force: true })
  })

  const file = (name: string, data: string | Buffer) => {
    const path = join(dir, name)
    writeFileSync(path, data)
    return path
  }
  async function start(options: Parameters<typeof createTestCanvas>[1] = {}) {
    const harness = await createTestCanvas(canvas, { now: () => NOW, ...options })
    close = harness.close
    return harness
  }
  /** Three variants in round 1: an image (A), Markdown (B), and HTML (C). */
  async function seeded(options?: Parameters<typeof createTestCanvas>[1]) {
    const harness = await start(options)
    const opened = await harness.open('a', { id: 'logo', title: 'Logo for the README', brief: 'Blobby plus one prop.' })
    const added = await harness.invoke('a', 'add_variants', {
      variants: [
        { path: file('Chart Card.png', screenshotPng()), approach: 'chart in a card', models: ['claude-opus-5.5'], credits: 12.5 },
        { content: '## Title\n\nBody', models: ['claude-opus-5.5', 'gpt-6-sol'] },
        { content: '<p>Hello</p>', kind: 'html' },
      ],
    })
    return { harness, added, pageUrl: opened.url }
  }
  /** Fetches a file the way the page does: by ID, with the page's token. */
  async function fetchFile(pageUrl: string, id: string) {
    const html = await (await fetch(pageUrl)).text()
    const bootstrap = JSON.parse(/<script type="application\/json" id="canvas-kit-bootstrap">(.*?)<\/script>/s.exec(html)?.[1] as string)
    return fetch(new URL(new CanvasClient({ ...bootstrap, base: new URL(pageUrl).pathname }).fileUrl(id), pageUrl))
  }

  it('copies variants into its folder, letters them, and keeps what made them', async () => {
    const { harness, added, pageUrl } = await seeded()
    expect(added).toMatchObject({
      round: 1,
      added: [
        { id: 'v1', label: 'A', kind: 'image', file: join('round-1', 'a-chart-card.png') },
        { id: 'v2', label: 'B', kind: 'markdown', file: join('round-1', 'b.md') },
        { id: 'v3', label: 'C', kind: 'html', file: join('round-1', 'c.html') },
      ],
    })
    expect(readFileSync(join(added.folder, 'round-1', 'b.md'), 'utf8')).toBe('## Title\n\nBody')
    const state = harness.state('a')!
    expect(state).toMatchObject({ id: 'logo', title: 'Logo for the README', brief: 'Blobby plus one prop.', folder: added.folder })
    expect(state.variants[0]).toMatchObject({ approach: 'chart in a card', models: ['claude-opus-5.5'], credits: 12.5, round: 1 })
    expect(state.variants[1]).toMatchObject({ approach: '', models: ['claude-opus-5.5', 'gpt-6-sol'], credits: null })
    expect(state.rounds).toEqual([{ number: 1, overall: '', sent: null, entries: ['v1', 'v2', 'v3'].map((variant) => ({ variant, vote: null, note: '', marks: [], carried: false })) }])

    // The page gets images as files, and text through an action.
    const image = await fetchFile(pageUrl, 'v1')
    expect([image.status, image.headers.get('content-type')]).toEqual([200, 'image/png'])
    expect((await fetchFile(pageUrl, 'v2')).status).toBe(404)
    expect(await harness.invoke('a', 'load_variant', { variant: 'v2' }, 'ui')).toEqual({ content: '## Title\n\nBody' })
    await expect(harness.invoke('a', 'load_variant', { variant: 'v1' }, 'ui')).rejects.toMatchObject({ code: 'not_found' })

    // An SVG is an image the page loads as text; another file can be shown as text when asked.
    const more = await harness.invoke('a', 'add_variants', { variants: [{ path: file('mark.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>') }, { path: file('notes.log', 'line'), kind: 'text' }] })
    expect(more.added).toMatchObject([{ label: 'D', kind: 'image', file: join('round-1', 'd-mark.svg') }, { label: 'E', kind: 'text', file: join('round-1', 'e-notes.log') }])
    expect((await fetchFile(pageUrl, 'v4')).status).toBe(404)
    expect(await harness.invoke('a', 'load_variant', { variant: 'v4' }, 'ui')).toEqual({ content: '<svg xmlns="http://www.w3.org/2000/svg"/>' })
  })

  it('rejects variants it cannot show, and keeps nothing of a failed add', async () => {
    const harness = await start()
    await harness.open('a', { id: 'logo' })
    const add = (variants: Parameters<typeof harness.invoke<'add_variants'>>[2]) => harness.invoke('a', 'add_variants', variants)
    await expect(add({ variants: [{ path: 'relative.png' }] })).rejects.toMatchObject({ code: 'invalid_variant', message: expect.stringContaining('not an absolute path') })
    await expect(add({ variants: [{ path: join(dir, 'missing.png') }] })).rejects.toMatchObject({ message: expect.stringContaining('there is no file') })
    await expect(add({ variants: [{ path: file('data.bin', 'x') }] })).rejects.toMatchObject({ message: expect.stringContaining('Pass kind "text"') })
    await expect(add({ variants: [{ path: file('zeros.bin', Buffer.alloc(8)), kind: 'text' }] })).rejects.toMatchObject({ message: expect.stringContaining('is not text') })
    await expect(add({ variants: [{ path: file('notes.md', '# Hi'), kind: 'image' }] })).rejects.toMatchObject({ message: expect.stringContaining('is not an image') })
    await expect(add({ variants: [{ content: 'x'.repeat(300_000) }] })).rejects.toMatchObject({ message: expect.stringContaining('markdown can be at most 200 KB') })
    await expect(add({ variants: [{ content: 'x', kind: 'image' }] })).rejects.toMatchObject({ code: 'invalid_variant' })
    await expect(add({ variants: [{ path: join(dir, 'a.png'), content: 'x' }] })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(add({ variants: [] })).rejects.toMatchObject({ code: 'invalid_input' })

    // The first variant was copied before the second failed: nothing of it stays.
    await expect(add({ variants: [{ content: 'fine' }, { path: join(dir, 'missing.png') }] })).rejects.toMatchObject({ message: expect.stringContaining('Variant 2') })
    expect(harness.state('a')).toMatchObject({ variants: [], folder: '' })
    const folder = (await add({ variants: [{ content: 'kept' }] })).folder
    expect(readFileSync(join(folder, 'round-1', 'a.md'), 'utf8')).toBe('kept')
  })

  it('keeps one winner, and notes that refer to pins and quotes', async () => {
    const { harness } = await seeded()
    const entries = () => harness.state('a')!.rounds[0]!.entries
    await harness.invoke('a', 'vote', { variant: 'v1', vote: 'pick' }, 'ui')
    await harness.invoke('a', 'vote', { variant: 'v2', vote: 'pick' }, 'ui')
    await harness.invoke('a', 'vote', { variant: 'v3', vote: 'drop' }, 'ui')
    expect(entries().map((entry) => entry.vote)).toEqual(['keep', 'pick', 'drop'])
    await harness.invoke('a', 'vote', { variant: 'v3', vote: null }, 'ui')
    expect(entries()[2]!.vote).toBeNull()
    await expect(harness.invoke('a', 'vote', { variant: 'v9', vote: 'keep' }, 'ui')).rejects.toMatchObject({ code: 'not_found' })

    await harness.invoke('a', 'set_note', { variant: 'v1', note: 'Too busy here' }, 'ui')
    expect(await harness.invoke('a', 'add_mark', { variant: 'v1', x: 0.25, y: 0.5 }, 'ui')).toEqual({ n: 1 })
    expect(await harness.invoke('a', 'add_mark', { variant: 'v1', quote: '  Validation  ' }, 'ui')).toEqual({ n: 2 })
    expect(entries()[0]).toMatchObject({ note: 'Too busy here [1] [2] ', marks: [{ n: 1, x: 0.25, y: 0.5 }, { n: 2, quote: 'Validation' }] })
    await harness.invoke('a', 'remove_mark', { variant: 'v1', n: 1 }, 'ui')
    // Numbers are never reused within what is left, so a note's [2] still means the same spot.
    expect(await harness.invoke('a', 'add_mark', { variant: 'v1', x: 1, y: 0 }, 'ui')).toEqual({ n: 3 })
    expect(entries()[0]!.marks.map((mark) => mark.n)).toEqual([2, 3])
    await expect(harness.invoke('a', 'add_mark', { variant: 'v1', x: 0.5 }, 'ui')).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(harness.invoke('a', 'add_mark', { variant: 'v1', x: 0.5, y: 0.5, quote: 'both' }, 'ui')).rejects.toMatchObject({ code: 'invalid_input' })

    // A pin on an HTML mock also says what it is on, on one line, and where in that element.
    const anchor = { path: [0, 2], x: 0.5, y: 0.5 }
    expect(await harness.invoke('a', 'add_mark', { variant: 'v3', x: 0.1, y: 0.2, on: ' <button> Ask the\n agent ', anchor }, 'ui')).toEqual({ n: 1 })
    expect(entries()[2]!.marks).toEqual([{ n: 1, x: 0.1, y: 0.2, on: '<button> Ask the agent', anchor }])
    await expect(harness.invoke('a', 'add_mark', { variant: 'v3', quote: 'Ask', on: '<button>' }, 'ui')).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('asks for another round with the feedback, then carries the kept variants into it', async () => {
    const { harness, added } = await seeded()
    await expect(harness.invoke('a', 'send', { kind: 'next' }, 'ui')).rejects.toMatchObject({ code: 'no_feedback' })
    await expect(harness.invoke('a', 'send', { kind: 'use' }, 'ui')).rejects.toMatchObject({ code: 'no_winner' })

    await harness.invoke('a', 'vote', { variant: 'v1', vote: 'pick' }, 'ui')
    await harness.invoke('a', 'add_mark', { variant: 'v1', x: 0.25, y: 0.5 }, 'ui')
    await harness.invoke('a', 'set_note', { variant: 'v1', note: '[1] Reads well, even with ``` in it.' }, 'ui')
    await harness.invoke('a', 'vote', { variant: 'v2', vote: 'drop' }, 'ui')
    await harness.invoke('a', 'set_note', { variant: 'v2', note: 'Too long.' }, 'ui')
    await harness.invoke('a', 'vote', { variant: 'v3', vote: 'keep' }, 'ui')
    await harness.invoke('a', 'add_mark', { variant: 'v3', x: 0.1, y: 0.2, on: '<button> Ask the agent' }, 'ui')
    await harness.invoke('a', 'set_overall', { note: "A's layout with C's colors." }, 'ui')

    const sent = await harness.invoke('a', 'send', { kind: 'next' }, 'ui')
    const feedback = [
      'A: Winner',
      `  File: ${join('round-1', 'a-chart-card.png')}. Made with: chart in a card; claude-opus-5.5; 12.5 AIC`,
      '  Note: [1] Reads well, even with ``` in it.',
      '  [1] is a pin 25% from the left and 50% from the top of the image',
      'B: Drop',
      `  File: ${join('round-1', 'b.md')}. Made with: claude-opus-5.5 + gpt-6-sol`,
      '  Note: Too long.',
      'C: Keep',
      `  File: ${join('round-1', 'c.html')}`,
      '  Note: [1]',
      '  [1] is a pin 10% from the left and 20% from the top of the page, on <button> Ask the agent',
      '',
      "Overall: A's layout with C's colors.",
    ].join('\n')
    expect(readFileSync(sent.feedbackFile, 'utf8')).toBe(`${feedback}\n`)
    expect(sent.feedbackFile).toBe(join(added.folder, 'round-1', 'feedback.md'))
    expect(harness.sentToAgent).toHaveLength(1)
    const { prompt, displayPrompt } = harness.sentToAgent[0]!
    expect(displayPrompt).toBe('Bakeoff · round 2')
    expect(prompt).toContain('[bakeoff:next-round]\nIn the Bakeoff canvas, the user reviewed round 1 of "Logo for the README" and asks for round 2.\nThey asked for: Blobby plus one prop.')
    // The user's words are in a fence their own backticks cannot close.
    expect(prompt).toContain(`\`\`\`\`text\n${feedback}\n\`\`\`\``)
    expect(prompt).toContain(`Files are relative to ${added.folder}.`)
    expect(prompt).toContain('instanceId "a", actionName "add_variants"')
    expect(harness.state('a')!.rounds[0]!.sent).toEqual({ kind: 'next', at: new Date(NOW).toISOString(), variant: null })

    // The agent answers: a new round, with the winner and the kept variant ahead of the new ones.
    const next = await harness.invoke('a', 'add_variants', { variants: [{ content: 'New D' }, { content: 'New E' }] })
    expect(next).toMatchObject({ round: 2, added: [{ label: 'D', file: join('round-2', 'd.md') }, { label: 'E' }] })
    const state = harness.state('a')!
    expect(state.rounds).toHaveLength(2)
    expect(state.rounds[1]).toEqual({
      number: 2,
      overall: '',
      sent: null,
      entries: [
        { variant: 'v1', vote: null, note: '', marks: [], carried: true },
        { variant: 'v3', vote: null, note: '', marks: [], carried: true },
        { variant: 'v4', vote: null, note: '', marks: [], carried: false },
        { variant: 'v5', vote: null, note: '', marks: [], carried: false },
      ],
    })
    // The earlier round is closed: it keeps what was sent.
    expect(state.rounds[0]!.entries[1]).toMatchObject({ variant: 'v2', vote: 'drop', note: 'Too long.' })
    await expect(harness.invoke('a', 'vote', { variant: 'v2', vote: 'keep' }, 'ui')).rejects.toMatchObject({ code: 'not_found' })

    await harness.invoke('a', 'vote', { variant: 'v4', vote: 'pick' }, 'ui')
    await harness.invoke('a', 'send', { kind: 'use' }, 'ui')
    expect(harness.sentToAgent[1]).toMatchObject({ displayPrompt: 'Bakeoff · use D', prompt: expect.stringContaining('[bakeoff:use]\nIn the Bakeoff canvas, the user picked variant D of "Logo for the README", in round 2.') })
    expect(harness.sentToAgent[1]!.prompt).toContain(`1. Use variant D (${join('round-2', 'd.md')})`)
    expect(harness.sentToAgent[1]!.prompt).toContain('A: No vote (kept from round 1)')
    expect(harness.state('a')!.rounds[1]!.sent).toMatchObject({ kind: 'use', variant: 'v4' })
    expect(await harness.invoke('a', 'get_state')).toMatchObject({ rounds: [{ number: 1 }, { number: 2, sent: { kind: 'use' } }] })
  })

  it('adds to the round being reviewed until the user asks for another, unless told otherwise', async () => {
    const { harness } = await seeded()
    expect(await harness.invoke('a', 'add_variants', { variants: [{ content: 'More' }] })).toMatchObject({ round: 1, added: [{ label: 'D' }] })
    await harness.invoke('a', 'vote', { variant: 'v4', vote: 'keep' }, 'ui')
    expect(await harness.invoke('a', 'add_variants', { variants: [{ content: 'Fresh' }], newRound: true })).toMatchObject({ round: 2, added: [{ label: 'E' }] })
    expect(harness.state('a')!.rounds[1]!.entries.map((entry) => [entry.variant, entry.carried])).toEqual([['v4', true], ['v5', false]])
  })

  it('does not record a request the agent never got', async () => {
    const { harness } = await seeded({ sendToAgent: () => Promise.reject(new Error('no session')) })
    await harness.invoke('a', 'vote', { variant: 'v1', vote: 'pick' }, 'ui')
    await expect(harness.invoke('a', 'send', { kind: 'use' }, 'ui')).rejects.toThrow()
    expect(harness.state('a')!.rounds[0]!.sent).toBeNull()
  })

  it('keeps one bakeoff per id, shared by every panel on it, and one per chat without an id', async () => {
    const { harness, added } = await seeded()
    expect((await harness.open('b', { id: 'logo' })).status).toBe('Logo for the README: round 1, 3 variants, no winner yet')
    await harness.invoke('b', 'vote', { variant: 'v2', vote: 'pick' }, 'ui')
    expect(harness.state('a')!.rounds[0]!.entries[1]!.vote).toBe('pick')
    expect((await harness.open('a', { id: 'logo', title: 'README logo' })).status).toBe('README logo: round 1, 3 variants, winner B')
    expect(harness.state('b')).toMatchObject({ title: 'README logo', brief: 'Blobby plus one prop.' })

    expect((await harness.open('c')).status).toBe('Bakeoff: no variants yet')
    expect(harness.state('c')).toMatchObject({ id: 'chat-test-session', variants: [] })
    await expect(harness.open('d', { id: 'Not A Slug' })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(existsSync(join(added.folder, 'round-1', 'a-chart-card.png'))).toBe(true)
  })
})
