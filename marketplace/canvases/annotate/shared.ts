// Shared by the extension (canvas.ts) and the page (App.tsx), so nothing here may import Node.js modules.
export const FORMATS = ['png', 'jpg', 'webp', 'mp4', 'webm', 'gif'] as const
export type Format = (typeof FORMATS)[number]
export const VIDEO_FORMATS: ReadonlySet<Format> = new Set(['mp4', 'webm', 'gif'])
