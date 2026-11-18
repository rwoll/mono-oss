import { useEffect, useRef, type CSSProperties } from 'react'
import { createCanvasHooks } from '@rwoll/canvas-kit/react'
import { Header, RefreshIcon } from '../../ui'
import type canvas from './canvas.ts'
import { STAGES, STAGE_LABELS, type Skill } from './shared.ts'
import { Wheel } from './Wheel.tsx'
import '../../ui/theme.css'
import './App.css'

const { useCanvas, useAction } = createCanvasHooks<typeof canvas>()

/** How long after the agent does something the log is read again, once it has been written. */
const FOLLOW_MS = 2000
/** The most dots in a row, and with a great many skills. */
const PER_ROW = 24
const PER_ROW_MANY = 40

/** How many dots go in a row, so the rows are about as long as each other. */
function columns(skills: number): number {
  const most = skills > PER_ROW * 3 ? PER_ROW_MANY : PER_ROW
  return Math.max(1, Math.ceil(skills / Math.ceil(skills / most)))
}

const tip = (skill: Skill) => [skill.name, skill.description].filter(Boolean).join('\n')

function App() {
  const { state, agent } = useCanvas()
  const [refresh, refreshing] = useAction('refresh')

  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    void refresh()
  }, [refresh])

  // The log grows as the agent works: read it again a moment after each thing the agent
  // does, and once more when something else happened during the wait.
  const activity = `${agent.busy}:${agent.lastActivityAt ?? ''}`
  const follow = useRef<{ seen: string; timer: number | undefined; again: boolean }>({ seen: activity, timer: undefined, again: false })
  useEffect(() => {
    const current = follow.current
    if (current.seen === activity) return
    current.seen = activity
    if (current.timer !== undefined) {
      current.again = true
      return
    }
    const wait = () => {
      current.timer = window.setTimeout(() => {
        current.timer = undefined
        void refresh()
        if (current.again) {
          current.again = false
          wait()
        }
      }, FOLLOW_MS)
    }
    wait()
  }, [activity, refresh])
  useEffect(() => () => window.clearTimeout(follow.current.timer), [])

  const { counts, skills } = state
  const invoked = skills.filter((skill) => skill.stage === 'invoked')

  return (
    <>
      <Header title={state.title ? `Skills · ${state.title}` : 'Skills'}>
        <button
          type="button"
          className={`icon-button${refreshing.pending ? ' spinning' : ''}`}
          aria-label="Read the session again"
          title="Read the session again"
          aria-disabled={refreshing.pending}
          onClick={() => !refreshing.pending && void refresh()}
        >
          <RefreshIcon />
        </button>
      </Header>
      <main className="page funnel" style={{ '--columns': columns(skills.length) } as CSSProperties}>
        {(state.error ?? refreshing.error) && (
          <p className="banner" role="alert">
            {state.error ?? refreshing.error?.message}
          </p>
        )}
        {state.status === 'idle' && (
          <p className="notice busy" role="status">
            Reading the session…
          </p>
        )}
        {state.status === 'ready' && (
          <div className="board">
            <div className="rows">
              <ol className="stages" aria-label="The session’s skills">
                {STAGES.map((stage) => (
                  <li key={stage} className={`stage ${stage}`}>
                    <div className="figure">
                      <p className="count">{counts[stage]}</p>
                      <h2 className="label">{STAGE_LABELS[stage]}</h2>
                    </div>
                    {/* One dot per skill, in the same place in both rows, lit when the skill got this far. */}
                    <div className="dots" aria-hidden="true">
                      {skills.map((skill) => (
                        <i key={skill.name} className={stage === 'available' || skill.stage === 'invoked' ? 'on' : undefined} title={tip(skill)} />
                      ))}
                    </div>
                  </li>
                ))}
              </ol>
              {invoked.length > 0 && (
                <ul className="chips invoked" aria-label="Invoked skills">
                  {invoked.map((skill) => (
                    <li key={skill.name} title={tip(skill)}>
                      {skill.name}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {state.context && <Wheel context={state.context} />}
            {!state.listed && <p className="notice warn">This session’s log does not list its available skills.</p>}
          </div>
        )}
      </main>
    </>
  )
}

export default App
