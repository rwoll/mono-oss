import { useState, type ReactNode } from 'react'
import type { FindingView, QaState } from './canvas.ts'
import type { Link, Outcome } from './format.ts'
import { MediaStrip } from './Media.tsx'
import { InlineMarkdown, Markdown } from './RichText.tsx'
import { githubRef, plainText } from './markdown.ts'
import { DECISION_LABEL, DECISIONS, SEVERITY_LABEL, STATUS_LABEL, when } from './triage.ts'

export interface DetailActions {
  decide: (key: string, decision: Outcome | null, trackedUrl?: string) => void
  setNote: (key: string, note: string) => void
  reset: (key: string) => void
  openFile: (path: string) => void
  openLink: (url: string) => void
}

const GITHUB_URL = /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9_-]{0,38}\/[A-Za-z0-9._-]{1,100}\/(?:issues|pull)\/[1-9]\d{0,8}\/?$/

function LinkState({ url, links }: { url: string; links: QaState['links'] }) {
  const status = links[url]
  if (!status) return null
  const [label, kind] =
    status.state === 'merged' ? ['Merged', 'state-merged'] : status.state === 'closed' ? ['Closed', 'state-failed'] : status.draft ? ['Draft', 'state-draft'] : ['Open', 'state-done']
  return <span className={`badge ${kind}`}>{label}</span>
}

function LinkRow({ link, links, actions }: { link: Link; links: QaState['links']; actions: DetailActions }) {
  const url = link.url
  return (
    <li className="row">
      <span className="row-kind">{link.label}</span>
      {link.path ? (
        <button type="button" className="link" onClick={() => actions.openFile(link.path!)} title={link.path}>
          {link.path.slice(link.path.lastIndexOf('/') + 1)}
        </button>
      ) : url?.startsWith('https://') ? (
        <a href={url} target="_blank" rel="noopener noreferrer" title={url}>
          {githubRef(url) ?? url}
        </a>
      ) : (
        <button type="button" className="link" onClick={() => actions.openLink(url!)} title={url}>
          Open session
        </button>
      )}
      {url && <LinkState url={url} links={links} />}
    </li>
  )
}

function NoteBox({ finding, actions }: { finding: FindingView; actions: DetailActions }) {
  const saved = finding.item?.note ?? ''
  const [draft, setDraft] = useState(saved)
  const [base, setBase] = useState(saved)
  // Another chat or the agent changed the note: show theirs unless you are mid-edit.
  if (saved !== base) {
    setBase(saved)
    if (draft === base) setDraft(saved)
  }
  return (
    <label className="block note">
      <span className="label">
        Note for the agent<span className="label-note">optional</span>
      </span>
      <textarea
        value={draft}
        rows={2}
        maxLength={4000}
        placeholder="For example: show the error with a button that fixes it."
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft.trim() !== saved) actions.setNote(finding.key, draft.trim())
        }}
      />
    </label>
  )
}

function TrackedPicker({ finding, actions, onDone }: { finding: FindingView; actions: DetailActions; onDone: () => void }) {
  const [url, setUrl] = useState(finding.matches[0]?.url ?? '')
  const valid = GITHUB_URL.test(url.trim())
  return (
    <form
      className="tracked"
      onSubmit={(event) => {
        event.preventDefault()
        if (!valid) return
        actions.decide(finding.key, 'tracked', url.trim())
        onDone()
      }}
    >
      <p className="label">Which issue tracks it?</p>
      {finding.matches.map((match) => (
        <label key={match.url} className="choice">
          <input type="radio" name="tracked" checked={url === match.url} onChange={() => setUrl(match.url)} />
          <span>
            {githubRef(match.url) ?? match.url}
            <span className="muted">
              {' '}
              · {match.relation === 'duplicate' ? 'same issue' : 'related'}
              {match.state ? `, ${match.state}` : ''}
            </span>
          </span>
        </label>
      ))}
      <input type="url" value={url} placeholder="https://github.com/microsoft/vscode/issues/…" onChange={(event) => setUrl(event.target.value)} aria-label="Issue URL" />
      <div className="button-row">
        <button type="submit" className="primary" disabled={!valid}>
          Mark tracked
        </button>
        <button type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function Status({ finding, state, actions }: { finding: FindingView; state: QaState; actions: DetailActions }) {
  const item = finding.item
  if (!item?.decision) return null
  const busy = item.state === 'sent' || item.state === 'working'
  let text: ReactNode
  if (item.decision === 'tracked' && item.trackedUrl) {
    text = (
      <>
        Tracked in{' '}
        <a href={item.trackedUrl} target="_blank" rel="noopener noreferrer">
          {githubRef(item.trackedUrl) ?? item.trackedUrl}
        </a>{' '}
        <LinkState url={item.trackedUrl} links={state.links} />
      </>
    )
  } else if (item.decision === 'suppress') text = "Suppressed. Later runs don't report it again."
  else if (item.state === 'draft') text = 'Not sent yet. Send to agent carries out every ready decision.'
  else if (item.state === 'sent') text = `Sent to the agent ${when(item.sentAt)}.`
  else if (item.state === 'working') text = 'A session is working on it and reports back when it finishes.'
  else if (item.state === 'failed') text = 'It didn’t finish. See the detail below.'
  else text = `${DECISION_LABEL[item.decision]}: done.`
  return (
    <p className={`decision-status${item.state === 'failed' ? ' error' : ''}`}>
      <span>{text}</span>
      {(busy || item.state === 'failed') && (
        <button type="button" className="link" onClick={() => actions.reset(finding.key)}>
          {item.state === 'failed' ? 'Try again' : 'Reset'}
        </button>
      )}
    </p>
  )
}

function Decision({ finding, state, actions }: { finding: FindingView; state: QaState; actions: DetailActions }) {
  const [picking, setPicking] = useState(false)
  const item = finding.item
  const busy = item?.state === 'sent' || item?.state === 'working'
  const suggestion = finding.recommendation
  return (
    <section className="decision" aria-label="Decision">
      <div className="segmented" role="group" aria-label="Decide">
        {DECISIONS.map((decision) => (
          <button
            key={decision.id}
            type="button"
            aria-pressed={item?.decision === decision.id}
            disabled={busy}
            title={`${decision.hint}${decision.id === 'tracked' ? '' : ` (${decision.key})`}`}
            onClick={() => {
              if (decision.id === 'tracked') setPicking(true)
              else actions.decide(finding.key, item?.decision === decision.id ? null : decision.id)
            }}
          >
            {decision.label}
          </button>
        ))}
      </div>
      {picking && !busy && <TrackedPicker finding={finding} actions={actions} onDone={() => setPicking(false)} />}
      <Status finding={finding} state={state} actions={actions} />
      {!item?.decision && suggestion && (
        <p className="suggestion">
          <span className="label">Suggested</span>
          <strong>{DECISION_LABEL[suggestion.outcome]}</strong>
          {suggestion.reason && (
            <span>
              <InlineMarkdown text={suggestion.reason} />
            </span>
          )}
          <button type="button" className="link" onClick={() => (suggestion.outcome === 'tracked' ? setPicking(true) : actions.decide(finding.key, suggestion.outcome))}>
            Use it
          </button>
        </p>
      )}
      <NoteBox key={finding.key} finding={finding} actions={actions} />
      {item && (item.links.length > 0 || item.detail) && (
        <div className="block">
          <p className="label">Result</p>
          {item.links.length > 0 && (
            <ul className="rows">
              {item.links.map((link) => (
                <LinkRow key={link.url ?? link.path} link={link} links={state.links} actions={actions} />
              ))}
            </ul>
          )}
          {item.detail && <Markdown text={item.detail} />}
        </div>
      )}
    </section>
  )
}

export function Detail({ finding, state, actions, onBack }: { finding: FindingView; state: QaState; actions: DetailActions; onBack?: () => void }) {
  const run = state.runs.find((entry) => entry.id === finding.runId)
  const { repro } = finding
  const latest = finding.seen.at(-1)!
  const hasRepro = Boolean(repro.setup || repro.steps.length || repro.expected || repro.actual)
  return (
    <article className="detail" aria-label={plainText(finding.title)}>
      {onBack && (
        <button type="button" className="link back" onClick={onBack}>
          ← All findings
        </button>
      )}
      <div className="block">
        <p className={`meta sev sev-${finding.severity}`}>
          <span className="sev-text">
            <span className="swatch" /> {SEVERITY_LABEL[finding.severity]}
          </span>
          <span>{finding.area}</span>
          <span>{STATUS_LABEL[finding.status]}</span>
          <span>
            {finding.id} in {finding.runId}
          </span>
          {finding.seen.length > 1 && <span>seen in {finding.seen.length} runs</span>}
        </p>
        <h2 className="headline">
          <InlineMarkdown text={finding.title} />
        </h2>
      </div>
      <Decision finding={finding} state={state} actions={actions} />
      {finding.summary && (
        <div className="block">
          <p className="label">Summary</p>
          <Markdown text={finding.summary} />
        </div>
      )}
      {hasRepro && (
        <div className="block">
          <p className="label">Repro</p>
          {repro.setup && (
            <div className="field">
              <span className="muted">Setup</span>
              <Markdown text={repro.setup} />
            </div>
          )}
          {repro.steps.length > 0 && (
            <ol className="steps">
              {repro.steps.map((step, index) => (
                <li key={index}>
                  <Markdown text={step} />
                </li>
              ))}
            </ol>
          )}
          {repro.expected && (
            <div className="field">
              <span className="muted">Expected</span>
              <Markdown text={repro.expected} />
            </div>
          )}
          {repro.actual && (
            <div className="field">
              <span className="muted">Actual</span>
              <Markdown text={repro.actual} />
            </div>
          )}
        </div>
      )}
      {finding.media.length > 0 && (
        <div className="block">
          <p className="label">Screenshots and recordings</p>
          <MediaStrip media={finding.media} onOpenFile={actions.openFile} />
        </div>
      )}
      {(finding.matches.length > 0 || finding.prs.length > 0 || finding.owner) && (
        <div className="block">
          <p className="label">Related</p>
          <ul className="rows">
            {finding.matches.map((match) => (
              <li key={match.url} className="row">
                <span className="row-kind">{match.relation === 'duplicate' ? 'Same issue' : 'Related issue'}</span>
                <a href={match.url} target="_blank" rel="noopener noreferrer" title={match.url}>
                  {githubRef(match.url) ?? match.url}
                </a>
                {match.state && <span className="row-note">{match.state}</span>}
                {match.note && (
                  <span className="row-note">
                    <InlineMarkdown text={match.note} />
                  </span>
                )}
              </li>
            ))}
            {finding.prs.map((url) => (
              <li key={url} className="row">
                <span className="row-kind">Pull request</span>
                <a href={url} target="_blank" rel="noopener noreferrer" title={url}>
                  {githubRef(url) ?? url}
                </a>
              </li>
            ))}
            {finding.owner && (
              <li className="row">
                <span className="row-kind">Owner</span>
                <span>@{finding.owner.login}</span>
                {finding.owner.reason && <span className="row-note">{finding.owner.reason}</span>}
              </li>
            )}
          </ul>
        </div>
      )}
      <p className="history">
        Seen in {finding.seen.map((sighting) => `${sighting.runId} (${STATUS_LABEL[sighting.status].toLowerCase()})`).join(', ')}. Key <code>{finding.key}</code>.
        {latest.status === 'fixed' && ` Fixed as of ${latest.runId}.`}
        {run?.report && (
          <>
            {' '}
            <button type="button" className="link" onClick={() => actions.openFile(run.report!)}>
              Open report
            </button>
          </>
        )}
      </p>
    </article>
  )
}
