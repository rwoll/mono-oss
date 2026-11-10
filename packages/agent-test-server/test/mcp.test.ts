import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { startServer, type RunningServer, type SessionHandle } from '../src/index.ts'

let server: RunningServer
let session: SessionHandle

beforeAll(async () => {
  server = await startServer()
})

afterAll(async () => {
  await server.close()
})

beforeEach(async () => {
  session = await server.createSession()
  return () => session.delete()
})

async function connect(url: string, era: 'modern' | 'legacy'): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)), era === 'legacy' ? { prior: { kind: 'legacy' } } : undefined)
  return client
}

describe.each(['modern', 'legacy'] as const)('MCP over Streamable HTTP (%s handshake)', era => {
  test('lists and calls declared tools, and logs the calls', async () => {
    const weather = await session.addMcpServer('weather', [{
      name: 'get_forecast',
      description: 'Forecast for a city',
      inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      result: { text: 'Sunny', structuredContent: { sky: 'clear' } },
    }])
    const client = await connect(await weather.url(), era)
    const tools = await client.listTools()
    expect(tools.tools.map(tool => tool.name)).toEqual(['get_forecast'])
    const result = await client.callTool({ name: 'get_forecast', arguments: { city: 'Paris' } })
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'Sunny' }], structuredContent: { sky: 'clear' } })
    const call = await weather.waitForToolCall('get_forecast')
    expect(call.mcp).toMatchObject({ server: 'weather', method: 'tools/call', tool: 'get_forecast', arguments: { city: 'Paris' } })
    expect((await session.requests({ kind: 'mcp', mcpMethod: 'tools/list' })).length).toBeGreaterThan(0)
    await client.close()
  })

  test('holds a manual tool call until the tester answers it', async () => {
    const weather = await session.addMcpServer('weather', [{ name: 'book', manual: true }])
    const client = await connect(await weather.url(), era)
    const pending = client.callTool({ name: 'book', arguments: { day: 'Monday' } })
    const call = await session.waitForPending({ kind: 'mcp' })
    await session.respondMcp(call.id, { text: 'Booked', isError: true })
    expect(await pending).toMatchObject({ content: [{ type: 'text', text: 'Booked' }], isError: true })
    await client.close()
  })
})

test('serves tools added after the server was created', async () => {
  const weather = await session.addMcpServer('weather')
  await weather.tool({ name: 'late_tool' })
  const client = await connect(await weather.url(), 'modern')
  expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['late_tool'])
  expect(await client.callTool({ name: 'late_tool', arguments: {} })).toMatchObject({ content: [{ type: 'text', text: 'late_tool called with {}' }] })
  await client.close()
})
