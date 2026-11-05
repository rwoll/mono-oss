#!/usr/bin/env node
// Check a run's findings.json against the format the Agents QA canvas reads:
//   node check-run.ts <run folder>
// Prints each problem and exits 1, or prints a one-line summary and exits 0.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'

// Parsed JSON from disk or gh; every field is checked before use.
// oxlint-disable-next-line typescript/no-explicit-any
type Json = any

const KEY = /^[a-z0-9][a-z0-9-]{1,79}$/
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SEVERITIES = ['high', 'medium', 'low', 'polish']
const OBSERVATIONS = ['new', 'still-reproduces', 'fixed']
const OUTCOMES = ['fix', 'issue', 'investigate', 'tracked', 'suppress']

const dir = resolve(process.argv[2] ?? '.')
const root = resolve(process.env.AGENTS_QA_ROOT || join(homedir(), 'agents-window-qa'))
const problems: string[] = []
const warnings: string[] = []
const problem = (where: string, message: string) => problems.push(`${where}: ${message}`)

const isString = (value: unknown): value is string => typeof value === 'string'
/** Optional objects must be objects when present; the canvas rejects null, strings, and arrays. */
function object(where: string, value: Json): boolean {
  if (value === undefined) return true
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    problem(where, 'must be an object when present')
    return false
  }
  return true
}
const time = (value: unknown) => isString(value) && !Number.isNaN(Date.parse(value))
const https = (value: unknown) => {
  try {
    return new URL(String(value)).protocol === 'https:'
  } catch {
    return false
  }
}
function text(where: string, value: unknown, max: number, { required = false } = {}): void {
  if (value === undefined && !required) return
  if (!isString(value)) problem(where, 'must be a string')
  else if (required && !value.trim()) problem(where, 'must not be empty')
  else if (value.trim().length > max) problem(where, `is ${value.trim().length} characters; the limit is ${max}`)
}
function list(where: string, value: unknown, max: number): Json[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    problem(where, 'must be an array')
    return []
  }
  if (value.length > max) problem(where, `has ${value.length} entries; the limit is ${max}`)
  return value
}
const real = (path: string) => {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}
const realRoot = real(root) ?? root
function media(where: string, entries: unknown): void {
  list(where, entries, where === 'media' ? 20 : 40).forEach((entry, index) => {
    const at = `${where}[${index}]`
    text(`${at}.path`, entry?.path, 1000, { required: true })
    text(`${at}.label`, entry?.label, 200)
    if (!isString(entry?.path)) return
    const path = isAbsolute(entry.path) ? entry.path : resolve(dir, entry.path)
    const target = real(path)
    if (!target) problem(`${at}.path`, `${path} does not exist`)
    else if (target !== realRoot && !target.startsWith(realRoot + sep)) problem(`${at}.path`, `${path} is outside the QA folder ${root}, so the canvas will not show it`)
  })
}

let run: Json
try {
  run = JSON.parse(readFileSync(join(dir, 'findings.json'), 'utf8'))
} catch (error) {
  console.error(`${join(dir, 'findings.json')}: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

if (run.format !== 'agents-qa-run') problem('format', 'must be "agents-qa-run"')
if (run.version !== 1) problem('version', 'must be 1')
if (!isString(run.id) || !RUN_ID.test(run.id)) problem('id', 'must be letters, digits, ".", "_" or "-", up to 64 characters')
else if (run.id !== basename(dir)) problem('id', `is "${run.id}", but the folder is "${basename(dir)}"`)
if (!['running', 'complete', 'failed'].includes(run.status)) problem('status', 'must be running, complete, or failed')
if (!time(run.startedAt)) problem('startedAt', 'must be an ISO time')
if (run.finishedAt !== undefined && !time(run.finishedAt)) problem('finishedAt', 'must be an ISO time')
if (run.status !== 'running' && run.finishedAt === undefined) warnings.push('finishedAt is missing')
if (run.status === 'failed' && !run.error) problem('error', 'a failed run needs a one-line error')
object('build', run.build)
object('scope', run.scope)
text('error', run.error, 2000)
text('environment', run.environment, 400)
text('summary', run.summary, 6000)
text('build.version', run.build?.version, 80)
text('build.commit', run.build?.commit, 64)
text('report', run.report, 300)
if (run.scope?.since !== undefined && !time(run.scope.since)) problem('scope.since', 'must be an ISO time')
list('scope.prs', run.scope?.prs, 300).forEach((url, index) => https(url) || problem(`scope.prs[${index}]`, 'must be an https URL'))
if (run.scope?.base !== undefined && object('scope.base', run.scope.base)) {
  text('scope.base.commit', run.scope.base.commit, 64, { required: true })
  text('scope.base.version', run.scope.base.version, 80)
  if (run.scope.base.run !== undefined && (!isString(run.scope.base.run) || !RUN_ID.test(run.scope.base.run))) problem('scope.base.run', 'must be a run id')
}
list('scope.skipped', run.scope?.skipped, 500).forEach((entry, index) => {
  if (!https(entry?.pr)) problem(`scope.skipped[${index}].pr`, 'must be an https URL')
  text(`scope.skipped[${index}].reason`, entry?.reason, 200, { required: true })
})
text('scope.area', run.scope?.area, 80)
text('scope.notes', run.scope?.notes, 1000)
media('media', run.media)
list('verified', run.verified, 300).forEach((entry, index) => {
  if (!https(entry?.pr)) problem(`verified[${index}].pr`, 'must be an https URL')
  text(`verified[${index}].note`, entry?.note, 400)
})
if (!existsSync(resolve(dir, isString(run.report) ? run.report : 'REPORT.md'))) warnings.push('the report file does not exist yet')

const keys = new Set<string>()
const ids = new Set<unknown>()
const findings = list('findings', run.findings, 200)
findings.forEach((finding, index) => {
  const at = `findings[${index}]${isString(finding?.id) ? ` (${finding.id})` : ''}`
  text(`${at}.id`, finding?.id, 20, { required: true })
  if (!isString(finding?.key) || !KEY.test(finding.key)) problem(`${at}.key`, 'must be a kebab-case slug of 2 to 80 characters, such as mcp-install-account-changed')
  else if (keys.has(finding.key)) problem(`${at}.key`, `"${finding.key}" is used twice in this run`)
  else keys.add(finding.key)
  if (isString(finding?.id) && ids.has(finding.id)) problem(`${at}.id`, `"${finding.id}" is used twice in this run`)
  ids.add(finding?.id)
  text(`${at}.title`, finding?.title, 200, { required: true })
  if (!SEVERITIES.includes(finding?.severity)) problem(`${at}.severity`, `must be one of ${SEVERITIES.join(', ')}`)
  if (finding?.status !== undefined && !OBSERVATIONS.includes(finding.status)) problem(`${at}.status`, `must be one of ${OBSERVATIONS.join(', ')}`)
  text(`${at}.area`, finding?.area, 60)
  text(`${at}.summary`, finding?.summary, 4000)
  object(`${at}.repro`, finding?.repro)
  text(`${at}.repro.setup`, finding?.repro?.setup, 4000)
  list(`${at}.repro.steps`, finding?.repro?.steps, 40).forEach((step, stepIndex) => text(`${at}.repro.steps[${stepIndex}]`, step, 1000, { required: true }))
  text(`${at}.repro.expected`, finding?.repro?.expected, 2000)
  text(`${at}.repro.actual`, finding?.repro?.actual, 4000)
  list(`${at}.prs`, finding?.prs, 20).forEach((url, urlIndex) => https(url) || problem(`${at}.prs[${urlIndex}]`, 'must be an https URL'))
  media(`${at}.media`, finding?.media)
  list(`${at}.matches`, finding?.matches, 10).forEach((match, matchIndex) => {
    const where = `${at}.matches[${matchIndex}]`
    if (!https(match?.url)) problem(`${where}.url`, 'must be an https URL')
    if (match?.relation !== undefined && !['duplicate', 'related'].includes(match.relation)) problem(`${where}.relation`, 'must be duplicate or related')
    if (match?.state !== undefined && !['open', 'closed'].includes(match.state)) problem(`${where}.state`, 'must be open or closed')
    text(`${where}.note`, match?.note, 400)
  })
  if (finding?.owner !== undefined && object(`${at}.owner`, finding.owner)) {
    if (!isString(finding.owner.login) || !LOGIN.test(finding.owner.login)) problem(`${at}.owner.login`, 'must be a GitHub user name without @')
    text(`${at}.owner.reason`, finding.owner?.reason, 300)
  }
  if (finding?.recommendation !== undefined && object(`${at}.recommendation`, finding.recommendation)) {
    if (!OUTCOMES.includes(finding.recommendation?.outcome)) problem(`${at}.recommendation.outcome`, `must be one of ${OUTCOMES.join(', ')}`)
    text(`${at}.recommendation.reason`, finding.recommendation?.reason, 600)
  }
})

for (const warning of warnings) console.log(`warning: ${warning}`)
if (problems.length) {
  for (const entry of problems) console.log(`problem: ${entry}`)
  process.exit(1)
}
const count = (status: string) => findings.filter((finding) => (finding.status ?? 'new') === status).length
console.log(`OK: ${run.id} is ${run.status} with ${findings.length} findings (${count('new')} new, ${count('still-reproduces')} still reproducing, ${count('fixed')} fixed).`)
