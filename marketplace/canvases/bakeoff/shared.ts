// Names and formatting the canvas and its page share. Nothing here needs Node.js.

export const KINDS = ['image', 'video', 'markdown', 'html', 'text'] as const
export type Kind = (typeof KINDS)[number]

/** What the user decided for a variant: the one winner, keep it for the next round, or drop it. */
export const VOTES = ['pick', 'keep', 'drop'] as const
export type Vote = (typeof VOTES)[number]

export const VOTE_LABEL: Record<Vote, string> = { pick: 'Winner', keep: 'Keep', drop: 'Drop' }

export const MAX_NOTE = 2000
export const MAX_QUOTE = 300
export const MAX_MARKS = 20
/** Variants one `add_variants` call may add. */
export const MAX_ADDED = 12
/** Variants in a bakeoff, over all its rounds. */
export const MAX_VARIANTS = 78

/** "A" to "Z", then "AA", "AB": a variant's letter, by the order it joined the bakeoff. It never changes. */
export function labelOf(index: number): string {
  let label = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) label = String.fromCharCode(65 + ((n - 1) % 26)) + label
  return label
}

/** "12.5 AIC": AI credits, to two decimals at most. */
export function formatCredits(credits: number): string {
  return `${Number(credits.toFixed(2)).toLocaleString('en-US')} AIC`
}

/** What made a variant, such as "chart in a card · claude-opus-5.5 · 12 AIC", or an empty string when the agent said nothing. */
export function madeWith(variant: { approach: string; models: readonly string[]; credits: number | null }, separator = ' · '): string {
  return [variant.approach, variant.models.join(' + '), variant.credits === null ? '' : formatCredits(variant.credits)].filter(Boolean).join(separator)
}

/** Text the page loads with `load_variant`, rather than from a file URL. */
export const loadsText = (variant: { kind: Kind; file: string }) => variant.kind === 'markdown' || variant.kind === 'html' || variant.kind === 'text' || variant.file.endsWith('.svg')
