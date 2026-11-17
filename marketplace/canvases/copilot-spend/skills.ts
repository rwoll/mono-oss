import { dirname } from 'node:path'

// Whether a session used a skill it loaded is not recorded, so it is worked out: a skill
// counts as used when, after it was loaded, the agent ran or read something in the
// skill's folder, called a tool the skill names, or used a name that the skill's
// instructions give in code formatting. A skill that names nothing cannot be judged.

const MAX_MARKERS = 80
/** Names so common in any repository that seeing one says nothing about a skill. */
const COMMON = new Set([
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'node_modules', 'README.md', 'SKILL.md', 'AGENTS.md',
  'CHANGELOG.md', 'LICENSE.md', '.gitignore', 'index.ts', 'index.js', 'index.html', 'main.ts', 'App.tsx', 'vite.config.ts', 'github.com', 'origin/main',
  'e.g.', 'i.e.', 'etc.', 'co-authored-by', 'user-facing', 'read-only',
])

const NAME = /^[@A-Za-z0-9][\w@/.:+-]*$/
const SEPARATED = /[A-Za-z0-9][-_/.:][A-Za-z0-9]/
const CAMEL = /[a-z][A-Z]/
const COMMAND = /^[a-z][a-z0-9]*(?: [a-z][a-z0-9-]*){1,3}$/

/** A name specific enough that a tool call containing it very likely follows the skill. */
function distinctive(token: string): boolean {
  if (token.length < 6 || token.length > 80 || !NAME.test(token)) return false
  if (/^\d[\d.]*$/.test(token) || /^https?:/i.test(token) || COMMON.has(token)) return false
  return SEPARATED.test(token) || CAMEL.test(token)
}

const trim = (token: string) => token.replace(/^["'([{]+/, '').replace(/["')\]},;:.!?]+$/, '')

/** The names a skill's instructions give in code formatting, to look for in later tool calls. */
export function skillMarkers(content: string): string[] {
  const body = content.replace(/^---\n[\s\S]*?\n---\n/, '')
  const found = new Set<string>()
  const add = (code: string, inline: boolean) => {
    // A placeholder such as `<owner>/<repo>` names nothing.
    const text = code.trim()
    if (inline && text.length >= 8 && text.length <= 60 && COMMAND.test(text)) found.add(text)
    for (const raw of text.split(/\s+/)) {
      const token = trim(raw)
      if (!/[<>…*$]/.test(token) && distinctive(token)) found.add(token)
    }
  }
  const prose = body.replace(/^\s*(```|~~~)[^\n]*\n([\s\S]*?)^\s*\1\s*$/gm, (_all, _fence, code: string) => {
    for (const line of code.split('\n')) add(line, false)
    return ''
  })
  for (const match of prose.matchAll(/`([^`\n]+)`/g)) add(match[1] as string, true)
  return [...found].slice(0, MAX_MARKERS)
}

/** The folder a skill's file is in, as it appears in a tool call that runs or reads something from it. */
export const skillFolder = (path: string) => (path ? `${dirname(path)}/` : '')

/** What in a tool call shows the skill being used: a marker, the skill's folder, or null. */
export function signOfUse(markers: readonly string[], folder: string, toolName: string, args: string): string | null {
  if (folder && args.includes(folder)) return 'its folder'
  for (const marker of markers) {
    if (toolName === marker || args.includes(marker)) return marker
  }
  return null
}
