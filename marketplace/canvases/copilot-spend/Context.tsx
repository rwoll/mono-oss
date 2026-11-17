import { useState } from 'react'
import { InlineMarkdown } from '../../ui'
import { Meter, ReadBar, ReadLegend } from './Bars.tsx'
import { percent, type ContextItem, type SpendState } from './shared.ts'
import { Toggle } from './Strip.tsx'

// Skills and MCP servers: how much of what the model read they took, and how much of
// that was read in sessions that never used them.

type Rank = 'unused' | 'share'
const SHOWN = 8
/** Below this share, the skills and MCP parts of the bar are too thin to see, so they are drawn again on their own. */
const ENLARGE_BELOW = 0.1

function sessionsText(item: ContextItem) {
  if (item.kind === 'mcp') {
    return (
      <>
        available in {item.sessions}, <b>called in {item.used}</b>
        {item.calls > 0 && (
          <small>
            {' '}
            · {item.calls} call{item.calls === 1 ? '' : 's'}
            {item.failed > 0 && `, ${item.failed} failed`}
          </small>
        )}
      </>
    )
  }
  return (
    <>
      loaded in {item.sessions}, <b>used in {item.used}</b>
      {item.unknown > 0 && <small> · cannot tell in {item.unknown}</small>}
    </>
  )
}

export function Context({ state }: { state: SpendState }) {
  const [rank, setRank] = useState<Rank>('unused')
  const [all, setAll] = useState(false)
  const { read, items } = state.context
  const context = read.skills + read.mcpDefs + read.mcpResults
  const unused = read.unusedSkills + read.unusedMcp
  const sorted = [...items].sort((a, b) => (rank === 'unused' ? b.unused - a.unused || b.share - a.share : b.share - a.share || b.unused - a.unused))
  const shown = all ? sorted : sorted.slice(0, SHOWN)
  const widest = Math.max(...items.map((item) => item.share), 0)
  // The same split, with only the skills and MCP parts, scaled to fill the bar.
  const enlarged = context > 0 && context < ENLARGE_BELOW
  const scaled = { ...read, base: 0, conversation: 0, output: 0, skills: read.skills / context, mcpDefs: read.mcpDefs / context, mcpResults: read.mcpResults / context, unusedSkills: read.unusedSkills / context, unusedMcp: read.unusedMcp / context }

  return (
    <section className="panel" aria-labelledby="context-title">
      <header className="panel-head">
        <h2 id="context-title">Skills and MCP servers</h2>
        <span className="sub">
          {state.context.skills} skill{state.context.skills === 1 ? '' : 's'} · {state.context.mcp} MCP server{state.context.mcp === 1 ? '' : 's'} · {percent(context)} of what the model read ·{' '}
          {percent(unused)} loaded and not used
        </span>
        <Toggle<Rank> label="Rank by" value={rank} onChange={setRank} options={[['unused', 'Loaded, not used'], ['share', 'Share read']]} />
      </header>
      <div className="panel-body">
        <h3 className="label">
          What the model read · all {state.totals.sessions} session{state.totals.sessions === 1 ? '' : 's'}
        </h3>
        <ReadBar read={read} label="What the model read in all sessions" text />
        <ReadLegend read={read} />
        {enlarged && (
          <>
            <h3 className="label enlarged">Skills and MCP, enlarged · {percent(context)} of the bar above</h3>
            <ReadBar read={scaled} label="The skills and MCP part of what the model read" parts={['skills', 'mcpDefs', 'mcpResults']} />
          </>
        )}
        <p className="note">
          <InlineMarkdown>{state.context.note}</InlineMarkdown>
        </p>
        {items.length > 0 && (
          <table className="items">
            <thead>
              <tr>
                <th scope="col" className="rank">
                  <span className="sr-only">Rank</span>
                </th>
                <th scope="col">Skill or MCP server</th>
                <th scope="col">Sessions · MCP tool calls</th>
                <th scope="col" colSpan={2}>
                  Share of what the model read
                </th>
                <th scope="col" className="num">
                  Loaded, not used
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((item, index) => (
                <tr key={`${item.kind}:${item.name}`}>
                  <td className="rank">{index + 1}</td>
                  <th scope="row">
                    <code>{item.name}</code>
                    <span className="kind">
                      <i className={`swatch ${item.kind === 'mcp' ? 'tone-mcp' : 'tone-skills'}`} aria-hidden="true" />
                      {item.kind === 'mcp' ? `MCP${item.tools ? ` · ${item.tools} tool${item.tools === 1 ? '' : 's'}` : ''}` : 'skill'}
                    </span>
                  </th>
                  <td>{sessionsText(item)}</td>
                  <td className="meter-cell">
                    <Meter share={widest ? item.share / widest : 0} hatched={widest ? item.unused / widest : 0} tone={item.kind === 'mcp' ? 'tone-mcp' : 'tone-skills'} />
                  </td>
                  <td className="num muted">{percent(item.share)}</td>
                  <td className="num">
                    <b>{percent(item.unused)}</b>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {items.length > SHOWN && (
          <p className="more">
            <span>{all ? `All ${items.length} are shown.` : `${items.length - SHOWN} more, each with less ${rank === 'unused' ? 'unused context' : 'context'} than the ones above.`}</span>
            <button type="button" className="link" onClick={() => setAll(!all)}>
              {all ? `Show the first ${SHOWN}` : `Show all ${items.length}`}
            </button>
          </p>
        )}
      </div>
    </section>
  )
}
