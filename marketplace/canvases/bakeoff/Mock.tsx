import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Pins, type Pin } from './Pins.tsx'
import type { Anchor } from './schema.ts'
import { MAX_ON, MAX_QUOTE } from './shared.ts'

interface MockProps {
  name: string
  content: string
  scheme: 'light' | 'dark'
  pins: readonly Pin[]
  /** A click on the mock: where, as fractions of the page, and what it landed on. */
  onPin?: ((x: number, y: number, on: { on: string; anchor?: Anchor }) => void) | undefined
  onUnpin?: ((n: number) => void) | undefined
  /** The text selected in the mock, or an empty string. */
  onSelect?: ((text: string) => void) | undefined
}

/** What changes by itself when clicked, without a script: a click there is not a pin. */
const ACTS = 'summary, input, select, textarea, option, label, video, audio'
/** Keys that scroll a page, and how far: a number of pixels, or a part of what is on screen. */
const SCROLLS: Record<string, { by?: number; pages?: number }> = { ArrowDown: { by: 40 }, ArrowUp: { by: -40 }, PageDown: { pages: 0.9 }, PageUp: { pages: -0.9 }, ' ': { pages: 0.9 }, End: { pages: Infinity }, Home: { pages: -Infinity } }
/** Longer than a double click, which selects a word rather than pinning a spot. */
const PIN_DELAY = 250

const fraction = (value: number) => Math.min(Math.max(value, 0), 1)
const oneLine = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim()

/** What a click landed on, for the agent to find in the mock's source: its tag and the start of its text. */
function describe(target: Element): string {
  const doc = target.ownerDocument
  if (target === doc.documentElement || target === doc.body) return ''
  const text = oneLine(target.textContent) || oneLine(target.getAttribute('alt')) || oneLine(target.getAttribute('aria-label'))
  return `<${target.localName}>${text ? ` ${text}` : ''}`.slice(0, MAX_ON)
}

/** The way from the mock's body to an element: which child, at each step. The mock's HTML never changes, so it leads to the same element at any size. */
function pathTo(target: Element): number[] | undefined {
  const path: number[] = []
  for (let element = target; element !== target.ownerDocument.body; ) {
    const parent = element.parentElement
    if (!parent) return undefined
    path.unshift(Array.prototype.indexOf.call(parent.children, element))
    element = parent
  }
  return path
}

/**
 * An HTML mock in a frame that runs nothing: no scripts, forms, or navigation, and the page's own
 * policy blocks the network, so the mock can only draw. The page can see into the frame
 * (allow-same-origin), to pin a click, quote a selection, and give the mock the height it needs.
 * Never add allow-scripts: together they would let a mock act as this page.
 */
export function Mock({ name, content, scheme, pins, onPin, onUnpin, onSelect }: MockProps) {
  const box = useRef<HTMLDivElement>(null)
  const page = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  // The listeners on the mock's document stay for as long as it does: they call what the props are now.
  const latest = useRef({ onPin, onSelect, pins })
  const unwire = useRef<() => void>(undefined)
  const pinnable = Boolean(onPin)
  // Where the pins are in the mock as it is laid out now: on the elements they were put on.
  const [placed, setPlaced] = useState(pins)
  const place = (pins: readonly Pin[]) => {
    const doc = frame.current?.contentDocument
    const scroller = doc?.scrollingElement ?? doc?.documentElement
    const next = pins.map((pin) => {
      const element = pin.anchor?.path.reduce<Element | null | undefined>((parent, index) => parent?.children[index], doc?.body)
      const box = element?.getBoundingClientRect()
      // Gone from view, as inside a closed <details>: where it was on the page when it was pinned.
      if (!pin.anchor || !scroller || !box || (!box.width && !box.height)) return pin
      return { ...pin, x: fraction((box.left + scroller.scrollLeft + pin.anchor.x * box.width) / scroller.scrollWidth), y: fraction((box.top + scroller.scrollTop + pin.anchor.y * box.height) / scroller.scrollHeight) }
    })
    setPlaced((before) => (JSON.stringify(before) === JSON.stringify(next) ? before : next))
  }
  useEffect(() => {
    latest.current = { onPin, onSelect, pins }
  })
  useLayoutEffect(() => place(pins), [pins])
  useEffect(() => {
    const root = frame.current?.contentDocument?.documentElement
    root?.style.setProperty('cursor', pinnable ? 'crosshair' : '')
  }, [pinnable])
  useEffect(() => () => unwire.current?.(), [])

  /** The frame loaded the mock, at first or after its backdrop changed. */
  const wire = () => {
    unwire.current?.()
    const doc = frame.current?.contentDocument
    const root = doc?.documentElement
    if (!doc || !root) return
    const scroller = () => doc.scrollingElement ?? root
    root.style.setProperty('cursor', latest.current.onPin ? 'crosshair' : '')

    // The mock at the size of its box first, to see how much more room it needs: the box then scrolls, not the mock.
    const fit = () => {
      const sheet = page.current
      const outer = box.current
      if (!sheet || !outer) return
      const { scrollTop, scrollLeft } = outer
      sheet.style.width = ''
      sheet.style.height = `${outer.clientHeight}px`
      const { scrollWidth, scrollHeight, clientWidth } = scroller()
      sheet.style.height = `${Math.max(scrollHeight, outer.clientHeight)}px`
      sheet.style.width = scrollWidth > clientWidth ? `${scrollWidth}px` : ''
      // Measuring made the box short for a moment: it is where the user scrolled it to again.
      outer.scrollTop = scrollTop
      outer.scrollLeft = scrollLeft
      place(latest.current.pins)
    }
    const sizes = new ResizeObserver(fit)
    if (box.current) sizes.observe(box.current)
    sizes.observe(root)
    if (doc.body) sizes.observe(doc.body)
    fit()

    let timer: ReturnType<typeof setTimeout> | undefined
    let deselects = false
    const onDown = () => {
      deselects = !(doc.getSelection()?.isCollapsed ?? true)
    }
    const onClick = (event: MouseEvent) => {
      // An element of the mock's document, which is not an instance of this page's Element.
      const target = event.target as Element | null
      if (!target?.closest) return
      // A link would replace the mock with a page this canvas may not load.
      if (target.closest('a[href], area[href]')) event.preventDefault()
      clearTimeout(timer)
      // A click that ends a drag selected text, and one that follows a selection only clears it.
      const selects = deselects || !(doc.getSelection()?.isCollapsed ?? true)
      if (!latest.current.onPin || event.detail !== 1 || selects || target.closest(ACTS)) return
      const { scrollWidth, scrollHeight } = scroller()
      const box = target.getBoundingClientRect()
      const path = pathTo(target)
      const anchor = path && box.width && box.height ? { path, x: fraction((event.clientX - box.left) / box.width), y: fraction((event.clientY - box.top) / box.height) } : undefined
      const spot = [fraction(event.pageX / scrollWidth), fraction(event.pageY / scrollHeight), { on: describe(target), ...(anchor ? { anchor } : {}) }] as const
      // A second click makes it a double click, which selects a word instead.
      timer = setTimeout(() => latest.current.onPin?.(...spot), PIN_DELAY)
    }
    // Something in the mock scrolled by itself, and its pins with it.
    const onScroll = () => place(latest.current.pins)
    const onSelection = () => latest.current.onSelect?.(oneLine(doc.getSelection()?.toString()).slice(0, MAX_QUOTE))
    // Keys typed in the mock reach this page, which picks, switches, and closes with them. The rest scroll the box, as they would the mock.
    const onKey = (event: KeyboardEvent) => {
      // A field in the mock takes what is typed in it.
      if (event.key === 'Tab' || (event.target as Element | null)?.closest?.('input, textarea, select, [contenteditable]')) return
      const { key, code, altKey, ctrlKey, metaKey, shiftKey } = event
      if (!frame.current?.dispatchEvent(new KeyboardEvent('keydown', { key, code, altKey, ctrlKey, metaKey, shiftKey, bubbles: true, cancelable: true }))) return event.preventDefault()
      const scroll = SCROLLS[key]
      const outer = box.current
      if (!scroll || !outer || altKey || ctrlKey || metaKey) return
      const from = outer.scrollTop
      const sign = key === ' ' && shiftKey ? -1 : 1
      outer.scrollBy({ top: sign * (scroll.by ?? Math.max(Math.min((scroll.pages ?? 0) * outer.clientHeight, outer.scrollHeight), -outer.scrollHeight)), behavior: 'instant' })
      // When the box has nowhere to go, the key is left to what scrolls inside the mock.
      if (outer.scrollTop !== from) event.preventDefault()
    }
    doc.addEventListener('mousedown', onDown, true)
    doc.addEventListener('click', onClick, true)
    doc.addEventListener('selectionchange', onSelection)
    doc.addEventListener('keydown', onKey)
    doc.addEventListener('scroll', onScroll, true)
    unwire.current = () => {
      clearTimeout(timer)
      sizes.disconnect()
      doc.removeEventListener('mousedown', onDown, true)
      doc.removeEventListener('click', onClick, true)
      doc.removeEventListener('selectionchange', onSelection)
      doc.removeEventListener('keydown', onKey)
      doc.removeEventListener('scroll', onScroll, true)
      unwire.current = undefined
    }
  }

  return (
    <div ref={box} className={`preview frame bd-${scheme}`}>
      <div ref={page} className="frame-page">
        <iframe ref={frame} sandbox="allow-same-origin" title={name} srcDoc={`${content}<style>:root{color-scheme:${scheme}}</style>`} style={{ colorScheme: scheme }} onLoad={wire} />
        <Pins pins={placed} onUnpin={onUnpin} />
      </div>
    </div>
  )
}
