#!/usr/bin/env node
// The pull requests a run should look at: every PR merged into microsoft/vscode main whose merge commit is in
// this build but was not in the build the last run tested. Choosing by build, not by date, means no PR falls
// between runs, and a PR merged after this build was made is picked up by the next run.
//   node pick-prs.ts <this build's commit> [--base <commit>] [--out <file>]
// Without --base, the base is the last complete run's build, or the build of 24 hours earlier on a first run.
// Writes the full list as JSON to --out (or prints it) and prints a summary. Needs the gh CLI, signed in.
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

// Parsed JSON from disk or gh; every field is checked before use.
// oxlint-disable-next-line typescript/no-explicit-any
type Json = any

const REPO = 'microsoft/vscode'
const SHA = /^[0-9a-f]{7,40}$/
const DAY_MS = 24 * 60 * 60 * 1000
// Paths whose changes show up in the Agents window. A hint for the agent, which makes the final call.
const AGENTS_PATHS = [
  'src/vs/sessions/',
  'src/vs/workbench/contrib/chat/',
  'src/vs/platform/agentHost/',
  'src/vs/workbench/services/agentHost/',
  'src/vs/workbench/contrib/mcp/',
  'src/vs/platform/mcp/',
  'extensions/copilot/',
]
const TEST_FILE = /(^|\/)(test|tests|__tests__|fixtures?)\/|\.(test|spec|integrationTest)\.[cm]?[jt]sx?$|\.snap$/
const ENGINEERING_FILE = /^(build|\.github|\.vscode|\.devcontainer|scripts|test|cli\/build)\/|^(package(-lock)?\.json|\.nvmrc|\.npmrc|cgmanifest\.json|eslint\.config\.\w+|[^/]+\.md)$/

const { values, positionals } = parseArgs({ allowPositionals: true, options: { base: { type: 'string' }, out: { type: 'string' } } })
const build = positionals[0]
if (!build || !SHA.test(build) || (values.base && !SHA.test(values.base))) {
  console.error('usage: node pick-prs.ts <this build commit> [--base <commit>] [--out <file>]')
  process.exit(2)
}

function gh(args: string[]): string {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } })
  } catch (error) {
    const failure = error as { stderr?: string; message?: string }
    console.error(`gh ${args.slice(0, 3).join(' ')} failed: ${String(failure.stderr || failure.message).trim()}`)
    process.exit(1)
  }
}
const commitDate = (sha: string) => gh(['api', `repos/${REPO}/commits/${sha}`, '--jq', '.commit.committer.date']).trim()
const fullSha = (sha: string) => gh(['api', `repos/${REPO}/commits/${sha}`, '--jq', '.sha']).trim()

function lastRun(): Json {
  const root = process.env.AGENTS_QA_ROOT || join(homedir(), 'agents-window-qa')
  let names: string[] = []
  try {
    names = readdirSync(join(root, 'runs'))
  } catch {
    return null
  }
  const runs = names
    .map((name) => {
      try {
        return JSON.parse(readFileSync(join(root, 'runs', name, 'findings.json'), 'utf8'))
      } catch {
        return null
      }
    })
    .filter((run) => run?.format === 'agents-qa-run' && run.status === 'complete' && SHA.test(run.build?.commit ?? '') && !Number.isNaN(Date.parse(run.startedAt)))
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
  return runs[0] ?? null
}

const buildSha = fullSha(build)
const buildDate = commitDate(buildSha)
let base: Json
if (values.base) base = { commit: fullSha(values.base), how: 'given' }
else {
  const previous = lastRun()
  if (previous) base = { commit: fullSha(previous.build.commit), version: previous.build.version || undefined, run: previous.id, how: 'the last run’s build' }
  else {
    const until = new Date(Date.parse(buildDate) - DAY_MS).toISOString()
    const sha = gh(['api', `repos/${REPO}/commits?sha=${buildSha}&until=${until}&per_page=1`, '--jq', '.[0].sha']).trim()
    base = { commit: sha, how: 'the build of 24 hours earlier (no earlier run)' }
  }
}
base.date = commitDate(base.commit)

// Every commit in this build that is not in the base.
const inBuild = new Set(
  base.commit === buildSha
    ? []
    : gh(['api', '--paginate', `repos/${REPO}/compare/${base.commit}...${buildSha}?per_page=100`, '--jq', '.commits[].sha'])
        .split('\n')
        .filter(Boolean),
)

// PRs merged since shortly before the base was made; the merge commit decides which build has them.
const from = new Date(Date.parse(base.date) - 2 * DAY_MS).toISOString().slice(0, 10)
const merged: Json[] = JSON.parse(
  gh(['pr', 'list', '-R', REPO, '--state', 'merged', '--base', 'main', '--search', `merged:>=${from}`, '--limit', '1000', '--json', 'number,title,url,mergedAt,mergeCommit,author']),
)
const picked = merged.filter((pr) => inBuild.has(pr.mergeCommit?.oid)).sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt))
const notYetInBuild = merged.filter((pr) => !inBuild.has(pr.mergeCommit?.oid) && Date.parse(pr.mergedAt) > Date.parse(buildDate)).length

// Changed files, 50 PRs per GraphQL request.
const files = new Map<number, string[]>()
for (let index = 0; index < picked.length; index += 50) {
  const batch = picked.slice(index, index + 50)
  const fields = batch.map((pr) => `p${pr.number}: pullRequest(number: ${pr.number}) { files(first: 100) { nodes { path } } }`).join(' ')
  const data = JSON.parse(gh(['api', 'graphql', '-f', `query=query { repository(owner: "microsoft", name: "vscode") { ${fields} } }`]))
  for (const pr of batch) files.set(pr.number, (data.data.repository[`p${pr.number}`]?.files?.nodes ?? []).map((node: Json) => node.path))
}

function relevance(paths: string[]): string {
  const code = paths.filter((path) => !TEST_FILE.test(path))
  if (code.some((path) => AGENTS_PATHS.some((prefix) => path.startsWith(prefix)))) return 'agents-window'
  if (paths.length && !code.length) return 'test-only'
  if (paths.length && paths.every((path) => ENGINEERING_FILE.test(path) || TEST_FILE.test(path))) return 'engineering'
  return 'other'
}
const dirs = (paths: string[]) => [...new Set(paths.map((path) => path.split('/').slice(0, 5).join('/')))].slice(0, 6)

const prs = picked.map((pr) => {
  const paths = files.get(pr.number) ?? []
  return { url: pr.url, number: pr.number, title: pr.title, mergedAt: pr.mergedAt, author: pr.author?.login ?? null, relevance: relevance(paths), paths: dirs(paths) }
})
const result = {
  base: { commit: base.commit, date: base.date, ...(base.version && { version: base.version }), ...(base.run && { run: base.run }), how: base.how },
  build: { commit: buildSha, date: buildDate },
  notYetInBuild,
  prs,
}

if (values.out) writeFileSync(values.out, `${JSON.stringify(result, null, 2)}\n`)
else console.log(JSON.stringify(result, null, 2))

const count = (kind: string) => prs.filter((pr) => pr.relevance === kind).length
const short = (sha: string) => sha.slice(0, 8)
const log = values.out ? console.log : console.error
log(`Base: ${short(base.commit)}, ${base.how}${base.run ? ` (run ${base.run})` : ''}, made ${base.date}.`)
log(`This build: ${short(buildSha)}, made ${buildDate}.`)
if (!prs.length) log('No PRs are in this build that were not in the base. Spend the run on exploration and re-checks.')
else {
  log(`${prs.length} PRs are in this build and not the base: ${count('agents-window')} touch the Agents window, ${count('other')} other, ${count('test-only')} test-only, ${count('engineering')} engineering.`)
  for (const pr of prs.filter((entry) => entry.relevance === 'agents-window')) log(`  #${pr.number}  ${pr.title}`)
}
if (notYetInBuild) log(`${notYetInBuild} merged PRs are not in this build yet; the next run picks them up.`)
if (values.out) log(`Full list: ${values.out}`)
