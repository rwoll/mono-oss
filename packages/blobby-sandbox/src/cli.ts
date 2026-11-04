#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream, readFileSync, realpathSync } from 'node:fs'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, posix, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { SandboxError } from './backend.ts'
import { readAccountFile } from './account-file.ts'
import { BACKEND_NAMES, createBackend, selectBackend, type BackendSelection } from './backends.ts'
import { allowlistStatus, LocalResolver } from './callbacks/local.ts'
import { isSignedIn } from './callbacks/protocol.ts'
import { connect, createEngine, type ConnectOptions, type SandboxClient } from './client.ts'
import { secretsFilesCheck } from './doctor.ts'
import { buildImage, type ImageBuild, type ImageBuildOptions } from './image.ts'
import { displayPath } from './paths.ts'
import type { ReapReport } from './reaper.ts'
import type { DoctorCheck } from './router.ts'
import type { AccessibleNode, InputAction, UiWait } from './sandboxes.ts'
import { DEFAULT_RECIPE, recipeRef } from './recipe.ts'
import { Secrets, totp, type SecretStatus, type SecretValues } from './secrets.ts'

const UI_STATES: NonNullable<UiWait['state']>[] = ['focused', 'checked', 'selected', 'expanded', 'editable', 'disabled']

const USAGE = `Usage: blobby-sandbox <command> [options]

Sandboxes:
  start <name>                 Create a sandbox, or start a stopped one. A new sandbox runs its recipe's
                               steps.
  list, ls                     List this host's sandboxes. --all adds other managers' on a shared backend;
                               --running and --expired filter; -q prints only names.
  view <name>                  Open a sandbox's desktop viewer in your browser. --print prints the URL
                               instead; --view-only watches without sending input.
  stop <name>                  Stop a sandbox. Its files are kept.
  rm, remove <name>            Delete a sandbox and its files.
  rm --expired                 Delete this host's sandboxes that are past their deletion deadline.
  exec <name> -- <command>     Run a command as the desktop user, in its session. --root runs it as root,
                               for system changes such as \`apt-get install -y\`. The scripts library,
                               such as vscode-signin, is on its PATH; \`blobby-scripts\` lists it.
  exec <name> --secret <secret> -- <command>
                               Also let the command ask for fields of a secret, such as
                               \`exec qa --secret github -- vscode-signin\`. Its login must be in
                               allowedLogins; values never show in the output.
  cp <from> <to>               Copy a file into or out of a sandbox, streamed. Write the sandbox's side as
                               <name>:/path, such as \`cp report.txt qa:/tmp/\` or \`cp qa:/tmp/x.log .\`.
  gc                           Delete expired sandboxes and older cached bases that nothing needs.
  doctor                       Check the backend (which one, and why), free disk, secrets, and the
                               allowlist. --reap also cleans up: expired
                               sandboxes, starts that were killed, and older cached bases.
  image build                  Build the optional blobby-desktop image with Docker, from this package's
                               files. Sandboxes don't need it; nothing is published.

Driving a sandbox's desktop (needs the desktop feature):
  screenshot <name> -o <file>  Save a PNG of the screen.
  input <name> <action>        click X Y | move X Y | type TEXT | key KEYS | scroll DX DY. The pointer
                               moves to X Y as a hand moves a mouse; --instant jumps.
  ui <name>                    Print the visible, named elements of the accessibility tree.
  act <name> <path> [press | focus | set TEXT]
                               Act on an element that ui printed (also: ui <name> <path> ...).
  ui <name> --wait --match TEXT
                               Wait until an element whose name or text has TEXT shows, and print it.
                               --role, --state, and --app narrow it; --gone waits until none shows;
                               --timeout says how long (default 30 seconds, at most 300).
  record <name> start|stop     Record the screen to an MP4. stop -o <file> saves it there.

Secrets and servers:
  secrets [list]               List secrets, by name and source. Never their values.
  secrets set <name>           Save a secret from the keyboard: login, password, and 2FA setup key.
  secrets set <name> --file <path>
                               Use a test-account file you keep, by path: JSON with username, password,
                               and totp_key, mode 600. Only the path is saved; the file is never copied.
  secrets set <name> --provider -- <command>
                               Get a secret from a program that prints it as JSON, such as one that reads
                               a password manager.
  secrets rm <name>            Remove a secret.
  serve                        Serve sandboxes to remote blobby-sandbox clients over HTTP.

Options:
  --json                       Print JSON, for scripts and agents.
  --backend <name>             Where sandboxes run: ${BACKEND_NAMES.join(', ')} (or set BLOBBY_SANDBOX_BACKEND).
                               The default is smolvm when this computer runs it, else docker; see doctor.
  --server <url>               Use a sandbox server (or set BLOBBY_SANDBOX_SERVER, with its token in
                               BLOBBY_SANDBOX_TOKEN). The server picks its own backend.
  --recipe <name | folder>     What a new sandbox has (default ${DEFAULT_RECIPE}; also: desktop). A folder
                               on this computer is sent to the server.
  --resolution <WxH>           The screen size, such as 1600x1000 (default 1280x800).
  --cpus <n>, --memory <MB>    Size of a new sandbox (default 4 CPUs, 8192 MB). Other sizes install it from
                               scratch, which takes a few minutes.
  --no-gpu                     Create a sandbox without the host GPU (also from scratch).
  --delete-after <duration>    The deletion deadline of a new sandbox, for cleanups: 90m, 8h, 7d, or never
                               (default 24h).
  --no-steps                   Do not run a new sandbox's recipe steps.
  --steps                      Run the recipe's steps again.
  --button left|middle|right, --double, --at X,Y, --instant
                               For input click, move, and scroll.
  --action <name>              For ui press: which action, when an element has several.
  --app <name>, --match <text>, --max <n>
                               Limit ui to one app, or to elements whose name or text has <text>.
  --root, --user <user>, --timeout <seconds>
                               For exec: run as root or another user, and stop after this long (default
                               600). For cp: --root writes the file as root.
  --env NAME=VALUE             For exec: set a variable for the command. Repeatable.
  --stdin                      For exec: pass this command's stdin to the command (at most 1 MiB).
  -o, --out <file>             Where screenshot and record stop save (default: in this folder).
  --max-seconds <n>            Stop a recording by itself after this long (default 600).
  --dry-run                    For rm --expired, gc, and doctor --reap: show what would be deleted.
  --platform <p>, --no-cache   For image build: linux/amd64 or linux/arm64, and build every step again.
  --host <address>, --port <n> For serve (default 127.0.0.1 and any free port).
  -h, --help, --version

Test accounts are compromised by design: anything in a sandbox can use their sessions. See the README.`

/** Accounts a step or command signed in to, never their logins: the engine and the resolver checked them. */
function signedInto(result: Record<string, unknown>): string[] {
  return Object.entries(result).flatMap(([key, value]) => (isSignedIn(value) ? [`the ${key} test account (${value.verified ? 'allowlisted' : 'not checked'})`] : []))
}

export interface Io {
  stdout: NodeJS.WriteStream
  stderr: NodeJS.WriteStream
  stdin: NodeJS.ReadStream
  env: NodeJS.ProcessEnv
  /** Makes the client. Tests pass one with a fake engine. */
  connect?: (options: ConnectOptions) => SandboxClient
  /** The login the GitHub CLI is signed in as, if any. */
  ghLogin?: () => Promise<string | null>
  /** Opens a URL in the browser. */
  openUrl?: (url: string) => Promise<void>
  /** The folder that relative --out and --recipe paths are in. */
  cwd?: string
  /** The client's secrets. Tests pass ones with a fake clock. */
  secrets?: Secrets
  /** Runs `blobby-sandbox serve` until it is stopped. Tests replace it. */
  serve?: (options: ServeForeverOptions) => Promise<{ url: string; backend: string; done: Promise<void> }>
  /** Builds the desktop image. Tests replace it. */
  buildImage?: (options: ImageBuildOptions) => Promise<ImageBuild>
}

interface ServeForeverOptions {
  host?: string
  port?: number
  token: string
  backend?: string
  env: NodeJS.ProcessEnv
}

const version = (): string => (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

function openUrl(url: string): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open'
  return new Promise((resolve, reject) => {
    const child = spawn(command, [url], { stdio: 'ignore', detached: true })
    child.once('error', () => reject(new SandboxError('no_browser', `Could not run ${command}. Use \`blobby-sandbox view --print\` and open the URL yourself.`)))
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

function ghLogin(): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('gh', ['api', 'user', '--jq', '.login'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))
    child.on('error', () => resolve(null))
    child.on('close', (code) => resolve(code === 0 && out.trim() ? out.trim() : null))
  })
}

async function serveForever(options: ServeForeverOptions): Promise<{ url: string; backend: string; done: Promise<void> }> {
  const { serve } = await import('./serve.ts')
  const selection: BackendSelection = selectBackend({ backend: options.backend, env: options.env })
  // Made now, so a backend that isn't available stops the server from starting.
  const engine = await createEngine(selection, options.env)
  const others = () => createBackend(selection.name, { env: options.env, labels: {} })
  const served = await serve({ host: options.host, port: options.port, token: options.token, selection, engine: async () => engine, env: options.env, others })
  const done = new Promise<void>((resolve) => {
    const stop = () => void served.close().then(resolve)
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  return { url: served.url, backend: selection.name, done }
}

/** Reads a line without echoing it. */
function readHidden(io: Io, question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = io
    stdout.write(question)
    stdin.setRawMode(true)
    stdin.resume()
    let value = ''
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\r' || character === '\n') return done(() => resolve(value))
        if (character === '\u0003') return done(() => reject(new SandboxError('cancelled', 'Cancelled.')))
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1)
        else value += character
      }
    }
    const done = (finish: () => void) => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      stdout.write('\n')
      finish()
    }
    stdin.on('data', onData)
  })
}

async function ask(io: Io, question: string): Promise<string> {
  const rl = createInterface({ input: io.stdin, output: io.stdout, terminal: true })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

/** Saves a secret from the keyboard. Only a person runs this, in a terminal: agents never see the values. */
async function secretsSet(io: Io, secrets: Secrets, name: string): Promise<void> {
  if (!io.stdin.isTTY || !io.stdout.isTTY) {
    throw new SandboxError('needs_terminal', 'Run `blobby-sandbox secrets set` yourself, in a terminal. It reads the password and 2FA key only from the keyboard.')
  }
  const out = (line = '') => io.stdout.write(`${line}\n`)
  out('Use a dedicated test account, and treat it as compromised from now on: its password and 2FA')
  out('key are saved on this computer, and sandboxes hold live sessions that anything in them can use.')
  out()
  const login = await ask(io, 'Login: ')
  if (name === 'github') {
    const signedIn = await (io.ghLogin ?? ghLogin)()
    if (signedIn && signedIn.toLowerCase() === login.toLowerCase()) {
      throw new SandboxError('own_account', `${login} is the account the GitHub CLI is signed in as. Use a separate test account.`)
    }
  }
  const password = await readHidden(io, 'Password: ')
  const key = await readHidden(io, '2FA setup key (base32, or empty for none): ')
  const values: SecretValues = { login, password, ...(key ? { totpSecret: key } : {}) }
  const existing = (await secrets.list()).find((status) => status.name === name)
  if (existing && (await ask(io, `Replace the ${name} secret? [y/N] `)).toLowerCase() !== 'y') throw new SandboxError('cancelled', `Kept the ${name} secret.`)
  if (key) {
    const code = totp(key)
    out(`Current 2FA code: ${code.slice(0, 3)} ${code.slice(3)}. Check that your authenticator app shows the same.`)
  }
  await secrets.setFile(name, values)
  out(`Saved the ${name} secret, readable only by you.`)
}

const SOURCES: Record<SecretStatus['source'], string> = { provider: 'provider', path: 'account file', file: 'saved in' }

const CHECK_TITLES: Record<string, string> = { disk: 'Disk', image: 'Desktop image', 'secrets-files': 'Secrets files', allowlist: 'Allowlist' }

/** A sandbox's side of `cp`: `<name>:/path`. */
function remotePath(text: string): { name: string; path: string } | null {
  const match = /^([a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?):(\/.*)$/.exec(text)
  return match ? { name: match[1]!, path: match[2]! } : null
}

/** A duration for people, such as `45m`, `5h`, or `3d`. */
function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 120) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

function featuresOf(sandbox: object): string {
  const features = (sandbox as { features?: string[] }).features
  return features?.length ? features.join(',') : '-'
}

/** What a reap did, or would do, for people. */
function reapText(report: ReapReport): string[] {
  const verb = (action: ReapReport['actions'][number]) => (report.dryRun ? 'Would remove' : action.done ? 'Removed' : 'Could not remove')
  const what = (action: ReapReport['actions'][number]) => (action.kind === 'start' ? 'start record' : action.kind === 'snapshot' ? 'base snapshot' : action.sandbox ? 'sandbox' : 'machine')
  const lines = report.actions.map((action) => `${verb(action)} ${what(action)} ${action.sandbox ?? action.id}: ${action.detail}${action.error ? ` (${action.error.message})` : ''}`)
  for (const skip of report.skipped) lines.push(`Kept ${skip.sandbox ?? skip.id}: ${skip.detail}`)
  if (!lines.length) lines.push(`Nothing to clean up on the ${report.backend} backend.`)
  return lines
}

/** Reads all of this command's stdin, up to 1 MiB, for `exec --stdin`. */
async function readStdin(io: Io): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of io.stdin) {
    size += (chunk as Buffer).length
    if (size > 1024 * 1024) throw new SandboxError('usage', '--stdin takes at most 1 MiB. Copy larger input in with `blobby-sandbox cp`.')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)))
  return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column]!)).join('  ').trimEnd()).join('\n')
}

export async function main(argv: string[], io: Io): Promise<number> {
  const split = argv.indexOf('--')
  const own = split === -1 ? argv : argv.slice(0, split)
  const json = own.includes('--json')
  try {
    return await run(own, split === -1 ? [] : argv.slice(split + 1), json, io)
  } catch (error) {
    const known = error instanceof SandboxError
    // parseArgs reports bad options with an ERR_PARSE_ARGS_* code and a message for people.
    const usage = !known && String((error as NodeJS.ErrnoException)?.code ?? '').startsWith('ERR_PARSE_ARGS')
    const code = known ? error.code : usage ? 'usage' : 'internal'
    const text = String((error as Error)?.message ?? error)
    const message = known ? error.message : usage ? `${text.split('. ')[0]}. Run \`blobby-sandbox --help\`.` : text
    io.stderr.write(json ? `${JSON.stringify({ error: { code, message } })}\n` : `blobby-sandbox: ${message}\n`)
    return 1
  }
}

async function run(args: string[], command: string[], json: boolean, io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    allowNegative: true,
    options: {
      json: { type: 'boolean' },
      server: { type: 'string' },
      recipe: { type: 'string' },
      resolution: { type: 'string' },
      gpu: { type: 'boolean' },
      steps: { type: 'boolean' },
      print: { type: 'boolean' },
      provider: { type: 'boolean' },
      button: { type: 'string' },
      double: { type: 'boolean' },
      instant: { type: 'boolean' },
      root: { type: 'boolean' },
      at: { type: 'string' },
      app: { type: 'string' },
      match: { type: 'string' },
      max: { type: 'string' },
      action: { type: 'string' },
      wait: { type: 'boolean' },
      gone: { type: 'boolean' },
      role: { type: 'string' },
      state: { type: 'string' },
      'max-seconds': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
      cpus: { type: 'string' },
      memory: { type: 'string' },
      user: { type: 'string' },
      timeout: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      backend: { type: 'string' },
      'delete-after': { type: 'string' },
      secret: { type: 'string' },
      file: { type: 'string' },
      out: { type: 'string', short: 'o' },
      all: { type: 'boolean' },
      running: { type: 'boolean' },
      expired: { type: 'boolean' },
      quiet: { type: 'boolean', short: 'q' },
      'dry-run': { type: 'boolean' },
      reap: { type: 'boolean' },
      'view-only': { type: 'boolean' },
      env: { type: 'string', multiple: true },
      stdin: { type: 'boolean' },
      platform: { type: 'string' },
      cache: { type: 'boolean' },
    },
  })
  const print = (value: unknown, text: string) => io.stdout.write(`${json ? JSON.stringify(value, null, 2) : text}\n`)
  const [name, ...rest] = positionals
  const server = values.server ?? io.env.BLOBBY_SANDBOX_SERVER
  const client = () => (io.connect ?? connect)({ server, token: io.env.BLOBBY_SANDBOX_TOKEN, backend: values.backend, env: io.env })
  const secrets = io.secrets ?? new Secrets({ env: io.env })
  const target = (index = 0, usage = `blobby-sandbox ${name} <name>`) => {
    if (!rest[index]) throw new SandboxError('usage', `Usage: ${usage}`)
    return rest[index]
  }
  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const number = (value: string | undefined, option: string) => {
    if (value === undefined) return undefined
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed <= 0) throw new SandboxError('usage', `--${option} must be a positive whole number.`)
    return parsed
  }
  const integer = (value: string | undefined, what: string) => {
    const parsed = Number(value)
    if (value === undefined || !Number.isInteger(parsed)) throw new SandboxError('usage', `${what} must be a whole number.`)
    return parsed
  }

  const local = (file: string) => resolve(io.cwd ?? process.cwd(), file)
  const dryRun = values['dry-run'] ?? false
  const reapLines = (report: ReapReport) => reapText(report)

  if (values.version) return print({ version: version() }, version()), 0
  if (values.help || !name) return print({ usage: USAGE }, USAGE), 0
  switch (name) {
    case 'doctor': {
      const sandboxes = client()
      const report = await sandboxes.doctor()
      const statuses = await secrets.list({ check: true })
      const allowlist = await allowlistStatus(secrets, io.env)
      const { backend } = report
      const checks: DoctorCheck[] = [
        ...report.checks,
        ...(backend.checks ?? []).map((check) => ({ ...check, name: `${backend.name}.${check.name}`, required: false })),
        await secretsFilesCheck(io.env, statuses.map((status) => status.name)),
        ...statuses.map((status) => ({ name: `secret.${status.name}`, ok: !status.problem, required: true, detail: status.problem ?? `${SOURCES[status.source]} ${status.detail}` })),
        {
          name: 'allowlist',
          ok: !allowlist.problem,
          // Secrets can't be used without an allowlist, so it matters once one is set.
          required: statuses.length > 0,
          detail: allowlist.problem ?? `${allowlist.allowedLogins} login${allowlist.allowedLogins === 1 ? ' is' : 's are'} allowed (${allowlist.source === 'env' ? 'BLOBBY_SANDBOX_ALLOWED_LOGINS' : 'config.json'})`,
        },
      ]
      const ok = checks.every((check) => check.ok || !check.required)
      const reaped = values.reap ? await sandboxes.reap({ expired: true, interrupted: true, bases: true, dryRun }) : undefined
      const mark = (check: { ok: boolean; required?: boolean }) => (check.ok ? '✓' : check.required === false ? '!' : '✗')
      const title = (check: DoctorCheck) => (check.name.startsWith('secret.') ? `Secret ${check.name.slice('secret.'.length)}` : (CHECK_TITLES[check.name] ?? check.name))
      const own = `${backend.name}.`
      const lines = [
        `${mark({ ok: backend.ok })} Backend ${backend.name}${sandboxes.server ? ` on ${sandboxes.server}` : ''}: ${backend.detail}`,
        `  ${backend.source === 'default' ? `Picked for this computer. ${backend.reason}` : backend.reason}`,
        ...checks.filter((check) => check.name.startsWith(own)).map((check) => `  ${mark(check)} ${check.name.slice(own.length)}: ${check.detail}`),
        ...checks.filter((check) => check.name !== 'backend' && !check.name.startsWith(own)).map((check) => `${mark(check)} ${title(check)}: ${check.detail}`),
        ...(reaped ? ['', ...reapLines(reaped)] : []),
      ]
      print({ ok, backend, checks, secrets: statuses, allowlist, ...(reaped ? { reap: reaped } : {}) }, lines.join('\n'))
      return ok && !reaped?.actions.some((action) => action.error) ? 0 : 1
    }
    case 'secrets': {
      const action = rest[0]
      if (!action || action === 'list') {
        const statuses = await secrets.list()
        const rows = statuses.map((status) => [status.name, SOURCES[status.source], status.problem ? 'problem' : 'ok', status.detail])
        const problems = statuses.flatMap((status) => (status.problem ? [`${status.name}: ${status.problem}`] : []))
        const text = statuses.length ? [table([['NAME', 'SOURCE', 'STATUS', 'WHERE'], ...rows]), ...problems].join('\n') : 'No secrets. Add one with `blobby-sandbox secrets set <name>`.'
        print({ secrets: statuses }, text)
        return 0
      }
      const secret = target(1, `blobby-sandbox secrets ${action} <name>`)
      if (action === 'set') {
        if (values.file !== undefined && values.provider) throw new SandboxError('usage', 'Use --file or --provider, not both.')
        if (values.file !== undefined) {
          const path = resolve(io.cwd ?? process.cwd(), values.file)
          if (secret === 'github') {
            const account = await readAccountFile(path)
            const signedIn = await (io.ghLogin ?? ghLogin)()
            if (signedIn && signedIn.toLowerCase() === account!.login.toLowerCase()) {
              throw new SandboxError('own_account', `${displayPath(path)} is for the account the GitHub CLI is signed in as. Use a separate test account.`)
            }
          }
          await secrets.setPath(secret, path)
          return print({ name: secret, source: 'path', path: displayPath(path) }, `The ${secret} secret now comes from ${displayPath(path)}, which blobby-sandbox reads when a command asks for it and never copies.`), 0
        }
        if (values.provider) {
          await secrets.setProvider(secret, command)
          return print({ name: secret, source: 'provider', command }, `The ${secret} secret now comes from: ${command.join(' ')}`), 0
        }
        return await secretsSet(io, secrets, secret), 0
      }
      if (action === 'rm') {
        const removed = await secrets.remove(secret)
        return print({ removed }, removed ? `Removed the ${secret} secret.` : `There was no ${secret} secret.`), 0
      }
      throw new SandboxError('usage', 'Usage: blobby-sandbox secrets [list | set <name> [--file <path> | --provider -- <command>] | rm <name>]')
    }
    case 'serve': {
      const token = io.env.BLOBBY_SANDBOX_TOKEN || randomBytes(24).toString('base64url')
      const port = values.port === undefined ? undefined : integer(values.port, '--port')
      const served = await (io.serve ?? serveForever)({ host: values.host, port, token, backend: values.backend, env: io.env })
      print(
        { url: served.url, token, backend: served.backend },
        `Serving ${served.backend} sandboxes at ${served.url}\nOn the client: export BLOBBY_SANDBOX_SERVER=${served.url} BLOBBY_SANDBOX_TOKEN=${token}\nStop with Ctrl+C.`,
      )
      await served.done
      return 0
    }
    case 'start': {
      const sandbox = target()
      const sandboxes = client()
      const recipe = values.recipe ? await recipeRef(values.recipe, io.cwd) : undefined
      // For recipe steps that ask for secrets; built-in recipes don't.
      const resolver = new LocalResolver({ secrets, env: io.env })
      const { started } = await sandboxes
        .start(sandbox, {
          recipe,
          resolution: values.resolution,
          cpus: number(values.cpus, 'cpus'),
          memoryMb: number(values.memory, 'memory'),
          gpu: values.gpu,
          steps: values.steps === true ? 'always' : values.steps === false ? 'never' : 'new',
          deleteAfter: values['delete-after'],
          onProgress: (line) => io.stderr.write(`${sandbox}: ${line}\n`),
          resolver,
        })
        .finally(() => resolver.release())
      if (!started) throw new SandboxError('internal', 'The start ended without a result.')
      const details = [started.recipe, ...Object.entries(started.info).map(([key, value]) => (key === 'insiders' ? `VS Code Insiders ${value}` : `${key} ${value}`))]
      const signedIn = started.steps.flatMap((step) => signedInto(step.result))
      print(
        started,
        `${started.created ? 'Created' : 'Started'} ${sandbox} (${details.join(', ')})${signedIn.length ? `, signed in to ${signedIn.join(', ')}` : ''}. ${started.viewer === false ? `See it with \`blobby-sandbox screenshot ${sandbox}\`; this backend has no viewer yet.` : `See it with \`blobby-sandbox view ${sandbox}\`.`}`,
      )
      return 0
    }
    case 'list':
    case 'ls': {
      const now = Date.now()
      const all = await client().list({ mine: !values.all })
      const list = all.filter((sandbox) => (!values.running || sandbox.state === 'running') && (!values.expired || sandbox.expired))
      if (values.quiet && !json) return io.stdout.write(list.map((sandbox) => `${sandbox.name}\n`).join('')), 0
      const rows = list.map((sandbox) => [
        sandbox.name,
        sandbox.state,
        sandbox.backend,
        featuresOf(sandbox),
        sandbox.createdAt ? duration(now - Date.parse(sandbox.createdAt)) : '-',
        sandbox.deleteAfter === null ? 'never' : sandbox.expired ? `expired ${duration(now - Date.parse(sandbox.deleteAfter))} ago` : `in ${duration(Date.parse(sandbox.deleteAfter) - now)}`,
        ...(values.all ? [sandbox.mine ? 'yes' : 'no'] : []),
      ])
      const header = ['NAME', 'STATE', 'BACKEND', 'FEATURES', 'AGE', 'EXPIRES', ...(values.all ? ['MINE'] : [])]
      const none = values.running || values.expired ? 'No sandboxes match.' : 'No sandboxes. Create one with `blobby-sandbox start <name>`.'
      print({ sandboxes: list }, list.length ? table([header, ...rows]) : none)
      return 0
    }
    case 'view': {
      const sandbox = target()
      const viewer = await client().view(sandbox, { viewOnly: values['view-only'] ?? false })
      if (values.print || json) return print({ name: sandbox, ...viewer }, viewer.url), 0
      await (io.openUrl ?? openUrl)(viewer.url)
      return print({}, `Opened ${sandbox} in your browser${viewer.viewOnly ? ', view only' : ''}.`), 0
    }
    case 'stop':
      await client().stop(target())
      return print({ stopped: rest[0] }, `Stopped ${rest[0]}.`), 0
    case 'rm':
    case 'remove': {
      if (values.expired) {
        if (rest[0]) throw new SandboxError('usage', 'Use `blobby-sandbox rm <name>` or `blobby-sandbox rm --expired`, not both.')
        const report = await client().removeExpired({ dryRun })
        print(report, reapLines(report).join('\n'))
        return report.actions.some((action) => action.error) ? 1 : 0
      }
      await client().remove(target(0, 'blobby-sandbox rm <name> | rm --expired'))
      return print({ removed: rest[0] }, `Removed ${rest[0]}.`), 0
    }
    case 'gc': {
      const report = await client().gc({ dryRun })
      print(report, reapLines(report).join('\n'))
      return report.actions.some((action) => action.error) ? 1 : 0
    }
    case 'screenshot': {
      const sandbox = target()
      const shot = await client().screenshot(sandbox)
      const path = local(values.out ?? `${sandbox}-${stamp()}.png`)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, shot.png)
      return print({ path, width: shot.width, height: shot.height }, path), 0
    }
    case 'input': {
      const usage = 'blobby-sandbox input <name> click X Y | move X Y | type TEXT | key KEYS | scroll DX DY'
      const sandbox = target(0, usage)
      const kind = target(1, usage)
      const pair = (): [number, number] => [integer(rest[2], 'X'), integer(rest[3], 'Y')]
      const at = values.at ? (values.at.split(',').map((part) => integer(part, '--at')) as [number, number]) : undefined
      const instant = values.instant ? { instant: true } : {}
      let action: InputAction
      if (kind === 'click') {
        const button = values.button ?? 'left'
        if (!['left', 'middle', 'right'].includes(button)) throw new SandboxError('usage', '--button must be left, middle, or right.')
        action = { click: pair(), button: button as 'left' | 'middle' | 'right', double: values.double ?? false, ...instant }
      } else if (kind === 'move') action = { move: pair(), ...instant }
      else if (kind === 'scroll') action = { scroll: pair(), ...(at ? { at } : {}), ...instant }
      else if (kind === 'type') action = { type: target(2, usage) }
      else if (kind === 'key') action = { key: rest.slice(2).join(' ') || target(2, usage) }
      else throw new SandboxError('usage', `Usage: ${usage}`)
      await client().input(sandbox, action)
      return print({ name: sandbox, action }, 'Done.'), 0
    }
    case 'act':
    case 'ui': {
      const usage = name === 'act' ? 'blobby-sandbox act <name> <path> [press | focus | set TEXT]' : 'blobby-sandbox ui <name> [<path> [press | focus | set TEXT]]'
      const sandbox = target(0, usage)
      if (rest[1] || name === 'act') {
        const path = target(1, usage)
        const kind = (rest[2] ?? 'press') as 'press' | 'focus' | 'set'
        if (!['press', 'focus', 'set'].includes(kind)) throw new SandboxError('usage', `Usage: ${usage}`)
        const result = await client().act(sandbox, { path, do: kind, action: values.action, text: kind === 'set' ? target(3, `blobby-sandbox ${name} <name> <path> set TEXT`) : undefined })
        return print(result, `Did ${result.did} on ${JSON.stringify(result.name)}.`), 0
      }
      const describe = (node: AccessibleNode) => {
        const extra = [node.text !== undefined ? `text=${JSON.stringify(node.text)}` : '', ...(node.states ?? []), node.box ? `at ${node.box.join(',')}` : '']
        return `${node.path}  ${node.role} ${JSON.stringify(node.name)} ${extra.filter(Boolean).join(' ')}`.trimEnd()
      }
      if (values.wait || values.gone) {
        if (!values.match) throw new SandboxError('usage', 'Usage: blobby-sandbox ui <name> --wait --match TEXT [--app NAME] [--role ROLE] [--state STATE] [--gone] [--timeout SECONDS]')
        const state = values.state as UiWait['state']
        if (state !== undefined && !UI_STATES.includes(state)) throw new SandboxError('usage', `--state must be one of ${UI_STATES.join(', ')}.`)
        const waited = await client().waitFor(sandbox, {
          match: values.match,
          app: values.app,
          role: values.role,
          state,
          gone: values.gone ?? false,
          timeoutSeconds: number(values.timeout, 'timeout'),
        })
        const took = `${(waited.waitedMs / 1000).toFixed(1)}s`
        return print(waited, waited.found ? [`Found after ${took}:`, ...waited.nodes.map(describe)].join('\n') : `Gone after ${took}.`), 0
      }
      const tree = await client().ui(sandbox, { app: values.app, match: values.match, max: number(values.max, 'max') })
      const lines = tree.nodes.map(describe)
      if (tree.truncated) lines.push('(more elements: narrow with --app or --match, or raise --max)')
      return print(tree, lines.join('\n') || 'No visible, named elements.'), 0
    }
    case 'record': {
      const usage = 'blobby-sandbox record <name> start|stop [-o <file>]'
      const sandbox = target(0, usage)
      const action = target(1, usage)
      if (action === 'start') {
        const started = await client().recordStart(sandbox, { maxSeconds: number(values['max-seconds'], 'max-seconds') })
        return print({ name: sandbox, ...started }, `Recording ${sandbox}. Stop with \`blobby-sandbox record ${sandbox} stop -o <file>\`.`), 0
      }
      if (action !== 'stop') throw new SandboxError('usage', `Usage: ${usage}`)
      const video = await client().recordStop(sandbox)
      const saved = await video.save(local(values.out ?? `${sandbox}-${stamp()}.mp4`))
      return print({ path: saved.path, id: video.id, size: saved.size, seconds: video.seconds, sha256: saved.sha256 }, saved.path), 0
    }
    case 'exec': {
      if (!command.length) throw new SandboxError('usage', 'Usage: blobby-sandbox exec <name> [--secret <secret>] -- <command> [args...]')
      if (values.root && values.user && values.user !== 'root') throw new SandboxError('usage', 'Use --root or --user, not both.')
      if (values.secret !== undefined && (values.root || values.user || values.env?.length || values.stdin)) {
        throw new SandboxError('usage', 'A command with --secret runs as the desktop user, without --root, --user, --env, or --stdin.')
      }
      const env = Object.fromEntries(
        (values.env ?? []).map((entry) => {
          const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(entry)
          if (!match) throw new SandboxError('usage', `--env takes NAME=VALUE, not ${JSON.stringify(entry)}.`)
          return [match[1]!, match[2]!]
        }),
      )
      const stdin = values.stdin ? await readStdin(io) : undefined
      const sandbox = target()
      const resolver = values.secret === undefined ? undefined : new LocalResolver({ secrets, env: io.env })
      // Refused before anything runs when the secret's login is not on the allowlist.
      if (resolver) await resolver.checkSecret(values.secret!)
      // A sign-in takes a while, so with --json its lines still stream to stderr, as `<name>: line`, like start's progress.
      let pending = ''
      const progress = (text: string, final = false) => {
        const lines = (pending + text).split('\n')
        pending = final ? '' : lines.pop()!
        for (const line of lines) if (line) io.stderr.write(`${sandbox}: ${line}\n`)
      }
      const onOutput = !json
        ? (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void (chunk.stream === 'stdout' ? io.stdout : io.stderr).write(chunk.text)
        : resolver
          ? (chunk: { text: string }) => progress(chunk.text)
          : undefined
      const result = await client()
        .exec(sandbox, command, {
          root: values.root,
          user: values.root ? undefined : values.user,
          timeoutSeconds: number(values.timeout, 'timeout') ?? (resolver ? undefined : 600),
          ...(values.env?.length ? { env } : {}),
          ...(stdin === undefined ? {} : { stdin }),
          ...(resolver ? { secret: values.secret, resolver } : {}),
          // Streamed as it arrives; with --json, the output is one JSON result.
          ...(onOutput ? { onOutput } : {}),
        })
        .finally(() => {
          progress('', true)
          return resolver?.release()
        })
      if (json) print(result, '')
      else if (result.result) {
        const signedIn = signedInto(result.result)
        if (signedIn.length) io.stderr.write(`${sandbox}: signed in to ${signedIn.join(', ')}.\n`)
      }
      return result.exitCode
    }
    case 'cp': {
      const usage = 'blobby-sandbox cp <from> <to>, with <name>:/path on one side'
      const [from, to] = [target(0, usage), target(1, usage)]
      const source = remotePath(from)
      const destination = remotePath(to)
      if (Boolean(source) === Boolean(destination)) {
        throw new SandboxError('usage', `${usage}, such as \`blobby-sandbox cp notes.txt qa:/tmp/\` or \`blobby-sandbox cp qa:/tmp/out.log .\`.`)
      }
      const sandboxes = client()
      if (destination) {
        const path = local(from)
        const info = await stat(path).catch(() => null)
        if (!info) throw new SandboxError('not_found', `There is no file ${path} on this computer.`)
        if (!info.isFile()) throw new SandboxError('not_a_file', `${path} is not a file. cp copies one file; to copy a folder, tar it first.`)
        const into = destination.path.endsWith('/') ? `${destination.path}${basename(path)}` : destination.path
        await sandboxes.writeFile(destination.name, into, createReadStream(path), { root: values.root ?? false, mode: info.mode & 0o777 })
        return print({ from: path, to: `${destination.name}:${into}`, bytes: info.size }, `Copied ${path} to ${destination.name}:${into} (${info.size} bytes).`), 0
      }
      const remote = source!
      let path = local(to)
      if ((await stat(path).catch(() => null))?.isDirectory() || to.endsWith('/')) path = join(path, posix.basename(remote.path))
      await mkdir(dirname(path), { recursive: true })
      const partial = `${path}.partial`
      let bytes = 0
      try {
        const counted = async function* (chunks: AsyncIterable<Uint8Array>) {
          for await (const chunk of chunks) {
            bytes += chunk.length
            yield chunk
          }
        }
        await pipeline(Readable.from(counted(sandboxes.readFile(remote.name, remote.path)), { objectMode: false }), createWriteStream(partial))
        await rename(partial, path)
      } finally {
        await rm(partial, { force: true })
      }
      return print({ from: `${remote.name}:${remote.path}`, to: path, bytes }, `Copied ${remote.name}:${remote.path} to ${path} (${bytes} bytes).`), 0
    }
    case 'image': {
      if (rest[0] !== 'build') throw new SandboxError('usage', 'Usage: blobby-sandbox image build [--platform linux/amd64|linux/arm64] [--no-cache]')
      const built = await (io.buildImage ?? buildImage)({
        platform: values.platform,
        noCache: values.cache === false,
        env: io.env,
        onProgress: (message) => io.stderr.write(`blobby-sandbox: ${message}\n`),
      })
      return print(built, `Built ${built.tags.join(' and ')}${built.size ? ` (${built.size})` : ''}${built.seconds === undefined ? '' : ` in ${built.seconds} s`}.`), 0
    }
    default:
      throw new SandboxError('usage', `Unknown command: ${name}. Run \`blobby-sandbox --help\`.`)
  }
}

const invoked = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
if (invoked) {
  process.exitCode = await main(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin, env: process.env })
}
