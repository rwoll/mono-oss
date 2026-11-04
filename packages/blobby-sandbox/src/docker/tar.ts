import { Readable } from 'node:stream'

// Just enough of the tar format to move one file in and out of a container through Docker's archive
// endpoints: ustar headers, with PAX records for long or non-ASCII names and for sizes over 8 GiB.

const BLOCK = 512
const END = Buffer.alloc(2 * BLOCK)
const MAX_OCTAL_SIZE = 0o77777777777

export interface TarEntry {
  /** Relative path inside the archive, with `/` separators. */
  name: string
  type: 'file' | 'directory'
  mode: number
  uid: number
  gid: number
  /** File size in bytes; 0 for folders. */
  size: number
  /** Seconds since the epoch. */
  mtime: number
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`
  // The length prefix counts itself, so grow it until it fits.
  let length = Buffer.byteLength(body) + 1
  while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body)
  return Buffer.from(`${length}${body}`, 'utf8')
}

function padding(size: number): number {
  return (BLOCK - (size % BLOCK)) % BLOCK
}

function rawHeader(name: string, type: string, size: number, entry: Pick<TarEntry, 'mode' | 'uid' | 'gid' | 'mtime'>): Buffer {
  const header = Buffer.alloc(BLOCK)
  header.write(name, 0, 100, 'utf8')
  header.write(octal(entry.mode & 0o7777, 8), 100, 'ascii')
  header.write(octal(entry.uid, 8), 108, 'ascii')
  header.write(octal(entry.gid, 8), 116, 'ascii')
  header.write(octal(size, 12), 124, 'ascii')
  header.write(octal(Math.floor(entry.mtime), 12), 136, 'ascii')
  header.write('        ', 148, 'ascii')
  header.write(type, 156, 'ascii')
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
  return header
}

/** The header blocks for one entry: a PAX header first when the name or size don't fit ustar. */
export function entryHeader(entry: TarEntry): Buffer {
  const name = entry.type === 'directory' && !entry.name.endsWith('/') ? `${entry.name}/` : entry.name
  const records: Buffer[] = []
  const ascii = /^[\x20-\x7e]*$/.test(name)
  if (!ascii || Buffer.byteLength(name) > 100) records.push(paxRecord('path', name))
  if (entry.size > MAX_OCTAL_SIZE) records.push(paxRecord('size', String(entry.size)))
  const short = ascii && name.length <= 100 ? name : `PaxHeaders/${name.replace(/[^\x20-\x7e]/g, '_').slice(-80)}`
  const header = rawHeader(short, entry.type === 'directory' ? '5' : '0', Math.min(entry.size, MAX_OCTAL_SIZE), entry)
  if (!records.length) return header
  const pax = Buffer.concat(records)
  return Buffer.concat([rawHeader('PaxHeader', 'x', pax.length, entry), pax, Buffer.alloc(padding(pax.length)), header])
}

/** The size of the archive `packEntries` makes. */
export function archiveSize(entries: readonly TarEntry[]): number {
  return entries.reduce((total, entry) => total + entryHeader(entry).length + entry.size + padding(entry.size), 0) + END.length
}

/**
 * A tar archive of folders and files. Each file's data comes from `data`, which must yield exactly
 * `entry.size` bytes.
 */
export function packEntries(entries: readonly TarEntry[], data: (entry: TarEntry) => AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Readable {
  async function* generate(): AsyncGenerator<Buffer> {
    for (const entry of entries) {
      yield entryHeader(entry)
      if (entry.type !== 'file') continue
      let written = 0
      for await (const chunk of data(entry)) {
        written += chunk.length
        if (written > entry.size) throw new Error(`${entry.name} has more than the ${entry.size} bytes it was packed with.`)
        yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      }
      if (written !== entry.size) throw new Error(`${entry.name} has ${written} bytes, not the ${entry.size} it was packed with.`)
      const pad = padding(entry.size)
      if (pad) yield Buffer.alloc(pad)
    }
    yield END
  }
  return Readable.from(generate(), { objectMode: false })
}

/** Reads exactly `size` bytes, keeping what is left over for the next read. */
class ChunkReader {
  readonly #iterator: AsyncIterator<Uint8Array>
  #pending: Buffer = Buffer.alloc(0)
  #done = false

  constructor(source: AsyncIterable<Uint8Array>) {
    this.#iterator = source[Symbol.asyncIterator]()
  }

  async #fill(): Promise<boolean> {
    if (this.#done) return false
    const next = await this.#iterator.next()
    if (next.done) {
      this.#done = true
      return false
    }
    const chunk = Buffer.from(next.value)
    this.#pending = this.#pending.length ? Buffer.concat([this.#pending, chunk]) : chunk
    return true
  }

  /** Exactly `size` bytes, or null at the end of the input. */
  async exact(size: number): Promise<Buffer | null> {
    while (this.#pending.length < size) if (!(await this.#fill())) return null
    const out = this.#pending.subarray(0, size)
    this.#pending = this.#pending.subarray(size)
    return out
  }

  /** Up to `limit` bytes as they arrive, or null at the end of the input. */
  async some(limit: number): Promise<Buffer | null> {
    if (!this.#pending.length && !(await this.#fill())) return null
    const out = this.#pending.subarray(0, limit)
    this.#pending = this.#pending.subarray(out.length)
    return out
  }

  async skip(size: number): Promise<boolean> {
    let left = size
    while (left > 0) {
      const chunk = await this.some(left)
      if (!chunk) return false
      left -= chunk.length
    }
    return true
  }

  async close(): Promise<void> {
    await this.#iterator.return?.()
  }
}

function field(header: Buffer, offset: number, length: number): string {
  const raw = header.subarray(offset, offset + length)
  const end = raw.indexOf(0)
  return raw.subarray(0, end === -1 ? length : end).toString('utf8')
}

function numeric(header: Buffer, offset: number, length: number): number {
  // GNU base-256 for large values: the high bit of the first byte is set.
  if (header[offset]! & 0x80) {
    let value = header[offset]! & 0x7f
    for (let i = 1; i < length; i += 1) value = value * 256 + header[offset + i]!
    return value
  }
  const text = field(header, offset, length).trim()
  return text ? parseInt(text, 8) : 0
}

function parsePax(data: Buffer): Record<string, string> {
  const records: Record<string, string> = {}
  let at = 0
  while (at < data.length) {
    const space = data.indexOf(0x20, at)
    if (space === -1) break
    const length = Number(data.subarray(at, space).toString('ascii'))
    if (!Number.isInteger(length) || length <= 0) break
    const record = data.subarray(space + 1, at + length - 1).toString('utf8')
    const equals = record.indexOf('=')
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1)
    at += length
  }
  return records
}

export class TarFormatError extends Error {}

/**
 * Streams the contents of the first regular file in a tar archive, from `offset` and at most `length`
 * bytes, without holding the file in memory. The source is closed as soon as the range is read.
 */
export function extractFirstFile(source: AsyncIterable<Uint8Array>, range: { offset?: number; length?: number } = {}): Readable {
  const offset = range.offset ?? 0
  const limit = range.length ?? Infinity
  async function* generate(): AsyncGenerator<Buffer> {
    const reader = new ChunkReader(source)
    try {
      let pax: Record<string, string> = {}
      for (;;) {
        const header = await reader.exact(BLOCK)
        if (!header || header.every((byte) => byte === 0)) throw new TarFormatError('The archive has no file in it.')
        const type = String.fromCharCode(header[156] || 0x30)
        const size = pax.size !== undefined ? Number(pax.size) : numeric(header, 124, 12)
        if (type === 'x' || type === 'L') {
          const data = await reader.exact(size + padding(size))
          if (!data) throw new TarFormatError('The archive ends inside a header.')
          if (type === 'x') pax = parsePax(data.subarray(0, size))
          continue
        }
        if (type !== '0' && type !== '7') {
          if (!(await reader.skip(size + padding(size)))) throw new TarFormatError('The archive ends inside an entry.')
          pax = {}
          continue
        }
        if (!(await reader.skip(Math.min(offset, size)))) throw new TarFormatError('The archive ends inside the file.')
        let left = Math.max(0, Math.min(size - offset, limit))
        while (left > 0) {
          const chunk = await reader.some(Math.min(left, 1 << 20))
          if (!chunk) throw new TarFormatError('The archive ends inside the file.')
          left -= chunk.length
          yield Buffer.from(chunk)
        }
        return
      }
    } finally {
      await reader.close()
    }
  }
  return Readable.from(generate(), { objectMode: false })
}
