import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { approveAll, CopilotClient, defineTool, RuntimeConnection, type ProviderConfig } from '@github/copilot-sdk'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { startServer, type RunningServer, type SessionHandle, type SessionInfo } from '../src/index.ts'

// The Copilot SDK needs a Copilot runtime: its per-platform package, which this workspace doesn't
// install, or the Copilot CLI at COPILOT_CLI_PATH. Without one, these tests are skipped.
const cliPath = process.env.COPILOT_CLI_PATH

let server: RunningServer
let session: SessionHandle
let info: SessionInfo
let client: CopilotClient
let home: string

beforeAll(async () => {
  if (!cliPath) return
  server = await startServer()
  home = mkdtempSync(join(tmpdir(), 'agent-test-server-copilot-'))
  client = new CopilotClient({ connection: RuntimeConnection.forStdio({ path: cliPath }), useLoggedInUser: false, baseDirectory: home })
})

afterAll(async () => {
  if (!cliPath) return
  await client.stop()
  await server.close()
  rmSync(home, { recursive: true, force: true })
})

beforeEach(async () => {
  if (!cliPath) return
  session = await server.createSession()
  info = await session.info()
  return () => session.delete()
})

const providers: [string, (info: SessionInfo) => ProviderConfig, string][] = [
  ['Chat Completions', info => ({ type: 'openai', wireApi: 'completions', baseUrl: info.llmBaseUrl, apiKey: info.apiKey }), 'chat'],
  ['Responses', info => ({ type: 'openai', wireApi: 'responses', baseUrl: info.llmBaseUrl, apiKey: info.apiKey }), 'responses'],
  ['Messages', info => ({ type: 'anthropic', baseUrl: info.baseUrl, apiKey: info.apiKey }), 'messages'],
]

describe.skipIf(!cliPath)('Copilot SDK', () => {
  describe.each(providers)('%s provider', (_name, provider, protocol) => {
    test.each([false, true])('calls a tool and answers (streaming: %s)', async streaming => {
      await session.when({ lastUserMessage: 'weather' }).reply(r => r.reasoning('They want the forecast.').toolCall('get_forecast', { city: 'Paris' }).stream({ chunkChars: 3 }))
      await session.when({ toolResult: 'get_forecast' }).reply(r => r.text('It is sunny in Paris.').stream({ chunkChars: 4 }))
      const calls: unknown[] = []
      const copilot = await client.createSession({
        model: 'test-model',
        provider: provider(info),
        streaming,
        onPermissionRequest: approveAll,
        tools: [defineTool('get_forecast', {
          description: 'Forecast for a city',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          handler: args => {
            calls.push(args)
            return 'sunny'
          },
        })],
      })
      try {
        const reply = await copilot.sendAndWait({ prompt: 'What is the weather in Paris?' }, 60_000)
        expect(reply?.data.content).toBe('It is sunny in Paris.')
        expect(calls).toEqual([{ city: 'Paris' }])
      } finally {
        await copilot.disconnect()
      }
      const requests = await session.requests({ kind: 'llm' })
      expect(requests.map(entry => [entry.llm?.protocol, entry.status])).toEqual([[protocol, 'completed'], [protocol, 'completed']])
      if (streaming) expect(requests.every(entry => entry.llm?.request.stream)).toBe(true)
      expect(requests[0]!.llm?.request.tools.some(tool => tool.name === 'get_forecast')).toBe(true)
      expect(requests[1]!.llm?.request.messages.at(-1)?.parts).toContainEqual(expect.objectContaining({ type: 'tool_result', name: 'get_forecast', content: 'sunny' }))
    }, 90_000)
  })

  test('surfaces a scripted failure as a session error', async () => {
    await session.when().fail(400, { message: 'Scripted failure.' })
    const copilot = await client.createSession({ model: 'test-model', provider: providers[0]![1](info), onPermissionRequest: approveAll })
    try {
      await expect(copilot.sendAndWait({ prompt: 'hi' }, 60_000)).rejects.toThrow(/Scripted failure/)
    } finally {
      await copilot.disconnect()
    }
  }, 90_000)
})
