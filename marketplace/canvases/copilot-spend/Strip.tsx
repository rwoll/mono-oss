import { useState } from 'react'
import { Meter } from './Bars.tsx'
import { OUTLIER, TASK_LABELS, TOP_SESSIONS, credits, percent, times, type Dot, type SpendState, type TypeRow } from './shared.ts'

// Each session as a dot on its task type's row, on a log scale, so a handful of sessions
// that cost a hundred times the rest stay on the same picture as the rest.

type Mode = 'share' | 'multiple'

/** The scale shows this many powers of ten below the largest session; smaller ones sit at its left edge. */
const DECADES = 5

interface Scale {
  ticks: number[]
  /** True when some sessions are smaller than the scale's left edge. */
  clipped: boolean
  at(value: number): number
}

function scaleFor(values: readonly number[]): Scale {
  const positive = values.filter((value) => value > 0)
  const lowest = Math.floor(Math.log10(Math.min(...positive, 1)))
  let high = Math.ceil(Math.log10(Math.max(...positive, 0)))
  if (!Number.isFinite(high) || high <= lowest) high = lowest + 1
  const low = Math.max(lowest, high - DECADES)
  const ticks = Array.from({ length: high - low + 1 }, (_unused, index) => 10 ** (low + index))
  return {
    ticks,
    clipped: low > lowest,
    at: (value) => (value > 0 ? Math.min(100, Math.max(0, ((Math.log10(value) - low) / (high - low)) * 100)) : 0),
  }
}

/** A power of ten on the axis, written out: 0.001%, 10%, 100×. */
const tickText = (value: number, unit: '%' | '×') => `${Number((unit === '%' ? value * 100 : value).toPrecision(1)).toLocaleString('en-US', { maximumFractionDigits: 6 })}${unit}`

export function Toggle<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly [T, string][]; onChange(value: T): void }) {
  return (
    <span className="toggle" role="group" aria-label={label}>
      <span className="toggle-label" aria-hidden="true">
        {label}
      </span>
      {options.map(([option, text]) => (
        <button key={option} type="button" aria-pressed={value === option} onClick={() => onChange(option)}>
          {text}
        </button>
      ))}
    </span>
  )
}

export function Strip({ state, onSelect }: { state: SpendState; onSelect(id: string): void }) {
  const [mode, setMode] = useState<Mode>('share')
  const value = (dot: Dot) => (mode === 'share' ? dot.share : dot.multiple)
  const scale = scaleFor(state.dots.map(value))
  const median = (row: TypeRow) => (mode === 'share' ? row.median : 1)

  return (
    <section className="panel" aria-labelledby="strip-title">
      <header className="panel-head">
        <h2 id="strip-title">Each session against its task type</h2>
        <span className="sub">
          {state.totals.sessions} session{state.totals.sessions === 1 ? '' : 's'} · {state.totals.types} task type{state.totals.types === 1 ? '' : 's'}
        </span>
        <Toggle<Mode> label="Position by" value={mode} onChange={setMode} options={[['share', 'Share of all AIC'], ['multiple', '× type median']]} />
      </header>
      <div className="strip">
        <div className="strip-row head">
          <span>Task type</span>
          <span>Share of all AIC</span>
          <span className="plot-label">{mode === 'share' ? "One session's share of all AIC, log scale →" : 'One session, in times its task type’s median, log scale →'}</span>
          <span className="num">Largest ÷ median</span>
        </div>
        {state.types.map((row) => {
          const dots = state.dots.filter((dot) => dot.type === row.type)
          return (
            <div className="strip-row" key={row.type}>
              <span className="type">
                <b>{TASK_LABELS[row.type]}</b>
                <small>
                  {row.sessions} session{row.sessions === 1 ? '' : 's'}
                </small>
              </span>
              <span className="share">
                <b>{percent(row.share)}</b>
                {row.aic !== null && <small>{credits(row.aic)}</small>}
                <Meter share={row.share} />
              </span>
              <span className="plot">
                {scale.ticks.map((tick) => (
                  <i key={tick} className="grid" style={{ left: `${scale.at(tick)}%` }} />
                ))}
                <i className="median" style={{ left: `${scale.at(median(row))}%` }} />
                {scale.at(median(row) * OUTLIER) < 100 && <i className="outlier-line" style={{ left: `${scale.at(median(row) * OUTLIER)}%` }} />}
                {dots.map((dot) => {
                  const text = `${percent(dot.share)} of all AIC, ${times(dot.multiple)} the ${TASK_LABELS[dot.type]} median`
                  const selected = dot.id === state.selected
                  if (dot.rank === null) {
                    // The rest are in the list under Show all; here they are for the pointer only.
                    return (
                      <button key={dot.id} type="button" className={`dot${selected ? ' selected' : ''}`} style={{ left: `${scale.at(value(dot))}%` }} title={text} tabIndex={-1} aria-hidden="true" onClick={() => onSelect(dot.id)} />
                    )
                  }
                  return (
                    <button
                      key={dot.id}
                      type="button"
                      className={`mark${dot.multiple > OUTLIER ? ' hot' : ''}${selected ? ' selected' : ''}`}
                      style={{ left: `${scale.at(value(dot))}%` }}
                      title={text}
                      aria-label={`Session ${dot.rank}: ${text}`}
                      aria-pressed={selected}
                      onClick={() => onSelect(dot.id)}
                    >
                      {dot.rank}
                    </button>
                  )
                })}
              </span>
              <span className={`num${row.largest > OUTLIER ? ' hot' : ''}`}>{times(row.largest)}</span>
            </div>
          )
        })}
        <div className="strip-row axis" aria-hidden="true">
          <span />
          <span />
          <span className="plot">
            {scale.ticks.map((tick, index) => (
              <span key={tick} style={{ left: `${scale.at(tick)}%` }}>
                {index === 0 && scale.clipped && '≤ '}
                {tickText(tick, mode === 'share' ? '%' : '×')}
              </span>
            ))}
          </span>
          <span />
        </div>
      </div>
      <p className="legend">
        <span className="key">
          <i className="dot static" aria-hidden="true" />
          one session
        </span>
        <span className="key">
          <i className="median static" aria-hidden="true" />
          median for the task type
        </span>
        <span className="key">
          <i className="outlier-line static" aria-hidden="true" />
          {OUTLIER}× the median
        </span>
        <span className="key">
          <i className="mark static" aria-hidden="true">
            1
          </i>
          one of the {Math.min(TOP_SESSIONS, state.totals.sessions)} most expensive, by rank
        </span>
        <span className="key">
          <i className="mark hot static" aria-hidden="true">
            2
          </i>
          also more than {OUTLIER}× its median
        </span>
        <span className="key">
          <i className="mark selected static" aria-hidden="true">
            3
          </i>
          selected below
        </span>
      </p>
    </section>
  )
}
