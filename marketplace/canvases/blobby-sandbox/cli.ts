import { spawn } from 'node:child_process'
import { CanvasKitError } from '@rwoll/canvas-kit'

export interface RunResult {
  exitCode: number
  /** What the CLI printed with --json. */
  json: unknown
}

export interface RunOptions {
  /** Called with each line the CLI prints to stderr, such as start's progress. */
  onLine?: (line: string) => void
  timeoutMs?: number
}

/** Runs one `blobby-sandbox` command. Tests pass a fake. */
export type SandboxCli = (args: string[], options?: RunOptions) => Promise<RunResult>

/**
 * The CLI to run: `BLOBBY_SANDBOX_CLI`, a path to the `blobby-sandbox` executable or its `cli.js`, or else
 * `blobby-sandbox` on PATH. The canvas runs the CLI rather than bundling the SDK, because backends such as
 * smolvm load native code, and the CLI picks the backend the same way everywhere.
 */
export function cliCommand(env: NodeJS.ProcessEnv = process.env): { command: string; prefix: string[] } {
  const configured = env.BLOBBY_SANDBOX_CLI
  // The Copilot host's own executable may not be Node.js, so a script runs with node from PATH.
  if (configured?.endsWith('.js')) return { command: 'node', prefix: [configured] }
  return { command: configured || 'blobby-sandbox', prefix: [] }
}

/** `--json` goes before `--`, which starts the command of `exec`. */
export function withJson(args: string[]): string[] {
  const split = args.indexOf('--')
  return split === -1 ? [...args, '--json'] : [...args.slice(0, split), '--json', ...args.slice(split)]
}

const missing = () =>
  new CanvasKitError(
    'cli_missing',
    'The blobby-sandbox CLI is not installed. Ask the agent to install it with the blobby-sandbox skill (its scripts/install-tools.ts), or set BLOBBY_SANDBOX_CLI to its path, then reload the canvas.',
    503,
  )

export function createCli(env: NodeJS.ProcessEnv = process.env): SandboxCli {
  return (args, options = {}) =>
    new Promise((resolve, reject) => {
      const { command, prefix } = cliCommand(env)
      const child = spawn(command, [...prefix, ...withJson(args)], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      let pending = ''
      const timer = options.timeoutMs ? setTimeout(() => child.kill('SIGTERM'), options.timeoutMs) : undefined
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        stderr += text
        const lines = (pending + text).split('\n')
        pending = lines.pop()!
        for (const line of lines) if (line && !line.startsWith('{')) options.onLine?.(line)
      })
      child.once('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        reject(error.code === 'ENOENT' ? missing() : error)
      })
      child.once('close', (code, signal) => {
        clearTimeout(timer)
        if (pending && !pending.startsWith('{')) options.onLine?.(pending)
        const exitCode = code ?? 1
        try {
          if (stdout.trim()) return resolve({ exitCode, json: JSON.parse(stdout) })
        } catch {
          // Not JSON: an older CLI, or a crash. Fall through to the error.
        }
        const errorLine = stderr.split('\n').reverse().find((line) => line.startsWith('{"error"'))
        if (errorLine) {
          const { error } = JSON.parse(errorLine) as { error: { code: string; message: string } }
          return reject(new CanvasKitError(error.code, error.message, 422))
        }
        const detail = signal ? `was stopped (${signal})` : `exited with code ${exitCode}`
        reject(new CanvasKitError('cli_failed', `\`blobby-sandbox ${args[0]}\` ${detail}: ${stderr.trim().split('\n').slice(-3).join(' ') || 'no output'}`, 500))
      })
    })
}
