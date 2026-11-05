import { execFile } from 'node:child_process'

// Opening things from the page goes through the operating system: https links in the browser, session
// links in VS Code's Agents window, and local files in their usual app.

const BUNDLE_SCHEMES: Record<string, string> = {
  'com.microsoft.VSCodeInsiders': 'vscode-insiders',
  'com.microsoft.VSCode': 'vscode',
  'com.microsoft.VSCodeExploration': 'vscode-exploration',
  'com.visualstudio.code.oss': 'code-oss',
}
const SCHEME = /^[a-z][a-z0-9+.-]{0,30}$/
const OPEN_LINK = /^agent-host-session:\/\/([A-Za-z0-9][A-Za-z0-9_.+-]{0,200})\/([A-Za-z0-9][A-Za-z0-9._-]{0,200})(?:\?[^#]*)?$/

/** The URL scheme of the VS Code build running this extension, or null when it is unknown. */
export function productScheme(env: NodeJS.ProcessEnv = process.env): string | null {
  const scheme = env.VSCODE_URL_PROTOCOL || BUNDLE_SCHEMES[env.__CFBundleIdentifier ?? ''] || null
  return scheme && SCHEME.test(scheme) ? scheme : null
}

/** The URL that opens the session behind an `agent-host-session://` link, or null when it is not one. */
export function sessionUrl(link: string, scheme: string): string | null {
  const match = OPEN_LINK.exec(link)
  return match ? `${scheme}://agents/agent-host-session/${match[1]!.toLowerCase()}/${match[2]}` : null
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile(command, args, { timeout: 10_000 }, (error, _stdout, stderr) => (error ? reject(new Error(String(stderr).trim() || error.message)) : resolve())),
  )
}

/** Hand a URL to the operating system, which passes product URLs to VS Code. */
export function openUrl(url: string): Promise<void> {
  if (process.platform === 'darwin') return run('open', [url])
  if (process.platform === 'win32') return run('rundll32', ['url.dll,FileProtocolHandler', url])
  return run('xdg-open', [url])
}

// Files that open safely in their usual app. Anything else is shown in its folder instead, so nothing runs.
const SAFE_TO_OPEN = /\.(md|markdown|txt|log|json|jsonl|csv|pdf|png|jpe?g|gif|webp|avif|mp4|m4v|webm|mov)$/i

/** Open a local file with the operating system, or show it in its folder when opening it could run it. */
export function openPath(path: string): Promise<void> {
  const reveal = !SAFE_TO_OPEN.test(path)
  if (process.platform === 'darwin') return run('open', reveal ? ['-R', path] : [path])
  if (process.platform === 'win32') return run('explorer.exe', reveal ? [`/select,${path}`] : [path]).catch(() => undefined)
  return run('xdg-open', [reveal ? path.slice(0, path.lastIndexOf('/')) || '/' : path])
}
