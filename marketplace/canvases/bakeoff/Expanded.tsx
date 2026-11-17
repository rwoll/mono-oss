import { useEffect, useRef, type KeyboardEvent } from 'react'
import type { Variant } from './schema.ts'
import { Preview, Review, type ReviewProps, type ViewOptions } from './Variant.tsx'

interface ExpandedProps extends ViewOptions {
  bakeoff: string
  /** The variants to flip between, in the order they are on screen. */
  variants: readonly Variant[]
  current: Variant
  /** The current variant's vote and note, to change here too. Head to head leaves it out, and only shows the variant. */
  review?: Pick<ReviewProps, 'entry' | 'readOnly' | 'actions'> | undefined
  onShow(variant: string): void
  onClose(): void
}

/** One variant alone, as large as the panel allows, with its vote and note below it. */
export function Expanded({ bakeoff, variants, current, review, onShow, onClose, ...view }: ExpandedProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (!dialog.current || dialog.current.open) return
    dialog.current.showModal()
    // Focus stays on the dialog, not on a letter, so the arrow keys work at once and no letter looks chosen.
    dialog.current.focus()
  }, [])

  const onKey = (event: KeyboardEvent) => {
    // A key typed in a mock arrives here from its frame, where the dialog's own Esc does not reach.
    if (event.key === 'Escape') return dialog.current?.close()
    const by = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
    // A note uses the arrow keys to move in its text, and a video's own controls to seek.
    const busy = event.target instanceof HTMLElement && event.target.matches('input, textarea, select, video')
    if (!by || variants.length < 2 || event.metaKey || event.ctrlKey || event.altKey || busy) return
    event.preventDefault()
    const at = variants.findIndex((variant) => variant.id === current.id)
    onShow((variants[(at + by + variants.length) % variants.length] as Variant).id)
  }

  return (
    <dialog ref={dialog} tabIndex={-1} className="dialog expanded" aria-label={`Variant ${current.label}, expanded`} onClose={onClose} onKeyDown={onKey}>
      <div className="expanded-bar">
        {variants.length > 1 ? (
          <div className="segmented" role="group" aria-label="Variant">
            {variants.map((variant) => (
              <button key={variant.id} type="button" aria-pressed={variant.id === current.id} aria-label={`Show ${variant.label}`} onClick={() => onShow(variant.id)}>
                {variant.label}
              </button>
            ))}
          </div>
        ) : (
          <span className="letter">{current.label}</span>
        )}
        <span className="muted keys">{variants.length > 1 ? '← → to switch · Esc to close' : 'Esc to close'}</span>
        <button type="button" onClick={() => dialog.current?.close()}>
          Close
        </button>
      </div>
      {review ? <Review key={current.id} bakeoff={bakeoff} variant={current} {...review} {...view} /> : <Preview bakeoff={bakeoff} variant={current} {...view} />}
    </dialog>
  )
}
