import type { Protocol } from './scenario.ts'

/** One piece of a message, the same whichever protocol carried it. */
export type Part =
  | { type: 'text'; text: string }
  | { type: 'image'; url?: string; mediaType?: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'tool_result'; toolCallId: string; name?: string; content: string; isError?: boolean }
  | { type: 'reasoning'; text: string }

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  parts: Part[]
}

export interface Tool {
  name: string
  description?: string
  parameters?: unknown
}

/** An LLM request in a protocol-neutral shape. `raw` on the log entry keeps the original body. */
export interface LlmRequest {
  protocol: Protocol
  model: string
  stream: boolean
  system?: string
  messages: Message[]
  tools: Tool[]
  toolChoice?: unknown
  maxTokens?: number
  previousResponseId?: string
  /** Chat Completions: whether the client asked for usage in the final chunk. */
  includeUsage?: boolean
}

export class RequestError extends Error {
  readonly status: number
  readonly code: string
  constructor(message: string, code = 'invalid_request', status = 400) {
    super(message)
    this.status = status
    this.code = code
  }
}

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const num = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined)
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/**
 * Parses a request body. `history` returns the conversation stored for a Responses
 * `previous_response_id`, which is prepended to the new input.
 */
export function normalize(protocol: Protocol, body: unknown, history?: (id: string) => Message[] | undefined): LlmRequest {
  if (!isObject(body)) throw new RequestError('The request body must be a JSON object.')
  const model = str(body.model)
  if (!model) throw new RequestError('`model` is required.')
  const request = protocol === 'chat' ? fromChat(body) : protocol === 'responses' ? fromResponses(body, history) : fromMessages(body)
  nameToolResults(request.messages)
  return { protocol, model, stream: body.stream === true, ...request }
}

function fromChat(body: Json): Omit<LlmRequest, 'protocol' | 'model' | 'stream'> {
  const system: string[] = []
  const messages: Message[] = []
  for (const raw of arr(body.messages)) {
    if (!isObject(raw)) continue
    const role = str(raw.role)
    if (role === 'system' || role === 'developer') {
      const text = textOf(raw.content)
      system.push(text)
      messages.push({ role: 'system', parts: [{ type: 'text', text }] })
    } else if (role === 'tool') {
      messages.push({ role: 'tool', parts: [{ type: 'tool_result', toolCallId: str(raw.tool_call_id) ?? '', content: textOf(raw.content) }] })
    } else if (role === 'user' || role === 'assistant') {
      const parts = chatParts(raw.content)
      for (const call of arr(raw.tool_calls)) {
        if (!isObject(call) || !isObject(call.function)) continue
        parts.push({ type: 'tool_call', id: str(call.id) ?? '', name: str(call.function.name) ?? '', arguments: str(call.function.arguments) ?? '' })
      }
      const reasoning = str(raw.reasoning_content) ?? str(raw.reasoning)
      if (reasoning) parts.unshift({ type: 'reasoning', text: reasoning })
      messages.push({ role, parts })
    }
  }
  const tools = arr(body.tools).flatMap(tool => (isObject(tool) && isObject(tool.function) ? [functionTool(tool.function)] : []))
  const options = isObject(body.stream_options) ? body.stream_options : {}
  return {
    system: system.length ? system.join('\n\n') : undefined,
    messages,
    tools,
    toolChoice: body.tool_choice,
    maxTokens: num(body.max_completion_tokens) ?? num(body.max_tokens),
    includeUsage: options.include_usage === true,
  }
}

function chatParts(content: unknown): Part[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  return arr(content).flatMap((part): Part[] => {
    if (!isObject(part)) return []
    if (part.type === 'text') return [{ type: 'text', text: str(part.text) ?? '' }]
    if (part.type === 'image_url') return [{ type: 'image', url: isObject(part.image_url) ? str(part.image_url.url) : undefined }]
    return []
  })
}

function fromResponses(body: Json, history?: (id: string) => Message[] | undefined): Omit<LlmRequest, 'protocol' | 'model' | 'stream'> {
  const previousResponseId = str(body.previous_response_id)
  const messages: Message[] = []
  if (previousResponseId) {
    const previous = history?.(previousResponseId)
    if (!previous) throw new RequestError(`Previous response with id '${previousResponseId}' not found.`, 'previous_response_not_found', 404)
    messages.push(...structuredClone(previous))
  }
  const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : arr(body.input)
  for (const item of input) {
    if (!isObject(item)) continue
    const type = str(item.type) ?? 'message'
    if (type === 'message') {
      const role = str(item.role)
      const parts = responsesParts(item.content)
      if (role === 'system' || role === 'developer') messages.push({ role: 'system', parts })
      else if (role === 'user' || role === 'assistant') messages.push({ role, parts })
    } else if (type === 'function_call') {
      append(messages, 'assistant', { type: 'tool_call', id: str(item.call_id) ?? '', name: str(item.name) ?? '', arguments: str(item.arguments) ?? '' })
    } else if (type === 'function_call_output') {
      messages.push({ role: 'tool', parts: [{ type: 'tool_result', toolCallId: str(item.call_id) ?? '', content: textOf(item.output) }] })
    } else if (type === 'reasoning') {
      const text = arr(item.summary).map(part => (isObject(part) ? str(part.text) ?? '' : '')).join('\n')
      append(messages, 'assistant', { type: 'reasoning', text })
    }
  }
  const tools = arr(body.tools).flatMap(tool => (isObject(tool) && tool.type === 'function' ? [functionTool(tool)] : []))
  const instructions = str(body.instructions)
  const systemMessages = messages.filter(message => message.role === 'system').map(message => textOfParts(message.parts))
  const system = [instructions, ...systemMessages].filter((text): text is string => !!text)
  return {
    system: system.length ? system.join('\n\n') : undefined,
    messages,
    tools,
    toolChoice: body.tool_choice,
    maxTokens: num(body.max_output_tokens),
    previousResponseId,
  }
}

function responsesParts(content: unknown): Part[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return arr(content).flatMap((part): Part[] => {
    if (!isObject(part)) return []
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') return [{ type: 'text', text: str(part.text) ?? '' }]
    if (part.type === 'input_image') return [{ type: 'image', url: str(part.image_url) }]
    return []
  })
}

function fromMessages(body: Json): Omit<LlmRequest, 'protocol' | 'model' | 'stream'> {
  const system = typeof body.system === 'string' ? body.system : arr(body.system).map(block => (isObject(block) ? str(block.text) ?? '' : '')).join('\n\n')
  const messages: Message[] = []
  for (const raw of arr(body.messages)) {
    if (!isObject(raw)) continue
    const role = str(raw.role)
    if (role !== 'user' && role !== 'assistant') continue
    const blocks = typeof raw.content === 'string' ? [{ type: 'text', text: raw.content }] : arr(raw.content)
    const parts = blocks.flatMap((block): Part[] => {
      if (!isObject(block)) return []
      switch (block.type) {
        case 'text': return [{ type: 'text', text: str(block.text) ?? '' }]
        case 'image': return [{ type: 'image', mediaType: isObject(block.source) ? str(block.source.media_type) : undefined, url: isObject(block.source) ? str(block.source.url) : undefined }]
        case 'tool_use': return [{ type: 'tool_call', id: str(block.id) ?? '', name: str(block.name) ?? '', arguments: JSON.stringify(block.input ?? {}) }]
        case 'tool_result': return [{ type: 'tool_result', toolCallId: str(block.tool_use_id) ?? '', content: textOf(block.content), isError: block.is_error === true ? true : undefined }]
        case 'thinking': return [{ type: 'reasoning', text: str(block.thinking) ?? '' }]
        default: return []
      }
    })
    messages.push({ role, parts })
  }
  const tools = arr(body.tools).flatMap(tool => (isObject(tool) && str(tool.name) ? [{ name: str(tool.name)!, description: str(tool.description), parameters: tool.input_schema }] : []))
  return { system: system || undefined, messages, tools, toolChoice: body.tool_choice, maxTokens: num(body.max_tokens) }
}

function functionTool(fn: Json): Tool {
  return { name: str(fn.name) ?? '', description: str(fn.description), parameters: fn.parameters }
}

function append(messages: Message[], role: 'assistant', part: Part): void {
  const last = messages.at(-1)
  if (last?.role === role) last.parts.push(part)
  else messages.push({ role, parts: [part] })
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (isObject(content)) return str(content.text) ?? JSON.stringify(content)
  return arr(content).map(part => (typeof part === 'string' ? part : isObject(part) ? str(part.text) ?? '' : '')).join('')
}

function textOfParts(parts: Part[]): string {
  return parts.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('')
}

/** Fills in each tool result's tool name from the call it answers. */
function nameToolResults(messages: Message[]): void {
  const names = new Map<string, string>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'tool_call') names.set(part.id, part.name)
      else if (part.type === 'tool_result' && !part.name) part.name = names.get(part.toolCallId)
    }
  }
}

/** The text of the final message when it is a user message, not a tool result. */
export function lastUserText(request: LlmRequest): string | undefined {
  const last = request.messages.at(-1)
  if (last?.role !== 'user' || last.parts.some(part => part.type === 'tool_result')) return undefined
  return textOfParts(last.parts)
}

/** The tool results at the end of the request, after the last assistant message. */
export function trailingToolResults(request: LlmRequest): Extract<Part, { type: 'tool_result' }>[] {
  const results: Extract<Part, { type: 'tool_result' }>[] = []
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const message = request.messages[i]!
    if (message.role === 'assistant') break
    const found = message.parts.filter((part): part is Extract<Part, { type: 'tool_result' }> => part.type === 'tool_result')
    if (!found.length) break
    results.unshift(...found)
  }
  return results
}

/** A rough token count: about four characters per token. */
export function estimateTokens(value: unknown): number {
  return Math.max(1, Math.ceil(JSON.stringify(value ?? '').length / 4))
}
