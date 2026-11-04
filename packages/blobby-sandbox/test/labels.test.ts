import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { hostId, standaloneLabels } from '../src/labels.ts'

let dir: string
let env: NodeJS.ProcessEnv
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'blobby-labels-'))
  env = { XDG_CONFIG_HOME: join(dir, 'config') }
})
afterEach(() => rm(dir, { recursive: true, force: true }))

it('makes a host ID once, keeps it private, and reuses it', async () => {
  const [first, second] = await Promise.all([hostId(env), hostId(env)])
  expect(first).toMatch(/^[a-f0-9]{16}$/)
  expect(second).toBe(first)
  expect(await hostId(env)).toBe(first)
  const file = join(dir, 'config', 'blobby', 'host-id')
  expect((await readFile(file, 'utf8')).trim()).toBe(first)
  expect((await stat(file)).mode & 0o777).toBe(0o600)
  expect((await stat(join(dir, 'config', 'blobby'))).mode & 0o777).toBe(0o700)
})

it('labels standalone sandboxes with this host as their manager', async () => {
  const id = await hostId(env)
  expect(await standaloneLabels(env)).toEqual({ 'blobby.dev/manager': `standalone:${id}`, 'blobby.dev/kind': 'desktop' })
})
