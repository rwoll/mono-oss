import { randomBytes } from 'node:crypto'
import { estimateTokens, type LlmRequest, type Message } from './normalize.ts'
import type { Failure, Protocol, Reply } from './scenario.ts'
import { toolNameMatches } from './scenario.ts'

/** A reply resolved against one request: tool names matched, IDs assigned, usage counted. */
export interface Plan {
  id: string
  model: string
  created: number
  items: PlanItem[]
  stopReason: 'stop' | 'length' | 'tool_calls'
  usage: { input: number; output: number }
  chunkChars: number
}

export type PlanItem =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }

const ID_PREFIX: Record<Protocol, string> = { chat: 'chatcmpl-', responses: 'resp_', messages: 'msg_' }

export function newId(prefix: string): string {
  return prefix + randomBytes(12).toString('hex')
}

export function plan(request: LlmRequest, reply: Reply, body: unknown): Plan {
  const items = reply.parts.map((part): PlanItem => {
    if ('text' in part) return { type: 'text', text: part.text }
    if ('reasoning' in part) return { type: 'reasoning', text: part.reasoning }
    const { name, arguments: args, id } = part.toolCall
    const matches = request.tools.filter(tool => toolNameMatches(tool.name, name))
    const exact = matches.find(tool => tool.name === name)
    return {
      type: 'tool_call',
      id: id ?? newId(request.protocol === 'messages' ? 'toolu_' : 'call_'),
      name: exact?.name ?? (matches.length === 1 ? matches[0]!.name : name),
      arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
    }
  })
  const output = items.map(item => ('text' in item ? item.text : item.arguments)).join('')
  return {
    id: newId(ID_PREFIX[request.protocol]),
    model: request.model,
    created: Math.floor(Date.now() / 1000),
    items,
    stopReason: reply.stopReason ?? (items.some(item => item.type === 'tool_call') ? 'tool_calls' : 'stop'),
    usage: {
      input: reply.usage?.inputTokens ?? estimateTokens(body),
      output: reply.usage?.outputTokens ?? estimateTokens(output),
    },
    chunkChars: reply.stream?.chunkChars ?? 16,
  }
}

/** The assistant message a plan adds to the conversation, for Responses chaining. */
export function planMessage(plan: Plan): Message {
  return {
    role: 'assistant',
    parts: plan.items.map(item => (item.type === 'tool_call' ? { type: 'tool_call', id: item.id, name: item.name, arguments: item.arguments } : item)),
  }
}

function chunks(text: string, size: number): string[] {
  if (!text) return []
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

function sse(data: unknown, event?: string): string {
  return `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`
}

export function encodeJson(protocol: Protocol, p: Plan, request: LlmRequest): unknown {
  if (protocol === 'chat') return chatJson(p)
  if (protocol === 'responses') return responseObject(p, request, p.stopReason === 'length' ? 'incomplete' : 'completed', p.items.map((item, i) => responsesItem(p, item, i)))
  return messagesJson(p)
}

/** The SSE events for a streamed reply, each one already framed. */
export function encodeEvents(protocol: Protocol, p: Plan, request: LlmRequest): string[] {
  if (protocol === 'chat') return chatEvents(p, request)
  if (protocol === 'responses') return responsesEvents(p, request)
  return messagesEvents(p)
}

// Chat Completions

const CHAT_FINISH = { stop: 'stop', length: 'length', tool_calls: 'tool_calls' } as const

function chatToolCalls(p: Plan) {
  return p.items.flatMap(item => (item.type === 'tool_call' ? [{ id: item.id, type: 'function', function: { name: item.name, arguments: item.arguments } }] : []))
}

function chatUsage(p: Plan) {
  return { prompt_tokens: p.usage.input, completion_tokens: p.usage.output, total_tokens: p.usage.input + p.usage.output }
}

function chatJson(p: Plan): unknown {
  const text = p.items.flatMap(item => (item.type === 'text' ? [item.text] : [])).join('')
  const toolCalls = chatToolCalls(p)
  return {
    id: p.id,
    object: 'chat.completion',
    created: p.created,
    model: p.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text || null, refusal: null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      logprobs: null,
      finish_reason: CHAT_FINISH[p.stopReason],
    }],
    usage: chatUsage(p),
  }
}

function chatEvents(p: Plan, request: LlmRequest): string[] {
  const chunk = (delta: unknown, finish: string | null = null) => sse({
    id: p.id, object: 'chat.completion.chunk', created: p.created, model: p.model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
  })
  const events = [chunk({ role: 'assistant', content: '' })]
  let toolIndex = 0
  for (const item of p.items) {
    // Chat Completions has no standard reasoning field, so reasoning parts are left out.
    if (item.type === 'text') for (const piece of chunks(item.text, p.chunkChars)) events.push(chunk({ content: piece }))
    if (item.type === 'tool_call') {
      const index = toolIndex++
      events.push(chunk({ tool_calls: [{ index, id: item.id, type: 'function', function: { name: item.name, arguments: '' } }] }))
      for (const piece of chunks(item.arguments, p.chunkChars)) events.push(chunk({ tool_calls: [{ index, function: { arguments: piece } }] }))
    }
  }
  events.push(chunk({}, CHAT_FINISH[p.stopReason]))
  if (request.includeUsage) events.push(sse({ id: p.id, object: 'chat.completion.chunk', created: p.created, model: p.model, choices: [], usage: chatUsage(p) }))
  events.push(sse('[DONE]'))
  return events
}

// Responses

function itemId(p: Plan, item: PlanItem, index: number): string {
  const prefix = item.type === 'text' ? 'msg_' : item.type === 'reasoning' ? 'rs_' : 'fc_'
  return `${prefix}${p.id.slice('resp_'.length)}_${index}`
}

function responsesItem(p: Plan, item: PlanItem, index: number): Record<string, unknown> {
  const id = itemId(p, item, index)
  if (item.type === 'text') return { id, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: item.text, annotations: [], logprobs: [] }] }
  if (item.type === 'reasoning') return { id, type: 'reasoning', summary: [{ type: 'summary_text', text: item.text }] }
  return { id, type: 'function_call', status: 'completed', call_id: item.id, name: item.name, arguments: item.arguments }
}

function responseObject(p: Plan, request: LlmRequest, status: string, output: unknown[]): Record<string, unknown> {
  const done = status !== 'in_progress'
  return {
    id: p.id,
    object: 'response',
    created_at: p.created,
    status,
    model: p.model,
    output,
    error: null,
    incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    instructions: null,
    max_output_tokens: request.maxTokens ?? null,
    parallel_tool_calls: true,
    previous_response_id: request.previousResponseId ?? null,
    reasoning: { effort: null, summary: null },
    store: true,
    temperature: 1,
    text: { format: { type: 'text' } },
    tool_choice: request.toolChoice ?? 'auto',
    tools: [],
    top_p: 1,
    truncation: 'disabled',
    usage: done
      ? { input_tokens: p.usage.input, input_tokens_details: { cached_tokens: 0 }, output_tokens: p.usage.output, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: p.usage.input + p.usage.output }
      : null,
    metadata: {},
  }
}

function responsesEvents(p: Plan, request: LlmRequest): string[] {
  let sequence = 0
  const events: string[] = []
  const emit = (type: string, data: Record<string, unknown>) => events.push(sse({ type, sequence_number: sequence++, ...data }, type))
  emit('response.created', { response: responseObject(p, request, 'in_progress', []) })
  emit('response.in_progress', { response: responseObject(p, request, 'in_progress', []) })
  const output: unknown[] = []
  p.items.forEach((item, output_index) => {
    const item_id = itemId(p, item, output_index)
    const done = responsesItem(p, item, output_index)
    if (item.type === 'text') {
      emit('response.output_item.added', { output_index, item: { id: item_id, type: 'message', status: 'in_progress', role: 'assistant', content: [] } })
      const part = { type: 'output_text', text: '', annotations: [], logprobs: [] }
      emit('response.content_part.added', { item_id, output_index, content_index: 0, part })
      for (const delta of chunks(item.text, p.chunkChars)) emit('response.output_text.delta', { item_id, output_index, content_index: 0, delta, logprobs: [] })
      emit('response.output_text.done', { item_id, output_index, content_index: 0, text: item.text, logprobs: [] })
      emit('response.content_part.done', { item_id, output_index, content_index: 0, part: { ...part, text: item.text } })
    } else if (item.type === 'reasoning') {
      emit('response.output_item.added', { output_index, item: { id: item_id, type: 'reasoning', summary: [] } })
      emit('response.reasoning_summary_part.added', { item_id, output_index, summary_index: 0, part: { type: 'summary_text', text: '' } })
      for (const delta of chunks(item.text, p.chunkChars)) emit('response.reasoning_summary_text.delta', { item_id, output_index, summary_index: 0, delta })
      emit('response.reasoning_summary_text.done', { item_id, output_index, summary_index: 0, text: item.text })
      emit('response.reasoning_summary_part.done', { item_id, output_index, summary_index: 0, part: { type: 'summary_text', text: item.text } })
    } else {
      emit('response.output_item.added', { output_index, item: { ...done, status: 'in_progress', arguments: '' } })
      for (const delta of chunks(item.arguments, p.chunkChars)) emit('response.function_call_arguments.delta', { item_id, output_index, delta })
      emit('response.function_call_arguments.done', { item_id, output_index, name: item.name, arguments: item.arguments })
    }
    emit('response.output_item.done', { output_index, item: done })
    output.push(done)
  })
  const status = p.stopReason === 'length' ? 'incomplete' : 'completed'
  emit(status === 'incomplete' ? 'response.incomplete' : 'response.completed', { response: responseObject(p, request, status, output) })
  return events
}

// Messages

const STOP_REASON = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use' } as const

function signature(text: string): string {
  return Buffer.from(`agent-test-server:${text.length}`).toString('base64')
}

function messagesBlock(item: PlanItem): Record<string, unknown> {
  if (item.type === 'text') return { type: 'text', text: item.text }
  if (item.type === 'reasoning') return { type: 'thinking', thinking: item.text, signature: signature(item.text) }
  return { type: 'tool_use', id: item.id, name: item.name, input: parseArguments(item.arguments) }
}

function parseArguments(args: string): unknown {
  try {
    return JSON.parse(args)
  } catch {
    return {}
  }
}

function messagesJson(p: Plan): unknown {
  return {
    id: p.id,
    type: 'message',
    role: 'assistant',
    model: p.model,
    content: p.items.map(messagesBlock),
    stop_reason: STOP_REASON[p.stopReason],
    stop_sequence: null,
    usage: { input_tokens: p.usage.input, output_tokens: p.usage.output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }
}

function messagesEvents(p: Plan): string[] {
  const events: string[] = []
  const emit = (type: string, data: Record<string, unknown>) => events.push(sse({ type, ...data }, type))
  emit('message_start', {
    message: {
      id: p.id, type: 'message', role: 'assistant', model: p.model, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: p.usage.input, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  })
  p.items.forEach((item, index) => {
    if (item.type === 'text') {
      emit('content_block_start', { index, content_block: { type: 'text', text: '' } })
      for (const text of chunks(item.text, p.chunkChars)) emit('content_block_delta', { index, delta: { type: 'text_delta', text } })
    } else if (item.type === 'reasoning') {
      emit('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } })
      for (const thinking of chunks(item.text, p.chunkChars)) emit('content_block_delta', { index, delta: { type: 'thinking_delta', thinking } })
      emit('content_block_delta', { index, delta: { type: 'signature_delta', signature: signature(item.text) } })
    } else {
      emit('content_block_start', { index, content_block: { type: 'tool_use', id: item.id, name: item.name, input: {} } })
      for (const partial_json of chunks(item.arguments, p.chunkChars)) emit('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json } })
    }
    emit('content_block_stop', { index })
  })
  emit('message_delta', { delta: { stop_reason: STOP_REASON[p.stopReason], stop_sequence: null }, usage: { output_tokens: p.usage.output } })
  emit('message_stop', {})
  return events
}

// Errors

const ANTHROPIC_ERROR: Record<number, string> = {
  400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error',
  413: 'request_too_large', 429: 'rate_limit_error', 500: 'api_error', 529: 'overloaded_error',
}

/** An error body shaped the way the protocol's real API shapes it. */
export function errorBody(protocol: Protocol | undefined, failure: Failure & { code?: string }): unknown {
  const message = failure.message ?? defaultMessage(failure.status)
  if (protocol === 'messages') {
    const type = failure.type ?? ANTHROPIC_ERROR[failure.status] ?? (failure.status >= 500 ? 'api_error' : 'invalid_request_error')
    return { type: 'error', error: { type, message } }
  }
  const type = failure.type ?? (failure.status === 429 ? 'rate_limit_exceeded' : failure.status >= 500 ? 'server_error' : failure.status === 401 ? 'invalid_api_key' : 'invalid_request_error')
  return { error: { message, type, param: null, code: failure.code ?? type } }
}

function defaultMessage(status: number): string {
  if (status === 401) return 'Incorrect API key provided.'
  if (status === 429) return 'Rate limit reached. Retry after the time in the Retry-After header.'
  if (status === 529) return 'Overloaded.'
  if (status >= 500) return 'The server had an error while processing your request.'
  return `Request failed with status ${status}.`
}
