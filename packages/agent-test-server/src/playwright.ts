import type { Fixtures } from '@playwright/test'
import { startServer, type RunningServer, type SessionHandle } from './client.ts'
import type { ServerOptions } from './server.ts'

export interface AgentTestServerFixtures {
  /** A fresh session for each test, deleted afterwards, so tests never see each other's rules or requests. */
  agentSession: SessionHandle
}

export interface AgentTestServerWorkerFixtures {
  /** One server per worker. */
  agentTestServer: RunningServer
  agentTestServerOptions: ServerOptions
}

/**
 * Fixtures for `@playwright/test`:
 *
 * ```ts
 * import { test as base } from '@playwright/test'
 * import { agentTestServerFixtures, type AgentTestServerFixtures, type AgentTestServerWorkerFixtures } from '@rwoll/agent-test-server/playwright'
 *
 * export const test = base.extend<AgentTestServerFixtures, AgentTestServerWorkerFixtures>(agentTestServerFixtures)
 * ```
 */
export const agentTestServerFixtures: Fixtures<AgentTestServerFixtures, AgentTestServerWorkerFixtures> = {
  agentTestServerOptions: [{}, { scope: 'worker', option: true }],
  agentTestServer: [async ({ agentTestServerOptions }, use) => {
    const server = await startServer(agentTestServerOptions)
    await use(server)
    await server.close()
  }, { scope: 'worker' }],
  agentSession: async ({ agentTestServer }, use) => {
    const session = await agentTestServer.createSession()
    await use(session)
    await session.delete()
  },
}
