import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseWorkspace, readEvents, type LogEvent } from '../copilot-spend/scan.ts'
import type { Context, Skill, Stage } from './shared.ts'

// Reads one Copilot session's event log (`<session>/events.jsonl`) for what happened to
// its skills. Which skills were available is in the system prompt, which lists each by
// name and description. A skill was invoked when the log has a `skill.invoked` event for
// it: that is when its full instructions are put in an agent's context. A log can miss
// its first events, so a skill whose instructions were delivered to an agent counts as
// invoked too. How large the main agent's context is comes from its latest model call,
// which records it.

const WANTED = new Set(['system.message', 'skill.invoked', 'skill.invoked_ref', 'skill.context_delivered', 'skill.context_delivered_ref', 'session.usage_record', 'session.compaction_complete'])
/** How a delivery of a skill's instructions names the skill. */
const DELIVERED = /^skill-(.+)$/
const MAIN = 'main'
const MAX_SKILLS = 500
const MAX_NAME = 200
const MAX_DESCRIPTION = 1200
const ORDER: Record<Stage, number> = { invoked: 0, available: 1 }

export interface SessionSkills {
  /** The session's name, or an empty string when it has none. */
  title: string
  /** Whether the log says which skills were available. Without it, only the invoked ones are known. */
  listed: boolean
  /** Invoked first, then the rest, each in the order the session met them. */
  skills: Skill[]
  /** What the skills take of the main agent's context, or null when the log has no model call. */
  context: Context | null
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {})
/** About four characters to a token. */
const tokens = (characters: number) => Math.ceil(characters / 4)
const cut = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value)

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
const unescape = (value: string) =>
  value.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(lt|gt|amp|quot|apos));/gi, (all, decimal?: string, hex?: string, named?: string) => {
    if (named) return ENTITIES[named.toLowerCase()] ?? all
    const code = decimal ? Number(decimal) : parseInt(hex as string, 16)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all
  })

const BLOCK = /<available_skills>([\s\S]*?)<\/available_skills>/g
const ENTRY = /<skill>([\s\S]*?)<\/skill>/g
const field = (entry: string, tag: string) => unescape(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(entry)?.[1] ?? '').trim()

/** The skills a system prompt lists as available. */
export function listedSkills(prompt: string): { name: string; description: string }[] {
  const found: { name: string; description: string }[] = []
  for (const block of prompt.matchAll(BLOCK)) {
    for (const entry of (block[1] as string).matchAll(ENTRY)) {
      const name = field(entry[1] as string, 'name')
      if (name) found.push({ name, description: field(entry[1] as string, 'description') })
    }
  }
  return found
}

/** Reads what happened to the skills of the session in `dir`. Fails when it has no log. */
export async function readSessionSkills(dir: string): Promise<SessionSkills> {
  const skills = new Map<string, Skill>()
  const skillFor = (name: string) => {
    let skill = skills.get(name)
    if (!skill && skills.size < MAX_SKILLS) skills.set(name, (skill = { name: cut(name, MAX_NAME), description: '', stage: 'available' }))
    return skill
  }
  /** How long each skill's instructions are, by the ID a later invocation refers to them by. */
  const lengths = new Map<string, number>()
  /** Invocations whose delivery has not been seen yet, by agent and skill. */
  const awaited = new Map<string, number>()
  let listed = false
  let lastPrompt = ''
  /** In the main agent's context now: the list of skills, the instructions of the skills it invoked, and all of it together. */
  let listTokens = 0
  let invokedTokens = 0
  let total = 0

  const onEvent = (event: LogEvent) => {
    const data = record(event.data)
    switch (event.type) {
      case 'system.message': {
        // The same prompt comes with every request: read it once.
        const prompt = text(data.content)
        if (prompt === lastPrompt) break
        lastPrompt = prompt
        if (prompt.includes('<available_skills>')) listed = true
        if (!event.agentId) listTokens = [...prompt.matchAll(BLOCK)].reduce((sum, block) => sum + tokens(block[0].length), 0)
        for (const entry of listedSkills(prompt)) {
          const skill = skillFor(entry.name)
          if (skill && entry.description) skill.description = cut(entry.description, MAX_DESCRIPTION)
        }
        break
      }
      case 'skill.invoked':
      case 'skill.invoked_ref': {
        const name = text(data.name)
        const skill = name ? skillFor(name) : undefined
        if (!skill) break
        skill.stage = 'invoked'
        skill.description ||= cut(text(data.description), MAX_DESCRIPTION)
        // A skill invoked again is recorded by reference to the instructions it had before.
        const content = text(data.content)
        if (content) lengths.set(`sha256:${createHash('sha256').update(content).digest('hex')}`, content.length)
        // A sub-agent reads a skill it invokes in a context of its own.
        if (!event.agentId) invokedTokens += tokens(content.length || lengths.get(text(data.contentId)) || count(data.contentLength))
        const key = `${event.agentId ?? MAIN}:${name}`
        awaited.set(key, (awaited.get(key) ?? 0) + 1)
        break
      }
      case 'skill.context_delivered':
      case 'skill.context_delivered_ref': {
        const name = DELIVERED.exec(text(data.source))?.[1]
        if (!name) break
        // The delivery that follows an invocation is the same invocation.
        const key = `${event.agentId ?? MAIN}:${name}`
        const waiting = awaited.get(key) ?? 0
        if (waiting > 0) {
          awaited.set(key, waiting - 1)
          break
        }
        // A delivery with no invocation before it: the log does not have the invocation.
        const skill = skillFor(name)
        if (!skill) break
        skill.stage = 'invoked'
        if (!event.agentId) invokedTokens += tokens(text(data.content).length || text(data.prefix).length + text(data.suffix).length + (lengths.get(text(data.contentId)) ?? 0))
        break
      }
      case 'session.usage_record': {
        const input = count(record(data.usage).inputTokens)
        if (!event.agentId && input) total = input
        break
      }
      case 'session.compaction_complete':
        // The conversation was replaced by a summary of it: the instructions read before are gone.
        if (!event.agentId && data.success !== false) invokedTokens = 0
        break
    }
  }
  await readEvents(join(dir, 'events.jsonl'), onEvent, WANTED)

  let title = ''
  try {
    title = cut(parseWorkspace(await readFile(join(dir, 'workspace.yaml'), 'utf8')).name ?? '', MAX_NAME)
  } catch {
    // Older sessions have no workspace.yaml, and so no name.
  }
  let context: Context | null = null
  if (total) {
    // The parts are estimates and the whole is measured: together they cannot be more than it.
    const scale = Math.min(1, total / (listTokens + invokedTokens || 1))
    context = { total, available: Math.round(listTokens * scale), invoked: Math.round(invokedTokens * scale) }
  }
  // Array.prototype.sort is stable, so each stage keeps the order the session met its skills in.
  return { title, listed, skills: [...skills.values()].sort((a, b) => ORDER[a.stage] - ORDER[b.stage]), context }
}
