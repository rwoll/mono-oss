import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { SandboxError } from './backend.ts'
import { buildDesktopImage, IMAGE_DIR, ImageError } from './desktop-image.ts'

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

/** The desktop image's build files, which the package ships in `images/desktop`, or null if they're missing. */
export async function desktopImageDir(): Promise<string | null> {
  return (await access(join(IMAGE_DIR, 'Dockerfile')).then(() => true, () => false)) ? IMAGE_DIR : null
}

/**
 * Builds the desktop image with Docker, from the build files in the package. Nothing is pulled from or
 * pushed to a registry except the Ubuntu base image and the packages the Dockerfile installs.
 */
export async function buildImage(options: ImageBuildOptions = {}): Promise<ImageBuild> {
  const dir = await desktopImageDir()
  if (!dir) throw new SandboxError('image_files_missing', 'This install of @rwoll/blobby-sandbox has no desktop image build files in images/desktop. Reinstall it.')
  try {
    return await buildDesktopImage({
      dir,
      ...(options.platform ? { platform: options.platform } : {}),
      noCache: options.noCache ?? false,
      onProgress: options.onProgress,
      signal: options.signal,
      env: options.env ?? process.env,
    })
  } catch (error) {
    if (error instanceof ImageError) throw new SandboxError(error.code, error.message, { cause: error })
    throw error
  }
}
