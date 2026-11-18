// What the canvas and its page both know: the two things a session's log records about
// a skill. Nothing here uses Node.js.

/** Available: listed to the agent by name and description. Invoked: its full instructions were put in an agent's context. */
export const STAGES = ['available', 'invoked'] as const
export type Stage = (typeof STAGES)[number]

export const STAGE_LABELS: Record<Stage, string> = { available: 'Skills available', invoked: 'Skills invoked' }

export interface Skill {
  name: string
  description: string
  stage: Stage
}

/** What the skills take of the agent's context, in tokens. Only `total` is measured; the rest is about four characters to a token. */
export interface Context {
  /** The size of the agent's latest request. */
  total: number
  /** The list of available skills, which is in every request. */
  available: number
  /** The instructions of the skills the agent invoked. */
  invoked: number
}

/** "950", "3.6k", "234k", or "1.2M". */
export function compact(count: number): string {
  if (count < 1000) return String(Math.round(count))
  const [amount, unit] = count < 999_500 ? [count / 1000, 'k'] : [count / 1e6, 'M']
  return `${amount.toFixed(amount < 10 ? 1 : 0).replace(/\.0$/, '')}${unit}`
}

/** "0%", "<0.1%", "2.7%", or "25%". */
export function percent(share: number): string {
  if (share <= 0) return '0%'
  if (share < 0.001) return '<0.1%'
  return `${(share * 100).toFixed(share < 0.1 ? 1 : 0).replace(/\.0$/, '')}%`
}
