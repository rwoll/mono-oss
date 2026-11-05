import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { CanvasKitError, defineCanvas, z, type ActionContext } from '@rwoll/canvas-kit'
import { AGENT_OUTCOMES, KEY, linkSchema, outcomeValue, type Item, type Link, type Triage } from './format.ts'
import { isGithubItem, LinkStatuses, runGh, type GhRunner } from './github.ts'
import { openPath, openUrl as openWithHost, productScheme, sessionUrl } from './open.ts'
import { batchFile, fixBrief, investigateBrief, sendPrompt, type BatchEntry } from './prompts.ts'
import { moveInto, readOutcomes, RunReader, TriageFile, writeAtomic } from './store.ts'
import { findingViews, inside, runView, type FindingView, type QaState } from './view.ts'

export type { FindingView, QaState, RunView } from './view.ts'

/** Where the agents-qa skill writes runs, unless this is set. */
export const ROOT_ENV = 'AGENTS_QA_ROOT'
const MAX_LINKS = 20
const MAX_PROBLEMS = 5

const line = (max: number) => z.string().trim().max(max)
const keySchema = z.string().regex(KEY, 'must be a finding key')
const githubUrl = z
  .string()
  .max(300)
  .regex(/^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9_-]{0,38}\/[A-Za-z0-9._-]{1,100}\/(?:issues|pull)\/[1-9]\d{0,8}\/?$/, 'must be a GitHub issue or pull request URL')

export interface QaOptions {
  /** The QA folder. Defaults to `AGENTS_QA_ROOT` or `~/agents-window-qa`. */
  root?: () => string
  /** The microsoft/vscode checkout used when you have not chosen one. Defaults to `~/code/vscode`. */
  defaultVscodePath?: () => string
  now?: () => number
  requestId?: () => string
  /** Opens a URL with the operating system; tests record it instead. */
  openUrl?: (url: string) => Promise<void>
  /** Opens a local file with the operating system; tests record it instead. */
  openFile?: (path: string) => Promise<void>
  /** The URL scheme of the VS Code build, such as `vscode-insiders`. */
  productScheme?: () => string | null
  gh?: GhRunner
}

type Ctx = ActionContext<QaState>

const stateSchema = z.custom<QaState>((value) => typeof value === 'object' && value !== null && Array.isArray((value as QaState).findings))

/** Links merged by URL or path, newest last. */
function mergeLinks(existing: readonly Link[], added: readonly Link[]): Link[] {
  const id = (link: Link) => link.url ?? link.path
  const kept = existing.filter((link) => !added.some((next) => id(next) === id(link)))
  return [...kept, ...added].slice(-MAX_LINKS)
}

const busy = (item: Item | undefined) => item?.state === 'sent' || item?.state === 'working'

export function createAgentsQaCanvas(options: QaOptions = {}) {
  const root = options.root ?? (() => process.env[ROOT_ENV] || join(homedir(), 'agents-window-qa'))
  const defaultVscodePath = options.defaultVscodePath ?? (() => join(homedir(), 'code', 'vscode'))
  const now = options.now ?? Date.now
  const iso = () => new Date(now()).toISOString()
  const requestId = options.requestId ?? (() => `${iso().replace(/[-:]/g, '').slice(0, 15)}-${randomBytes(3).toString('hex')}`)
  const open = options.openUrl ?? openWithHost
  const openFile = options.openFile ?? openPath
  const scheme = options.productScheme ?? (() => productScheme())
  const runs = new RunReader()
  const triage = new TriageFile(() => join(root(), 'triage.json'), now)
  const links = new LinkStatuses(options.gh ?? runGh, now)
  /** Outcome files that could not be used; they are moved aside, so each is reported by one process. */
  let outcomeProblems: string[] = []

  async function applyOutcomes(): Promise<void> {
    const dir = root()
    const { outcomes, problems } = await readOutcomes(dir)
    if (problems.length) outcomeProblems = [...outcomeProblems, ...problems].slice(-MAX_PROBLEMS)
    if (!outcomes.length) return
    await triage.update((current) => {
      let items = current.items
      for (const { outcome } of outcomes) {
        const item = items[outcome.key]
        // You cleared the decision while its session ran; its result has nowhere to go.
        if (!item?.decision) continue
        items = {
          ...items,
          [outcome.key]: { ...item, state: outcome.state, links: mergeLinks(item.links, outcome.links), ...(outcome.detail && { detail: outcome.detail }), updatedAt: iso() },
        }
      }
      return items === current.items ? current : { ...current, items }
    })
    for (const { file } of outcomes) await moveInto(file, join(dir, 'outcomes', 'applied'))
  }

  async function compute(): Promise<QaState> {
    const dir = root()
    const [reads, read] = await Promise.all([runs.read(dir), triage.read()])
    const runViews = reads.map((entry) => runView(entry, dir, now(), existsSync))
    return {
      root: dir,
      rootExists: existsSync(dir),
      runs: runViews,
      findings: findingViews(reads, read.triage, dir),
      settings: { fixModel: read.triage.settings.fixModel, vscodePath: read.triage.settings.vscodePath ?? defaultVscodePath() },
      links: links.snapshot(),
      problems: [...(read.problem ? [read.problem] : []), ...runViews.flatMap((run) => (run.problem ? [`Run ${run.id}: ${run.problem}`] : [])), ...outcomeProblems],
      syncedAt: iso(),
    }
  }

  /** Look up the pull requests and issues your decisions led to, then show their state. */
  function refreshLinks(ctx: Ctx, state: QaState) {
    const urls = state.findings.flatMap((finding) => [
      ...(finding.item?.links ?? []).flatMap((link) => (link.url && isGithubItem(link.url) ? [link.url] : [])),
      ...(finding.item?.trackedUrl ? [finding.item.trackedUrl] : []),
    ])
    void links
      .refresh(urls)
      .then((changed) => {
        if (changed) ctx.setState((current) => ({ ...current, links: links.snapshot() }))
      })
      .catch((error: unknown) => ctx.log(`Agents QA could not look up pull requests: ${error instanceof Error ? error.message : String(error)}`, 'warning'))
  }

  async function publish(ctx: Ctx): Promise<QaState> {
    const next = await compute()
    ctx.setState(next)
    refreshLinks(ctx, next)
    return next
  }

  async function findingFor(key: string): Promise<{ state: QaState; finding: FindingView }> {
    const state = await compute()
    const finding = state.findings.find((entry) => entry.key === key)
    if (!finding) throw new CanvasKitError('not_found', `No finding has the key "${key}". Refresh the canvas.`, 404)
    return { state, finding }
  }

  const changeItems = (change: (items: Triage['items']) => Triage['items']) =>
    triage.update((current) => {
      const items = change(current.items)
      return items === current.items ? current : { ...current, items }
    })

  async function initial(): Promise<QaState> {
    await applyOutcomes().catch(() => undefined)
    return compute()
  }

  return defineCanvas({
    id: 'rwoll-agents-qa',
    title: 'Agents QA',
    description:
      'Triage findings from scheduled VS Code Agents window QA runs, which the agents-qa skill writes under ~/agents-window-qa/runs. ' +
      'The user picks an outcome for each finding: fix (a session opens a draft PR), file an issue, investigate the root cause, ' +
      'already tracked, or suppress (later runs don\'t report it again). Send asks this chat to carry out the decisions with an [agents-qa-triage:…] message; record ' +
      'each result with record_outcome.',
    state: stateSchema,
    init: () => initial(),
    reopen: () => initial(),
    files: async (ctx, id) => {
      const media = [...ctx.state.findings.flatMap((finding) => finding.media), ...ctx.state.runs.flatMap((run) => run.media)].find((entry) => entry.id === id)
      if (!media || media.kind === 'file') return null
      // Check real paths, so a link inside the QA folder cannot lead out of it.
      try {
        const [base, target] = await Promise.all([realpath(ctx.state.root), realpath(media.path)])
        return inside(base, target) ? { path: target } : null
      } catch {
        return null
      }
    },
    status: (state) => {
      const open = state.findings.filter((finding) => !finding.item?.decision && finding.status !== 'fixed').length
      const latest = state.runs[0]
      if (!latest) return 'No QA runs yet'
      return `${open} finding${open === 1 ? '' : 's'} to triage; latest run ${latest.id} (${latest.status})`
    },
    actions: ({ action }) => ({
      sync: action({
        description: 'Read the QA folder again: new runs, your decisions, and results that sessions reported.',
        expose: 'ui',
        run: async (ctx) => {
          await applyOutcomes()
          const state = await publish(ctx)
          return { runs: state.runs.length, findings: state.findings.length }
        },
      }),

      decide: action({
        description:
          'Choose what happens to a finding: fix, issue, investigate, tracked (pass trackedUrl, or its first matching issue is used), ' +
          'suppress, or null to clear the decision. Fix, issue, and investigate wait for Send; tracked and suppress are done at once.',
        input: z.object({ key: keySchema, decision: outcomeValue.nullable(), trackedUrl: githubUrl.optional() }),
        run: async (ctx, { key, decision, trackedUrl }) => {
          const { finding } = await findingFor(key)
          const tracked =
            decision === 'tracked' ? (trackedUrl ?? finding.matches.find((match) => match.relation === 'duplicate')?.url ?? finding.matches[0]?.url) : undefined
          if (decision === 'tracked' && !tracked) {
            throw new CanvasKitError('needs_issue', 'Paste the URL of the issue that already tracks this finding.', 400)
          }
          await changeItems((items) => {
            const item = items[key]
            if (busy(item)) {
              throw new CanvasKitError('in_progress', `The agent is still working on "${finding.title}". Wait for its result, or reset it first.`, 409)
            }
            const next = { ...items }
            if (decision === null) {
              if (item?.note) next[key] = { ...item, decision: null, state: 'draft', trackedUrl: undefined, updatedAt: iso() }
              else delete next[key]
              return next
            }
            const base: Item = item ?? { decision: null, note: '', state: 'draft', updatedAt: iso(), links: [] }
            next[key] = {
              ...base,
              decision,
              state: decision === 'tracked' || decision === 'suppress' ? 'done' : 'draft',
              trackedUrl: tracked,
              sentAt: undefined,
              batch: undefined,
              updatedAt: iso(),
            }
            return next
          })
          await publish(ctx)
          return { key, decision }
        },
      }),

      set_note: action({
        description: "Save a note for the agent that carries out a finding's decision, such as how you want it fixed.",
        input: z.object({ key: keySchema, note: line(4000) }),
        run: async (ctx, { key, note }) => {
          await findingFor(key)
          await changeItems((items) => {
            const item = items[key]
            if ((item?.note ?? '') === note) return items
            const base: Item = item ?? { decision: null, note: '', state: 'draft', updatedAt: iso(), links: [] }
            return { ...items, [key]: { ...base, note, updatedAt: iso() } }
          })
          await publish(ctx)
          return { key }
        },
      }),

      accept_suggestions: action({
        description: "Take the run's suggested decision for every finding you have not decided yet, or only for the given keys.",
        expose: 'ui',
        input: z.object({ keys: z.array(keySchema).max(200).optional() }),
        run: async (ctx, { keys }) => {
          const state = await compute()
          const wanted = keys ? new Set(keys) : null
          let accepted = 0
          await changeItems((items) => {
            const next = { ...items }
            for (const finding of state.findings) {
              const suggestion = finding.recommendation
              if (!suggestion || finding.status === 'fixed' || next[finding.key]?.decision || (wanted && !wanted.has(finding.key))) continue
              const tracked = suggestion.outcome === 'tracked' ? finding.matches.find((match) => match.relation === 'duplicate')?.url : undefined
              if (suggestion.outcome === 'tracked' && !tracked) continue
              const base: Item = next[finding.key] ?? { decision: null, note: '', state: 'draft', updatedAt: iso(), links: [] }
              next[finding.key] = {
                ...base,
                decision: suggestion.outcome,
                state: suggestion.outcome === 'tracked' || suggestion.outcome === 'suppress' ? 'done' : 'draft',
                trackedUrl: tracked,
                updatedAt: iso(),
              }
              accepted += 1
            }
            return accepted ? next : items
          })
          await publish(ctx)
          return { accepted }
        },
      }),

      send: action({
        description: 'Ask the agent in this chat to carry out every Fix, File issue, and Investigate decision that has not been sent.',
        expose: 'ui',
        run: async (ctx) => {
          const state = await compute()
          const ready = state.findings.filter((finding) => finding.item?.decision && AGENT_OUTCOMES.includes(finding.item.decision) && finding.item.state === 'draft')
          if (!ready.length) throw new CanvasKitError('nothing_to_send', 'Nothing to send. Choose Fix, File issue, or Investigate for a finding first.', 409)
          const dir = root()
          const batchId = requestId()
          const runsById = new Map(state.runs.map((run) => [run.id, run]))
          const entries: BatchEntry[] = []
          for (const finding of ready) {
            const item = finding.item!
            const run = runsById.get(finding.runId)
            let brief: string | undefined
            if (item.decision === 'fix' || item.decision === 'investigate') {
              brief = join(dir, 'requests', batchId, `${finding.key}.md`)
              const paths = { root: dir, outcomeFile: join(dir, 'outcomes', `${finding.key}-${batchId}.json`) }
              await writeAtomic(brief, `${(item.decision === 'fix' ? fixBrief : investigateBrief)(finding, run, item, paths)}\n`)
            }
            entries.push({ finding, run, item, ...(brief && { brief }) })
          }
          const file = join(dir, 'requests', `${batchId}.md`)
          await writeAtomic(file, `${batchFile(entries, { batchId, instanceId: ctx.instanceId, fixModel: state.settings.fixModel, vscodePath: state.settings.vscodePath })}\n`)
          const keys = new Set(ready.map((finding) => finding.key))
          const at = iso()
          await changeItems((items) =>
            Object.fromEntries(
              Object.entries(items).map(([key, item]): [string, Item] => [key, keys.has(key) && item.state === 'draft' ? { ...item, state: 'sent', sentAt: at, batch: batchId } : item]),
            ),
          )
          try {
            await ctx.sendToAgent({
              prompt: sendPrompt({ batchId, instanceId: ctx.instanceId, file, count: ready.length }),
              displayPrompt: `Agents QA · ${ready.length} decision${ready.length === 1 ? '' : 's'}`,
            })
          } catch (error) {
            await changeItems((items) =>
              Object.fromEntries(
                Object.entries(items).map(([key, item]): [string, Item] => [
                  key,
                  item.batch === batchId && item.state === 'sent' ? { ...item, state: 'draft', sentAt: undefined, batch: undefined } : item,
                ]),
              ),
            )
            await publish(ctx)
            throw error
          }
          await publish(ctx)
          return { sent: ready.length, file }
        },
      }),

      reset: action({
        description: 'Put a sent, working, or failed decision back to not sent, so it can be changed or sent again.',
        expose: 'ui',
        input: z.object({ key: keySchema }),
        run: async (ctx, { key }) => {
          await changeItems((items) => {
            const item = items[key]
            if (!item?.decision) return items
            return { ...items, [key]: { ...item, state: 'draft', sentAt: undefined, batch: undefined, updatedAt: iso() } }
          })
          await publish(ctx)
          return { key }
        },
      }),

      record_outcome: action({
        description:
          'Record what came of a decision you carried out from an [agents-qa-triage:…] message: state working (a session is on it), ' +
          'done, or failed, with links to the pull request, issue, session (its agent-host-session:// link), or report file.',
        expose: 'agent',
        input: z.object({
          key: keySchema,
          state: z.enum(['working', 'done', 'failed']),
          links: z.array(linkSchema).max(10).default([]),
          detail: line(4000).optional(),
        }),
        run: async (ctx, { key, state, links: added, detail }) => {
          for (const link of added) {
            if (link.path && !isAbsolute(link.path)) throw new CanvasKitError('invalid_input', `${link.path} is not an absolute path.`, 400)
          }
          await changeItems((items) => {
            const item = items[key]
            if (!item?.decision) throw new CanvasKitError('not_found', `No decision was made for "${key}".`, 404)
            return { ...items, [key]: { ...item, state, links: mergeLinks(item.links, added), ...(detail && { detail }), updatedAt: iso() } }
          })
          await publish(ctx)
          return { key, state }
        },
      }),

      configure: action({
        description: 'Set the model for fix and investigation sessions, and the microsoft/vscode checkout they run in.',
        input: z.object({ fixModel: line(80).min(1).optional(), vscodePath: line(1000).min(1).optional() }),
        run: async (ctx, { fixModel, vscodePath }) => {
          if (vscodePath && (!isAbsolute(vscodePath) || !existsSync(join(vscodePath, '.git')))) {
            throw new CanvasKitError('invalid_input', `${vscodePath} is not a git checkout. Give the absolute path of a microsoft/vscode clone.`, 400)
          }
          await triage.update((current) => ({ ...current, settings: { ...current.settings, ...(fixModel && { fixModel }), ...(vscodePath && { vscodePath }) } }))
          const state = await publish(ctx)
          return state.settings
        },
      }),

      open_file: action({
        description: 'Open a report, recording, or other file from the QA folder with its usual app.',
        expose: 'ui',
        input: z.object({ path: z.string().min(1).max(1000) }),
        run: async (_ctx, { path }) => {
          let target: string
          try {
            const [base, real] = await Promise.all([realpath(root()), realpath(path)])
            if (!inside(base, real)) throw new Error('outside')
            target = real
          } catch {
            throw new CanvasKitError('not_found', 'Only existing files in the QA folder can be opened.', 404)
          }
          await openFile(target)
          return { opened: true }
        },
      }),

      open_link: action({
        description: 'Open a GitHub link in the browser, or a session link in the Agents window.',
        expose: 'ui',
        input: z.object({ url: z.string().min(1).max(500) }),
        run: async (_ctx, { url }) => {
          if (url.startsWith('https://')) await open(url)
          else {
            const product = scheme()
            const target = product ? sessionUrl(url, product) : null
            if (!target) throw new CanvasKitError('open_failed', 'This link cannot be opened from here. Open the session from the Sessions list.', 409)
            await open(target)
          }
          return { opened: true }
        },
      }),
    }),
  })
}

export default createAgentsQaCanvas()
