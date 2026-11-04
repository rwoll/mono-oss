import { SandboxError } from '../backend.ts'

/** What redacted values are replaced with. */
export const REDACTED = '***'
/** Shorter values are too likely to match ordinary text, so they aren't redacted. */
const MIN_LENGTH = 4

/** The forms a value takes in output: as is, without spaces, escaped in JSON, URL-encoded, and a code in two groups. */
function variants(value: string): string[] {
  const forms = [value, value.replace(/\s/g, ''), JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]
  if (/^\d{6,8}$/.test(value)) {
    const half = Math.floor(value.length / 2)
    forms.push(`${value.slice(0, half)} ${value.slice(half)}`, `${value.slice(0, half)}-${value.slice(half)}`)
  }
  return forms.filter((form) => form.length >= MIN_LENGTH)
}

/**
 * Removes known secret values, such as passwords and the 2FA codes made from a key, from text, JSON, and
 * errors before they reach logs, progress, results, or a terminal. Resolvers add every value they know
 * is secret; the engine and clients pass step output through it.
 */
export class Redactor {
  readonly #values = new Set<string>()
  #forms: string[] = []

  /** Adds secret values. Values shorter than 4 characters are ignored. */
  add(...values: (string | null | undefined)[]): this {
    let changed = false
    for (const value of values) {
      if (typeof value !== 'string' || value.length < MIN_LENGTH || this.#values.has(value)) continue
      this.#values.add(value)
      changed = true
    }
    // Longest first, so a value that contains another is replaced whole.
    if (changed) this.#forms = [...new Set([...this.#values].flatMap(variants))].sort((a, b) => b.length - a.length)
    return this
  }

  /** How many values it redacts. */
  get size(): number {
    return this.#values.size
  }

  text(input: string): string {
    let out = input
    for (const form of this.#forms) if (out.includes(form)) out = out.split(form).join(REDACTED)
    return out
  }

  /** A copy of `value` with every string, keys included, redacted. */
  json<T>(value: T): T {
    if (!this.#forms.length) return value
    const walk = (item: unknown): unknown => {
      if (typeof item === 'string') return this.text(item)
      if (Array.isArray(item)) return item.map(walk)
      if (item && typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) {
        return Object.fromEntries(Object.entries(item).map(([key, field]) => [this.text(key), walk(field)]))
      }
      return item
    }
    return walk(value) as T
  }

  /** The error with its message redacted. A `SandboxError` keeps its code; other errors become plain ones. */
  error(error: unknown): Error {
    const message = this.text(String((error as Error)?.message ?? error))
    if (error instanceof SandboxError) return message === error.message ? error : new SandboxError(error.code, message)
    if (error instanceof Error && message === error.message && !(error.stack && this.text(error.stack) !== error.stack)) return error
    return new Error(message)
  }
}

/** Output held back while it has no line break, and how much of it a long line keeps back. */
const HOLD_CHARS = 4096
const HOLD_TAIL = 1024

/**
 * Redacts text that arrives in chunks, such as a command's output. Each chunk is redacted together with
 * what was held back from the last one, and sent up to its last line break, so a value split across
 * chunks is never sent in part. A line longer than 4 KiB is sent as it comes, keeping its last 1 KiB.
 */
export class RedactedStream {
  readonly #redact: (text: string) => string
  #pending = ''

  constructor(redact: (text: string) => string) {
    this.#redact = redact
  }

  /** Takes a chunk, and returns what may be sent now. */
  push(text: string): string {
    const redacted = this.#redact(this.#pending + text)
    let cut = redacted.lastIndexOf('\n') + 1
    if (redacted.length - cut > HOLD_CHARS) cut = redacted.length - HOLD_TAIL
    this.#pending = redacted.slice(cut)
    return redacted.slice(0, cut)
  }

  /** Returns the rest, once no more chunks come. */
  flush(): string {
    const rest = this.#redact(this.#pending)
    this.#pending = ''
    return rest
  }
}
