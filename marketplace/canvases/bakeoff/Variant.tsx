import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { Markdown } from '../../ui'
import { client, track, useContent } from './hooks.ts'
import { Mock } from './Mock.tsx'
import { Pins, type Pin } from './Pins.tsx'
import type { Anchor, Entry, Mark, Variant } from './schema.ts'
import { madeWith, MAX_NOTE, MAX_QUOTE, VOTES, type Vote } from './shared.ts'

export type Backdrop = 'light' | 'dark' | 'checker'

export interface ViewOptions {
  /** What is behind images, videos, and HTML mocks. */
  backdrop: Backdrop
  /** Show Markdown and HTML as their source. */
  source: boolean
}

const VOTE_BUTTON: Record<Vote, string> = { pick: 'Pick', keep: 'Keep', drop: 'Drop' }

interface PreviewProps extends ViewOptions {
  bakeoff: string
  variant: Variant
  /** Pins on an image or a mock. Clicking one removes it, when the round can be edited. */
  pins?: readonly Pin[]
  /** A click on an image or a mock: where, and on a mock, what it landed on. */
  onPin?: ((x: number, y: number, on?: { on: string; anchor?: Anchor }) => void) | undefined
  onUnpin?: ((n: number) => void) | undefined
  /** The text selected in a mock, or an empty string. */
  onSelect?: ((text: string) => void) | undefined
}

/** A variant, shown as what it is: an image or video on a backdrop, rendered Markdown, a sandboxed HTML page, or text. */
export function Preview({ bakeoff, variant, backdrop, source, pins = [], onPin, onUnpin, onSelect }: PreviewProps) {
  const { content, error } = useContent(bakeoff, variant)
  const name = `Variant ${variant.label}`
  if (error) return <p className="error preview-message">{error}</p>

  if (variant.kind === 'image' || variant.kind === 'video') {
    const svg = variant.file.endsWith('.svg')
    if (svg && content === undefined) return <p className="notice preview-message">Loading…</p>
    const src = svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content as string)}` : client().fileUrl(variant.id)
    const pin = (event: MouseEvent<HTMLImageElement>) => {
      const box = event.currentTarget.getBoundingClientRect()
      if (box.width && box.height) onPin?.(Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1), Math.min(Math.max((event.clientY - box.top) / box.height, 0), 1))
    }
    return (
      <div className={`preview media bd-${backdrop}`}>
        {variant.kind === 'video' ? (
          <video src={src} controls preload="metadata" aria-label={name} />
        ) : (
          <span className={`shot${onPin ? ' pinnable' : ''}`}>
            <img src={src} alt={name} onClick={onPin ? pin : undefined} />
            <Pins pins={pins} onUnpin={onUnpin} />
          </span>
        )}
      </div>
    )
  }

  if (content === undefined) return <p className="notice preview-message">Loading…</p>
  if (variant.kind === 'html' && !source) return <Mock name={name} content={content} scheme={backdrop === 'dark' ? 'dark' : 'light'} pins={pins} onPin={onPin} onUnpin={onUnpin} onSelect={onSelect} />
  return (
    <div className="preview doc" data-quotable>
      {variant.kind === 'markdown' && !source ? <Markdown>{content}</Markdown> : <pre className="source">{content}</pre>}
    </div>
  )
}

/** A note that saves when the user pauses or leaves it, and follows the saved value when they are not typing. */
function NoteField({ value, onSave, label, placeholder, disabled, single, field }: { value: string; onSave: (text: string) => Promise<unknown>; label: string; placeholder: string; disabled: boolean; single?: boolean; field?: React.RefObject<HTMLTextAreaElement | null> }) {
  const [draft, setDraft] = useState<string | null>(null)
  const [focused, setFocused] = useState(false)
  const [seen, setSeen] = useState(value)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // The saved value changed: show it, unless the user is in the middle of typing something else.
  if (seen !== value) {
    setSeen(value)
    if (!focused || draft === value) setDraft(null)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  const save = (text: string) => {
    clearTimeout(timer.current)
    if (text !== value) void track(onSave(text))
  }
  const props = {
    'aria-label': label,
    placeholder,
    disabled,
    maxLength: MAX_NOTE,
    value: draft ?? value,
    onFocus: () => setFocused(true),
    onChange: (event: { target: { value: string } }) => {
      const text = event.target.value
      setDraft(text)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => save(text), 700)
    },
    onBlur: () => {
      setFocused(false)
      if (draft !== null) save(draft)
    },
  }
  return single ? <input type="text" {...props} /> : <textarea rows={2} ref={field} {...props} />
}

export { NoteField }

/** Opens a variant alone, as large as the panel allows. */
export function ExpandButton({ variant, onExpand }: { variant: Variant; onExpand: () => void }) {
  return (
    <button type="button" className="expand" aria-label={`Expand ${variant.label}`} title="Show this variant alone, as large as the panel allows" onClick={onExpand}>
      Expand
    </button>
  )
}

export interface CardActions {
  vote(variant: string, vote: Vote | null): void
  note(variant: string, note: string): Promise<unknown>
  mark(variant: string, mark: { x: number; y: number; on?: string; anchor?: Anchor } | { quote: string }): Promise<unknown>
  unmark(variant: string, n: number): void
}

export interface ReviewProps extends ViewOptions {
  bakeoff: string
  variant: Variant
  entry: Entry
  /** An earlier round: what was decided, with nothing to change. */
  readOnly: boolean
  actions: CardActions
}

/** A variant with what the user says about it: the preview to pin and quote, the vote, and the note. */
export function Review({ bakeoff, variant, entry, readOnly, actions, ...view }: ReviewProps) {
  const body = useRef<HTMLDivElement>(null)
  const note = useRef<HTMLTextAreaElement>(null)
  // Text selected inside this variant can become a quote the note refers to: on this page, or in a mock's frame.
  const [onPage, setOnPage] = useState('')
  const [inMock, setInMock] = useState('')
  const selected = inMock || onPage
  const pins = entry.marks.filter((mark): mark is Pin => 'x' in mark)
  const quotes = entry.marks.filter((mark): mark is Extract<Mark, { quote: string }> => 'quote' in mark)

  useEffect(() => {
    if (readOnly) return
    const onSelection = () => {
      const selection = document.getSelection()
      const box = body.current?.querySelector('[data-quotable]')
      const inside = selection && !selection.isCollapsed && box && box.contains(selection.anchorNode) && box.contains(selection.focusNode)
      setOnPage(inside ? selection.toString().replace(/\s+/g, ' ').trim().slice(0, MAX_QUOTE) : '')
    }
    document.addEventListener('selectionchange', onSelection)
    return () => document.removeEventListener('selectionchange', onSelection)
  }, [readOnly])

  const mark = async (spot: { x: number; y: number; on?: string; anchor?: Anchor } | { quote: string }) => {
    await actions.mark(variant.id, spot)
    if ('quote' in spot) body.current?.querySelector('iframe')?.contentDocument?.getSelection()?.removeAllRanges()
    // The note now ends with the mark's number: continue typing there.
    const field = note.current
    if (!field) return
    field.focus()
    field.setSelectionRange(field.value.length, field.value.length)
  }

  return (
    <>
      <div className="variant-body" ref={body}>
        <Preview
          bakeoff={bakeoff}
          variant={variant}
          {...view}
          pins={pins}
          onPin={readOnly ? undefined : (x, y, on) => void mark({ x, y, ...(on?.on ? { on: on.on } : {}), ...(on?.anchor ? { anchor: on.anchor } : {}) })}
          onUnpin={readOnly ? undefined : (n) => actions.unmark(variant.id, n)}
          onSelect={readOnly ? undefined : setInMock}
        />
      </div>
      {selected && (
        <button type="button" className="quote-button" onMouseDown={(event) => event.preventDefault()} onClick={() => void mark({ quote: selected })}>
          Comment on the selected text
        </button>
      )}
      {quotes.length > 0 && (
        <ul className="quotes" aria-label={`Quotes from ${variant.label}`}>
          {quotes.map((quote) => (
            <li key={quote.n}>
              <span className="pin inline">{quote.n}</span>
              <q>{quote.quote}</q>
              {!readOnly && (
                <button type="button" className="link" aria-label={`Remove quote ${quote.n}`} onClick={() => actions.unmark(variant.id, quote.n)}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <div className="votes" role="group" aria-label={`Vote on ${variant.label}`}>
          {VOTES.map((vote) => (
            <button key={vote} type="button" data-vote={vote} aria-pressed={entry.vote === vote} onClick={() => actions.vote(variant.id, entry.vote === vote ? null : vote)}>
              {VOTE_BUTTON[vote]}
            </button>
          ))}
        </div>
      )}
      {readOnly ? (
        entry.note.trim() && <p className="said">{entry.note.trim()}</p>
      ) : (
        <NoteField value={entry.note} onSave={(text) => actions.note(variant.id, text)} label={`Note on ${variant.label}`} placeholder="What works, what doesn't" disabled={false} field={note} />
      )}
    </>
  )
}

interface CardProps extends ReviewProps {
  /** Hide what made the variant. */
  blind: boolean
  onExpand(): void
}

/** One variant in the grid: what it is, the vote, and the note with its pins and quotes. */
export function VariantCard({ blind, onExpand, ...review }: CardProps) {
  const { variant, entry, readOnly } = review
  const made = blind ? '' : madeWith(variant)
  let status: ReactNode = null
  if (entry.vote === 'pick') status = <span className="pill status-done">Winner</span>
  else if (readOnly && entry.vote) status = <span className={`pill ${entry.vote === 'keep' ? 'status-working' : 'status-blocked'}`}>{entry.vote === 'keep' ? 'Kept' : 'Dropped'}</span>

  return (
    <article className={`variant${entry.vote === 'pick' ? ' winner' : ''}${entry.vote === 'drop' ? ' dropped' : ''}`} aria-label={`Variant ${variant.label}`}>
      <div className="variant-head">
        <span className="letter">{variant.label}</span>
        {status}
        {entry.carried && <span className="muted">from round {variant.round}</span>}
        {made && (
          <span className="made muted" title={made}>
            {made}
          </span>
        )}
        <ExpandButton variant={variant} onExpand={onExpand} />
      </div>
      <Review {...review} />
    </article>
  )
}
