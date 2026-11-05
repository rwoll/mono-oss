#!/usr/bin/env node
// What earlier Agents QA runs found and what the user decided about it, for the next run:
//   node known.ts
// Prints JSON: the build the last run tested (previousBuild), the exploratory area to cover next (nextArea),
// and every known finding with its key, latest status, and the user's decision. scripts/pick-prs.ts picks
// this run's PRs from previousBuild.
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Parsed JSON from disk or gh; every field is checked before use.
// oxlint-disable-next-line typescript/no-explicit-any
type Json = any

const AREAS = [
  'Sessions list',
  'Composer and chat',
  'Changes and diffs',
  'Customizations',
  'Automations',
  'Remotes and environments',
  'Settings and onboarding',
  'Artifacts and canvases',
  'Sandbox and permissions',
  'Worktrees and merging',
]
const SEVERITY = ['high', 'medium', 'low', 'polish']
const DAY_MS = 24 * 60 * 60 * 1000

const root = process.env.AGENTS_QA_ROOT || join(homedir(), 'agents-window-qa')

async function readJson(file: string): Promise<Json> {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

const entries = await readdir(join(root, 'runs'), { withFileTypes: true }).catch(() => [])
const runs = (await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => readJson(join(root, 'runs', entry.name, 'findings.json')))))
  .filter((run) => run?.format === 'agents-qa-run' && !Number.isNaN(Date.parse(run.startedAt)))
  .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
const items = (await readJson(join(root, 'triage.json')))?.items ?? {}

const lastComplete = runs.findLast((run) => run.status === 'complete')
const since = lastComplete?.startedAt ?? new Date(Date.now() - DAY_MS).toISOString()

const explored = new Map<string, number>()
for (const run of runs) if (run.scope?.area) explored.set(String(run.scope.area).toLowerCase(), Date.parse(run.startedAt))
const nextArea = [...AREAS].sort((a, b) => (explored.get(a.toLowerCase()) ?? 0) - (explored.get(b.toLowerCase()) ?? 0))[0]

const known = new Map<string, Json>()
for (const run of runs) {
  for (const finding of run.findings ?? []) {
    if (typeof finding?.key !== 'string') continue
    const previous = known.get(finding.key)
    known.set(finding.key, {
      key: finding.key,
      title: finding.title,
      area: finding.area ?? 'Other',
      severity: finding.severity,
      lastStatus: finding.status ?? 'new',
      lastSeen: run.id,
      runs: (previous?.runs ?? 0) + 1,
    })
  }
}

const findings = [...known.values()]
  .map((finding) => {
    const item = items[finding.key]
    return {
      ...finding,
      // `dismiss` is the earlier name for `suppress`.
      decision: item?.decision === 'dismiss' ? 'suppress' : (item?.decision ?? null),
      ...(item?.decision && { state: item.state }),
      ...(item?.trackedUrl && { trackedUrl: item.trackedUrl }),
      ...(item?.links?.length && { links: item.links.map((link: Json) => link.url ?? link.path) }),
      ...(item?.note && { note: item.note }),
    }
  })
  .sort((a, b) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity) || a.key.localeCompare(b.key))

const last = runs.at(-1)
console.log(
  JSON.stringify(
    {
      root,
      since,
      lastRun: last ? { id: last.id, status: last.status, startedAt: last.startedAt, build: last.build ?? null } : null,
      previousBuild: lastComplete?.build?.commit ? { run: lastComplete.id, version: lastComplete.build.version ?? '', commit: lastComplete.build.commit } : null,
      nextArea,
      areas: AREAS,
      known: findings,
    },
    null,
    2,
  ),
)
