import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineCanvas, z, type ActionContext } from '@rwoll/canvas-kit'
import { readSessionSkills } from './log.ts'
import { STAGES } from './shared.ts'

/** Where Copilot keeps its files, unless this is set: `~/.copilot`. */
export const HOME_ENV = 'COPILOT_HOME'

export interface FunnelOptions {
  /** The folder with one folder per session. Defaults to `session-state` in Copilot's home: `$COPILOT_HOME`, or `~/.copilot`. */
  root?: () => string
}

const sessionId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/, 'must be a session ID')
const amount = z.number().int().min(0)

const state = z.object({
  /** The ID of the session shown, or null when the canvas was opened outside a chat with no session given. */
  session: z.string().nullable(),
  title: z.string(),
  status: z.enum(['idle', 'ready', 'error']),
  error: z.string().nullable(),
  /** False when the session's log does not say which skills were available, so only the invoked ones are shown. */
  listed: z.boolean(),
  readAt: z.string().nullable(),
  /** Invoked first, then the rest. */
  skills: z.array(z.object({ name: z.string(), description: z.string(), stage: z.enum(STAGES) })).max(500),
  /** An invoked skill was also available, so it counts in both. `available` is null when the log does not say which skills were. */
  counts: z.object({ available: amount.nullable(), invoked: amount }),
  /** Tokens in the agent's context (measured), and about how many of them are the list of available skills and the instructions of invoked skills. Null before its first model call. */
  context: z.object({ total: amount, available: amount, invoked: amount }).nullable(),
})

export type FunnelState = z.output<typeof state>
type Ctx = ActionContext<FunnelState>

const empty = (session: string | null): FunnelState => ({
  session,
  title: '',
  status: 'idle',
  error: null,
  listed: true,
  readAt: null,
  skills: [],
  counts: { available: 0, invoked: 0 },
  context: null,
})

export function createSkillFunnelCanvas(options: FunnelOptions = {}) {
  const root = options.root ?? (() => join(process.env[HOME_ENV] || join(homedir(), '.copilot'), 'session-state'))
  /** The session to show: the one asked for, or the chat the canvas is in. */
  const sessionFor = (asked: string | undefined, chat: string | undefined) => asked ?? (sessionId.safeParse(chat).success ? (chat as string) : null)

  async function read(ctx: Ctx): Promise<FunnelState> {
    const { session } = ctx.state
    const failed = (error: string) => ctx.setState({ ...empty(session), status: 'error', error })
    if (!session) return failed('There is no session to show. Open this canvas from a chat, or open it with the ID of a session.')
    try {
      const { title, listed, skills, context } = await readSessionSkills(join(root(), session))
      return ctx.setState({
        session,
        title,
        status: 'ready',
        error: null,
        listed,
        readAt: new Date(ctx.now()).toISOString(),
        skills,
        counts: { available: listed ? skills.length : null, invoked: skills.filter((skill) => skill.stage === 'invoked').length },
        context,
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return failed(`Session ${session} has no log in ${root()}.`)
      const message = error instanceof Error ? error.message : String(error)
      ctx.log(`Skill funnel could not read session ${session} in ${root()}: ${message}`, 'error')
      return failed(`The log of session ${session} could not be read: ${message}`)
    }
  }

  return defineCanvas({
    id: 'rwoll-skill-funnel',
    title: 'Skill funnel',
    description:
      "Shows the skills of a Copilot session, from its log on this machine: how many were available (listed to the agent by name and description) and which of them were invoked (their full instructions put in the agent's context), " +
      "with a wheel of how much of the agent's context they take. It shows this chat unless opened with the ID of another session. After opening, call refresh.",
    state,
    input: z.object({ session: sessionId.optional().describe('The ID of the session to show. Defaults to the chat that opens the canvas.') }),
    init: ({ input, sessionId: chat }) => empty(sessionFor(input.session, chat)),
    // Opening it again with another session shows that one.
    reopen: ({ input, state: current, sessionId: chat }) => {
      const session = sessionFor(input.session, chat)
      return session === current.session ? undefined : empty(session)
    },
    status: (current) => {
      if (current.status === 'idle') return 'Not read yet: call refresh'
      if (current.status === 'error') return current.error ?? 'The session could not be read'
      const { available, invoked } = current.counts
      if (available === null) return `${invoked} skill${invoked === 1 ? '' : 's'} invoked; the session's log does not say which were available`
      return `${available} skill${available === 1 ? '' : 's'} available, ${invoked} invoked`
    },
    actions: ({ action }) => ({
      refresh: action({
        description:
          "Read the session's log again. Returns how many skills were available (null when the log does not say) and invoked, the names of the invoked ones, and what they take of the agent's context in tokens; get_state has every skill. The page calls it when it opens and as the agent works.",
        run: async (ctx) => {
          const { status, error, counts, context, skills } = await read(ctx)
          return { status, error, counts, context, invoked: skills.filter((skill) => skill.stage === 'invoked').map((skill) => skill.name) }
        },
      }),
    }),
  })
}

export default createSkillFunnelCanvas()
