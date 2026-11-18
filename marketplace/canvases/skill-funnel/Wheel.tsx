import { compact, percent, type Context, type Stage } from './shared.ts'

/** The slices, clockwise from the top. */
const SLICES: readonly { stage: Stage; what: string }[] = [
  { stage: 'invoked', what: 'Instructions of invoked skills' },
  { stage: 'available', what: 'The list of available skills' },
]

/** A wheel of the agent's context, with what its skills take of it in the colors of their rows. */
export function Wheel({ context }: { context: Context }) {
  const share = (context.invoked + context.available) / context.total
  const length = (stage: Stage) => (context[stage] / context.total) * 100
  // Each slice starts where the ones before it end.
  const arcs = SLICES.map(({ stage }, index) => ({ stage, length: length(stage), start: SLICES.slice(0, index).reduce((sum, before) => sum + length(before.stage), 0) }))
  return (
    <figure className="wheel">
      <h2 className="label">Context usage</h2>
      <svg viewBox="0 0 120 120" role="img" aria-label={`Skills take about ${percent(share)} of the ${compact(context.total)} tokens in the agent’s context`}>
        {/* Drawn from the top, clockwise; each circle's outline is 100 long. */}
        <g transform="rotate(-90 60 60)" fill="none" strokeWidth="15">
          <circle className="rest" cx="60" cy="60" r="48" />
          {arcs.map(({ stage, length: size, start }) =>
            size > 0 ? <circle key={stage} className={stage} cx="60" cy="60" r="48" pathLength="100" strokeDasharray={`${size} ${100 - size}`} strokeDashoffset={-start} /> : null,
          )}
        </g>
        <text className="share" x="60" y="60" textAnchor="middle">
          {percent(share)}
        </text>
        <text className="of" x="60" y="74" textAnchor="middle">
          skills
        </text>
      </svg>
      <figcaption>
        {SLICES.map(({ stage, what }) => (
          <span key={stage} className={`key ${stage}`} title={`${what}: about ${compact(context[stage])} tokens`}>
            {compact(context[stage])}
          </span>
        ))}
        <span className="muted">of {compact(context.total)} tokens</span>
      </figcaption>
    </figure>
  )
}
