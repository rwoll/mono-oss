import { readdir, stat, statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { configDir, displayPath, stateDir } from './paths.ts'
import type { DoctorCheck } from './router.ts'

const GB = 1024 ** 3
/** Below this, `doctor` warns: a desktop sandbox and its cached base take several gigabytes each. */
export const DISK_WARN_GB = 20
/** Below this, sandboxes can't be installed, so `doctor` fails. */
export const DISK_FAIL_GB = 5

/** Free disk space where sandboxes keep their state, in bytes, from the nearest folder that exists. */
async function freeBytes(path: string): Promise<{ path: string; free: number }> {
  for (let current = path; ; current = dirname(current)) {
    const info = await statfs(current).catch(() => null)
    if (info) return { path: current, free: info.bavail * info.bsize }
    if (dirname(current) === current) throw new Error(`No file system found for ${path}.`)
  }
}

/** Whether this host has room for sandboxes: at least 20 GB free is fine, under 5 GB fails. */
export async function diskCheck(env: NodeJS.ProcessEnv = process.env): Promise<DoctorCheck> {
  try {
    const { path, free } = await freeBytes(stateDir(env))
    const gb = Math.floor((free / GB) * 10) / 10
    if (gb < DISK_FAIL_GB) return { name: 'disk', ok: false, required: true, detail: `${gb} GB free at ${displayPath(path)}. Free up at least ${DISK_WARN_GB} GB, for example with \`blobby-sandbox gc\`.` }
    if (gb < DISK_WARN_GB) return { name: 'disk', ok: false, required: false, detail: `${gb} GB free at ${displayPath(path)}. Sandboxes and their bases take several GB each; free up some space, for example with \`blobby-sandbox gc\`.` }
    return { name: 'disk', ok: true, required: true, detail: `${gb} GB free at ${displayPath(path)}` }
  } catch (error) {
    return { name: 'disk', ok: false, required: false, detail: `Could not check free space: ${(error as Error).message}` }
  }
}

/**
 * Whether there are secrets, and the files that hold them are private: the config folder, `secrets.json`, and every saved
 * secret in `secrets/` must belong to you and be unreadable by others. Names only, never contents.
 */
export async function secretsFilesCheck(env: NodeJS.ProcessEnv = process.env, secrets: string[] = []): Promise<DoctorCheck> {
  const dir = configDir(env)
  const saved = (await readdir(join(dir, 'secrets')).catch(() => [] as string[])).filter((entry) => entry.endsWith('.json')).sort()
  const paths = [join(dir, 'secrets.json'), ...saved.map((entry) => join(dir, 'secrets', entry))]
  const present: string[] = []
  const problems: string[] = []
  for (const path of [dir, join(dir, 'secrets'), ...paths]) {
    const info = await stat(path).catch(() => null)
    if (!info) continue
    if (paths.includes(path)) present.push(path)
    const mine = typeof process.getuid !== 'function' || info.uid === process.getuid()
    if (!mine) problems.push(`${displayPath(path)} must belong to you`)
    else if ((info.mode & 0o077) !== 0) problems.push(`${displayPath(path)} can be read by other users: run \`chmod ${info.isDirectory() ? 700 : 600} ${displayPath(path)}\``)
  }
  if (problems.length) return { name: 'secrets-files', ok: false, required: true, detail: `${problems.join('; ')}.` }
  if (!secrets.length) {
    return { name: 'secrets-files', ok: false, required: false, detail: 'No secrets yet. `exec --secret` needs one: run `blobby-sandbox secrets set github --file <test-account file>` in a terminal.' }
  }
  const names = present.map((path) => (path.endsWith('secrets.json') ? 'secrets.json' : `secrets/${path.split('/').at(-1)}`))
  return { name: 'secrets-files', ok: true, required: true, detail: `${names.join(', ')} in ${displayPath(dir)}, readable only by you` }
}
