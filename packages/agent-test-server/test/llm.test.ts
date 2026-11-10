import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { startServer, type RunningServer, type SessionHandle, type SessionInfo } from '../src/index.ts'

let server: RunningServer
let session: SessionHandle
let info: SessionInfo
let openai: OpenAI
let anthropic: Anthropic

const weatherTool = { name: 'get_weather', description: 'Weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } } } }

beforeAll(async () => {
  server = await startServer()
})

afterAll(async () => {
  await server.close()
})

beforeEach(async () => {
  session = await server.createSession()
  info = await session.info()
  openai = new OpenAI({ baseURL: info.llmBaseUrl, apiKey: info.apiKey, maxRetries: 0 })
  anthropic = new Anthropic({ baseURL: info.baseUrl, apiKey: info.apiKey, maxRetries: 0 })
  return () => session.delete()
})

async function scriptWeather(): Promise<void> {
  await session.when({ lastUserMessage: 'weather' }).reply(r => r.reasoning('The user wants weather.').toolCall('get_weather', { city: 'Paris' }).stream({ chunkChars: 3 }))
  await session.when({ toolResult: 'get_weather' }).reply(r => r.text('It is sunny in Paris.').stream({ chunkChars: 4 }))
}

describe('Chat Completions', () => {
  test('streams a tool call and then text, which the official client assembles', async () => {
    await scriptWeather()
    const first = await openai.chat.completions.stream({
      model: 'test-model',
      messages: [{ role: 'user', content: 'What is the weather?' }],
      tools: [{ type: 'function', function: weatherTool }],
      stream_options: { include_usage: true },
    }).finalChatCompletion()
    const call = first.choices[0]!.message.tool_calls![0]!
    expect(first.choices[0]!.finish_reason).toBe('tool_calls')
    expect(call.type === 'function' && call.function).toEqual({ name: 'get_weather', arguments: '{"city":"Paris"}' })
    expect(first.usage?.total_tokens).toBeGreaterThan(0)

    const second = await openai.chat.completions.create({
      model: 'test-model',
      messages: [
        { role: 'user', content: 'What is the weather?' },
        { role: 'assistant', content: null, tool_calls: [call] },
        { role: 'tool', tool_call_id: call.id, content: 'sunny' },
      ],
      tools: [{ type: 'function', function: weatherTool }],
    })
    expect(second.choices[0]!.message.content).toBe('It is sunny in Paris.')

    const entry = await session.waitForRequest({ after: 1 })
    expect(entry.llm?.request.messages.at(-1)?.parts[0]).toMatchObject({ type: 'tool_result', name: 'get_weather', content: 'sunny' })
    expect(entry.headers.authorization).toBe(`Bearer ${info.apiKey}`)
  })

  test('resolves a short tool name to the prefixed name the client offered', async () => {
    await session.when().reply(r => r.toolCall('get_forecast', { city: 'Oslo' }))
    const result = await openai.chat.completions.create({
      model: 'test-model',
      messages: [{ role: 'user', content: 'forecast' }],
      tools: [{ type: 'function', function: { name: 'mcp_weather_get_forecast', parameters: { type: 'object' } } }],
    })
    const call = result.choices[0]!.message.tool_calls![0]!
    expect(call.type === 'function' && call.function.name).toBe('mcp_weather_get_forecast')
  })
})

describe('Responses', () => {
  test('streams reasoning and a function call, then chains with previous_response_id', async () => {
    await scriptWeather()
    const first = await openai.responses.stream({
      model: 'test-model',
      input: 'What is the weather?',
      tools: [{ type: 'function', ...weatherTool, strict: false }],
    }).finalResponse()
    expect(first.output.map(item => item.type)).toEqual(['reasoning', 'function_call'])
    const call = first.output[1]!
    expect(call.type === 'function_call' && call.arguments).toBe('{"city":"Paris"}')

    const second = await openai.responses.stream({
      model: 'test-model',
      previous_response_id: first.id,
      input: [{ type: 'function_call_output', call_id: call.type === 'function_call' ? call.call_id : '', output: 'sunny' }],
    }).finalResponse()
    expect(second.output_text).toBe('It is sunny in Paris.')

    const entry = await session.waitForRequest({ after: 1 })
    expect(entry.llm?.request.messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool'])
  })

  test('rejects an unknown previous_response_id like the real API', async () => {
    await expect(openai.responses.create({ model: 'test-model', input: 'hi', previous_response_id: 'resp_missing' })).rejects.toMatchObject({ status: 404 })
  })
})

describe('Messages', () => {
  test('streams thinking, text, and tool use, which the official client assembles', async () => {
    await session.when().reply(r => r.reasoning('Thinking it over.').text('Let me check.').toolCall('get_weather', { city: 'Paris' }).stream({ chunkChars: 5 }))
    const message = await anthropic.messages.stream({
      model: 'test-model',
      max_tokens: 1000,
      system: 'You are a test.',
      messages: [{ role: 'user', content: 'What is the weather?' }],
      tools: [{ name: 'get_weather', input_schema: { type: 'object' } }],
    }).finalMessage()
    expect(message.content.map(block => block.type)).toEqual(['thinking', 'text', 'tool_use'])
    expect(message.content[2]).toMatchObject({ type: 'tool_use', name: 'get_weather', input: { city: 'Paris' } })
    expect(message.stop_reason).toBe('tool_use')
    const entry = await session.waitForRequest()
    expect(entry.headers['anthropic-version']).toBeTruthy()
    expect(entry.llm?.request.system).toBe('You are a test.')
  })

  test('accepts the key in x-api-key, as VS Code sends it for the Messages API', async () => {
    await session.when().reply('ok')
    const response = await fetch(`${info.llmBaseUrl}/messages`, {
      method: 'POST',
      headers: { 'x-api-key': info.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(await response.json()).toMatchObject({ content: [{ type: 'text', text: 'ok' }] })
  })

  test('answers errors in the Anthropic error shape', async () => {
    await session.when().fail(529)
    await expect(anthropic.messages.create({ model: 'test-model', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toMatchObject({ status: 529, error: { type: 'error', error: { type: 'overloaded_error' } } })
  })
})

describe('faults and control', () => {
  test('fails with Retry-After, once', async () => {
    await session.when().once().fail(429, { retryAfter: 2 })
    await session.otherwise().reply('ok')
    const error = await openai.chat.completions.create({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }).catch(e => e)
    expect(error).toMatchObject({ status: 429 })
    expect(error.headers.get('retry-after')).toBe('2')
    const retry = await openai.chat.completions.create({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] })
    expect(retry.choices[0]!.message.content).toBe('ok')
  })

  test('drops the connection mid-stream and records it', async () => {
    await session.when().reply(r => r.text('a long answer that never finishes').stream({ chunkChars: 2 }).disconnectAfter(3))
    await expect(openai.chat.completions.stream({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }).finalChatCompletion()).rejects.toThrow()
    const entry = await session.waitForRequest({ status: 'failed' })
    expect(entry.response?.eventsSent).toBe(3)
  })

  test('holds a request until the test responds', async () => {
    await session.when().hold().reply('held reply')
    const pending = openai.chat.completions.create({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] })
    const entry = await session.waitForPending()
    await session.respond(entry.id)
    expect((await pending).choices[0]!.message.content).toBe('held reply')
  })

  test('lets the tester act as the model in manual mode', async () => {
    await session.setUnmatched('manual')
    const pending = anthropic.messages.create({ model: 'test-model', max_tokens: 10, messages: [{ role: 'user', content: 'ping' }] })
    const entry = await session.waitForPending({ lastUserMessage: 'ping' })
    await session.respond(entry.id, r => r.text('pong'))
    expect((await pending).content).toEqual([{ type: 'text', text: 'pong' }])
  })

  test('records a client cancelling a stream', async () => {
    await session.when().reply(r => r.text('slow text').stream({ chunkChars: 1, delayMs: 50 }))
    const abort = new AbortController()
    const stream = await openai.chat.completions.create({ model: 'test-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }, { signal: abort.signal })
    for await (const _chunk of stream) {
      abort.abort()
      break
    }
    const entry = await session.waitForRequest({ status: 'aborted' })
    expect(entry.notes.join(' ')).toMatch(/disconnected after \d+ of \d+ SSE events/)
  })

  test('finds requests that arrived before the wait started', async () => {
    await session.when().reply('one')
    await openai.chat.completions.create({ model: 'test-model', messages: [{ role: 'user', content: 'first' }] })
    expect((await session.waitForRequest()).llm?.request.messages[0]?.parts[0]).toEqual({ type: 'text', text: 'first' })
    await openai.chat.completions.create({ model: 'test-model', messages: [{ role: 'user', content: 'second' }] })
    expect((await session.waitForRequest()).seq).toBe(2)
  })

  test('rejects the wrong API key and keeps sessions apart', async () => {
    const other = new OpenAI({ baseURL: info.llmBaseUrl, apiKey: 'wrong', maxRetries: 0 })
    await expect(other.chat.completions.create({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({ status: 401 })
    const defaults = await server.session().info()
    expect(defaults.apiKey).not.toBe(info.apiKey)
    expect(await server.session().requests()).toEqual([])
  })

  test('lists models for both clients and serves built-in models', async () => {
    await session.setModels([{ id: 'my-model', protocol: 'responses', vision: true }])
    expect((await openai.models.list()).data.map(model => model.id)).toContain('my-model')
    expect((await anthropic.models.list()).data.map(model => model.id)).toContain('echo')
    const echo = await openai.chat.completions.create({ model: 'echo', messages: [{ role: 'user', content: 'repeat me' }] })
    expect(echo.choices[0]!.message.content).toBe('repeat me')
    await expect(openai.chat.completions.create({ model: 'fail-429', messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({ status: 429 })
  })

  test('explains unmatched requests in the reply', async () => {
    const reply = await openai.chat.completions.create({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] })
    expect(reply.choices[0]!.message.content).toContain('No rule matched')
  })

  test('writes VS Code configuration for the Custom Endpoint provider', async () => {
    await session.setModels([{ id: 'm1', protocol: 'messages' }])
    await session.addMcpServer('weather')
    const config = await session.vscodeConfig()
    expect(config.chatLanguageModels).toEqual([expect.objectContaining({
      vendor: 'customendpoint',
      apiKey: info.apiKey,
      models: [expect.objectContaining({ id: 'm1', apiType: 'messages', url: `${info.llmBaseUrl}/messages` })],
    })])
    expect(config.mcp.servers.weather).toEqual({ type: 'http', url: `${info.baseUrl}/mcp/weather` })
  })
})
