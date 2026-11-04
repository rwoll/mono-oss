// The seccomp profile for sandboxes with the command sandbox (bubblewrap): Docker's default profile,
// docker-default.json, with only the namespace syscalls opened up. docker-default.json is an unchanged
// copy of moby/profiles' seccomp/default.json (Apache-2.0, see LICENSE in this folder) at
// https://github.com/moby/profiles/blob/6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef/seccomp/default.json
import { readFile } from 'node:fs/promises'

/** Where docker-default.json comes from. */
export const DOCKER_PROFILE_SOURCE = 'https://github.com/moby/profiles/blob/6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef/seccomp/default.json'
/** SHA-256 of docker-default.json, so a changed copy fails tests instead of shipping. */
export const DOCKER_PROFILE_SHA256 = '6416b47770785a41ac59073cdc77d9fe98517df2799dc83ef207e622de3053f6'

/**
 * Syscalls that bubblewrap, unshare, and nsenter use to create and enter user, mount, network, and other
 * namespaces. Docker's default profile allows them only to containers with CAP_SYS_ADMIN, which sandboxes
 * never get. Allowing them lets an unprivileged process act inside namespaces it creates; everywhere else
 * the kernel still requires the capability, so root in the sandbox still can't mount anything.
 */
export const NAMESPACE_SYSCALLS: readonly string[] = Object.freeze([
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

/** The device slirp4netns uses to give sandboxed commands network access. */
export const TUN_DEVICE = '/dev/net/tun'

/** Docker's default profile, as text. */
export async function dockerDefaultProfile(): Promise<string> {
  return readFile(new URL('./docker-default.json', import.meta.url), 'utf8')
}

/**
 * Docker's default profile with only NAMESPACE_SYSCALLS changed: every rule about them is removed,
 * including the ones that limit clone's flags and refuse clone3, and one rule allows them unconditionally.
 */
interface SyscallRule {
  names: string[]
  action: string
  [field: string]: unknown
}

export function commandSandboxProfile(base: string): string {
  const profile = JSON.parse(base) as { syscalls?: unknown }
  if (!Array.isArray(profile.syscalls)) throw new Error('Not a seccomp profile: it has no syscalls list.')
  const namespaced = new Set(NAMESPACE_SYSCALLS)
  const syscalls = (profile.syscalls as SyscallRule[]).flatMap((rule): SyscallRule[] => {
    const names = rule.names.filter((name) => !namespaced.has(name))
    if (names.length === rule.names.length) return [rule]
    return names.length ? [{ ...rule, names }] : []
  })
  syscalls.push({ names: [...NAMESPACE_SYSCALLS], action: 'SCMP_ACT_ALLOW' })
  return JSON.stringify({ ...profile, syscalls })
}
