import { useEffect, useRef, type KeyboardEvent } from 'react'
import { useKeysBack } from './hooks.ts'
import type { Mark, Variant } from './schema.ts'
import { Preview, type ViewOptions } from './Variant.tsx'

interface ExpandedProps extends ViewOptions {
  bakeoff: string
  /** The variants to flip between, in the order they are on screen. */
  variants: readonly Variant[]
  current: Variant
  /** The current variant's pins, to look at: notes are written in the grid. */
  pins?: readonly Extract<Mark, { x: number }>[] | undefined
  onShow(variant: string): void
  onClose(): void
}

/** One variant alone, as large as the panel allows. It only shows: votes and notes stay where they were. */
export function Expanded({ bakeoff, variants, current, pins, onShow, onClose, ...view }: ExpandedProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (!dialog.current || dialog.current.open) return
    dialog.current.showModal()
    // Focus stays on the dialog, not on a letter, so the arrow keys work at once and no letter looks chosen.
    dialog.current.focus()
  }, [])
  useKeysBack(() => dialog.current?.focus())

  const flip = (event: KeyboardEvent) => {
    const by = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
    // A video's own controls use the arrow keys to seek.
    if (!by || variants.length < 2 || event.metaKey || event.ctrlKey || event.altKey || event.target instanceof HTMLVideoElement) return
    event.preventDefault()
    const at = variants.findIndex((variant) => variant.id === current.id)
    onShow((variants[(at + by + variants.length) % variants.length] as Variant).id)
  }

  return (
    <dialog ref={dialog} tabIndex={-1} className="dialog expanded" aria-label={`Variant ${current.label}, expanded`} onClose={onClose} onKeyDown={flip}>
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
      <Preview bakeoff={bakeoff} variant={current} {...view} {...(pins ? { pins } : {})} />
    </dialog>
  )
}
