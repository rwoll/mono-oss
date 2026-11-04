// Types for the parts of the noVNC client used by the viewer. noVNC ships no type declarations.
declare module '@novnc/novnc' {
  export interface RFBOptions {
    shared?: boolean
    credentials?: { username?: string; password?: string; target?: string }
    wsProtocols?: string[]
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: RFBOptions)
    viewOnly: boolean
    focusOnClick: boolean
    clipViewport: boolean
    scaleViewport: boolean
    resizeSession: boolean
    background: string
    qualityLevel: number
    compressionLevel: number
    disconnect(): void
    sendCtrlAltDel(): void
    focus(options?: FocusOptions): void
    clipboardPasteFrom(text: string): void
  }
}
