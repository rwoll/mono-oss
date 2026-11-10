import type { ModelDef, Protocol } from './scenario.ts'

const API_TYPE: Record<Protocol, string> = { chat: 'chat-completions', responses: 'responses', messages: 'messages' }
const API_PATH: Record<Protocol, string> = { chat: '/chat/completions', responses: '/responses', messages: '/messages' }

export interface VscodeConfigOptions {
  /** Point every model at this protocol instead of each model's own. */
  protocol?: Protocol
  /** The provider group's name in the model picker. Defaults to "Agent Test Server". */
  name?: string
}

/**
 * Provider groups for VS Code's `chatLanguageModels.json`, using the built-in Copilot
 * extension's Custom Endpoint (`customendpoint`) BYOK provider.
 */
export function vscodeLanguageModels(llmBaseUrl: string, apiKey: string, models: ModelDef[], options: VscodeConfigOptions = {}): unknown[] {
  return [{
    name: options.name ?? 'Agent Test Server',
    vendor: 'customendpoint',
    apiKey,
    models: models.map(model => {
      const protocol = options.protocol ?? model.protocol
      return {
        id: model.id,
        name: model.name ?? model.id,
        url: `${llmBaseUrl}${API_PATH[protocol]}`,
        apiType: API_TYPE[protocol],
        toolCalling: model.toolCalling,
        vision: model.vision,
        thinking: model.thinking,
        maxInputTokens: model.maxInputTokens,
        maxOutputTokens: model.maxOutputTokens,
      }
    }),
  }]
}

/** The `servers` entries for VS Code's `mcp.json`. */
export function vscodeMcpServers(servers: { name: string; url: string }[]): { servers: Record<string, { type: 'http'; url: string }> } {
  return { servers: Object.fromEntries(servers.map(server => [server.name, { type: 'http' as const, url: server.url }])) }
}
