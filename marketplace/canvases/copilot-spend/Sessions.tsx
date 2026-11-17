import { Fragment } from 'react'
import { InlineMarkdown } from '../../ui'
import { Bar, Key, Meter, ReadBar, ReadLegend, type Segment } from './Bars.tsx'
import { useAction } from './hooks.ts'
import { OUTLIER, TASK_LABELS, TASK_TYPES, credits, duration, percent, times, type SessionDetail, type SessionRow, type SpendState, type TaskType } from './shared.ts'

// The most expensive sessions, each with what set it apart and what the model read in it.
// The selected one opens to its models, tool calls, skills, and MCP servers.

const CLIENTS: Record<string, string> = { 'vscode-agent-host': 'VS Code', 'copilot-agent': 'Copilot CLI', cli: 'Copilot CLI' }
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
const names = (items: readonly string[]) =>
  items.map((name) => (
    <Fragment key={name}>
      {' '}
      <code>{name}</code>
    </Fragment>
  ))

function Unused({ row }: { row: SessionRow }) {
  const share = row.read.unusedSkills + row.read.unusedMcp
  if (!row.unusedSkills.length && !row.unusedMcp.length) return <p className="unused-line muted">Nothing loaded went unused.</p>
  return (
    <p className="unused-line">
      <i className="swatch tone-skills unused" aria-hidden="true" /> <b>{percent(share)}</b> loaded, not used:
      {row.unusedSkills.length > 0 && (
        <>
          {' '}
          skill{row.unusedSkills.length === 1 ? '' : 's'}
          {names(row.unusedSkills)}
        </>
      )}
      {row.unusedSkills.length > 0 && row.unusedMcp.length > 0 && ' ·'}
      {row.unusedMcp.length > 0 && <> MCP{names(row.unusedMcp)}</>}
    </p>
  )
}

function Detail({ row, detail }: { row: SessionRow; detail: SessionDetail }) {
  const [setTypes, typing] = useAction('set_task_types')
  const [ask, asking] = useAction('ask_about_session')
  const { within } = detail
  const models: Segment[] = detail.models.map((model, index) => ({ key: model.model, share: model.share, tone: index === 0 ? 'tone-model' : index === 1 ? 'tone-model-2' : 'tone-base', label: model.model, text: percent(model.share) }))
  const type: Segment[] = [
    { key: 'self', share: within.self, tone: 'tone-hot', label: 'This session', text: percent(within.self) },
    ...(within.next ? [{ key: 'next', share: within.next.share, tone: 'tone-hot-2', label: `Session ${within.next.rank}`, text: percent(within.next.share) }] : []),
    ...(within.restCount ? [{ key: 'rest', share: within.rest, tone: 'tone-base', label: `The other ${within.restCount} session${within.restCount === 1 ? '' : 's'}`, text: percent(within.rest) }] : []),
  ]
  return (
    <div className="detail" role="region" aria-label={`Detail of session ${row.rank}`}>
      <div className="detail-columns">
        <div>
          <h4 className="label">This session’s AIC by model</h4>
          <Bar label="AIC by model" segments={models} />
          <p className="legend">
            {detail.models.map((model, index) => (
              <Key key={model.model} tone={index === 0 ? 'tone-model' : index === 1 ? 'tone-model-2' : 'tone-base'}>
                <code>{model.model}</code> {percent(model.share)}
                {model.aic !== null && ` · ${credits(model.aic)}`}
              </Key>
            ))}
          </p>
          {detail.subagents > 0 && (
            <>
              <h4 className="label">By agent</h4>
              <Bar
                label="AIC by agent"
                segments={[
                  { key: 'main', share: 1 - detail.subagentShare, tone: 'tone-output', label: 'Main agent', text: percent(1 - detail.subagentShare) },
                  { key: 'sub', share: detail.subagentShare, tone: 'tone-hot', label: `${detail.subagents} sub-agent${detail.subagents === 1 ? '' : 's'}`, text: percent(detail.subagentShare) },
                ]}
              />
              <p className="legend">
                <Key tone="tone-output">main agent {percent(1 - detail.subagentShare)}</Key>
                <Key tone="tone-hot">
                  {detail.subagents} sub-agent{detail.subagents === 1 ? '' : 's'} {percent(detail.subagentShare)}
                </Key>
              </p>
            </>
          )}
          <h4 className="label split">
            <span>Within {TASK_LABELS[within.type]}</span>
            <span>
              {within.sessions} session{within.sessions === 1 ? '' : 's'} · {percent(within.typeShare)} of all AIC
            </span>
          </h4>
          <Bar label={`Share of ${TASK_LABELS[within.type]}`} segments={type} />
          <p className="legend">
            {type.map((segment) => (
              <Key key={segment.key} tone={segment.tone}>
                {segment.label}
              </Key>
            ))}
          </p>
        </div>
        <div>
          <h4 className="label split">
            <span>Tool calls</span>
            <span>share of calls · {percent(detail.failed)} failed</span>
          </h4>
          <ul className="tools">
            {detail.tools.map((tool) => (
              <li key={tool.name}>
                <span>{tool.name}</span>
                <span className="meter wide" aria-hidden="true">
                  <i className="tone-output" style={{ width: `${tool.share * (1 - tool.failed) * 100}%` }} />
                  <i className="tone-bad" style={{ width: `${tool.share * tool.failed * 100}%` }} />
                </span>
                <span className="num">
                  {percent(tool.share)}
                  {tool.failed > 0 && <small className="bad"> {percent(tool.failed)} failed</small>}
                </span>
              </li>
            ))}
          </ul>
          <p className="legend">
            <Key tone="tone-output">succeeded</Key>
            <Key tone="tone-bad">failed</Key>
          </p>
        </div>
      </div>

      <h4 className="label split">
        <span>What the model read in this session</span>
        <span>{percent(detail.read.unusedSkills + detail.read.unusedMcp)} loaded and not used</span>
      </h4>
      <ReadBar read={detail.read} label="What the model read in this session" text />
      <ReadLegend read={detail.read} />

      <div className="detail-columns">
        <div>
          <h4 className="label split">
            <span>Skills loaded</span>
            <span>
              {detail.skills.length} skill{detail.skills.length === 1 ? '' : 's'} · {percent(detail.read.skills)} of what it read
            </span>
          </h4>
          {detail.skills.length === 0 && <p className="muted">No skill was loaded.</p>}
          <ul className="loaded">
            {detail.skills.map((skill) => (
              <li key={skill.name}>
                <div>
                  <code>{skill.name}</code> <span className={`verdict ${skill.verdict}`}>{skill.verdict === 'unused' ? 'not used' : skill.verdict === 'partly' ? 'partly used' : skill.verdict === 'unknown' ? 'cannot tell' : 'used'}</span>
                  <p className="muted">
                    Loaded {skill.loadedAfterMs < 60_000 ? 'at the start' : `${duration(skill.loadedAfterMs)} in`}. <InlineMarkdown>{skill.note}</InlineMarkdown>
                  </p>
                </div>
                <Meter share={detail.read.skills ? skill.share / detail.read.skills : 0} tone={`tone-skills${skill.verdict === 'unused' ? ' unused' : ''}`} />
                <span className="num">{percent(skill.share)}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h4 className="label split">
            <span>MCP servers available</span>
            <span>
              {detail.mcp.length} server{detail.mcp.length === 1 ? '' : 's'} · {percent(detail.read.mcpDefs + detail.read.mcpResults)} of what it read
            </span>
          </h4>
          {detail.mcp.length === 0 && <p className="muted">The model was given no MCP tools.</p>}
          <ul className="loaded">
            {detail.mcp.map((server) => (
              <li key={server.name}>
                <div>
                  <code>{server.name}</code> <span className={`verdict ${server.used ? 'used' : 'unused'}`}>{server.used ? 'used' : 'not used'}</span>
                  <p className="muted">{server.note}</p>
                </div>
                <Meter share={detail.read.mcpDefs + detail.read.mcpResults ? server.share / (detail.read.mcpDefs + detail.read.mcpResults) : 0} tone={`tone-mcp${server.used ? '' : ' unused'}`} />
                <span className="num">{percent(server.share)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="button-row">
        <button type="button" className="primary" disabled={asking.pending} onClick={() => void ask({ id: row.id })}>
          Ask the agent why
        </button>
        <label className="type-choice">
          Task type
          <select
            value={row.typeSource === 'auto' ? '' : row.type}
            disabled={typing.pending}
            onChange={(event) => void setTypes({ types: [{ id: row.id, type: (event.target.value || null) as TaskType | null }] })}
          >
            <option value="">{row.typeSource === 'auto' ? `${TASK_LABELS[row.type]} (worked out)` : 'Work it out'}</option>
            {TASK_TYPES.map((option) => (
              <option key={option} value={option}>
                {TASK_LABELS[option]}
              </option>
            ))}
          </select>
        </label>
        {row.typeSource !== 'auto' && <span className="muted">Chosen by {row.typeSource === 'you' ? 'you' : 'the agent'}.</span>}
        <span className="muted session-id">
          Session <code>{row.id}</code>
        </span>
      </div>
      {(asking.error ?? typing.error) && (
        <p className="error" role="alert">
          {(asking.error ?? typing.error)?.message}
        </p>
      )}
    </div>
  )
}

export function Sessions({ state, onSelect }: { state: SpendState; onSelect(id: string | null): void }) {
  const [showSessions, showing] = useAction('show_sessions')
  const { top, rows, more, totals } = state
  const ranked = rows.filter((row) => row.rank <= top.count)
  const rest = Math.max(0, 1 - top.share)

  return (
    <section className="panel" aria-labelledby="sessions-title">
      <header className="panel-head">
        <h2 id="sessions-title">Most expensive sessions</h2>
        <span className="sub">
          {top.count} of {totals.sessions} session{totals.sessions === 1 ? '' : 's'} · {percent(top.share)} of all AIC
          {top.outliers > 0 && ` · ${top.outliers} of them more than ${OUTLIER}× their task type’s median, ${percent(top.outlierShare)} of all AIC`}
        </span>
      </header>
      <div className="concentration" role="group" aria-label="Share of all AIC by session">
        {ranked.map((row) => (
          <button
            key={row.id}
            type="button"
            className={`${row.multiple > OUTLIER ? 'tone-hot' : 'tone-plain'}${row.id === state.selected ? ' selected' : ''}`}
            style={{ flexGrow: row.share }}
            title={`Session ${row.rank}: ${percent(row.share)} of all AIC`}
            aria-label={`Session ${row.rank}: ${percent(row.share)} of all AIC`}
            aria-pressed={row.id === state.selected}
            onClick={() => onSelect(row.id === state.selected ? null : row.id)}
          >
            {row.rank}
          </button>
        ))}
        {rest > 0.0005 && (
          <span className="rest" style={{ flexGrow: rest }}>
            other {totals.sessions - top.count} session{totals.sessions - top.count === 1 ? '' : 's'} · {percent(rest)}
          </span>
        )}
      </div>
      <div className="panel-body">
        <ReadLegend lead="What the model read in each session:" />
      </div>
      <ol className="sessions">
        {rows.map((row) => {
          const selected = row.id === state.selected
          const hot = row.multiple > OUTLIER
          return (
            <li key={row.id} className={selected ? 'selected' : undefined}>
              <div className="session">
                <span className={`mark static${hot ? ' hot' : ''}${row.rank > top.count ? ' plain' : ''}`} aria-hidden="true">
                  {row.rank}
                </span>
                <div className="what">
                  <h3>
                    <button type="button" className="title-button" aria-expanded={selected} onClick={() => onSelect(selected ? null : row.id)}>
                      <span className="sr-only">Session {row.rank}: </span>
                      {row.title}
                    </button>
                  </h3>
                  <p className="meta">
                    <b>{TASK_LABELS[row.type]}</b>
                    {row.repository && ` · ${row.repository}`}
                    {row.branch && ` · ${row.branch}`}
                  </p>
                  <p className="meta">
                    {CLIENTS[row.client] ?? (row.client || 'Copilot')} · {day(row.endedAt)} · {duration(row.activeMs)} active
                  </p>
                  <p className="meta">{row.filesChanged ? `${row.filesChanged} file${row.filesChanged === 1 ? '' : 's'} changed` : 'No files changed'}</p>
                </div>
                <div className="why">
                  <p className="tag">{row.reason.tag}</p>
                  <p>
                    <InlineMarkdown>{row.reason.text}</InlineMarkdown>
                  </p>
                </div>
                <div className={`multiple${hot ? ' hot' : ''}`}>
                  <b>{times(row.multiple)}</b>
                  <small>{hot ? `above ${OUTLIER}×` : `within ${OUTLIER}×`}</small>
                  <small>{percent(row.shareOfType)} of its type</small>
                </div>
                <div className="portion">
                  <b>{percent(row.share)}</b>
                  {row.aic !== null && <small>{credits(row.aic)}</small>}
                  <Meter share={rows[0] ? row.share / (rows[0].share || 1) : 0} tone={hot ? 'tone-hot' : 'tone-plain'} />
                </div>
                <div className="read-cell">
                  <ReadBar read={row.read} label={`What the model read in session ${row.rank}`} />
                  <p className="meta">
                    Skills {percent(row.read.skills)} · MCP {percent(row.read.mcpDefs + row.read.mcpResults)} of what it read
                  </p>
                </div>
                <div className="unused-cell">
                  <Unused row={row} />
                </div>
              </div>
              {selected && state.detail && <Detail row={row} detail={state.detail} />}
            </li>
          )
        })}
      </ol>
      {(more.count > 0 || state.showAll) && (
        <p className="more">
          <span>
            {state.showAll
              ? `All ${totals.sessions} sessions are listed.`
              : `${more.count} more session${more.count === 1 ? '' : 's'} · ${percent(more.share)} of all AIC · ${percent(more.largest)} or less each`}
          </span>
          <button type="button" className="link" disabled={showing.pending} onClick={() => void showSessions({ all: !state.showAll })}>
            {state.showAll ? `Show the top ${top.count}` : `Show all ${totals.sessions}`}
          </button>
        </p>
      )}
    </section>
  )
}
