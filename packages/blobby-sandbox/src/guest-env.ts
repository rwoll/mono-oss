import { SandboxError } from './backend.ts'

/**
 * No host environment reaches a sandbox. Backends start guest commands with only what the caller passes,
 * and the engine passes only the desktop session's variables and what its own caller passes. Credentials
 * are refused even then: sandboxes get secrets only through a feature's sealed callbacks.
 */

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/
/** Credentials by name. */
const NAMES = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'SSH_ASKPASS',
  'GIT_ASKPASS',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'DOCKER_AUTH_CONFIG',
  'DOCKER_CONFIG',
  'KUBECONFIG',
  'NETRC',
])
/** Families of credentials and of settings that bring credentials along, by prefix. */
const PREFIXES = ['GH_', 'GITHUB_', 'COPILOT_', 'AZURE_', 'ARM_', 'AWS_', 'GCLOUD_', 'CLOUDSDK_', 'GIT_CONFIG_', 'GIT_CREDENTIAL', 'NPM_CONFIG_', 'OP_', 'VAULT_', 'BLOBBY_SANDBOX_']
/** Anything that names itself a credential. */
const PARTS = ['TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'API_KEY', 'APIKEY', 'PRIVATE_KEY', 'ACCESS_KEY', 'CREDENTIAL']

/** Whether a variable is a host credential, or brings one along, so it never goes into a sandbox. */
export function isCredentialEnv(name: string): boolean {
  const upper = name.toUpperCase()
  return NAMES.has(upper) || PREFIXES.some((prefix) => upper.startsWith(prefix)) || PARTS.some((part) => upper.includes(part))
}

/**
 * Checks the environment a caller passes for a guest command: valid names and values, and no
 * credentials. Fails with `env_blocked`, naming the variable but never its value.
 */
export function checkGuestEnv(env: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(env ?? {})) {
    if (!NAME.test(name)) throw new SandboxError('invalid_options', `"${name}" isn't a valid environment variable name.`)
    if (typeof value !== 'string' || value.includes('\0')) throw new SandboxError('invalid_options', `The value of ${name} must be text without NUL characters.`)
    if (isCredentialEnv(name)) {
      throw new SandboxError(
        'env_blocked',
        `blobby-sandbox never passes host credentials into a sandbox, so it refuses ${name}. Sandboxes get secrets only through a feature's sealed callbacks.`,
      )
    }
    out[name] = value
  }
  return out
}
