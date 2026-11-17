import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Invented Copilot sessions for tests and screenshots, written the way Copilot writes
// them: a folder per session with workspace.yaml and events.jsonl.

const NANO_PER_AIC = 1e9

export const SKILLS = {
  'monorepo-build': '# Build the monorepo\n\nRun `scripts/build-all.sh` before testing, then `pnpm test:changed` for the packages you touched.\n',
  'pr-descriptions': '# Pull request descriptions\n\nWrite the description to a file, then run `gh pr edit` with `--body-file`.\n',
  'release-notes': '# Release notes\n\nAdd an entry to `docs/release-notes.md` under the next version.\n',
  // Only prose: nothing in it can be looked for, so its use cannot be told.
  'writing-tone': '# Tone\n\nWrite plainly. Lead with the point, and keep sentences short.\n',
} as const
export type SkillName = keyof typeof SKILLS

export const MCP_TOOLS = ['issue-tracker-list_issues', 'issue-tracker-get_issue', 'issue-tracker-create_issue', 'issue-tracker-add_comment', 'docs-search-search', 'docs-search-open_page']
const BUILT_IN = ['bash', 'view', 'edit', 'grep', 'task', 'skill']

interface ToolOptions {
  result?: string
  success?: boolean
  exitCode?: number
  server?: string
  edits?: string[]
  agent?: string
}

/** One session's event log, built call by call. Each event is a second after the last. */
export class FakeSession {
  readonly id: string
  readonly workspace: { name?: string; repository?: string; branch?: string; client_name?: string }
  readonly #lines: string[] = []
  #at: number

  constructor(id: string, start: number, workspace: FakeSession['workspace'] = {}) {
    this.id = id
    this.workspace = workspace
    this.#at = start
    this.event('session.start', { sessionId: id, producer: 'copilot-agent', context: { repository: workspace.repository, branch: workspace.branch } })
  }

  /** When the next event happens. */
  get at() {
    return this.#at
  }

  wait(ms: number) {
    this.#at += ms
    return this
  }

  event(type: string, data: Record<string, unknown>, agent?: string) {
    this.#lines.push(JSON.stringify({ type, data, id: `e${this.#lines.length}`, timestamp: new Date(this.#at).toISOString(), ...(agent && { agentId: agent }) }))
    this.#at += 1000
    return this
  }

  /** A line as it is, such as one that is cut short. */
  raw(line: string) {
    this.#lines.push(line)
    return this
  }

  user(content: string, agent?: string) {
    return this.event('user.message', { content }, agent)
  }

  skill(name: string, content: string, agent?: string) {
    return this.event('skill.invoked', { name, path: `/plugins/sample/skills/${name}/SKILL.md`, content }, agent)
  }

  subagent(agent: string) {
    return this.event('subagent.started', { agentName: 'general-purpose' }, agent)
  }

  tool(name: string, args: unknown, options: ToolOptions = {}) {
    const toolCallId = `call-${this.#lines.length}`
    this.event('tool.execution_start', { toolCallId, toolName: name, arguments: args, ...(options.server && { mcpServerName: options.server, mcpToolName: name.slice(options.server.length + 1) }) }, options.agent)
    return this.event(
      'tool.execution_complete',
      {
        toolCallId,
        success: options.success ?? true,
        result: { content: options.result ?? 'ok' },
        ...(options.exitCode !== undefined && { shellExecution: { exitCode: options.exitCode } }),
        ...(options.edits && { fileEdits: options.edits.map((path) => ({ path, kind: 'edit' })) }),
      },
      options.agent,
    )
  }

  /** Which tools the model is given, and how large its system prompt is. */
  checkpoint(model: string, tools: readonly string[], systemTokens: number) {
    return this.event('session.usage_checkpoint', {
      promptCacheBreakState: [
        {
          conversation: 'main',
          lastActiveModel: model,
          models: { [model]: { tools: tools.map((name) => ({ name, ...(MCP_TOOLS.includes(name) && { mcp: true }) })), system_segments: [{ segment: 'identity', tokens: systemTokens }] } },
        },
      ],
    })
  }

  /** A model call. `aic` is null for a call that recorded none. `source` is the session that made it, when a fork repeats its parent's call. */
  call(model: string, usage: { input: number; output?: number; aic: number | null; toolTokens?: number; agent?: string; source?: string }) {
    return this.event(
      'session.usage_record',
      {
        usage: {
          model,
          inputTokens: usage.input,
          outputTokens: usage.output ?? 200,
          toolTokenCount: usage.toolTokens ?? 0,
          // A sub-agent's calls are recorded under its own ID.
          accounting: { sourceSessionId: usage.source ?? usage.agent ?? this.id },
          ...(usage.aic !== null && { copilotUsage: { totalNanoAiu: Math.round(usage.aic * NANO_PER_AIC) } }),
        },
      },
      usage.agent,
    )
  }

  async write(root: string): Promise<string> {
    const dir = join(root, this.id)
    await mkdir(dir, { recursive: true })
    const { name, repository, branch, client_name: client } = this.workspace
    const yaml = [`id: ${this.id}`, name && `name: ${JSON.stringify(name)}`, repository && `repository: ${repository}`, branch && `branch: ${branch}`, `client_name: ${client ?? 'vscode-agent-host'}`]
    await writeFile(join(dir, 'workspace.yaml'), `${yaml.filter(Boolean).join('\n')}\n`)
    await writeFile(join(dir, 'events.jsonl'), `${this.#lines.join('\n')}\n`)
    return dir
  }
}

const OPUS = 'claude-opus-5.5'
const SOL = 'gpt-6-sol'
const DAY_MS = 24 * 60 * 60 * 1000

interface Sample {
  id: string
  title: string
  repository: string
  branch: string
  daysAgo: number
  model: string
  /** Model calls, and the AIC each costs. */
  calls: number
  aic: number
  skills?: SkillName[]
  /** The session runs the build script that `monorepo-build` names. */
  builds?: boolean
  /** Of every ten shell commands, how many fail. */
  failures?: number
  /** Calls to the `docs-search` MCP server. */
  searches?: number
  subagents?: number
  files?: number
}

const SAMPLES: Sample[] = [
  { id: 'offline-sync', title: 'Build the offline sync queue', repository: 'acme/mobile-app', branch: 'offline-sync', daysAgo: 13, model: OPUS, calls: 60, aic: 15, skills: ['monorepo-build', 'release-notes'], builds: true, files: 12, searches: 3 },
  { id: 'sync-ci', title: 'Fix CI failures on the offline sync pull request', repository: 'acme/mobile-app', branch: 'offline-sync', daysAgo: 11, model: OPUS, calls: 46, aic: 15, skills: ['monorepo-build', 'pr-descriptions', 'release-notes'], builds: true, failures: 4, files: 3 },
  { id: 'billing-forms', title: 'Migrate billing settings to the new form library', repository: 'acme/web-app', branch: 'billing-forms', daysAgo: 20, model: OPUS, calls: 40, aic: 15, skills: ['monorepo-build', 'release-notes'], builds: true, subagents: 3, files: 9 },
  { id: 'webhook-dupes', title: 'Fix duplicate webhook deliveries', repository: 'acme/api-gateway', branch: 'fix-webhook-dupes', daysAgo: 10, model: OPUS, calls: 30, aic: 15, skills: ['pr-descriptions'], failures: 3, files: 4 },
  { id: 'csv-export', title: 'Add CSV export to the reports page', repository: 'acme/web-app', branch: 'reports-csv-export', daysAgo: 6, model: OPUS, calls: 24, aic: 15, skills: ['monorepo-build'], builds: true, files: 6 },
  { id: 'queue-libraries', title: 'Compare queue libraries for the job runner', repository: 'acme/platform-tools', branch: 'main', daysAgo: 24, model: OPUS, calls: 18, aic: 15, skills: ['writing-tone'], subagents: 4, searches: 6 },
  { id: 'review-comments', title: 'Address review comments on billing settings', repository: 'acme/web-app', branch: 'billing-forms', daysAgo: 18, model: SOL, calls: 30, aic: 1, skills: ['pr-descriptions'], files: 2 },
  { id: 'retry-upload', title: 'Add retry to the upload client', repository: 'acme/web-app', branch: 'upload-retry', daysAgo: 5, model: SOL, calls: 40, aic: 1, skills: ['monorepo-build'], builds: true, files: 3 },
  { id: 'flaky-login', title: 'Fix the flaky login test', repository: 'acme/web-app', branch: 'fix-login-test', daysAgo: 4, model: SOL, calls: 26, aic: 1, files: 1 },
  { id: 'e2e-export', title: 'Run the end-to-end suite for CSV export', repository: 'acme/web-app', branch: 'reports-csv-export', daysAgo: 3, model: SOL, calls: 22, aic: 1, failures: 2 },
  { id: 'readme-setup', title: 'Update the README setup steps', repository: 'acme/platform-tools', branch: 'docs-setup', daysAgo: 8, model: SOL, calls: 10, aic: 1, skills: ['writing-tone'], files: 1 },
  { id: 'bump-deps', title: 'Bump the lint dependencies', repository: 'acme/platform-tools', branch: 'bump-lint', daysAgo: 2, model: SOL, calls: 8, aic: 1, files: 2 },
  { id: 'review-retry', title: 'Review this pull request for the upload retry', repository: 'acme/web-app', branch: 'upload-retry', daysAgo: 1, model: SOL, calls: 6, aic: 1 },
]

function sample(spec: Sample, now: number): FakeSession {
  const session = new FakeSession(spec.id, now - spec.daysAgo * DAY_MS, { name: spec.title, repository: spec.repository, branch: spec.branch })
  session.checkpoint(spec.model, [...BUILT_IN, ...MCP_TOOLS], 9000)
  session.user(spec.title)
  for (const name of spec.skills ?? []) session.skill(name, SKILLS[name])
  const agents = Array.from({ length: spec.subagents ?? 0 }, (_unused, index) => `${spec.id}-agent-${index + 1}`)
  for (const agent of agents) session.subagent(agent)
  for (let call = 0; call < spec.calls; call++) {
    // Sub-agents take every other call of a session that has them.
    const agent = agents.length && call % 2 ? agents[(call >> 1) % agents.length] : undefined
    const options = agent ? { agent } : {}
    if (call % 3 === 0) {
      const failed = (call / 3) % 10 < (spec.failures ?? 0)
      session.tool('bash', { command: spec.builds && call === 0 ? 'scripts/build-all.sh' : 'pnpm test' }, { ...options, exitCode: failed ? 1 : 0, result: failed ? 'x'.repeat(4000) : 'x'.repeat(1200) })
    } else if (call % 3 === 1) {
      session.tool('view', { path: `src/module-${call}.ts` }, { ...options, result: 'x'.repeat(6000) })
    } else if (spec.searches && call / 3 < spec.searches) {
      session.tool('docs-search-search', { query: 'queue retries' }, { ...options, server: 'docs-search', result: 'x'.repeat(3000) })
    } else if (spec.files) {
      session.tool('edit', { path: `src/module-${call % spec.files}.ts` }, { ...options, edits: [`src/module-${call % spec.files}.ts`] })
    }
    session.call(spec.model, { input: 14_000 + call * 2500, output: 300, aic: spec.aic, toolTokens: 4800, ...options })
    session.wait(40_000)
  }
  return session
}

const MORE_TITLES = [
  'Add pagination to the audit log', 'Fix the date picker on small screens', 'Explain how the job runner retries', 'Update the changelog for the next release',
  'Add tests for the webhook signer', 'Rename the settings module', 'Review this pull request for the audit log', 'Address review comments on the signer',
  'Implement dark mode for the reports page', 'Fix a crash when the queue is empty', 'Investigate slow cold starts', 'Draft the migration guide',
  'Verify the export on a clean checkout', 'Bump the build tools', 'Support bulk upload in the client', 'Debug the stuck deployment',
]
const REPOSITORIES = ['acme/web-app', 'acme/mobile-app', 'acme/api-gateway', 'acme/platform-tools']

/** One more session, small and unlike its neighbors. A fixed pattern, not chance, so every run draws the same picture. */
function another(index: number): Sample {
  const opus = index % 9 === 4
  return {
    id: `more-${index + 1}`,
    title: MORE_TITLES[index % MORE_TITLES.length] as string,
    repository: REPOSITORIES[index % REPOSITORIES.length] as string,
    branch: 'main',
    daysAgo: 1 + ((index * 7) % 28),
    model: opus ? OPUS : SOL,
    calls: 3 + ((index * 5) % 29),
    aic: opus ? 15 : 1,
    skills: index % 3 === 0 ? ['monorepo-build'] : index % 5 === 1 ? ['pr-descriptions'] : [],
    builds: index % 6 === 0,
    failures: index % 7 === 3 ? 2 : 0,
    searches: index % 8 === 0 ? 2 : 0,
    files: index % 4,
  }
}

/**
 * Thirteen sessions over the last 24 days, with a few expensive ones on `claude-opus-5.5`
 * and many cheap ones on `gpt-6-sol`, and `more` small ones for a picture of a month of work.
 */
export async function writeSampleSessions(root: string, now: number, more = 0): Promise<void> {
  const specs = [...SAMPLES, ...Array.from({ length: more }, (_unused, index) => another(index))]
  await Promise.all(specs.map((spec) => sample(spec, now).write(root)))
}
