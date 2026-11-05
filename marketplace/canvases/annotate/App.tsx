import { documentDuration, mediaKind, timeCues, TONES, type AnnotateDocument, type Annotation, type Box, type Cue, type Point, type Tone } from '@rwoll/annotate'
import { AnnotatePlayer, type PlayerView } from '@rwoll/annotate/react'
import { createCanvasHooks, getCanvasClient } from '@rwoll/canvas-kit/react'
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type canvas from './canvas.ts'
import type { AnnotateState } from './canvas.ts'
import { FORMATS, VIDEO_FORMATS, type Format } from './shared.ts'
import '../../ui/theme.css'
import './App.css'

const { useCanvas, useAction } = createCanvasHooks<typeof canvas>()

type Geometry = Box | Point
interface Draft {
  index: number
  field: string
  value: Geometry
}

const BOX_FIELDS = ['box', 'into'] as const
const POINT_FIELDS = ['from', 'to', 'at'] as const
const LABEL_TYPES = new Set<Annotation['type']>(['rect', 'ellipse', 'arrow', 'guide', 'measure', 'magnify'])
const NOTE_TYPES = new Set<Annotation['type']>(['rect', 'ellipse', 'arrow', 'measure'])
const round = (geometry: Geometry) => geometry.map((v) => Math.round(v)) as Geometry
function describe(a: Annotation): string {
  if ('label' in a && a.label) return a.label
  if ('text' in a && a.text) return a.text
  if (a.type === 'measure') return `${Math.round(Math.hypot(a.to[0] - a.from[0], a.to[1] - a.from[1]))} px`
  if (a.type === 'redact') return a.style ?? 'fill'
  return a.id ?? ''
}
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path
const fmt = (t: number) => `${t.toFixed(1)}s`

/** Reads the media's size (and a video's length) in the page, for documents started from an image or video. */
function MediaProbe({ src, video }: { src: string; video: boolean }) {
  const [reportSize, { error }] = useAction('media_info')
  const reported = useRef(false)
  const report = (width: number, height: number, duration?: number) => {
    if (reported.current || width <= 0 || height <= 0) return
    reported.current = true
    void reportSize({ width, height, ...(duration && Number.isFinite(duration) && { duration }) })
  }
  const measureVideo = (element: HTMLVideoElement) => {
    const { videoWidth, videoHeight } = element
    if (Number.isFinite(element.duration)) return report(videoWidth, videoHeight, element.duration)
    // Live recordings (Playwright, MediaRecorder) have no length in their header; seeking past the end makes the browser find it.
    const found = () => {
      if (Number.isFinite(element.duration)) report(videoWidth, videoHeight, element.duration)
    }
    element.addEventListener('durationchange', found)
    setTimeout(() => report(videoWidth, videoHeight), 4_000)
    element.currentTime = 1e101
  }
  return (
    <main className="annotate empty">
      <p className="muted">Reading the size of the media…</p>
      {error && <p role="alert">{error.message}</p>}
      {video ? (
        <video src={src} preload="metadata" muted hidden onLoadedMetadata={(e) => measureVideo(e.currentTarget)} />
      ) : (
        <img src={src} alt="" hidden onLoad={(e) => report(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} />
      )}
    </main>
  )
}

/** Whether this page can open a video: browsers such as VS Code's cannot open WebM, whatever canPlayType says. */
function usePlayable(src: string | undefined): 'checking' | 'yes' | 'no' {
  const [result, setResult] = useState<{ src: string; ok: boolean }>()
  useEffect(() => {
    if (!src) return
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'metadata'
    const settle = (ok: boolean) => setResult({ src, ok })
    video.addEventListener('loadedmetadata', () => settle(true), { once: true })
    video.addEventListener('error', () => settle(false), { once: true })
    video.src = src
    return () => {
      video.removeAttribute('src')
      video.load()
    }
  }, [src])
  if (!src) return 'yes'
  return result?.src === src ? (result.ok ? 'yes' : 'no') : 'checking'
}

export default function App() {
  const { state } = useCanvas()
  const [reload, { pending }] = useAction('reload')
  const [makePreview, previewState] = useAction('preview')
  const isVideo = !!state.document && mediaKind(state.document.source.path) === 'video'
  const fileUrl = (id: string | undefined) => (id ? getCanvasClient().fileUrl(id) : undefined)
  const playable = usePlayable(isVideo && state.media && !state.media.preview ? fileUrl(state.media.source) : undefined)
  const asked = useRef(false)
  useEffect(() => {
    if (playable !== 'no' || asked.current) return
    asked.current = true
    void makePreview()
  }, [playable, makePreview])

  if (isVideo && state.media && !state.media.preview && playable !== 'yes') {
    return (
      <main className="annotate empty">
        {previewState.error ? (
          <p role="alert">This window cannot play the recording, and converting it failed: {previewState.error.message}</p>
        ) : (
          <p className="muted">{playable === 'checking' ? 'Opening the recording…' : 'Converting the recording to MP4 so this window can play it…'}</p>
        )}
      </main>
    )
  }
  if (!state.document || !state.media) {
    return (
      <main className="annotate empty">
        <p role="alert">{state.error ?? 'The document could not be read.'}</p>
        <button type="button" disabled={pending} onClick={() => void reload()}>
          Reload
        </button>
      </main>
    )
  }
  const { source } = state.document
  const media = { src: fileUrl(state.media.preview ?? state.media.source) as string, before: fileUrl(state.media.before) }
  // A video whose length cannot be read still opens: its timeline then ends after the last mark, caption, or shot.
  if (!source.width || !source.height) return <MediaProbe src={media.src} video={isVideo} />
  return <Editor state={state} document={state.document} media={media} />
}

function Editor({ state, document: doc, media }: { state: AnnotateState; document: AnnotateDocument; media: { src: string; before: string | undefined } }) {
  const [time, setTime] = useState(0)
  const [editing, setEditing] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [update, updateState] = useAction('update_annotation')
  const [add, addState] = useAction('add_annotations')
  const [remove] = useAction('remove_annotations')
  const [reload] = useAction('reload')
  const duration = documentDuration(doc)

  const lastSeek = useRef(state.seek.n)
  useEffect(() => {
    if (state.seek.n === lastSeek.current) return
    lastSeek.current = state.seek.n
    setTime(state.seek.time)
  }, [state.seek])

  const shown = useMemo<AnnotateDocument>(() => {
    if (!draft) return doc
    return { ...doc, annotations: doc.annotations.map((a, i) => (i === draft.index ? ({ ...a, [draft.field]: draft.value } as Annotation) : a)) }
  }, [doc, draft])

  const commit = async (index: number, changes: Record<string, unknown>) => {
    await update({ target: index, changes })
    setDraft(null)
  }

  const addAnnotation = async (annotation: Annotation) => {
    const result = await add({ annotations: [annotation] })
    if (result) {
      setSelected(doc.annotations.length)
      setEditing(true)
    }
  }

  const { width = 1, height = 1 } = doc.source
  const center: Point = [width / 2, height / 2]
  const size = Math.round(Math.min(width, height) / 5)
  const box: Box = [Math.round(center[0] - size), Math.round(center[1] - size / 2), size * 2, size]
  const at = (time > 0 && duration > 0 ? { time: [Number(time.toFixed(2)), Number(Math.min(duration, time + 3).toFixed(2))] as [number, number] } : {})
  const selectedAnnotation = selected !== null ? doc.annotations[selected] : undefined

  return (
    <main className="annotate">
      <header className="bar">
        <h1 title={state.path}>{fileName(state.path)}</h1>
        <span className="muted">
          {width}×{height}
          {duration > 0 ? ` · ${fmt(duration)}` : ' · still'}
        </span>
        <span className="spacer" />
        <label className="toggle">
          <input type="checkbox" checked={editing} onChange={(e) => setEditing(e.currentTarget.checked)} /> Edit
        </label>
        <button type="button" onClick={() => void reload()}>
          Reload
        </button>
      </header>

      <AnnotatePlayer
        document={shown}
        src={media.src}
        beforeSrc={media.before}
        time={time}
        onTimeChange={setTime}
        camera={!editing}
        overlay={editing ? (view) => <Handles view={view} document={shown} time={time} selected={selected} onSelect={setSelected} onDraft={setDraft} onCommit={commit} /> : undefined}
      />
      {updateState.error && <p role="alert">{updateState.error.message}</p>}

      <section aria-label="Annotations">
        <div className="bar">
          <h2>Annotations</h2>
          <span className="spacer" />
          <span className="adders">
            <button type="button" disabled={addState.pending} onClick={() => void addAnnotation({ type: 'rect', box, label: 'Note', tone: 'note', ...at })}>
              + Box
            </button>
            <button type="button" disabled={addState.pending} onClick={() => void addAnnotation({ type: 'arrow', from: [box[0] - size, box[1] - size / 2], to: [box[0], box[1]], tone: 'note', ...at })}>
              + Arrow
            </button>
            <button type="button" disabled={addState.pending} onClick={() => void addAnnotation({ type: 'callout', at: center, text: 'Note', ...at })}>
              + Callout
            </button>
            <button type="button" disabled={addState.pending} onClick={() => void addAnnotation({ type: 'spotlight', box, ...at })}>
              + Spotlight
            </button>
            <button type="button" disabled={addState.pending} onClick={() => void addAnnotation({ type: 'redact', box })}>
              + Redact
            </button>
          </span>
        </div>
        {addState.error && <p role="alert">{addState.error.message}</p>}
        {doc.annotations.length === 0 ? (
          <p className="muted">No annotations yet. Add one, or ask the agent.</p>
        ) : (
          <ul className="list">
            {doc.annotations.map((a, index) => (
              <li key={a.id ?? index} className={index === selected ? 'selected' : undefined}>
                <button
                  type="button"
                  className="row"
                  aria-pressed={index === selected}
                  onClick={() => {
                    setSelected(index === selected ? null : index)
                    if (a.time && (time < a.time[0] || time > a.time[1])) setTime(a.time[0])
                  }}
                >
                  <span className="kind">{a.type}</span>
                  <span className="text">{describe(a)}</span>
                  <span className="muted time">{a.time ? `${fmt(a.time[0])}–${fmt(a.time[1])}` : 'always'}</span>
                </button>
                {index === selected && selectedAnnotation && (
                  <Inspector key={JSON.stringify(selectedAnnotation)} annotation={selectedAnnotation} onChange={(changes) => void commit(index, changes)} onDelete={() => void remove({ targets: [index] }).then(() => setSelected(null))} />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Narration document={doc} duration={duration} time={time} onSeek={setTime} />
      {state.issues.length > 0 && (
        <section aria-label="Problems">
          <h2>Problems</h2>
          <ul className="issues">
            {state.issues.map((issue) => (
              <li key={`${issue.path}:${issue.message}`} className={issue.level}>
                <span className="mono">{issue.path}</span> {issue.message}
              </li>
            ))}
          </ul>
        </section>
      )}
      <Export state={state} time={time} duration={duration} />
      <Feedback selected={selected} selectedLabel={selectedAnnotation ? `${selectedAnnotation.type} ${describe(selectedAnnotation)}`.trim() : undefined} />
    </main>
  )
}

/** Drag handles for the annotations visible now (and the selected one), drawn over the whole frame. */
function Handles(props: {
  view: PlayerView
  document: AnnotateDocument
  time: number
  selected: number | null
  onSelect(index: number): void
  onDraft(draft: Draft | null): void
  onCommit(index: number, changes: Record<string, unknown>): Promise<void>
}) {
  const { view, document: doc, time, selected } = props
  const drag = useRef<{ index: number; field: string; start: Point; original: Geometry; mode: 'move' | 'resize'; value: Geometry } | null>(null)
  const scale = view.frame.scale

  const begin = (event: ReactPointerEvent, index: number, field: string, original: Geometry, mode: 'move' | 'resize') => {
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    props.onSelect(index)
    drag.current = { index, field, start: [event.clientX, event.clientY], original, mode, value: original }
  }
  const move = (event: ReactPointerEvent) => {
    const current = drag.current
    if (!current) return
    const dx = (event.clientX - current.start[0]) / scale
    const dy = (event.clientY - current.start[1]) / scale
    const o = current.original
    const value: Geometry =
      o.length === 4
        ? current.mode === 'move'
          ? [o[0] + dx, o[1] + dy, o[2], o[3]]
          : [o[0], o[1], Math.max(4, o[2] + dx), Math.max(4, o[3] + dy)]
        : [o[0] + dx, o[1] + dy]
    current.value = value
    props.onDraft({ index: current.index, field: current.field, value })
  }
  const end = () => {
    const current = drag.current
    drag.current = null
    if (!current || current.value === current.original) return
    void props.onCommit(current.index, { [current.field]: round(current.value) })
  }

  const handles: ReactNode[] = []
  doc.annotations.forEach((a, index) => {
    const visible = !a.time || (time >= a.time[0] && time <= a.time[1])
    if (!visible && index !== selected) return
    const record = a as Record<string, unknown>
    const name = `${a.type} ${describe(a)}`.trim()
    for (const field of BOX_FIELDS) {
      const value = record[field]
      if (!Array.isArray(value) || value.length !== 4) continue
      const [x, y] = view.toView([value[0], value[1]])
      const style = { left: x, top: y, width: value[2] * scale, height: value[3] * scale }
      handles.push(
        <div
          key={`${index}-${field}`}
          role="button"
          tabIndex={0}
          aria-label={`Move ${name}${field === 'into' ? ' lens' : ''}`}
          className={`handle box${index === selected ? ' selected' : ''}`}
          style={style}
          onPointerDown={(e) => begin(e, index, field, value as Box, 'move')}
          onPointerMove={move}
          onPointerUp={end}
          onKeyDown={(e) => e.key === 'Enter' && props.onSelect(index)}
        >
          <span
            className="resize"
            aria-label={`Resize ${name}`}
            onPointerDown={(e) => begin(e, index, field, value as Box, 'resize')}
            onPointerMove={move}
            onPointerUp={end}
          />
        </div>,
      )
    }
    for (const field of POINT_FIELDS) {
      const value = record[field]
      if (!Array.isArray(value) || value.length !== 2) continue
      const [x, y] = view.toView(value as Point)
      handles.push(
        <div
          key={`${index}-${field}`}
          role="button"
          tabIndex={0}
          aria-label={`Move ${name} ${field}`}
          className={`handle point${index === selected ? ' selected' : ''}`}
          style={{ left: x, top: y }}
          onPointerDown={(e) => begin(e, index, field, value as Point, 'move')}
          onPointerMove={move}
          onPointerUp={end}
        />,
      )
    }
  })
  return <div className="handles">{handles}</div>
}

function Inspector({ annotation: a, onChange, onDelete }: { annotation: Annotation; onChange(changes: Record<string, unknown>): void; onDelete(): void }) {
  const record = a as Record<string, unknown>
  const textField = a.type === 'callout' ? 'text' : LABEL_TYPES.has(a.type) ? 'label' : undefined
  const [text, setText] = useState(textField ? String(record[textField] ?? '') : '')
  const [note, setNote] = useState(String(record.note ?? ''))
  const [start, setStart] = useState(a.time ? String(a.time[0]) : '')
  const [end, setEnd] = useState(a.time ? String(a.time[1]) : '')
  const saveText = () => {
    if (!textField || text === String(record[textField] ?? '')) return
    onChange({ [textField]: text.trim() ? text : textField === 'text' ? 'Note' : null })
  }
  const saveNote = () => {
    if (note !== String(record.note ?? '')) onChange({ note: note.trim() ? note : null })
  }
  const saveTime = () => {
    if (start === '' && end === '') return a.time && onChange({ time: null })
    const time = [Number(start), Number(end)]
    if (time.every(Number.isFinite) && (time[0] !== a.time?.[0] || time[1] !== a.time?.[1])) onChange({ time })
  }
  return (
    <div className="inspector">
      {textField && (
        <label>
          {textField === 'text' ? 'Text' : 'Label'}
          <input value={text} onChange={(e) => setText(e.currentTarget.value)} onBlur={saveText} onKeyDown={(e) => e.key === 'Enter' && saveText()} />
        </label>
      )}
      {NOTE_TYPES.has(a.type) && (
        <label className="note">
          Note
          <textarea rows={2} placeholder="Longer text for the notes panel" value={note} onChange={(e) => setNote(e.currentTarget.value)} onBlur={saveNote} />
        </label>
      )}
      {a.type !== 'redact' && (
        <label>
          Tone
          <select value={a.tone ?? ''} onChange={(e) => onChange({ tone: (e.currentTarget.value as Tone) || null })}>
            <option value="">default</option>
            {TONES.map((tone) => (
              <option key={tone} value={tone}>
                {tone}
              </option>
            ))}
          </select>
        </label>
      )}
      {a.type === 'redact' ? (
        <label>
          Style
          <select value={a.style ?? 'fill'} onChange={(e) => onChange({ style: e.currentTarget.value })}>
            <option value="fill">fill</option>
            <option value="pixelate">pixelate</option>
          </select>
        </label>
      ) : (
        <span className="times">
          <label>
            From
            <input inputMode="decimal" placeholder="start" value={start} onChange={(e) => setStart(e.currentTarget.value)} onBlur={saveTime} />
          </label>
          <label>
            To
            <input inputMode="decimal" placeholder="end" value={end} onChange={(e) => setEnd(e.currentTarget.value)} onBlur={saveTime} />
          </label>
        </span>
      )}
      {(a.type === 'rect' || a.type === 'ellipse') && (
        <label className="toggle">
          <input type="checkbox" checked={a.step !== undefined} onChange={(e) => onChange({ step: e.currentTarget.checked ? true : null })} /> Step number
        </label>
      )}
      <button type="button" className="danger" onClick={onDelete}>
        Delete
      </button>
    </div>
  )
}

function Narration({ document: doc, duration, time, onSeek }: { document: AnnotateDocument; duration: number; time: number; onSeek(time: number): void }) {
  const [setNarration, { error, pending }] = useAction('set_narration')
  const cues = doc.narration ?? []
  const timed = timeCues(cues, duration)
  const save = (next: Cue[]) => void setNarration({ narration: [...next].sort((a, b) => a.t - b.t) })
  return (
    <section aria-label="Captions">
      <div className="bar">
        <h2>Captions</h2>
        <span className="spacer" />
        <button type="button" disabled={pending} onClick={() => save([...cues, { t: Number(time.toFixed(2)), text: 'New caption' }])}>
          + Caption at {fmt(time)}
        </button>
      </div>
      {error && <p role="alert">{error.message}</p>}
      {cues.length === 0 ? (
        <p className="muted">No captions. Videos without sound rely on them.</p>
      ) : (
        <ul className="list">
          {cues.map((cue, index) => {
            const info = timed.find((t) => t.start === cue.t && t.text === cue.text)
            return (
              <li key={`${cue.t}-${index}`} className="cue">
                <button type="button" className="link time" onClick={() => onSeek(cue.t)}>
                  {fmt(cue.t)}
                </button>
                <input
                  aria-label={`Caption at ${fmt(cue.t)}`}
                  defaultValue={cue.text}
                  onBlur={(e) => {
                    const text = e.currentTarget.value.trim()
                    if (text && text !== cue.text) save(cues.map((c, i) => (i === index ? { ...c, text } : c)))
                  }}
                />
                <button type="button" aria-label={`Delete caption at ${fmt(cue.t)}`} onClick={() => save(cues.filter((_, i) => i !== index))}>
                  ×
                </button>
                {info?.tooFast && (
                  <span className="warn">
                    Needs {info.needs.toFixed(1)}s to read, shown for {(info.end - info.start).toFixed(1)}s
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function Export({ state, time, duration }: { state: AnnotateState; time: number; duration: number }) {
  const [run, { pending, error }] = useAction('export')
  const formats = FORMATS.filter((format) => duration > 0 || !VIDEO_FORMATS.has(format))
  const exporting = state.exporting
  const percent = exporting && exporting.frames > 0 ? Math.round((exporting.frame / exporting.frames) * 100) : undefined
  return (
    <section aria-label="Export">
      <div className="bar">
        <h2>Export</h2>
        <span className="spacer" />
        {formats.map((format: Format) => (
          <button
            key={format}
            type="button"
            disabled={pending}
            title={VIDEO_FORMATS.has(format) ? `Render the whole video as ${format}` : `Render the frame at ${fmt(time)} as ${format}`}
            onClick={() => void run({ format, ...(!VIDEO_FORMATS.has(format) && duration > 0 && { at: Number(time.toFixed(2)) }) })}
          >
            {format.toUpperCase()}
          </button>
        ))}
      </div>
      {exporting && (
        <p role="status">
          Exporting {exporting.format.toUpperCase()}…{percent !== undefined ? ` ${percent}%` : ''}
        </p>
      )}
      {(state.exportError ?? error?.message) && <p role="alert">{state.exportError ?? error?.message}</p>}
      {state.exports.length > 0 && (
        <ul className="exports">
          {state.exports.map((entry) => (
            <li key={entry.path} className="mono" title={entry.path}>
              {entry.path}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function Feedback({ selected, selectedLabel }: { selected: number | null; selectedLabel: string | undefined }) {
  const [send, { pending, error }] = useAction('send_feedback')
  const [text, setText] = useState('')
  const [sent, setSent] = useState(false)
  return (
    <section aria-label="Ask the agent">
      <h2>Ask the agent</h2>
      <textarea
        aria-label="Feedback for the agent"
        placeholder={selectedLabel ? `About the selected ${selectedLabel}…` : 'What should change?'}
        value={text}
        onChange={(e) => {
          setText(e.currentTarget.value)
          setSent(false)
        }}
      />
      <div className="bar">
        <button
          type="button"
          disabled={pending || !text.trim()}
          onClick={async () => {
            // Resolves to null when sent and undefined when it failed (the error shows below).
            const result = await send({ text, ...(selected !== null && { target: selected }) })
            if (result !== undefined) {
              setText('')
              setSent(true)
            }
          }}
        >
          Send to agent
        </button>
        {sent && <span className="muted">Sent.</span>}
        {error && <span role="alert">{error.message}</span>}
      </div>
    </section>
  )
}
