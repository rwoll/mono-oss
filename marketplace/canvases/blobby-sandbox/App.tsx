import { useEffect, useState } from 'react'
import { createCanvasHooks } from '@rwoll/canvas-kit/react'
import type canvas from './canvas.ts'
import { Screen, type Fit, type Phase } from './Screen.tsx'
import '../../ui/theme.css'
import './App.css'

const { useCanvas, useAction } = createCanvasHooks<typeof canvas>()

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/
const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function NewSandbox({ taken }: { taken: string[] }) {
  const [name, setName] = useState('')
  const [signin, setSignin] = useState(true)
  const [start, { pending, error }] = useAction('start_sandbox')
  const valid = NAME.test(name) && !taken.includes(name)
  return (
    <form
      className="new"
      onSubmit={(event) => {
        event.preventDefault()
        if (valid) void start({ name, signin }).then((result) => result && setName(''))
      }}
    >
      <input aria-label="New sandbox name" placeholder="new-sandbox" value={name} onChange={(event) => setName(event.target.value.toLowerCase())} />
      <label>
        <input type="checkbox" checked={signin} onChange={(event) => setSignin(event.target.checked)} /> Sign in
      </label>
      <button type="submit" disabled={!valid || pending}>
        Start
      </button>
      {name && !NAME.test(name) && <span className="hint">Lowercase letters, digits, and dashes.</span>}
      {error && <span role="alert">{error.message}</span>}
    </form>
  )
}

function SandboxList() {
  const { state } = useCanvas()
  const [select] = useAction('select_sandbox')
  const [start, starting] = useAction('start_sandbox')
  const [stop, stopping] = useAction('stop_sandbox')
  const [remove, removing] = useAction('remove_sandbox')
  const [signIn, signingIn] = useAction('sign_in')
  const busy = new Set(state.tasks.filter((task) => task.state === 'running').map((task) => task.sandbox))
  const error = starting.error ?? stopping.error ?? removing.error ?? signingIn.error
  if (!state.sandboxes.length) return <p className="muted">No sandboxes yet. Start one: the first takes about two minutes, later ones seconds.</p>
  return (
    <>
      <ul className="sandboxes" aria-label="Sandboxes">
        {state.sandboxes.map((sandbox) => {
          const isBusy = busy.has(sandbox.name)
          const isRunning = sandbox.state === 'running'
          return (
            <li key={sandbox.name} className={state.selected === sandbox.name ? 'selected' : undefined}>
              <button type="button" className="name" disabled={!isRunning} title={isRunning ? 'Show it below' : undefined} onClick={() => select({ name: sandbox.name })}>
                {sandbox.name}
              </button>
              <span className="muted">{isBusy ? 'starting…' : sandbox.state}</span>
              <span className="actions">
                {isRunning ? (
                  <>
                    <button type="button" disabled={isBusy} onClick={() => signIn({ name: sandbox.name })}>
                      Sign in
                    </button>
                    <button type="button" disabled={isBusy || stopping.pending} onClick={() => stop({ name: sandbox.name })}>
                      Stop
                    </button>
                  </>
                ) : (
                  <button type="button" disabled={isBusy} onClick={() => start({ name: sandbox.name })}>
                    Start
                  </button>
                )}
                <button
                  type="button"
                  disabled={isBusy || removing.pending}
                  onClick={() => window.confirm(`Delete ${sandbox.name} and its files?`) && remove({ name: sandbox.name })}
                >
                  Remove
                </button>
              </span>
            </li>
          )
        })}
      </ul>
      {error && <p role="alert">{error.message}</p>}
    </>
  )
}

function Viewer({ name, port }: { name: string; port: number }) {
  const { state } = useCanvas()
  const [fit, setFit] = useState<Fit>('scale')
  const [phase, setPhase] = useState<Phase>({ kind: 'connecting' })
  const [screenshot, shooting] = useAction('take_screenshot')
  const [startRecording, recordingStart] = useAction('start_recording')
  const [stopRecording, recordingStop] = useAction('stop_recording')
  const [openInBrowser] = useAction('open_in_browser')
  const [select] = useAction('select_sandbox')
  const recording = state.recording.includes(name)
  const error = shooting.error ?? recordingStart.error ?? recordingStop.error
  const status = phase.kind === 'connected' ? 'Connected' : phase.kind === 'failed' ? phase.message : (phase.message ?? 'Connecting…')
  return (
    <section className="viewer" aria-label={`${name} viewer`}>
      <div className="toolbar">
        <strong>{name}</strong>
        <span className="muted" role="status">
          {status}
        </span>
        <span className="actions">
          <button type="button" disabled={shooting.pending} onClick={() => screenshot({ name })}>
            Screenshot
          </button>
          {recording ? (
            <button type="button" className="recording" disabled={recordingStop.pending} onClick={() => stopRecording({ name })}>
              Stop recording
            </button>
          ) : (
            <button type="button" disabled={recordingStart.pending} onClick={() => startRecording({ name })}>
              Record
            </button>
          )}
          <button type="button" onClick={() => setFit(fit === 'scale' ? 'remote' : 'scale')} title="Scale the screen to the panel, or resize the desktop to fit it">
            {fit === 'scale' ? 'Resize desktop to fit' : 'Scale to fit'}
          </button>
          <button type="button" onClick={() => openInBrowser({ name })}>
            Open in browser
          </button>
          <button type="button" onClick={() => select({ name: null })}>
            Close
          </button>
        </span>
      </div>
      {error && <p role="alert">{error.message}</p>}
      <Screen key={`${name}:${port}`} name={name} port={port} fit={fit} onPhase={setPhase} onReady={() => {}} />
    </section>
  )
}

function Activity() {
  const { state } = useCanvas()
  if (!state.tasks.length) return null
  return (
    <section aria-label="Activity">
      <h2>Activity</h2>
      <ul className="tasks">
        {state.tasks.map((task) => (
          <li key={task.id} className={task.state}>
            <details open={task.state !== 'done'}>
              <summary>
                <span className="state">{task.state === 'running' ? '…' : task.state === 'done' ? '✓' : '✗'}</span> {task.kind === 'start' ? 'Start' : 'Sign in'}{' '}
                {task.sandbox}
                <span className="muted"> · {time(task.startedAt)}</span>
                {task.state === 'running' && task.lines.length > 0 && <span className="muted"> · {task.lines.at(-1)}</span>}
                {task.message && <span> · {task.message}</span>}
              </summary>
              {task.lines.length > 0 && <pre>{task.lines.join('\n')}</pre>}
            </details>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Captures() {
  const { state } = useCanvas()
  if (!state.captures.length) return null
  return (
    <section aria-label="Captures">
      <h2>Screenshots and recordings</h2>
      <ul className="captures">
        {state.captures.map((capture) => (
          <li key={capture.path}>
            <span className="muted">
              {time(capture.at)} · {capture.sandbox} · {capture.kind}
            </span>{' '}
            <code>{capture.path}</code>
          </li>
        ))}
      </ul>
    </section>
  )
}

export default function App() {
  const { state, status } = useCanvas()
  const [refresh] = useAction('refresh')
  const busy = state.tasks.some((task) => task.state === 'running')

  // Starts and sign-ins report progress through refresh, so poll faster while one runs.
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), busy ? 2_000 : 15_000)
    return () => clearInterval(timer)
  }, [busy, refresh])

  const selected = state.sandboxes.find((sandbox) => sandbox.name === state.selected && sandbox.state === 'running' && sandbox.viewerPort !== null)
  return (
    <main>
      <header>
        <h1>Blobby Sandbox</h1>
        <p className="muted">
          {state.account ? `Test account from the ${state.account} secret` : 'No test account'} · {state.sandboxes.length} {state.sandboxes.length === 1 ? 'sandbox' : 'sandboxes'}
          {state.backend && ` on ${state.backend}`}
          {status !== 'live' && ` · ${status === 'connecting' ? 'Connecting…' : 'Offline'}`}
        </p>
      </header>
      {state.problems.length > 0 && (
        <ul className="problems" role="alert">
          {state.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      <NewSandbox taken={state.sandboxes.map((sandbox) => sandbox.name)} />
      <SandboxList />
      {selected && <Viewer name={selected.name} port={selected.viewerPort!} />}
      <Activity />
      <Captures />
      <p className="muted footnote">The test account is compromised by design: anything in a sandbox can use its GitHub session. Use it for nothing else.</p>
    </main>
  )
}
