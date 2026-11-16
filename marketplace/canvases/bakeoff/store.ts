import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
import { CanvasKitError } from '@rwoll/canvas-kit'
import type { Kind } from './shared.ts'

// A bakeoff's folder, in the canvas's private data folder: a copy of every variant, by round, so the
// bakeoff still works after the agent's scratch files are gone, and the agent has one place to read them.

const KB = 1024
const MB = 1024 * KB

/** What a file is, by its extension, and how large it may be. Images and videos are what canvas-kit serves to the page. */
const TYPES: Record<string, { kind: Kind; max: number }> = {
  '.png': { kind: 'image', max: 25 * MB },
  '.jpg': { kind: 'image', max: 25 * MB },
  '.jpeg': { kind: 'image', max: 25 * MB },
  '.gif': { kind: 'image', max: 25 * MB },
  '.webp': { kind: 'image', max: 25 * MB },
  '.avif': { kind: 'image', max: 25 * MB },
  // Shown as a data URL in an <img>, where it cannot run scripts.
  '.svg': { kind: 'image', max: MB },
  '.mp4': { kind: 'video', max: 200 * MB },
  '.m4v': { kind: 'video', max: 200 * MB },
  '.webm': { kind: 'video', max: 200 * MB },
  '.mov': { kind: 'video', max: 200 * MB },
  '.md': { kind: 'markdown', max: 200 * KB },
  '.markdown': { kind: 'markdown', max: 200 * KB },
  '.html': { kind: 'html', max: 500 * KB },
  '.htm': { kind: 'html', max: 500 * KB },
  '.txt': { kind: 'text', max: 200 * KB },
}
const TEXT: Partial<Record<Kind, { extension: string; max: number }>> = {
  markdown: { extension: '.md', max: 200 * KB },
  html: { extension: '.html', max: 500 * KB },
  text: { extension: '.txt', max: 200 * KB },
}

export interface NewVariant {
  path?: string | undefined
  content?: string | undefined
  kind?: Kind | undefined
}

export interface StoredVariant {
  kind: Kind
  /** Relative to the bakeoff's folder. */
  file: string
  bytes: number
}

export const bakeoffDir = (dataDir: string, id: string) => join(dataDir, 'bakeoffs', id)
const roundDir = (round: number) => `round-${round}`

const size = (bytes: number) => (bytes >= MB ? `${Math.round(bytes / MB)} MB` : `${Math.round(bytes / KB)} KB`)
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
const invalid = (message: string) => new CanvasKitError('invalid_variant', message, 400)

/** Copy a variant's file, or write its text, into the round's folder. `name` is how errors refer to it. */
export async function storeVariant(dir: string, round: number, label: string, input: NewVariant, name: string): Promise<StoredVariant> {
  const prefix = label.toLowerCase()
  await mkdir(join(dir, roundDir(round)), { recursive: true })

  if (input.content !== undefined) {
    const kind = input.kind ?? 'markdown'
    const text = TEXT[kind]
    if (!text) throw invalid(`${name}: content can be markdown, html, or text. Give an ${kind} as a file, with path.`)
    const bytes = Buffer.byteLength(input.content)
    if (bytes > text.max) throw invalid(`${name}: the content is ${size(bytes)}; ${kind} can be at most ${size(text.max)}.`)
    const file = join(roundDir(round), `${prefix}${text.extension}`)
    await writeFile(join(dir, file), input.content)
    return { kind, file, bytes }
  }

  const path = input.path as string
  if (!isAbsolute(path)) throw invalid(`${name}: ${path} is not an absolute path.`)
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) throw invalid(`${name}: there is no file at ${path}.`)
  const extension = extname(path).toLowerCase()
  const type = TYPES[extension]
  // A file with another extension can still be shown as text, when the agent says so.
  const kind = input.kind ?? type?.kind
  if (!kind) throw invalid(`${name}: ${basename(path)} is not an image, video, Markdown, HTML, or .txt file. Pass kind "text" to show it as plain text.`)
  const media = kind === 'image' || kind === 'video'
  if (media && type?.kind !== kind) throw invalid(`${name}: ${basename(path)} is not ${kind === 'image' ? 'an image' : 'a video'} this canvas can show (PNG, JPEG, GIF, WebP, AVIF, SVG, MP4, WebM, MOV).`)
  const max = media ? (type as { max: number }).max : (TEXT[kind] as { max: number }).max
  if (info.size > max) throw invalid(`${name}: ${basename(path)} is ${size(info.size)}; ${kind} can be at most ${size(max)}.`)
  if (!media && (await readFile(path)).includes(0)) throw invalid(`${name}: ${basename(path)} is not text.`)

  const stem = slug(basename(path, extname(path)))
  const file = join(roundDir(round), `${prefix}${stem ? `-${stem}` : ''}${extension || '.txt'}`)
  await copyFile(path, join(dir, file))
  return { kind, file, bytes: info.size }
}

export const removeStored = (dir: string, files: readonly string[]) => Promise.all(files.map((file) => rm(join(dir, file), { force: true })))

export const readStored = (dir: string, file: string) => readFile(join(dir, file), 'utf8')

/** Save what the user decided in a round next to its variants, and return the file's path. */
export async function writeFeedback(dir: string, round: number, text: string): Promise<string> {
  const path = join(dir, roundDir(round), 'feedback.md')
  await mkdir(join(dir, roundDir(round)), { recursive: true })
  await writeFile(path, `${text}\n`)
  return path
}
