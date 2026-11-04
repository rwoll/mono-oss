import { createCanvasHooks } from '@rwoll/canvas-kit/react'
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ChatIcon } from '../../ui'
import type canvas from './canvas.ts'
import { MAX_PASSAGE, MAX_QUESTION } from './canvas.ts'

const { useAction } = createCanvasHooks<typeof canvas>()

const GAP_X = 10
const GAP_Y = 4
const MARGIN = 8
/** Selection events can lag the pointer's release; stay with the pointer this long after it. */
const POINTER_SETTLE_MS = 200

interface Rect {
  left: number
  right: number
  top: number
  bottom: number
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high))
const count = (n: number) => n.toLocaleString('en-US')

/** Where a keyboard selection ends. */
function selectionRect(): Rect | undefined {
  const selection = document.getSelection()
  const rects = selection?.rangeCount ? selection.getRangeAt(0).getClientRects() : []
  const last = rects[rects.length - 1]
  return last && (last.width || last.height) ? last : undefined
}

/**
 * Select text in the canvas, then click **Ask agent** (or press Alt+Enter) to ask
 * the agent about it in chat. The button follows the pointer while it selects, and
 * sits beside the end of a keyboard selection. Selecting alone sends nothing.
 */
export function AskAgent({ root }: { root: React.RefObject<HTMLElement | null> }) {
  const [ask, asking] = useAction('ask_about_selection')
  /** The passage, captured when it was selected so live updates cannot change it. */
  const [passage, setPassage] = useState<string>()
  const [anchor, setAnchor] = useState<Rect>()
  const [active, setActive] = useState<string>()
  const [question, setQuestion] = useState('')
  const [invalid, setInvalid] = useState('')
  const [sent, setSent] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const pointer = useRef({ x: 0, y: 0, down: false, selecting: false, upAt: -Infinity })
  const [position, setPosition] = useState<{ left: number; top: number }>()

  useEffect(() => {
    const pointerRect = (): Rect => {
      const { x, y } = pointer.current
      return { left: x - 2, right: x + 2, top: y - 8, bottom: y + 8 }
    }
    const capture = () => {
      if (dialog.current?.open) return
      const selection = document.getSelection()
      if (!selection?.rangeCount || selection.isCollapsed) return
      const range = selection.getRangeAt(0)
      if (!root.current?.contains(range.commonAncestorContainer)) return
      const text = selection.toString()
      if (!text.trim()) return
      const { down, upAt } = pointer.current
      const atPointer = down || performance.now() - upAt < POINTER_SETTLE_MS
      setPassage((previous) => {
        setAnchor((current) => (atPointer ? pointerRect() : previous !== text || !current ? (selectionRect() ?? pointerRect()) : current))
        return text
      })
    }
    const clear = () => {
      if (dialog.current?.open) return
      setPassage(undefined)
    }
    const onSelection = () => {
      if (pointer.current.down) pointer.current.selecting = true
      capture()
    }
    const onDown = (event: PointerEvent) => {
      if (button.current?.contains(event.target as Node)) return
      clear()
      if (event.button !== 0 || !event.isPrimary) return
      pointer.current = { ...pointer.current, down: true, selecting: false, x: event.clientX, y: event.clientY }
    }
    const onMove = (event: PointerEvent) => {
      if (!pointer.current.down) return
      pointer.current.x = event.clientX
      pointer.current.y = event.clientY
      if (pointer.current.selecting) capture()
    }
    const onUp = (event: PointerEvent) => {
      if (!pointer.current.down) return
      pointer.current = { ...pointer.current, down: false, x: event.clientX, y: event.clientY, upAt: performance.now() }
      if (pointer.current.selecting) capture()
      pointer.current.selecting = false
    }
    const onKeyCapture = () => {
      pointer.current.upAt = -Infinity
    }
    const onKey = (event: KeyboardEvent) => {
      if (dialog.current?.open) return
      if (event.altKey && !event.ctrlKey && !event.metaKey && event.key === 'Enter') {
        capture()
        const text = document.getSelection()?.toString()
        if (text?.trim() && root.current?.contains(document.getSelection()!.getRangeAt(0).commonAncestorContainer)) {
          event.preventDefault()
          openQuestion(text)
        }
      } else if (event.key === 'Escape') {
        clear()
      }
    }
    document.addEventListener('selectionchange', onSelection)
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp, true)
    document.addEventListener('keydown', onKeyCapture, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('selectionchange', onSelection)
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp, true)
      document.removeEventListener('keydown', onKeyCapture, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [root])

  // Below and to the right of the anchor, flipping to the other side when there is no room.
  useEffect(() => {
    const node = button.current
    if (!node || !anchor || !passage) return
    const place = () => {
      const width = node.offsetWidth
      const height = node.offsetHeight
      const viewWidth = document.documentElement.clientWidth
      const viewHeight = document.documentElement.clientHeight
      let left = anchor.right + GAP_X
      let top = anchor.bottom + GAP_Y
      if (left + width > viewWidth - MARGIN) left = anchor.left - GAP_X - width
      if (top + height > viewHeight - MARGIN) top = anchor.top - GAP_Y - height
      setPosition({ left: Math.round(clamp(left, MARGIN, viewWidth - width - MARGIN)), top: Math.round(clamp(top, MARGIN, viewHeight - height - MARGIN)) })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor, passage])

  function openQuestion(text = passage) {
    if (!text || dialog.current?.open) return
    setActive(text)
    setQuestion('')
    setInvalid('')
    setSent(false)
    dialog.current?.showModal()
  }

  // The form renders once the dialog has a passage; then the question takes focus.
  useEffect(() => {
    if (active !== undefined) input.current?.focus()
  }, [active])

  const tooLong = !!active && active.length > MAX_PASSAGE
  const send = async (event?: FormEvent) => {
    event?.preventDefault()
    if (!active || asking.pending || sent) return
    const text = question.trim()
    if (!text || text.length > MAX_QUESTION) {
      setInvalid(`Write a question of at most ${count(MAX_QUESTION)} characters.`)
      input.current?.focus()
      return
    }
    if (tooLong) return
    setInvalid('')
    const result = await ask({ passage: active, question: text })
    if (result?.sent) setSent(true)
  }
  const onQuestionKey = (event: ReactKeyboardEvent) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void send()
    }
  }

  return (
    <>
      {passage && (
        <button
          ref={button}
          type="button"
          hidden={active !== undefined}
          className="selection-ask"
          style={position}
          aria-haspopup="dialog"
          aria-controls="selection-dialog"
          aria-keyshortcuts="Alt+Enter"
          title="Ask about selected text (Alt+Enter)"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => openQuestion()}
        >
          <ChatIcon />
          Ask agent
        </button>
      )}
      <dialog
        ref={dialog}
        id="selection-dialog"
        className="dialog"
        aria-labelledby="selection-title"
        aria-describedby="selection-context"
        onClose={() => {
          setActive(undefined)
          requestAnimationFrame(() => button.current?.focus({ preventScroll: true }))
        }}
      >
        {active !== undefined && (
          <form className="dialog-form" noValidate onSubmit={send}>
            <h2 id="selection-title">Ask about selected text</h2>
            <p id="selection-context" className="muted">
              Summary selection. Your question and this passage will be sent to this chat.
            </p>
            <blockquote className="quote" tabIndex={0}>
              {active}
            </blockquote>
            {tooLong && (
              <p className="error" role="alert">
                This selection is {count(active.length)} characters. Select at most {count(MAX_PASSAGE)} characters and try again.
              </p>
            )}
            <label htmlFor="selection-question">Your question</label>
            <textarea
              ref={input}
              id="selection-question"
              rows={3}
              maxLength={MAX_QUESTION}
              placeholder="What would you like to know?"
              readOnly={asking.pending}
              aria-invalid={invalid ? true : undefined}
              value={question}
              onChange={(event) => {
                setQuestion(event.target.value)
                setSent(false)
                setInvalid('')
              }}
              onKeyDown={onQuestionKey}
            />
            {sent && (
              <p className="notice" role="status">
                Sent to this chat. The agent will answer here after its current turn.
              </p>
            )}
            {(invalid || asking.error) && (
              <p className="error" role="alert">
                {invalid || `${asking.error!.message} Your question is still here. If delivery is uncertain, check the chat before retrying.`}
              </p>
            )}
            <div className="button-row end">
              <button type="button" onClick={() => dialog.current?.close()}>
                {sent ? 'Close' : 'Cancel'}
              </button>
              <button type="submit" className="primary" aria-disabled={asking.pending || sent || tooLong || undefined}>
                {asking.pending ? 'Sending...' : 'Send to agent'}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </>
  )
}
