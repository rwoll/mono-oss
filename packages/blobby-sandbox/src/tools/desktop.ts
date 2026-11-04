import { z } from 'zod'
import { SandboxError } from '../backend.ts'
import type { AccessibleNode, InputAction } from '../sandboxes.ts'
import { failure, failureOf, SCREENSHOT_AFTER_ERROR, success, type ToolResult } from './result.ts'
import type { DesktopTarget } from './target.ts'

/** How a host binds tools to one desktop. */
export interface ToolOptions {
  /** Lets `desktop_exec` run commands as root. Without it, root is refused. */
  allowRoot?: boolean
  /** Most bytes of stdout and of stderr `desktop_exec` returns. Default 64 KiB each. */
  maxOutputBytes?: number
}

export interface ToolCallContext {
  signal?: AbortSignal
}

/** Takes the model's arguments, validates them, and never throws. */
export type ToolHandler = (input: unknown, context?: ToolCallContext) => Promise<ToolResult>

/** A plain tool: its name, what the model reads about it, a zod schema of its input, and a handler factory. */
export interface ToolDescriptor<S extends z.ZodType = z.ZodType> {
  name: string
  description: string
  inputSchema: S
  /** Makes the handler for one desktop. */
  createHandler(target: DesktopTarget, options?: ToolOptions): ToolHandler
}

interface Definition<S extends z.ZodType> {
  name: string
  description: string
  inputSchema: S
  run(input: z.output<S>, target: DesktopTarget, options: ToolOptions): Promise<ToolResult>
}

function defineTool<S extends z.ZodType>(definition: Definition<S>): ToolDescriptor<S> {
  const { run, ...descriptor } = definition
  return {
    ...descriptor,
    description: `${definition.description} ${SCREENSHOT_AFTER_ERROR}`,
    createHandler: (target, options = {}) => async (input, context = {}) => {
      const parsed = definition.inputSchema.safeParse(input ?? {})
      if (!parsed.success) {
        const issue = parsed.error.issues[0]!
        return failure('invalid_input', `${issue.path.join('.') || 'input'}: ${issue.message}`)
      }
      try {
        context.signal?.throwIfAborted()
        return await run(parsed.data, target, options)
      } catch (error) {
        return failureOf(error)
      }
    },
  }
}

const coordinate = z.number().int().min(0).max(20_000)
const delta = z.number().int().min(-1000).max(1000)

export const desktopScreenshot = defineTool({
  name: 'desktop_screenshot',
  description:
    'Takes a screenshot of the sandbox desktop and returns it as a PNG image, with its width and height. Input coordinates are in the same pixels. Take one after every action whose result you need to see.',
  inputSchema: z.strictObject({}),
  async run(_input, target) {
    const shot = await target.screenshot()
    const data = Buffer.from(shot.png).toString('base64')
    return success(`Screenshot of the desktop, ${shot.width}x${shot.height} pixels.`, { width: shot.width, height: shot.height, bytes: shot.png.byteLength }, [
      { type: 'image', mimeType: 'image/png', data, description: `Desktop screenshot, ${shot.width}x${shot.height}` },
    ])
  },
})

const InputSchema = z.strictObject({
  action: z.enum(['click', 'move', 'type', 'key', 'scroll']).describe('What to do.'),
  x: coordinate.optional().describe('For click and move, and optionally scroll: the x coordinate, in screenshot pixels.'),
  y: coordinate.optional().describe('For click and move, and optionally scroll: the y coordinate, in screenshot pixels.'),
  button: z.enum(['left', 'middle', 'right']).optional().describe('For click. Default left.'),
  double: z.boolean().optional().describe('For click: a double click.'),
  text: z.string().min(1).max(10_000).optional().describe('For type: the text to type.'),
  keys: z.string().min(1).max(200).optional().describe('For key: keys to press, such as Return, ctrl+l, or ctrl+shift+p.'),
  dx: delta.optional().describe('For scroll: steps right (negative: left).'),
  dy: delta.optional().describe('For scroll: steps down (negative: up).'),
  instant: z.boolean().optional().describe('Jump and click at once instead of moving like a hand. Faster, but hover effects may not show.'),
})

/** The engine's input action for the tool's flat arguments, which models fill in more reliably than unions. */
function inputAction(input: z.output<typeof InputSchema>): InputAction {
  const need = <T>(value: T | undefined, field: string): T => {
    if (value === undefined) throw new SandboxError('invalid_input', `${input.action} needs ${field}.`)
    return value
  }
  const instant = input.instant ? { instant: true } : {}
  switch (input.action) {
    case 'click':
      return { click: [need(input.x, 'x'), need(input.y, 'y')], button: input.button ?? 'left', double: input.double ?? false, ...instant }
    case 'move':
      return { move: [need(input.x, 'x'), need(input.y, 'y')], ...instant }
    case 'type':
      return { type: need(input.text, 'text') }
    case 'key':
      return { key: need(input.keys, 'keys') }
    case 'scroll': {
      if ((input.x === undefined) !== (input.y === undefined)) throw new SandboxError('invalid_input', 'scroll needs both x and y, or neither.')
      const at: [number, number] | undefined = input.x !== undefined && input.y !== undefined ? [input.x, input.y] : undefined
      return { scroll: [input.dx ?? 0, need(input.dy, 'dy')], ...(at ? { at } : {}), ...instant }
    }
  }
}

export const desktopInput = defineTool({
  name: 'desktop_input',
  description:
    'Clicks, moves the pointer, types text, presses keys, or scrolls on the sandbox desktop, by screenshot coordinates. The pointer moves like a hand on a mouse unless instant is set. It does not return a screenshot: take one to see the result.',
  inputSchema: InputSchema,
  async run(input, target) {
    const action = inputAction(input)
    await target.input(action)
    return success(`Did ${input.action}. Take a screenshot to see the result.`, { action })
  },
})

function describeNode(node: AccessibleNode): string {
  const extra = [node.text !== undefined ? `text=${JSON.stringify(node.text)}` : '', ...(node.states ?? []), node.box ? `at ${node.box.join(',')}` : '']
  return `${node.path}  ${node.role} ${JSON.stringify(node.name)} ${extra.filter(Boolean).join(' ')}`.trimEnd()
}

export const desktopUi = defineTool({
  name: 'desktop_ui',
  description:
    "Reads or acts on the desktop's accessibility tree. Without path, it lists the visible, named elements (optionally of one app, or matching some text), each with a path, role, name, and screen box. With path, it acts on that element: press (default), focus, or set its text. Paths are valid until the UI changes; list again after acting.",
  inputSchema: z.strictObject({
    app: z.string().min(1).max(200).optional().describe('Only elements of this app, such as code-insiders or chrome.'),
    match: z.string().min(1).max(200).optional().describe("Only elements whose name or text contains this."),
    max: z.number().int().min(1).max(1000).optional().describe('Most elements to list. Default 300.'),
    path: z.string().regex(/^\d+(?:\.\d+)*$/).optional().describe('An element path from a listing, to act on it.'),
    do: z.enum(['press', 'focus', 'set']).optional().describe('With path: what to do. Default press.'),
    action: z.string().min(1).max(100).optional().describe('With do=press: which action, when the element has several.'),
    text: z.string().max(10_000).optional().describe('With do=set: the new text.'),
  }),
  async run(input, target) {
    if (input.path !== undefined) {
      if (input.do === 'set' && input.text === undefined) throw new SandboxError('invalid_input', 'do=set needs text.')
      const result = await target.act({ path: input.path, do: input.do ?? 'press', action: input.action, text: input.text })
      return success(`Did ${result.did} on ${JSON.stringify(result.name)}. List again or take a screenshot to see the result.`, result)
    }
    const tree = await target.ui({ app: input.app, match: input.match, max: input.max })
    const lines = tree.nodes.map(describeNode)
    if (tree.truncated) lines.push('(more elements: narrow with app or match, or raise max)')
    return success(lines.join('\n') || 'No visible, named elements.', { nodes: tree.nodes, truncated: tree.truncated })
  },
})

const truncate = (text: string, max: number) => {
  const bytes = Buffer.from(text)
  return bytes.length <= max ? { text, truncated: false } : { text: bytes.subarray(bytes.length - max).toString('utf8'), truncated: true }
}

export const desktopExec = defineTool({
  name: 'desktop_exec',
  description:
    "Runs a command in the sandbox, as the desktop user, in its desktop session, so it can open and drive windows. Returns its exit code and output (the end of each, when long); a non-zero exit code is a result, not an error. Root needs root: true, which the host may not allow.",
  inputSchema: z.strictObject({
    command: z.array(z.string().max(100_000)).min(1).max(1000).describe('The program and its arguments, such as ["xdotool", "getactivewindow"]. Use ["bash", "-c", "..."] for a shell.'),
    root: z.boolean().optional().describe('Run as root, for system changes. Refused unless the host allows root.'),
    timeoutSeconds: z.number().int().min(1).max(3600).optional().describe('Stop the command after this long. Default 600.'),
    stdin: z.string().max(1024 * 1024).optional().describe('Text for the command to read on stdin.'),
  }),
  async run(input, target, options) {
    if (input.root && !options.allowRoot) return failure('root_not_allowed', 'This host does not allow commands as root. Run it as the desktop user, or ask the person who set up the task.')
    const result = await target.exec(input.command, { root: input.root, timeoutSeconds: input.timeoutSeconds ?? 600, stdin: input.stdin })
    const max = options.maxOutputBytes ?? 64 * 1024
    const stdout = truncate(result.stdout, max)
    const stderr = truncate(result.stderr, max)
    const text = [`Exit code ${result.exitCode}.`, stdout.text && `stdout${stdout.truncated ? ' (end)' : ''}:\n${stdout.text}`, stderr.text && `stderr${stderr.truncated ? ' (end)' : ''}:\n${stderr.text}`]
    return success(text.filter(Boolean).join('\n'), { exitCode: result.exitCode, stdout: stdout.text, stderr: stderr.text, truncated: stdout.truncated || stderr.truncated })
  },
})

export const desktopRecordStart = defineTool({
  name: 'desktop_record_start',
  description: 'Starts recording the sandbox screen to a video. It stops by itself after maxSeconds. Stop it with desktop_record_stop.',
  inputSchema: z.strictObject({ maxSeconds: z.number().int().min(1).max(3600).optional().describe('Stop by itself after this long. Default 600.') }),
  async run(input, target) {
    const started = await target.recordStart({ maxSeconds: input.maxSeconds })
    return success(`Recording, for at most ${started.maxSeconds} seconds. Stop it with desktop_record_stop.`, started)
  },
})

export const desktopRecordStop = defineTool({
  name: 'desktop_record_stop',
  description: 'Stops recording the screen. The video stays in the sandbox; its id, size, and SHA-256 come back, and desktop_media_read reads it.',
  inputSchema: z.strictObject({}),
  async run(_input, target) {
    const info = await target.recordStop()
    return success(`Stopped recording: ${info.id}, ${info.size} bytes${info.seconds === null ? '' : `, ${info.seconds} seconds`}.`, { ...info })
  },
})

const MAX_CHUNK = 4 * 1024 * 1024

export const desktopMediaRead = defineTool({
  name: 'desktop_media_read',
  description: 'Reads a chunk of a recording that desktop_record_stop returned, as bytes, from offset. Read again from nextOffset until eof.',
  inputSchema: z.strictObject({
    id: z.string().regex(/^[a-f0-9]{8,64}$/).describe('The recording id.'),
    offset: z.number().int().min(0).optional().describe('The first byte. Default 0.'),
    length: z.number().int().min(1).max(MAX_CHUNK).optional().describe('Most bytes to read. Default 1 MiB, at most 4 MiB.'),
  }),
  async run(input, target) {
    const offset = input.offset ?? 0
    const chunk = await target.mediaRead(input.id, offset, input.length ?? 1024 * 1024)
    const bytes = chunk.data.byteLength
    const json = { id: input.id, offset, bytes, nextOffset: offset + bytes, eof: chunk.eof }
    const text = `Read ${bytes} bytes of ${input.id} from ${offset}${chunk.eof ? '; that is the end' : `; continue from ${offset + bytes}`}.`
    return success(text, json, [{ type: 'resource', mimeType: 'video/mp4', data: Buffer.from(chunk.data).toString('base64'), description: `${input.id}, bytes ${offset} to ${offset + bytes}` }])
  },
})

export const desktopInfo = defineTool({
  name: 'desktop_info',
  description: "Describes the sandbox: its name, whether it runs, and when it was made.",
  inputSchema: z.strictObject({}),
  async run(_input, target) {
    const info = await target.info()
    return success(`Sandbox ${info.name} is ${info.state}.`, { ...info })
  },
})

/** Every desktop tool. Register them only for sandboxes with the `desktop` feature: see `toolsFor`. */
export const DESKTOP_TOOLS: readonly ToolDescriptor[] = [
  desktopScreenshot,
  desktopInput,
  desktopUi,
  desktopExec,
  desktopRecordStart,
  desktopRecordStop,
  desktopMediaRead,
  desktopInfo,
]

/** The tools that apply to a sandbox with these features: the desktop tools only with `desktop`. */
export function toolsFor(features: readonly string[]): ToolDescriptor[] {
  return features.includes('desktop') ? [...DESKTOP_TOOLS] : []
}

/** A tool bound to one desktop, ready to register with an agent runtime. */
export interface BoundTool {
  name: string
  description: string
  inputSchema: z.ZodType
  /** The input schema as JSON Schema, for runtimes that take one. */
  parameters: Record<string, unknown>
  handler: ToolHandler
}

/** Binds tools to one desktop. */
export function bindTools(tools: readonly ToolDescriptor[], target: DesktopTarget, options: ToolOptions = {}): BoundTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    parameters: z.toJSONSchema(tool.inputSchema) as Record<string, unknown>,
    handler: tool.createHandler(target, options),
  }))
}
