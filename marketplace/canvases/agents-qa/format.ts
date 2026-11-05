import { z } from '@rwoll/canvas-kit'

// The files the agents-qa skill and this canvas share, all under the QA folder (default ~/agents-window-qa):
//   runs/<run>/findings.json   one QA run, written only by the skill
//   triage.json                your decisions and what came of them, written by the canvas
//   outcomes/*.json            results from fix and investigation sessions, one file each, merged by the canvas
// skills/agents-qa/references/findings-format.md documents the same shapes for the agent.

export const SEVERITIES = ['high', 'medium', 'low', 'polish'] as const
export const OUTCOMES = ['fix', 'issue', 'investigate', 'tracked', 'suppress'] as const
/** What a run saw: a new problem, one an earlier run reported, or an earlier problem that is gone. */
export const OBSERVATIONS = ['new', 'still-reproduces', 'fixed'] as const
export const ITEM_STATES = ['draft', 'sent', 'working', 'done', 'failed'] as const
export const LINK_KINDS = ['pr', 'issue', 'session', 'file', 'other'] as const
/** Decisions the agent carries out; tracked and suppressed findings need no agent. */
export const AGENT_OUTCOMES: readonly Outcome[] = ['fix', 'issue', 'investigate']

export type Severity = (typeof SEVERITIES)[number]
export type Outcome = (typeof OUTCOMES)[number]
export type ItemState = (typeof ITEM_STATES)[number]

export const KEY = /^[a-z0-9][a-z0-9-]{1,79}$/
/** A GitHub user name, without the @. */
export const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

const text = (max: number) => z.string().trim().max(max)
/** A decision. `dismiss`, the earlier name for `suppress`, is still read. */
export const outcomeValue = z.preprocess((value) => (value === 'dismiss' ? 'suppress' : value), z.enum(OUTCOMES))
const time = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'must be an ISO time')
const httpsUrl = z
  .string()
  .max(500)
  .refine((value) => {
    try {
      return new URL(value).protocol === 'https:'
    } catch {
      return false
    }
  }, 'must be an https URL')

export const mediaSchema = z.object({
  /** Absolute, or relative to the run folder. */
  path: text(1000).min(1),
  label: text(200).optional(),
})

const matchSchema = z.object({
  url: httpsUrl,
  relation: z.enum(['duplicate', 'related']).default('related'),
  state: z.enum(['open', 'closed']).optional(),
  note: text(400).optional(),
})

const findingSchema = z.object({
  /** The run's own label, such as W4. */
  id: text(20).min(1),
  /** Stable across runs: a run that sees the same problem again reuses it. */
  key: z.string().regex(KEY, 'must be a kebab-case slug, such as mcp-install-account-changed'),
  title: text(200).min(1),
  severity: z.enum(SEVERITIES),
  area: text(60).default('Other'),
  status: z.enum(OBSERVATIONS).default('new'),
  summary: text(4000).default(''),
  repro: z
    .object({
      setup: text(4000).default(''),
      steps: z.array(text(1000)).max(40).default([]),
      expected: text(2000).default(''),
      actual: text(4000).default(''),
    })
    .prefault({}),
  prs: z.array(httpsUrl).max(20).default([]),
  media: z.array(mediaSchema).max(40).default([]),
  matches: z.array(matchSchema).max(10).default([]),
  owner: z.object({ login: z.string().regex(LOGIN, 'must be a GitHub user name without @'), reason: text(300).optional() }).optional(),
  /** What the run's agent proposes you decide. */
  recommendation: z.object({ outcome: outcomeValue, reason: text(600).default('') }).optional(),
})

export const runSchema = z.object({
  format: z.literal('agents-qa-run'),
  version: z.literal(1),
  id: z.string().regex(RUN_ID),
  status: z.enum(['running', 'complete', 'failed']),
  startedAt: time,
  finishedAt: time.optional(),
  build: z.object({ version: text(80).default(''), commit: text(64).default('') }).prefault({}),
  environment: text(400).default(''),
  scope: z
    .object({
      since: time.optional(),
      /** The build the PRs are counted from: those in this build and not in the base. Usually the last run's build. */
      base: z.object({ commit: text(64).min(1), version: text(80).optional(), run: z.string().regex(RUN_ID).optional() }).optional(),
      /** Merged PRs the run self-hosted. */
      prs: z.array(httpsUrl).max(300).default([]),
      /** The other PRs in this build and not the base, each with why the run didn't test it. */
      skipped: z.array(z.object({ pr: httpsUrl, reason: text(200).min(1) })).max(500).default([]),
      /** The area explored beyond the PRs. */
      area: text(80).optional(),
      notes: text(1000).optional(),
    })
    .prefault({}),
  summary: text(6000).default(''),
  error: text(2000).optional(),
  /** Relative to the run folder. */
  report: text(300).default('REPORT.md'),
  /** Run-wide media, such as recordings of the whole pass. */
  media: z.array(mediaSchema).max(20).default([]),
  findings: z.array(findingSchema).max(200).default([]),
  verified: z.array(z.object({ pr: httpsUrl, note: text(400).default('') })).max(300).default([]),
})

export const linkSchema = z
  .object({
    url: z
      .string()
      .max(500)
      .refine((value) => value.startsWith('https://') || value.startsWith('agent-host-session://'), 'must be an https or agent-host-session:// URL')
      .optional(),
    /** An absolute local file, such as an investigation report. */
    path: text(1000).optional(),
    label: text(120).min(1),
    kind: z.enum(LINK_KINDS).default('other'),
  })
  .refine((link) => Boolean(link.url) !== Boolean(link.path), 'needs exactly one of url or path')

export const itemSchema = z.object({
  decision: outcomeValue.nullable().default(null),
  /** Your note to the agent that carries out the decision. */
  note: text(4000).default(''),
  /** For tracked findings: the issue that already covers it. */
  trackedUrl: httpsUrl.optional(),
  state: z.enum(ITEM_STATES).default('draft'),
  updatedAt: time,
  sentAt: time.optional(),
  batch: text(40).optional(),
  links: z.array(linkSchema).max(20).default([]),
  detail: text(4000).optional(),
})

export const settingsSchema = z
  .object({
    fixModel: text(80).min(1).default('claude-opus-5.5'),
    /** A microsoft/vscode checkout; fix and investigation sessions run in new worktrees of it. */
    vscodePath: text(1000).optional(),
  })
  .prefault({})

export const triageSchema = z.object({
  format: z.literal('agents-qa-triage'),
  version: z.literal(1),
  items: z.record(z.string().regex(KEY), itemSchema).default({}),
  settings: settingsSchema,
})

export const outcomeSchema = z.object({
  format: z.literal('agents-qa-outcome'),
  version: z.literal(1),
  key: z.string().regex(KEY),
  state: z.enum(['working', 'done', 'failed']),
  links: z.array(linkSchema).max(10).default([]),
  detail: text(4000).optional(),
})

export type Run = z.output<typeof runSchema>
export type RunFinding = Run['findings'][number]
export type Media = z.output<typeof mediaSchema>
export type Link = z.output<typeof linkSchema>
export type Item = z.output<typeof itemSchema>
export type Settings = z.output<typeof settingsSchema>
export type Triage = z.output<typeof triageSchema>
export type OutcomeFile = z.output<typeof outcomeSchema>

export const emptyTriage = (): Triage => ({ format: 'agents-qa-triage', version: 1, items: {}, settings: { fixModel: 'claude-opus-5.5' } })

/** The first problem with a value, as one line. */
export function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return 'invalid'
  const path = issue.path.length ? issue.path.join('.') : 'file'
  return `${path}: ${issue.message}`
}
