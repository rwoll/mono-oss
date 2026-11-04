import { Readable } from 'node:stream'
import {
  DELETE_AFTER_LABEL,
  IDEMPOTENCY_LABEL,
  SandboxError,
  type Capabilities,
  type CreateOptions,
  type NetworkPolicy,
  type NetworkPolicyKind,
  type ReadRange,
} from './backend.ts'

// Checks that every backend makes the same way, so they agree on what is valid and on the errors they give.

/** Label keys every provider accepts: a DNS-like prefix, optionally with one `/name` segment. */
export const LABEL_KEY_PATTERN = /^[a-z0-9.-]+(?:\/[a-z0-9._-]+)?$/
/** Label values every provider accepts. */
export const LABEL_VALUE_PATTERN = /^[A-Za-z0-9._:-]{0,63}$/

/** Every capability on, as the fake backend has by default. */
const all: Capabilities = {
  branch: true,
  publish: true,
  ports: true,
  gpu: true,
  networkPolicies: ['none', 'essential', 'internet', 'allow'],
  commandSandbox: true,
  streamingFiles: true,
  labels: true,
  stdin: true,
  snapshot: true,
}
export const ALL_CAPABILITIES: Readonly<Capabilities> = Object.freeze(all)

/** Fails with `invalid_options` unless every label is valid on every provider. */
export function checkLabels(labels: Record<string, string> = {}): Record<string, string> {
  for (const [key, value] of Object.entries(labels)) {
    if (!LABEL_KEY_PATTERN.test(key)) {
      throw new SandboxError('invalid_options', `"${key}" is not a valid label key. Use lowercase letters, digits, dots, and dashes, with an optional /name part.`)
    }
    if (typeof value !== 'string' || !LABEL_VALUE_PATTERN.test(value)) {
      throw new SandboxError('invalid_options', `The value of label ${key} is not valid. Use at most 63 letters, digits, dots, underscores, colons, and dashes.`)
    }
  }
  return { ...labels }
}

/** Whether `labels` has every one of `filter`. */
export function hasLabels(labels: Readonly<Record<string, string>>, filter: Readonly<Record<string, string>> = {}): boolean {
  return Object.entries(filter).every(([key, value]) => labels[key] === value)
}

/** The deletion deadline in a machine's labels, as an ISO 8601 UTC time, or null when it has none or it is not a time. */
export function deleteAfterOf(labels: Readonly<Record<string, string>>): string | null {
  const value = labels[DELETE_AFTER_LABEL]
  if (!value) return null
  const time = new Date(value)
  return Number.isNaN(time.getTime()) ? null : time.toISOString()
}

/** The part of `data` a read range asks for. Fails with `invalid_options` for a range that is not whole and non-negative. */
export function sliceRange(data: Buffer, range: ReadRange = {}): Buffer {
  const offset = range.offset ?? 0
  const length = range.length ?? Infinity
  if (!Number.isInteger(offset) || offset < 0 || !(length === Infinity || (Number.isInteger(length) && length >= 0))) {
    throw new SandboxError('invalid_options', 'A read range needs a whole, non-negative offset and length.')
  }
  return data.subarray(offset, Math.min(data.length, offset + length))
}

/** Bytes as a byte stream, in chunks of `size`. */
export function streamBytes(data: Buffer, size = 64 * 1024): Readable {
  return Readable.from(
    (function* () {
      for (let offset = 0; offset < data.length; offset += size) yield data.subarray(offset, offset + size)
    })(),
    { objectMode: false },
  )
}

/** All of a stream's bytes, for backends that can only write whole files. */
export async function collectStream(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const chunk of stream) parts.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array))
  return Buffer.concat(parts)
}

/** The environment variable that marks every process of one command, so `KILL_SCRIPT` can find them. */
export const EXEC_ID_ENV = 'BLOBBY_EXEC_ID'
/**
 * Kills every process whose environment has `BLOBBY_EXEC_ID=$1`: politely, then for good. It runs as the
 * command's own user, who may read its processes' environments without extra capabilities.
 */
export const KILL_SCRIPT =
  'kill_all() { for f in /proc/[0-9]*/environ; do case "$(tr "\\0" "\\n" < "$f" 2>/dev/null)" in *"$2=$1"*) p=${f#/proc/}; kill -s "$3" "${p%/environ}" 2>/dev/null;; esac; done; }; kill_all "$1" "$2" TERM; sleep 2; kill_all "$1" "$2" KILL'

export function networkPolicyKind(policy: NetworkPolicy = 'internet'): NetworkPolicyKind {
  return typeof policy === 'string' ? policy : 'allow'
}

/** Fails with `unsupported` when the backend lacks a capability. */
export function requireCapability(backend: string, capabilities: Capabilities, capability: Exclude<keyof Capabilities, 'networkPolicies'>, what: string): void {
  if (!capabilities[capability]) throw new SandboxError('unsupported', `The ${backend} backend can't ${what}.`)
}

/**
 * Checks create options against a backend's capabilities, and returns the labels to store: the caller's,
 * then the deletion deadline and the idempotency key, then the owner labels, which nothing overrides.
 * `enforced` is false when the machine runs unrestricted under `allowUnenforcedNetwork`.
 */
export function checkCreate(
  backend: string,
  capabilities: Capabilities,
  options: Omit<CreateOptions, 'image'>,
  owner: Readonly<Record<string, string>>,
): { labels: Record<string, string>; network: NetworkPolicy; enforced: boolean } {
  if (options.resources?.gpu) requireCapability(backend, capabilities, 'gpu', 'give machines the host GPU')
  if (options.ports?.length) requireCapability(backend, capabilities, 'ports', 'publish ports at create')
  if (options.commandSandbox) requireCapability(backend, capabilities, 'commandSandbox', "run VS Code's command sandbox")
  if (options.branchable) requireCapability(backend, capabilities, 'branch', 'branch machines')
  if (options.deleteAfter !== undefined && Number.isNaN(options.deleteAfter.getTime())) {
    throw new SandboxError('invalid_options', 'deleteAfter is not a valid time.')
  }
  const labels = checkLabels(options.labels)
  if (options.deleteAfter) labels[DELETE_AFTER_LABEL] = options.deleteAfter.toISOString()
  if (options.idempotencyKey !== undefined) {
    if (!LABEL_VALUE_PATTERN.test(options.idempotencyKey) || !options.idempotencyKey) {
      throw new SandboxError('invalid_options', 'The idempotency key must be 1 to 63 letters, digits, dots, underscores, colons, and dashes.')
    }
    labels[IDEMPOTENCY_LABEL] = options.idempotencyKey
  }
  const network = options.network ?? 'internet'
  if (typeof network === 'object') {
    if (!Array.isArray(network.allow) || network.allow.some((host) => typeof host !== 'string' || !/^(?:\*\.)?[A-Za-z0-9.-]+$/.test(host))) {
      throw new SandboxError('invalid_options', 'A network allow list holds host names, or host names that start with *. for their subdomains.')
    }
  }
  const kind = networkPolicyKind(network)
  let enforced = true
  if (!capabilities.networkPolicies.includes(kind)) {
    if (!options.allowUnenforcedNetwork) {
      const can = capabilities.networkPolicies.length ? capabilities.networkPolicies.join(', ') : 'none'
      throw new SandboxError(
        'network_unenforceable',
        `The ${backend} backend can't enforce the ${kind} network policy (it enforces: ${can}). Ask for one it enforces, or, for local development only, allow it to run unrestricted.`,
      )
    }
    enforced = false
  }
  return { labels: { ...labels, ...owner }, network: enforced ? network : 'internet', enforced }
}
