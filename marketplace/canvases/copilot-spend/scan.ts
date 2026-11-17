import { createHash } from 'node:crypto'
import { open, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ReadPart } from './shared.ts'
import { signOfUse, skillFolder, skillMarkers } from './skills.ts'

// Reads one Copilot session's event log (`<session>/events.jsonl`) into a small summary:
// what it spent, on which models and tools, and what the model read. Logs run to hundreds
// of megabytes, most of it images, so lines are skipped by their type before they are
// decoded, and the file is read in chunks without blocking other canvases.

/** Increment when a summary's shape or meaning changes, so cached ones are read again. */
export const SUMMARY_VERSION = 1

const CHUNK = 1 << 20
/** Enough of a line to see its type, which comes first. */
const HEAD = 256
const TYPE = /"type":"([^"]+)"/
const WANTED = new Set([
  'session.start',
  'user.message',
  'tool.execution_start',
  'tool.execution_complete',
  'session.usage_record',
  'session.usage_checkpoint',
  'skill.invoked',
  'skill.invoked_ref',
  'session.compaction_complete',
  'subagent.started',
])
/** A pause longer than this is time away, not time working. */
const IDLE_GAP_MS = 5 * 60 * 1000
const MAX_TITLE = 120
const MAX_PROMPT = 400
const MAX_NAMES = 300
const MAIN = 'main'

export interface SkillUse {
  name: string
  /** How many times it was loaded: once by each agent or sub-agent that asked for it. */
  loads: number
  usedLoads: number
  /** Loads that cannot be judged, because the skill names nothing to look for. */
  unknownLoads: number
  /** When it was first loaded, in milliseconds of active time into the session. */
  firstAtMs: number
  /** Tokens read: its size, once for every model call made with it in context. */
  read: number
  /** The part of `read` from loads that were not used. */
  unusedRead: number
  /** What showed it being used, such as a tool or command it names. */
  sign: string | null
}

export interface McpUse {
  server: string
  calls: number
  failed: number
  /** The tools called, by name. */
  tools: string[]
  /** Tokens read from its tool results. */
  resultsRead: number
}

export interface SessionSummary {
  id: string
  title: string
  /** The start of the first request, to work out the task type from. */
  prompt: string
  repository: string
  branch: string
  client: string
  startedAt: number
  /** When the last model call ended. */
  endedAt: number
  activeMs: number
  calls: number
  /** Model calls that recorded no AIC. */
  callsWithoutAic: number
  nanoAiu: number
  inputTokens: number
  models: Record<string, { nanoAiu: number; calls: number }>
  subagents: number
  subagentNanoAiu: number
  /** Tool calls by kind of tool. */
  tools: Record<string, { calls: number; failed: number }>
  filesChanged: number
  /** Tokens the model read, counted again on every model call, by where they came from. */
  read: Record<ReadPart, number>
  skills: SkillUse[]
  mcp: McpUse[]
  /** The MCP tools the model was given, by name. */
  mcpTools: string[]
}

interface LogEvent {
  type: string
  timestamp?: string
  agentId?: string
  data?: Record<string, unknown>
}

/** Calls `onEvent` for every event of a wanted type in a session's log, in order. */
export async function readEvents(file: string, onEvent: (event: LogEvent) => void): Promise<void> {
  const handle = await open(file, 'r')
  try {
    const chunk = Buffer.allocUnsafe(CHUNK)
    let parts: Buffer[] = []
    let size = 0
    // Undefined until enough of the line is read to see its type.
    let wanted: boolean | undefined
    const emit = () => {
      if (wanted !== false && size > 0) {
        try {
          onEvent(JSON.parse((parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts, size)).toString('utf8')) as LogEvent)
        } catch {
          // A line still being written, or damaged: the next read picks it up.
        }
      }
      parts = []
      size = 0
      wanted = undefined
    }
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, CHUNK, null)
      if (bytesRead === 0) break
      let start = 0
      while (start < bytesRead) {
        let newline = chunk.indexOf(10, start)
        if (newline >= bytesRead) newline = -1
        const end = newline === -1 ? bytesRead : newline
        if (wanted !== false && end > start) {
          const piece = chunk.subarray(start, end)
          // A line that ends in this chunk is used before the next read overwrites it.
          parts.push(newline === -1 ? Buffer.from(piece) : piece)
          size += piece.length
          if (wanted === undefined && (newline !== -1 || size >= HEAD)) {
            const head = (parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts, size)).subarray(0, HEAD).toString('latin1')
            const type = TYPE.exec(head)?.[1]
            wanted = type === undefined || WANTED.has(type)
            if (!wanted) {
              parts = []
              size = 0
            }
          }
        }
        if (newline === -1) break
        emit()
        start = newline + 1
      }
    }
    emit()
  } finally {
    await handle.close()
  }
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {})
/** About four characters to a token: close enough to split what the model read, which is then fitted to the measured total. */
const tokens = (characters: number) => Math.ceil(characters / 4)

/** The flat `key: value` lines of a session's workspace.yaml. */
export function parseWorkspace(yaml: string): Record<string, string> {
  const values: Record<string, string> = {}
  const lines = yaml.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const match = /^([a-z_]+):\s?(.*)$/.exec(lines[index] as string)
    if (!match) continue
    let value = (match[2] as string).trim()
    if (/^[|>][+-]?$/.test(value)) {
      const block: string[] = []
      while (index + 1 < lines.length && /^(\s+|$)/.test(lines[index + 1] as string)) block.push((lines[++index] as string).trim())
      value = block.join(' ').trim()
    } else if (value.startsWith('"')) {
      try {
        value = String(JSON.parse(value))
      } catch {
        value = value.replace(/^"|"$/g, '')
      }
    } else if (value.startsWith("'")) {
      value = value.replace(/^'|'$/g, '').replaceAll("''", "'")
    }
    values[match[1] as string] = value
  }
  return values
}

const oneLine = (value: string, max: number) => {
  const line = value.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

const SHELL = new Set(['bash', 'powershell', 'shell', 'read_bash', 'write_bash', 'stop_bash', 'list_bash', 'read_powershell', 'write_powershell', 'stop_powershell', 'list_powershell'])
const VIEW = new Set(['view', 'read_file', 'read', 'read_resource'])
const EDIT = new Set(['edit', 'create', 'apply_patch', 'write', 'write_file', 'str_replace_editor', 'insert', 'multi_edit'])
const SEARCH = new Set(['grep', 'glob', 'rg', 'find', 'ls', 'tool_search_tool'])
const WEB = new Set(['web_fetch', 'web_search', 'fetch'])
const SUBAGENT = new Set(['task', 'read_agent', 'write_agent', 'list_agents'])

/** The kind of tool, for the breakdown of a session's tool calls. */
export function toolKind(name: string, mcp: boolean): string {
  if (mcp) return 'MCP tools'
  if (SHELL.has(name)) return 'shell'
  if (VIEW.has(name)) return 'file view'
  if (EDIT.has(name)) return 'edit'
  if (SEARCH.has(name) || name.endsWith('_search') || name.endsWith('_code_search')) return 'search'
  if (WEB.has(name)) return 'web'
  if (SUBAGENT.has(name)) return 'sub-agent'
  if (name === 'skill') return 'skill'
  if (name.includes('canvas')) return 'canvas'
  return 'other'
}

interface Load {
  skill: number
  agent: string
  markers: readonly string[]
  folder: string
  /** Null when the skill names nothing to look for. */
  used: boolean | null
  read: number
}

interface Agent {
  /** Estimated tokens now in this agent's context, by where they came from. */
  live: Map<string, number>
}

const CONVERSATION = 'conversation'
const OUTPUT = 'output'

/** Summarizes the session in `dir`, or returns null when it made no model calls. */
export async function summarizeSession(dir: string, id: string): Promise<SessionSummary | null> {
  let workspace: Record<string, string> = {}
  try {
    workspace = parseWorkspace(await readFile(join(dir, 'workspace.yaml'), 'utf8'))
  } catch {
    // Older sessions have none; the log's first event has the same facts.
  }
  const summary: SessionSummary = {
    id,
    title: oneLine(workspace.name ?? '', MAX_TITLE),
    prompt: '',
    // A folder that is not a GitHub repository is named by its folder.
    repository: workspace.repository || basename(workspace.git_root || workspace.cwd || ''),
    branch: workspace.branch ?? '',
    client: workspace.client_name ?? '',
    startedAt: 0,
    endedAt: 0,
    activeMs: 0,
    calls: 0,
    callsWithoutAic: 0,
    nanoAiu: 0,
    inputTokens: 0,
    models: {},
    subagents: 0,
    subagentNanoAiu: 0,
    tools: {},
    filesChanged: 0,
    read: { base: 0, conversation: 0, output: 0, skills: 0, mcpDefs: 0, mcpResults: 0 },
    skills: [],
    mcp: [],
    mcpTools: [],
  }
  const agents = new Map<string, Agent>()
  const agentFor = (key: string) => {
    let agent = agents.get(key)
    if (!agent) agents.set(key, (agent = { live: new Map() }))
    return agent
  }
  const add = (agent: Agent, bucket: string, amount: number) => agent.live.set(bucket, (agent.live.get(bucket) ?? 0) + amount)
  const loads: Load[] = []
  const skillContent = new Map<string, string>()
  const servers = new Map<string, McpUse & { toolSet: Set<string> }>()
  const serverFor = (name: string) => {
    let server = servers.get(name)
    if (!server) servers.set(name, (server = { server: name, calls: 0, failed: 0, tools: [], resultsRead: 0, toolSet: new Set() }))
    return server
  }
  const started = new Map<string, { kind: string; server: string | null; agent: string }>()
  const edited = new Set<string>()
  const mcpTools = new Set<string>()
  /** From the latest usage checkpoint: the system prompt's size, and the share of tool definitions that are MCP tools. */
  let systemTokens: number | undefined
  let mcpDefShare = 0
  let last = 0

  /**
   * A forked session's log starts with a copy of its parent's history, which the parent
   * has already paid for. Everything counted so far was that history: start over, keeping
   * only what is still in the model's context.
   */
  const inherited = (at: number) => {
    Object.assign(summary, { startedAt: Number.isFinite(at) ? at : 0, endedAt: 0, activeMs: 0, calls: 0, callsWithoutAic: 0, nanoAiu: 0, inputTokens: 0, models: {}, subagents: 0, subagentNanoAiu: 0, tools: {} })
    summary.read = { base: 0, conversation: 0, output: 0, skills: 0, mcpDefs: 0, mcpResults: 0 }
    for (const skill of summary.skills) skill.firstAtMs = 0
    for (const load of loads) load.read = 0
    for (const server of servers.values()) Object.assign(server, { calls: 0, failed: 0, resultsRead: 0, toolSet: new Set<string>() })
    edited.clear()
  }

  const onEvent = (event: LogEvent) => {
    const data = record(event.data)
    const at = event.timestamp ? Date.parse(event.timestamp) : NaN
    if (Number.isFinite(at)) {
      if (!summary.startedAt) summary.startedAt = at
      if (last && at > last && at - last <= IDLE_GAP_MS) summary.activeMs += at - last
      if (at > last) last = at
    }
    const key = event.agentId ?? MAIN
    switch (event.type) {
      case 'session.start': {
        const context = record(data.context)
        summary.repository ||= text(context.repository) || basename(text(context.gitRoot) || text(context.cwd))
        summary.branch ||= text(context.branch)
        summary.client ||= text(data.producer)
        break
      }
      case 'user.message': {
        const content = text(data.transformedContent) || text(data.content)
        if (key === MAIN && !summary.prompt) summary.prompt = oneLine(text(data.content) || content, MAX_PROMPT)
        add(agentFor(key), CONVERSATION, tokens(content.length))
        break
      }
      case 'subagent.started':
        summary.subagents += 1
        break
      case 'skill.invoked':
      case 'skill.invoked_ref': {
        const name = text(data.name)
        if (!name) break
        let content = text(data.content)
        if (content) skillContent.set(`sha256:${createHash('sha256').update(content).digest('hex')}`, content)
        else content = skillContent.get(text(data.contentId)) ?? ''
        const size = tokens(content.length || count(data.contentLength))
        let index = summary.skills.findIndex((skill) => skill.name === name)
        if (index === -1) {
          index = summary.skills.length
          summary.skills.push({ name, loads: 0, usedLoads: 0, unknownLoads: 0, firstAtMs: summary.activeMs, read: 0, unusedRead: 0, sign: null })
        }
        const markers = content ? skillMarkers(content) : []
        const folder = skillFolder(text(data.path))
        ;(summary.skills[index] as SkillUse).loads += 1
        // A skill that names nothing can still be seen used, when something in its folder is run or read.
        loads.push({ skill: index, agent: key, markers, folder, used: markers.length ? false : null, read: 0 })
        add(agentFor(key), `skill:${loads.length - 1}`, size)
        break
      }
      case 'tool.execution_start': {
        const name = text(data.toolName)
        const server = text(data.mcpServerName) || null
        const callId = text(data.toolCallId)
        if (callId) started.set(callId, { kind: toolKind(name, server !== null), server, agent: key })
        if (server) {
          const use = serverFor(server)
          use.calls += 1
          use.toolSet.add(text(data.mcpToolName) || name)
        }
        if (name === 'skill') break
        // What this agent loaded before now and has not shown using yet.
        let args: string | undefined
        for (const load of loads) {
          if (load.used === true || load.agent !== key) continue
          args ??= JSON.stringify(data.arguments ?? '')
          const sign = signOfUse(load.markers, load.folder, name, args)
          if (!sign) continue
          load.used = true
          ;(summary.skills[load.skill] as SkillUse).sign ??= sign
        }
        break
      }
      case 'tool.execution_complete': {
        const call = started.get(text(data.toolCallId))
        started.delete(text(data.toolCallId))
        const kind = call?.kind ?? 'other'
        const tally = (summary.tools[kind] ??= { calls: 0, failed: 0 })
        tally.calls += 1
        // A shell command that exits with an error still succeeds as a tool call.
        const exitCode = record(data.shellExecution).exitCode
        const failed = data.success === false || (typeof exitCode === 'number' && exitCode !== 0)
        if (failed) tally.failed += 1
        if (call?.server && failed) serverFor(call.server).failed += 1
        for (const edit of Array.isArray(data.fileEdits) ? data.fileEdits : []) {
          const path = text(record(edit).path)
          if (path) edited.add(path)
        }
        const measured = count(record(record(data.toolTelemetry).metrics).result_token_count)
        const size = measured || tokens(text(record(data.result).content).length || text(record(data.error).message).length)
        add(agentFor(call?.agent ?? key), call?.server ? `mcp:${call.server}` : OUTPUT, size)
        break
      }
      case 'session.usage_checkpoint': {
        for (const conversation of Array.isArray(data.promptCacheBreakState) ? data.promptCacheBreakState : []) {
          const entry = record(conversation)
          if (entry.conversation !== MAIN) continue
          const model = record(record(entry.models)[text(entry.lastActiveModel)])
          const tools = Array.isArray(model.tools) ? model.tools.map(record) : []
          const mcp = tools.filter((tool) => tool.mcp === true)
          mcpDefShare = tools.length ? mcp.length / tools.length : 0
          for (const tool of mcp) {
            if (mcpTools.size < MAX_NAMES) mcpTools.add(text(tool.name))
          }
          const segments = Array.isArray(model.system_segments) ? model.system_segments : []
          if (segments.length) systemTokens = segments.reduce((sum: number, segment) => sum + count(record(segment).tokens), 0)
        }
        break
      }
      case 'session.compaction_complete': {
        if (data.success === false) break
        // The conversation was replaced by a summary of it: what was in context before is gone.
        const agent = agentFor(key)
        agent.live.clear()
        add(agent, CONVERSATION, count(data.conversationTokens) || tokens(text(data.summaryContent).length))
        if (count(data.systemTokens)) systemTokens = count(data.systemTokens)
        break
      }
      case 'session.usage_record': {
        const usage = record(data.usage)
        const source = text(record(usage.accounting).sourceSessionId)
        if (key === MAIN && source && source !== id) {
          inherited(at)
          add(agentFor(key), CONVERSATION, count(usage.outputTokens))
          break
        }
        const model = text(usage.model) || 'unknown'
        const nano = record(usage.copilotUsage).totalNanoAiu
        const spent = count(nano)
        const tally = (summary.models[model] ??= { nanoAiu: 0, calls: 0 })
        tally.calls += 1
        tally.nanoAiu += spent
        summary.calls += 1
        summary.nanoAiu += spent
        if (typeof nano !== 'number') summary.callsWithoutAic += 1
        if (key !== MAIN) summary.subagentNanoAiu += spent
        if (Number.isFinite(at)) summary.endedAt = Math.max(summary.endedAt, at)

        // What this call read: its prompt is measured; how it splits is estimated and fitted to that.
        const input = count(usage.inputTokens)
        summary.inputTokens += input
        const definitions = Math.min(count(usage.toolTokenCount), input)
        const mcpDefinitions = definitions * mcpDefShare
        summary.read.mcpDefs += mcpDefinitions
        summary.read.base += definitions - mcpDefinitions
        const agent = agentFor(key)
        const rest = input - definitions
        let estimated = 0
        for (const amount of agent.live.values()) estimated += amount
        // Sub-agents get a prompt of their own, of unknown size: what is left over is theirs.
        const system = key === MAIN && systemTokens !== undefined ? Math.min(systemTokens, rest) : Math.max(0, rest - estimated)
        summary.read.base += system
        const context = rest - system
        if (estimated <= 0) summary.read.conversation += context
        else {
          const scale = context / estimated
          for (const [bucket, amount] of agent.live) {
            const share = amount * scale
            if (bucket === CONVERSATION) summary.read.conversation += share
            else if (bucket === OUTPUT) summary.read.output += share
            else if (bucket.startsWith('skill:')) {
              summary.read.skills += share
              ;(loads[Number(bucket.slice(6))] as Load).read += share
            } else {
              summary.read.mcpResults += share
              serverFor(bucket.slice(4)).resultsRead += share
            }
          }
        }
        // What the model wrote is read again on its next call.
        add(agent, CONVERSATION, count(usage.outputTokens))
        break
      }
    }
  }

  await readEvents(join(dir, 'events.jsonl'), onEvent)
  if (summary.calls === 0) return null

  for (const load of loads) {
    const skill = summary.skills[load.skill] as SkillUse
    skill.read += load.read
    if (load.used === true) skill.usedLoads += 1
    else if (load.used === null) skill.unknownLoads += 1
    else skill.unusedRead += load.read
  }
  for (const skill of summary.skills) {
    skill.read = Math.round(skill.read)
    skill.unusedRead = Math.round(skill.unusedRead)
  }
  summary.mcp = [...servers.values()].map(({ toolSet, ...server }) => ({ ...server, tools: [...toolSet].slice(0, MAX_NAMES), resultsRead: Math.round(server.resultsRead) }))
  summary.mcpTools = [...mcpTools]
  summary.filesChanged = edited.size
  for (const part of Object.keys(summary.read) as ReadPart[]) summary.read[part] = Math.round(summary.read[part])
  summary.title ||= oneLine(summary.prompt, MAX_TITLE) || 'Untitled session'
  summary.endedAt ||= last
  return summary
}
