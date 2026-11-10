import { z } from 'zod'

/** The LLM wire protocols the server speaks. */
export const PROTOCOLS = ['chat', 'responses', 'messages'] as const
export const Protocol = z.enum(PROTOCOLS)
export type Protocol = z.infer<typeof Protocol>

/** A string matches when the text contains it; use `regex` or `equals` for other comparisons. */
export const TextMatch = z.union([
  z.string(),
  z.object({ regex: z.string(), flags: z.string().optional() }).strict(),
  z.object({ equals: z.string() }).strict(),
])
export type TextMatch = z.infer<typeof TextMatch>

/** Conditions on an LLM request. Every condition given must hold. */
export const Matcher = z.object({
  model: z.string().optional().describe('The requested model ID.'),
  protocol: Protocol.optional(),
  lastUserMessage: TextMatch.optional().describe('The request ends with a user message whose text matches.'),
  toolResult: z.string().optional().describe('The request ends with a result for this tool. Also matches a prefixed name ending in `_<name>`.'),
  hasTool: z.string().optional().describe('The request offers this tool. Also matches a prefixed name ending in `_<name>`.'),
  system: TextMatch.optional().describe('The system prompt or instructions match.'),
  nth: z.number().int().positive().optional().describe('The session\'s nth LLM request, counting from 1.'),
}).strict()
export type Matcher = z.infer<typeof Matcher>

export const ToolCall = z.object({
  name: z.string().min(1).describe('A tool name from the request, or the end of one: `get_forecast` matches `mcp_weather_get_forecast`.'),
  arguments: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
  id: z.string().optional(),
}).strict()

export const ReplyPart = z.union([
  z.object({ text: z.string() }).strict(),
  z.object({ toolCall: ToolCall }).strict(),
  z.object({ reasoning: z.string() }).strict(),
])
export type ReplyPart = z.infer<typeof ReplyPart>

export const StreamOptions = z.object({
  chunkChars: z.number().int().positive().optional().describe('Characters per text or argument delta. Defaults to 16.'),
  delayMs: z.number().nonnegative().optional().describe('Delay between SSE events.'),
  firstEventDelayMs: z.number().nonnegative().optional().describe('Delay before the first SSE event.'),
}).strict()

export const Failure = z.object({
  status: z.number().int().min(400).max(599),
  message: z.string().optional(),
  type: z.string().optional().describe('Error type in the body. Defaults to the protocol\'s usual type for the status.'),
  retryAfter: z.number().nonnegative().optional().describe('Seconds, sent as the Retry-After header.'),
}).strict()
export type Failure = z.infer<typeof Failure>

/** What the server sends back, encoded for whichever protocol the request used. */
export const Reply = z.object({
  parts: z.array(ReplyPart).default([]),
  stream: StreamOptions.optional(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
  }).strict().optional(),
  stopReason: z.enum(['stop', 'length', 'tool_calls']).optional().describe('Defaults to tool_calls when the reply calls a tool, otherwise stop.'),
  delayMs: z.number().nonnegative().optional().describe('Delay before the response starts.'),
  fail: Failure.optional().describe('Answer with an HTTP error instead.'),
  disconnectAfterEvents: z.number().int().nonnegative().optional().describe('Drop the connection after this many SSE events. Streaming requests only.'),
  hang: z.boolean().optional().describe('Never answer; the request stays open until the client gives up.'),
}).strict()
export type Reply = z.infer<typeof Reply>
export type ReplyInput = z.input<typeof Reply>

export const Rule = z.object({
  id: z.string().optional(),
  when: Matcher.default({}),
  times: z.number().int().positive().optional().describe('Match at most this many requests. Unlimited when omitted.'),
  fallback: z.boolean().optional().describe('Try this rule only after every other rule fails to match.'),
  hold: z.boolean().optional().describe('Hold matching requests until `respond` releases them.'),
  reply: Reply,
}).strict()
export type Rule = z.infer<typeof Rule>
export type RuleInput = z.input<typeof Rule>

export const ModelDef = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  protocol: Protocol.default('chat').describe('The protocol `config vscode` points VS Code at.'),
  toolCalling: z.boolean().default(true),
  vision: z.boolean().default(false),
  thinking: z.boolean().default(false),
  maxInputTokens: z.number().int().positive().default(128_000),
  maxOutputTokens: z.number().int().positive().default(16_000),
}).strict()
export type ModelDef = z.infer<typeof ModelDef>
export type ModelDefInput = z.input<typeof ModelDef>

export const McpToolResult = z.object({
  text: z.string().optional(),
  content: z.array(z.record(z.string(), z.unknown())).optional().describe('MCP content blocks. Overrides `text`.'),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
}).strict()
export type McpToolResult = z.infer<typeof McpToolResult>

export const McpTool = z.object({
  name: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional().describe('JSON Schema for the arguments. Defaults to any object.'),
  result: McpToolResult.optional().describe('Defaults to text describing the call.'),
  delayMs: z.number().nonnegative().optional(),
  manual: z.boolean().optional().describe('Hold each call until `respond` answers it.'),
}).strict()
export type McpTool = z.infer<typeof McpTool>
export type McpToolInput = z.input<typeof McpTool>

export const McpServerDef = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]+$/, 'Use letters, digits, _ and -.'),
  tools: z.array(McpTool).default([]),
}).strict()
export type McpServerDef = z.infer<typeof McpServerDef>
export type McpServerDefInput = z.input<typeof McpServerDef>

export const Unmatched = z.enum(['text', 'error', 'manual'])
export type Unmatched = z.infer<typeof Unmatched>

export const Scenario = z.object({
  $schema: z.string().optional(),
  models: z.array(ModelDef).optional(),
  rules: z.array(Rule).optional(),
  mcpServers: z.array(McpServerDef).optional(),
  unmatched: Unmatched.optional().describe('What to do with a request no rule matches: reply with explanatory text (default), fail with HTTP 500, or hold it for `respond`.'),
}).strict()
export type Scenario = z.infer<typeof Scenario>
export type ScenarioInput = z.input<typeof Scenario>

/** JSON Schema for scenario files. */
export function scenarioJsonSchema(): unknown {
  return z.toJSONSchema(Scenario, { io: 'input' })
}

export function matchText(match: TextMatch, text: string | undefined): boolean {
  if (text === undefined) return false
  if (typeof match === 'string') return text.includes(match)
  if ('equals' in match) return text === match.equals
  return new RegExp(match.regex, match.flags).test(text)
}

/** Whether a tool name equals `name` or ends with `_<name>`, the way clients prefix MCP tools. */
export function toolNameMatches(actual: string, name: string): boolean {
  return actual === name || actual.endsWith(`_${name}`)
}
