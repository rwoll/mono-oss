import { useEffect, useRef } from 'react'
import { Header, InlineMarkdown, RefreshIcon } from '../../ui'
import { Context } from './Context.tsx'
import { useAction, useCanvas } from './hooks.ts'
import { Sessions } from './Sessions.tsx'
import { PERIODS, credits, type Period, type SpendState } from './shared.ts'
import { Strip } from './Strip.tsx'
import '../../ui/theme.css'
import './App.css'

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

function Reading({ state }: { state: SpendState }) {
  const { scan } = state
  if (scan.status === 'error') {
    return (
      <p className="banner" role="alert">
        The sessions in <code>{state.source}</code> could not be read: {scan.error}
      </p>
    )
  }
  if (scan.status === 'scanning' || scan.status === 'idle') {
    return (
      <p className="notice busy" role="status">
        Reading sessions{scan.total > 0 ? `: ${scan.done} of ${scan.total}` : '…'}
      </p>
    )
  }
  return null
}

function App() {
  const { state } = useCanvas()
  const [refresh, refreshing] = useAction('refresh')
  const [setFilters, filtering] = useAction('set_filters')
  const [setShowAic, showing] = useAction('set_show_aic')
  const [select, selecting] = useAction('select_session')
  const [askToSort, sorting] = useAction('ask_to_sort')
  const busy = state.scan.status === 'scanning' || refreshing.pending

  // Read when the page opens, which is quick when little changed; after that, when you ask.
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    void refresh()
  }, [refresh])

  const error = refreshing.error ?? filtering.error ?? showing.error ?? selecting.error ?? sorting.error
  const empty = state.totals.sessions === 0
  const onSelect = (id: string | null) => void select({ id })

  return (
    <>
      <Header title="AIC by task type">
        <label className="filter">
          <span className="sr-only">Period</span>
          <select value={state.filters.days} disabled={filtering.pending} onChange={(event) => void setFilters({ days: Number(event.target.value) as Period })}>
            {PERIODS.map((days) => (
              <option key={days} value={days}>
                Last {days} days
              </option>
            ))}
          </select>
        </label>
        <label className="filter">
          <span className="sr-only">Repository</span>
          <select value={state.filters.repository ?? ''} disabled={filtering.pending} onChange={(event) => void setFilters({ repository: event.target.value || null })}>
            <option value="">All repositories</option>
            {state.repositories.map((repository) => (
              <option key={repository} value={repository}>
                {repository}
              </option>
            ))}
          </select>
        </label>
        <label className="switch">
          <span className="muted">{state.showAic ? 'Amounts shown' : 'Amounts hidden, showing shares'}</span>
          <input type="checkbox" role="switch" checked={state.showAic} disabled={showing.pending} onChange={(event) => void setShowAic({ show: event.target.checked })} />
          Show AIC
        </label>
        <button type="button" className={`icon-button${busy ? ' spinning' : ''}`} aria-label="Read the sessions again" title="Read the sessions again" aria-disabled={busy} onClick={() => !busy && void refresh()}>
          <RefreshIcon />
        </button>
      </Header>
      <main className="page spend">
        <Reading state={state} />
        {error && (
          <p className="error" role="alert">
            {error.message}
          </p>
        )}
        <p className="period muted">
          {day(state.period.from)} – {day(state.period.to)}
          {state.totals.aic !== null && (
            <>
              {' '}
              · <b>{credits(state.totals.aic)}</b> in {state.totals.sessions} session{state.totals.sessions === 1 ? '' : 's'}
            </>
          )}
          {state.totals.withoutAic > 0 && ` · ${state.totals.withoutAic} session${state.totals.withoutAic === 1 ? '' : 's'} left out, with no AIC recorded`}
        </p>
        {empty ? (
          state.scan.status === 'ready' && (
            <p className="empty">
              No session in the last {state.filters.days} days{state.filters.repository ? ` in ${state.filters.repository}` : ''} recorded any AIC. Sessions are read from <code>{state.source}</code>.
            </p>
          )
        ) : (
          <>
            <p className="lead">
              <InlineMarkdown>{state.summary}</InlineMarkdown>
            </p>
            <Strip state={state} onSelect={onSelect} />
            <Context state={state} />
            <Sessions state={state} onSelect={onSelect} />
            <footer className="how muted">
              <p>
                Task type is worked out from each session’s first request and what it did. To correct one, open the session and choose its task type, or{' '}
                <button type="button" className="link" disabled={sorting.pending} onClick={() => void askToSort()}>
                  ask the agent to check them
                </button>
                . A skill counts as used when, after loading it, the agent ran or read something in the skill’s folder, called a tool it names, or used a name its instructions give in code formatting; an MCP server
                counts as used when one of its tools was called.
              </p>
              <p>
                Shares of what the model read count text again each time the model reads it, so a skill loaded early in a long session weighs more than its size. Each call’s total is measured; how it splits is an
                estimate, and an MCP tool’s definition is taken to be the size of any other tool’s. Only sessions on this machine are counted, in the period their last model call falls in.
              </p>
            </footer>
          </>
        )}
      </main>
    </>
  )
}

export default App
