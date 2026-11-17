import { z } from '@rwoll/canvas-kit'
import { KINDS, VOTES } from './shared.ts'

// The canvas's state: the variants, and what the user decided in each round. The variants' content
// stays in files, so the state the agent reads with get_state is small.

/** A spot in an element of a mock: the way to the element from the mock's body (which child, at each step), and fractions of its width and height. */
export const anchor = z.object({ path: z.array(z.number().int().min(0)).max(64), x: z.number().min(0).max(1), y: z.number().min(0).max(1) })

const mark = z.union([
  /**
   * A pin on an image or an HTML mock, as fractions of its width and height. On a mock, `on` is the
   * element under it, such as "<button> Ask the agent", and `anchor` is where in that element, so
   * the pin stays on it when the mock is laid out at another size.
   */
  z.object({ n: z.number().int(), x: z.number().min(0).max(1), y: z.number().min(0).max(1), on: z.string().optional(), anchor: anchor.optional() }),
  /** Text the user selected in a variant. */
  z.object({ n: z.number().int(), quote: z.string() }),
])

const variant = z.object({
  id: z.string(),
  /** A, B, C…: how the user and the agent name it. */
  label: z.string(),
  kind: z.enum(KINDS),
  /** What is different about it, such as a direction or a prompt. Empty when the agent gave none. */
  approach: z.string(),
  /** The model or models that made it, when the agent said. */
  models: z.array(z.string()),
  /** AI credits spent making it, when the agent said. */
  credits: z.number().nullable(),
  /** Its file, relative to the bakeoff's folder. */
  file: z.string(),
  bytes: z.number().int(),
  /** The round it was added in. */
  round: z.number().int(),
})

const entry = z.object({
  variant: z.string(),
  vote: z.enum(VOTES).nullable(),
  note: z.string(),
  /** Numbered spots the note refers to as [1], [2]. */
  marks: z.array(mark),
  /** Kept from the round before, to compare with this round's new variants. */
  carried: z.boolean(),
})

const round = z.object({
  number: z.number().int(),
  entries: z.array(entry),
  /** Feedback on the round as a whole, such as "A's layout with C's colors". */
  overall: z.string(),
  /** What the user last asked the agent to do with this round. */
  sent: z.object({ kind: z.enum(['next', 'use']), at: z.string(), variant: z.string().nullable() }).nullable(),
})

export const stateSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** What the user asked for. */
  brief: z.string(),
  /** Where the variants' files are; empty until the first variant is added. */
  folder: z.string(),
  variants: z.array(variant),
  /** Oldest first; the last is the one being reviewed. */
  rounds: z.array(round).min(1),
})

export type Anchor = z.output<typeof anchor>
export type Mark = z.output<typeof mark>
export type Variant = z.output<typeof variant>
export type Entry = z.output<typeof entry>
export type Round = z.output<typeof round>
export type BakeoffState = z.output<typeof stateSchema>
