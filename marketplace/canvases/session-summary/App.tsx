import { createCanvasHooks, type AgentActivity, type CanvasActionError } from '@rwoll/canvas-kit/react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronIcon, ClockIcon, Header, Markdown, RefreshIcon } from '../../ui'
import type canvas from './canvas.ts'
import type { PendingRefresh, RefreshOutcome, Summary } from './canvas.ts'
import { AskAgent } from './AskAgent.tsx'
import { linkReferences, referenceParts } from './references.ts'
import '../../ui/theme.css'
import './App.css'

const { useCanvas, useAction, useJobs } = createCanvasHooks<typeof canvas>()

const STATUS_LABELS: Record<Summary['status'], string> = { working: 'Working', waiting: 'Waiting', blocked: 'Blocked', idle: 'Idle', done: 'Done' }
const STATE_LABELS: Record<Summary['running'][number]['state'], string> = {
  running: 'Running',
  queued: 'Queued',
  waiting: 'Waiting',
  blocked: 'Blocked',
  done: 'Done',
  failed: 'Failed',
}
/** Refresh now is ignored this long after a click, so a double click asks once. */
const REFRESH_LOCK_MS = 3_000
const MINUTE = 60_000

function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

const pad = (n: number) => String(n).padStart(2, '0')

function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1_000))
  const hours = Math.floor(total / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(total % 60)}` : `${minutes}:${pad(total % 60)}`
}

function formatAgo(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000))
  if (seconds < 10) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`
}

const clockTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/** The agent finished a turn after the request without answering it. */
function unanswered(pending: PendingRefresh | null, agent: AgentActivity): boolean {
  return !!pending && !agent.busy && agent.idleSince !== undefined && agent.idleSince > Date.parse(pending.requestedAt)
}

function notice(pending: PendingRefresh | null, agent: AgentActivity, outcome: RefreshOutcome | undefined): { text: string; tone: string } {
  if (unanswered(pending, agent)) return { text: 'The agent finished without updating the summary. Try refreshing again.', tone: 'warn' }
  if (pending) {
    const picked = agent.busy && (agent.lastActivityAt ?? 0) >= Date.parse(pending.requestedAt)
    return { text: picked ? 'The agent is writing an update…' : 'Refresh requested. Waiting for the agent to pick it up…', tone: 'busy' }
  }
  if (!outcome) return { text: '', tone: '' }
  const at = clockTime(outcome.at)
  switch (outcome.kind) {
    case 'skipped':
      return { text: `Skipped the ${at} refresh because nothing has happened since the last update.`, tone: '' }
    case 'unanswered':
      return { text: `The agent finished without updating the summary (${at}). Try refreshing again.`, tone: 'warn' }
    case 'expired':
      return { text: `The ${at} refresh request timed out. ${outcome.detail}`, tone: 'warn' }
    case 'send_failed':
      return { text: `Could not reach the agent (${at}): ${outcome.detail}`, tone: 'warn' }
  }
}

/** Plain text with GitHub issue and pull request URLs as short links. */
function RefText({ children }: { children: string }) {
  return (
    <>
      {referenceParts(children).map((part, index) =>
        typeof part === 'string' ? (
          part
        ) : (
          <a key={index} href={part.url} target="_blank" rel="noopener noreferrer" title={part.url}>
            {part.label}
          </a>
        ),
      )}
    </>
  )
}

/** How long the panel stays visible and focused before the summary counts as read. */
const SEEN_AFTER_MS = 3_000

/** Tells the canvas when the user has looked at this revision of the summary. */
function useMarkSeen(revision: number | undefined, seenRevision: number | undefined) {
  const [markSeen] = useAction('mark_seen')
  useEffect(() => {
    if (revision === undefined || revision === seenRevision) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = () => {
      clearTimeout(timer)
      if (document.visibilityState === 'visible' && document.hasFocus()) timer = setTimeout(() => void markSeen({ revision }), SEEN_AFTER_MS)
    }
    check()
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    window.addEventListener('blur', check)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('focus', check)
      window.removeEventListener('blur', check)
    }
  }, [revision, seenRevision, markSeen])
}

function App() {
  const { state, agent, status } = useCanvas()
  const jobs = useJobs()
  const now = useNow()
  const page = useRef<HTMLElement>(null)
  const [refreshLocked, setRefreshLocked] = useState(false)
  const refresh = jobs.jobs.find((job) => job.id === 'refresh')
  const { summary, pending, lastOutcome } = state
  const updating = !!pending && !unanswered(pending, agent)
  useMarkSeen(summary?.revision, state.seen?.revision)

  const refreshNow = () => {
    if (refreshLocked) return
    setRefreshLocked(true)
    setTimeout(() => setRefreshLocked(false), REFRESH_LOCK_MS)
    void jobs.run('refresh')
  }

  // Report only what happened after the summary on screen.
  const outcome = lastOutcome && (!summary || lastOutcome.at > summary.updatedAt) ? lastOutcome : undefined
  const { text: noticeText, tone } = notice(pending, agent, outcome)
  const error = jobs.error

  return (
    <>
      <Header title="Session summary" badge={summary && <span className={`pill status-${summary.status}`}>{STATUS_LABELS[summary.status]}</span>}>
        {refresh && <RefreshSettings refresh={refresh} updating={updating} now={now} />}
        <button
          type="button"
          className={updating ? 'icon-button spinning' : 'icon-button'}
          aria-label="Refresh now"
          title="Refresh now"
          aria-disabled={refreshLocked || undefined}
          onClick={refreshNow}
        >
          <RefreshIcon />
        </button>
      </Header>

      <main className="page" ref={page}>
        {status === 'offline' && (
          <p className="banner" role="alert">
            Lost connection to the session. Reopen this panel if it does not recover.
          </p>
        )}
        {error && (
          <p className="banner" role="alert">
            {error.message}
          </p>
        )}
        <section className="panel" aria-label="Summary">
          <p className="meta">
            {summary && (
              <span>
                Updated <span className="time">{formatAgo(now - Date.parse(summary.updatedAt))}</span>
              </span>
            )}
            {noticeText && (
              <span className={`notice ${tone}`.trim()} role="status">
                {noticeText}
              </span>
            )}
          </p>
          {summary ? (
            <SummaryView summary={summary} />
          ) : (
            <p className="headline empty">
              {updating ? 'Requesting the first summary…' : 'No summary yet. Use the refresh button to ask the agent for one.'}
            </p>
          )}
        </section>
      </main>
      <AskAgent root={page} />
    </>
  )
}

function SummaryView({ summary }: { summary: Summary }) {
  return (
    <>
      <p className="headline">
        <RefText>{summary.headline}</RefText>
      </p>
      {summary.notes && (
        <p className="notes">
          <RefText>{summary.notes}</RefText>
        </p>
      )}
      {summary.executiveSummary && (
        <section className="block executive" aria-labelledby="executive-title">
          <h2 id="executive-title" className="label">
            Executive summary
          </h2>
          <Markdown>{linkReferences(summary.executiveSummary)}</Markdown>
        </section>
      )}
      <Bullets id="attention" title="Needs your attention" items={summary.attention} className="block attention" />
      {summary.running.length > 0 && (
        <section className="block" aria-labelledby="running-title">
          <h2 id="running-title" className="label">
            Running
          </h2>
          <ul className="rows">
            {summary.running.map((item, index) => (
              <li key={index} className="row">
                <span className="row-main">
                  <span className="row-title">
                    <RefText>{item.title}</RefText>
                  </span>
                  {item.detail && (
                    <span className="row-detail">
                      <RefText>{item.detail}</RefText>
                    </span>
                  )}
                </span>
                <span className={`badge state-${item.state}`}>{STATE_LABELS[item.state]}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {(summary.progress.length > 0 || summary.next.length > 0) && (
        <div className="columns">
          <Bullets id="progress" title="Recent progress" items={summary.progress} className="block" />
          <Bullets id="next" title="Next up" items={summary.next} className="block" />
        </div>
      )}
    </>
  )
}

function Bullets({ id, title, items, className }: { id: string; title: string; items: readonly string[]; className: string }) {
  if (items.length === 0) return null
  return (
    <section className={className} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="label">
        {title}
      </h2>
      <ul className="bullets">
        {items.map((item, index) => (
          <li key={index}>
            <RefText>{item}</RefText>
          </li>
        ))}
      </ul>
    </section>
  )
}

type RefreshJob = ReturnType<typeof useJobs>['jobs'][number]

/**
 * The countdown to the next refresh. Clicking it opens the refresh settings: a
 * typed interval is saved with Enter or when the menu closes, and Escape closes
 * it without saving.
 */
function RefreshSettings({ refresh, updating, now }: { refresh: RefreshJob; updating: boolean; now: number }) {
  const jobs = useJobs()
  const { state } = useCanvas()
  const [setSkip, skipping] = useAction('set_skip_when_idle')
  const [open, setOpen] = useState(false)
  const minutes = Math.round(refresh.every / MINUTE)
  /** What is being typed; the saved interval shows otherwise. */
  const [draft, setDraft] = useState<string>()
  const interval = draft ?? String(minutes)
  const [invalid, setInvalid] = useState('')
  const menu = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const min = Math.ceil(refresh.minEvery / MINUTE)
  const max = Math.floor(refresh.maxEvery / MINUTE)

  const commit = (revert = false): void => {
    const value = Number(interval)
    if (interval.trim() === '' || !Number.isInteger(value) || value < min || value > max) {
      if (revert) {
        setDraft(undefined)
        setInvalid('')
      } else {
        setInvalid(`Enter a whole number of minutes from ${min} to ${max}.`)
      }
      return
    }
    setInvalid('')
    setDraft(undefined)
    if (value !== minutes) void jobs.update('refresh', { every: value * MINUTE })
  }

  const close = ({ save = true, focus = false } = {}) => {
    if (!open) return
    if (save) commit(true)
    else setDraft(undefined)
    setInvalid('')
    setOpen(false)
    if (focus) toggle.current?.focus()
  }

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!menu.current?.contains(target) && !toggle.current?.contains(target)) close()
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  })

  let text: string
  let title: string
  if (updating) [text, title] = ['Updating…', 'Refresh in progress']
  else if (!refresh.enabled) [text, title] = ['Off', 'Auto-refresh is off']
  else if (!refresh.nextRunAt) [text, title] = ['Pending', 'Next refresh pending']
  else {
    const left = Date.parse(refresh.nextRunAt) - now
    if (left <= 0) [text, title] = ['Due', 'Refresh due']
    else [text, title] = [formatClock(left), `Next refresh in ${formatClock(left)}`]
  }
  const prefix = updating ? '' : !refresh.enabled ? 'auto-refresh ' : text === 'Due' || text === 'Pending' ? 'next refresh ' : 'next refresh in '

  const onMenuKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close({ save: false, focus: true })
    }
  }

  return (
    <>
      <button
        ref={toggle}
        type="button"
        className={!refresh.enabled && !updating ? 'icon-button timer off' : 'icon-button timer'}
        aria-expanded={open}
        aria-controls="settings"
        title={`Refresh settings · ${title}`}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.preventDefault()
            close()
          }
        }}
      >
        <ClockIcon />
        <span className="sr-only">Refresh settings, </span>
        <span className="countdown">
          <span className="sr-only">{prefix}</span>
          {text}
        </span>
        <ChevronIcon />
      </button>
      {open && (
        <div
          ref={menu}
          id="settings"
          className="menu"
          role="group"
          aria-labelledby="settings-heading"
          onKeyDown={onMenuKey}
          onBlur={(event) => {
            const next = event.relatedTarget as Node | null
            if (next && !menu.current?.contains(next) && next !== toggle.current) close()
          }}
        >
          <h2 id="settings-heading" className="label">
            Refresh settings
          </h2>
          <label className="menu-item">
            <input
              type="checkbox"
              checked={refresh.enabled}
              disabled={jobs.pending.has('refresh')}
              onChange={(event) => void jobs.update('refresh', { enabled: event.target.checked })}
            />{' '}
            Auto-refresh
          </label>
          <div className="menu-item">
            <label htmlFor="interval">Every</label>
            <input
              id="interval"
              className="interval"
              type="number"
              min={min}
              max={max}
              step={1}
              inputMode="numeric"
              aria-describedby="interval-unit"
              aria-invalid={invalid ? true : undefined}
              value={interval}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commit()
                }
              }}
            />
            <span id="interval-unit">minutes</span>
          </div>
          <label className="menu-item">
            <input
              type="checkbox"
              aria-describedby="skip-help"
              checked={state.skipWhenIdle}
              disabled={skipping.pending}
              onChange={(event) => void setSkip({ enabled: event.target.checked })}
            />{' '}
            Skip when idle
          </label>
          <p id="skip-help" className="menu-help">
            Skips a timed refresh when nothing has happened since the last update.
          </p>
          <MenuError message={invalid || skipping.error?.message || errorText(jobs.error)} />
        </div>
      )}
    </>
  )
}

const errorText = (error: CanvasActionError | undefined) => error?.message ?? ''

function MenuError({ message }: { message: string }) {
  if (!message) return null
  return (
    <p className="error" role="alert">
      {message}
    </p>
  )
}

export default App
