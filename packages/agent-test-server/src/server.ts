import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import { encodeEvents, encodeJson, errorBody, plan, planMessage } from './encode.ts'
import { closed, flattenHeaders, HttpError, readBody, sendJson } from './http.ts'
import { McpHost } from './mcp.ts'
import { lastUserText, normalize, RequestError } from './normalize.ts'
import {
  Failure, McpTool, ModelDef, Protocol, Reply, Scenario, TextMatch, Unmatched,
  type ScenarioInput,
} from './scenario.ts'
import { Session, TimeoutError, type LogEntry, type RequestFilter } from './session.ts'
import { vscodeLanguageModels, vscodeMcpServers } from './vscode.ts'

export interface ServerOptions {
  /** Defaults to 127.0.0.1. */
  host?: string
  /** Defaults to 0, any free port. */
  port?: number
  /** The URL clients use to reach the server, when it differs from the address it listens on (for example from a container). */
  publicUrl?: string
  /** Bearer token for the admin API. Generated when omitted. */
  adminToken?: string
  /** API key for the default session. Generated when omitted. */
  apiKey?: string
  /** Reject LLM requests that don't carry the session's API key. Defaults to true. */
  requireApiKey?: boolean
  /** Loaded into the default session. */
  scenario?: ScenarioInput
}

/** Models that behave a fixed way when no rule matches, so a tester can pick them without writing rules. */
export const BUILTIN_MODELS = ['echo', 'fail-429', 'fail-500', 'hang', 'slow'] as const

export interface SessionInfo {
  id: string
  apiKey: string
  baseUrl: string
  /** Base URL for the OpenAI and Anthropic APIs, ending in /v1. */
  llmBaseUrl: string
  models: ModelDef[]
  unmatched: Unmatched
  mcpServers: { name: string; url: string; tools: McpTool[] }[]
  cursor: number
}

const PROTOCOL_PATHS: Record<string, Protocol> = { '/chat/completions': 'chat', '/responses': 'responses', '/messages': 'messages' }
const DEFAULT_SESSION = 'default'

/** The fake LLM and MCP server. Drive it through the admin API, usually with the SDK or CLI. */
export class AgentTestServer {
  readonly adminToken: string
  readonly requireApiKey: boolean
  private readonly sessions = new Map<string, Session>()
  private readonly mcp = new McpHost()
  private readonly http: Server
  private readonly options: ServerOptions
  private listenUrl = ''

  private constructor(options: ServerOptions) {
    this.options = options
    this.adminToken = options.adminToken ?? `ats-admin-${randomBytes(16).toString('hex')}`
    this.requireApiKey = options.requireApiKey ?? true
    this.sessions.set(DEFAULT_SESSION, new Session(DEFAULT_SESSION, options.apiKey))
    this.http = createServer((req, res) => {
      this.route(req, res).catch(error => {
        const status = error instanceof HttpError ? error.status : 500
        if (status === 500) console.error('[agent-test-server]', error)
        sendJson(res, status, { error: error instanceof Error ? error.message : String(error) })
      })
    })
    // Clients abort streams all the time; that is not a server error.
    this.http.on('clientError', (_error, socket) => socket.destroy())
  }

  static async start(options: ServerOptions = {}): Promise<AgentTestServer> {
    const server = new AgentTestServer(options)
    await new Promise<void>((resolve, reject) => {
      server.http.once('error', reject)
      server.http.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => resolve())
    })
    const address = server.http.address() as AddressInfo
    const host = address.family === 'IPv6' ? `[${address.address}]` : address.address
    server.listenUrl = `http://${host === '0.0.0.0' || host === '[::]' ? '127.0.0.1' : host}:${address.port}`
    if (options.scenario) server.load(server.session(DEFAULT_SESSION), options.scenario)
    return server
  }

  get url(): string {
    return (this.options.publicUrl ?? this.listenUrl).replace(/\/$/, '')
  }

  async close(): Promise<void> {
    for (const session of this.sessions.values()) session.reset()
    await this.mcp.close()
    this.http.closeAllConnections()
    await new Promise<void>(resolve => this.http.close(() => resolve()))
  }

  session(id: string): Session {
    const session = this.sessions.get(id)
    if (!session) throw new HttpError(404, `No session ${id}.`)
    return session
  }

  createSession(id?: string, apiKey?: string): Session {
    const sessionId = id ?? `s-${randomBytes(6).toString('hex')}`
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new HttpError(400, 'Session IDs use letters, digits, _ and -.')
    if (this.sessions.has(sessionId)) throw new HttpError(409, `Session ${sessionId} already exists.`)
    const session = new Session(sessionId, apiKey)
    this.sessions.set(sessionId, session)
    return session
  }

  info(session: Session): SessionInfo {
    const baseUrl = session.id === DEFAULT_SESSION ? this.url : `${this.url}/s/${session.id}`
    return {
      id: session.id,
      apiKey: session.apiKey,
      baseUrl,
      llmBaseUrl: `${baseUrl}/v1`,
      models: session.effectiveModels(),
      unmatched: session.unmatched,
      mcpServers: [...session.mcpServers.values()].map(def => ({ name: def.name, url: `${baseUrl}/mcp/${def.name}`, tools: def.tools })),
      cursor: session.cursor,
    }
  }

  /** Adds a scenario to a session: replaces models and the unmatched policy when given, and adds rules and MCP servers. */
  load(session: Session, input: unknown): void {
    const scenario = Scenario.parse(input)
    if (scenario.models) session.models = scenario.models
    if (scenario.unmatched) session.unmatched = scenario.unmatched
    for (const rule of scenario.rules ?? []) session.addRule(rule)
    for (const server of scenario.mcpServers ?? []) session.addMcpServer(server)
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname.startsWith('/_admin/') || url.pathname === '/_admin') return this.admin(req, res, url)
    let session = this.session(DEFAULT_SESSION)
    let path = url.pathname
    const scoped = /^\/s\/([^/]+)(\/.*)?$/.exec(path)
    if (scoped) {
      session = this.session(decodeURIComponent(scoped[1]!))
      path = scoped[2] ?? '/'
    }
    const mcp = /^\/mcp\/([^/]+)\/?$/.exec(path)
    if (mcp) return this.mcp.handle(session, decodeURIComponent(mcp[1]!), req, res, url, await readBody(req))
    const api = path.replace(/^\/v1(?=\/)/, '')
    if (req.method === 'GET' && api === '/models') return this.listModels(session, req, res)
    const protocol = PROTOCOL_PATHS[api]
    if (protocol && req.method === 'POST') return this.llm(session, protocol, req, res, url)
    if (req.method === 'GET' && path === '/') return sendJson(res, 200, { name: '@rwoll/agent-test-server', session: session.id })
    sendJson(res, 404, { error: `Nothing at ${req.method} ${url.pathname}.` })
  }

  private listModels(session: Session, req: IncomingMessage, res: ServerResponse): void {
    if (!this.authorized(session, req)) return sendJson(res, 401, errorBody(undefined, { status: 401 }))
    const created = Math.floor(Date.now() / 1000)
    const ids = [...session.effectiveModels().map(model => model.id), ...BUILTIN_MODELS]
    // One shape that both the OpenAI and Anthropic model list parsers accept.
    const data = ids.map(id => ({ id, object: 'model', type: 'model', display_name: id, created, created_at: new Date(created * 1000).toISOString(), owned_by: 'agent-test-server' }))
    sendJson(res, 200, { object: 'list', data, has_more: false, first_id: ids[0] ?? null, last_id: ids.at(-1) ?? null })
  }

  private authorized(session: Session, req: IncomingMessage): boolean {
    if (!this.requireApiKey) return true
    const headers = flattenHeaders(req.headers)
    const bearer = /^Bearer\s+(.+)$/i.exec(headers.authorization ?? '')?.[1]
    return [bearer, headers['x-api-key'], headers['api-key']].includes(session.apiKey)
  }

  private async llm(session: Session, protocol: Protocol, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    session.open.add(res)
    res.once('close', () => session.open.delete(res))
    const abort = new AbortController()
    res.once('close', () => abort.abort())
    const raw = await readBody(req)
    let body: unknown
    try {
      body = JSON.parse(raw.toString('utf8'))
    } catch {
      body = raw.toString('utf8')
    }
    const entry = session.add({ kind: 'llm', status: 'in_progress', method: 'POST', path: url.pathname, headers: flattenHeaders(req.headers), body })
    const fail = (failure: Failure & { code?: string }, note?: string) => {
      if (note) entry.notes.push(note)
      const error = errorBody(protocol, failure)
      entry.status = 'failed'
      entry.response = { status: failure.status, error }
      session.changed(entry)
      sendJson(res, failure.status, error, failure.retryAfter !== undefined ? { 'retry-after': String(failure.retryAfter) } : {})
    }
    if (!this.authorized(session, req)) return fail({ status: 401 }, 'Rejected: missing or wrong API key.')
    let request
    try {
      request = normalize(protocol, body, id => session.responses.get(id))
    } catch (error) {
      if (error instanceof RequestError) return fail({ status: error.status, message: error.message, code: error.code })
      throw error
    }
    const nth = ++session.llmCount
    entry.llm = { protocol, model: request.model, nth, request }
    const rule = session.matchRule(request, nth)
    let reply: Reply | undefined
    if (rule) {
      entry.llm.ruleId = rule.id
      reply = rule.reply
      if (rule.hold) {
        const payload = await session.awaitRespond(entry, abort.signal)
        if (!payload) return this.abandoned(session, entry)
        reply = payload.reply ? Reply.parse(payload.reply) : reply
      }
    } else if ((BUILTIN_MODELS as readonly string[]).includes(request.model)) {
      entry.llm.builtin = request.model
      reply = builtinReply(request.model, lastUserText(request))
    } else {
      entry.llm.unmatched = true
      if (session.unmatched === 'manual') {
        const payload = await session.awaitRespond(entry, abort.signal)
        if (!payload) return this.abandoned(session, entry)
        if (!payload.reply) return fail({ status: 500, message: `Respond to ${entry.id} with a reply.` })
        reply = Reply.parse(payload.reply)
      } else if (session.unmatched === 'error') {
        return fail({ status: 500, message: `[agent-test-server] No rule matched request ${entry.id} in session ${session.id}.` })
      } else {
        reply = Reply.parse({ parts: [{ text: `[agent-test-server] No rule matched request ${entry.id}. Add one with the SDK, or run: agent-test-server reply "<text>"` }] })
      }
    }
    entry.status = 'in_progress'
    entry.response = { status: 0, reply }
    session.changed(entry)
    if (reply.delayMs) await sleep(reply.delayMs, undefined, { signal: abort.signal }).catch(() => {})
    if (res.closed) return this.abandoned(session, entry)
    if (reply.hang) {
      await closed(res)
      return this.abandoned(session, entry, 'The client closed a request that was set to hang.')
    }
    if (reply.fail) return fail(reply.fail)
    const p = plan(request, reply, body)
    entry.response = { status: 200, id: p.id, items: p.items, reply }
    if (protocol === 'responses') session.responses.set(p.id, [...request.messages, planMessage(p)])
    if (!request.stream) {
      entry.status = 'completed'
      session.changed(entry)
      return sendJson(res, 200, encodeJson(protocol, p, request))
    }
    const events = encodeEvents(protocol, p, request)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.flushHeaders()
    let sent = 0
    for (const event of events) {
      if (reply.disconnectAfterEvents !== undefined && sent >= reply.disconnectAfterEvents) {
        res.destroy()
        entry.status = 'failed'
        entry.response.eventsSent = sent
        entry.notes.push(`The server dropped the connection after ${sent} SSE events, as the reply asked.`)
        session.changed(entry)
        return
      }
      const delay = sent === 0 ? reply.stream?.firstEventDelayMs : reply.stream?.delayMs
      if (delay) await sleep(delay, undefined, { signal: abort.signal }).catch(() => {})
      if (res.closed) {
        entry.response.eventsSent = sent
        return this.abandoned(session, entry, `The client disconnected after ${sent} of ${events.length} SSE events.`)
      }
      res.write(event)
      sent++
    }
    res.end()
    entry.status = 'completed'
    entry.response.eventsSent = sent
    session.changed(entry)
  }

  private abandoned(session: Session, entry: LogEntry, note = 'The client disconnected before the server answered.'): void {
    entry.status = 'aborted'
    entry.notes.push(note)
    session.changed(entry)
  }

  // Admin API

  private async admin(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const auth = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]
    if (auth !== this.adminToken) return sendJson(res, 401, { error: 'The admin API needs `Authorization: Bearer <admin token>`.' })
    const parts = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent)
    const method = req.method ?? 'GET'
    const raw = await readBody(req)
    let input: unknown = {}
    if (raw.length) {
      try {
        input = JSON.parse(raw.toString('utf8'))
      } catch {
        throw new HttpError(400, 'The admin API takes JSON bodies.')
      }
    }
    try {
      const result = await this.adminRoute(method, parts, input, url, res)
      if (result !== undefined) sendJson(res, 200, result)
    } catch (error) {
      if (error instanceof z.ZodError) return sendJson(res, 400, { error: z.prettifyError(error) })
      if (error instanceof TimeoutError) return sendJson(res, 408, { error: error.message })
      throw error
    }
  }

  private async adminRoute(method: string, parts: string[], input: unknown, url: URL, res: ServerResponse): Promise<unknown> {
    const [resource, sessionId, sub, subId, action] = parts
    if (resource === 'status' && method === 'GET') return { name: '@rwoll/agent-test-server', url: this.url, sessions: [...this.sessions.keys()] }
    if (resource === 'reset' && method === 'POST') {
      for (const session of this.sessions.values()) {
        session.reset()
        await this.mcp.forget(session)
      }
      return { ok: true }
    }
    if (resource !== 'sessions') throw new HttpError(404, `Unknown admin route /${parts.join('/')}.`)
    if (!sessionId) {
      if (method === 'GET') return [...this.sessions.values()].map(session => this.info(session))
      if (method === 'POST') {
        const body = z.object({ id: z.string().optional(), apiKey: z.string().optional() }).parse(input)
        return this.info(this.createSession(body.id, body.apiKey))
      }
    }
    const session = this.session(sessionId!)
    if (!sub) {
      if (method === 'GET') return this.info(session)
      if (method === 'DELETE') {
        if (session.id === DEFAULT_SESSION) throw new HttpError(400, 'The default session can be reset but not deleted.')
        session.reset()
        await this.mcp.forget(session)
        this.sessions.delete(session.id)
        return { ok: true }
      }
    }
    switch (`${method} ${sub}${subId ? '/:id' : ''}${action ? `/${action}` : ''}`) {
      case 'POST reset':
        session.reset()
        await this.mcp.forget(session)
        return this.info(session)
      case 'POST scenario':
        this.load(session, input)
        return this.info(session)
      case 'PUT models':
        session.models = z.object({ models: z.array(ModelDef) }).parse(input).models
        return this.info(session)
      case 'PUT unmatched':
        session.unmatched = z.object({ unmatched: Unmatched }).parse(input).unmatched
        return this.info(session)
      case 'GET rules':
        return session.rules
      case 'POST rules':
        return { id: session.addRule(input) }
      case 'DELETE rules/:id':
        if (!session.removeRule(subId!)) throw new HttpError(404, `No rule ${subId}.`)
        return { ok: true }
      case 'GET cursor':
        return { cursor: session.cursor }
      case 'GET requests': {
        const after = Number(url.searchParams.get('after') ?? 0)
        return { cursor: session.cursor, requests: session.list(filterFromQuery(url.searchParams), after) }
      }
      case 'GET requests/:id': {
        const entry = session.get(subId!)
        if (!entry) throw new HttpError(404, `No request ${subId}.`)
        return entry
      }
      case 'POST requests/:id/respond':
        session.respond(subId!, z.object({ reply: Reply.optional(), result: McpTool.shape.result }).parse(input))
        return { ok: true }
      case 'POST wait': {
        const body = z.object({ after: z.number().int().nonnegative().default(0), filter: RequestFilterSchema.default({}), timeoutMs: z.number().positive().max(300_000).default(30_000) }).parse(input)
        const abort = new AbortController()
        res.once('close', () => abort.abort())
        return session.wait(body.filter, body.after, body.timeoutMs, abort.signal)
      }
      case 'PUT mcp/:id': {
        const def = session.addMcpServer({ tools: [], ...(input as object), name: subId })
        this.mcp.toolsChanged(session, def.name)
        return this.info(session)
      }
      case 'DELETE mcp/:id':
        session.mcpServers.delete(subId!)
        await this.mcp.forget(session, subId)
        return this.info(session)
      case 'POST mcp/:id/tools': {
        const def = session.mcpServers.get(subId!) ?? session.addMcpServer({ name: subId })
        const tool = McpTool.parse(input)
        def.tools = [...def.tools.filter(existing => existing.name !== tool.name), tool]
        this.mcp.toolsChanged(session, def.name)
        return this.info(session)
      }
      case 'GET vscode': {
        const protocol = url.searchParams.get('protocol')
        const info = this.info(session)
        return {
          chatLanguageModels: vscodeLanguageModels(info.llmBaseUrl, info.apiKey, info.models, { protocol: protocol ? Protocol.parse(protocol) : undefined, name: url.searchParams.get('name') ?? undefined }),
          mcp: vscodeMcpServers(info.mcpServers),
        }
      }
    }
    throw new HttpError(404, `Unknown admin route ${method} /${parts.join('/')}.`)
  }
}

export const RequestFilterSchema = z.object({
  kind: z.enum(['llm', 'mcp']).optional(),
  status: z.enum(['in_progress', 'pending', 'completed', 'failed', 'aborted']).optional(),
  protocol: Protocol.optional(),
  model: z.string().optional(),
  hasTool: z.string().optional(),
  lastUserMessage: TextMatch.optional(),
  mcpServer: z.string().optional(),
  mcpMethod: z.string().optional(),
  tool: z.string().optional(),
}).strict()

function filterFromQuery(params: URLSearchParams): RequestFilter {
  const json = params.get('filter')
  if (json) {
    try {
      return RequestFilterSchema.parse(JSON.parse(json))
    } catch (error) {
      if (error instanceof z.ZodError) throw error
      throw new HttpError(400, 'The `filter` query parameter must be JSON.')
    }
  }
  const filter: Record<string, string> = {}
  for (const key of Object.keys(RequestFilterSchema.shape)) {
    const value = params.get(key)
    if (value !== null) filter[key] = value
  }
  return RequestFilterSchema.parse(filter)
}

function builtinReply(model: string, userText: string | undefined): Reply {
  switch (model) {
    case 'echo': return Reply.parse({ parts: [{ text: userText ?? '(The request has no user message to echo.)' }] })
    case 'fail-429': return Reply.parse({ fail: { status: 429, retryAfter: 1 } })
    case 'fail-500': return Reply.parse({ fail: { status: 500 } })
    case 'hang': return Reply.parse({ hang: true })
    default: return Reply.parse({ parts: [{ text: 'This reply streams slowly, a few characters at a time.' }], stream: { chunkChars: 4, delayMs: 250 } })
  }
}

