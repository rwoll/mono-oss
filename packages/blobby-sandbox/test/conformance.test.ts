import { describe, it } from 'vitest'
import { KIND_LABEL, MANAGER_LABEL } from '../src/labels.ts'
import { SmolvmBackend } from '../src/smolvm.ts'
import { backendConformance, emulateCommand, FakeBackend, type ConformanceTarget } from '../src/testing.ts'
import { FakeSdk } from './fake-sdk.ts'

const owner = (host: string) => ({ [MANAGER_LABEL]: `standalone:${host}`, [KIND_LABEL]: 'desktop' })

/** A fake with every optional capability off, so the suite's capability checks and skips run too. */
const minimal = {
  branch: false,
  publish: false,
  gpu: false,
  networkPolicies: ['internet' as const],
  commandSandbox: false,
  streamingFiles: false,
  labels: false,
  stdin: false,
  snapshot: false,
}

const targets: [string, ConformanceTarget][] = [
  [
    'FakeBackend',
    {
      setup: async () => {
        const backend = new FakeBackend({ labels: owner('a') })
        return { backend, other: new FakeBackend({ labels: owner('b'), machines: backend.machines, snapshots: backend.snapshotStore }) }
      },
    },
  ],
  [
    'FakeBackend without optional capabilities',
    {
      setup: async () => {
        const backend = new FakeBackend({ labels: owner('a'), capabilities: minimal })
        return { backend, other: new FakeBackend({ labels: owner('b'), capabilities: minimal, machines: backend.machines }) }
      },
    },
  ],
  [
    'smolvm on its fake SDK',
    {
      setup: async () => {
        const sdk = new FakeSdk()
        sdk.onExec = (name, command, options) => emulateCommand(command, options, sdk.vms.get(name)?.files)
        return {
          backend: new SmolvmBackend({ load: async () => sdk, labels: owner('a') }),
          other: new SmolvmBackend({ load: async () => sdk, labels: owner('b') }),
        }
      },
    },
  ],
]

for (const [name, target] of targets) {
  describe(`backend conformance: ${name}`, () => {
    for (const check of backendConformance(target)) it(check.name, (context) => check.run(context))
  })
}

// Real micro-VMs, on a Mac with Apple silicon or Linux with KVM. Run them with
// BLOBBY_SANDBOX_CONFORMANCE_SMOLVM=1 pnpm --filter @rwoll/blobby-sandbox exec vitest run conformance
describe.skipIf(!process.env.BLOBBY_SANDBOX_CONFORMANCE_SMOLVM)('backend conformance: smolvm', () => {
  const run = Math.random().toString(16).slice(2, 8)
  const target: ConformanceTarget = {
    setup: async () => ({
      backend: new SmolvmBackend({ labels: { ...owner(`conformance-${run}-a`), [KIND_LABEL]: 'conformance' } }),
      other: new SmolvmBackend({ labels: { ...owner(`conformance-${run}-b`), [KIND_LABEL]: 'conformance' } }),
    }),
  }
  for (const check of backendConformance(target)) it(check.name, (context) => check.run(context), 10 * 60_000)
})
