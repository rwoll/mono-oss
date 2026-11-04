import { initTRPC, TRPCError } from '@trpc/server'
import { z } from 'zod'
import { SandboxError, type Backend, type BackendCheck, type BackendStatus, type Capabilities, type Endpoint, type Machine } from './backend.ts'
import type { BackendSelection } from './backends.ts'
import { MANAGER_LABEL } from './labels.ts'
import { DURATION_PATTERN, MACHINE_PREFIX, NAME_PATTERN, RESOLUTION_PATTERN, type SandboxInfo, type Sandboxes } from './sandboxes.ts'
import type { Jobs } from './jobs.ts'
import { diskCheck } from './doctor.ts'
import { reap, recordStart } from './reaper.ts'
import { describeBuiltinRecipes, RecipeRefSchema, resolveRecipe } from './recipe.ts'
import { SECRET_NAME } from './secrets.ts'

/** What each request runs with. In-process clients and `blobby-sandbox serve` both make one. */
export interface Context {
  /** The engine, created on first use, so commands that don't need the backend don't load it. */
  engine: () => Promise<Sandboxes>
  /** Which backend the engine runs on, and why. Without it, `doctor` names the engine's backend. */
  selection?: BackendSelection
  jobs: Jobs
  /** Turns where the engine reaches a sandbox's viewer into a URL the client can reach: the same place in-process, or a relay path. */
  viewerUrl: (sandbox: string, endpoint: Endpoint) => Promise<string>
  /** Where the engine runs: its state folder holds start records, and its config folder this host's ID. Default `process.env`. */
  env?: NodeJS.ProcessEnv
  /**
   * The same backend without an owner filter, for `list --all`, which also shows other managers' sandboxes
   * on a shared backend. Absent or null: only this host's are listed.
   */
  others?: () => Promise<Backend | null>
}

/** A sandbox, as `list` shows it. */
export interface ListedSandbox extends SandboxInfo {
  /** The backend it runs on. */
  backend: string
  /** Whether it is past its deletion deadline, so `rm --expired` and `gc` remove it. */
  expired: boolean
  /** Whether this host manages it. Others are listed only with `list --all`. */
  mine: boolean
  /** Its manager label, such as `standalone:<host ID>`, or null when it has none. */
  manager: string | null
}

/** One thing `doctor` checked on the engine's side. A failed `required` check means sandboxes can't start. */
export interface DoctorCheck extends BackendCheck {
  required: boolean
}

/** What `doctor` says about the backend: which one, why, whether this host can run it, and what it can do. */
export interface DoctorBackend extends BackendStatus {
  name: string
  source: BackendSelection['source'] | 'engine'
  reason: string
  /** Null when the backend could not be made. */
  capabilities: Capabilities | null
}

const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
    const cause = error.cause
    return { ...shape, data: { ...shape.data, sandboxCode: cause instanceof SandboxError ? cause.code : null } }
  },
})

const name = z.string().regex(NAME_PATTERN)
const expired = (deleteAfter: string | null, now: number) => deleteAfter !== null && Date.parse(deleteAfter) <= now
const otherSandbox = (machine: Machine, backend: string, now: number): ListedSandbox => ({
  name: machine.name.slice(MACHINE_PREFIX.length),
  state: machine.state,
  viewerPort: null,
  createdAt: machine.createdAt,
  deleteAfter: machine.deleteAfter,
  backend,
  expired: expired(machine.deleteAfter, now),
  mine: false,
  manager: machine.labels[MANAGER_LABEL] ?? null,
})
const point = z.tuple([z.number().int(), z.number().int()])
const sealed = z.strictObject({ v: z.literal(1), epk: z.string(), nonce: z.string(), ct: z.string(), tag: z.string() })
export const CallbackAnswerSchema = z.union([
  z.strictObject({ value: z.string() }),
  z.strictObject({ sealed }),
  z.strictObject({ error: z.string().max(1000), code: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/).optional() }),
])
export const InputActionSchema = z.union([
  z.strictObject({ click: point, button: z.enum(['left', 'middle', 'right']).optional(), double: z.boolean().optional(), instant: z.boolean().optional() }),
  z.strictObject({ move: point, instant: z.boolean().optional() }),
  z.strictObject({ type: z.string().max(10_000) }),
  z.strictObject({ key: z.string().min(1).max(200) }),
  z.strictObject({ scroll: point, at: point.optional(), instant: z.boolean().optional() }),
])
export const NetworkPolicySchema = z.union([
  z.enum(['none', 'essential', 'internet']),
  z.strictObject({ allow: z.array(z.string().regex(/^(?:\*\.)?[A-Za-z0-9.-]+$/).max(253)).max(1000) }),
])
const MAX_CHUNK = 4 * 1024 * 1024
const ExecInputSchema = z.strictObject({
  name,
  command: z.array(z.string()).min(1).max(1000),
  user: z.string().regex(/^[a-z_][a-z0-9_-]*$/).optional(),
  timeoutSeconds: z.number().int().min(1).max(86_400).optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).optional(),
  stdin: z.string().max(1024 * 1024).optional(),
  /** Binary stdin. */
  stdinBase64: z.string().max(1.5 * 1024 * 1024).optional(),
  /** A secret the command may ask for. Only `execJob` takes it, since its callbacks go to the client. */
  secret: z.string().regex(SECRET_NAME).optional(),
})
/** The engine's exec options from the wire's. */
const execOptions = ({ stdinBase64, ...options }: Omit<z.infer<typeof ExecInputSchema>, 'name' | 'command'>) => {
  if (stdinBase64 !== undefined && options.stdin !== undefined) throw new SandboxError('usage', 'Send stdin or stdinBase64, not both.')
  return stdinBase64 === undefined ? options : { ...options, stdin: Buffer.from(stdinBase64, 'base64') }
}

// tRPC wraps errors it doesn't know; a SandboxError keeps its code in the error's data.
const procedure = t.procedure.use(async ({ next }) => {
  const result = await next()
  if (!result.ok && result.error.cause instanceof SandboxError && result.error.code === 'INTERNAL_SERVER_ERROR') {
    const cause = result.error.cause
    const code = cause.code === 'not_found' ? 'NOT_FOUND' : cause.code === 'usage' || cause.code.startsWith('invalid') ? 'BAD_REQUEST' : 'PRECONDITION_FAILED'
    throw new TRPCError({ code, message: cause.message, cause })
  }
  return result
})

export const appRouter = t.router({
  doctor: procedure.query(async ({ ctx }) => {
    let name: string | undefined = ctx.selection?.name
    let status: BackendStatus
    let capabilities: Capabilities | null = null
    try {
      const engine = await ctx.engine()
      name ??= engine.backend.name
      capabilities = engine.backend.capabilities()
      status = await engine.check()
    } catch (error) {
      // A backend that can't be made, such as one that isn't installed, is what doctor reports.
      if (!(error instanceof SandboxError)) throw error
      status = { ok: false, detail: error.message, code: error.code }
    }
    const backend: DoctorBackend = {
      name: name ?? 'unknown',
      source: ctx.selection?.source ?? 'engine',
      reason: ctx.selection?.reason ?? 'The client was given its engine.',
      ...status,
      capabilities,
    }
    const checks: DoctorCheck[] = [{ name: 'backend', ok: status.ok, required: true, detail: status.detail }]
    checks.push(await diskCheck(ctx.env))
    return { backend, checks, recipes: await describeBuiltinRecipes() }
  }),
  list: procedure.input(z.strictObject({ all: z.boolean().optional() }).optional()).query(async ({ ctx, input }) => {
    const engine = await ctx.engine()
    const now = Date.now()
    const own = (await engine.list()).map((sandbox): ListedSandbox => ({
      ...sandbox,
      backend: engine.backend.name,
      expired: expired(sandbox.deleteAfter, now),
      mine: true,
      manager: null,
    }))
    if (own.length) {
      const labels = new Map((await engine.backend.list()).map((machine) => [machine.name, machine.labels[MANAGER_LABEL] ?? null]))
      for (const sandbox of own) sandbox.manager = labels.get(MACHINE_PREFIX + sandbox.name) ?? null
    }
    const others = input?.all ? await ctx.others?.() : null
    if (!others) return { sandboxes: own }
    const managers = new Set(own.map((sandbox) => sandbox.manager).filter(Boolean))
    // Sandboxes another manager labelled, never unlabelled machines, which may not be sandboxes at all.
    const theirs = (await others.list())
      .filter((machine) => machine.name.startsWith(MACHINE_PREFIX) && NAME_PATTERN.test(machine.name.slice(MACHINE_PREFIX.length)))
      .filter((machine) => machine.labels[MANAGER_LABEL] && !managers.has(machine.labels[MANAGER_LABEL]) && !own.some((sandbox) => MACHINE_PREFIX + sandbox.name === machine.name))
      .map((machine) => otherSandbox(machine, others.name, now))
    return { sandboxes: [...own, ...theirs].sort((a, b) => Number(b.mine) - Number(a.mine) || a.name.localeCompare(b.name, 'en', { numeric: true })) }
  }),
  get: procedure.input(z.strictObject({ name })).query(async ({ ctx, input }) => {
    const engine = await ctx.engine()
    const sandbox = (await engine.list()).find((sandbox) => sandbox.name === input.name)
    if (!sandbox) throw new SandboxError('not_found', `There is no sandbox named ${input.name} on the ${engine.backend.name} backend. See \`blobby-sandbox list\`, or pick the backend it's on with --backend.`)
    return sandbox
  }),
  reap: procedure
    .input(z.strictObject({ expired: z.boolean().optional(), interrupted: z.boolean().optional(), bases: z.boolean().optional(), dryRun: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => reap((await ctx.engine()).backend, { ...input, env: ctx.env })),
  start: procedure
    .input(
      z.strictObject({
        name,
        recipe: RecipeRefSchema.optional(),
        resolution: z.string().regex(RESOLUTION_PATTERN).optional(),
        cpus: z.number().int().min(1).max(64).optional(),
        memoryMb: z.number().int().min(1024).max(262_144).optional(),
        gpu: z.boolean().optional(),
        steps: z.enum(['new', 'always', 'never']).optional(),
        deleteAfter: z.string().regex(DURATION_PATTERN).optional(),
        network: NetworkPolicySchema.optional(),
        allowUnenforcedNetwork: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const recipe = input.recipe ? await resolveRecipe(input.recipe) : undefined
      const engine = await ctx.engine()
      // Recorded before anything is created, so `doctor --reap` can clean up if this process dies mid-start.
      const existed = (await engine.backend.get(MACHINE_PREFIX + input.name)) !== null
      const started = await recordStart({ name: input.name, backend: engine.backend.name, existed }, { env: ctx.env })
      const job = ctx.jobs.start((job) =>
        engine.start(input.name, {
          recipe,
          resolution: input.resolution,
          cpus: input.cpus,
          memoryMb: input.memoryMb,
          gpu: input.gpu,
          steps: input.steps,
          deleteAfter: input.deleteAfter,
          network: input.network,
          allowUnenforcedNetwork: input.allowUnenforcedNetwork,
          onProgress: job.progress,
          // Callbacks and step results go to the client's resolver.
          resolver: { resolve: job.request, checkResult: job.check },
          signal: job.signal,
        }).finally(() => started.done()),
      )
      return { job }
    }),
  stop: procedure.input(z.strictObject({ name })).mutation(async ({ ctx, input }) => {
    await (await ctx.engine()).stop(input.name)
    return { stopped: input.name }
  }),
  remove: procedure.input(z.strictObject({ name })).mutation(async ({ ctx, input }) => {
    await (await ctx.engine()).remove(input.name)
    return { removed: input.name }
  }),
  view: procedure.input(z.strictObject({ name })).query(async ({ ctx, input }) => {
    const viewer = await (await ctx.engine()).view(input.name)
    return { url: await ctx.viewerUrl(input.name, viewer.endpoint), password: viewer.password }
  }),
  exec: procedure
    .input(ExecInputSchema)
    .mutation(async ({ ctx, input }) => {
      const { name: sandbox, command, ...options } = input
      if (options.secret !== undefined) throw new SandboxError('usage', 'A command with a secret runs as a job: use execJob, which passes its callbacks to the client.')
      return (await ctx.engine()).exec(sandbox, command, execOptions(options))
    }),
  /** Like `exec`, as a job whose events stream the command's output. Cancel it with `jobs.cancel`. */
  execJob: procedure.input(ExecInputSchema).mutation(async ({ ctx, input }) => {
    const { name: sandbox, command, ...options } = input
    const engine = await ctx.engine()
    const job = ctx.jobs.start((job) =>
      engine.exec(sandbox, command, {
        ...execOptions(options),
        onOutput: (chunk) => job.output(chunk.stream, chunk.text),
        signal: job.signal,
        // Callbacks and the command's result go to the client's resolver.
        ...(options.secret === undefined ? {} : { resolver: { resolve: job.request, checkResult: job.check } }),
      }),
    )
    return { job }
  }),
  screenshot: procedure.input(z.strictObject({ name })).mutation(async ({ ctx, input }) => {
    const shot = await (await ctx.engine()).screenshot(input.name)
    return { png: Buffer.from(shot.png).toString('base64'), width: shot.width, height: shot.height }
  }),
  input: procedure.input(z.strictObject({ name, action: InputActionSchema })).mutation(async ({ ctx, input }) => {
    await (await ctx.engine()).input(input.name, input.action)
    return {}
  }),
  ui: procedure
    .input(z.strictObject({ name, app: z.string().max(200).optional(), match: z.string().max(200).optional(), max: z.number().int().min(1).max(5000).optional() }))
    .query(async ({ ctx, input }) => {
      const { name: sandbox, ...query } = input
      return (await ctx.engine()).ui(sandbox, query)
    }),
  waitFor: procedure
    .input(
      z.strictObject({
        name,
        match: z.string().min(1).max(200),
        app: z.string().max(200).optional(),
        role: z.string().max(100).optional(),
        state: z.enum(['focused', 'checked', 'selected', 'expanded', 'editable', 'disabled']).optional(),
        gone: z.boolean().optional(),
        timeoutSeconds: z.number().int().min(1).max(300).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { name: sandbox, ...wait } = input
      return (await ctx.engine()).waitFor(sandbox, wait)
    }),
  act: procedure
    .input(
      z.strictObject({
        name,
        path: z.string().regex(/^\d+(?:\.\d+)*$/),
        do: z.enum(['press', 'focus', 'set']).optional(),
        action: z.string().max(100).optional(),
        text: z.string().max(10_000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { name: sandbox, ...act } = input
      return (await ctx.engine()).act(sandbox, act)
    }),
  record: t.router({
    start: procedure.input(z.strictObject({ name, maxSeconds: z.number().int().min(1).max(3600).optional() })).mutation(async ({ ctx, input }) => {
      return (await ctx.engine()).recordStart(input.name, { maxSeconds: input.maxSeconds })
    }),
    stop: procedure.input(z.strictObject({ name })).mutation(async ({ ctx, input }) => (await ctx.engine()).recordStop(input.name)),
  }),
  media: t.router({
    read: procedure
      .input(z.strictObject({ name, id: z.string().regex(/^[a-f0-9]{8,64}$/), offset: z.number().int().min(0), length: z.number().int().min(1).max(MAX_CHUNK) }))
      .query(async ({ ctx, input }) => {
        const chunk = await (await ctx.engine()).mediaRead(input.name, input.id, input.offset, input.length)
        return { data: Buffer.from(chunk.data).toString('base64'), eof: chunk.eof }
      }),
    delete: procedure.input(z.strictObject({ name, id: z.string().regex(/^[a-f0-9]{8,64}$/) })).mutation(async ({ ctx, input }) => {
      await (await ctx.engine()).mediaDelete(input.name, input.id)
      return {}
    }),
  }),
  jobs: t.router({
    events: procedure
      .input(z.strictObject({ id: z.string().regex(/^[a-f0-9]{32}$/), after: z.number().int().min(0), waitMs: z.number().int().min(0).max(25_000).optional() }))
      .query(({ ctx, input }) => ctx.jobs.events(input.id, input.after, input.waitMs ?? 20_000)),
    answer: procedure
      .input(z.strictObject({ id: z.string().regex(/^[a-f0-9]{32}$/), request: z.string().regex(/^[a-f0-9]{8,64}$/), answer: CallbackAnswerSchema }))
      .mutation(({ ctx, input }) => {
        ctx.jobs.answer(input.id, input.request, input.answer)
        return {}
      }),
    check: procedure
      .input(
        z.strictObject({
          id: z.string().regex(/^[a-f0-9]{32}$/),
          check: z.string().regex(/^[a-f0-9]{16}$/),
          reply: z.union([
            z.strictObject({ result: z.record(z.string(), z.unknown()) }),
            z.strictObject({ error: z.strictObject({ code: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), message: z.string().max(1000) }) }),
          ]),
        }),
      )
      .mutation(({ ctx, input }) => {
        ctx.jobs.checked(input.id, input.check, input.reply)
        return {}
      }),
    cancel: procedure.input(z.strictObject({ id: z.string().regex(/^[a-f0-9]{32}$/) })).mutation(({ ctx, input }) => {
      ctx.jobs.cancel(input.id)
      return {}
    }),
  }),
})

export type AppRouter = typeof appRouter
