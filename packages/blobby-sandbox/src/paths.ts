import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where secrets and their providers live: `$XDG_CONFIG_HOME/blobby`, or `~/.config/blobby`. Created with mode 700. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'blobby')
}

/** Where blobby-sandbox keeps locks and the record of base sandboxes: `$XDG_STATE_HOME/blobby`, or `~/.local/state/blobby`. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'blobby')
}

/** A path with the home folder shortened to `~`, for messages. */
export function displayPath(path: string): string {
  const home = homedir()
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}
