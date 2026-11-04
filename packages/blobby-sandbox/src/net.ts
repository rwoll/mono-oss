import { createServer } from 'node:net'
import type { Endpoint } from './backend.ts'

/** A free TCP port on 127.0.0.1. */
export function loopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('No port'))))
    })
  })
}

/** The URL of `path` on a guest port that a backend's `endpoint` points at, and the headers a request there needs. */
export function endpointUrl(endpoint: Endpoint, path = ''): { url: URL; headers: Record<string, string> } {
  if (endpoint.kind === 'tcp') {
    const host = endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host
    return { url: new URL(path, `http://${host}:${endpoint.port}/`), headers: {} }
  }
  const base = endpoint.url.endsWith('/') ? endpoint.url : `${endpoint.url}/`
  return { url: new URL(path, base), headers: { ...endpoint.headers } }
}
