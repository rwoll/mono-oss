import { useEffect, useState } from 'react'
import type { Variant } from './schema.ts'
import { Preview, type ViewOptions } from './Variant.tsx'

interface DuelProps extends ViewOptions {
  bakeoff: string
  /** The variants still in the running, in the round's order. */
  variants: readonly Variant[]
  /** The variant that won every match it played. */
  onWinner(variant: string): void
  onDone(): void
}

/**
 * Two variants at a time: the one the user would rather get stays and meets the next, so N variants
 * take N - 1 matches. It shows no votes, notes, or what made a variant, so nothing sways the pick.
 */
export function Duel({ bakeoff, variants, onWinner, onDone, ...view }: DuelProps) {
  const [match, setMatch] = useState({ champion: 0, challenger: 1, done: false })
  const champion = variants[match.champion]
  const challenger = variants[match.challenger]

  const choose = (side: 'left' | 'right' | 'tie') => {
    if (match.done || !champion || !challenger) return
    const stays = side === 'right' ? match.challenger : match.champion
    if (match.challenger + 1 >= variants.length) {
      setMatch({ champion: stays, challenger: match.challenger, done: true })
      onWinner((variants[stays] as Variant).id)
    } else setMatch({ champion: stays, challenger: match.challenger + 1, done: false })
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || (event.target instanceof HTMLElement && event.target.matches('input, textarea, select'))) return
      const side = event.key === 'ArrowLeft' ? 'left' : event.key === 'ArrowRight' ? 'right' : event.key === '=' ? 'tie' : null
      if (!side) return
      event.preventDefault()
      choose(side)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!champion || !challenger) return <p className="notice">Head to head needs at least two variants that are not dropped.</p>
  const side = (variant: Variant) => (
    <article className="variant" aria-label={`Variant ${variant.label}`}>
      <div className="variant-head">
        <span className="letter">{variant.label}</span>
      </div>
      <Preview bakeoff={bakeoff} variant={variant} {...view} />
    </article>
  )

  if (match.done) {
    return (
      <>
        <p className="notice busy" role="status">
          {champion.label} won head to head and is now the winner.{' '}
          <button type="button" onClick={onDone}>
            Back to the grid
          </button>{' '}
          to add notes.
        </p>
        <div className="duel one">{side(champion)}</div>
      </>
    )
  }
  return (
    <>
      <p className="notice">
        Match {match.challenger} of {variants.length - 1}. Pick the one you'd rather get: it stays and meets the next variant. Keys: ←, =, →.
      </p>
      <div className="duel">
        {side(champion)}
        {side(challenger)}
      </div>
      <div className="button-row center">
        <button type="button" className="primary" onClick={() => choose('left')}>
          {champion.label} is better
        </button>
        <button type="button" onClick={() => choose('tie')}>
          No preference
        </button>
        <button type="button" className="primary" onClick={() => choose('right')}>
          {challenger.label} is better
        </button>
      </div>
    </>
  )
}
