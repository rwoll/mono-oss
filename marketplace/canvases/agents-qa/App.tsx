import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FindingView, QaState } from './canvas.ts'
import type { Outcome } from './format.ts'
import '../../ui/theme.css'
import './App.css'
import { Detail, type DetailActions } from './Detail.tsx'
import { MediaStrip } from './Media.tsx'
import { Markdown } from './RichText.tsx'
import { githubRef, plainText } from './markdown.ts'
import { ago, buildLabel, DECISIONS, inTab, progressLabel, SEVERITY_LABEL, shortCommit, STATUS_LABEL, TABS, tabOf, useAction, useCanvas, when, type Tab } from './triage.ts'

const SYNC_MS = 20_000
const NARROW_PX = 720

function RefreshIcon() {
  return (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M12.5 1.75v3h-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function MoreIcon() {
  return (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="3.5" cy="8" r="1.25" fill="currentColor" />
      <circle cx="8" cy="8" r="1.25" fill="currentColor" />
      <circle cx="12.5" cy="8" r="1.25" fill="currentColor" />
    </svg>
  )
}

function Settings({ state, onClose }: { state: QaState; onClose: () => void }) {
  const [configure, { pending, error }] = useAction('configure')
  const [fixModel, setFixModel] = useState(state.settings.fixModel)
  const [vscodePath, setVscodePath] = useState(state.settings.vscodePath)
  return (
    <form
      className="menu settings"
      aria-label="Settings"
      onSubmit={async (event) => {
        event.preventDefault()
        const result = await configure({
          ...(fixModel.trim() !== state.settings.fixModel && { fixModel: fixModel.trim() }),
          ...(vscodePath.trim() !== state.settings.vscodePath && { vscodePath: vscodePath.trim() }),
        })
        if (result) onClose()
      }}
    >
      <label>
        <span className="label">Model for fix and investigation sessions</span>
        <input value={fixModel} onChange={(event) => setFixModel(event.target.value)} />
      </label>
      <label>
        <span className="label">microsoft/vscode checkout</span>
        <input value={vscodePath} onChange={(event) => setVscodePath(event.target.value)} />
      </label>
      <p className="notice">
        Sessions run in new worktrees of the checkout. Runs and decisions live in <code>{state.root}</code>.
      </p>
      {error && <p className="error">{error.message}</p>}
      <div className="button-row end">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={pending}>
          Save
        </button>
      </div>
    </form>
  )
}

function RunBox({ state, runId, onRun, onOpenFile }: { state: QaState; runId: string | null; onRun: (id: string | null) => void; onOpenFile: (path: string) => void }) {
  const run = (runId ? state.runs.find((entry) => entry.id === runId) : null) ?? state.runs[0]
  if (!run) return null
  const build = buildLabel(run)
  const finished = run.status === 'running' ? `Running since ${when(run.startedAt)}` : run.status === 'stopped' ? `Stopped without finishing, started ${when(run.startedAt)}` : when(run.finishedAt ?? run.startedAt)
  return (
    <section className={`executive run ${run.status}`} aria-label="Run">
      <div className="run-head">
        <p className="label">{runId ? 'Run' : 'Latest run'}</p>
        <select value={runId ?? ''} onChange={(event) => onRun(event.target.value || null)} aria-label="Show findings from">
          <option value="">All runs</option>
          {state.runs.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.id}
              {entry.status !== 'complete' ? ` (${entry.status})` : ''}
            </option>
          ))}
        </select>
        {run.report && (
          <button type="button" className="link" onClick={() => onOpenFile(run.report!)}>
            Open report
          </button>
        )}
      </div>
      <p className="run-meta">
        <span>{finished}</span>
        {build && <span>{build}</span>}
        {run.scope.base && <span title={run.scope.base.commit}>PRs since {run.scope.base.version ? `${run.scope.base.version} ` : ''}{shortCommit(run.scope.base.commit)}</span>}
        {run.scope.area && <span>explored {run.scope.area}</span>}
        {run.counts.findings > 0 && (
          <span>
            {run.counts.new} new, {run.counts.still} still reproducing, {run.counts.fixed} fixed
          </span>
        )}
      </p>
      {run.problem && <p className="error">{run.problem}</p>}
      {run.error && <p className="error">{run.error}</p>}
      {run.summary && <Markdown text={run.summary} />}
      {run.media.length > 0 && (
        <details>
          <summary>{run.media.length === 1 ? run.media[0]!.label : `${run.media.length} recordings and screenshots`}</summary>
          <MediaStrip media={run.media} onOpenFile={onOpenFile} />
        </details>
      )}
      <PullRequests run={run} />
    </section>
  )
}

function PrLink({ url }: { url: string }) {
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" title={url}>
      {githubRef(url) ?? url}
    </a>
  )
}

/** The PRs a run tested, which work, and the others in its build with why it skipped them. */
function PullRequests({ run }: { run: QaState['runs'][number] }) {
  const verified = new Map(run.verified.map((entry) => [entry.pr, entry.note]))
  const tested = [...new Set([...run.scope.prs, ...verified.keys()])]
  const { skipped } = run.scope
  if (!tested.length && !skipped.length) return null
  const parts = [`${tested.length} tested`, `${verified.size} verified working`, ...(skipped.length ? [`${skipped.length} skipped`] : [])]
  return (
    <details>
      <summary>Pull requests: {parts.join(', ')}</summary>
      {tested.length > 0 && (
        <ul className="rows">
          {tested.map((url) => (
            <li key={url} className="row">
              <PrLink url={url} />
              {verified.has(url) ? <span className="badge state-done">Works</span> : <span className="row-note">Tested; see the findings</span>}
              {verified.get(url) && <span className="row-note">{verified.get(url)}</span>}
            </li>
          ))}
        </ul>
      )}
      {skipped.length > 0 && (
        <>
          <p className="label">Skipped</p>
          <ul className="rows">
            {skipped.map((entry) => (
              <li key={entry.pr} className="row">
                <PrLink url={entry.pr} />
                <span className="row-note">{entry.reason}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </details>
  )
}

const BADGE_CLASS: Record<string, string> = { draft: 'state-draft', sent: 'state-sent', working: 'state-working', failed: 'state-failed', done: 'state-done' }

function Item({ finding, tab, selected, now, onSelect }: { finding: FindingView; tab: Tab; selected: boolean; now: number; onSelect: () => void }) {
  const progress = progressLabel(finding)
  const latest = finding.seen.at(-1)!
  const state = finding.item?.decision === 'suppress' ? 'state-suppressed' : BADGE_CLASS[finding.item?.state ?? 'draft']
  return (
    <li>
      <button type="button" className={`item sev sev-${finding.severity}`} aria-current={selected || undefined} onClick={onSelect}>
        <span className="item-title">
          <span className="swatch" title={SEVERITY_LABEL[finding.severity]} />
          <span>{plainText(finding.title)}</span>
        </span>
        <span className="item-detail">
          <span>
            {finding.id} · {finding.area}
            {finding.status !== 'new' && ` · ${STATUS_LABEL[finding.status].toLowerCase()}`}
            {finding.seen.length > 1 && ` · ${finding.seen.length} runs`} · {ago(latest.at, now)}
          </span>
          {progress ? (
            <span className={`badge ${state}`}>{progress}</span>
          ) : (
            tab === 'triage' && finding.recommendation && <span className="hint">suggests {finding.recommendation.outcome}</span>
          )}
        </span>
      </button>
    </li>
  )
}

export default function App() {
  const { state, status } = useCanvas()
  const [sync, syncState] = useAction('sync')
  const [decide, decideState] = useAction('decide')
  const [setNote, noteState] = useAction('set_note')
  const [reset, resetState] = useAction('reset')
  const [send, sendState] = useAction('send')
  const [accept, acceptState] = useAction('accept_suggestions')
  const [openFile, openFileState] = useAction('open_file')
  const [openLink, openLinkState] = useAction('open_link')
  const [tab, setTab] = useState<Tab>('triage')
  const [runId, setRunId] = useState<string | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [showDetail, setShowDetail] = useState(false)
  const [settings, setSettings] = useState(false)
  const [sent, setSent] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [narrow, setNarrow] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const top = useRef<HTMLElement>(null)

  useEffect(() => {
    const element = root.current
    const header = top.current
    if (!element || !header) return
    const observer = new ResizeObserver(() => {
      setNarrow(element.clientWidth < NARROW_PX)
      // The findings list stays in view below the pinned header.
      element.style.setProperty('--top', `${header.offsetHeight}px`)
    })
    observer.observe(element)
    observer.observe(header)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    void sync()
    const tick = () => {
      setNow(Date.now())
      if (document.visibilityState === 'visible') void sync()
    }
    const timer = window.setInterval(tick, SYNC_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [sync])

  const scoped = useMemo(() => (runId ? state.findings.filter((finding) => finding.seen.some((sighting) => sighting.runId === runId)) : state.findings), [state.findings, runId])
  const counts = useMemo(() => Object.fromEntries(TABS.map((entry) => [entry.id, scoped.filter((finding) => inTab(finding, entry.id)).length])) as Record<Tab, number>, [scoped])
  const visible = useMemo(() => scoped.filter((finding) => inTab(finding, tab)), [scoped, tab])
  const ready = state.findings.filter((finding) => tabOf(finding) === 'ready').length
  const suggested = useMemo(() => scoped.filter((finding) => tabOf(finding) === 'triage' && finding.recommendation).map((finding) => finding.key), [scoped])
  const suggestions = suggested.length
  // Pin the finding shown by default, so a sync that reorders the list doesn't swap it under you.
  if (!narrow && visible[0] && !visible.some((finding) => finding.key === selectedKey)) setSelectedKey(visible[0].key)
  const selected = visible.find((finding) => finding.key === selectedKey) ?? (narrow ? undefined : visible[0])

  /** After deciding, move on to the next finding in the list, as in an inbox. */
  const advanceFrom = useCallback(
    (key: string) => {
      const index = visible.findIndex((finding) => finding.key === key)
      const next = visible[index + 1] ?? visible[index - 1]
      setSelectedKey(next && next.key !== key ? next.key : null)
    },
    [visible],
  )

  const actions: DetailActions = useMemo(
    () => ({
      decide: (key, decision, trackedUrl) => {
        void decide({ key, decision, ...(trackedUrl && { trackedUrl }) }).then((result) => {
          if (result && tab === 'triage' && decision) advanceFrom(key)
        })
      },
      setNote: (key, note) => void setNote({ key, note }),
      reset: (key) => void reset({ key }),
      openFile: (path) => void openFile({ path }),
      openLink: (url) => void openLink({ url }),
    }),
    [advanceFrom, decide, openFile, openLink, reset, setNote, tab],
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Keys sent to the document itself have no element target.
      const target = event.target instanceof Element ? event.target : document.body
      if (target.closest('input, textarea, select, .menu') || document.querySelector('[role="dialog"]') || event.metaKey || event.ctrlKey || event.altKey) return
      const index = visible.findIndex((finding) => finding.key === selected?.key)
      if (event.key === 'j' || event.key === 'k') {
        const next = visible[Math.min(visible.length - 1, Math.max(0, index + (event.key === 'j' ? 1 : -1)))]
        if (next) setSelectedKey(next.key)
      } else {
        const decision = DECISIONS.find((entry) => entry.key === event.key)
        const busy = selected?.item?.state === 'sent' || selected?.item?.state === 'working'
        if (!selected || !decision || decision.id === 'tracked' || busy) return
        actions.decide(selected.key, selected.item?.decision === decision.id ? null : (decision.id as Outcome))
      }
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions, selected, visible])

  useEffect(() => {
    if (!settings) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSettings(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settings])

  const error = [decideState, noteState, resetState, sendState, acceptState, openFileState, openLinkState, syncState].find((entry) => entry.error)?.error
  const latest = state.runs[0]
  const shownTabs = TABS.filter((entry) => entry.id === 'triage' || entry.id === 'all' || counts[entry.id] > 0)

  const list =
    visible.length === 0 ? (
      <p className="empty">{tab === 'triage' ? (state.findings.length ? 'Nothing left to triage.' : 'No findings yet.') : 'Nothing here.'}</p>
    ) : (
      <ul className="list" aria-label={TABS.find((entry) => entry.id === tab)!.label}>
        {visible.map((finding) => (
          <Item
            key={finding.key}
            finding={finding}
            tab={tab}
            now={now}
            selected={finding.key === selected?.key}
            onSelect={() => {
              setSelectedKey(finding.key)
              setShowDetail(true)
            }}
          />
        ))}
      </ul>
    )

  return (
    <div ref={root} className={`app${narrow ? ' narrow' : ''}`}>
      <header ref={top} className="top">
        <div className="top-row">
          <h1 className="title">Agents QA</h1>
          <span className="top-meta">
            {latest ? `Last run ${ago(latest.startedAt, now)}${latest.build.version ? ` · ${latest.build.version}` : ''}` : 'No runs yet'}
            {status !== 'live' && ` · ${status}`}
          </span>
          <div className="controls">
            {suggestions > 0 && tab === 'triage' && (
              <button type="button" disabled={acceptState.pending} onClick={() => void accept({ keys: suggested })} title="Take the run's suggested decision for each finding you haven't decided">
                Use {suggestions} suggestion{suggestions === 1 ? '' : 's'}
              </button>
            )}
            <button
              type="button"
              className="primary"
              disabled={!ready || sendState.pending}
              title="Ask the agent in this chat to carry out every ready decision"
              onClick={async () => {
                const result = await send({})
                if (result) {
                  setSent(`Sent ${result.sent} decision${result.sent === 1 ? '' : 's'} to the agent.`)
                  window.setTimeout(() => setSent(null), 6000)
                }
              }}
            >
              {ready ? `Send ${ready} to agent` : 'Send to agent'}
            </button>
            <button
              id="refresh"
              type="button"
              className={`icon-button${syncState.pending ? ' spinning' : ''}`}
              aria-label="Refresh"
              title="Read the QA folder again"
              onClick={() => void sync()}
            >
              <RefreshIcon />
            </button>
            <button type="button" className="icon-button" aria-label="Settings" aria-expanded={settings} title="Settings" onClick={() => setSettings(!settings)}>
              <MoreIcon />
            </button>
            {settings && <Settings state={state} onClose={() => setSettings(false)} />}
          </div>
        </div>
        {state.runs.length > 0 && (
          <nav className="tabs" role="tablist" aria-label="Findings">
            {shownTabs.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                className="tab"
                aria-selected={tab === entry.id}
                onClick={() => {
                  setTab(entry.id)
                  setSelectedKey(null)
                  setShowDetail(false)
                }}
              >
                {entry.label}
                <span className="tab-count">{counts[entry.id]}</span>
              </button>
            ))}
          </nav>
        )}
      </header>

      <main className="page">
        {(error || sent) && (
          <p className={error ? 'banner' : 'banner ok'} role={error ? 'alert' : 'status'}>
            {error?.message ?? sent}
          </p>
        )}
        {state.problems.length > 0 && (
          <ul className="problems" aria-label="Problems">
            {state.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
        {!state.runs.length ? (
          <section className="empty">
            <p className="headline">No QA runs yet</p>
            <p>
              Create a scheduled automation that says <code>Use the agents-qa skill.</code> Each run writes its findings to <code>{state.root}/runs</code>, and they show up here to
              triage.
            </p>
          </section>
        ) : (
          <>
            <RunBox state={state} runId={runId} onRun={setRunId} onOpenFile={actions.openFile} />
            <div className="panes">
              {(!narrow || !showDetail || !selected) && list}
              {selected && (!narrow || showDetail) && (
                <Detail
                  key={selected.key}
                  finding={selected}
                  state={state}
                  actions={actions}
                  onBack={narrow ? () => setShowDetail(false) : undefined}
                />
              )}
            </div>
          </>
        )}
      </main>
    </div>
  )
}
