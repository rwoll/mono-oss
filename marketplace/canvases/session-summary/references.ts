// GitHub issue and pull request URLs, exactly: no sub-pages such as /files, and no fragments.
const REFERENCE = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\/(?:pull|issues)\/(\d+)\/?(?:\?[^\s#]*)?$/

// Code blocks, code spans, and Markdown links are kept as written; <url> and bare URLs are candidates.
const TOKENS = /(```|~~~)[\s\S]*?(?:\1|$)|(`+)[\s\S]*?\2|!?\[[^\]\n]*\]\([^)\n]*\)|<(https?:\/\/[^\s>]+)>|https?:\/\/[^\s<>()[\]`]+/g
const TRAILING = /[.,;:!?'"*_~]+$/

/** `owner/repo#42` for a GitHub issue or pull request URL, or undefined for any other text. */
export function shortReference(url: string): string | undefined {
  const match = REFERENCE.exec(url)
  return match ? `${match[1]}/${match[2]}#${match[3]}` : undefined
}

/**
 * Turn GitHub issue and pull request URLs in Markdown into short `owner/repo#42`
 * links. Other hosts, sub-pages, fragments, code, and links with their own label
 * stay as written.
 */
export function linkReferences(markdown: string): string {
  return markdown.replace(TOKENS, (token, _fence, _ticks, bracketed: string | undefined) => {
    if (bracketed !== undefined) {
      const label = shortReference(bracketed)
      return label ? `[${label}](${bracketed})` : token
    }
    if (!/^https?:/.test(token)) return token
    const trailing = TRAILING.exec(token)?.[0] ?? ''
    const url = token.slice(0, token.length - trailing.length)
    const label = shortReference(url)
    return label ? `[${label}](${url})${trailing}` : token
  })
}

export type TextPart = string | { url: string; label: string }

// `<url>` or a bare URL. Backticks end a URL, since agents often quote one that way.
const PLAIN_URL = /<(https?:\/\/[^\s<>]+)>|(https?:\/\/[^\s<>`]*[^\s<>`.,:;"')\]!?*_~])/g

/**
 * Plain text exactly as written, except that GitHub issue and pull request URLs
 * become short `owner/repo#42` links. For the headline and list items, which are
 * not Markdown.
 */
export function referenceParts(text: string): TextPart[] {
  const parts: TextPart[] = []
  let last = 0
  for (const match of text.matchAll(PLAIN_URL)) {
    const url = match[1] ?? match[2]!
    const label = shortReference(url)
    if (!label) continue
    if (match.index > last) parts.push(text.slice(last, match.index))
    parts.push({ url, label })
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}
