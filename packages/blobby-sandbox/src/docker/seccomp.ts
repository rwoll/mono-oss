import { readFile } from 'node:fs/promises'

/**
 * The package's copy of Docker's default seccomp profile, unchanged, from moby/profiles (Apache-2.0; its
 * license is next to it). The command sandbox's profile is built from it at create time.
 */
export const SECCOMP_PROFILE_URL = new URL('../../seccomp/docker-default.json', import.meta.url)

/** Where the copy comes from. */
export const SECCOMP_PROFILE_SOURCE = 'https://github.com/moby/profiles/blob/6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef/seccomp/default.json'

/**
 * Syscalls that bubblewrap, unshare, and nsenter use to create and enter user, mount, network, and other
 * namespaces. Docker's default profile allows them only in containers with CAP_SYS_ADMIN, which machines
 * never get. Allowing them lets an unprivileged process act inside the namespaces it creates; everywhere
 * else the kernel still requires the capability, so root in a machine still cannot mount anything.
 */
export const NAMESPACE_SYSCALLS = Object.freeze([
  'clone',
  'clone3',
  'unshare',
  'setns',
  'mount',
  'umount',
  'umount2',
  'pivot_root',
  'mount_setattr',
  'move_mount',
  'open_tree',
  'fsopen',
  'fsconfig',
  'fsmount',
  'fspick',
  'sethostname',
  'setdomainname',
])

/** The device slirp4netns uses to give a sandboxed command network access. */
export const TUN_DEVICE = '/dev/net/tun'

interface SeccompRule {
  names: string[]
  action: string
  [key: string]: unknown
}

/**
 * Docker's default seccomp profile with only `NAMESPACE_SYSCALLS` changed: every rule about them is
 * removed, including the ones that limit clone's flags and refuse clone3, and one rule allows them.
 */
export function sandboxSeccompProfile(base: string): string {
  const profile = JSON.parse(base) as { syscalls?: SeccompRule[] }
  if (!Array.isArray(profile.syscalls)) throw new Error('Not a seccomp profile: it has no syscalls list.')
  const namespaced = new Set<string>(NAMESPACE_SYSCALLS)
  const syscalls = profile.syscalls.flatMap((rule) => {
    const names = rule.names.filter((name) => !namespaced.has(name))
    if (names.length === rule.names.length) return [rule]
    return names.length ? [{ ...rule, names }] : []
  })
  syscalls.push({ names: [...NAMESPACE_SYSCALLS], action: 'SCMP_ACT_ALLOW' })
  return JSON.stringify({ ...profile, syscalls })
}

let cached: Promise<string> | undefined

/** The command sandbox's profile, read from the package once. */
export function loadSandboxProfile(): Promise<string> {
  cached ??= readFile(SECCOMP_PROFILE_URL, 'utf8')
    .then(sandboxSeccompProfile)
    .catch((error: unknown) => {
      cached = undefined
      throw error
    })
  return cached
}
