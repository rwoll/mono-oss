import { AgentTestServer, type ServerOptions, type SessionInfo } from './server.ts'
import type {
  Failure, Matcher, McpToolInput, McpToolResult, ModelDefInput, Protocol, ReplyInput, ReplyPart, RuleInput, ScenarioInput, Unmatched,
} from './scenario.ts'
import type { LogEntry, RequestFilter } from './session.ts'

export interface ConnectOptions {
  /** The server's URL, such as http://127.0.0.1:4317. */
  url: string
  adminToken: string
}

export class AgentTestServerError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface VscodeConfig {
  /** The contents of VS Code's `chatLanguageModels.json`. */
  chatLanguageModels: unknown[]
  /** The contents of VS Code's `mcp.json`. */
  mcp: { servers: Record<string, { type: 'http'; url: string }> }
}

export type WaitOptions = RequestFilter & {
  /** Only requests after this cursor. Defaults to the last request this handle waited for, or `mark()`. */
  after?: number
  /** Defaults to 30 seconds; at most 5 minutes. */
  timeoutMs?: number
}

/** Talks to a running server's admin API. */
export class AgentTestClient {
  readonly url: string
  readonly adminToken: string

  constructor(options: ConnectOptions) {
    this.url = options.url.replace(/\/$/, '')
    this.adminToken = options.adminToken
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.url}/_admin${path}`, {
      method,
      headers: { authorization: `Bearer ${this.adminToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    const data = text ? JSON.parse(text) : undefined
    if (!response.ok) throw new AgentTestServerError(response.status, data?.error ?? `${method} ${path} failed with ${response.status}.`)
    return data as T
  }

  /** A handle for an existing session. `default` always exists. */
  session(id = 'default'): SessionHandle {
    return new SessionHandle(this, id)
  }

  /** A new, isolated session with its own API key, rules, log, and MCP servers. */
  async createSession(options: { id?: string; apiKey?: string } = {}): Promise<SessionHandle> {
    const info = await this.call<SessionInfo>('POST', '/sessions', options)
    return new SessionHandle(this, info.id)
  }

  sessions(): Promise<SessionInfo[]> {
    return this.call('GET', '/sessions')
  }

  /** `noAuth` is set when the server accepts LLM and MCP requests without a session API key. */
  status(): Promise<{ name: string; url: string; sessions: string[]; noAuth?: true }> {
    return this.call('GET', '/status')
  }

  /** Resets every session: rules, models, logs, MCP servers, and open requests. */
  async reset(): Promise<void> {
    await this.call('POST', '/reset')
  }
}

/** A server running in this process, with a client for it. */
export class RunningServer extends AgentTestClient {
  readonly server: AgentTestServer

  constructor(server: AgentTestServer) {
    super({ url: server.url, adminToken: server.adminToken })
    this.server = server
  }

  close(): Promise<void> {
    return this.server.close()
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }
}

/** Starts a server in this process. */
export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  return new RunningServer(await AgentTestServer.start(options))
}

/** Connects to a server started elsewhere, such as with `agent-test-server start`. */
export function connect(options: ConnectOptions): AgentTestClient {
  return new AgentTestClient(options)
}

type ReplyLike = ReplyInput | ReplyBuilder | string | ((reply: ReplyBuilder) => ReplyBuilder)

function toReply(reply: ReplyLike): ReplyInput {
  if (typeof reply === 'string') return { parts: [{ text: reply }] }
  if (typeof reply === 'function') return reply(new ReplyBuilder()).toJSON()
  if (reply instanceof ReplyBuilder) return reply.toJSON()
  return reply
}

export class SessionHandle {
  readonly id: string
  readonly client: AgentTestClient
  private seen = 0

  constructor(client: AgentTestClient, id: string) {
    this.client = client
    this.id = id
  }

  private path(suffix = ''): string {
    return `/sessions/${encodeURIComponent(this.id)}${suffix}`
  }

  /** URLs, API key, models, MCP servers, and the current cursor. */
  info(): Promise<SessionInfo> {
    return this.client.call('GET', this.path())
  }

  /** Replaces models and the unmatched policy when given; adds rules and MCP servers. */
  load(scenario: ScenarioInput): Promise<SessionInfo> {
    return this.client.call('POST', this.path('/scenario'), scenario)
  }

  setModels(models: ModelDefInput[]): Promise<SessionInfo> {
    return this.client.call('PUT', this.path('/models'), { models })
  }

  setUnmatched(unmatched: Unmatched): Promise<SessionInfo> {
    return this.client.call('PUT', this.path('/unmatched'), { unmatched })
  }

  async addRule(rule: RuleInput): Promise<string> {
    return (await this.client.call<{ id: string }>('POST', this.path('/rules'), rule)).id
  }

  /** Starts a rule for requests that match. Finish it with `reply` or `fail`. */
  when(matcher: Matcher = {}): RuleBuilder {
    return new RuleBuilder(this, { when: matcher })
  }

  /** Starts a rule that applies only when no other rule matches. */
  otherwise(): RuleBuilder {
    return new RuleBuilder(this, { when: {}, fallback: true })
  }

  rules(): Promise<(RuleInput & { id: string; used: number })[]> {
    return this.client.call('GET', this.path('/rules'))
  }

  async removeRule(id: string): Promise<void> {
    await this.client.call('DELETE', this.path(`/rules/${encodeURIComponent(id)}`))
  }

  async requests(filter: RequestFilter & { after?: number } = {}): Promise<LogEntry[]> {
    const { after, ...rest } = filter
    const query = new URLSearchParams({ after: String(after ?? 0), filter: JSON.stringify(rest) })
    return (await this.client.call<{ requests: LogEntry[] }>('GET', `${this.path('/requests')}?${query}`)).requests
  }

  request(id: string): Promise<LogEntry> {
    return this.client.call('GET', this.path(`/requests/${encodeURIComponent(id)}`))
  }

  /** Records the current cursor, so the next `waitForRequest` only sees requests that come later. */
  async mark(): Promise<number> {
    this.seen = (await this.client.call<{ cursor: number }>('GET', this.path('/cursor'))).cursor
    return this.seen
  }

  /**
   * The first matching request after `after`, waiting for one if needed. Without `after`,
   * it starts after the last request this handle waited for, so requests that arrive
   * before the wait starts still count.
   */
  async waitForRequest(options: WaitOptions = {}): Promise<LogEntry> {
    const { after, timeoutMs, ...filter } = options
    const entry = await this.client.call<LogEntry>('POST', this.path('/wait'), { after: after ?? this.seen, filter, timeoutMs })
    this.seen = Math.max(this.seen, entry.seq)
    return entry
  }

  /** Waits for a request that is held or unmatched in manual mode. */
  waitForPending(options: WaitOptions = {}): Promise<LogEntry> {
    return this.waitForRequest({ ...options, status: 'pending' })
  }

  /** Answers a pending LLM request. A held request without a reply gets its rule's reply. */
  async respond(id: string, reply?: ReplyLike): Promise<void> {
    await this.client.call('POST', this.path(`/requests/${encodeURIComponent(id)}/respond`), reply === undefined ? {} : { reply: toReply(reply) })
  }

  /** Answers a pending MCP tool call. */
  async respondMcp(id: string, result: McpToolResult | string): Promise<void> {
    await this.client.call('POST', this.path(`/requests/${encodeURIComponent(id)}/respond`), { result: typeof result === 'string' ? { text: result } : result })
  }

  /** A handle for one of this session's MCP servers. */
  mcp(name: string): McpServerHandle {
    return new McpServerHandle(this, name)
  }

  /** Adds or replaces an MCP server. */
  async addMcpServer(name: string, tools: McpToolInput[] = []): Promise<McpServerHandle> {
    await this.client.call('PUT', this.path(`/mcp/${encodeURIComponent(name)}`), { tools })
    return this.mcp(name)
  }

  /** Configuration for VS Code: `chatLanguageModels.json` for BYOK models, and `mcp.json`. */
  vscodeConfig(options: { protocol?: Protocol; name?: string } = {}): Promise<VscodeConfig> {
    const query = new URLSearchParams()
    if (options.protocol) query.set('protocol', options.protocol)
    if (options.name) query.set('name', options.name)
    return this.client.call('GET', `${this.path('/vscode')}?${query}`)
  }

  async reset(): Promise<void> {
    await this.client.call('POST', this.path('/reset'))
    this.seen = 0
  }

  async delete(): Promise<void> {
    await this.client.call('DELETE', this.path())
  }
}

export class McpServerHandle {
  readonly session: SessionHandle
  readonly name: string

  constructor(session: SessionHandle, name: string) {
    this.session = session
    this.name = name
  }

  async url(): Promise<string> {
    const info = await this.session.info()
    const server = info.mcpServers.find(server => server.name === this.name)
    if (!server) throw new AgentTestServerError(404, `No MCP server named ${this.name}.`)
    return server.url
  }

  /** Adds or replaces a tool, creating the server if needed, and notifies clients that the tool list changed. */
  async tool(tool: McpToolInput): Promise<this> {
    await this.session.client.call('POST', `/sessions/${encodeURIComponent(this.session.id)}/mcp/${encodeURIComponent(this.name)}/tools`, tool)
    return this
  }

  waitForToolCall(tool?: string, options: WaitOptions = {}): Promise<LogEntry> {
    return this.session.waitForRequest({ ...options, kind: 'mcp', mcpServer: this.name, mcpMethod: 'tools/call', ...(tool ? { tool } : {}) })
  }

  async remove(): Promise<void> {
    await this.session.client.call('DELETE', `/sessions/${encodeURIComponent(this.session.id)}/mcp/${encodeURIComponent(this.name)}`)
  }
}

export class RuleBuilder {
  private readonly session: SessionHandle
  private readonly rule: Omit<RuleInput, 'reply'>

  constructor(session: SessionHandle, rule: Omit<RuleInput, 'reply'>) {
    this.session = session
    this.rule = rule
  }

  id(id: string): this {
    this.rule.id = id
    return this
  }

  once(): this {
    return this.times(1)
  }

  times(count: number): this {
    this.rule.times = count
    return this
  }

  /** Holds matching requests until `respond` releases them. */
  hold(): this {
    this.rule.hold = true
    return this
  }

  /** Adds the rule and returns its ID. */
  reply(reply: ReplyLike): Promise<string> {
    return this.session.addRule({ ...this.rule, reply: toReply(reply) })
  }

  /** Adds a rule that answers with an HTTP error. */
  fail(failure: number | Failure, options: Omit<Failure, 'status'> = {}): Promise<string> {
    return this.reply({ fail: typeof failure === 'number' ? { status: failure, ...options } : failure })
  }
}

/** Builds a protocol-neutral reply. */
export class ReplyBuilder {
  private readonly reply: ReplyInput & { parts: ReplyPart[] } = { parts: [] }

  text(text: string): this {
    this.reply.parts.push({ text })
    return this
  }

  /** Calls a tool. `name` can be the end of a prefixed name, such as an MCP tool's. */
  toolCall(name: string, args: Record<string, unknown> | string = {}, options: { id?: string } = {}): this {
    this.reply.parts.push({ toolCall: { name, arguments: args, ...options } })
    return this
  }

  reasoning(text: string): this {
    this.reply.parts.push({ reasoning: text })
    return this
  }

  stream(options: NonNullable<ReplyInput['stream']>): this {
    this.reply.stream = options
    return this
  }

  usage(inputTokens: number, outputTokens: number): this {
    this.reply.usage = { inputTokens, outputTokens }
    return this
  }

  stopReason(reason: NonNullable<ReplyInput['stopReason']>): this {
    this.reply.stopReason = reason
    return this
  }

  delay(ms: number): this {
    this.reply.delayMs = ms
    return this
  }

  /** Drops the connection after this many SSE events. */
  disconnectAfter(events: number): this {
    this.reply.disconnectAfterEvents = events
    return this
  }

  hang(): this {
    this.reply.hang = true
    return this
  }

  fail(failure: number | Failure, options: Omit<Failure, 'status'> = {}): this {
    this.reply.fail = typeof failure === 'number' ? { status: failure, ...options } : failure
    return this
  }

  toJSON(): ReplyInput {
    return structuredClone(this.reply)
  }
}
