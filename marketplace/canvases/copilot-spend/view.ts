import { classify } from './classify.ts'
import type { SessionSummary } from './scan.ts'
import {
  OUTLIER, READ_PARTS, TASK_LABELS, TASK_TYPES, TOP_SESSIONS, duration, percent, times,
  type ContextItem, type Dot, type ReadSplit, type ScanStatus, type SessionDetail, type SessionRow, type SkillVerdict, type SpendState, type TaskType, type TypeRow, type TypeSource,
} from './shared.ts'
import type { TypeChoice } from './store.ts'

// Turns the sessions' summaries into what the page draws. Everything is a share, a rank,
// or a multiple; AIC amounts are added only when `showAic` is on, so while it is off
// neither the page nor the agent reading the canvas's state can see one.

const DAY_MS = 24 * 60 * 60 * 1000
const NANO_PER_AIC = 1e9
const MAX_ROWS = 500

export interface ViewOptions {
  now: number
  filters: SpendState['filters']
  showAic: boolean
  showAll: boolean
  selected: string | null
  scan: ScanStatus
  source: string
}

const sum = (values: Iterable<number>) => {
  let total = 0
  for (const value of values) total += value
  return total
}
const median = (values: readonly number[]) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
}
const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : 0)
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
/** A name inside a Markdown code span. */
const code = (name: string) => `\`${name.replaceAll('`', "'")}\``
const list = (items: readonly string[]) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`)

/**
 * The MCP server each tool belongs to. A tool is named `<server>-<tool>`, and either part
 * may have hyphens, so servers that were called (`known`) are matched first; other tools
 * that start with the same word are taken to be one server, named by what they share.
 */
export function mcpServers(tools: readonly string[], known: readonly string[]): Map<string, number> {
  const servers = new Map<string, number>()
  const unknown = new Map<string, string[][]>()
  for (const tool of tools) {
    const server = known.find((name) => tool.startsWith(`${name}-`))
    if (server) servers.set(server, (servers.get(server) ?? 0) + 1)
    else {
      const words = tool.split('-')
      const group = unknown.get(words[0] as string) ?? []
      group.push(words.length > 1 ? words.slice(0, -1) : words)
      unknown.set(words[0] as string, group)
    }
  }
  for (const group of unknown.values()) {
    let shared = group[0] as string[]
    for (const words of group) {
      let length = 0
      while (length < shared.length && shared[length] === words[length]) length++
      shared = shared.slice(0, length)
    }
    servers.set(shared.join('-'), group.length)
  }
  return servers
}

interface Server {
  tools: number
  calls: number
  failed: number
  toolsCalled: number
  defs: number
  results: number
}

interface Entry {
  session: SessionSummary
  type: TaskType
  typeSource: TypeSource
  share: number
  rank: number
  multiple: number
  shareOfType: number
  readTotal: number
  servers: Map<string, Server>
  split: ReadSplit
}

function serversOf(session: SessionSummary, known: readonly string[]): Map<string, Server> {
  const servers = new Map<string, Server>()
  for (const [name, tools] of mcpServers(session.mcpTools, known)) {
    servers.set(name, { tools, calls: 0, failed: 0, toolsCalled: 0, defs: ratio(session.read.mcpDefs * tools, session.mcpTools.length), results: 0 })
  }
  for (const use of session.mcp) {
    const server = servers.get(use.server) ?? { tools: 0, calls: 0, failed: 0, toolsCalled: 0, defs: 0, results: 0 }
    servers.set(use.server, { ...server, calls: use.calls, failed: use.failed, toolsCalled: use.tools.length, results: use.resultsRead })
  }
  return servers
}

const unusedSkillTokens = (session: SessionSummary) => Math.min(session.read.skills, sum(session.skills.map((skill) => skill.unusedRead)))
const unusedMcpTokens = (servers: Map<string, Server>) => sum([...servers.values()].map((server) => (server.calls ? 0 : server.defs)))

function splitOf(read: Record<(typeof READ_PARTS)[number], number>, unusedSkills: number, unusedMcp: number): ReadSplit {
  const total = sum(READ_PARTS.map((part) => read[part]))
  const split = { unusedSkills: ratio(unusedSkills, total), unusedMcp: ratio(unusedMcp, total) } as ReadSplit
  for (const part of READ_PARTS) split[part] = ratio(read[part], total)
  return split
}

const skillVerdict = (skill: SessionSummary['skills'][number]): SkillVerdict =>
  skill.usedLoads === skill.loads ? 'used' : skill.usedLoads > 0 ? 'partly' : skill.unknownLoads === skill.loads ? 'unknown' : 'unused'

interface Usual {
  activeMs: number
  /** Tokens read per model call. */
  prompt: number
  /** AIC per call, by model, and the least of them. */
  price: Map<string, number>
  cheapest: { model: string; price: number } | null
}

/** The one thing that most sets an expensive session apart, in a sentence of Markdown. */
function reason(entry: Entry, usual: Usual): SessionRow['reason'] {
  const { session, split } = entry
  const models = Object.entries(session.models).sort((a, b) => b[1].nanoAiu - a[1].nanoAiu)
  const top = models[0]
  const topShare = top ? ratio(top[1].nanoAiu, session.nanoAiu) : 0
  const on = top && topShare >= 0.8 && models.length > 1 ? ` ${percent(topShare)} of its AIC was on ${code(top[0])}.` : top && models.length === 1 ? ` All on ${code(top[0])}.` : ''
  const shell = session.tools.shell
  if (shell && shell.calls >= 10 && shell.failed / shell.calls >= 0.3) {
    return { tag: 'Repeated failures', text: `**${percent(shell.failed / shell.calls)}** of shell commands failed.${on}` }
  }
  const subagents = ratio(session.subagentNanoAiu, session.nanoAiu)
  if (subagents >= 0.4) return { tag: 'Sub-agents', text: `${plural(session.subagents, 'sub-agent')} spent **${percent(subagents)}** of its AIC.${on}` }
  const unused = split.unusedSkills + split.unusedMcp
  if (unused >= 0.15) return { tag: 'Unused context', text: `**${percent(unused)}** of what the model read was skills and MCP tools the session did not use.${on}` }
  const calls = sum(Object.values(session.tools).map((tool) => tool.calls))
  const views = session.tools['file view']?.calls ?? 0
  if (calls >= 30 && views / calls >= 0.6) {
    return { tag: 'Rereading files', text: `**${percent(views / calls)}** of tool calls were file views, to change ${plural(session.filesChanged, 'file')}.${on}` }
  }
  // A long session and a large context go together; say whichever stands out more.
  const longer = ratio(session.activeMs, usual.activeMs)
  const larger = ratio(ratio(session.inputTokens, session.calls), usual.prompt)
  if (longer >= 2 && longer >= larger) return { tag: 'Long session', text: `Active for ${duration(session.activeMs)}, **${times(longer)}** your usual session.${on}` }
  if (larger >= 2) return { tag: 'Large context', text: `Each model call read **${times(larger)}** as much as in your usual session.${on}` }
  const price = top ? usual.price.get(top[0]) : undefined
  if (top && price && usual.cheapest && usual.cheapest.model !== top[0] && topShare >= 0.8 && price / usual.cheapest.price >= 3) {
    return {
      tag: 'Model',
      text: `**${percent(topShare)}** of its AIC was on ${code(top[0])}, where a call costs about **${times(price / usual.cheapest.price)}** as much as on ${code(usual.cheapest.model)}.`,
    }
  }
  return { tag: 'Nothing unusual', text: `Its length, context, and tool calls are close to your usual session.${on}` }
}

function rowOf(entry: Entry, usual: Usual, showAic: boolean): SessionRow {
  const { session } = entry
  return {
    id: session.id,
    rank: entry.rank,
    title: session.title,
    type: entry.type,
    typeSource: entry.typeSource,
    repository: session.repository,
    branch: session.branch,
    client: session.client,
    endedAt: new Date(session.endedAt).toISOString(),
    activeMs: session.activeMs,
    filesChanged: session.filesChanged,
    share: entry.share,
    aic: showAic ? session.nanoAiu / NANO_PER_AIC : null,
    multiple: entry.multiple,
    shareOfType: entry.shareOfType,
    reason: reason(entry, usual),
    read: entry.split,
    // Whatever took the most context first.
    unusedSkills: session.skills
      .filter((skill) => skillVerdict(skill) === 'unused')
      .sort((a, b) => b.unusedRead - a.unusedRead)
      .map((skill) => skill.name),
    unusedMcp: [...entry.servers]
      .filter(([, server]) => server.tools > 0 && !server.calls)
      .sort((a, b) => b[1].defs - a[1].defs)
      .map(([name]) => name),
  }
}

function detailOf(entry: Entry, entries: readonly Entry[], typeRow: TypeRow, showAic: boolean): SessionDetail {
  const { session, readTotal } = entry
  const calls = sum(Object.values(session.tools).map((tool) => tool.calls))
  const failed = sum(Object.values(session.tools).map((tool) => tool.failed))
  const others = entries.filter((other) => other.type === entry.type && other !== entry)
  const next = others[0]
  return {
    id: session.id,
    models: Object.entries(session.models)
      .sort((a, b) => b[1].nanoAiu - a[1].nanoAiu)
      .map(([model, usage]) => ({ model, share: ratio(usage.nanoAiu, session.nanoAiu), aic: showAic ? usage.nanoAiu / NANO_PER_AIC : null })),
    subagentShare: ratio(session.subagentNanoAiu, session.nanoAiu),
    subagents: session.subagents,
    within: {
      type: entry.type,
      sessions: typeRow.sessions,
      typeShare: typeRow.share,
      self: entry.shareOfType,
      next: next ? { rank: next.rank, share: next.shareOfType } : null,
      rest: Math.max(0, 1 - entry.shareOfType - (next?.shareOfType ?? 0)),
      restCount: Math.max(0, others.length - 1),
    },
    tools: Object.entries(session.tools)
      .sort((a, b) => b[1].calls - a[1].calls)
      .slice(0, 6)
      .map(([name, tool]) => ({ name, share: ratio(tool.calls, calls), failed: ratio(tool.failed, tool.calls) })),
    failed: ratio(failed, calls),
    read: entry.split,
    skills: [...session.skills]
      .sort((a, b) => b.read - a.read)
      .map((skill) => {
        const verdict = skillVerdict(skill)
        const note =
          verdict === 'used'
            ? skill.sign === 'its folder' || !skill.sign
              ? 'A later tool call ran or read something in its folder.'
              : `${code(skill.sign)} appears in a later tool call.`
            : verdict === 'partly'
              ? `Used by ${skill.usedLoads} of the ${skill.loads} agents that loaded it.`
              : verdict === 'unknown'
                ? 'It names no tools or commands to look for, so its use cannot be told.'
                : skill.loads > 1
                  ? `Loaded by ${skill.loads} agents; none ran or named anything from it.`
                  : 'No later tool call ran or named anything from it.'
        return { name: skill.name, verdict, loadedAfterMs: skill.firstAtMs, share: ratio(skill.read, readTotal), note }
      }),
    mcp: [...entry.servers]
      .map(([name, server]) => ({
        name,
        used: server.calls > 0,
        tools: server.tools,
        calls: server.calls,
        failed: server.failed,
        share: ratio(server.defs + server.results, readTotal),
        note: server.calls
          ? `${server.tools ? `${server.toolsCalled} of ${plural(server.tools, 'tool')} called` : plural(server.toolsCalled, 'tool')} · ${plural(server.calls, 'call')}, ${server.failed || 'none'} failed.`
          : `${plural(server.tools, 'tool')}, none called.`,
      }))
      .sort((a, b) => b.share - a.share),
  }
}

/** The opening paragraph: where the AIC went, and how much context went unused. */
function summarize(types: readonly TypeRow[], entries: readonly Entry[], read: ReadSplit): string {
  const first = types[0]
  if (!first) return ''
  const outliers = (type: TaskType) => entries.filter((entry) => entry.type === type && entry.multiple > OUTLIER)
  const about = (row: TypeRow) => {
    const far = outliers(row.type)
    const usual = `the usual for ${TASK_LABELS[row.type].toLowerCase()}`
    if (!far.length) return row.sessions > 1 ? `none of its ${row.sessions} sessions is more than ${OUTLIER}× ${usual}` : 'it is one session'
    const from = `**${percent(sum(far.map((entry) => entry.shareOfType)))}** of that came from ${plural(far.length, 'session')}`
    // Entries are in order of cost, so the first is the largest.
    if (far.length > 3) return `${from} that each cost more than ${OUTLIER}× ${usual}, the largest **${times((far[0] as Entry).multiple)}**`
    return `${from} that cost ${list(far.map((entry) => `**${times(entry.multiple)}**`))} ${usual}`
  }
  const sentences = [`**${TASK_LABELS[first.type]}** takes the largest share of your AIC, **${percent(first.share)}**, and ${about(first)}.`]
  const second = types[1]
  if (second) sentences.push(`**${TASK_LABELS[second.type]}** is second at **${percent(second.share)}**${outliers(second.type).length ? `, but ${about(second)}` : ''}.`)
  const context = read.skills + read.mcpDefs + read.mcpResults
  const unused = read.unusedSkills + read.unusedMcp
  sentences.push(
    `Skill instructions and MCP tools were **${percent(context)}** of what the model read` +
      (unused > 0 ? `, and **${percent(unused)}** was loaded and never used in its session.` : ', and nothing loaded went unused.'),
  )
  return sentences.join(' ')
}

/** A sentence on which skills and MCP servers hold the unused context, and which earn theirs. */
function contextNote(items: readonly ContextItem[], read: ReadSplit): string {
  const unused = read.unusedSkills + read.unusedMcp
  if (!items.length) return 'No session in this period loaded a skill or was given MCP tools.'
  const describe = (item: ContextItem) => `${code(item.name)} ${item.kind === 'mcp' ? 'MCP server' : 'skill'}`
  const sentences: string[] = []
  if (unused <= 0) sentences.push('Every skill and MCP server that was loaded was used in its session.')
  else {
    const wasteful = items.filter((item) => item.unused > 0).sort((a, b) => b.unused - a.unused)
    const named: ContextItem[] = []
    for (const item of wasteful) {
      named.push(item)
      if (named.length === 4 || sum(named.map((entry) => entry.unused)) >= unused * 0.8) break
    }
    const held = percent(ratio(sum(named.map((item) => item.unused)), unused))
    sentences.push(
      named.length === wasteful.length
        ? `All of the unused context is from the ${list(named.map(describe))}.`
        : `${named.length} of the ${items.length} hold **${held}** of the unused context: the ${list(named.map(describe))}.`,
    )
  }
  const earning = items
    .filter((item) => item.sessions >= 3 && item.used / item.sessions >= 0.8)
    .sort((a, b) => b.share - a.share)
    .slice(0, 2)
  if (earning.length) sentences.push(`${list(earning.map((item) => code(item.name)))} ${earning.length === 1 ? 'earns its place: it is' : 'earn theirs: each is'} used in most sessions that have it.`)
  return sentences.join(' ')
}

export function buildState(all: readonly SessionSummary[], choices: ReadonlyMap<string, TypeChoice>, options: ViewOptions): SpendState {
  const { now, showAic } = options
  const from = now - options.filters.days * DAY_MS
  const inPeriod = all.filter((session) => session.endedAt >= from && session.endedAt <= now + DAY_MS)
  const repositories = [...new Set(inPeriod.map((session) => session.repository).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  const repository = options.filters.repository !== null && repositories.includes(options.filters.repository) ? options.filters.repository : null
  const scoped = repository === null ? inPeriod : inPeriod.filter((session) => session.repository === repository)
  const priced = scoped.filter((session) => session.nanoAiu > 0).sort((a, b) => b.nanoAiu - a.nanoAiu || a.id.localeCompare(b.id))
  const total = sum(priced.map((session) => session.nanoAiu))
  // Longest first, so `team-tools-beta` is not taken for a tool of `team-tools`.
  const known = [...new Set(all.flatMap((session) => session.mcp.map((use) => use.server)))].sort((a, b) => b.length - a.length)

  const entries: Entry[] = priced.map((session, index) => {
    const choice = choices.get(session.id)
    const servers = serversOf(session, known)
    return {
      session,
      type: choice?.type ?? classify(session),
      typeSource: choice?.by ?? 'auto',
      share: ratio(session.nanoAiu, total),
      rank: index + 1,
      multiple: 0,
      shareOfType: 0,
      readTotal: sum(READ_PARTS.map((part) => session.read[part])),
      servers,
      split: splitOf(session.read, unusedSkillTokens(session), unusedMcpTokens(servers)),
    }
  })

  const types: TypeRow[] = []
  for (const type of TASK_TYPES) {
    const members = entries.filter((entry) => entry.type === type)
    if (!members.length) continue
    const typeTotal = sum(members.map((entry) => entry.session.nanoAiu))
    const middle = median(members.map((entry) => entry.share))
    for (const entry of members) {
      entry.multiple = ratio(entry.share, middle)
      entry.shareOfType = ratio(entry.session.nanoAiu, typeTotal)
    }
    types.push({
      type,
      sessions: members.length,
      share: ratio(typeTotal, total),
      aic: showAic ? typeTotal / NANO_PER_AIC : null,
      median: middle,
      largest: Math.max(...members.map((entry) => entry.multiple)),
    })
  }
  types.sort((a, b) => b.share - a.share)

  // Skills and MCP servers, across every session.
  const read = { base: 0, conversation: 0, output: 0, skills: 0, mcpDefs: 0, mcpResults: 0 }
  const items = new Map<string, ContextItem & { tokens: number; unusedTokens: number }>()
  const item = (kind: ContextItem['kind'], name: string) => {
    const key = `${kind}:${name}`
    let found = items.get(key)
    if (!found) items.set(key, (found = { kind, name, tools: 0, sessions: 0, used: 0, unknown: 0, calls: 0, failed: 0, share: 0, unused: 0, tokens: 0, unusedTokens: 0 }))
    return found
  }
  let unusedSkills = 0
  let unusedMcp = 0
  for (const entry of entries) {
    for (const part of READ_PARTS) read[part] += entry.session.read[part]
    unusedSkills += unusedSkillTokens(entry.session)
    unusedMcp += unusedMcpTokens(entry.servers)
    for (const skill of entry.session.skills) {
      const found = item('skill', skill.name)
      const verdict = skillVerdict(skill)
      found.sessions += 1
      if (verdict === 'used' || verdict === 'partly') found.used += 1
      if (verdict === 'unknown') found.unknown += 1
      found.tokens += skill.read
      found.unusedTokens += skill.unusedRead
    }
    for (const [name, server] of entry.servers) {
      const found = item('mcp', name)
      found.sessions += 1
      found.tools = Math.max(found.tools, server.tools)
      if (server.calls) found.used += 1
      found.calls += server.calls
      found.failed += server.failed
      found.tokens += server.defs + server.results
      if (!server.calls) found.unusedTokens += server.defs
    }
  }
  const readTotal = sum(READ_PARTS.map((part) => read[part]))
  const contextItems: ContextItem[] = [...items.values()]
    .map(({ tokens, unusedTokens, ...rest }) => ({ ...rest, share: ratio(tokens, readTotal), unused: ratio(unusedTokens, readTotal) }))
    .sort((a, b) => b.unused - a.unused || b.share - a.share || a.name.localeCompare(b.name))
  const contextRead = splitOf(read, unusedSkills, unusedMcp)

  const price = new Map<string, number>()
  for (const model of new Set(priced.flatMap((session) => Object.keys(session.models)))) {
    const calls = sum(priced.map((session) => session.models[model]?.calls ?? 0))
    const spent = sum(priced.map((session) => session.models[model]?.nanoAiu ?? 0))
    if (calls >= 5 && spent > 0) price.set(model, spent / calls)
  }
  const cheapest = [...price].sort((a, b) => a[1] - b[1])[0]
  const usual: Usual = {
    activeMs: median(priced.map((session) => session.activeMs)),
    prompt: median(priced.map((session) => ratio(session.inputTokens, session.calls))),
    price,
    cheapest: cheapest ? { model: cheapest[0], price: cheapest[1] } : null,
  }

  const top = entries.slice(0, TOP_SESSIONS)
  const selected = entries.find((entry) => entry.session.id === options.selected)
  const shown = options.showAll ? entries.slice(0, MAX_ROWS) : top
  const rows = (selected && !shown.includes(selected) ? [...shown, selected] : shown).map((entry) => rowOf(entry, usual, showAic))
  const hidden = entries.filter((entry) => !shown.includes(entry) && entry !== selected)
  const outliers = top.filter((entry) => entry.multiple > OUTLIER)
  const dots: Dot[] = entries.map((entry) => ({
    id: entry.session.id,
    type: entry.type,
    share: entry.share,
    multiple: entry.multiple,
    rank: entry.rank <= TOP_SESSIONS ? entry.rank : null,
  }))
  const selectedType = selected && types.find((row) => row.type === selected.type)

  return {
    scan: options.scan,
    source: options.source,
    filters: { days: options.filters.days, repository },
    repositories,
    showAic,
    showAll: options.showAll,
    period: { from: new Date(from).toISOString(), to: new Date(now).toISOString() },
    totals: { sessions: entries.length, types: types.length, aic: showAic ? total / NANO_PER_AIC : null, withoutAic: scoped.length - priced.length },
    summary: summarize(types, entries, contextRead),
    types,
    dots,
    context: {
      read: contextRead,
      skills: contextItems.filter((entry) => entry.kind === 'skill').length,
      mcp: contextItems.filter((entry) => entry.kind === 'mcp').length,
      items: contextItems,
      note: contextNote(contextItems, contextRead),
    },
    top: { count: top.length, share: sum(top.map((entry) => entry.share)), outliers: outliers.length, outlierShare: sum(outliers.map((entry) => entry.share)) },
    rows,
    more: { count: hidden.length, share: sum(hidden.map((entry) => entry.share)), largest: Math.max(0, ...hidden.map((entry) => entry.share)) },
    selected: selected ? selected.session.id : null,
    detail: selected && selectedType ? detailOf(selected, entries, selectedType, showAic) : null,
  }
}
