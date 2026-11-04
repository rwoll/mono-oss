// Builds the desktop image for the Docker host's architecture, tagged blobby-desktop:<content hash> and
// blobby-desktop:latest, from the build files the package ships in images/desktop. The content hash
// covers the build context: the Dockerfile, .dockerignore, and rootfs/. See images/desktop/README.md.
// `blobby-sandbox image build` runs it, and so does `node images/desktop/build.ts` in a checkout.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

export const IMAGE_REPOSITORY = 'blobby-desktop'
/** The image's build files, next to `src/` and `dist/`. */
export const IMAGE_DIR = fileURLToPath(new URL('../images/desktop/', import.meta.url))
/** The build context, as .dockerignore says: what the content hash covers, and what the package ships. */
export const CONTEXT: readonly string[] = Object.freeze(['.dockerignore', 'Dockerfile', 'rootfs'])
export const IMAGE_SOURCE = 'https://github.com/rwoll/mono-oss'
export const PLATFORMS: readonly string[] = Object.freeze(['linux/amd64', 'linux/arm64'])
/** The build reads the npm registry from this build secret, so its host stays out of the image's history. */
export const REGISTRY_SECRET = 'npm-registry'
const REGISTRY_ENV = 'BLOBBY_NPM_REGISTRY'
const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'
/** Files that editors and file managers leave behind. Everything else counts. */
const IGNORED = new Set(['.DS_Store'])
const LOG_LINES = 60

/** An expected failure, with a stable code and a message that says what to do. */
export class ImageError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ImageError'
    this.code = code
  }
}

/** The build context's files, as sorted `/`-separated paths relative to `dir`. */
export async function imageFiles(dir: string = IMAGE_DIR): Promise<string[]> {
  const files: string[] = []
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (IGNORED.has(entry.name)) continue
      const path = join(folder, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) files.push(relative(dir, path).split(sep).join('/'))
      else throw new ImageError('invalid_image_files', `${path} is not a regular file. The image's folder holds only files and folders.`)
    }
  }
  for (const name of CONTEXT) {
    const path = join(dir, name)
    const info = await stat(path).catch(() => null)
    if (!info) throw new ImageError('image_files_missing', `${path} is missing. Reinstall @rwoll/blobby-sandbox.`)
    if (info.isDirectory()) await walk(path)
    else files.push(name)
  }
  return files.sort()
}

/** SHA-256 over every file's path, executable bit, and contents. */
export async function contentDigest(dir: string = IMAGE_DIR): Promise<string> {
  const digest = createHash('sha256')
  for (const file of await imageFiles(dir)) {
    const path = join(dir, file)
    const executable = ((await stat(path)).mode & 0o111) !== 0
    digest.update(file).update('\0').update(executable ? 'x' : '-').update('\0').update(await readFile(path)).update('\0')
  }
  return digest.digest('hex')
}

/** The first 12 hex digits of `contentDigest`: the image's tag. */
export async function contentHash(dir: string = IMAGE_DIR): Promise<string> {
  return (await contentDigest(dir)).slice(0, 12)
}

/** The tags a build gets: `<hash>` and `latest` for the host's platform, `<hash>-<arch>` for another one. */
export function imageTags(hash: string, platform: string, native: boolean, repository: string = IMAGE_REPOSITORY): string[] {
  return native ? [`${repository}:${hash}`, `${repository}:latest`] : [`${repository}:${hash}-${platform.split('/')[1] ?? platform}`]
}

/**
 * The npm registry playwright-core comes from: `pnpm_config_registry` or `npm_config_registry`, then the
 * `registry=` line of the repository's .npmrc, then the public registry. Only that line is read.
 */
export function npmRegistry({ env = process.env, npmrc }: { env?: NodeJS.ProcessEnv; npmrc?: string | undefined } = {}): string {
  const fromEnv = env.pnpm_config_registry || env.npm_config_registry || env.NPM_CONFIG_REGISTRY
  const fromFile = npmrc ? /^[ \t]*registry[ \t]*=[ \t]*(\S+)[ \t]*$/m.exec(npmrc)?.[1] : undefined
  const registry = fromEnv || fromFile || DEFAULT_REGISTRY
  if (!/^https:\/\/[^\s/]+\/\S*$/.test(registry)) {
    throw new ImageError('usage', 'The npm registry must be an https:// URL. Check pnpm_config_registry, npm_config_registry, and the repository\'s .npmrc.')
  }
  return registry
}

export interface BuildCommandOptions {
  dir: string
  hash: string
  platform: string
  native: boolean
  revision?: string | undefined
  noCache?: boolean | undefined
  pull?: boolean | undefined
  builder?: string | undefined
  cacheFrom?: string[] | undefined
  cacheTo?: string[] | undefined
  repository?: string
}

/** The `docker` arguments for a build. Never a shell string. */
export function buildCommand(options: BuildCommandOptions): { args: string[]; tags: string[] } {
  const { dir, hash, platform, native, revision, noCache, pull, builder, cacheFrom = [], cacheTo = [], repository = IMAGE_REPOSITORY } = options
  if (!PLATFORMS.includes(platform)) throw new ImageError('unsupported_platform', `The image is built for ${PLATFORMS.join(' and ')}, not ${platform}.`)
  const tags = imageTags(hash, platform, native, repository)
  const labels = {
    'blobby.dev/image': 'desktop',
    'org.opencontainers.image.title': 'Blobby desktop',
    'org.opencontainers.image.source': IMAGE_SOURCE,
    'org.opencontainers.image.licenses': 'MIT',
    'org.opencontainers.image.version': hash,
    ...(revision ? { 'org.opencontainers.image.revision': revision } : {}),
  }
  // Exporting a cache or picking a builder needs buildx; `--load` puts the result in Docker's images.
  const buildx = Boolean(builder) || cacheFrom.length > 0 || cacheTo.length > 0
  const args = buildx ? ['buildx', 'build', '--load'] : ['build']
  if (builder) args.push('--builder', builder)
  args.push('--platform', platform, '--progress', 'plain', '--secret', `id=${REGISTRY_SECRET},env=${REGISTRY_ENV}`)
  args.push('--build-arg', `BLOBBY_IMAGE_HASH=${hash}`)
  for (const tag of tags) args.push('--tag', tag)
  for (const [key, value] of Object.entries(labels)) args.push('--label', `${key}=${value}`)
  if (noCache) args.push('--no-cache')
  if (pull) args.push('--pull')
  for (const spec of cacheFrom) args.push('--cache-from', spec)
  for (const spec of cacheTo) args.push('--cache-to', spec)
  args.push(dir)
  return { args, tags }
}

interface RunOptions {
  env?: NodeJS.ProcessEnv | undefined
  signal?: AbortSignal | undefined
  onStderrLine?: ((line: string) => void) | undefined
  onStdoutLine?: ((line: string) => void) | undefined
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/** Runs a command without a shell. Resolves with its exit code and output, or rejects if it can't start. */
function run(command: string, args: string[], { env, signal, onStderrLine, onStdoutLine }: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, signal, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const lines = (callback: ((line: string) => void) | undefined) => {
      let pending = ''
      return (chunk: string) => {
        if (!callback) return
        pending += chunk
        const parts = pending.split(/\r?\n/)
        pending = parts.pop() ?? ''
        for (const line of parts) callback(line)
      }
    }
    const outLines = lines(onStdoutLine)
    const errLines = lines(onStderrLine)
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk
      outLines(chunk)
    })
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk
      errLines(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      outLines('\n')
      errLines('\n')
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

/** The Docker server's architecture, as a platform. */
export async function dockerPlatform({ docker = 'docker', env = process.env }: { docker?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  let result: RunResult
  try {
    result = await run(docker, ['version', '--format', '{{.Server.Arch}}'], { env })
  } catch (error) {
    throw new ImageError('docker_unavailable', `The docker CLI didn't run (${(error as Error).message}). Install Docker Desktop or Docker Engine.`, { cause: error })
  }
  const arch = result.stdout.trim()
  if (result.code !== 0 || !arch) {
    throw new ImageError('docker_unavailable', `Docker isn't running: ${result.stderr.trim().split('\n').at(-1) || 'no server'}. Start Docker and try again.`)
  }
  return `linux/${arch}`
}

/** The checkout's commit, when the build files are tracked in one; never an installing project's. */
async function gitRevision(dir: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const tracked = await run('git', ['-C', dir, 'ls-files', '--error-unmatch', 'Dockerfile'], { env })
    if (tracked.code !== 0) return undefined
    const result = await run('git', ['-C', dir, 'rev-parse', 'HEAD'], { env })
    return result.code === 0 ? result.stdout.trim() : undefined
  } catch {
    return undefined
  }
}

/** Turns BuildKit's plain progress into short lines: each Dockerfile step as it starts, and when it ends. */
function stepReader(onProgress: (message: string) => void): (line: string) => void {
  const steps = new Map<string, string>()
  return (line) => {
    const start = /^#(\d+) \[(?:[^\]]* )?(\d+\/\d+)\] (.*)$/.exec(line)
    if (start && !steps.has(start[1]!)) {
      const [, id = '', step = '', text = ''] = start
      steps.set(id, step)
      onProgress(`[${step}] ${text.length > 100 ? `${text.slice(0, 99)}…` : text}`)
      return
    }
    const end = /^#(\d+) (CACHED|DONE ([\d.]+)s)$/.exec(line)
    const step = end && steps.get(end[1]!)
    if (end && step) onProgress(end[2] === 'CACHED' ? `[${step}] cached` : `[${step}] done in ${end[3]} s`)
  }
}

export interface BuildOptions {
  /** The image's build files. Default: the package's `images/desktop`. */
  dir?: string
  /** `linux/amd64` or `linux/arm64`. Default: the Docker host's. */
  platform?: string | undefined
  /** The npm registry for playwright-core. Default: see `npmRegistry`. */
  registry?: string
  /** Path of the .npmrc to read the registry from. Default: the repository's. */
  npmrc?: string
  /** Build every step again. */
  noCache?: boolean | undefined
  /** Pull the base image again. */
  pull?: boolean | undefined
  /** A buildx builder, for example one that can export caches. */
  builder?: string | undefined
  /** `--cache-from` specs (buildx). */
  cacheFrom?: string[] | undefined
  /** `--cache-to` specs (buildx). */
  cacheTo?: string[] | undefined
  /** Return the command instead of running it. */
  dryRun?: boolean | undefined
  /** Each step as it starts and ends. */
  onProgress?: ((message: string) => void) | undefined
  /** Every line of Docker's output. */
  onLog?: ((line: string) => void) | undefined
  /** Stops the build. */
  signal?: AbortSignal | undefined
  /** The docker CLI. Default: `docker` on PATH. */
  docker?: string
  /** The environment for docker. Default: this process's. */
  env?: NodeJS.ProcessEnv
}

export interface BuildResult {
  image: string
  tags: string[]
  hash: string
  digest: string
  platform: string
  /** The docker command, for `dryRun`. */
  command?: string[]
  id?: string
  size?: string | null
  seconds?: number
}

/** Builds the desktop image and returns what it built. */
export async function buildDesktopImage(options: BuildOptions = {}): Promise<BuildResult> {
  const { dir = IMAGE_DIR, docker = 'docker', env = process.env, onProgress = () => {}, onLog, signal } = options
  const started = Date.now()
  const [digest, host] = await Promise.all([contentDigest(dir), dockerPlatform({ docker, env })])
  const hash = digest.slice(0, 12)
  const platform = options.platform ?? host
  // Only in a checkout, where the build files are in packages/blobby-sandbox/images/desktop, the
  // repository's .npmrc; an npm install never reads files outside the package.
  const revision = await gitRevision(dir, env)
  const npmrcPath = options.npmrc ?? (revision ? join(dir, '..', '..', '..', '..', '.npmrc') : undefined)
  const npmrc = npmrcPath ? await readFile(npmrcPath, 'utf8').catch(() => undefined) : undefined
  const registry = options.registry ?? npmRegistry({ env, npmrc })
  const { args, tags } = buildCommand({ ...options, dir, hash, platform, native: platform === host, revision })
  const image = tags[0]!
  if (options.dryRun) return { image, tags, hash, digest, platform, command: [docker, ...args] }

  onProgress(`Building ${image} for ${platform}`)
  const log: string[] = []
  const steps = stepReader(onProgress)
  let result: RunResult
  try {
    result = await run(docker, args, {
      env: { ...env, DOCKER_BUILDKIT: '1', [REGISTRY_ENV]: registry },
      signal,
      onStderrLine: (line) => {
        log.push(line)
        if (log.length > LOG_LINES) log.shift()
        steps(line)
        onLog?.(line)
      },
      onStdoutLine: (line) => onLog?.(line),
    })
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw new ImageError('cancelled', 'The image build was cancelled.', { cause: error })
    throw new ImageError('docker_unavailable', `The docker CLI didn't run (${(error as Error).message}).`, { cause: error })
  }
  if (result.code !== 0) {
    throw new ImageError('image_build_failed', `Building ${image} failed. The end of Docker's output:\n${log.join('\n').trim()}`)
  }
  const inspect = await run(docker, ['image', 'inspect', '--format', '{{.Id}}', image], { env })
  if (inspect.code !== 0) throw new ImageError('image_build_failed', `Docker built ${image} but can't find it: ${inspect.stderr.trim()}`)
  // The size `docker images` shows: what the image takes on disk, unpacked, with either image store.
  const listed = await run(docker, ['image', 'ls', '--filter', `reference=${image}`, '--format', '{{.Size}}'], { env })
  const seconds = Math.round((Date.now() - started) / 100) / 10
  onProgress(`Built ${image} in ${seconds} s`)
  return { image, tags, hash, digest, platform, id: inspect.stdout.trim(), size: listed.stdout.trim().split('\n')[0] || null, seconds }
}

const USAGE = `Usage: node images/desktop/build.ts [options]

Builds ${IMAGE_REPOSITORY}:<content hash> and ${IMAGE_REPOSITORY}:latest for the Docker host's architecture.

  --platform <p>      ${PLATFORMS.join(' or ')}. Another platform than the host's is tagged <hash>-<arch> only.
  --no-cache          Build every step again.
  --pull              Pull the base image again.
  --builder <name>    Build with this buildx builder.
  --cache-from <spec> Import a build cache (buildx), for example type=local,src=<dir>. Repeatable.
  --cache-to <spec>   Export the build cache (buildx), for example type=local,dest=<dir>,mode=max. Repeatable.
  --verbose           Print all of Docker's output.
  --dry-run           Print the docker command instead of running it.
  --hash              Print the content hash and exit.
  --json              Print JSON, for scripts and agents.
`

/** The `images/desktop/build.ts` command, for checkouts and CI. */
export async function main(argv: string[]): Promise<number> {
  let values
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: {
        platform: { type: 'string' },
        'no-cache': { type: 'boolean' },
        pull: { type: 'boolean' },
        builder: { type: 'string' },
        'cache-from': { type: 'string', multiple: true },
        'cache-to': { type: 'string', multiple: true },
        verbose: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        hash: { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }))
  } catch (error) {
    process.stderr.write(`blobby-desktop: ${(error as Error).message}\n\n${USAGE}`)
    return 2
  }
  if (values.help) return process.stdout.write(USAGE), 0
  const json = Boolean(values.json)
  try {
    if (values.hash) {
      const hash = await contentHash()
      process.stdout.write(json ? `${JSON.stringify({ hash, image: `${IMAGE_REPOSITORY}:${hash}` })}\n` : `${hash}\n`)
      return 0
    }
    const result = await buildDesktopImage({
      platform: values.platform,
      noCache: values['no-cache'],
      pull: values.pull,
      builder: values.builder,
      cacheFrom: values['cache-from'],
      cacheTo: values['cache-to'],
      dryRun: values['dry-run'],
      onProgress: (message) => process.stderr.write(`blobby-desktop: ${message}\n`),
      onLog: values.verbose ? (line) => process.stderr.write(`${line}\n`) : undefined,
    })
    if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    else if (result.command) process.stdout.write(`${result.command.join(' ')}\n`)
    else process.stdout.write(`Built ${result.tags.join(' and ')} (${result.size ?? 'size unknown'}) in ${result.seconds} s\n`)
    return 0
  } catch (error) {
    const code = error instanceof ImageError ? error.code : 'image_build_failed'
    const message = (error as Error).message
    process.stderr.write(json ? `${JSON.stringify({ error: { code, message } })}\n` : `blobby-desktop: ${message}\n`)
    return 1
  }
}
