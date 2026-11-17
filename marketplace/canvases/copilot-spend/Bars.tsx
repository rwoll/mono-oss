import type { ReactNode } from 'react'
import { READ_LABELS, READ_PARTS, percent, type ReadPart, type ReadSplit } from './shared.ts'

// The bars every section draws. A bar is a picture with a text alternative; each color
// it uses is named in a legend beside it.

export interface Segment {
  key: string
  share: number
  /** The color and pattern, as a class in App.css. */
  tone: string
  label: string
  /** Text drawn inside the segment when it is wide enough. */
  text?: string
}

export function Bar({ segments, label, className = '' }: { segments: readonly Segment[]; label: string; className?: string }) {
  const shown = segments.filter((segment) => segment.share > 0)
  return (
    <div className={`bar ${className}`} role="img" aria-label={`${label}: ${shown.map((segment) => `${segment.label} ${percent(segment.share)}`).join(', ') || 'nothing'}`}>
      {shown.map((segment) => (
        <span key={segment.key} className={`seg ${segment.tone}`} style={{ flexGrow: segment.share }} title={`${segment.label} ${percent(segment.share)}`}>
          {segment.text && segment.share >= 0.08 ? segment.text : null}
        </span>
      ))}
    </div>
  )
}

const TONES: Record<ReadPart, string> = { base: 'tone-base', conversation: 'tone-conversation', output: 'tone-output', skills: 'tone-skills', mcpDefs: 'tone-mcp', mcpResults: 'tone-results' }

/** What the model read, with the skills and MCP tool definitions that went unused hatched. */
function readSegments(read: ReadSplit, parts: readonly ReadPart[] = READ_PARTS, text = false): Segment[] {
  return parts.flatMap((part): Segment[] => {
    const unused = part === 'skills' ? read.unusedSkills : part === 'mcpDefs' ? read.unusedMcp : 0
    const used = Math.max(0, read[part] - unused)
    return [
      { key: part, share: used, tone: TONES[part], label: unused ? `${READ_LABELS[part]}, used` : READ_LABELS[part], ...(text && { text: percent(read[part]) }) },
      { key: `${part}-unused`, share: unused, tone: `${TONES[part]} unused`, label: `${READ_LABELS[part]}, loaded and not used` },
    ]
  })
}

export function ReadBar({ read, label, parts, text }: { read: ReadSplit; label: string; parts?: readonly ReadPart[]; text?: boolean }) {
  return <Bar className="read" label={label} segments={readSegments(read, parts, text)} />
}

export function Key({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span className="key">
      <i className={`swatch ${tone}`} aria-hidden="true" />
      {children}
    </span>
  )
}

/** The legend for a `ReadBar`, with each part's share when `read` is given. */
export function ReadLegend({ read, parts = READ_PARTS, lead }: { read?: ReadSplit; parts?: readonly ReadPart[]; lead?: string }) {
  const unused = read ? read.unusedSkills + read.unusedMcp : 0
  return (
    <p className="legend">
      {lead && <span>{lead}</span>}
      {parts.map((part) => (
        <Key key={part} tone={TONES[part]}>
          {READ_LABELS[part]}
          {read && ` ${percent(read[part])}`}
        </Key>
      ))}
      <Key tone="tone-skills unused">
        loaded and not used
        {read && ` ${percent(unused)}`}
        {read && unused > 0 && `: skills ${percent(read.unusedSkills)}, MCP ${percent(read.unusedMcp)}`}
      </Key>
    </p>
  )
}

/** A thin bar for one share of a whole, under a number. */
export function Meter({ share, tone = '', hatched = 0 }: { share: number; tone?: string; hatched?: number }) {
  const width = (value: number) => `${Math.min(100, Math.max(0, value * 100))}%`
  return (
    <span className="meter" aria-hidden="true">
      {hatched > 0 && <i className={`${tone} unused`} style={{ width: width(hatched) }} />}
      <i className={tone} style={{ width: width(share - hatched) }} />
    </span>
  )
}
