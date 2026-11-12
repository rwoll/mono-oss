import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import OpenAI from 'openai'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { startServer, type RunningServer } from '../src/index.ts'

const NO_AUTH_HEADER = 'x-agent-test-server-no-auth'

const UNKNOWN_KEY = 'not-a-session-key'

/** The headers a client sends for each way of not having the key. An empty bearer token is what a signed-out VS Code sends. */
const KEYLESS: [string, Record<string, string>][] = [
  ['a missing key', {}],
  ['an empty bearer token', { authorization: 'Bearer ' }],
  ['an empty x-api-key', { 'x-api-key': '' }],
  ['an unknown key', { authorization: `Bearer ${UNKNOWN_KEY}` }],
]

function chat(baseUrl: string, headers: Record<string, string>, content = 'hello'): Promise<Response> {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'echo', messages: [{ role: 'user', content }] }),
  })
}

describe('without no-auth', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  })

  afterAll(() => server.close())

  test.each(KEYLESS)('rejects %s', async (_name, headers) => {
    const response = await chat(server.url, headers)
    expect(response.status).toBe(401)
    expect(response.headers.has(NO_AUTH_HEADER)).toBe(false)
  })
})

describe('with no-auth', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer({ noAuth: true })
  })

  afterAll(() => server.close())

  afterEach(() => server.reset())

  test.each(KEYLESS)('sends %s to the default session and logs it as unauthenticated', async (_name, headers) => {
    const other = await server.createSession()
    const response = await chat(server.url, headers)
    expect(response.status).toBe(200)
    expect(response.headers.get(NO_AUTH_HEADER)).toBe('1')
    expect(await server.session().requests()).toMatchObject([{ kind: 'llm', status: 'completed', unauthenticated: true }])
    expect(await other.requests()).toEqual([])
    await other.delete()
  })

  test('sends a request with a session key to that session', async () => {
    const other = await server.createSession()
    const { apiKey, baseUrl } = await other.info()
    expect((await chat(server.url, { authorization: `Bearer ${apiKey}` })).status).toBe(200)
    expect((await chat(baseUrl, {})).status).toBe(200)
    const entries = await other.requests()
    expect(entries.map(entry => entry.unauthenticated)).toEqual([undefined, true])
    expect(await server.session().requests()).toEqual([])
    const defaultKey = (await server.session().info()).apiKey
    await chat(server.url, { 'x-api-key': defaultKey })
    expect((await server.session().requests())[0]!.unauthenticated).toBeUndefined()
    await other.delete()
  })

  test('still needs the admin token for the admin API', async () => {
    for (const headers of [{}, { authorization: 'Bearer ' }, { authorization: `Bearer ${(await server.session().info()).apiKey}` }]) {
      expect((await fetch(`${server.url}/_admin/status`, { headers })).status).toBe(401)
    }
    expect(await server.status()).toMatchObject({ noAuth: true })
  })

  test('streams', async () => {
    await server.session().when().reply(r => r.text('streamed without a key').stream({ chunkChars: 4 }))
    const openai = new OpenAI({ baseURL: `${server.url}/v1`, apiKey: UNKNOWN_KEY, maxRetries: 0 })
    const stream = openai.chat.completions.stream({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] })
    let chunks = 0
    stream.on('chunk', () => chunks++)
    expect((await stream.finalChatCompletion()).choices[0]!.message.content).toBe('streamed without a key')
    expect(chunks).toBeGreaterThan(2)
  })

  test('serves MCP', async () => {
    const weather = await server.session().addMcpServer('weather', [{ name: 'get_forecast', result: { text: 'Sunny' } }])
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(await weather.url())))
    expect(await client.callTool({ name: 'get_forecast', arguments: {} })).toMatchObject({ content: [{ type: 'text', text: 'Sunny' }] })
    expect(await weather.waitForToolCall('get_forecast')).toMatchObject({ unauthenticated: true })
    expect((await server.session().requests({ kind: 'mcp', mcpMethod: 'tools/list' })).every(entry => entry.unauthenticated)).toBe(true)
    await client.close()
  })

  test('writes VS Code configuration without an API key', async () => {
    const [group] = (await server.session().vscodeConfig()).chatLanguageModels as Record<string, unknown>[]
    expect(group).toMatchObject({ vendor: 'customendpoint', models: [{ url: `${server.url}/v1/chat/completions` }] })
    expect(group).not.toHaveProperty('apiKey')
  })
})

test.each(['0.0.0.0', '::', '192.0.2.1'])('refuses to start with no-auth on %s', async host => {
  await expect(startServer({ noAuth: true, host })).rejects.toThrow(/loopback/)
})

describe('agent-test-server start --no-auth', () => {
  const cliPath = join(import.meta.dirname, '../src/cli.ts')
  const dir = mkdtempSync(join(tmpdir(), 'agent-test-server-no-auth-'))
  const run = (...args: string[]) => promisify(execFile)(process.execPath, [cliPath, ...args, '--state', join(dir, 'server.json')])

  afterAll(async () => {
    await run('stop')
    rmSync(dir, { recursive: true, force: true })
  })

  test('refuses a host that is not loopback', async () => {
    await expect(run('start', '--no-auth', '--host', '0.0.0.0')).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('loopback') })
  })

  test('warns, reports noAuth, answers an empty bearer token, and writes VS Code configuration', async () => {
    const { stdout, stderr } = await run('start', '--no-auth')
    const started = JSON.parse(stdout) as { url: string; noAuth?: boolean }
    expect(started.noAuth).toBe(true)
    expect(stderr).toContain('warning: no-auth mode')
    expect(JSON.parse((await run('status')).stdout)).toMatchObject({ noAuth: true })

    expect((await chat(started.url, { authorization: 'Bearer ' })).status).toBe(200)
    expect(JSON.parse((await run('requests')).stdout)).toMatchObject([{ status: 'completed', unauthenticated: true }])

    const models = join(dir, 'chatLanguageModels.json')
    await run('config', 'vscode', '--write', models)
    const [group] = JSON.parse(readFileSync(models, 'utf8')) as Record<string, unknown>[]
    expect(group).toMatchObject({ vendor: 'customendpoint', models: [{ id: 'test-model', url: `${started.url}/v1/chat/completions` }] })
    expect(group).not.toHaveProperty('apiKey')
  })
})
