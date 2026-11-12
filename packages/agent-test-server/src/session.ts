import { randomBytes } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import { lastUserText, trailingToolResults, type LlmRequest, type Message } from './normalize.ts'
import type { PlanItem } from './encode.ts'
import {
  matchText, McpServerDef, ModelDef, Rule, toolNameMatches,
  type McpToolResult, type Protocol, type Reply, type TextMatch, type Unmatched,
} from './scenario.ts'

export type EntryStatus = 'in_progress' | 'pending' | 'completed' | 'failed' | 'aborted'

/** One request the server received, as the request log records it. */
export interface LogEntry {
  /** `r<seq>`, unique within the session. */
  id: string
  /** Position in the session's log, starting at 1. Pass it as `after` to wait for later requests. */
  seq: number
  time: string
  kind: 'llm' | 'mcp'
  /** `pending` means the request waits for `respond`. */
  status: EntryStatus
  method: string
  path: string
  headers: Record<string, string>
  body: unknown
  /** Set when a server in no-auth mode accepted the request without the session's API key. */
  unauthenticated?: true
  llm?: { protocol: Protocol; model: string; nth: number; request: LlmRequest; ruleId?: string; builtin?: string; unmatched?: boolean }
  mcp?: { server: string; method: string; tool?: string; arguments?: unknown }
  response?: { status: number; id?: string; items?: PlanItem[]; reply?: Reply; result?: unknown; error?: unknown; eventsSent?: number }
  /** Things that happened to the request, such as the client disconnecting. */
  notes: string[]
}

export interface RequestFilter {
  kind?: 'llm' | 'mcp'
  status?: EntryStatus
  protocol?: Protocol
  model?: string
  hasTool?: string
  lastUserMessage?: TextMatch
  mcpServer?: string
  mcpMethod?: string
  tool?: string
}

export class TimeoutError extends Error {}

export function entryMatches(entry: LogEntry, filter: RequestFilter): boolean {
  if (filter.kind && entry.kind !== filter.kind) return false
  if (filter.status && entry.status !== filter.status) return false
  const llm = entry.llm
  if (filter.protocol && llm?.protocol !== filter.protocol) return false
  if (filter.model && llm?.model !== filter.model) return false
  if (filter.hasTool && !llm?.request.tools.some(tool => toolNameMatches(tool.name, filter.hasTool!))) return false
  if (filter.lastUserMessage && !(llm && matchText(filter.lastUserMessage, lastUserText(llm.request)))) return false
  if (filter.mcpServer && entry.mcp?.server !== filter.mcpServer) return false
  if (filter.mcpMethod && entry.mcp?.method !== filter.mcpMethod) return false
  if (filter.tool && !(entry.mcp?.tool && toolNameMatches(entry.mcp.tool, filter.tool))) return false
  return true
}

export type RespondPayload = { reply?: Reply; result?: McpToolResult }

interface Waiter {
  after: number
  filter: RequestFilter
  resolve: (entry: LogEntry) => void
}

type StoredRule = Rule & { id: string; used: number }

/**
 * A tenant: its own API key, models, rules, request log, and MCP servers. Tests that
 * share one server use separate sessions so they never see each other's state.
 */
export class Session {
  readonly id: string
  apiKey: string
  models: ModelDef[] = []
  unmatched: Unmatched = 'text'
  readonly rules: StoredRule[] = []
  readonly entries: LogEntry[] = []
  readonly mcpServers = new Map<string, McpServerDef>()
  /** Conversations behind Responses API IDs, for `previous_response_id`. */
  readonly responses = new Map<string, Message[]>()
  /** HTTP responses still open, closed on reset so nothing leaks into the next test. */
  readonly open = new Set<ServerResponse>()
  private readonly pending = new Map<string, (payload: RespondPayload | undefined) => void>()
  private readonly waiters = new Set<Waiter>()
  private seq = 0
  private ruleSeq = 0
  llmCount = 0

  constructor(id: string, apiKey?: string) {
    this.id = id
    this.apiKey = apiKey ?? `ats-${randomBytes(16).toString('hex')}`
  }

  get cursor(): number {
    return this.seq
  }

  effectiveModels(): ModelDef[] {
    return this.models.length ? this.models : [ModelDef.parse({ id: 'test-model' })]
  }

  addRule(input: unknown): string {
    const rule = Rule.parse(input)
    const id = rule.id ?? `rule-${++this.ruleSeq}`
    if (this.rules.some(existing => existing.id === id)) throw new Error(`A rule with ID ${id} already exists.`)
    this.rules.push({ ...rule, id, used: 0 })
    return id
  }

  removeRule(id: string): boolean {
    const index = this.rules.findIndex(rule => rule.id === id)
    if (index >= 0) this.rules.splice(index, 1)
    return index >= 0
  }

  /** The first rule that matches, trying fallback rules last, and counts the use. */
  matchRule(request: LlmRequest, nth: number): StoredRule | undefined {
    const ordered = [...this.rules.filter(rule => !rule.fallback), ...this.rules.filter(rule => rule.fallback)]
    const rule = ordered.find(rule => (rule.times === undefined || rule.used < rule.times) && ruleMatches(rule, request, nth))
    if (rule) rule.used++
    return rule
  }

  addMcpServer(input: unknown): McpServerDef {
    const def = McpServerDef.parse(input)
    this.mcpServers.set(def.name, def)
    return def
  }

  add(fields: Omit<LogEntry, 'id' | 'seq' | 'time' | 'notes'> & { notes?: string[] }): LogEntry {
    const seq = ++this.seq
    const entry: LogEntry = { id: `r${seq}`, seq, time: new Date().toISOString(), notes: [], ...fields }
    this.entries.push(entry)
    this.changed(entry)
    return entry
  }

  /** Call after changing an entry, so waiters see it. */
  changed(entry: LogEntry): void {
    for (const waiter of this.waiters) {
      if (entry.seq > waiter.after && entryMatches(entry, waiter.filter)) {
        this.waiters.delete(waiter)
        waiter.resolve(entry)
      }
    }
  }

  get(id: string): LogEntry | undefined {
    return this.entries.find(entry => entry.id === id)
  }

  list(filter: RequestFilter = {}, after = 0): LogEntry[] {
    return this.entries.filter(entry => entry.seq > after && entryMatches(entry, filter))
  }

  /** The first entry after `after` that matches, waiting up to `timeoutMs` for one. */
  wait(filter: RequestFilter, after: number, timeoutMs: number, signal?: AbortSignal): Promise<LogEntry> {
    const found = this.list(filter, after)[0]
    if (found) return Promise.resolve(found)
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        after,
        filter,
        resolve: entry => {
          clearTimeout(timer)
          resolve(entry)
        },
      }
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        reject(new TimeoutError(`No matching request arrived within ${timeoutMs} ms.`))
      }, timeoutMs)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        this.waiters.delete(waiter)
        reject(new Error('The wait was cancelled.'))
      }, { once: true })
      this.waiters.add(waiter)
    })
  }

  /** Marks the entry pending and waits for `respond`. Resolves undefined when the request is abandoned. */
  awaitRespond(entry: LogEntry, signal?: AbortSignal): Promise<RespondPayload | undefined> {
    entry.status = 'pending'
    this.changed(entry)
    return new Promise(resolve => {
      const done = (payload: RespondPayload | undefined) => {
        this.pending.delete(entry.id)
        resolve(payload)
      }
      this.pending.set(entry.id, done)
      signal?.addEventListener('abort', () => done(undefined), { once: true })
    })
  }

  respond(id: string, payload: RespondPayload): void {
    const resolve = this.pending.get(id)
    if (!resolve) throw new Error(`Request ${id} isn't pending.`)
    resolve(payload)
  }

  reset(): void {
    for (const resolve of this.pending.values()) resolve(undefined)
    this.pending.clear()
    for (const res of this.open) res.destroy()
    this.open.clear()
    this.rules.length = 0
    this.entries.length = 0
    this.responses.clear()
    this.mcpServers.clear()
    this.models = []
    this.unmatched = 'text'
    this.seq = 0
    this.ruleSeq = 0
    this.llmCount = 0
  }
}

function ruleMatches(rule: Rule, request: LlmRequest, nth: number): boolean {
  const when = rule.when
  if (when.model !== undefined && request.model !== when.model) return false
  if (when.protocol !== undefined && request.protocol !== when.protocol) return false
  if (when.nth !== undefined && nth !== when.nth) return false
  if (when.lastUserMessage !== undefined && !matchText(when.lastUserMessage, lastUserText(request))) return false
  if (when.system !== undefined && !matchText(when.system, request.system)) return false
  if (when.hasTool !== undefined && !request.tools.some(tool => toolNameMatches(tool.name, when.hasTool!))) return false
  if (when.toolResult !== undefined && !trailingToolResults(request).some(result => toolNameMatches(result.name ?? '', when.toolResult!))) return false
  return true
}
