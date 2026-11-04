import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { CanvasKitError, defineCanvas, z } from '@rwoll/canvas-kit'
import { createCli, type SandboxCli } from './cli.ts'

const NAME = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/, 'Use 1 to 24 lowercase letters, digits, and dashes.')
const RECIPE = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/, 'A built-in recipe, such as vscode-insiders or desktop.')
// With BLOBBY_SANDBOX_SERVER, viewers connect through that server's relay.
const serverSocket = (() => {
  try {
    const server = new URL(process.env.BLOBBY_SANDBOX_SERVER ?? '')
    return [`${server.protocol === 'https:' ? 'wss' : 'ws'}://${server.host}`]
  } catch {
    return []
  }
})()
const MAX_TASKS = 20
const MAX_LINES = 40
const MAX_CAPTURES = 30

const sandboxSchema = z.object({
  name: z.string(),
  state: z.string(),
  viewerPort: z.number().int().nullable(),
  createdAt: z.string().nullable(),
})

const taskSchema = z.object({
  id: z.string(),
  sandbox: z.string(),
  kind: z.enum(['start', 'signin']),
  state: z.enum(['running', 'done', 'failed']),
  /** What happened, when it finished: the result or what went wrong. */
  message: z.string().nullable(),
  lines: z.array(z.string()).max(MAX_LINES),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
})

const captureSchema = z.object({
  sandbox: z.string(),
  kind: z.enum(['screenshot', 'recording']),
  path: z.string(),
  at: z.number(),
})

const stateSchema = z.object({
  /** Problems that stop sandboxes from working, such as a missing CLI, backend, or secret. Empty when all is well. */
  problems: z.array(z.string()),
  /** The backend sandboxes run on, such as smolvm, as doctor picked it. */
  backend: z.string().nullable(),
  /** The secret VS Code Insiders signs in with, when it is usable. Never a login or a secret value. */
  account: z.string().nullable(),
  sandboxes: z.array(sandboxSchema),
  /** The sandbox whose desktop the viewer shows. */
  selected: z.string().nullable(),
  /** Starts and sign-ins, newest first, with their progress. */
  tasks: z.array(taskSchema).max(MAX_TASKS),
  recording: z.array(z.string()),
  /** Screenshots and recordings saved by this canvas, newest first. */
  captures: z.array(captureSchema).max(MAX_CAPTURES),
  refreshedAt: z.number().nullable(),
})

export type State = z.infer<typeof stateSchema>
type Task = z.infer<typeof taskSchema>
type Sandbox = z.infer<typeof sandboxSchema>

export interface Deps {
  cli: SandboxCli
}

/** An account a step signed in to, as the CLI reports it: never by login. */
interface SignedIn {
  signedIn: true
  verified: boolean
}
const isSignedIn = (value: unknown): value is SignedIn => typeof value === 'object' && value !== null && (value as SignedIn).signedIn === true

/** The secret and the script that sign VS Code Insiders in, with `exec --secret`. */
const SIGN_IN = ['--secret', 'github', '--', 'vscode-signin']

const hideText = (result: Record<string, unknown> | undefined) =>
  Object.fromEntries(Object.entries(result ?? {}).map(([key, value]) => [key, typeof value === 'string' ? '(hidden)' : value]))

/**
 * A start's or sign-in's result with no text in what its steps or command reported: the CLI reports
 * accounts as `SignedIn`, and any text there might be a login, which must never reach an agent's report.
 */
function withoutLogins(json: unknown): unknown {
  if (!json || typeof json !== 'object') return json
  const result = json as { steps?: { result?: Record<string, unknown> }[]; result?: Record<string, unknown> }
  return {
    ...result,
    ...(Array.isArray(result.steps) ? { steps: result.steps.map((step) => ({ ...step, result: hideText(step.result) })) } : {}),
    ...(result.result ? { result: hideText(result.result) } : {}),
  }
}

const accounts = (results: (Record<string, unknown> | undefined)[]) =>
  results.flatMap((result) =>
    Object.entries(result ?? {}).flatMap(([key, value]) => (isSignedIn(value) ? [`the ${key} test account (${value.verified ? 'allowlisted' : 'not checked'})`] : [])),
  )

/** What a finished start says: how the sandbox was made, and which test accounts its steps signed in to. */
function describeStart(json: unknown): string {
  const result = json as { from?: string | null; steps?: { result?: Record<string, unknown> }[] }
  const from = result.from === 'base' ? ', copied from the installed base' : result.from === 'scratch' ? ', installed from scratch' : ''
  const signedIn = accounts((result.steps ?? []).map((step) => step.result))
  return `Ready${from}${signedIn.length ? `, signed in to ${signedIn.join(', ')}` : ''}.`
}

/** What a finished sign-in says: the account, or the last thing the script printed when it failed. */
function describeSignIn(json: unknown, exitCode: number): string {
  const result = json as { stdout?: string; stderr?: string; result?: Record<string, unknown> } | null
  if (exitCode !== 0) {
    const last = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`.split('\n').map((line) => line.trim()).filter(Boolean).at(-1)
    return `Signing in failed${last ? `: ${last.replace(/\.$/, '')}` : ` with exit code ${exitCode}`}.`
  }
  const signedIn = accounts([result?.result])
  return signedIn.length ? `Signed in to ${signedIn.join(', ')}.` : 'Signed in.'
}

const stamp = (at: number) => new Date(at).toISOString().replace(/[:.]/g, '-').slice(0, 19)
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The canvas around the blobby-sandbox CLI. Long starts and sign-ins run in the background and show their progress. */
export function createCanvas(deps: Deps) {
  const { cli } = deps
  // Starts and sign-ins outlive the action that began them, so they live here, and refresh copies them into state.
  const tasks = new Map<string, Task>()
  let sequence = 0

  const track = (sandbox: string, kind: Task['kind'], args: string[], now: () => number, describe: (json: unknown, exitCode: number) => string) => {
    const task: Task = { id: `${kind}-${++sequence}`, sandbox, kind, state: 'running', message: null, lines: [], startedAt: now(), finishedAt: null }
    tasks.set(task.id, task)
    for (const id of [...tasks.keys()].slice(0, Math.max(0, tasks.size - MAX_TASKS))) tasks.delete(id)
    const finished = cli(args, {
      onLine: (line) => {
        task.lines = [...task.lines, line.startsWith(`${sandbox}: `) ? line.slice(sandbox.length + 2) : line].slice(-MAX_LINES)
      },
    }).then(
      (result) => {
        task.state = result.exitCode === 0 ? 'done' : 'failed'
        task.message = kind === 'signin' || result.exitCode === 0 ? describe(result.json, result.exitCode) : `Exited with code ${result.exitCode}.`
        task.finishedAt = now()
        return result
      },
      (error: unknown) => {
        task.state = 'failed'
        task.message = message(error)
        task.finishedAt = now()
        throw error
      },
    )
    return { task, finished }
  }

  const snapshotTasks = () => [...tasks.values()].reverse().map((task) => ({ ...task, lines: [...task.lines] }))
  const running = (name: string) => [...tasks.values()].some((task) => task.sandbox === name && task.state === 'running')
  const signIn = (name: string, now: () => number) => track(name, 'signin', ['exec', name, ...SIGN_IN], now, describeSignIn)

  return defineCanvas({
    id: 'blobby-sandbox',
    title: 'Blobby Sandbox',
    description:
      "Start disposable sandboxes with an Ubuntu desktop from recipes, by default with VS Code Insiders, signed in to the user's GitHub test account " +
      'with `exec --secret github -- vscode-signin`, and see, drive, screenshot, and record them. A thin UI over the `blobby-sandbox` CLI, on the ' +
      'backend it picks (smolvm, Docker, or Azure): new sandboxes are copies of an installed base and start in seconds (the first install of a recipe takes ' +
      'a few minutes), then sign in for about 20 seconds. Viewers listen on 127.0.0.1 only, or go through a blobby-sandbox server. Test accounts are compromised by design: never use them ' +
      'for anything else.',
    csp: { connectSrc: ['ws://127.0.0.1:*', ...serverSocket] },
    state: stateSchema,
    init: () => ({ problems: [], backend: null, account: null, sandboxes: [], selected: null, tasks: [], recording: [], captures: [], refreshedAt: null }),
    actions: ({ action }) => {
      type Ctx = { setState(next: (state: State) => State): State; now(): number }
      const refresh = async (ctx: Ctx) => {
        const problems: string[] = []
        let backend: string | null = null
        let account: string | null = null
        let sandboxes: Sandbox[] = []
        try {
          const doctor = (await cli(['doctor'])).json as {
            backend: { name: string; ok: boolean; detail: string }
            secrets: { name: string; source: string; problem: string | null }[]
            allowlist?: { problem: string | null }
          }
          const github = doctor.secrets.find((secret) => secret.name === 'github')
          // Which secret signs in, never its login: doctor doesn't show logins.
          account = github && !github.problem ? github.name : null
          backend = doctor.backend.name
          if (!doctor.backend.ok) problems.push(`The ${doctor.backend.name} backend: ${doctor.backend.detail}`)
          for (const secret of doctor.secrets) if (secret.problem) problems.push(`The ${secret.name} secret: ${secret.problem}`)
          if (!github) problems.push('Signing VS Code in needs the github secret. Run `blobby-sandbox secrets set github --file <test-account file>` in a terminal.')
          if (doctor.allowlist?.problem) problems.push(doctor.allowlist.problem)
          sandboxes = ((await cli(['list'])).json as { sandboxes: Sandbox[] }).sandboxes
        } catch (error) {
          problems.push(message(error))
        }
        return ctx.setState((state) => ({
          ...state,
          problems,
          backend,
          account,
          sandboxes,
          // A sandbox that is still being created is not listed yet, but stays selected.
          selected: state.selected && (sandboxes.some((sandbox) => sandbox.name === state.selected) || running(state.selected)) ? state.selected : null,
          recording: state.recording.filter((name) => sandboxes.some((sandbox) => sandbox.name === name && sandbox.state === 'running')),
          tasks: snapshotTasks(),
          refreshedAt: ctx.now(),
        }))
      }

      const captureDir = async (dataDir: string) => {
        const dir = join(dataDir, 'captures')
        await mkdir(dir, { recursive: true })
        return dir
      }

      return {
        refresh: action({
          description: 'Refresh the list of sandboxes, the backend, the test account, and the progress of starts and sign-ins.',
          run: async (ctx) => {
            const state = await refresh(ctx)
            return {
              problems: state.problems,
              backend: state.backend,
              account: state.account,
              sandboxes: state.sandboxes,
              running: state.tasks.filter((task) => task.state === 'running'),
            }
          },
        }),
        start_sandbox: action({
          description:
            'Create a sandbox from a recipe, or start a stopped one, and show its desktop in the viewer. A new vscode-insiders sandbox then signs ' +
            'VS Code in to the test account. It returns at once and the canvas shows progress; pass wait: true to return when the sandbox is ' +
            'ready, with its result.',
          input: z.object({
            name: NAME,
            recipe: RECIPE.optional().describe('What a new sandbox has: vscode-insiders (the default) or desktop, with nothing signed in.'),
            resolution: z.string().regex(/^[1-9]\d{2,3}x[1-9]\d{2,3}$/).optional().describe('The screen size, such as 1600x1000.'),
            signin: z.boolean().default(true).describe("Sign a new vscode-insiders sandbox's VS Code in to the test account once it starts."),
            wait: z.boolean().default(false).describe('Return when the sandbox is ready instead of at once.'),
          }),
          run: async (ctx, { name, recipe, resolution, signin, wait }) => {
            if (running(name)) throw new CanvasKitError('busy', `${name} is already starting or signing in. Watch its progress in the canvas.`, 409)
            const args = ['start', name, ...(recipe ? ['--recipe', recipe] : []), ...(resolution ? ['--resolution', resolution] : [])]
            const { task, finished } = track(name, 'start', args, ctx.now, describeStart)
            ctx.setState((state) => ({ ...state, selected: name, tasks: snapshotTasks() }))
            // Only a new sandbox signs in: signing in quits and opens VS Code, which a restart shouldn't do.
            const signsIn = signin && (recipe ?? 'vscode-insiders') === 'vscode-insiders'
            const signedIn = finished.then(async (result) => {
              if (!signsIn || result.exitCode !== 0 || (result.json as { created?: boolean } | null)?.created !== true) return null
              const signing = signIn(name, ctx.now)
              return { task: signing.task.id, result: await signing.finished }
            })
            signedIn.catch(() => {})
            if (!wait) return { name, task: task.id, state: 'starting' }
            const result = await finished
            const signing = await signedIn
            await refresh(ctx)
            return {
              ...(withoutLogins(result.json) as object),
              task: task.id,
              ...(signing ? { signIn: { task: signing.task, ...(withoutLogins(signing.result.json) as object) } } : {}),
            }
          },
        }),
        sign_in: action({
          description:
            "Sign a sandbox's VS Code Insiders in to the test account, with `exec --secret github -- vscode-signin`: for a sandbox started " +
            'without signing in, or after a failed sign-in. It quits VS Code first, and opens it again signed in.',
          input: z.object({ name: NAME, wait: z.boolean().default(false) }),
          run: async (ctx, { name, wait }) => {
            if (running(name)) throw new CanvasKitError('busy', `${name} is already starting or signing in.`, 409)
            const { task, finished } = signIn(name, ctx.now)
            ctx.setState((state) => ({ ...state, tasks: snapshotTasks() }))
            if (!wait) {
              finished.catch(() => {})
              return { name, task: task.id, state: 'signing in' }
            }
            const result = await finished
            await refresh(ctx)
            return withoutLogins(result.json)
          },
        }),
        select_sandbox: action({
          description: "Show a sandbox's desktop in the canvas viewer, or none.",
          input: z.object({ name: NAME.nullable() }),
          run: (ctx, { name }) => {
            ctx.setState((state) => ({ ...state, selected: name }))
            return { selected: name }
          },
        }),
        stop_sandbox: action({
          description: 'Stop a sandbox. Its files are kept, and starting it again takes seconds.',
          input: z.object({ name: NAME }),
          run: async (ctx, { name }) => {
            await cli(['stop', name])
            await refresh(ctx)
            return { stopped: name }
          },
        }),
        remove_sandbox: action({
          description: 'Delete a sandbox and its files.',
          input: z.object({ name: NAME }),
          run: async (ctx, { name }) => {
            await cli(['rm', name])
            await refresh(ctx)
            return { removed: name }
          },
        }),
        take_screenshot: action({
          description: "Save a PNG of a sandbox's desktop in the canvas's data folder, and return its path so you can view it.",
          input: z.object({ name: NAME }),
          run: async (ctx, { name }) => {
            const out = join(await captureDir(ctx.dataDir), `${name}-${stamp(ctx.now())}.png`)
            const shot = (await cli(['screenshot', name, '--out', out])).json as { path: string; width: number; height: number }
            ctx.setState((state) => ({ ...state, captures: [{ sandbox: name, kind: 'screenshot' as const, path: shot.path, at: ctx.now() }, ...state.captures].slice(0, MAX_CAPTURES) }))
            return shot
          },
        }),
        start_recording: action({
          description: "Start recording a sandbox's desktop. It stops by itself after maxSeconds.",
          input: z.object({ name: NAME, maxSeconds: z.number().int().min(1).max(3600).default(600) }),
          run: async (ctx, { name, maxSeconds }) => {
            await cli(['record', name, 'start', '--max-seconds', String(maxSeconds)])
            ctx.setState((state) => ({ ...state, recording: [...new Set([...state.recording, name])] }))
            return { name, recording: true, maxSeconds }
          },
        }),
        stop_recording: action({
          description: "Stop recording a sandbox's desktop and save the MP4 in the canvas's data folder. Returns its path and length.",
          input: z.object({ name: NAME }),
          run: async (ctx, { name }) => {
            const out = join(await captureDir(ctx.dataDir), `${name}-${stamp(ctx.now())}.mp4`)
            const result: Awaited<ReturnType<SandboxCli>> | Error = await cli(['record', name, 'stop', '--out', out]).catch((error: unknown) =>
              error instanceof Error ? error : new Error(String(error)),
            )
            if (result instanceof Error) {
              // A recording that stopped by itself is not running any more; the canvas forgets it rather than failing again.
              if (result instanceof CanvasKitError && result.code === 'not_recording') {
                ctx.setState((state) => ({ ...state, recording: state.recording.filter((entry) => entry !== name) }))
                return { name, recording: false, note: result.message }
              }
              throw result
            }
            const saved = result.json as { path: string; seconds: number | null }
            ctx.setState((state) => ({
              ...state,
              recording: state.recording.filter((entry) => entry !== name),
              captures: [{ sandbox: name, kind: 'recording' as const, path: saved.path, at: ctx.now() }, ...state.captures].slice(0, MAX_CAPTURES),
            }))
            return saved
          },
        }),
        run_command: action({
          description:
            'Run a command in a sandbox, in its desktop session, so it can open windows and use xdotool and wmctrl: as the desktop user, or with user "root" for ' +
            'system changes such as `apt-get install -y`. Returns the exit code and output.',
          expose: 'agent',
          input: z.object({
            name: NAME,
            command: z.array(z.string().max(4000)).min(1).max(200),
            user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/).optional().describe('Another user: root, for installing packages and other system changes.'),
            timeoutSeconds: z.number().int().min(1).max(3600).default(600),
          }),
          run: async (_ctx, { name, command, user, timeoutSeconds }) => {
            const result = await cli(['exec', name, ...(user ? ['--user', user] : []), '--timeout', String(timeoutSeconds), '--', ...command])
            return result.json
          },
        }),
        connect_desktop: action({
          description: "Return the viewer websocket URL and password of a running sandbox's desktop, for the canvas viewer.",
          expose: 'ui',
          input: z.object({ name: NAME }),
          run: async (_ctx, { name }) => {
            const { websocket, password } = (await cli(['view', name, '--print'])).json as { websocket: string; password: string }
            return { url: websocket, password }
          },
        }),
        open_in_browser: action({
          description: "Open a sandbox's desktop in the user's browser.",
          expose: 'ui',
          input: z.object({ name: NAME }),
          run: async (_ctx, { name }) => {
            await cli(['view', name])
            return { opened: name }
          },
        }),
      }
    },
  })
}

export default createCanvas({ cli: createCli() })
