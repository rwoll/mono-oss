import { join } from 'node:path'
import { CanvasKitError, defineCanvas, z, type ActionContext } from '@rwoll/canvas-kit'
import { askPrompt, feedback } from './prompts.ts'
import { stateSchema, type BakeoffState, type Entry, type Round, type Variant } from './schema.ts'
import { KINDS, labelOf, loadsText, MAX_ADDED, MAX_MARKS, MAX_NOTE, MAX_QUOTE, MAX_VARIANTS, VOTES } from './shared.ts'
import { bakeoffDir, readStored, removeStored, storeVariant, writeFeedback } from './store.ts'

export type { BakeoffState } from './schema.ts'

type Ctx = ActionContext<BakeoffState>

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/
const line = (max: number) => z.string().trim().max(max)
const variantId = z.string().regex(/^v\d{1,3}$/, 'must be a variant ID, such as v1')

const openInput = z.object({
  id: z.string().regex(ID, 'Use lowercase letters, digits, and dashes, such as "readme-logo".').optional().describe('A short name for this bakeoff, such as "readme-logo". Opening the same ID again shows the same bakeoff. Without one, the chat has a single bakeoff.'),
  title: line(120).min(1).optional().describe('What is being decided, such as "Logo for the README".'),
  brief: line(500).optional().describe('What the user asked for, in a sentence.'),
})

/** One bakeoff per ID, or one per chat when the agent gives none. */
const keyOf = ({ input, sessionId }: { input: z.output<typeof openInput>; sessionId: string | undefined }) =>
  input.id ?? `chat-${(sessionId ?? 'local').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 56)}`

const newVariant = z
  .object({
    path: z.string().min(1).max(1000).optional().describe('Absolute path of the file: an image (PNG, JPEG, GIF, WebP, AVIF, SVG), a video (MP4, WebM, MOV), Markdown, HTML, or text. The canvas copies it.'),
    content: z.string().min(1).max(500_000).optional().describe('The text itself, instead of a file: Markdown unless kind says html or text.'),
    kind: z.enum(KINDS).optional().describe("Only needed for content that is not Markdown, or to show a file as plain text. Otherwise the file's extension decides."),
    approach: line(200).optional().describe('What is different about this variant, in a few words, such as "picture first" or "flat, two colors". Hidden from the user while Blind is on.'),
    models: z.array(line(80).min(1)).max(8).optional().describe('The model or models that made this variant, by their public names, such as the model of the sub-agent that wrote it. Leave it out when you do not know.'),
    credits: z.number().min(0).max(1_000_000).optional().describe('AI credits (AIC) spent making this variant. Leave it out when you do not know; never guess.'),
  })
  .refine((variant) => (variant.path === undefined) !== (variant.content === undefined), 'Give each variant either path or content, not both.')

const latest = (state: BakeoffState) => state.rounds.at(-1) as Round

function changeRound(ctx: Ctx, change: (round: Round) => Round) {
  ctx.setState((state) => ({ ...state, rounds: [...state.rounds.slice(0, -1), change(latest(state))] }))
}

/** Change one variant's entry in the round being reviewed. Earlier rounds are closed. */
function changeEntry(ctx: Ctx, variant: string, change: (entry: Entry) => Entry) {
  if (!latest(ctx.state).entries.some((entry) => entry.variant === variant)) {
    throw new CanvasKitError('not_found', 'That variant is not in the round being reviewed.', 404)
  }
  changeRound(ctx, (round) => ({ ...round, entries: round.entries.map((entry) => (entry.variant === variant ? change(entry) : entry)) }))
}

const emptyEntry = (variant: string, carried: boolean): Entry => ({ variant, vote: null, note: '', marks: [], carried })

export default defineCanvas({
  id: 'rwoll-bakeoff',
  title: 'Bakeoff',
  description:
    'Lets the user compare variants you made, such as images, PR descriptions or other Markdown, HTML mocks, videos, or text, side by side or head to head: ' +
    'they pick a winner, keep or drop the others, and comment, with pins on images and quotes from text. Use it whenever the user asks for several options of something, ' +
    'or to choose between drafts: open it with a title and a brief, then add the variants with add_variants, with the models that made them and their AI credits when you know them. ' +
    'The user answers from the canvas with a [bakeoff:next-round] message (make new variants from their feedback) or a [bakeoff:use] message (use the winner); get_state has their votes and notes at any time.',
  input: openInput,
  state: stateSchema,
  init: (ctx): BakeoffState => ({
    id: keyOf(ctx),
    title: ctx.input.title ?? 'Bakeoff',
    brief: ctx.input.brief ?? '',
    folder: '',
    variants: [],
    rounds: [{ number: 1, entries: [], overall: '', sent: null }],
  }),
  // Opening it again with a title or brief updates them.
  reopen: ({ input, state }) => {
    const title = input.title ?? state.title
    const brief = input.brief ?? state.brief
    return title === state.title && brief === state.brief ? undefined : { ...state, title, brief }
  },
  persist: { key: keyOf },
  status: (state) => {
    const round = latest(state)
    if (!round.entries.length) return `${state.title}: no variants yet`
    const winner = state.variants.find((variant) => variant.id === round.entries.find((entry) => entry.vote === 'pick')?.variant)
    return `${state.title}: round ${round.number}, ${round.entries.length} variants, ${winner ? `winner ${winner.label}` : 'no winner yet'}`
  },
  // Images and videos only, by the variant's ID; text is read with load_variant.
  files: (ctx, id) => {
    const variant = ctx.state.variants.find((candidate) => candidate.id === id)
    if (!variant || (variant.kind !== 'image' && variant.kind !== 'video') || loadsText(variant)) return null
    return { path: join(bakeoffDir(ctx.dataDir, ctx.state.id), variant.file) }
  },
  actions: ({ action }) => ({
    add_variants: action({
      description:
        'Add variants for the user to compare: each a file (path) or text (content). They get letters (A, B, C…) that never change, and the canvas copies them into the folder it returns. ' +
        'After the user asked for another round, this starts it, and carries their Winner and Keep variants into it for comparison: add only the new ones. ' +
        'Give models and credits for each variant when you know them.',
      expose: 'agent',
      input: z.object({
        variants: z.array(newVariant).min(1).max(MAX_ADDED),
        newRound: z.boolean().optional().describe('Start a new round (true) or add to the round being reviewed (false). By default a new round starts when the user asked for one.'),
      }),
      run: async (ctx, { variants, newRound }) => {
        const state = ctx.state
        if (state.variants.length + variants.length > MAX_VARIANTS) {
          throw new CanvasKitError('too_many', `A bakeoff holds at most ${MAX_VARIANTS} variants, and this one has ${state.variants.length}. Open a new bakeoff with another id.`, 409)
        }
        const dir = bakeoffDir(ctx.dataDir, state.id)
        const current = latest(state)
        const startNew = current.entries.length > 0 && (newRound ?? current.sent !== null)
        const number = startNew ? current.number + 1 : current.number
        const stored: Variant[] = []
        try {
          for (const [index, input] of variants.entries()) {
            const label = labelOf(state.variants.length + index)
            const file = await storeVariant(dir, number, label, input, variants.length > 1 ? `Variant ${index + 1}` : 'The variant')
            stored.push({
              id: `v${state.variants.length + index + 1}`,
              label,
              kind: file.kind,
              approach: input.approach ?? '',
              models: input.models ?? [],
              credits: input.credits ?? null,
              file: file.file,
              bytes: file.bytes,
              round: number,
            })
          }
        } catch (error) {
          await removeStored(dir, stored.map((variant) => variant.file))
          throw error
        }
        const added = stored.map((variant) => emptyEntry(variant.id, false))
        const carried = startNew ? current.entries.filter((entry) => entry.vote === 'pick' || entry.vote === 'keep').map((entry) => emptyEntry(entry.variant, true)) : []
        ctx.setState({
          ...state,
          folder: dir,
          variants: [...state.variants, ...stored],
          rounds: startNew
            ? [...state.rounds, { number, entries: [...carried, ...added], overall: '', sent: null }]
            : [...state.rounds.slice(0, -1), { ...current, entries: [...current.entries, ...added] }],
        })
        return { round: number, folder: dir, added: stored.map(({ id, label, kind, file }) => ({ id, label, kind, file })) }
      },
    }),

    vote: action({
      description: 'Vote on a variant in the round being reviewed: pick (the one winner), keep (for the next round), drop, or null to clear the vote.',
      input: z.object({ variant: variantId, vote: z.enum(VOTES).nullable() }),
      run: (ctx, { variant, vote }) => {
        changeEntry(ctx, variant, (entry) => entry)
        // There is one winner: picking another turns the old one into a keep.
        changeRound(ctx, (round) => ({
          ...round,
          entries: round.entries.map((entry) => (entry.variant === variant ? { ...entry, vote } : vote === 'pick' && entry.vote === 'pick' ? { ...entry, vote: 'keep' as const } : entry)),
        }))
      },
    }),

    set_note: action({
      description: "Save the user's note on a variant: what works and what doesn't.",
      expose: 'ui',
      input: z.object({ variant: variantId, note: z.string().max(MAX_NOTE) }),
      run: (ctx, { variant, note }) => changeEntry(ctx, variant, (entry) => ({ ...entry, note })),
    }),

    add_mark: action({
      description: 'Mark a spot the note can refer to as [1], [2]: a pin on an image (x and y, as fractions of its width and height), or text selected in the variant (quote).',
      expose: 'ui',
      input: z
        .object({ variant: variantId, x: z.number().min(0).max(1).optional(), y: z.number().min(0).max(1).optional(), quote: line(MAX_QUOTE).min(1).optional() })
        .refine((mark) => (mark.quote === undefined ? mark.x !== undefined && mark.y !== undefined : mark.x === undefined && mark.y === undefined), 'Give x and y, or quote.'),
      run: (ctx, { variant, x, y, quote }) => {
        let n = 0
        changeEntry(ctx, variant, (entry) => {
          if (entry.marks.length >= MAX_MARKS) throw new CanvasKitError('too_many', `A variant can have ${MAX_MARKS} marks. Remove one first.`, 409)
          n = Math.max(0, ...entry.marks.map((mark) => mark.n)) + 1
          const note = `${entry.note.trimEnd()}${entry.note.trim() ? ' ' : ''}[${n}] `
          return { ...entry, marks: [...entry.marks, quote === undefined ? { n, x: x as number, y: y as number } : { n, quote }], note: note.length <= MAX_NOTE ? note : entry.note }
        })
        return { n }
      },
    }),

    remove_mark: action({
      description: 'Remove a pin or quote from a variant. The note keeps its text.',
      expose: 'ui',
      input: z.object({ variant: variantId, n: z.number().int().min(1) }),
      run: (ctx, { variant, n }) => changeEntry(ctx, variant, (entry) => ({ ...entry, marks: entry.marks.filter((mark) => mark.n !== n) })),
    }),

    set_overall: action({
      description: "Save the user's feedback on the round as a whole, such as which parts of two variants to combine.",
      expose: 'ui',
      input: z.object({ note: z.string().max(MAX_NOTE) }),
      run: (ctx, { note }) => changeRound(ctx, (round) => ({ ...round, overall: note })),
    }),

    send: action({
      description: 'Send the round to the agent in this chat: ask for another round of variants from the feedback (next), or tell it to use the winner (use).',
      expose: 'ui',
      input: z.object({ kind: z.enum(['next', 'use']) }),
      run: async (ctx, { kind }) => {
        const state = ctx.state
        const round = latest(state)
        if (!round.entries.length) throw new CanvasKitError('nothing_to_send', 'There are no variants yet. Ask the agent to add some.', 409)
        const winner = round.entries.find((entry) => entry.vote === 'pick')
        if (kind === 'use' && !winner) throw new CanvasKitError('no_winner', 'Pick a winner first.', 409)
        if (kind === 'next' && !round.overall.trim() && !round.entries.some((entry) => entry.vote || entry.note.trim())) {
          throw new CanvasKitError('no_feedback', 'Vote or leave a note first, so the agent knows what to change.', 409)
        }
        const folder = bakeoffDir(ctx.dataDir, state.id)
        const feedbackFile = await writeFeedback(folder, round.number, feedback(state, round))
        changeRound(ctx, (current) => ({ ...current, sent: { kind, at: new Date(ctx.now()).toISOString(), variant: kind === 'use' ? (winner as Entry).variant : null } }))
        // A failed send throws, which puts the state back.
        await ctx.sendToAgent({
          prompt: askPrompt({ kind, instanceId: ctx.instanceId, state, round, folder, feedbackFile }),
          displayPrompt: kind === 'use' ? `Bakeoff · use ${state.variants.find((variant) => variant.id === (winner as Entry).variant)?.label}` : `Bakeoff · round ${round.number + 1}`,
        })
        return { sent: true as const, feedbackFile }
      },
    }),

    load_variant: action({
      description: "Read a text variant's content (Markdown, HTML, text, or SVG) for the page to show.",
      expose: 'ui',
      input: z.object({ variant: variantId }),
      run: async (ctx, { variant: id }) => {
        const variant = ctx.state.variants.find((candidate) => candidate.id === id)
        if (!variant || !loadsText(variant)) throw new CanvasKitError('not_found', 'That variant has no text to show.', 404)
        try {
          return { content: await readStored(bakeoffDir(ctx.dataDir, ctx.state.id), variant.file) }
        } catch {
          throw new CanvasKitError('missing_file', `The file of variant ${variant.label} is gone. Ask the agent to add it again.`, 410)
        }
      },
    }),
  }),
})
