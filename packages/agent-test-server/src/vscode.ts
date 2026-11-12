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
 *
 * Leave `apiKey` undefined for a server in no-auth mode. VS Code treats the file's `apiKey` as a
 * reference into its secret storage, never as the key itself, so a key written here is not sent
 * unless it was also entered in VS Code. Without one, VS Code sends an empty key.
 */
export function vscodeLanguageModels(llmBaseUrl: string, apiKey: string | undefined, models: ModelDef[], options: VscodeConfigOptions = {}): unknown[] {
  return [{
    name: options.name ?? 'Agent Test Server',
    vendor: 'customendpoint',
    ...(apiKey === undefined ? {} : { apiKey }),
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
