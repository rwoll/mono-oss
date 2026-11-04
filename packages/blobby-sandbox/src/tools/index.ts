// Plain agent tool descriptors for a sandbox's desktop, at `@rwoll/blobby-sandbox/tools`: a name, a
// description, a zod input schema, and a handler factory that takes a `DesktopTarget`. They don't depend
// on any agent SDK. The engine and the client both provide targets, and a hosted broker can implement
// one over its own procedures. Results carry text, JSON, and binary content, such as screenshots as PNG
// images; `toToolResultObject` maps them to the Copilot SDK's tool results.

export { bindTools, DESKTOP_TOOLS, desktopExec, desktopInfo, desktopInput, desktopMediaRead, desktopRecordStart, desktopRecordStop, desktopScreenshot, desktopUi, toolsFor } from './desktop.ts'
export type { BoundTool, ToolCallContext, ToolDescriptor, ToolHandler, ToolOptions } from './desktop.ts'
export { failure, failureOf, SCREENSHOT_AFTER_ERROR, success, toToolResultObject } from './result.ts'
export type { BinaryContent, ToolResult, ToolResultObject } from './result.ts'
export { clientTarget, engineTarget, readMedia } from './target.ts'
export type { DesktopExecOptions, DesktopInfo, DesktopTarget } from './target.ts'
