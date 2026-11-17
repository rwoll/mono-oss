// What the server and the page share: the task types, and the state the page draws.
// Nothing here imports Node.js, so App.tsx can import values from it.

export const TASK_TYPES = ['feature', 'followup', 'bugfix', 'research', 'qa', 'review', 'docs', 'chores'] as const
export type TaskType = (typeof TASK_TYPES)[number]

export const TASK_LABELS: Record<TaskType, string> = {
  feature: 'Feature work',
  followup: 'PR follow-up',
  bugfix: 'Bug fix',
  research: 'Research',
  qa: 'QA and testing',
  review: 'Code review',
  docs: 'Docs and writing',
  chores: 'Chores',
}

export const PERIODS = [7, 30, 90] as const
export type Period = (typeof PERIODS)[number]

/** How many of the most expensive sessions are called out. */
export const TOP_SESSIONS = 8
/** A session this many times its task type's median is called out. */
export const OUTLIER = 10

/** What the model read, by where it came from. */
export const READ_PARTS = ['base', 'conversation', 'output', 'skills', 'mcpDefs', 'mcpResults'] as const
export type ReadPart = (typeof READ_PARTS)[number]

export const READ_LABELS: Record<ReadPart, string> = {
  base: 'instructions and built-in tools',
  conversation: 'conversation',
  output: 'files and tool output',
  skills: 'skill instructions',
  mcpDefs: 'MCP tool definitions',
  mcpResults: 'MCP tool results',
}

/** Shares of what the model read, from 0 to 1. The parts sum to 1 when anything was read. */
export interface ReadSplit extends Record<ReadPart, number> {
  /** The part of `skills` from skills that were loaded and not used. */
  unusedSkills: number
  /** The part of `mcpDefs` from MCP servers that were never called. */
  unusedMcp: number
}

/** One session in the picture of sessions against task types. */
export interface Dot {
  id: string
  type: TaskType
  /** Share of all AIC, from 0 to 1. */
  share: number
  /** Times its task type's median. */
  multiple: number
  /** 1 for the most expensive, down to `TOP_SESSIONS`; null for the rest. */
  rank: number | null
}

export interface TypeRow {
  type: TaskType
  sessions: number
  share: number
  /** Null while amounts are hidden. */
  aic: number | null
  /** The median session's share of all AIC. */
  median: number
  /** The largest session, in times the median. */
  largest: number
}

/** A skill or an MCP server, across every session in the period. */
export interface ContextItem {
  kind: 'skill' | 'mcp'
  name: string
  /** MCP: the most of its tools the model was given in one session. */
  tools: number
  /** Sessions that loaded the skill, or gave the model the server's tools. */
  sessions: number
  /** Sessions that used the skill, or called the server. */
  used: number
  /** Skills: sessions where use cannot be told, because the skill names nothing to look for. */
  unknown: number
  /** MCP: tool calls, and how many failed. */
  calls: number
  failed: number
  /** Share of what the model read in all sessions. */
  share: number
  /** The part of `share` read in sessions that did not use it. */
  unused: number
}

export type TypeSource = 'auto' | 'you' | 'agent'

export interface SessionRow {
  id: string
  /** By AIC, 1 for the most expensive. */
  rank: number
  title: string
  type: TaskType
  typeSource: TypeSource
  repository: string
  branch: string
  client: string
  /** When its last model call ended, in ISO format. */
  endedAt: string
  activeMs: number
  filesChanged: number
  share: number
  aic: number | null
  multiple: number
  shareOfType: number
  reason: { tag: string; text: string }
  read: ReadSplit
  /** Skills and MCP servers that were in context and not used. */
  unusedSkills: string[]
  unusedMcp: string[]
}

export type SkillVerdict = 'used' | 'partly' | 'unused' | 'unknown'

export interface SessionDetail {
  id: string
  models: { model: string; share: number; aic: number | null }[]
  /** Share of the session's AIC spent by sub-agents, and how many there were. */
  subagentShare: number
  subagents: number
  within: {
    type: TaskType
    sessions: number
    typeShare: number
    self: number
    /** The largest other session of the type. */
    next: { rank: number; share: number } | null
    rest: number
    restCount: number
  }
  tools: { name: string; share: number; failed: number }[]
  /** Share of all tool calls that failed. */
  failed: number
  read: ReadSplit
  skills: { name: string; verdict: SkillVerdict; loadedAfterMs: number; share: number; note: string }[]
  mcp: { name: string; used: boolean; tools: number; calls: number; failed: number; share: number; note: string }[]
}

export interface ScanStatus {
  status: 'idle' | 'scanning' | 'ready' | 'error'
  done: number
  total: number
  /** When the sessions were last read, in ISO format. */
  scannedAt: string | null
  error: string | null
}

export interface SpendState {
  scan: ScanStatus
  /** The folder the sessions are read from. */
  source: string
  filters: { days: Period; repository: string | null }
  repositories: string[]
  /** False by default: the page then gets shares only, and every amount is null. */
  showAic: boolean
  showAll: boolean
  period: { from: string; to: string }
  totals: {
    sessions: number
    types: number
    aic: number | null
    /** Sessions left out because they recorded no AIC. */
    withoutAic: number
  }
  /** The findings, as one paragraph of Markdown. */
  summary: string
  types: TypeRow[]
  dots: Dot[]
  context: {
    read: ReadSplit
    skills: number
    mcp: number
    items: ContextItem[]
    /** Markdown. */
    note: string
  }
  top: { count: number; share: number; outliers: number; outlierShare: number }
  rows: SessionRow[]
  /** How many sessions are not in `rows`, their share, and the largest one's share. */
  more: { count: number; share: number; largest: number }
  selected: string | null
  detail: SessionDetail | null
}

/** A share as a percentage: whole numbers from 10%, one decimal below, so small shares stay apart. */
export function percent(share: number): string {
  const value = share * 100
  if (value <= 0) return '0%'
  if (value < 0.05) return '<0.1%'
  if (value >= 9.95) return `${Math.round(value)}%`
  return `${value.toFixed(1).replace(/\.0$/, '')}%`
}

/** A multiple, such as 8.5× or 36×. */
export function times(multiple: number): string {
  return `${multiple >= 9.95 ? Math.round(multiple) : multiple.toFixed(1).replace(/\.0$/, '')}×`
}

/** A length of time, such as 5h 48m, 12m, or 40s. */
export function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`
  const hours = Math.floor(minutes / 60)
  return hours ? `${hours}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`
}

/** An AIC amount, with more precision for small ones. */
export function credits(aic: number): string {
  return `${aic.toLocaleString('en-US', { maximumFractionDigits: aic < 10 ? 2 : aic < 100 ? 1 : 0 })} AIC`
}
