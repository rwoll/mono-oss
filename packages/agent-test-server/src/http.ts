import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'

export const MAX_BODY_BYTES = 64 * 1024 * 1024

export class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, `The request body is larger than ${limit} bytes.`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export function flattenHeaders(headers: IncomingHttpHeaders | Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
  }
  return out
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.destroyed) return
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body))
}

export function toWebRequest(req: IncomingMessage, url: URL, body: Buffer, signal: AbortSignal): Request {
  const headers = new Headers()
  for (const [key, value] of Object.entries(flattenHeaders(req.headers))) headers.set(key, value)
  const method = req.method ?? 'GET'
  return new Request(url, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : new Uint8Array(body), signal })
}

export async function writeWebResponse(res: ServerResponse, response: Response, signal: AbortSignal): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers))
  if (!response.body) {
    res.end()
    return
  }
  const reader = response.body.getReader()
  signal.addEventListener('abort', () => void reader.cancel().catch(() => {}), { once: true })
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(value)
    }
  } catch {
    // The client went away mid-stream.
  }
  res.end()
}

/** Resolves when the response closes, whether it finished or the client went away. */
export function closed(res: ServerResponse): Promise<void> {
  return new Promise(resolve => {
    if (res.closed) resolve()
    else res.once('close', () => resolve())
  })
}
