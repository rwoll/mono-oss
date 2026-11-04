import { accessSync, constants } from 'node:fs'
import { SandboxError, type Backend } from './backend.ts'

/** The backends `--backend` and `BLOBBY_SANDBOX_BACKEND` can name. */
export const BACKEND_NAMES = ['smolvm', 'docker', 'azure'] as const
export type BackendName = (typeof BACKEND_NAMES)[number]

/** Where a backend choice came from: `--backend` or `connect({ backend })`, the environment, or this host. */
export type BackendSource = 'option' | 'environment' | 'default'

export interface BackendSelection {
  name: BackendName
  source: BackendSource
  /** Why, in a sentence, for `doctor`. */
  reason: string
}

/** What decides the default backend. Tests pass their own. */
export interface HostInfo {
  platform: NodeJS.Platform
  arch: string
  /** Whether `/dev/kvm` exists and this user can open it. Only Linux has it. */
  kvm: boolean
}

/** Why smolvm can or can't run on a host. */
export interface HostSupport {
  supported: boolean
  reason: string
}

export const BACKEND_ENV = 'BLOBBY_SANDBOX_BACKEND'

export function detectHost(): HostInfo {
  let kvm = false
  if (process.platform === 'linux') {
    try {
      accessSync('/dev/kvm', constants.R_OK | constants.W_OK)
      kvm = true
    } catch {
      kvm = false
    }
  }
  return { platform: process.platform, arch: process.arch, kvm }
}

/** smolvm runs on macOS on Apple silicon, and on Linux with a usable `/dev/kvm`. */
export function smolvmSupport(host: HostInfo = detectHost()): HostSupport {
  if (host.platform === 'darwin') {
    return host.arch === 'arm64'
      ? { supported: true, reason: 'This is macOS on Apple silicon, which runs smolvm.' }
      : { supported: false, reason: 'smolvm needs Apple silicon on macOS; this Mac has an Intel processor.' }
  }
  if (host.platform === 'linux') {
    return host.kvm
      ? { supported: true, reason: 'This is Linux with a usable /dev/kvm, which runs smolvm.' }
      : { supported: false, reason: 'smolvm needs /dev/kvm, which is missing here or which this user cannot open.' }
  }
  return { supported: false, reason: `smolvm needs macOS on Apple silicon or Linux with KVM, not ${host.platform}.` }
}

function checkName(name: string, from: string): BackendName {
  if ((BACKEND_NAMES as readonly string[]).includes(name)) return name as BackendName
  throw new SandboxError('unknown_backend', `${from} names an unknown backend, "${name}". Use one of: ${BACKEND_NAMES.join(', ')}.`)
}

/**
 * Picks the backend: the one asked for, else `BLOBBY_SANDBOX_BACKEND`, else smolvm when this host runs it
 * and Docker when it doesn't.
 */
export function selectBackend(options: { backend?: string; env?: NodeJS.ProcessEnv; host?: HostInfo } = {}): BackendSelection {
  if (options.backend) return { name: checkName(options.backend, '--backend'), source: 'option', reason: 'It was asked for with --backend.' }
  const fromEnv = (options.env ?? process.env)[BACKEND_ENV]
  if (fromEnv) return { name: checkName(fromEnv, BACKEND_ENV), source: 'environment', reason: `${BACKEND_ENV} is set to ${fromEnv}.` }
  const smolvm = smolvmSupport(options.host ?? detectHost())
  return smolvm.supported
    ? { name: 'smolvm', source: 'default', reason: smolvm.reason }
    : { name: 'docker', source: 'default', reason: `${smolvm.reason} Docker is the default here.` }
}

/**
 * Makes a backend by name. Each backend loads only when it is chosen, so its dependencies, such as
 * `smolmachines` for smolvm and `@azure/containerapps-sandbox` for Azure, are needed only by the people
 * who use it. Docker needs none: it talks to the daemon's socket.
 */
export async function createBackend(name: string, options: { env?: NodeJS.ProcessEnv; labels?: Record<string, string> } = {}): Promise<Backend> {
  // Owner labels other than this host's are for reading only, such as `list --all` with `labels: {}`.
  const labels = options.labels ? { labels: options.labels } : {}
  switch (checkName(name, 'The backend')) {
    case 'smolvm': {
      const { SmolvmBackend } = await import('./smolvm.ts')
      return new SmolvmBackend({ env: options.env, ...labels })
    }
    case 'docker': {
      const { DockerBackend } = await import('./docker/index.ts')
      return new DockerBackend({ env: options.env, ...labels })
    }
    case 'azure': {
      const { AzureBackend } = await import('./azure/index.ts')
      return new AzureBackend({ env: options.env, ...labels })
    }
  }
}
