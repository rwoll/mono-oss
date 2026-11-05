import { createHash } from 'node:crypto'
import { extname, isAbsolute, resolve, sep } from 'node:path'
import { SEVERITIES, type Item, type Media, type Run, type RunFinding, type Triage } from './format.ts'
import type { RunRead } from './store.ts'

/** A run marked running this long ago stopped without finishing. */
export const STALE_RUN_MS = 6 * 60 * 60 * 1000

export interface MediaView {
  /** What the page asks the files route for. */
  id: string
  path: string
  label: string
  kind: 'image' | 'video' | 'file'
}

export interface Sighting {
  runId: string
  id: string
  status: RunFinding['status']
  at: string
}

/** A finding as the newest run that saw it describes it, with every run that saw it and your decision. */
export interface FindingView extends Omit<RunFinding, 'media'> {
  runId: string
  media: MediaView[]
  seen: Sighting[]
  item: Item | null
}

export interface RunView {
  id: string
  status: Run['status'] | 'stopped' | 'unreadable'
  startedAt: string | null
  finishedAt: string | null
  build: Run['build']
  environment: string
  scope: Run['scope']
  summary: string
  error: string | null
  /** The report's absolute path, when it exists. */
  report: string | null
  media: MediaView[]
  verified: Run['verified']
  counts: { findings: number; new: number; still: number; fixed: number }
  problem: string | null
}

export interface LinkStatus {
  state: 'open' | 'closed' | 'merged'
  draft?: boolean
  title?: string
}

export interface QaState {
  root: string
  rootExists: boolean
  runs: RunView[]
  findings: FindingView[]
  settings: { fixModel: string; vscodePath: string }
  links: Record<string, LinkStatus>
  problems: string[]
  syncedAt: string
}

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif'])
const VIDEO = new Set(['.mp4', '.m4v', '.webm', '.mov'])

export const mediaId = (path: string) => `m-${createHash('sha256').update(path).digest('hex').slice(0, 24)}`

/** Whether `path` is `root` or inside it, by path alone. */
export function inside(root: string, path: string): boolean {
  const base = resolve(root)
  const target = resolve(path)
  return target === base || target.startsWith(base + sep)
}

function mediaViews(media: readonly Media[], dir: string, root: string): MediaView[] {
  return media.flatMap((entry) => {
    const path = isAbsolute(entry.path) ? resolve(entry.path) : resolve(dir, entry.path)
    // Media must live in the QA folder; anything else is not shown.
    if (!inside(root, path)) return []
    const ext = extname(path).toLowerCase()
    const name = path.slice(path.lastIndexOf(sep) + 1)
    return [{ id: mediaId(path), path, label: entry.label || name, kind: IMAGE.has(ext) ? 'image' : VIDEO.has(ext) ? 'video' : 'file' } satisfies MediaView]
  })
}

const rank = (severity: RunFinding['severity']) => SEVERITIES.indexOf(severity)

export function runView(read: RunRead, root: string, now: number, exists: (path: string) => boolean): RunView {
  const { run } = read
  if (!run) {
    return {
      id: read.id,
      status: 'unreadable',
      startedAt: null,
      finishedAt: null,
      build: { version: '', commit: '' },
      environment: '',
      scope: { prs: [], skipped: [] },
      summary: '',
      error: null,
      report: null,
      media: [],
      verified: [],
      counts: { findings: 0, new: 0, still: 0, fixed: 0 },
      problem: read.problem ?? 'The run file could not be read.',
    }
  }
  const report = resolve(read.dir, run.report)
  const count = (status: RunFinding['status']) => run.findings.filter((finding) => finding.status === status).length
  const stale = run.status === 'running' && now - Date.parse(run.startedAt) > STALE_RUN_MS
  return {
    id: run.id,
    status: stale ? 'stopped' : run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    build: run.build,
    environment: run.environment,
    scope: run.scope,
    summary: run.summary,
    error: run.error ?? null,
    report: inside(read.dir, report) && exists(report) ? report : null,
    media: mediaViews(run.media, read.dir, root),
    verified: run.verified,
    counts: { findings: run.findings.length, new: count('new'), still: count('still-reproduces'), fixed: count('fixed') },
    problem: null,
  }
}

/** Findings from every readable run, merged by key, most severe and most recent first. */
export function findingViews(reads: readonly RunRead[], triage: Triage, root: string): FindingView[] {
  const byKey = new Map<string, FindingView>()
  // Oldest run first, so newer runs describe the finding.
  for (const read of [...reads].reverse()) {
    const { run } = read
    if (!run) continue
    for (const finding of run.findings) {
      const previous = byKey.get(finding.key)
      const media = mediaViews(finding.media, read.dir, root)
      const sighting: Sighting = { runId: run.id, id: finding.id, status: finding.status, at: run.startedAt }
      byKey.set(finding.key, {
        ...finding,
        runId: run.id,
        media: media.length ? media : (previous?.media ?? []),
        matches: finding.matches.length ? finding.matches : (previous?.matches ?? []),
        seen: [...(previous?.seen ?? []), sighting],
        item: null,
      })
    }
  }
  const lastAt = (finding: FindingView) => Date.parse(finding.seen.at(-1)!.at)
  return [...byKey.values()]
    .map((finding) => ({ ...finding, item: triage.items[finding.key] ?? null }))
    .sort((a, b) => rank(a.severity) - rank(b.severity) || lastAt(b) - lastAt(a) || a.title.localeCompare(b.title))
}
