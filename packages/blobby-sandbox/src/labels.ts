import { randomBytes } from 'node:crypto'
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SandboxError } from './backend.ts'
import { configDir, displayPath } from './paths.ts'

/** Who manages a sandbox: `standalone:<host-id>` for this CLI and library, or `home:<deployment-id>`. */
export const MANAGER_LABEL = 'blobby.dev/manager'
/** What a sandbox is for, such as `desktop`. */
export const KIND_LABEL = 'blobby.dev/kind'

const HOST_ID = /^[a-z0-9][a-z0-9-]{0,62}$/

/**
 * This computer's ID in ownership labels, so each host manages only its own sandboxes. It is random,
 * made on first use, and kept in `host-id` in the config folder.
 */
export async function hostId(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const file = join(configDir(env), 'host-id')
  const existing = (await readFile(file, 'utf8').catch(() => '')).trim()
  if (HOST_ID.test(existing)) return existing
  if (existing) throw new SandboxError('invalid_config', `${displayPath(file)} does not hold a host ID. Remove it, and one is made again.`)
  await mkdir(configDir(env), { recursive: true, mode: 0o700 })
  const id = randomBytes(8).toString('hex')
  // Written whole, then linked into place, so a process that loses the race reads the winner's ID.
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(temporary, `${id}\n`, { mode: 0o600, flag: 'wx' })
    await link(temporary, file)
    return id
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return (await readFile(file, 'utf8')).trim()
  } finally {
    await rm(temporary, { force: true })
  }
}

/** The owner labels of a standalone backend on this host: the machines this host manages on its own, without a controller. */
export async function ownerLabels(env: NodeJS.ProcessEnv = process.env): Promise<Record<string, string>> {
  return { [MANAGER_LABEL]: `standalone:${await hostId(env)}` }
}

/** The labels of sandboxes this host manages on its own: its owner labels and the sandbox's kind. */
export async function standaloneLabels(env: NodeJS.ProcessEnv = process.env, kind = 'desktop'): Promise<Record<string, string>> {
  return { ...(await ownerLabels(env)), [KIND_LABEL]: kind }
}
