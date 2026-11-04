import { randomBytes } from 'node:crypto'
import { afterAll, describe, it } from 'vitest'
import { DockerBackend } from '../src/docker/index.ts'
import { backendConformance, type ConformanceTarget } from '../src/testing.ts'
import { runOwner, sweep, UBUNTU_IMAGE } from './docker-world.ts'
import { FakeDockerEngine } from './fake-docker-engine.ts'

describe('backend conformance: docker on a fake Docker Engine', () => {
  let engine: FakeDockerEngine | undefined
  let count = 0
  const target: ConformanceTarget = {
    image: UBUNTU_IMAGE,
    setup: async () => {
      engine ??= await FakeDockerEngine.start()
      count += 1
      const options = { target: engine.target, env: {} }
      return { backend: new DockerBackend({ ...options, labels: runOwner('fake', `${count}a`) }), other: new DockerBackend({ ...options, labels: runOwner('fake', `${count}b`) }) }
    },
  }
  afterAll(() => engine?.close())
  for (const check of backendConformance(target)) it(check.name, (context) => check.run(context), 30_000)
})

// Real containers, on any computer with Docker. Run them with
// BLOBBY_SANDBOX_CONFORMANCE_DOCKER=1 pnpm --filter @rwoll/blobby-sandbox exec vitest run docker
describe.skipIf(!process.env.BLOBBY_SANDBOX_CONFORMANCE_DOCKER)('backend conformance: docker', () => {
  const run = randomBytes(4).toString('hex')
  let count = 0
  const target: ConformanceTarget = {
    image: UBUNTU_IMAGE,
    resources: { cpus: 1, memoryMb: 512 },
    setup: async () => {
      count += 1
      return { backend: new DockerBackend({ labels: runOwner(run, `${count}a`) }), other: new DockerBackend({ labels: runOwner(run, `${count}b`) }) }
    },
  }
  afterAll(() => sweep(run), 120_000)
  for (const check of backendConformance(target)) it(check.name, (context) => check.run(context), 5 * 60_000)
})
