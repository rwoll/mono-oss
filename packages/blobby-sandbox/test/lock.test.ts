import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { withLock } from '../src/lock.ts'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'blobby-lock-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

it('runs one holder at a time', async () => {
  const order: string[] = []
  const lock = join(dir, 'locks', 'base')
  await Promise.all(
    ['a', 'b'].map((name) =>
      withLock(lock, 'testing', 5_000, async () => {
        order.push(`${name} in`)
        await new Promise((resolve) => setTimeout(resolve, 50))
        order.push(`${name} out`)
      }),
    ),
  )
  // Either may go first, but the second starts only after the first has finished.
  expect([order[0]!.split(' ')[0], order[1]]).toEqual([order[1]!.split(' ')[0], `${order[0]!.split(' ')[0]} out`])
  expect(order.slice(2).map((step) => step.split(' ')[1])).toEqual(['in', 'out'])
})

it('says another command is busy when it cannot wait', async () => {
  const lock = join(dir, 'base')
  await mkdir(lock)
  await writeFile(join(lock, 'pid'), String(process.pid))
  await expect(withLock(lock, 'installing the base desktop', 0, async () => 'ran')).rejects.toMatchObject({
    code: 'busy',
    message: 'Another blobby-sandbox command is installing the base desktop. Try again when it finishes.',
  })
})

it('takes over a lock whose owner died, or never wrote its process ID', async () => {
  const dead = join(dir, 'dead')
  await mkdir(dead)
  await writeFile(join(dead, 'pid'), '999999')
  expect(await withLock(dead, 'testing', 1_000, async () => 'ran')).toBe('ran')

  const orphan = join(dir, 'orphan')
  await mkdir(orphan)
  const old = new Date(Date.now() - 60_000)
  await utimes(orphan, old, old)
  expect(await withLock(orphan, 'testing', 1_000, async () => 'ran')).toBe('ran')
})
