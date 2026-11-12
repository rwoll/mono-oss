import type { IncomingMessage, ServerResponse } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { createMcpHandler, fromJsonSchema, McpServer, type CallToolResult, type McpHttpHandler } from '@modelcontextprotocol/server'
import { McpToolResult, type McpTool } from './scenario.ts'
import type { Session } from './session.ts'
import { flattenHeaders, toWebRequest, writeWebResponse } from './http.ts'

/** Serves each session's fake MCP servers over Streamable HTTP and records their traffic. */
export class McpHost {
  private readonly handlers = new Map<string, McpHttpHandler>()
  private readonly unauthenticated: (session: Session, headers: Record<string, string>) => boolean

  constructor(unauthenticated: (session: Session, headers: Record<string, string>) => boolean = () => false) {
    this.unauthenticated = unauthenticated
  }

  private mark(session: Session, headers: Record<string, string>): { unauthenticated?: true } {
    return this.unauthenticated(session, headers) ? { unauthenticated: true } : {}
  }

  async handle(session: Session, name: string, req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer): Promise<void> {
    if (!session.mcpServers.has(name)) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `No MCP server named ${name} in session ${session.id}.` }))
      return
    }
    const headers = flattenHeaders(req.headers)
    this.record(session, name, req, url, headers, body)
    const key = `${session.id}\0${name}`
    let handler = this.handlers.get(key)
    if (!handler) {
      handler = createMcpHandler(context => this.build(session, name, flattenHeaders(Object.fromEntries(context.requestInfo?.headers ?? []))), {
        onerror: error => console.error(`[agent-test-server] MCP ${name}: ${error.message}`),
      })
      this.handlers.set(key, handler)
    }
    const abort = new AbortController()
    res.on('close', () => abort.abort())
    const response = await handler.fetch(toWebRequest(req, url, body, abort.signal))
    await writeWebResponse(res, response, abort.signal)
  }

  toolsChanged(session: Session, name: string): void {
    this.handlers.get(`${session.id}\0${name}`)?.notify.toolsChanged()
  }

  async forget(session: Session, name?: string): Promise<void> {
    for (const [key, handler] of this.handlers) {
      if (key === `${session.id}\0${name}` || (name === undefined && key.startsWith(`${session.id}\0`))) {
        this.handlers.delete(key)
        await handler.close()
      }
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.handlers.values()].map(handler => handler.close()))
    this.handlers.clear()
  }

  /** Logs JSON-RPC requests other than tool calls, which the tool handler logs with its result. */
  private record(session: Session, name: string, req: IncomingMessage, url: URL, headers: Record<string, string>, body: Buffer): void {
    if (req.method !== 'POST') return
    let parsed: unknown
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch {
      return
    }
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      if (typeof message !== 'object' || message === null) continue
      const method = (message as { method?: unknown }).method
      if (typeof method !== 'string' || method === 'tools/call' || method.startsWith('notifications/')) continue
      session.add({ kind: 'mcp', status: 'completed', method: 'POST', path: url.pathname, headers, body: message, mcp: { server: name, method }, ...this.mark(session, headers) })
    }
  }

  private build(session: Session, name: string, headers: Record<string, string>): McpServer {
    const server = new McpServer({ name, version: '0.0.0' }, { capabilities: { tools: { listChanged: true } } })
    for (const tool of session.mcpServers.get(name)?.tools ?? []) {
      server.registerTool(tool.name, {
        title: tool.title,
        description: tool.description,
        inputSchema: fromJsonSchema(tool.inputSchema ?? { type: 'object' }),
      }, (args: unknown) => this.call(session, name, tool, args, headers))
    }
    return server
  }

  private async call(session: Session, server: string, tool: McpTool, args: unknown, headers: Record<string, string>): Promise<CallToolResult> {
    const entry = session.add({
      kind: 'mcp', status: 'in_progress', method: 'POST', path: `/mcp/${server}`, headers,
      body: { method: 'tools/call', params: { name: tool.name, arguments: args } },
      mcp: { server, method: 'tools/call', tool: tool.name, arguments: args },
      ...this.mark(session, headers),
    })
    if (tool.delayMs) await sleep(tool.delayMs)
    let result = tool.result ?? { text: `${tool.name} called with ${JSON.stringify(args ?? {})}` }
    if (tool.manual) {
      const payload = await session.awaitRespond(entry)
      if (!payload) {
        entry.status = 'aborted'
        entry.notes.push('The session was reset before anyone responded.')
        session.changed(entry)
        return { content: [{ type: 'text', text: 'Cancelled.' }], isError: true }
      }
      if (!payload.result) throw new Error(`Respond to MCP tool call ${entry.id} with a result.`)
      result = McpToolResult.parse(payload.result)
    }
    const callResult = {
      content: result.content ?? [{ type: 'text', text: result.text ?? '' }],
      ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
      ...(result.isError ? { isError: true } : {}),
    } as CallToolResult
    entry.status = 'completed'
    entry.response = { status: 200, result: callResult }
    session.changed(entry)
    return callResult
  }
}
