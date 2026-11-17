import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { classify } from './classify.ts'
import { FakeSession, SKILLS } from './fixtures.ts'
import { summarizeSession } from './scan.ts'
import { signOfUse, skillMarkers } from './skills.ts'
import { mcpServers } from './view.ts'

const START = Date.parse('2026-10-01T09:00:00Z')
const OPUS = 'claude-opus-5.5'
const SOL = 'gpt-6-sol'

describe('reading a session', () => {
  let root = ''
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'copilot-spend-scan-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const read = async (session: FakeSession) => summarizeSession(await session.write(root), session.id)

  it('adds up what it spent, and splits what the model read by where it came from', async () => {
    const summary = await read(
      new FakeSession('s1', START, { name: 'Add retry to the upload client', repository: 'acme/web-app', branch: 'upload-retry' })
        // Half the tools the model is given are MCP tools.
        .checkpoint(OPUS, ['bash', 'view', 'issue-tracker-list_issues', 'issue-tracker-get_issue'], 1000)
        .user('Add retry to the upload client')
        .skill('monorepo-build', SKILLS['monorepo-build'])
        .skill('release-notes', SKILLS['release-notes'])
        .call(OPUS, { input: 10_000, aic: 15, toolTokens: 2000 })
        .tool('bash', { command: 'scripts/build-all.sh' }, { exitCode: 1, result: 'x'.repeat(4000) })
        .tool('edit', { path: 'src/upload.ts' }, { edits: ['src/upload.ts'] })
        .call(SOL, { input: 12_000, aic: 1, toolTokens: 2000 }),
    )
    expect(summary).toMatchObject({
      title: 'Add retry to the upload client',
      repository: 'acme/web-app',
      calls: 2,
      nanoAiu: 16e9,
      inputTokens: 22_000,
      models: { [OPUS]: { nanoAiu: 15e9, calls: 1 }, [SOL]: { nanoAiu: 1e9, calls: 1 } },
      // The command exited with an error, though the tool call itself succeeded.
      tools: { shell: { calls: 1, failed: 1 }, edit: { calls: 1, failed: 0 } },
      filesChanged: 1,
      mcpTools: ['issue-tracker-list_issues', 'issue-tracker-get_issue'],
    })
    const parts = summary!.read
    expect(parts.mcpDefs).toBe(2000)
    expect(parts.skills).toBeGreaterThan(0)
    expect(parts.output).toBeGreaterThan(0)
    // Every token of both prompts is accounted for, give or take rounding.
    expect(Math.abs(Object.values(parts).reduce((sum, part) => sum + part, 0) - 22_000)).toBeLessThan(6)

    const [build, notes] = summary!.skills
    expect(build).toMatchObject({ name: 'monorepo-build', loads: 1, usedLoads: 1, unusedRead: 0, sign: 'scripts/build-all.sh' })
    expect(notes).toMatchObject({ name: 'release-notes', loads: 1, usedLoads: 0, sign: null })
    expect(notes!.unusedRead).toBe(notes!.read)
  })

  it('judges each agent that loaded a skill, and cannot judge a skill that names nothing', async () => {
    const summary = await read(
      new FakeSession('s2', START)
        .user('Build it')
        .skill('monorepo-build', SKILLS['monorepo-build'])
        .skill('writing-tone', SKILLS['writing-tone'])
        .subagent('helper')
        .skill('monorepo-build', SKILLS['monorepo-build'], 'helper')
        .tool('bash', { command: 'pnpm test:changed' })
        .tool('view', { path: 'src/a.ts' }, { agent: 'helper' })
        .call(OPUS, { input: 5000, aic: 15 })
        .call(OPUS, { input: 4000, aic: 15, agent: 'helper' }),
    )
    expect(summary!.skills).toMatchObject([
      { name: 'monorepo-build', loads: 2, usedLoads: 1, unknownLoads: 0 },
      { name: 'writing-tone', loads: 1, usedLoads: 0, unknownLoads: 1, unusedRead: 0 },
    ])
    expect(summary).toMatchObject({ subagents: 1, subagentNanoAiu: 15e9 })
  })

  it('skips long lines it has no use for, and a line that is cut short', async () => {
    const summary = await read(
      new FakeSession('s3', START)
        .user('Take a screenshot')
        // Longer than the chunk the log is read in.
        .raw(JSON.stringify({ type: 'session.binary_asset', data: { data: 'A'.repeat(3 * 1024 * 1024) } }))
        .call(SOL, { input: 3000, aic: 1 })
        .raw('{"type":"session.usage_record","data":{"usage":{"model":"gpt-6-sol","inputTok'),
    )
    expect(summary).toMatchObject({ calls: 1, nanoAiu: 1e9 })
  })

  it('stops counting a skill once the conversation is compacted', async () => {
    const session = (id: string, compact: boolean) => {
      const log = new FakeSession(id, START).checkpoint(OPUS, ['bash'], 1000).user('Build it').skill('release-notes', SKILLS['release-notes']).call(OPUS, { input: 8000, aic: 15 })
      if (compact) log.event('session.compaction_complete', { success: true, conversationTokens: 500 })
      return log.call(OPUS, { input: 8000, aic: 15 })
    }
    const [kept, compacted] = await Promise.all([read(session('kept', false)), read(session('compacted', true))])
    expect(compacted!.read.skills).toBeGreaterThan(0)
    expect(compacted!.read.skills).toBeLessThan(kept!.read.skills)
  })

  it('counts a fork’s own work, not the history it copied from its parent', async () => {
    const summary = await read(
      new FakeSession('fork', START)
        .user('Build it')
        .skill('release-notes', SKILLS['release-notes'])
        .tool('edit', { path: 'src/a.ts' }, { edits: ['src/a.ts'] })
        .subagent('helper')
        .call(OPUS, { input: 4000, aic: 15, agent: 'helper' })
        .call(OPUS, { input: 9000, aic: 15, source: 'parent' })
        // From here on, the fork's own.
        .tool('bash', { command: 'pnpm test' })
        .call(SOL, { input: 10_000, aic: 1 }),
    )
    expect(summary).toMatchObject({ calls: 1, nanoAiu: 1e9, inputTokens: 10_000, subagents: 0, subagentNanoAiu: 0, filesChanged: 0, tools: { shell: { calls: 1 } }, models: { [SOL]: { calls: 1 } } })
    expect(summary!.tools.edit).toBeUndefined()
    // The skill its parent loaded is still in context, and still read.
    expect(summary!.skills).toMatchObject([{ name: 'release-notes', loads: 1 }])
    expect(summary!.skills[0]!.read).toBeGreaterThan(0)
  })

  it('has nothing to say about a session with no model calls', async () => {
    expect(await read(new FakeSession('s4', START).user('Hello'))).toBeNull()
  })
})

describe('whether a skill was used', () => {
  it('looks for the names a skill gives in code formatting, not common ones or placeholders', () => {
    const markers = skillMarkers(
      ['---', 'name: sample', '---', '', 'Run `gh pr create` or `canvas-kit new <name>`, then edit `package.json`.', '', '```sh', 'pnpm exec blobby-sandbox start --recipe base', '```', ''].join('\n'),
    )
    expect(markers).toEqual(expect.arrayContaining(['gh pr create', 'canvas-kit', 'blobby-sandbox']))
    expect(markers).not.toEqual(expect.arrayContaining(['package.json', '<name>', '--recipe']))
  })

  it('finds a named tool, a named command, or the skill’s folder in a tool call', () => {
    const folder = '/plugins/sample/skills/annotate/'
    expect(signOfUse(['add_variants'], folder, 'invoke_canvas_action', '{"actionName":"add_variants"}')).toBe('add_variants')
    expect(signOfUse(['rename_chat'], folder, 'rename_chat', '{}')).toBe('rename_chat')
    expect(signOfUse([], folder, 'bash', '{"command":"node /plugins/sample/skills/annotate/scripts/install.ts"}')).toBe('its folder')
    expect(signOfUse(['add_variants'], folder, 'bash', '{"command":"ls"}')).toBeNull()
  })
})

it('works out the task type from how the request starts', () => {
  const type = (title: string, filesChanged = 0) => classify({ title, prompt: '', tools: {}, filesChanged })
  expect(type('Add retry to the upload client')).toBe('feature')
  expect(type('Fix duplicate webhook deliveries')).toBe('bugfix')
  expect(type('Address review comments on billing settings and fix the build')).toBe('followup')
  expect(type('Review this pull request for the upload retry')).toBe('review')
  expect(type('Compare queue libraries for the job runner')).toBe('research')
  expect(type('Run the end-to-end suite for CSV export')).toBe('qa')
  expect(type('Update the README setup steps')).toBe('docs')
  expect(type('Bump the lint dependencies')).toBe('chores')
  // Nothing in the request says: what the session did decides.
  expect(type('Billing settings', 3)).toBe('feature')
  expect(type('Billing settings')).toBe('research')
})

it('groups MCP tools by server, known servers first', () => {
  const servers = mcpServers(['team-tools-list_items', 'team-tools-beta-run', 'docs-search-open-page', 'docs-search-find', 'lookup'], ['team-tools-beta', 'team-tools'].sort((a, b) => b.length - a.length))
  expect(Object.fromEntries(servers)).toEqual({ 'team-tools': 1, 'team-tools-beta': 1, 'docs-search': 2, lookup: 1 })
})
