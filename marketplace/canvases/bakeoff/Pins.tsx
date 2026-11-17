import type { Mark } from './schema.ts'

export type Pin = Extract<Mark, { x: number }>

/** Numbered pins over an image or a mock, placed by fractions of its size. Clicking one removes it, when the round can be edited. */
export function Pins({ pins, onUnpin }: { pins: readonly Pin[]; onUnpin?: ((n: number) => void) | undefined }) {
  return pins.map((mark) => {
    const style = { left: `${mark.x * 100}%`, top: `${mark.y * 100}%` }
    return onUnpin ? (
      <button key={mark.n} type="button" className="pin" style={style} aria-label={`Remove pin ${mark.n}`} title={`Remove pin ${mark.n}`} onClick={() => onUnpin(mark.n)}>
        {mark.n}
      </button>
    ) : (
      <span key={mark.n} className="pin" style={style}>
        {mark.n}
      </span>
    )
  })
}
