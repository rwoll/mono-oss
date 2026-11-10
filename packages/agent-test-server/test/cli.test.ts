import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, test } from 'vitest'

const cliPath = join(import.meta.dirname, '../src/cli.ts')
const dir = mkdtempSync(join(tmpdir(), 'agent-test-server-'))
const state = join(dir, 'server.json')
let server: { url: string; session: { apiKey: string; llmBaseUrl: string } }

async function cli<T = unknown>(...args: string[]): Promise<T> {
  const { stdout } = await promisify(execFile)(process.execPath, [cliPath, ...args, '--state', state])
  return JSON.parse(stdout) as T
}

interface ChatCompletion {
  choices: { message: { content: string | null; tool_calls: { function: unknown }[] } }[]
}

async function cliFails(...args: string[]): Promise<{ code: number; stderr: string }> {
  return promisify(execFile)(process.execPath, [cliPath, ...args, '--state', state]).then(
    () => ({ code: 0, stderr: '' }),
    (error: { code: number; stderr: string }) => ({ code: error.code, stderr: error.stderr }),
  )
}

function chat(content: string, model = 'test-model'): Promise<ChatCompletion> {
  return fetch(`${server.session.llmBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${server.session.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }] }),
  }).then(response => response.json() as Promise<ChatCompletion>)
}

beforeAll(async () => {
  server = await cli('start')
})

afterAll(async () => {
  await cli('stop')
  rmSync(dir, { recursive: true, force: true })
})

test('scripts replies and waits for requests', async () => {
  await cli('reply', 'hello there', '--when-user', 'hi', '--once')
  await cli('requests', 'mark')
  expect((await chat('hi')).choices[0]!.message.content).toBe('hello there')
  const entry = await cli('requests', 'wait')
  expect(entry).toMatchObject({ kind: 'llm', status: 'completed', lastUserMessage: 'hi', response: { text: 'hello there' } })
  expect(await cliFails('requests', 'wait', '--timeout', '1')).toMatchObject({ code: 3 })
})

test('lets an agent play the model', async () => {
  await cli('unmatched', 'manual')
  const pending = chat('ping')
  const entry = await cli<{ id: string }>('requests', 'wait', '--pending')
  await cli('respond', entry.id, '--tool-call', 'lookup', '--args', '{"q":"ping"}')
  expect((await pending).choices[0]!.message.tool_calls[0]!.function).toEqual({ name: 'lookup', arguments: '{"q":"ping"}' })
  await cli('unmatched', 'text')
})

test('adds MCP tools and writes VS Code configuration', async () => {
  await cli('mcp', 'add', 'weather')
  const mcp = await cli<{ tools: unknown[] }>('mcp', 'tool', 'weather', 'get_forecast', '--text', 'Sunny', '--schema', '{"type":"object","properties":{"city":{"type":"string"}}}')
  expect(mcp.tools).toEqual([expect.objectContaining({ name: 'get_forecast', result: { text: 'Sunny' } })])
  const models = join(dir, 'chatLanguageModels.json')
  await cli('models', 'm1', '--protocol', 'responses', '--vision')
  await cli('config', 'vscode', '--write', models, '--write-mcp', join(dir, 'mcp.json'))
  expect(JSON.parse(readFileSync(models, 'utf8'))[0].models[0] as unknown).toMatchObject({ id: 'm1', apiType: 'responses', vision: true })
  expect(JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')).servers.weather.url).toBe(`${server.url}/mcp/weather`)
})

test('reports usage errors with exit code 2', async () => {
  expect(await cliFails('reply', '--nope')).toMatchObject({ code: 2 })
  expect(await cliFails('fail', '--status', 'abc')).toMatchObject({ code: 2 })
})
