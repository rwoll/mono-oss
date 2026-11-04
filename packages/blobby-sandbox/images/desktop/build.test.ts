import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCommand, contentDigest, contentHash, IMAGE_DIR, imageFiles, imageTags, ImageError, npmRegistry, PLATFORMS } from './build.ts'
import { commandSandboxProfile, DOCKER_PROFILE_SHA256, dockerDefaultProfile, NAMESPACE_SYSCALLS } from './seccomp/command-sandbox.ts'
import { CHECKS, mp4Boxes, parseEnv, pngSize } from './smoke.ts'
import { afterAll, describe, expect, test } from 'vitest'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const read = (path: string) => readFile(join(ROOT, path), 'utf8')
const sha256 = (data: string) => createHash('sha256').update(data).digest('hex')
const scratch: string[] = []
afterAll(() => Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true }))))

async function copyOfImage() {
  const dir = await mkdtemp(join(tmpdir(), 'blobby-desktop-test-'))
  scratch.push(dir)
  await cp(IMAGE_DIR, dir, { recursive: true })
  return dir
}

/** The text of a `cat >path <<'EOF'` heredoc in a shell script. */
function heredoc(script: string, path: string): string {
  const start = script.indexOf(`cat >${path} <<'EOF'\n`)
  expect(start, `no heredoc for ${path}`).not.toBe(-1)
  const body = script.slice(script.indexOf('\n', start) + 1)
  return body.slice(0, body.indexOf('\nEOF\n') + 1)
}

describe('content hash', () => {
  test('covers every file in the folder, sorted', async () => {
    const files = await imageFiles()
    for (const file of ['Dockerfile', '.dockerignore', 'README.md', 'build.ts', 'smoke.ts', 'seccomp/LICENSE', 'seccomp/docker-default.json']) {
      expect(files.includes(file), file).toBeTruthy()
    }
    expect(files).toEqual([...files].sort())
  })

  test('changes with any file, its executable bit, or a new file, and ignores .DS_Store', async () => {
    const dir = await copyOfImage()
    const before = await contentDigest(dir)
    expect(await contentDigest(dir)).toBe(before)
    expect(await contentHash(dir)).toBe(before.slice(0, 12))

    await writeFile(join(dir, '.DS_Store'), 'junk')
    expect(await contentDigest(dir)).toBe(before)

    await writeFile(join(dir, 'README.md'), `${await readFile(join(dir, 'README.md'), 'utf8')}\n`)
    const edited = await contentDigest(dir)
    expect(edited).not.toBe(before)

    const launcher = join(dir, 'rootfs/usr/local/bin/code-insiders')
    await chmod(launcher, 0o644)
    const modeChanged = await contentDigest(dir)
    expect(modeChanged).not.toBe(edited)

    await writeFile(join(dir, 'rootfs/new-file'), '')
    expect(await contentDigest(dir)).not.toBe(modeChanged)
  })
})

describe('build command', () => {
  const base = { dir: '/images/desktop', hash: 'abcdef123456', platform: 'linux/arm64', native: true }

  test('builds for the host with docker build, tagged by hash and latest, labelled', () => {
    const { args, tags } = buildCommand({ ...base, revision: '0'.repeat(40) })
    expect(tags).toEqual(['blobby-desktop:abcdef123456', 'blobby-desktop:latest'])
    expect(args[0]).toBe('build')
    expect(args.at(-1)).toBe('/images/desktop')
    const pairs = (flag: string) => args.flatMap((arg, index) => (args[index - 1] === flag ? [arg] : []))
    expect(pairs('--tag')).toEqual(tags)
    expect(pairs('--platform')).toEqual(['linux/arm64'])
    expect(pairs('--secret')).toEqual(['id=npm-registry,env=BLOBBY_NPM_REGISTRY'])
    expect(pairs('--build-arg')).toEqual(['BLOBBY_IMAGE_HASH=abcdef123456'])
    const labels = pairs('--label')
    for (const label of [
      'blobby.dev/image=desktop',
      'org.opencontainers.image.source=https://github.com/rwoll/mono-oss',
      'org.opencontainers.image.licenses=MIT',
      'org.opencontainers.image.version=abcdef123456',
      `org.opencontainers.image.revision=${'0'.repeat(40)}`,
    ]) {
      expect(labels.includes(label), label).toBeTruthy()
    }
    expect(!args.some((arg) => /registry\.npmjs|npmrc/.test(arg)), 'the registry never appears in the arguments').toBeTruthy()
  })

  test('uses buildx and loads the result when it exports a cache or picks a builder', () => {
    const { args } = buildCommand({ ...base, builder: 'ci', cacheFrom: ['type=local,src=/c'], cacheTo: ['type=local,dest=/d,mode=max'], noCache: true, pull: true })
    expect(args.slice(0, 5)).toEqual(['buildx', 'build', '--load', '--builder', 'ci'])
    for (const arg of ['--no-cache', '--pull', 'type=local,src=/c', 'type=local,dest=/d,mode=max']) expect(args.includes(arg), arg).toBeTruthy()
  })

  test('tags another platform than the host\'s by architecture only, so it never replaces latest', () => {
    expect(imageTags('abcdef123456', 'linux/amd64', false)).toEqual(['blobby-desktop:abcdef123456-amd64'])
    expect(buildCommand({ ...base, platform: 'linux/amd64', native: false }).tags).toEqual(['blobby-desktop:abcdef123456-amd64'])
  })

  test('refuses other platforms', () => {
    expect(PLATFORMS).toEqual(['linux/amd64', 'linux/arm64'])
    expect(() => buildCommand({ ...base, platform: 'linux/riscv64' })).toThrow(expect.objectContaining({ code: 'unsupported_platform' }))
    expect(() => buildCommand({ ...base, platform: 'linux/riscv64' })).toThrow(ImageError)
  })
})

describe('npm registry', () => {
  test('takes the environment, then the .npmrc registry line, then the public registry', () => {
    const npmrc = '@rwoll:registry=https://scoped.example.com/\nregistry=https://feed.example.com/npm/\nignore-scripts=true\n'
    expect(npmRegistry({ env: { pnpm_config_registry: 'https://a.example.com/' }, npmrc })).toBe('https://a.example.com/')
    expect(npmRegistry({ env: { npm_config_registry: 'https://b.example.com/' }, npmrc })).toBe('https://b.example.com/')
    expect(npmRegistry({ env: {}, npmrc })).toBe('https://feed.example.com/npm/')
    expect(npmRegistry({ env: {}, npmrc: '@rwoll:registry=https://scoped.example.com/\n' })).toBe('https://registry.npmjs.org/')
    expect(npmRegistry({ env: {} })).toBe('https://registry.npmjs.org/')
  })

  test('accepts only https URLs', () => {
    expect(() => npmRegistry({ env: { npm_config_registry: 'http://insecure.example.com/' } })).toThrow(expect.objectContaining({ code: 'usage' }))
  })
})

const dockerfile = await readFile(join(IMAGE_DIR, 'Dockerfile'), 'utf8')
const arg = (name: string) => new RegExp(`^ARG ${name}=(\\S+)$`, 'm').exec(dockerfile)?.[1]

describe('Dockerfile', () => {
  test('starts from ubuntu:24.04 pinned by digest, and labels that base', () => {
    const digest = /^FROM ubuntu:24\.04@(sha256:[a-f0-9]{64})$/m.exec(dockerfile)?.[1]
    expect(digest, 'FROM ubuntu:24.04@sha256:<digest>').toBeTruthy()
    expect(dockerfile.includes(`org.opencontainers.image.base.digest=${digest}`)).toBeTruthy()
  })

  test('installs the same Node.js as the runtime\'s setup.sh, checked by SHA-256', async () => {
    const setup = await read('runtime/setup.sh')
    expect(arg('NODE_VERSION')).toBe(/^node_version=(\S+)$/m.exec(setup)?.[1])
    expect(arg('NODE_SHA256_AMD64')).toBe(/amd64\) node_arch=x64; node_sum=([a-f0-9]{64})/.exec(setup)?.[1])
    expect(arg('NODE_SHA256_ARM64')).toBe(/arm64\) node_arch=arm64; node_sum=([a-f0-9]{64})/.exec(setup)?.[1])
    expect(dockerfile).toMatch(/sha256sum -c -/)
  })

  test('installs the playwright-core that blobby-sandbox depends on, checked against the lockfile\'s SHA-512', async () => {
    const manifest = JSON.parse(await read('package.json'))
    const version = arg('PLAYWRIGHT_CORE_VERSION') ?? ''
    expect(version).toBe(manifest.dependencies['playwright-core'])
    const integrity = new RegExp(`^  playwright-core@${version.replaceAll('.', '\\.')}:\\n    resolution: \\{integrity: sha512-([A-Za-z0-9+/=]+)\\}`, 'm').exec(await read('../../pnpm-lock.yaml'))?.[1]
    expect(integrity, 'the lockfile has playwright-core').toBeTruthy()
    expect(arg('PLAYWRIGHT_CORE_SHA512')).toBe(Buffer.from(integrity ?? '', 'base64').toString('hex'))
    expect(dockerfile).toMatch(/sha512sum -c -/)
  })

  test('never hard-codes an npm registry: it comes in as a build secret', () => {
    const instructions = dockerfile.replace(/^\s*#.*$/gm, '')
    expect(instructions).not.toMatch(/registry\.npmjs\.org|npmjs\.com|\.npmrc|npm install|pnpm (install|add)|ARG NPM_REGISTRY/)
    expect(dockerfile).toMatch(/RUN --mount=type=secret,id=npm-registry /)
  })

  test('installs no proprietary app', () => {
    const installs = dockerfile.split(/^RUN /m).filter((step) => step.includes('apt-get install'))
    expect(installs.length >= 2).toBeTruthy()
    for (const step of installs) expect(step).not.toMatch(/code-insiders|google-chrome|chromium/)
    expect(dockerfile).not.toMatch(/sources\.list\.d/)
  })

  test('runs tini as PID 1 and only waits by default', () => {
    expect(dockerfile).toMatch(/^ENTRYPOINT \["\/usr\/bin\/tini", "-g", "--"\]$/m)
    expect(dockerfile).toMatch(/^CMD \["\/usr\/local\/bin\/blobby-desktop", "idle"\]$/m)
    expect(dockerfile).toMatch(/^EXPOSE 6901$/m)
    expect(dockerfile).not.toMatch(/^USER /m)
  })
})

describe('files in the image', () => {
  test('match what the runtime\'s setup.sh writes on other backends', async () => {
    const setup = await read('runtime/setup.sh')
    const files: [string, string][] = [
      ['/etc/blobby/system-bus.conf', 'rootfs/etc/blobby/system-bus.conf'],
      ['/etc/dconf/db/local.d/00-blobby', 'rootfs/etc/dconf/db/local.d/00-blobby'],
      ['/etc/xdg/mimeapps.list', 'rootfs/etc/xdg/mimeapps.list'],
    ]
    for (const [path, inImage] of files) {
      expect(await readFile(join(IMAGE_DIR, inImage), 'utf8'), path).toBe(heredoc(setup, path))
    }
    expect(setup.includes(`echo '${(await readFile(join(IMAGE_DIR, 'rootfs/etc/sudoers.d/blobby'), 'utf8')).trim()}' >/etc/sudoers.d/blobby`)).toBeTruthy()
  })

  test('scripts are executable and pass a syntax check', async () => {
    for (const folder of ['rootfs/usr/local/bin', 'rootfs/opt/blobby/image/bin']) {
      for (const name of await readdir(join(IMAGE_DIR, folder))) {
        const path = join(IMAGE_DIR, folder, name)
        expect(((await stat(path)).mode & 0o111) !== 0, `${folder}/${name} is executable`).toBeTruthy()
        const shell = /^#!\/bin\/(ba)?sh\n/.exec(await readFile(path, 'utf8'))?.[1] ? 'bash' : 'sh'
        const check = spawnSync(shell, ['-n', path], { encoding: 'utf8' })
        expect(check.status, `${folder}/${name}: ${check.stderr}`).toBe(0)
      }
    }
  })

  test('the inactive apt sources name the vendors\' signed repositories', async () => {
    const vscode = await readFile(join(IMAGE_DIR, 'rootfs/opt/blobby/image/apt/vscode.sources'), 'utf8')
    expect(vscode).toMatch(/^URIs: https:\/\/packages\.microsoft\.com\/repos\/code$/m)
    expect(vscode).toMatch(/^Signed-By: \/usr\/share\/keyrings\/microsoft\.gpg$/m)
    const chrome = await readFile(join(IMAGE_DIR, 'rootfs/opt/blobby/image/apt/google-chrome.sources'), 'utf8')
    expect(chrome).toMatch(/^URIs: https:\/\/dl\.google\.com\/linux\/chrome\/deb\/$/m)
    expect(chrome).toMatch(/^Signed-By: \/usr\/share\/keyrings\/google-chrome\.gpg$/m)
  })
})

describe('seccomp', () => {
  test('docker-default.json and its license are unchanged copies', async () => {
    expect(sha256(await dockerDefaultProfile())).toBe(DOCKER_PROFILE_SHA256)
    const license = await readFile(join(IMAGE_DIR, 'seccomp/LICENSE'), 'utf8')
    expect(license).toMatch(/Apache License\s+Version 2\.0, January 2004/)
  })

  test('the command-sandbox profile allows only the namespace syscalls on top of Docker\'s', async () => {
    const base = JSON.parse(await dockerDefaultProfile())
    const profile = JSON.parse(commandSandboxProfile(JSON.stringify(base)))
    expect(profile.defaultAction).toBe(base.defaultAction)
    const allowed = profile.syscalls.at(-1)
    expect(allowed).toEqual({ names: [...NAMESPACE_SYSCALLS], action: 'SCMP_ACT_ALLOW' })
    for (const rule of profile.syscalls.slice(0, -1)) {
      for (const name of rule.names) expect(!NAMESPACE_SYSCALLS.includes(name), `${name} has no other rule`).toBeTruthy()
    }
    const others = (rules: { names: string[]; action: string }[]) => rules.flatMap((rule) => rule.names.filter((name) => !NAMESPACE_SYSCALLS.includes(name)).map((name) => `${rule.action}:${name}`)).sort()
    expect(others(profile.syscalls)).toEqual(others(base.syscalls))
  })
})

describe('smoke test helpers', () => {
  test('pngSize reads a PNG header and refuses anything else', () => {
    const header = Buffer.alloc(24)
    Buffer.from('89504e470d0a1a0a', 'hex').copy(header)
    header.write('IHDR', 12)
    header.writeUInt32BE(1280, 16)
    header.writeUInt32BE(800, 20)
    expect(pngSize(header)).toEqual({ width: 1280, height: 800 })
    expect(() => pngSize(Buffer.from('not a png at all, really'))).toThrow()
  })

  test('mp4Boxes needs ftyp first, and moov and mdat', () => {
    const box = (type: string, size = 16) => {
      const data = Buffer.alloc(size)
      data.writeUInt32BE(size)
      data.write(type, 4, 'latin1')
      return data
    }
    expect(mp4Boxes(Buffer.concat([box('ftyp'), box('moov'), box('mdat', 32)]))).toEqual(['ftyp', 'moov', 'mdat'])
    expect(() => mp4Boxes(Buffer.concat([box('moov'), box('mdat')]))).toThrow(/not an MP4/)
    expect(() => mp4Boxes(Buffer.from('garbage that is not a box'))).toThrow(/malformed|not an MP4/)
  })

  test('parseEnv reads the runtime\'s session.env', async () => {
    const env = parseEnv(await read('runtime/session.env'))
    expect(env.DISPLAY).toBe(':1')
    expect(env.XDG_RUNTIME_DIR).toBe('/run/user/1000')
  })

  test('checks have unique names and cover the image contract', () => {
    const names = CHECKS.map((check) => check.name)
    expect(new Set(names).size).toBe(names.length)
    for (const name of ['image', 'session', 'screenshot', 'accessibility', 'viewer', 'command-sandbox', 'recording']) expect(names.includes(name), name).toBeTruthy()
  })
})
