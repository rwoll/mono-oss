import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SandboxError } from './backend.ts'

/** What `image build` takes. */
export interface ImageBuildOptions {
  /** `linux/amd64` or `linux/arm64`. Default the Docker host's. */
  platform?: string
  /** Build every step again. */
  noCache?: boolean
  /** Each step as it starts and ends. */
  onProgress?: (message: string) => void
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
}

/** What `image build` built. */
export interface ImageBuild {
  /** The tag sandboxes are created from, `blobby-desktop:<content hash>`. */
  image: string
  tags: string[]
  /** The first 12 hex digits of the SHA-256 over the image's build files. */
  hash: string
  digest: string
  platform: string
  /** Docker's image ID. */
  id?: string
  /** The size Docker shows, such as `2.1GB`, or null. */
  size?: string | null
  seconds?: number
}

/** The desktop image's build files, in the package next to `dist/` or `src/`. */
export async function desktopImageDir(): Promise<string | null> {
  const dir = fileURLToPath(new URL('../images/desktop/', import.meta.url))
  if (await access(join(dir, 'build.ts')).then(() => true, () => false)) return dir
  return null
}

type BuildModule = {
  buildDesktopImage(options: Record<string, unknown>): Promise<ImageBuild>
  ImageError: new (...args: never[]) => Error & { code: string }
}

/** Builds the desktop image with Docker, as `images/desktop/build.ts` does. */
export async function buildImage(options: ImageBuildOptions = {}): Promise<ImageBuild> {
  const dir = await desktopImageDir()
  if (!dir) {
    throw new SandboxError('image_files_missing', "This install of blobby-sandbox has no desktop image build files. Build the image from a checkout of rwoll/mono-oss: `node packages/blobby-sandbox/images/desktop/build.ts`.")
  }
  const build = (await import(pathToFileURL(join(dir, 'build.ts')).href)) as BuildModule
  try {
    return await build.buildDesktopImage({
      dir,
      ...(options.platform ? { platform: options.platform } : {}),
      noCache: options.noCache ?? false,
      onProgress: options.onProgress,
      signal: options.signal,
      env: options.env ?? process.env,
    })
  } catch (error) {
    if (error instanceof build.ImageError) throw new SandboxError(error.code, error.message, { cause: error })
    throw error
  }
}
