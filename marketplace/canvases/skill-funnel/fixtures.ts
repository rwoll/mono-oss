import { FakeSession, SKILLS } from '../copilot-spend/fixtures.ts'

// An invented Copilot session for tests and screenshots: fourteen skills available and
// four of them invoked, in a context of 24,000 tokens.

export const SAMPLE_START = Date.parse('2026-10-30T09:00:00Z')
export const SAMPLE_CONTEXT = 24_000

const FLAKY_TESTS = '# Flaky tests\n\nRerun the failing test with the script in this folder, then compare the runs.\n'
/** Instructions as long as a real skill's: about 1,500 tokens. */
const long = (content: string) => content + 'Say what you found, and what you did about it.\n'.repeat(128)

export const AVAILABLE: readonly (readonly [name: string, description: string])[] = [
  ['monorepo-build', 'Build and test the monorepo. Use before running tests or when a build fails.'],
  ['flaky-tests', 'Find out why a test fails some of the time. Use when a test passes on rerun.'],
  ['pr-descriptions', 'Write pull request titles & descriptions a reviewer can skim in 30 seconds.'],
  ['writing-tone', 'Write plainly, in the team’s voice. Use for docs, comments, and messages.'],
  ['release-notes', 'Add an entry to the release notes for a user-facing change.'],
  ['code-review', 'Review the changes on this branch for bugs and missing tests.'],
  ['db-migrations', 'Write and check a database migration, with a rollback.'],
  ['api-docs', 'Update the API reference when an endpoint changes.'],
  ['incident-notes', 'Write up an incident: timeline, cause, and follow-ups.'],
  ['design-tokens', 'Use the design system’s colors, spacing, and type.'],
  ['a11y-audit', 'Check a page for accessibility problems and fix them.'],
  ['dependency-updates', 'Update a dependency and read its changelog for breaking changes.'],
  ['perf-profiling', 'Profile a slow page or endpoint and find what takes the time.'],
  ['feature-flags', 'Put a change behind a feature flag, and remove flags that are done.'],
]

const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/** A system prompt that lists skills the way Copilot does. */
export function systemPrompt(skills: readonly (readonly [name: string, description: string])[] = AVAILABLE): string {
  const entries = skills.map(([name, description]) => `<skill>\n  <name>${escape(name)}</name>\n  <description>${escape(description)}</description>\n  <location>plugin</location>\n</skill>`)
  return `You are a coding agent.\n<skill>\n<available_skills>\n${entries.join('\n')}\n</available_skills>\n</skill>\nBe concise.`
}

/** What the log records when a skill is invoked. */
export const invoked = (name: string, content: string) => ({ name, path: `/plugins/sample/skills/${name}/SKILL.md`, content, trigger: 'agent-invoked' })

/** The sample session, before it is written: add to it to show a session that goes on. */
export function sampleSession(id: string, start = SAMPLE_START): FakeSession {
  return new FakeSession(id, start, { name: 'Fix the flaky upload test', repository: 'acme/web-app', branch: 'fix-upload-test' })
    .event('system.message', { role: 'system', content: systemPrompt() })
    .user('The upload test fails about one run in five. Find out why and fix it.')
    .event('skill.invoked', invoked('monorepo-build', long(SKILLS['monorepo-build'])))
    .event('skill.invoked', invoked('flaky-tests', long(FLAKY_TESTS)))
    .event('skill.invoked', invoked('pr-descriptions', long(SKILLS['pr-descriptions'])))
    .event('skill.invoked', invoked('writing-tone', long(SKILLS['writing-tone'])))
    .call('claude-opus-5.5', { input: SAMPLE_CONTEXT, aic: 15 })
}

/** Writes the sample session under `root` and returns its folder. */
export const writeSampleSession = (root: string, id: string, start = SAMPLE_START) => sampleSession(id, start).write(root)
