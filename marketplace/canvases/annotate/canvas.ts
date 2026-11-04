import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { annotationSchema, checkDocument, cueSchema, documentSchema, mediaKind, shotSchema, type AnnotateDocument, type Annotation } from '@rwoll/annotate'
import annotatePackage from '@rwoll/annotate/package.json' with { type: 'json' }
import { CanvasKitError, defineCanvas, z, type ActionContext } from '@rwoll/canvas-kit'
import { FORMATS, VIDEO_FORMATS } from './shared.ts'

/** The oldest annotate CLI exports run with: the @rwoll/annotate this canvas was built with. */
export const ANNOTATE_VERSION = annotatePackage.version
const INSTALL_HELP =
  'Ask the agent to install it with the annotate skill (its scripts/install-tools.ts), or see https://github.com/rwoll/mono-oss/tree/main/packages/annotate#install.'

const issue = z.object({ level: z.enum(['error', 'warning']), path: z.string(), message: z.string() })
const exported = z.object({ path: z.string(), format: z.enum(FORMATS), at: z.string() })

const state = z.object({
  /** The document file. */
  path: z.string(),
  document: documentSchema.nullable(),
  /**
   * File IDs the page loads the media with, through `files`: each carries the file's
   * modification time, so the page reloads a changed file, and its extension. `preview`
   * is an MP4 of the source for pages that cannot play it.
   */
  media: z.object({ source: z.string(), before: z.string().optional(), preview: z.string().optional() }).nullable(),
  /** Why the document could not be read, if it could not. */
  error: z.string().nullable(),
  issues: z.array(issue),
  /** The file's modification time when the canvas last read or wrote it. */
  mtime: z.number(),
  /** Where the agent asked the player to go, and a counter so asking twice still moves it. */
  seek: z.object({ time: z.number(), n: z.number().int() }),
  exporting: z.object({ format: z.enum(FORMATS), frame: z.number().int(), frames: z.number().int() }).nullable(),
  exports: z.array(exported).max(20),
  exportError: z.string().nullable(),
})
export type AnnotateState = z.output<typeof state>

const docPathFor = (path: string) => (extname(path).toLowerCase() === '.json' ? path : join(dirname(path), `${basename(path, extname(path))}.annotate.json`))

/** MP4 previews already made in this process, by source file and its modification time. */
const previews = new Map<string, { id: string; path: string }>()
const previewKey = (path: string, mtime: number) => `${path}\n${mtime}`
const mtimeOf = async (path: string) => Math.round((await stat(path).catch(() => undefined))?.mtimeMs ?? 0)
const fileId = (name: string, path: string, mtime: number) => `${name}-${mtime}${extname(path).toLowerCase()}`

/** Reads the document and names its media for the page; a broken file is reported in the state, not thrown. */
async function load(path: string): Promise<Pick<AnnotateState, 'path' | 'document' | 'media' | 'error' | 'issues' | 'mtime'>> {
  const mtime = (await stat(path).catch(() => undefined))?.mtimeMs ?? 0
  try {
    const document = documentSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    const base = dirname(path)
    const source = resolve(base, document.source.path)
    const sourceMtime = await mtimeOf(source)
    const preview = previews.get(previewKey(source, sourceMtime))
    const before = document.compare && resolve(base, document.compare.before.path)
    const media = {
      source: fileId('source', source, sourceMtime),
      ...(before && { before: fileId('before', before, await mtimeOf(before)) }),
      ...(preview && { preview: preview.id }),
    }
    return { path, document, media, error: null, issues: checkDocument(document), mtime }
  } catch (error) {
    const message = error instanceof z.ZodError ? z.prettifyError(error) : (error as Error).message
    return { path, document: null, media: null, error: `Could not read ${basename(path)}: ${message}`, issues: [], mtime }
  }
}

/** Opens a document, or starts one next to an image or video. */
async function open(input: string) {
  const target = resolve(input)
  if (!existsSync(target)) throw new CanvasKitError('not_found', `${target} does not exist`)
  const path = docPathFor(target)
  if (path !== target && !existsSync(path)) {
    if (!mediaKind(target)) throw new CanvasKitError('invalid_input', `${basename(target)} is not a document (.json) or a supported image or video`)
    const document: AnnotateDocument = { version: 1, source: { path: basename(target) }, annotations: [] }
    await writeFile(path, `${JSON.stringify(document, null, 2)}\n`)
  }
  return load(path)
}

/** Edits to one file run one at a time in this process, even from different canvas instances. */
const fileLocks = new Map<string, Promise<unknown>>()
function withFileLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(path) ?? Promise.resolve()
  const next = previous.then(work, work)
  const settled = next.catch(() => {})
  fileLocks.set(path, settled)
  void settled.then(() => {
    if (fileLocks.get(path) === settled) fileLocks.delete(path)
  })
  return next
}

/**
 * Applies an edit to the document as it is on disk now: if the file changed since the
 * canvas last read it (the agent edited it, or another chat did), the edit applies to
 * that version, so nothing is overwritten. The result is validated and saved atomically.
 */
async function edit(ctx: ActionContext<AnnotateState>, change: (document: AnnotateDocument) => unknown): Promise<AnnotateDocument> {
  const { path } = ctx.state
  return withFileLock(path, async () => {
    const mtime = (await stat(path).catch(() => undefined))?.mtimeMs ?? 0
    if (mtime !== ctx.state.mtime) {
      const loaded = await load(path)
      ctx.setState((s) => ({ ...s, ...loaded }))
    }
    const document = ctx.state.document
    if (!document) throw new CanvasKitError('invalid_state', ctx.state.error ?? 'The document could not be read; fix the file, then reload.')
    const parsed = documentSchema.safeParse(change(document))
    if (!parsed.success) throw new CanvasKitError('invalid_input', `The document would not be valid:\n${z.prettifyError(parsed.error)}`)
    const temp = `${path}.${randomUUID()}.tmp`
    await writeFile(temp, `${JSON.stringify(parsed.data, null, 2)}\n`)
    await rename(temp, path)
    const loaded = await load(path)
    ctx.setState((s) => ({ ...s, ...loaded }))
    return parsed.data
  })
}

function current(ctx: ActionContext<AnnotateState>): AnnotateDocument {
  const document = ctx.state.document
  if (!document) throw new CanvasKitError('invalid_state', ctx.state.error ?? 'The document could not be read; fix the file, then reload.')
  return document
}

/** Gives every annotation an id, so the agent and the page can refer to it. */
function withIds(existing: readonly Annotation[], added: readonly Annotation[]): Annotation[] {
  const used = new Set(existing.flatMap((a) => (a.id ? [a.id] : [])))
  let n = existing.length
  return added.map((annotation) => {
    if (annotation.id) return annotation
    let id: string
    do id = `${annotation.type}-${++n}`
    while (used.has(id))
    used.add(id)
    return { ...annotation, id }
  })
}

function indexOf(document: AnnotateDocument, target: string | number): number {
  const index = typeof target === 'number' ? target : document.annotations.findIndex((a) => a.id === target)
  if (index < 0 || index >= document.annotations.length) throw new CanvasKitError('not_found', `No annotation ${JSON.stringify(target)}`)
  return index
}

/** How exports run the CLI: ANNOTATE_CLI (a command, or a .js file run with Node.js), else `annotate` on PATH. */
export function cliCommand(env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  const explicit = env.ANNOTATE_CLI
  if (explicit) return /\.[cm]?[jt]s$/.test(explicit) ? { command: process.execPath, args: [explicit] } : { command: explicit, args: [] }
  return { command: process.platform === 'win32' ? 'annotate.cmd' : 'annotate', args: [] }
}

/** Whether `version` is `minimum` or later. Pre-release suffixes are ignored. */
export function atLeast(version: string, minimum: string): boolean {
  const parse = (v: string) => (v.trim().replace(/^v/, '').split(/[-+]/)[0] ?? '').split('.').map(Number)
  const [a, b] = [parse(version), parse(minimum)]
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  return true
}

/** Spawns a command; Windows runs .cmd launchers only through a shell, so everything is quoted for it. */
function spawnCli(command: string, args: string[], cwd?: string) {
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)
  const quote = (arg: string) => (shell ? `"${arg.replace(/"/g, '""')}"` : arg)
  return spawn(quote(command), args.map(quote), { cwd, shell, stdio: ['ignore', 'pipe', 'pipe'] })
}

const installedVersion = (command: string): Promise<string | null> =>
  new Promise((done) => {
    const child = spawnCli(command, ['--version'])
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))
    child.stderr.resume()
    child.on('error', () => done(null))
    child.on('close', (code) => done(code === 0 ? out.trim() : null))
  })

/** Fails unless the annotate CLI is installed at ANNOTATE_VERSION or later. ANNOTATE_CLI is used as it is. */
export async function checkCli(env: NodeJS.ProcessEnv = process.env, versionOf: (command: string) => Promise<string | null> = installedVersion): Promise<void> {
  if (env.ANNOTATE_CLI) return
  const version = await versionOf(cliCommand(env).command)
  if (version === null) throw new CanvasKitError('unavailable', `The annotate command isn't installed. ${INSTALL_HELP}`)
  if (!atLeast(version, ANNOTATE_VERSION)) {
    throw new CanvasKitError('unavailable', `annotate ${version} is installed, but this canvas needs ${ANNOTATE_VERSION} or later. ${INSTALL_HELP.replace('install it', 'update it')}`)
  }
}

async function runCli(args: string[], cwd: string, onProgress: (frame: number, frames: number) => void): Promise<void> {
  await checkCli()
  const { command, args: prefix } = cliCommand()
  return new Promise((done, fail) => {
    const child = spawnCli(command, [...prefix, ...args], cwd)
    let errors = ''
    let partial = ''
    child.stderr.on('data', (chunk: Buffer) => {
      partial += chunk.toString('utf8')
      const lines = partial.split('\n')
      partial = lines.pop() ?? ''
      for (const line of lines) {
        try {
          const progress = JSON.parse(line) as { frame?: number; frames?: number }
          if (typeof progress.frame === 'number' && typeof progress.frames === 'number') {
            onProgress(progress.frame, progress.frames)
            continue
          }
        } catch {
          // Not a progress line.
        }
        errors = `${errors}${line}\n`.slice(-4000)
      }
    })
    child.stdout.resume()
    child.on('error', (error) => fail(new CanvasKitError('export_failed', `Could not run ${command}: ${error.message}`)))
    child.on('close', (code) => (code === 0 ? done() : fail(new CanvasKitError('export_failed', (errors + partial).trim() || `annotate exited with ${code}`))))
  })
}

/** Fences text so nothing in it can close the block: one backtick more than its longest run. */
const fence = (text: string, info = '') => {
  const ticks = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)))
  return `${ticks}${info}\n${text}\n${ticks}`
}

/** The user's note is data for the agent to act on, so it is quoted, never inlined as instructions. */
export const feedbackPrompt = (path: string, text: string, selected?: Annotation) =>
  [
    `The user left a note in the annotate canvas on ${path}. Their note, quoted:`,
    '',
    fence(text, 'text'),
    ...(selected ? ['', 'It is about this annotation:', '', fence(JSON.stringify(selected), 'json')] : []),
    '',
    'Change the document with the canvas actions (or edit the file; the canvas reloads it), then tell the user what changed.',
  ].join('\n')

export default defineCanvas({
  id: 'rwoll-annotate',
  title: 'Annotate',
  description:
    'Shows an annotate document (marks, zoom, captions, before/after, redaction on a screenshot or recording) for the user to play, edit, and export. Open it with a .json document or an image or video.',
  state,
  input: z.object({
    path: z
      .string()
      .min(1)
      .describe('A document (.json), or an image or video to start one for: it is written next to it as <name>.annotate.json.'),
  }),
  init: async ({ input }) => ({
    ...(await open(input.path)),
    seek: { time: 0, n: 0 },
    exporting: null,
    exports: [],
    exportError: null,
  }),
  reopen: async ({ input, state: current }) => ({ ...current, ...(await open(input.path)) }),
  // The page may load only this document's own media, by the IDs in state.media.
  files: ({ state: s }, id) => {
    if (!s.document || !s.media) return null
    const base = dirname(s.path)
    if (id === s.media.source) return { path: resolve(base, s.document.source.path) }
    if (id === s.media.before && s.document.compare) return { path: resolve(base, s.document.compare.before.path) }
    const preview = id === s.media.preview ? [...previews.values()].find((candidate) => candidate.id === id) : undefined
    if (preview) return { path: preview.path }
    return null
  },
  status: (s) => (s.error ? s.error : `${basename(s.path)}: ${s.document?.annotations.length ?? 0} annotations`),
  actions: ({ action }) => ({
    set_document: action({
      description: 'Replace the whole document. It is validated, saved to the file, and shown.',
      input: z.object({ document: z.unknown() }),
      run: async (ctx, { document }) => {
        await edit(ctx, () => document)
        return { issues: ctx.state.issues }
      },
    }),
    add_annotations: action({
      description: 'Add annotations. Each gets an id if it has none; the ids are returned so arrows and steps can refer to them.',
      input: z.object({ annotations: z.array(annotationSchema).min(1).max(100) }),
      run: async (ctx, { annotations }) => {
        let added: Annotation[] = []
        await edit(ctx, (document) => {
          added = withIds(document.annotations, annotations)
          return { ...document, annotations: [...document.annotations, ...added] }
        })
        return { ids: added.map((a) => a.id), issues: ctx.state.issues }
      },
    }),
    update_annotation: action({
      description: 'Change fields of one annotation, by id or index. Fields set to null are removed.',
      input: z.object({ target: z.union([z.string(), z.number().int().nonnegative()]), changes: z.record(z.string(), z.unknown()) }),
      run: async (ctx, { target, changes }) => {
        await edit(ctx, (document) => {
          const index = indexOf(document, target)
          const merged: Record<string, unknown> = { ...document.annotations[index] }
          for (const [key, value] of Object.entries(changes)) {
            if (value === null) delete merged[key]
            else merged[key] = value
          }
          return { ...document, annotations: document.annotations.map((a, i) => (i === index ? merged : a)) }
        })
        return { issues: ctx.state.issues }
      },
    }),
    remove_annotations: action({
      description: 'Remove annotations by id or index.',
      input: z.object({ targets: z.array(z.union([z.string(), z.number().int().nonnegative()])).min(1) }),
      run: async (ctx, { targets }) => {
        await edit(ctx, (document) => {
          const drop = new Set(targets.map((target) => indexOf(document, target)))
          return { ...document, annotations: document.annotations.filter((_, i) => !drop.has(i)) }
        })
        return { issues: ctx.state.issues }
      },
    }),
    set_narration: action({
      description: 'Replace the captions. Each needs a start time `t` and `text`; the end defaults from reading speed.',
      input: z.object({ narration: z.array(cueSchema).max(1000) }),
      run: async (ctx, { narration }) => {
        await edit(ctx, ({ narration: _old, ...document }) => (narration.length ? { ...document, narration } : document))
        return { issues: ctx.state.issues }
      },
    }),
    set_camera: action({
      description: 'Replace the camera shots: zoom shots, or auto zoom that follows the input events.',
      input: z.object({ camera: z.array(shotSchema).max(500) }),
      run: async (ctx, { camera }) => {
        await edit(ctx, ({ camera: _old, ...document }) => (camera.length ? { ...document, camera } : document))
        return { issues: ctx.state.issues }
      },
    }),
    seek: action({
      description: 'Show the player at a time, in seconds, paused.',
      expose: 'agent',
      input: z.object({ time: z.number().nonnegative() }),
      run: (ctx, { time }) => {
        ctx.setState((s) => ({ ...s, seek: { time, n: s.seek.n + 1 } }))
      },
    }),
    reload: action({
      description: 'Read the document file again, for example after editing it directly.',
      run: async (ctx) => {
        const loaded = await load(ctx.state.path)
        ctx.setState((s) => ({ ...s, ...loaded }))
        return { error: loaded.error, issues: loaded.issues }
      },
    }),
    media_info: action({
      description: 'Record the source size the page read from the media, when the document does not have it yet.',
      expose: 'ui',
      input: z.object({ width: z.number().int().positive(), height: z.number().int().positive(), duration: z.number().positive().optional() }),
      run: async (ctx, { width, height, duration }) => {
        const { source } = current(ctx)
        const isVideo = mediaKind(source.path) === 'video'
        if (source.width && source.height && (!isVideo || source.duration !== undefined || duration === undefined)) return
        await edit(ctx, (document) => ({
          ...document,
          source: {
            ...document.source,
            width: document.source.width ?? width,
            height: document.source.height ?? height,
            ...(isVideo && duration !== undefined && { duration: document.source.duration ?? Math.round(duration * 1000) / 1000 }),
          },
        }))
      },
    }),
    preview: action({
      description: 'Make an MP4 copy of the source video for a page that cannot play it, such as WebM in VS Code.',
      expose: 'ui',
      run: async (ctx) => {
        const document = current(ctx)
        const source = resolve(dirname(ctx.state.path), document.source.path)
        if (mediaKind(source) !== 'video') throw new CanvasKitError('invalid_input', 'Only videos need a preview')
        const info = await stat(source)
        const key = previewKey(source, await mtimeOf(source))
        const dir = join(ctx.dataDir, 'previews')
        const out = join(dir, `${createHash('sha256').update(`${key}\n${info.size}`).digest('hex').slice(0, 24)}.mp4`)
        if (!existsSync(out)) {
          await mkdir(dir, { recursive: true })
          const temp = `${out}.${randomUUID()}.mp4`
          await runCli(['convert', source, '-o', temp], dir, () => {})
          await rename(temp, out)
        }
        const id = `preview-${basename(out)}`
        previews.set(key, { id, path: out })
        ctx.setState((s) => (s.media ? { ...s, media: { ...s.media, preview: id } } : s))
        return { id }
      },
    }),
    export: action({
      description:
        'Render the document with the annotate CLI: png, jpg, or webp for a still (at `at` seconds, default the end), or mp4, webm, or gif for video. Written next to the document unless `out` is given. Returns the path.',
      input: z.object({
        format: z.enum(FORMATS),
        at: z.number().nonnegative().optional(),
        out: z.string().min(1).optional(),
        captions: z.enum(['burn', 'soft', 'none']).optional(),
      }),
      run: async (ctx, { format, at, out, captions }) => {
        const document = current(ctx)
        const dir = dirname(ctx.state.path)
        const name = basename(ctx.state.path).replace(/(\.annotate)?\.json$/i, '')
        const still = !VIDEO_FORMATS.has(format)
        const path = resolve(dir, out ?? `${name}-annotated${still && at !== undefined ? `-${at.toFixed(1)}s` : ''}.${format}`)
        const inputs = [document.source, document.compare?.before].flatMap((media) => (media ? [resolve(dir, media.path)] : []))
        if (inputs.includes(path) || path === ctx.state.path) throw new CanvasKitError('invalid_input', `${basename(path)} is one of the document's own files; export to another name.`)
        const args = ['render', ctx.state.path, '-o', path, '--progress']
        if (at !== undefined) args.push('--at', String(at))
        if (captions) args.push('--captions', captions)
        ctx.setState((s) => ({ ...s, exporting: { format, frame: 0, frames: still ? 1 : 0 }, exportError: null }))
        try {
          await runCli(args, dir, (frame, frames) => ctx.setState((s) => ({ ...s, exporting: { format, frame, frames } })))
        } catch (error) {
          const message = (error as Error).message
          ctx.setState((s) => ({ ...s, exporting: null, exportError: message }))
          return { error: message }
        }
        const entry = { path, format, at: new Date(ctx.now()).toISOString() }
        ctx.setState((s) => ({ ...s, exporting: null, exports: [entry, ...s.exports.filter((e) => e.path !== path)].slice(0, 20) }))
        if (ctx.source === 'ui') {
          await ctx
            .sendToAgent({
              prompt: `The user exported ${path} from the annotate canvas (document: ${ctx.state.path}${document.narration?.length ? '; it has captions' : ''}).`,
              displayPrompt: `Annotate · exported ${basename(path)}`,
            })
            .catch((error: unknown) => ctx.log(`Could not tell the agent about the export: ${(error as Error).message}`, 'warning'))
        }
        return { path }
      },
    }),
    send_feedback: action({
      description: 'Send the user’s feedback about the document to the agent.',
      expose: 'ui',
      input: z.object({ text: z.string().trim().min(1).max(4000), target: z.union([z.string(), z.number().int().nonnegative()]).optional() }),
      run: async (ctx, { text, target }) => {
        const document = current(ctx)
        const selected = target === undefined ? undefined : document.annotations[indexOf(document, target)]
        await ctx.sendToAgent({ prompt: feedbackPrompt(ctx.state.path, text, selected), displayPrompt: `Annotate · ${text.slice(0, 80)}` })
      },
    }),
  }),
  jobs: ({ job }) => ({
    // The file is the source of truth: pick up edits made outside the canvas.
    watch_file: job({
      every: '2s',
      description: 'Reload the document when its file changes.',
      run: async (ctx) => {
        const mtime = (await stat(ctx.state.path).catch(() => undefined))?.mtimeMs ?? 0
        if (mtime === ctx.state.mtime) return
        const loaded = await load(ctx.state.path)
        ctx.setState((s) => ({ ...s, ...loaded }))
      },
    }),
  }),
})
