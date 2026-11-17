import { useState } from 'react'
import { Header } from '../../ui'
import { Duel } from './Duel.tsx'
import { Expanded } from './Expanded.tsx'
import { client, saved, track, useCanvas } from './hooks.ts'
import type { Round, Variant } from './schema.ts'
import { formatCredits, madeWith } from './shared.ts'
import { NoteField, VariantCard, type Backdrop, type CardActions } from './Variant.tsx'
import '../../ui/theme.css'
import './App.css'

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`
const stamp = (time: string) => new Date(time).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

function Segmented<T extends string>({ label, options, value, onChange }: { label: string; options: readonly (readonly [T, string])[]; value: T; onChange: (value: T) => void }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map(([option, text]) => (
        <button key={option} type="button" aria-pressed={value === option} onClick={() => onChange(option)}>
          {text}
        </button>
      ))}
    </div>
  )
}

function App() {
  const { state, agent } = useCanvas()
  const [layout, setLayout] = useState<'grid' | 'duel'>('grid')
  const [backdrop, setBackdrop] = useState<Backdrop>('light')
  const [source, setSource] = useState(false)
  const [blind, setBlind] = useState(true)
  const [error, setError] = useState<string>()
  const [sending, setSending] = useState(false)
  // The variant shown alone over the page, and the ones to flip between from there.
  const [expanded, setExpanded] = useState<{ id: string; among: readonly string[] } | null>(null)
  // The round on screen: the latest, unless the user is looking back at an earlier one.
  const [viewing, setViewing] = useState<{ round: number | null; rounds: number }>({ round: null, rounds: state.rounds.length })
  if (viewing.rounds !== state.rounds.length) setViewing({ round: null, rounds: state.rounds.length })

  const latest = state.rounds.at(-1) as Round
  const round = state.rounds.find((candidate) => candidate.number === viewing.round) ?? latest
  const readOnly = round !== latest
  const variants = new Map(state.variants.map((variant) => [variant.id, variant]))
  const shown = round.entries.map((entry) => ({ entry, variant: variants.get(entry.variant) as Variant }))
  const kinds = new Set(shown.map(({ variant }) => variant.kind))
  const winner = shown.find(({ entry }) => entry.vote === 'pick')?.variant
  const count = (vote: 'keep' | 'drop') => round.entries.filter((entry) => entry.vote === vote).length
  const notes = round.entries.filter((entry) => entry.note.trim()).length
  const credits = shown.filter(({ variant, entry }) => variant.credits !== null && !entry.carried)
  const hasProvenance = shown.some(({ variant }) => madeWith(variant))
  const contenders = shown.filter(({ entry }) => entry.vote !== 'drop').map(({ variant }) => variant)
  const duel = layout === 'duel' && !readOnly && shown.length > 0
  const alone = expanded ? variants.get(expanded.id) : undefined
  // Head to head shows no votes or notes, expanded or not.
  const aloneEntry = duel ? undefined : round.entries.find((entry) => entry.variant === alone?.id)

  /** Run an action, and say so when it fails. */
  const attempt = async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    try {
      const result = await action()
      setError(undefined)
      return result
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      return undefined
    }
  }
  const run = client().run
  const actions: CardActions = {
    vote: (variant, vote) => void attempt(() => run('vote', { variant, vote })),
    note: (variant, note) => attempt(() => run('set_note', { variant, note })),
    // The note the user just typed is saved first, so the mark's number lands after it.
    mark: (variant, mark) => attempt(() => saved().then(() => run('add_mark', { variant, ...mark }))),
    unmark: (variant, n) => void attempt(() => run('remove_mark', { variant, n })),
  }
  const send = async (kind: 'next' | 'use') => {
    setSending(true)
    await saved()
    await attempt(() => run('send', { kind }))
    setSending(false)
  }

  const view = { backdrop, source }
  const hints = [
    ...(kinds.has('image') || kinds.has('html') ? [`Click a spot on ${[...(kinds.has('image') ? ['an image'] : []), ...(kinds.has('html') ? ['a mock'] : [])].join(' or ')} to pin a note to it.`] : []),
    ...(kinds.has('markdown') || kinds.has('text') || kinds.has('html') ? ['Select text in a variant to comment on it.'] : []),
  ]

  return (
    <div className={duel ? 'app fill' : 'app'}>
      <Header title={`Bakeoff · ${state.title}`} badge={<span className={`pill ${readOnly ? 'status-idle' : 'status-working'}`}>Round {round.number}</span>} />
      <main className="page">
        {shown.length > 0 && (
          <div className="toolbar">
            {state.rounds.length > 1 && (
              <label className="field">
                <span>Round</span>
                <select value={round.number} onChange={(event) => setViewing({ round: Number(event.target.value) === latest.number ? null : Number(event.target.value), rounds: state.rounds.length })}>
                  {state.rounds.map(({ number }) => (
                    <option key={number} value={number}>
                      {number}
                      {number === latest.number ? ' (now)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {!readOnly && (
              <Segmented
                label="Layout"
                value={layout}
                onChange={setLayout}
                options={[
                  ['grid', 'Grid'],
                  ['duel', 'Head to head'],
                ]}
              />
            )}
            {(kinds.has('image') || kinds.has('video') || kinds.has('html')) && (
              <div className="field">
                <span>Backdrop</span>
                <Segmented
                  label="Backdrop"
                  value={backdrop}
                  onChange={setBackdrop}
                  options={[['light', 'Light'], ['dark', 'Dark'], ...(kinds.has('image') ? ([['checker', 'Checker']] as const) : [])]}
                />
              </div>
            )}
            {(kinds.has('markdown') || kinds.has('html')) && (
              <Segmented
                label="Show"
                value={source ? 'source' : 'rendered'}
                onChange={(value) => setSource(value === 'source')}
                options={[
                  ['rendered', 'Rendered'],
                  ['source', 'Source'],
                ]}
              />
            )}
            {hasProvenance && (
              <label className="check" title="Hide the models, credits, and approach behind each variant until you have looked">
                <input type="checkbox" checked={blind} onChange={(event) => setBlind(event.target.checked)} /> Blind
              </label>
            )}
          </div>
        )}

        {state.brief && <p className="notice">Asked for: {state.brief}</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        {shown.length === 0 ? (
          <p className="notice empty">No variants yet. Ask the agent for a few options of something, such as "Give me four logo ideas and put them in the bakeoff."</p>
        ) : readOnly ? (
          <p className="notice">
            Round {round.number} is closed{round.sent ? `: this is what you sent the agent ${stamp(round.sent.at)}` : ''}.{' '}
            <button type="button" className="link" onClick={() => setViewing({ round: null, rounds: state.rounds.length })}>
              Back to round {latest.number}
            </button>
          </p>
        ) : (
          layout === 'grid' && hints.length > 0 && <p className="notice">{hints.join(' ')}</p>
        )}

        {shown.length > 0 &&
          (duel ? (
            <Duel
              bakeoff={state.id}
              variants={contenders}
              {...view}
              onWinner={(variant) => actions.vote(variant, 'pick')}
              onDone={() => setLayout('grid')}
              onExpand={(id, among) => setExpanded({ id, among })}
              paused={alone !== undefined}
            />
          ) : (
            <div className="grid">
              {shown.map(({ entry, variant }) => (
                <VariantCard
                  key={variant.id}
                  bakeoff={state.id}
                  variant={variant}
                  entry={entry}
                  blind={blind && !readOnly}
                  readOnly={readOnly}
                  actions={actions}
                  onExpand={() => setExpanded({ id: variant.id, among: shown.map((each) => each.variant.id) })}
                  {...view}
                />
              ))}
            </div>
          ))}

        {/* Head to head shows no earlier votes, so nothing sways the pick. */}
        {shown.length > 0 && (layout === 'grid' || readOnly) && (
          <section className="block outcome" aria-label="Decide">
            <h2 className="label">{readOnly ? 'What you decided' : 'Decide'}</h2>
            <p className="notice">
              {[winner ? `Winner: ${winner.label}` : 'No winner yet', `${count('keep')} kept`, `${count('drop')} dropped`, plural(notes, 'note')].join(' · ')}
              {credits.length > 0 && ` · ${formatCredits(credits.reduce((sum, { variant }) => sum + (variant.credits as number), 0))} to make ${readOnly ? "that round's" : "this round's"} ${plural(credits.length, 'variant')}`}
            </p>
            {readOnly ? (
              round.overall.trim() && <p className="said">{round.overall.trim()}</p>
            ) : (
              <div className="outcome-row">
                <NoteField
                  single
                  value={round.overall}
                  onSave={(note) => attempt(() => track(run('set_overall', { note })))}
                  label="Overall feedback"
                  placeholder={'Overall feedback, such as "A\'s layout with C\'s colors"'}
                  disabled={false}
                />
                <div className="button-row">
                  <button type="button" className={winner ? undefined : 'primary'} disabled={sending} onClick={() => void send('next')}>
                    Ask for round {round.number + 1}
                  </button>
                  <button type="button" className={winner ? 'primary' : undefined} disabled={!winner || sending} onClick={() => void send('use')}>
                    {winner ? `Use ${winner.label}` : 'Use the winner'}
                  </button>
                </div>
              </div>
            )}
            {!readOnly && round.sent && (
              <p className="notice busy" role="status">
                {round.sent.kind === 'use' ? `Asked the agent to use ${variants.get(round.sent.variant ?? '')?.label ?? 'the winner'}` : `Asked the agent for round ${round.number + 1}`} {stamp(round.sent.at)}
                {agent.busy ? '; it is working' : ''}.{round.sent.kind === 'next' && ' New variants show up here.'}
              </p>
            )}
          </section>
        )}
      </main>
      {expanded && alone && (
        <Expanded
          bakeoff={state.id}
          variants={expanded.among.flatMap((id) => variants.get(id) ?? [])}
          current={alone}
          review={aloneEntry && { entry: aloneEntry, readOnly, actions }}
          {...view}
          onShow={(id) => setExpanded({ ...expanded, id })}
          onClose={() => setExpanded(null)}
        />
      )}
    </div>
  )
}

export default App
