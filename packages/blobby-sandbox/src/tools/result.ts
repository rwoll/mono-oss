import { SandboxError } from '../backend.ts'

/** Bytes a tool returns, base64: an image the model should see, or another file. */
export interface BinaryContent {
  type: 'image' | 'resource'
  mimeType: string
  /** Base64. */
  data: string
  description?: string
}

/**
 * What every tool handler returns. It never throws: failures are results with `ok: false` and a stable
 * error code, so the agent can read them.
 *
 * - `text` is for the model.
 * - `json` is the same result as data, for programs and logs.
 * - `binary` carries bytes: screenshots as `{ type: 'image', mimeType: 'image/png' }`, and recording
 *   chunks as `{ type: 'resource' }`.
 *
 * For the Copilot SDK, `toToolResultObject` maps it to a `ToolResultObject`: `text` to
 * `textResultForLlm`, `binary` to `binaryResultsForLlm`, and `ok` to `resultType`.
 */
export interface ToolResult {
  ok: boolean
  text: string
  json: Record<string, unknown>
  binary: BinaryContent[]
  error?: { code: string; message: string }
}

/** Repeated in every desktop tool's description and error: the agent must look before it acts again. */
export const SCREENSHOT_AFTER_ERROR =
  'After any error, take a fresh screenshot before acting again: input is not idempotent, so an action may have happened even though it failed.'

export function success(text: string, json: Record<string, unknown> = {}, binary: BinaryContent[] = []): ToolResult {
  return { ok: true, text, json, binary }
}

export function failure(code: string, message: string): ToolResult {
  return { ok: false, text: `Error (${code}): ${message} ${SCREENSHOT_AFTER_ERROR}`, json: { error: { code, message } }, binary: [], error: { code, message } }
}

/** A thrown error as a result: a `SandboxError` keeps its code; anything else is `internal`. */
export function failureOf(error: unknown): ToolResult {
  if (error instanceof SandboxError) return failure(error.code, error.message)
  return failure('internal', String((error as Error)?.message ?? error))
}

/** The Copilot SDK's tool result shape, without depending on the SDK. */
export interface ToolResultObject {
  textResultForLlm: string
  binaryResultsForLlm?: BinaryContent[]
  resultType: 'success' | 'failure'
  error?: string
}

export function toToolResultObject(result: ToolResult): ToolResultObject {
  return {
    textResultForLlm: result.text,
    ...(result.binary.length ? { binaryResultsForLlm: result.binary } : {}),
    resultType: result.ok ? 'success' : 'failure',
    ...(result.error ? { error: result.error.message } : {}),
  }
}
