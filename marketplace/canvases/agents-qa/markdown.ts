// A small Markdown subset for text QA runs write: paragraphs, bullet and numbered lists, fenced code,
// **bold**, *emphasis*, `code`, [links](https://…), and bare URLs. Only http and https links are kept,
// and GitHub issue and pull request URLs read as owner/repo#123. It builds data, never HTML.

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong' | 'em'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }

export type Block = { kind: 'p'; lines: string[] } | { kind: 'ul' | 'ol'; items: string[] } | { kind: 'code'; text: string }

const GITHUB_REF = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9_-]{0,38})\/((?!\.{1,2}$)[A-Za-z0-9._-]{1,100})\/(?:pull|issues)\/([1-9]\d{0,8})\/?$/
const INLINE = new RegExp(
  [
    /`(?<code>[^`\n]+)`/.source,
    /\*\*(?<strong>.+?)\*\*/.source,
    /(?<![\w*])\*(?!\s)(?<em>[^*\n]+?)\*(?![\w*])/.source,
    /\[(?<label>[^\]\n]+)\]\((?<labelHref>https?:\/\/[^\s)]+)\)/.source,
    // Other links, such as relative paths in a report, keep only their label.
    /\[(?<localLabel>[^\]\n]+)\]\((?<localHref>[^\s()]+)\)/.source,
    /<(?<auto>https?:\/\/[^\s>]+)>/.source,
    /(?<bare>https?:\/\/[^\s<>()`]*[^\s<>()`.,;:!?'"])/.source,
  ].join('|'),
  'g',
)
const BULLET = /^\s*[-*]\s+(.*)$/
const NUMBERED = /^\s*\d{1,3}[.)]\s+(.*)$/
const FENCE = /^\s*(`{3,}|~{3,})/

export function safeHref(href: string): string | null {
  try {
    const url = new URL(href)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

/** `owner/repo#123` for a GitHub issue or pull request URL, otherwise null. */
export function githubRef(href: string): string | null {
  const match = GITHUB_REF.exec(href)
  return match ? `${match[1]}/${match[2]}#${match[3]}` : null
}

export function parseInline(text: string, depth = 0): Inline[] {
  if (depth > 4) return [{ kind: 'text', text }]
  const out: Inline[] = []
  let last = 0
  for (const match of text.matchAll(INLINE)) {
    const start = match.index
    if (start > last) out.push({ kind: 'text', text: text.slice(last, start) })
    last = start + match[0].length
    const { code, strong, em, label, labelHref, localLabel, auto, bare } = match.groups!
    if (code !== undefined) out.push({ kind: 'code', text: code })
    else if (strong !== undefined) out.push({ kind: 'strong', children: parseInline(strong, depth + 1) })
    else if (em !== undefined) out.push({ kind: 'em', children: parseInline(em, depth + 1) })
    else if (localLabel !== undefined) out.push(...parseInline(localLabel, depth + 1))
    else if (label !== undefined) {
      const href = safeHref(labelHref!)
      out.push(href ? { kind: 'link', href, children: parseInline(label, depth + 1) } : { kind: 'text', text: label })
    } else {
      const raw = (auto ?? bare)!
      const href = safeHref(raw)
      out.push(href ? { kind: 'link', href, children: [{ kind: 'text', text: githubRef(raw) ?? raw }] } : { kind: 'text', text: raw })
    }
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}

/** The text of inline Markdown without its markup, for places that show plain text. */
export function plainText(text: string): string {
  const flatten = (nodes: Inline[]): string => nodes.map((node) => ('children' in node ? flatten(node.children) : node.text)).join('')
  return flatten(parseInline(text))
}

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = []
  let fence: { marker: string; lines: string[] } | null = null
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (fence) {
      if (raw.trim().startsWith(fence.marker) && raw.trim().replace(/[`~]/g, '') === '') {
        blocks.push({ kind: 'code', text: fence.lines.join('\n') })
        fence = null
      } else fence.lines.push(raw)
      continue
    }
    const opening = FENCE.exec(raw)
    if (opening) {
      fence = { marker: opening[1]!, lines: [] }
      continue
    }
    const line = raw.trimEnd()
    const current = blocks.at(-1)
    const bullet = BULLET.exec(line)
    const numbered = bullet ? null : NUMBERED.exec(line)
    if (!line.trim()) blocks.push({ kind: 'p', lines: [] })
    else if (bullet || numbered) {
      const kind = bullet ? 'ul' : 'ol'
      const item = (bullet ?? numbered)![1]!
      if (current?.kind === kind) current.items.push(item)
      else blocks.push({ kind, items: [item] })
    } else if (current && (current.kind === 'ul' || current.kind === 'ol') && /^\s{2,}\S/.test(raw)) {
      // An indented line continues the previous list item.
      current.items[current.items.length - 1] += ` ${line.trim()}`
    } else if (current?.kind === 'p') current.lines.push(line.trim())
    else blocks.push({ kind: 'p', lines: [line.trim()] })
  }
  // An unclosed fence still shows its text.
  if (fence) blocks.push({ kind: 'code', text: fence.lines.join('\n') })
  return blocks.filter((block) => block.kind !== 'p' || block.lines.length > 0)
}
