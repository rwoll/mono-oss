import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { LinkStatus } from './view.ts'

// The state of the pull requests and issues your decisions led to, from the gh CLI, so the canvas shows
// whether a fix is still a draft or merged and whether an issue was closed.

const GITHUB_ITEM = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9_-]{0,38})\/([A-Za-z0-9._-]{1,100})\/(pull|issues)\/([1-9]\d{0,8})\/?$/
// GUI hosts often start extensions with a minimal PATH that lacks Homebrew.
const GH_LOCATIONS = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']
const TTL_MS = 5 * 60 * 1000
const PER_REFRESH = 12

export type GhRunner = (args: readonly string[]) => Promise<string>

export const isGithubItem = (url: string) => GITHUB_ITEM.test(url)

function findGh(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [env.AGENTS_QA_GH, ...(env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, 'gh')), ...GH_LOCATIONS]
  return (
    candidates.find((path): path is string => {
      if (!path) return false
      try {
        accessSync(path, constants.X_OK)
        return true
      } catch {
        return false
      }
    }) ?? null
  )
}

export const runGh: GhRunner = (args) => {
  const binary = findGh()
  if (!binary) return Promise.reject(new Error('The gh CLI was not found.'))
  return new Promise((resolve, reject) =>
    execFile(binary, [...args], { timeout: 20_000, maxBuffer: 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }, (error, stdout, stderr) =>
      error ? reject(new Error(String(stderr).trim() || error.message)) : resolve(String(stdout)),
    ),
  )
}

function parse(kind: string, out: string): LinkStatus | null {
  const raw = JSON.parse(out) as { state?: unknown; isDraft?: unknown; title?: unknown }
  const state = String(raw.state ?? '').toLowerCase()
  if (state !== 'open' && state !== 'closed' && state !== 'merged') return null
  return {
    state,
    ...(kind === 'pull' && raw.isDraft === true && { draft: true }),
    ...(typeof raw.title === 'string' && { title: raw.title.slice(0, 200) }),
  }
}

/** Cached pull request and issue states; a refresh looks up only the ones that are missing or older than five minutes. */
export class LinkStatuses {
  readonly #gh: GhRunner
  readonly #now: () => number
  readonly #cache = new Map<string, { at: number; status: LinkStatus | null }>()
  #running: Promise<boolean> | null = null

  constructor(gh: GhRunner, now: () => number) {
    this.#gh = gh
    this.#now = now
  }

  snapshot(): Record<string, LinkStatus> {
    return Object.fromEntries([...this.#cache].flatMap(([url, entry]) => (entry.status ? [[url, entry.status]] : [])))
  }

  /** Look up the stale ones; resolves to whether anything changed. One refresh runs at a time. */
  refresh(urls: readonly string[]): Promise<boolean> {
    if (this.#running) return this.#running
    const due = [...new Set(urls)].filter((url) => GITHUB_ITEM.test(url) && !(this.#now() - (this.#cache.get(url)?.at ?? -Infinity) < TTL_MS)).slice(0, PER_REFRESH)
    if (!due.length) return Promise.resolve(false)
    this.#running = (async () => {
      let changed = false
      for (const url of due) {
        const [, , , kind] = GITHUB_ITEM.exec(url)!
        let status: LinkStatus | null = null
        try {
          status = parse(kind!, await this.#gh(kind === 'pull' ? ['pr', 'view', url, '--json', 'state,isDraft,title'] : ['issue', 'view', url, '--json', 'state,title']))
        } catch {
          // Offline, signed out, or no access: try again after the next interval.
        }
        if (JSON.stringify(status) !== JSON.stringify(this.#cache.get(url)?.status ?? null)) changed = true
        this.#cache.set(url, { at: this.#now(), status })
      }
      return changed
    })().finally(() => {
      this.#running = null
    })
    return this.#running
  }
}
