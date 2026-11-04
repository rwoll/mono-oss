import { DockerBackend } from '../src/docker/index.ts'
import { MANAGER_LABEL } from '../src/labels.ts'

/** Ubuntu 24.04, pinned by the digest of its multi-platform index. */
export const UBUNTU_IMAGE = 'ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac'
/** Marks everything one test run makes, so it can be swept up whatever happens. */
export const RUN_LABEL = 'blobby.dev/test-run'

/** The owner labels of one backend in a test run. */
export function runOwner(run: string, id: string): Record<string, string> {
  return { [MANAGER_LABEL]: `standalone:test-${run}-${id}`, [RUN_LABEL]: run }
}

/** Removes every machine and snapshot a run made, through a backend whose only owner label is the run's. */
export async function sweep(run: string, options: ConstructorParameters<typeof DockerBackend>[0] = {}): Promise<void> {
  const sweeper = new DockerBackend({ ...options, labels: { [RUN_LABEL]: run } })
  for (const machine of await sweeper.list()) await sweeper.remove(machine.name)
  for (const snapshot of await sweeper.snapshots()) await sweeper.removeSnapshot(snapshot.id)
}
