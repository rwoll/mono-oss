#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { AgentTestClient, AgentTestServerError, type SessionHandle } from './client.ts'
import type { Matcher, McpToolInput, ReplyInput, ReplyPart, RuleInput } from './scenario.ts'
import { PROTOCOLS, scenarioJsonSchema, type Protocol } from './scenario.ts'
import { AgentTestServer, isLoopbackHost } from './server.ts'
import type { LogEntry, RequestFilter } from './session.ts'
import { lastUserText } from './normalize.ts'

const USAGE = `Usage: agent-test-server <command> [options]

A fake LLM (OpenAI Chat Completions and Responses, Anthropic Messages) and MCP server for
testing clients such as VS Code. Every command prints JSON.

Server:
  start                        Start a server in the background and save its URL and admin token
                               to the state file. --port, --host, --public-url, --api-key,
                               --admin-token, --scenario <file>, --unmatched <text|error|manual>.
                               --no-auth accepts LLM and MCP requests without a session API key,
                               for clients that can't be given one: a request with no key, an
                               empty key, or an unknown key goes to the default session. Only on
                               loopback (--host 127.0.0.1, ::1, or localhost). The admin API
                               still needs the admin token.
  serve                        Same as start, in the foreground.
  stop                         Stop the server in the state file.
  status                       The server and the session's URLs, API key, models, and MCP servers,
                               and noAuth: true in no-auth mode.

Sessions (each has its own API key, rules, request log, and MCP servers):
  session create [--id <id>]   Create a session. Use it with --session <id> or AGENT_TEST_SERVER_SESSION.
  session list | rm <id>
  reset [--all]                Clear the session's rules, models, log, and MCP servers, or every session's.

Scripting the model:
  reply [text]                 Add a rule that answers with text, --tool-call <name> [--args <json>],
                               and --reasoning <text>. Rule options below.
  fail [--status <code>]       Add a rule that answers with an HTTP error (default 500).
                               --message, --retry-after <seconds>.
  rules [list] | rules rm <id>
  load <scenario.json>         Add models, rules, and MCP servers from a scenario file (see: schema).
  models <id>...               Set the session's models. --protocol <chat|responses|messages>,
                               --vision, --thinking.
  unmatched <text|error|manual>
                               What happens when no rule matches. manual holds the request until
                               you respond to it, so you can play the model.
  schema                       The scenario file's JSON Schema.

  Rule options: --when-user <text>, --when-user-regex <regex>, --when-tool-result <tool>,
  --when-has-tool <tool>, --when-model <id>, --when-protocol <protocol>, --when-system <text>,
  --nth <n>, --once, --times <n>, --fallback, --hold, --id <id>.
  Reply options: --stream <chars>[:<delayMs>], --delay <ms>, --disconnect-after <events>, --hang.

Requests:
  requests [list]              Summaries of logged requests. --full for whole entries; --after <cursor>.
  requests show <id>           One whole entry: headers, raw body, normalized request, response.
  requests wait                Wait for the first matching request after the last one you waited
                               for (or marked). --pending waits for one held for respond.
                               --timeout <seconds> (default 30, exits 3 on timeout), --after <cursor>.
  requests mark                Wait only for requests that arrive after now.
  Filters: --kind <llm|mcp>, --status <status>, --protocol, --model, --has-tool <tool>,
  --user <text>, --mcp-server <name>, --tool <name>, --method <mcp method>.

  respond <id> [text]          Answer a pending request. LLM: text, --tool-call, --reasoning, or
                               --fail <status>; a held request with no reply gets its rule's reply.
                               MCP tool call: text, or --result <json>, and --error.

MCP:
  mcp add <name>               Add an MCP server. Its URL is <base>/mcp/<name>.
  mcp tool <server> <tool>     Add or replace a tool. --description, --schema <json>, --text <result>,
                               --result <json>, --error, --manual, --delay <ms>.
  mcp list | mcp rm <name>

VS Code:
  config vscode                chatLanguageModels.json (Custom Endpoint provider) and mcp.json content.
                               --protocol overrides each model's; --write <file> and --write-mcp <file>
                               write the files. In no-auth mode the models file has no apiKey:
                               VS Code reads keys only from its secret storage, and sends an
                               empty one.

Connection: --state <file> (default ~/.agent-test-server/server.json, or AGENT_TEST_SERVER_STATE),
or --url and --admin-token (AGENT_TEST_SERVER_URL, AGENT_TEST_SERVER_ADMIN_TOKEN).
Session: --session <id> or AGENT_TEST_SERVER_SESSION; default "default".
`

const options = {
  help: { type: 'boolean', short: 'h' },
  state: { type: 'string' },
  url: { type: 'string' },
  'admin-token': { type: 'string' },
  session: { type: 'string', short: 's' },
  // start and serve
  host: { type: 'string' },
  port: { type: 'string' },
  'public-url': { type: 'string' },
  'api-key': { type: 'string' },
  'no-auth': { type: 'boolean' },
  scenario: { type: 'string' },
  // rules
  'when-user': { type: 'string' },
  'when-user-regex': { type: 'string' },
  'when-tool-result': { type: 'string' },
  'when-has-tool': { type: 'string' },
  'when-model': { type: 'string' },
  'when-protocol': { type: 'string' },
  'when-system': { type: 'string' },
  nth: { type: 'string' },
  once: { type: 'boolean' },
  times: { type: 'string' },
  fallback: { type: 'boolean' },
  hold: { type: 'boolean' },
  id: { type: 'string' },
  // replies
  'tool-call': { type: 'string' },
  args: { type: 'string' },
  reasoning: { type: 'string' },
  stream: { type: 'string' },
  delay: { type: 'string' },
  'disconnect-after': { type: 'string' },
  hang: { type: 'boolean' },
  status: { type: 'string' },
  message: { type: 'string' },
  'retry-after': { type: 'string' },
  fail: { type: 'string' },
  // requests
  full: { type: 'boolean' },
  after: { type: 'string' },
  pending: { type: 'boolean' },
  timeout: { type: 'string' },
  kind: { type: 'string' },
  protocol: { type: 'string' },
  model: { type: 'string' },
  'has-tool': { type: 'string' },
  user: { type: 'string' },
  'mcp-server': { type: 'string' },
  tool: { type: 'string' },
  method: { type: 'string' },
  all: { type: 'boolean' },
  // models
  vision: { type: 'boolean' },
  thinking: { type: 'boolean' },
  // mcp
  description: { type: 'string' },
  schema: { type: 'string' },
  text: { type: 'string' },
  result: { type: 'string' },
  error: { type: 'boolean' },
  manual: { type: 'boolean' },
  unmatched: { type: 'string' },
  // config
  name: { type: 'string' },
  write: { type: 'string' },
  'write-mcp': { type: 'string' },
} as const

type Values = ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true }>>['values']

class UsageError extends Error {}

interface State {
  url: string
  adminToken: string
  pid?: number
  /** The last cursor `requests wait` or `mark` saw, per server URL and session. */
  cursors?: Record<string, number>
}

function statePath(values: Values): string {
  return resolve(values.state ?? process.env.AGENT_TEST_SERVER_STATE ?? join(homedir(), '.agent-test-server', 'server.json'))
}

function readState(path: string): State | undefined {
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8')) as State
}

function writeState(path: string, state: State): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function int(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new UsageError(`--${flag} takes a non-negative number.`)
  return parsed
}

function json(value: string | undefined, flag: string): unknown {
  if (value === undefined) return undefined
  try {
    return JSON.parse(value)
  } catch {
    throw new UsageError(`--${flag} takes JSON.`)
  }
}

function protocol(value: string | undefined, flag = 'protocol'): Protocol | undefined {
  if (value === undefined) return undefined
  if (!(PROTOCOLS as readonly string[]).includes(value)) throw new UsageError(`--${flag} is one of ${PROTOCOLS.join(', ')}.`)
  return value as Protocol
}

function connection(values: Values): { client: AgentTestClient; state?: State; path: string } {
  const path = statePath(values)
  const state = readState(path)
  const url = values.url ?? process.env.AGENT_TEST_SERVER_URL ?? state?.url
  const adminToken = values['admin-token'] ?? process.env.AGENT_TEST_SERVER_ADMIN_TOKEN ?? state?.adminToken
  if (!url || !adminToken) throw new UsageError(`No server: run \`agent-test-server start\`, or pass --url and --admin-token. (Looked for ${path}.)`)
  return { client: new AgentTestClient({ url, adminToken }), state: url === state?.url ? state : undefined, path }
}

function sessionId(values: Values): string {
  return values.session ?? process.env.AGENT_TEST_SERVER_SESSION ?? 'default'
}

function matcher(values: Values): Matcher {
  const when: Matcher = {}
  if (values['when-user'] !== undefined) when.lastUserMessage = values['when-user']
  if (values['when-user-regex'] !== undefined) when.lastUserMessage = { regex: values['when-user-regex'] }
  if (values['when-tool-result'] !== undefined) when.toolResult = values['when-tool-result']
  if (values['when-has-tool'] !== undefined) when.hasTool = values['when-has-tool']
  if (values['when-model'] !== undefined) when.model = values['when-model']
  if (values['when-protocol'] !== undefined) when.protocol = protocol(values['when-protocol'], 'when-protocol')
  if (values['when-system'] !== undefined) when.system = values['when-system']
  if (values.nth !== undefined) when.nth = int(values.nth, 'nth')
  return when
}

function reply(values: Values, text: string | undefined): ReplyInput {
  const parts: ReplyPart[] = []
  if (values.reasoning !== undefined) parts.push({ reasoning: values.reasoning })
  if (text !== undefined) parts.push({ text })
  if (values['tool-call'] !== undefined) parts.push({ toolCall: { name: values['tool-call'], arguments: (json(values.args, 'args') ?? {}) as Record<string, unknown> } })
  const result: ReplyInput = { parts }
  if (values.stream !== undefined) {
    const [chars, delay] = values.stream.split(':')
    result.stream = { chunkChars: int(chars, 'stream') || undefined, delayMs: int(delay, 'stream') }
  }
  if (values.delay !== undefined) result.delayMs = int(values.delay, 'delay')
  if (values['disconnect-after'] !== undefined) result.disconnectAfterEvents = int(values['disconnect-after'], 'disconnect-after')
  if (values.hang) result.hang = true
  return result
}

function failure(values: Values, status: string | undefined): ReplyInput['fail'] {
  return {
    status: int(status ?? '500', 'status')!,
    ...(values.message !== undefined ? { message: values.message } : {}),
    ...(values['retry-after'] !== undefined ? { retryAfter: int(values['retry-after'], 'retry-after') } : {}),
  }
}

function rule(values: Values, replyInput: ReplyInput): RuleInput {
  return {
    ...(values.id !== undefined ? { id: values.id } : {}),
    when: matcher(values),
    ...(values.once ? { times: 1 } : values.times !== undefined ? { times: int(values.times, 'times') } : {}),
    ...(values.fallback ? { fallback: true } : {}),
    ...(values.hold ? { hold: true } : {}),
    reply: replyInput,
  }
}

function filter(values: Values): RequestFilter {
  const result: Record<string, unknown> = {
    kind: values.kind,
    status: values.pending ? 'pending' : values.status,
    protocol: protocol(values.protocol),
    model: values.model,
    hasTool: values['has-tool'],
    lastUserMessage: values.user,
    mcpServer: values['mcp-server'],
    tool: values.tool,
    mcpMethod: values.method,
  }
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined)) as RequestFilter
}

/** A short view of a log entry, small enough for an agent to read many of. */
function summary(entry: LogEntry): unknown {
  const llm = entry.llm
  const toolCalls = entry.response?.items?.flatMap(item => (item.type === 'tool_call' ? [item.name] : []))
  const text = entry.response?.items?.flatMap(item => (item.type === 'text' ? [item.text] : [])).join('')
  return {
    id: entry.id,
    seq: entry.seq,
    time: entry.time,
    kind: entry.kind,
    status: entry.status,
    ...(entry.unauthenticated ? { unauthenticated: true } : {}),
    ...(llm ? {
      protocol: llm.protocol,
      model: llm.model,
      lastUserMessage: lastUserText(llm.request),
      toolResults: llm.request.messages.at(-1)?.parts.flatMap(part => (part.type === 'tool_result' ? [{ name: part.name, content: part.content.slice(0, 200) }] : [])),
      tools: llm.request.tools.length,
      rule: llm.ruleId ?? (llm.builtin ? `builtin:${llm.builtin}` : llm.unmatched ? 'unmatched' : undefined),
    } : {}),
    ...(entry.mcp ? { mcp: entry.mcp } : {}),
    ...(entry.response ? { response: { status: entry.response.status, text: text || undefined, toolCalls: toolCalls?.length ? toolCalls : undefined, error: entry.response.error, result: entry.response.result } } : {}),
    ...(entry.notes.length ? { notes: entry.notes } : {}),
  }
}

async function serve(values: Values, background: boolean): Promise<void> {
  const path = statePath(values)
  const existing = readState(path)
  if (existing?.pid && isAlive(existing.pid)) throw new UsageError(`A server is already running (pid ${existing.pid}, ${existing.url}). Stop it first, or pass another --state.`)
  const noAuth = values['no-auth'] ?? false
  if (noAuth && !isLoopbackHost(values.host ?? '127.0.0.1')) {
    throw new UsageError(`--no-auth only works on loopback (--host 127.0.0.1, ::1, or localhost), not --host ${values.host}: without API keys, anyone who can reach the port can use the server.`)
  }
  const warn = () => {
    if (noAuth) process.stderr.write('agent-test-server: warning: no-auth mode. LLM and MCP requests are accepted without a session API key, from this machine only. The admin API still needs the admin token.\n')
  }
  if (background) {
    mkdirSync(dirname(path), { recursive: true })
    rmSync(path, { force: true })
    const log = openSync(join(dirname(path), 'server.log'), 'a')
    const args = process.argv.slice(2).map(arg => (arg === 'start' ? 'serve' : arg))
    if (!values.state) args.push('--state', path)
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...args], { detached: true, stdio: ['ignore', log, log] })
    child.unref()
    for (let i = 0; i < 100; i++) {
      const state = readState(path)
      if (state && state.pid === child.pid) {
        warn()
        return print(await describe(new AgentTestClient(state), 'default', path, state.pid))
      }
      if (child.exitCode !== null) break
      await sleep(100)
    }
    throw new Error(`The server didn't start. See ${join(dirname(path), 'server.log')}.`)
  }
  const scenario = values.scenario ? JSON.parse(readFileSync(values.scenario, 'utf8')) : undefined
  const server = await AgentTestServer.start({
    host: values.host,
    port: int(values.port, 'port'),
    publicUrl: values['public-url'],
    apiKey: values['api-key'],
    adminToken: values['admin-token'],
    noAuth,
    scenario: values.unmatched ? { ...scenario, unmatched: values.unmatched } : scenario,
  })
  writeState(path, { url: server.url, adminToken: server.adminToken, pid: process.pid })
  const shutdown = async () => {
    const state = readState(path)
    if (state?.pid === process.pid) rmSync(path, { force: true })
    await server.close()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  warn()
  print(await describe(new AgentTestClient(server), 'default', path, process.pid))
}

async function describe(client: AgentTestClient, session: string, state: string, pid?: number): Promise<unknown> {
  const [status, info] = await Promise.all([client.status(), client.session(session).info()])
  return { url: client.url, adminToken: client.adminToken, pid, state, ...(status.noAuth ? { noAuth: true } : {}), session: info }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true, strict: true })
  const [command, ...rest] = positionals
  if (values.help || !command || command === 'help') {
    process.stdout.write(USAGE)
    return 0
  }
  if (command === 'schema') return print(scenarioJsonSchema()), 0
  if (command === 'serve' || command === 'start') {
    await serve(values, command === 'start')
    return 0
  }
  if (command === 'stop') {
    const path = statePath(values)
    const state = readState(path)
    if (!state?.pid || !isAlive(state.pid)) {
      rmSync(path, { force: true })
      print({ stopped: false, reason: 'No server was running.' })
      return 0
    }
    process.kill(state.pid, 'SIGTERM')
    for (let i = 0; i < 50 && isAlive(state.pid); i++) await sleep(100)
    rmSync(path, { force: true })
    print({ stopped: true, pid: state.pid })
    return 0
  }

  const { client, state, path } = connection(values)
  const id = sessionId(values)
  const session: SessionHandle = client.session(id)
  const cursorKey = `${client.url} ${id}`
  const saveCursor = (cursor: number) => {
    if (!state) return
    writeState(path, { ...state, cursors: { ...state.cursors, [cursorKey]: cursor } })
  }

  switch (command) {
    case 'status':
      print({ ...(await client.status()), session: await session.info() })
      break
    case 'session': {
      const [sub, target] = rest
      if (sub === 'create') print(await (await client.createSession({ id: values.id, apiKey: values['api-key'] })).info())
      else if (sub === 'list' || sub === undefined) print(await client.sessions())
      else if (sub === 'rm' && target) print((await client.session(target).delete(), { deleted: target }))
      else throw new UsageError('Usage: session create [--id <id>] | session list | session rm <id>')
      break
    }
    case 'reset':
      if (values.all) await client.reset()
      else await session.reset()
      saveCursor(0)
      print({ reset: values.all ? 'all' : id })
      break
    case 'reply':
      print({ id: await session.addRule(rule(values, reply(values, rest[0]))) })
      break
    case 'fail':
      print({ id: await session.addRule(rule(values, { ...reply(values, undefined), fail: failure(values, values.status) })) })
      break
    case 'rules': {
      const [sub, target] = rest
      if (sub === 'rm' && target) print((await session.removeRule(target), { removed: target }))
      else print(await session.rules())
      break
    }
    case 'load':
      if (!rest[0]) throw new UsageError('Usage: load <scenario.json>')
      print(await session.load(JSON.parse(readFileSync(rest[0], 'utf8'))))
      break
    case 'models':
      if (!rest.length) throw new UsageError('Usage: models <id>... [--protocol <protocol>] [--vision] [--thinking]')
      print(await session.setModels(rest.map(model => ({ id: model, protocol: protocol(values.protocol), vision: values.vision, thinking: values.thinking }))))
      break
    case 'unmatched': {
      const policy = rest[0]
      if (policy !== 'text' && policy !== 'error' && policy !== 'manual') throw new UsageError('Usage: unmatched <text|error|manual>')
      print(await session.setUnmatched(policy))
      break
    }
    case 'requests': {
      const [sub, target] = rest
      if (sub === 'show') {
        if (!target) throw new UsageError('Usage: requests show <id>')
        print(await session.request(target))
      } else if (sub === 'mark') {
        const cursor = await session.mark()
        saveCursor(cursor)
        print({ cursor })
      } else if (sub === 'wait') {
        const current = (await session.info()).cursor
        let after = int(values.after, 'after') ?? state?.cursors?.[cursorKey] ?? 0
        if (after > current) after = 0
        const timeoutMs = (int(values.timeout, 'timeout') ?? 30) * 1000
        const entry = await session.waitForRequest({ ...filter(values), after, timeoutMs })
        saveCursor(entry.seq)
        print(values.full ? entry : summary(entry))
      } else if (sub === 'list' || sub === undefined) {
        const entries = await session.requests({ ...filter(values), after: int(values.after, 'after') })
        print(values.full ? entries : entries.map(summary))
      } else {
        throw new UsageError('Usage: requests [list] | show <id> | wait | mark')
      }
      break
    }
    case 'respond': {
      const [target, text] = rest
      if (!target) throw new UsageError('Usage: respond <id> [text] [options]')
      const entry = await session.request(target)
      if (entry.kind === 'mcp') {
        const result = (json(values.result, 'result') ?? { text: text ?? values.text ?? '' }) as Record<string, unknown>
        await session.respondMcp(target, { ...result, ...(values.error ? { isError: true } : {}) })
      } else {
        const replyInput = values.fail !== undefined ? { fail: failure(values, values.fail) } : reply(values, text)
        const empty = !replyInput.fail && !replyInput.parts?.length
        await session.respond(target, empty ? undefined : replyInput)
      }
      print({ responded: target })
      break
    }
    case 'mcp': {
      const [sub, server, toolName] = rest
      if (sub === 'add' && server) print(await (await session.addMcpServer(server)).url())
      else if (sub === 'rm' && server) print((await session.mcp(server).remove(), { removed: server }))
      else if (sub === 'list' || sub === undefined) print((await session.info()).mcpServers)
      else if (sub === 'tool' && server && toolName) {
        const result = (json(values.result, 'result') ?? (values.text !== undefined ? { text: values.text } : undefined)) as McpToolInput['result']
        const tool: McpToolInput = {
          name: toolName,
          ...(values.description !== undefined ? { description: values.description } : {}),
          ...(values.schema !== undefined ? { inputSchema: json(values.schema, 'schema') as Record<string, unknown> } : {}),
          ...(result || values.error ? { result: { ...result, ...(values.error ? { isError: true } : {}) } } : {}),
          ...(values.manual ? { manual: true } : {}),
          ...(values.delay !== undefined ? { delayMs: int(values.delay, 'delay') } : {}),
        }
        await session.mcp(server).tool(tool)
        print((await session.info()).mcpServers.find(entry => entry.name === server))
      } else {
        throw new UsageError('Usage: mcp add <name> | mcp tool <server> <tool> [options] | mcp list | mcp rm <name>')
      }
      break
    }
    case 'config': {
      if (rest[0] !== 'vscode') throw new UsageError('Usage: config vscode [--protocol <protocol>] [--write <file>] [--write-mcp <file>]')
      const config = await session.vscodeConfig({ protocol: protocol(values.protocol), name: values.name })
      for (const [file, content] of [[values.write, config.chatLanguageModels], [values['write-mcp'], config.mcp]] as const) {
        if (!file) continue
        mkdirSync(dirname(resolve(file)), { recursive: true })
        writeFileSync(file, `${JSON.stringify(content, null, 2)}\n`)
      }
      print(config)
      break
    }
    default:
      throw new UsageError(`Unknown command ${command}. Run agent-test-server --help.`)
  }
  return 0
}

main(process.argv.slice(2)).then(code => {
  if (code) process.exitCode = code
}, (error: unknown) => {
  if (error instanceof UsageError || (error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS'))) {
    process.stderr.write(`agent-test-server: ${error.message}\n`)
    process.exitCode = 2
  } else if (error instanceof AgentTestServerError) {
    process.stderr.write(`agent-test-server: ${error.message}\n`)
    process.exitCode = error.status === 408 ? 3 : 1
  } else {
    process.stderr.write(`agent-test-server: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
})
